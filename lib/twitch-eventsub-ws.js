/**
 * TwitchEventSubWS - Native WebSocket EventSub client
 * Replaces @twurple/eventsub-ws with direct WebSocket implementation
 */

const WebSocket = require('ws');
const axios = require('axios');

const EVENTSUB_WS_URL = 'wss://eventsub.wss.twitch.tv/ws';
const HELIX_BASE_URL = 'https://api.twitch.tv/helix';

class TwitchEventSubWS {
  constructor(options = {}) {
    this.clientId = options.clientId;
    this.accessToken = options.accessToken;
    this.ws = null;
    this.sessionId = null;
    this.reconnectUrl = null;
    this.keepaliveTimeout = null;
    this.keepaliveTimeoutMs = 10000; // Default 10 seconds
    this._isConnected = false;
    this._subscriptions = new Map();
    this._eventHandlers = new Map();
    this._pendingSubscriptions = [];
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 5;
    this._reconnectBackoffMs = 1000;

    // Subscription tracking
    this._subscriptionIds = new Map(); // Maps internal ID to Twitch subscription ID
  }

  /**
   * Update access token
   */
  setAccessToken(token) {
    this.accessToken = token;
  }

  /**
   * Get Helix API headers
   */
  _getHeaders() {
    return {
      'Client-ID': this.clientId,
      'Authorization': `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json'
    };
  }

  /**
   * Start the EventSub WebSocket connection
   */
  async start() {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(EVENTSUB_WS_URL);

        this.ws.on('open', () => {
          console.log('[EventSub-WS] WebSocket connected');
        });

        this.ws.on('message', async (data) => {
          try {
            const message = JSON.parse(data.toString());
            await this._handleMessage(message);

            // Resolve the promise on successful welcome
            if (message.metadata?.message_type === 'session_welcome') {
              clearTimeout(connectionTimeout);
              resolve();
            }
          } catch (error) {
            console.error('[EventSub-WS] Error parsing message:', error.message);
          }
        });

        this.ws.on('close', (code, reason) => {
          console.log(`[EventSub-WS] WebSocket closed: ${code} - ${reason || 'No reason'}`);
          this._isConnected = false;
          this._clearKeepalive();
          clearTimeout(connectionTimeout);

          // Attempt to reconnect if we have a reconnect URL
          if (this.reconnectUrl) {
            console.log('[EventSub-WS] Attempting reconnect...');
            this._scheduleReconnect();
          }
        });

        this.ws.on('error', (error) => {
          console.error('[EventSub-WS] WebSocket error:', error.message);
          clearTimeout(connectionTimeout);
          reject(error);
        });

        // Set a connection timeout and store the ID for cleanup
        const connectionTimeout = setTimeout(() => {
          if (!this._isConnected) {
            reject(new Error('EventSub connection timeout'));
          }
        }, 30000);
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Stop the EventSub connection
   */
  stop() {
    this._clearKeepalive();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._isConnected = false;
    this.sessionId = null;
  }

  /**
   * Handle incoming WebSocket messages
   */
  async _handleMessage(message) {
    const messageType = message.metadata?.message_type;

    switch (messageType) {
      case 'session_welcome':
        await this._handleSessionWelcome(message);
        break;

      case 'session_keepalive':
        this._resetKeepalive();
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
   * Handle session welcome message
   */
  async _handleSessionWelcome(message) {
    const session = message.payload?.session;
    this.sessionId = session?.id;
    this.keepaliveTimeoutMs = (session?.keepalive_timeout_seconds || 10) * 1000 + 1000; // Add 1 second buffer
    this._isConnected = true;
    this._reconnectAttempts = 0; // Reset reconnect attempts on successful connection

    console.log(`[EventSub-WS] Session established: ${this.sessionId}`);
    this._resetKeepalive();

    // Process any pending subscriptions
    for (const sub of this._pendingSubscriptions) {
      await this._createSubscription(sub.type, sub.condition, sub.callback, sub.internalId);
    }
    this._pendingSubscriptions = [];
  }

  /**
   * Handle session reconnect message
   */
  _handleSessionReconnect(message) {
    this.reconnectUrl = message.payload?.session?.reconnect_url;
    console.log('[EventSub-WS] Received reconnect URL, will reconnect when current connection closes');
  }

  /**
   * Schedule a reconnection attempt with exponential backoff
   */
  _scheduleReconnect() {
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      console.error('[EventSub-WS] Max reconnection attempts reached. Giving up.');
      this.reconnectUrl = null;
      return;
    }

    this._reconnectAttempts++;
    const delay = this._reconnectBackoffMs * Math.pow(2, this._reconnectAttempts - 1);

    console.log(`[EventSub-WS] Scheduling reconnect attempt ${this._reconnectAttempts}/${this._maxReconnectAttempts} in ${delay}ms`);
    setTimeout(() => this._reconnect(), delay);
  }

  /**
   * Attempt to reconnect to EventSub
   */
  _reconnect() {
    if (!this.reconnectUrl) {
      console.warn('[EventSub-WS] No reconnect URL available');
      return;
    }

    const reconnectUrl = this.reconnectUrl;
    this.reconnectUrl = null;

    try {

      this.ws = new WebSocket(reconnectUrl);

      // Track connection success
      let connectionSucceeded = false;

      this.ws.on('open', () => {
        connectionSucceeded = true;
        console.log('[EventSub-WS] Reconnected successfully');
      });

      // Reattach event handlers
      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this._handleMessage(message);
        } catch (error) {
          console.error('[EventSub-WS] Error parsing message:', error.message);
        }
      });

      this.ws.on('close', (code, reason) => {
        console.log(`[EventSub-WS] Reconnected WebSocket closed: ${code} - ${reason || 'No reason'}`);
        this._isConnected = false;
        this._clearKeepalive();

        // If this was a failed reconnection attempt, retry
        if (!connectionSucceeded) {
          console.warn('[EventSub-WS] Reconnection failed, retrying...');
          this.reconnectUrl = reconnectUrl;
          this._scheduleReconnect();
        }
      });

      this.ws.on('error', (error) => {
        console.error('[EventSub-WS] Reconnect error:', error.message);
        // Don't schedule retry here - let close handler take care of it
      });
    } catch (error) {
      console.error('[EventSub-WS] Failed to initiate reconnect:', error.message);
      // Restore the reconnect URL for retry
      this.reconnectUrl = this.reconnectUrl || reconnectUrl;
      this._scheduleReconnect();
    }
  }

  /**
   * Handle notification message (actual events)
   */
  _handleNotification(message) {
    const subscription = message.payload?.subscription;
    const event = message.payload?.event;
    const subType = subscription?.type;

    // Find handlers for this subscription type
    const handlers = this._eventHandlers.get(subType) || [];

    for (const handler of handlers) {
      try {
        // Check if this handler matches the condition
        if (this._conditionMatches(handler.condition, subscription.condition)) {
          handler.callback(event);
        }
      } catch (error) {
        console.error(`[EventSub-WS] Error in handler for ${subType}:`, error.message);
      }
    }
  }

  /**
   * Handle subscription revocation
   */
  _handleRevocation(message) {
    const subscription = message.payload?.subscription;
    console.log(`[EventSub-WS] Subscription revoked: ${subscription?.type} - ${subscription?.status}`);
  }

  /**
   * Check if a subscription condition matches a handler's condition
   */
  _conditionMatches(handlerCondition, subCondition) {
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
  _resetKeepalive() {
    this._clearKeepalive();
    this.keepaliveTimeout = setTimeout(() => {
      console.log('[EventSub-WS] Keepalive timeout - reconnecting...');
      this.ws?.close();
    }, this.keepaliveTimeoutMs);
  }

  /**
   * Clear keepalive timeout
   */
  _clearKeepalive() {
    if (this.keepaliveTimeout) {
      clearTimeout(this.keepaliveTimeout);
      this.keepaliveTimeout = null;
    }
  }

  /**
   * Create a subscription via Helix API
   */
  async _createSubscription(type, condition, callback, internalId) {
    if (!this.sessionId) {
      // Queue for later if session not established
      this._pendingSubscriptions.push({ type, condition, callback, internalId });
      return;
    }

    try {
      const response = await axios.post(
        `${HELIX_BASE_URL}/eventsub/subscriptions`,
        {
          type,
          version: this._getSubscriptionVersion(type),
          condition,
          transport: {
            method: 'websocket',
            session_id: this.sessionId
          }
        },
        { headers: this._getHeaders() }
      );

      const sub = response.data?.data?.[0];
      if (sub) {
        this._subscriptionIds.set(internalId, sub.id);
        console.log(`[EventSub-WS] Subscribed to ${type}: ${sub.id}`);
      }

      // Store handler
      if (!this._eventHandlers.has(type)) {
        this._eventHandlers.set(type, []);
      }
      this._eventHandlers.get(type).push({ condition, callback });

      return sub;
    } catch (error) {
      const errMsg = error?.response?.data?.message || error.message;
      console.error(`[EventSub-WS] Failed to subscribe to ${type}:`, errMsg);
      throw error;
    }
  }

  /**
   * Get subscription version for a type
   */
  _getSubscriptionVersion(type) {
    // Most subscriptions are version 1, some are version 2
    const v2Types = [
      'channel.follow'
    ];
    return v2Types.includes(type) ? '2' : '1';
  }

  // ==================== PUBLIC SUBSCRIPTION METHODS ====================

  /**
   * Subscribe to stream online events
   * @param {string} broadcasterId
   * @param {Function} callback
   * @returns {Promise}
   */
  async onStreamOnline(broadcasterId, callback) {
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
   * @param {string} broadcasterId
   * @param {Function} callback
   * @returns {Promise}
   */
  async onStreamOffline(broadcasterId, callback) {
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
   * @param {string} broadcasterId
   * @param {string} moderatorId
   * @param {Function} callback
   * @returns {Promise}
   */
  async onChannelFollow(broadcasterId, moderatorId, callback) {
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
        userDisplayName: event.user_name,
        broadcasterUserId: event.broadcaster_user_id,
        followedAt: new Date(event.followed_at)
      }),
      internalId
    );
  }

  /**
   * Subscribe to channel raid (incoming) events
   * @param {string} toBroadcasterId
   * @param {Function} callback
   * @returns {Promise}
   */
  async onChannelRaidTo(toBroadcasterId, callback) {
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
   * @param {string} broadcasterId
   * @param {Function} callback
   * @returns {Promise}
   */
  async onChannelRedemptionAdd(broadcasterId, callback) {
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
        userDisplayName: event.user_name,
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
   * @param {string} broadcasterId
   * @param {Function} callback
   * @returns {Promise}
   */
  async onChannelSubscription(broadcasterId, callback) {
    const internalId = `channel.subscribe:${broadcasterId}`;
    return this._createSubscription(
      'channel.subscribe',
      { broadcaster_user_id: broadcasterId },
      (event) => callback({
        userId: event.user_id,
        userLogin: event.user_login,
        userName: event.user_name,
        userDisplayName: event.user_name,
        broadcasterUserId: event.broadcaster_user_id,
        tier: event.tier,
        isGift: event.is_gift
      }),
      internalId
    );
  }

  /**
   * Subscribe to subscription message events (resubs with message)
   * @param {string} broadcasterId
   * @param {Function} callback
   * @returns {Promise}
   */
  async onChannelSubscriptionMessage(broadcasterId, callback) {
    const internalId = `channel.subscription.message:${broadcasterId}`;
    return this._createSubscription(
      'channel.subscription.message',
      { broadcaster_user_id: broadcasterId },
      (event) => callback({
        userId: event.user_id,
        userLogin: event.user_login,
        userName: event.user_name,
        userDisplayName: event.user_name,
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
   * @param {string} broadcasterId
   * @param {Function} callback
   * @returns {Promise}
   */
  async onChannelSubscriptionGift(broadcasterId, callback) {
    const internalId = `channel.subscription.gift:${broadcasterId}`;
    return this._createSubscription(
      'channel.subscription.gift',
      { broadcaster_user_id: broadcasterId },
      (event) => callback({
        userId: event.user_id,
        userLogin: event.user_login,
        userName: event.user_name,
        gifterName: event.user_name,
        gifterDisplayName: event.user_name,
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
   * @param {string} broadcasterId
   * @param {Function} callback
   * @returns {Promise}
   */
  async onChannelCheer(broadcasterId, callback) {
    const internalId = `channel.cheer:${broadcasterId}`;
    return this._createSubscription(
      'channel.cheer',
      { broadcaster_user_id: broadcasterId },
      (event) => callback({
        userId: event.user_id,
        userLogin: event.user_login,
        userName: event.user_name,
        userDisplayName: event.user_name,
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
  isConnected() {
    return this._isConnected;
  }
}

module.exports = TwitchEventSubWS;
