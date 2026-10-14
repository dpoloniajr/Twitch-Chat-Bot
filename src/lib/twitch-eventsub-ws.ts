/**
 * TwitchEventSubWS - Native WebSocket EventSub client
 * Replaces @twurple/eventsub-ws with direct WebSocket implementation
 *
 * Connection handling follows Twitch's EventSub WebSocket rules:
 * - Any message counts as activity; no message within keepalive_timeout_seconds
 *   (plus a small grace) means the connection is dead.
 * - A lost connection (unexpected close, keepalive timeout, socket error) gets a
 *   brand-new session on the default URL with exponential backoff that never gives
 *   up. A new session has no subscriptions, so every registered one is re-created.
 * - session_reconnect: connect to reconnect_url right away, keep the old socket
 *   until the new one sends session_welcome, then close the old one. The session
 *   and its subscriptions carry over.
 * - Messages are de-duplicated by metadata.message_id.
 * - stop() cancels everything; nothing reconnects after it.
 */

import WebSocket from 'ws';
import axios from 'axios';

export const EVENTSUB_WS_URL = 'wss://eventsub.wss.twitch.tv/ws';
export const HELIX_BASE_URL = 'https://api.twitch.tv/helix';

export interface TwitchEventSubWSOptions {
  clientId?: string;
  accessToken?: string;
}

/** Subscription condition as sent to / received from Twitch */
export type EventSubCondition = Record<string, string>;

/** Raw `event` payload of a notification; the shape depends on the subscription type */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RawEventSubEvent = Record<string, any>;

/** May return a promise; a rejection is logged like a thrown error */
export type RawEventCallback = (event: RawEventSubEvent) => unknown;

/** The parts of an EventSub WebSocket message this client reads */
export interface EventSubMessage {
  metadata?: {
    message_id?: string;
    message_type?: string;
    message_timestamp?: string;
    subscription_type?: string;
    subscription_version?: string;
  };
  payload?: {
    session?: {
      id?: string;
      status?: string;
      keepalive_timeout_seconds?: number | null;
      reconnect_url?: string | null;
      connected_at?: string;
    };
    subscription?: {
      id?: string;
      type?: string;
      version?: string;
      status?: string;
      condition?: EventSubCondition;
    };
    event?: RawEventSubEvent;
  };
}

/** Subscription object returned by POST /helix/eventsub/subscriptions */
export interface HelixEventSubSubscription {
  id: string;
  status?: string;
  type?: string;
  version?: string;
  condition?: EventSubCondition;
  created_at?: string;
  transport?: { method: string; session_id?: string };
  cost?: number;
}

type TimerHandle = ReturnType<typeof setTimeout>;

const CONNECT_TIMEOUT_MS = 30000;
const DEFAULT_KEEPALIVE_SECONDS = 10;
const KEEPALIVE_GRACE_MS = 1000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60000;
const DEDUPE_MAX_IDS = 500;
const DEDUPE_TTL_MS = 10 * 60 * 1000;

interface PendingSubscription {
  type: string;
  condition: EventSubCondition;
  callback: RawEventCallback;
  internalId: string;
}

/** A subscription created on Twitch; re-created on every new session until revoked */
interface RegisteredSubscription {
  type: string;
  condition: EventSubCondition;
  callback: RawEventCallback;
  internalId: string;
  /** Twitch subscription id on the current session (undefined if Helix returned none) */
  twitchId: string | undefined;
}

interface PendingStart {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: TimerHandle;
}

interface HttpError {
  message: string;
  response?: { data?: { message?: string } };
}

// ==================== MAPPED EVENT PAYLOADS ====================

export interface StreamOnlineEvent {
  broadcasterUserId: string;
  broadcasterUserLogin: string;
  broadcasterUserName: string;
  type: string;
  startedAt: Date;
}

export interface StreamOfflineEvent {
  broadcasterUserId: string;
  broadcasterUserLogin: string;
  broadcasterUserName: string;
}

export interface ChannelFollowEvent {
  userId: string;
  userLogin: string;
  userName: string;
  userDisplayName: string;
  broadcasterUserId: string;
  followedAt: Date;
}

export interface ChannelRaidEvent {
  raidingBroadcasterId: string;
  raidingBroadcasterLogin: string;
  raidingBroadcasterName: string;
  raidingBroadcasterDisplayName: string;
  raidedBroadcasterId: string;
  raidedBroadcasterLogin: string;
  raidedBroadcasterName: string;
  viewers: number;
}

export interface ChannelRedemptionAddEvent {
  id: string;
  broadcasterUserId: string;
  broadcasterUserLogin: string;
  broadcasterUserName: string;
  userId: string;
  userLogin: string;
  userName: string;
  userDisplayName: string;
  userInput: string;
  status: string;
  rewardId: string | undefined;
  rewardTitle: string | undefined;
  rewardCost: number | undefined;
  redeemedAt: Date;
}

export interface ChannelSubscriptionEvent {
  userId: string;
  userLogin: string;
  userName: string;
  userDisplayName: string;
  broadcasterUserId: string;
  tier: string;
  isGift: boolean;
}

export interface ChannelSubscriptionMessageEvent {
  userId: string;
  userLogin: string;
  userName: string;
  userDisplayName: string;
  broadcasterUserId: string;
  tier: string;
  messageText: string;
  cumulativeMonths: number;
  streakMonths: number | null;
  durationMonths: number;
}

export interface ChannelSubscriptionGiftEvent {
  userId: string;
  userLogin: string;
  userName: string;
  gifterName: string;
  gifterDisplayName: string;
  broadcasterUserId: string;
  tier: string;
  amount: number;
  cumulativeAmount: number;
  isAnonymous: boolean;
}

export interface ChannelCheerEvent {
  userId: string;
  userLogin: string;
  userName: string;
  userDisplayName: string;
  broadcasterUserId: string;
  bits: number;
  message: string;
  isAnonymous: boolean;
}


export class TwitchEventSubWS {
  clientId: string | undefined;
  accessToken: string | undefined;
  /** The socket that owns the current session (or is connecting to get one) */
  ws: WebSocket | null;
  sessionId: string | null | undefined;
  /** reconnect_url from the last session_reconnect, until the move completes */
  reconnectUrl: string | null | undefined;
  keepaliveTimeout: TimerHandle | null;
  keepaliveTimeoutMs: number;
  private _isConnected: boolean;
  private _subscriptions: Set<RegisteredSubscription>;
  private _pendingSubscriptions: PendingSubscription[];
  private _reconnectAttempts: number;
  private _reconnectBackoffMs: number;
  private _maxReconnectBackoffMs: number;
  private _reconnectTimer: TimerHandle | null;
  /** Socket opened to a session_reconnect URL, waiting for its welcome */
  private _migratingWs: WebSocket | null;
  private _stopped: boolean;
  private _pendingStart: PendingStart | null;
  /** message_id -> time first seen (insertion order = age order) */
  private _seenMessageIds: Map<string, number>;

  constructor(options: TwitchEventSubWSOptions = {}) {
    this.clientId = options.clientId;
    this.accessToken = options.accessToken;
    this.ws = null;
    this.sessionId = null;
    this.reconnectUrl = null;
    this.keepaliveTimeout = null;
    this.keepaliveTimeoutMs = DEFAULT_KEEPALIVE_SECONDS * 1000; // Default 10 seconds
    this._isConnected = false;
    this._subscriptions = new Set();
    this._pendingSubscriptions = [];
    this._reconnectAttempts = 0;
    this._reconnectBackoffMs = RECONNECT_BASE_MS;
    this._maxReconnectBackoffMs = RECONNECT_MAX_MS;
    this._reconnectTimer = null;
    this._migratingWs = null;
    this._stopped = false;
    this._pendingStart = null;
    this._seenMessageIds = new Map();
  }

  /**
   * Update access token
   * Used for every later Helix request, including re-creating subscriptions after a reconnect.
   */
  setAccessToken(token: string): void {
    this.accessToken = token;
  }

  /**
   * Get Helix API headers
   */
  private _getHeaders(): Record<string, string> {
    return {
      'Client-ID': this.clientId as string,
      'Authorization': `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json'
    };
  }

  /**
   * Start the EventSub WebSocket connection.
   * Resolves once the first session is welcomed and any subscriptions queued before
   * start() were attempted (failures are logged, not thrown). Rejects if the socket
   * errors or closes before the welcome, after 30s without one, or on stop(); a
   * rejected start() leaves the client stopped (no background reconnects).
   */
  async start(): Promise<void> {
    this._stopped = false;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this._isConnected) {
          this._failStart(new Error('EventSub connection timeout'));
        }
      }, CONNECT_TIMEOUT_MS);
      this._pendingStart = { resolve, reject, timer };

      try {
        this.ws = this._openSocket(EVENTSUB_WS_URL, false);
      } catch (error) {
        this._failStart(error as Error);
      }
    });
  }

  /**
   * Stop the EventSub connection. Cancels pending reconnects; registered
   * subscriptions are kept and re-created if start() is called again.
   */
  stop(): void {
    this._stopped = true;
    this._failStart(new Error('EventSub stopped'));
    this._teardown();
  }

  // ==================== CONNECTION LIFECYCLE ====================

  /**
   * Open a socket and wire its events. `migration` marks a socket opened for a
   * session_reconnect: its welcome continues the existing session.
   */
  private _openSocket(url: string, migration: boolean): WebSocket {
    const socket = new WebSocket(url);

    socket.on('open', () => {
      if (this._isStale(socket)) return;
      console.log(migration
        ? '[EventSub-WS] Connected to reconnect URL, waiting for welcome'
        : '[EventSub-WS] WebSocket connected');
    });

    socket.on('message', async (data: WebSocket.RawData) => {
      if (this._isStale(socket)) return;
      let message: EventSubMessage;
      try {
        message = JSON.parse(data.toString()) as EventSubMessage;
      } catch (error) {
        console.error('[EventSub-WS] Error parsing message:', (error as Error).message);
        return;
      }
      try {
        await this._handleMessage(message, socket, migration);
      } catch (error) {
        console.error('[EventSub-WS] Error handling message:', (error as Error).message);
      }
    });

    socket.on('close', (code: number, reason: Buffer) => {
      const reasonText = reason?.toString() || 'No reason';
      if (socket === this._migratingWs) {
        console.warn(`[EventSub-WS] Reconnect URL connection closed before welcome: ${code} - ${reasonText}; staying on current connection`);
        this._migratingWs = null;
        return;
      }
      if (socket !== this.ws) return; // replaced or stopped; nothing to do
      console.log(`[EventSub-WS] WebSocket closed: ${code} - ${reasonText}`);
      this._connectionLost(socket);
    });

    socket.on('error', (error: Error) => {
      if (this._isStale(socket)) return;
      if (socket === this._migratingWs) {
        console.error('[EventSub-WS] Reconnect error:', error.message);
        return; // the close that follows drops it
      }
      console.error('[EventSub-WS] WebSocket error:', error.message);
      if (this._pendingStart) {
        this._failStart(error);
      }
      // Otherwise the close event that ws emits after an error triggers the reconnect
    });

    return socket;
  }

  private _isStale(socket: WebSocket): boolean {
    return socket !== this.ws && socket !== this._migratingWs;
  }

  /**
   * The current socket is gone (closed, errored or keepalive timeout).
   */
  private _connectionLost(socket: WebSocket): void {
    if (socket !== this.ws) return;
    this._clearKeepalive();
    this._isConnected = false;

    if (this._pendingStart) {
      this._failStart(new Error('EventSub connection closed before welcome'));
      return;
    }
    if (this._stopped) return;

    if (this._migratingWs) {
      // Old connection closed before the reconnect URL's welcome; carry on with the new one
      this.ws = this._migratingWs;
      this._migratingWs = null;
      console.log('[EventSub-WS] Previous connection closed; continuing on reconnect URL connection');
      this._resetKeepalive();
      return;
    }

    this.ws = null;
    this.sessionId = null;
    this.reconnectUrl = null;
    console.log('[EventSub-WS] Connection lost - reconnecting...');
    this._scheduleReconnect();
  }

  /**
   * Schedule a new-session reconnect with exponential backoff (capped, never gives up)
   */
  private _scheduleReconnect(): void {
    if (this._stopped || this._reconnectTimer) return;

    const delay = Math.min(
      this._reconnectBackoffMs * Math.pow(2, this._reconnectAttempts),
      this._maxReconnectBackoffMs
    );
    this._reconnectAttempts++;

    console.log(`[EventSub-WS] Scheduling reconnect attempt ${this._reconnectAttempts} in ${delay}ms`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._reconnect();
    }, delay);
  }

  /**
   * Open a new session on the default URL
   */
  private _reconnect(): void {
    if (this._stopped) return;
    console.log(`[EventSub-WS] Reconnect attempt ${this._reconnectAttempts}: connecting to ${EVENTSUB_WS_URL}`);
    try {
      this.ws = this._openSocket(EVENTSUB_WS_URL, false);
      // Also covers a handshake or welcome that never arrives
      this._resetKeepalive();
    } catch (error) {
      console.error('[EventSub-WS] Failed to initiate reconnect:', (error as Error).message);
      this.ws = null;
      this._scheduleReconnect();
    }
  }

  private _resolveStart(): void {
    const pending = this._pendingStart;
    if (!pending) return;
    this._pendingStart = null;
    clearTimeout(pending.timer);
    pending.resolve();
  }

  private _failStart(error: Error): void {
    const pending = this._pendingStart;
    if (!pending) return;
    this._pendingStart = null;
    clearTimeout(pending.timer);
    this._teardown();
    pending.reject(error);
  }

  /**
   * Close every socket and cancel every timer
   */
  private _teardown(): void {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._clearKeepalive();
    const sockets = [this.ws, this._migratingWs];
    // Detach first so their close events are ignored
    this.ws = null;
    this._migratingWs = null;
    for (const socket of sockets) {
      socket?.close();
    }
    this._isConnected = false;
    this.sessionId = null;
    this.reconnectUrl = null;
  }

  // ==================== MESSAGES ====================

  /**
   * Handle incoming WebSocket messages
   */
  private async _handleMessage(message: EventSubMessage, socket: WebSocket, migration: boolean): Promise<void> {
    if (this._isDuplicate(message)) return;

    // Any message proves the connection is alive
    this._resetKeepalive();

    const messageType = message.metadata?.message_type;

    switch (messageType) {
      case 'session_welcome':
        await this._handleSessionWelcome(message, socket, migration);
        break;

      case 'session_keepalive':
        break;

      case 'session_reconnect':
        this._handleSessionReconnect(message);
        break;

      case 'notification':
        this._handleNotification(message);
        break;

      case 'revocation':
        this._handleRevocation(message);
        break;

      default:
        console.log('[EventSub-WS] Unknown message type:', messageType);
    }
  }

  /**
   * True if this message_id was already handled (bounded by count and age)
   */
  private _isDuplicate(message: EventSubMessage): boolean {
    const id = message.metadata?.message_id;
    if (!id) return false;

    const now = Date.now();
    for (const [seenId, seenAt] of this._seenMessageIds) {
      if (now - seenAt > DEDUPE_TTL_MS || this._seenMessageIds.size >= DEDUPE_MAX_IDS) {
        this._seenMessageIds.delete(seenId);
      } else {
        break;
      }
    }

    if (this._seenMessageIds.has(id)) {
      console.log(`[EventSub-WS] Duplicate message ignored: ${id}`);
      return true;
    }
    this._seenMessageIds.set(id, now);
    return false;
  }

  /**
   * Handle session welcome message
   */
  private async _handleSessionWelcome(message: EventSubMessage, socket: WebSocket, migration: boolean): Promise<void> {
    const session = message.payload?.session;
    this.keepaliveTimeoutMs = (session?.keepalive_timeout_seconds || DEFAULT_KEEPALIVE_SECONDS) * 1000 + KEEPALIVE_GRACE_MS;

    if (migration) {
      // session_reconnect completed: same session, subscriptions carried over
      const previous = this.ws;
      this.ws = socket;
      this._migratingWs = null;
      this.reconnectUrl = null;
      this.sessionId = session?.id;
      this._isConnected = true;
      this._reconnectAttempts = 0;
      console.log(`[EventSub-WS] Reconnected to session ${this.sessionId}`);
      this._resetKeepalive();
      if (previous && previous !== socket) {
        previous.close();
      }
      await this._flushPending();
      return;
    }

    this.sessionId = session?.id;
    this._isConnected = true;
    this._reconnectAttempts = 0; // Reset reconnect attempts on successful connection

    console.log(`[EventSub-WS] Session established: ${this.sessionId}`);
    this._resetKeepalive();

    await this._resubscribeAll();
    await this._flushPending();
    this._resolveStart();
  }

  /**
   * A new session has no subscriptions: re-create every registered one
   */
  private async _resubscribeAll(): Promise<void> {
    if (this._subscriptions.size === 0) return;
    const sessionId = this.sessionId;
    console.log(`[EventSub-WS] Re-creating ${this._subscriptions.size} subscription(s) on session ${sessionId}`);

    for (const sub of [...this._subscriptions]) {
      if (this._stopped || this.sessionId !== sessionId) return; // a newer session takes over
      if (!this._subscriptions.has(sub)) continue; // revoked meanwhile
      try {
        const created = await this._postSubscription(sub.type, sub.condition, sessionId as string);
        sub.twitchId = created?.id;
      } catch {
        // Logged by _postSubscription; kept so the next session tries again
        sub.twitchId = undefined;
      }
    }
  }

  /**
   * Create subscriptions requested while there was no session
   */
  private async _flushPending(): Promise<void> {
    const sessionId = this.sessionId;
    while (this._pendingSubscriptions.length > 0) {
      if (this._stopped || !this.sessionId || this.sessionId !== sessionId) return;
      const sub = this._pendingSubscriptions.shift() as PendingSubscription;
      try {
        await this._createSubscription(sub.type, sub.condition, sub.callback, sub.internalId);
      } catch {
        // Logged by _postSubscription; the subscription is dropped like a direct call's failure
      }
    }
  }

  /**
   * Handle session reconnect message: move to reconnect_url now, keep the old
   * socket until the new one is welcomed
   */
  private _handleSessionReconnect(message: EventSubMessage): void {
    const url = message.payload?.session?.reconnect_url;
    if (!url) {
      console.warn('[EventSub-WS] session_reconnect without reconnect_url; ignoring');
      return;
    }
    this.reconnectUrl = url;
    console.log('[EventSub-WS] Received reconnect URL, connecting before the current connection closes');

    if (this._migratingWs) {
      const superseded = this._migratingWs;
      this._migratingWs = null;
      superseded.close();
    }

    try {
      this._migratingWs = this._openSocket(url, true);
    } catch (error) {
      // Stay on the current socket; when Twitch closes it we start a new session
      console.error('[EventSub-WS] Failed to initiate reconnect:', (error as Error).message);
      this._migratingWs = null;
    }
  }

  /**
   * Handle notification message (actual events)
   */
  private _handleNotification(message: EventSubMessage): void {
    const subscription = message.payload?.subscription;
    const event = message.payload?.event;
    const subType = subscription?.type;

    for (const sub of this._subscriptions) {
      if (sub.type !== subType) continue;
      try {
        // Check if this handler matches the condition
        // (sub.type === subType, so `subscription` is set here)
        if (this._conditionMatches(sub.condition, subscription!.condition as EventSubCondition)) {
          const result = sub.callback(event as RawEventSubEvent);
          if (result && typeof (result as Promise<unknown>).catch === 'function') {
            (result as Promise<unknown>).catch((error: Error) => {
              console.error(`[EventSub-WS] Error in handler for ${subType}:`, error?.message);
            });
          }
        }
      } catch (error) {
        console.error(`[EventSub-WS] Error in handler for ${subType}:`, (error as Error).message);
      }
    }
  }

  /**
   * Handle subscription revocation: stop dispatching it and never re-create it
   */
  private _handleRevocation(message: EventSubMessage): void {
    const subscription = message.payload?.subscription;
    console.log(`[EventSub-WS] Subscription revoked: ${subscription?.type} - ${subscription?.status}`);
    if (!subscription) return;

    let removed = 0;
    for (const sub of [...this._subscriptions]) {
      const matches = subscription.id && sub.twitchId
        ? sub.twitchId === subscription.id
        : sub.type === subscription.type && this._conditionMatches(sub.condition, subscription.condition || {});
      if (matches) {
        this._subscriptions.delete(sub);
        removed++;
      }
    }
    if (removed > 0) {
      console.log(`[EventSub-WS] Removed ${removed} handler(s) for revoked ${subscription.type}; it will not be re-created`);
    }
  }

  /**
   * Check if a subscription condition matches a handler's condition
   */
  private _conditionMatches(handlerCondition: EventSubCondition, subCondition: EventSubCondition): boolean {
    for (const key of Object.keys(handlerCondition)) {
      if (handlerCondition[key] !== subCondition[key]) {
        return false;
      }
    }
    return true;
  }

  /**
   * Reset keepalive timeout
   */
  private _resetKeepalive(): void {
    this._clearKeepalive();
    this.keepaliveTimeout = setTimeout(() => {
      this.keepaliveTimeout = null;
      const socket = this.ws;
      if (!socket) return;
      console.log('[EventSub-WS] Keepalive timeout - reconnecting...');
      this._connectionLost(socket);
      socket.terminate();
    }, this.keepaliveTimeoutMs);
  }

  /**
   * Clear keepalive timeout
   */
  private _clearKeepalive(): void {
    if (this.keepaliveTimeout) {
      clearTimeout(this.keepaliveTimeout);
      this.keepaliveTimeout = null;
    }
  }

  // ==================== HELIX ====================

  /**
   * Create a subscription and register its handler, or queue it if there is no session
   */
  private async _createSubscription(
    type: string,
    condition: EventSubCondition,
    callback: RawEventCallback,
    internalId: string
  ): Promise<HelixEventSubSubscription | undefined> {
    if (!this.sessionId) {
      // Queue for later if session not established
      this._pendingSubscriptions.push({ type, condition, callback, internalId });
      return;
    }

    const sub = await this._postSubscription(type, condition, this.sessionId);
    this._subscriptions.add({ type, condition, callback, internalId, twitchId: sub?.id });
    return sub;
  }

  /**
   * POST the subscription to Helix for the given session
   */
  private async _postSubscription(
    type: string,
    condition: EventSubCondition,
    sessionId: string
  ): Promise<HelixEventSubSubscription | undefined> {
    try {
      const response = await axios.post(
        `${HELIX_BASE_URL}/eventsub/subscriptions`,
        {
          type,
          version: this._getSubscriptionVersion(type),
          condition,
          transport: {
            method: 'websocket',
            session_id: sessionId
          }
        },
        { headers: this._getHeaders() }
      );

      const sub: HelixEventSubSubscription | undefined = response.data?.data?.[0];
      if (sub) {
        console.log(`[EventSub-WS] Subscribed to ${type}: ${sub.id}`);
      }
      return sub;
    } catch (err) {
      const error = err as HttpError;
      const errMsg = error?.response?.data?.message || error.message;
      console.error(`[EventSub-WS] Failed to subscribe to ${type}:`, errMsg);
      throw error;
    }
  }

  /**
   * Get subscription version for a type
   */
  private _getSubscriptionVersion(type: string): '1' | '2' {
    // Most subscriptions are version 1, some are version 2
    const v2Types = [
      'channel.follow'
    ];
    return v2Types.includes(type) ? '2' : '1';
  }

  // ==================== PUBLIC SUBSCRIPTION METHODS ====================

  /**
   * Subscribe to stream online events
   * Resolves with the Helix subscription, or undefined when queued until the welcome.
   */
  async onStreamOnline(
    broadcasterId: string,
    callback: (event: StreamOnlineEvent) => void | Promise<void>
  ): Promise<HelixEventSubSubscription | undefined> {
    const internalId = `stream.online:${broadcasterId}`;
    return this._createSubscription(
      'stream.online',
      { broadcaster_user_id: broadcasterId },
      (event) => callback({
        broadcasterUserId: event.broadcaster_user_id,
        broadcasterUserLogin: event.broadcaster_user_login,
        broadcasterUserName: event.broadcaster_user_name,
        type: event.type,
        startedAt: new Date(event.started_at)
      }),
      internalId
    );
  }

  /**
   * Subscribe to stream offline events
   */
  async onStreamOffline(
    broadcasterId: string,
    callback: (event: StreamOfflineEvent) => void | Promise<void>
  ): Promise<HelixEventSubSubscription | undefined> {
    const internalId = `stream.offline:${broadcasterId}`;
    return this._createSubscription(
      'stream.offline',
      { broadcaster_user_id: broadcasterId },
      (event) => callback({
        broadcasterUserId: event.broadcaster_user_id,
        broadcasterUserLogin: event.broadcaster_user_login,
        broadcasterUserName: event.broadcaster_user_name
      }),
      internalId
    );
  }

  /**
   * Subscribe to channel follow events (requires moderator:read:followers scope)
   */
  async onChannelFollow(
    broadcasterId: string,
    moderatorId: string,
    callback: (event: ChannelFollowEvent) => void | Promise<void>
  ): Promise<HelixEventSubSubscription | undefined> {
    const internalId = `channel.follow:${broadcasterId}`;
    return this._createSubscription(
      'channel.follow',
      {
        broadcaster_user_id: broadcasterId,
        moderator_user_id: moderatorId
      },
      (event) => callback({
        userId: event.user_id,
        userLogin: event.user_login,
        userName: event.user_name,
        userDisplayName: event.user_display_name || event.user_name,
        broadcasterUserId: event.broadcaster_user_id,
        followedAt: new Date(event.followed_at)
      }),
      internalId
    );
  }

  /**
   * Subscribe to channel raid (incoming) events
   */
  async onChannelRaidTo(
    toBroadcasterId: string,
    callback: (event: ChannelRaidEvent) => void | Promise<void>
  ): Promise<HelixEventSubSubscription | undefined> {
    const internalId = `channel.raid.to:${toBroadcasterId}`;
    return this._createSubscription(
      'channel.raid',
      { to_broadcaster_user_id: toBroadcasterId },
      (event) => callback({
        raidingBroadcasterId: event.from_broadcaster_user_id,
        raidingBroadcasterLogin: event.from_broadcaster_user_login,
        raidingBroadcasterName: event.from_broadcaster_user_name,
        raidingBroadcasterDisplayName: event.from_broadcaster_user_name,
        raidedBroadcasterId: event.to_broadcaster_user_id,
        raidedBroadcasterLogin: event.to_broadcaster_user_login,
        raidedBroadcasterName: event.to_broadcaster_user_name,
        viewers: event.viewers
      }),
      internalId
    );
  }

  /**
   * Subscribe to channel points redemption events
   */
  async onChannelRedemptionAdd(
    broadcasterId: string,
    callback: (event: ChannelRedemptionAddEvent) => void | Promise<void>
  ): Promise<HelixEventSubSubscription | undefined> {
    const internalId = `channel.redemption:${broadcasterId}`;
    return this._createSubscription(
      'channel.channel_points_custom_reward_redemption.add',
      { broadcaster_user_id: broadcasterId },
      (event) => callback({
        id: event.id,
        broadcasterUserId: event.broadcaster_user_id,
        broadcasterUserLogin: event.broadcaster_user_login,
        broadcasterUserName: event.broadcaster_user_name,
        userId: event.user_id,
        userLogin: event.user_login,
        userName: event.user_name,
        userDisplayName: event.user_display_name || event.user_name,
        userInput: event.user_input,
        status: event.status,
        rewardId: event.reward?.id,
        rewardTitle: event.reward?.title,
        rewardCost: event.reward?.cost,
        redeemedAt: new Date(event.redeemed_at)
      }),
      internalId
    );
  }

  /**
   * Subscribe to subscription events
   */
  async onChannelSubscription(
    broadcasterId: string,
    callback: (event: ChannelSubscriptionEvent) => void | Promise<void>
  ): Promise<HelixEventSubSubscription | undefined> {
    const internalId = `channel.subscribe:${broadcasterId}`;
    return this._createSubscription(
      'channel.subscribe',
      { broadcaster_user_id: broadcasterId },
      (event) => callback({
        userId: event.user_id,
        userLogin: event.user_login,
        userName: event.user_name,
        userDisplayName: event.user_display_name || event.user_name,
        broadcasterUserId: event.broadcaster_user_id,
        tier: event.tier,
        isGift: event.is_gift
      }),
      internalId
    );
  }

  /**
   * Subscribe to subscription message events (resubs with message)
   */
  async onChannelSubscriptionMessage(
    broadcasterId: string,
    callback: (event: ChannelSubscriptionMessageEvent) => void | Promise<void>
  ): Promise<HelixEventSubSubscription | undefined> {
    const internalId = `channel.subscription.message:${broadcasterId}`;
    return this._createSubscription(
      'channel.subscription.message',
      { broadcaster_user_id: broadcasterId },
      (event) => callback({
        userId: event.user_id,
        userLogin: event.user_login,
        userName: event.user_name,
        userDisplayName: event.user_display_name || event.user_name,
        broadcasterUserId: event.broadcaster_user_id,
        tier: event.tier,
        messageText: event.message?.text || '',
        cumulativeMonths: event.cumulative_months,
        streakMonths: event.streak_months,
        durationMonths: event.duration_months
      }),
      internalId
    );
  }

  /**
   * Subscribe to gift subscription events
   */
  async onChannelSubscriptionGift(
    broadcasterId: string,
    callback: (event: ChannelSubscriptionGiftEvent) => void | Promise<void>
  ): Promise<HelixEventSubSubscription | undefined> {
    const internalId = `channel.subscription.gift:${broadcasterId}`;
    return this._createSubscription(
      'channel.subscription.gift',
      { broadcaster_user_id: broadcasterId },
      (event) => callback({
        userId: event.user_id,
        userLogin: event.user_login,
        userName: event.user_name,
        gifterName: event.user_name,
        gifterDisplayName: event.user_display_name || event.user_name,
        broadcasterUserId: event.broadcaster_user_id,
        tier: event.tier,
        amount: event.total,
        cumulativeAmount: event.cumulative_total || event.total,
        isAnonymous: event.is_anonymous
      }),
      internalId
    );
  }

  /**
   * Subscribe to cheer (bits) events
   */
  async onChannelCheer(
    broadcasterId: string,
    callback: (event: ChannelCheerEvent) => void | Promise<void>
  ): Promise<HelixEventSubSubscription | undefined> {
    const internalId = `channel.cheer:${broadcasterId}`;
    return this._createSubscription(
      'channel.cheer',
      { broadcaster_user_id: broadcasterId },
      (event) => callback({
        userId: event.user_id,
        userLogin: event.user_login,
        userName: event.user_name,
        userDisplayName: event.user_display_name || event.user_name,
        broadcasterUserId: event.broadcaster_user_id,
        bits: event.bits,
        message: event.message,
        isAnonymous: event.is_anonymous
      }),
      internalId
    );
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this._isConnected;
  }
}
