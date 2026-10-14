/**
 * TwitchIRCClient - Twitch IRC chat client
 * Replaces @twurple/chat with tmi.js
 */

import * as tmi from 'tmi.js';

export interface TwitchIRCClientOptions {
  username?: string;
  accessToken?: string;
  channels?: string[];
}

/** A single emote occurrence in a message (character offsets are inclusive) */
export interface ParsedEmote {
  id: string;
  start: number;
  end: number;
}

/** Chatter details, shaped like Twurple's ChatUser */
export interface ChatUserInfo {
  userName: string | undefined;
  displayName: string | undefined;
  userId: string | undefined;
  isMod: boolean;
  isBroadcaster: boolean;
  isSubscriber: boolean;
  isVip: boolean;
  color: string | undefined;
  badges: tmi.Badges;
  badgeInfo: tmi.BadgeInfo;
}

/** A msg object compatible with Twurple's ChatMessage structure */
export interface ChatMessage {
  userInfo: ChatUserInfo;
  id: string | undefined;
  channelId: string | undefined;
  emotes: ParsedEmote[];
  /** Raw `first-msg` tag value from tmi.js, or false when absent */
  isFirst: boolean;
  /** Raw `returning-chatter` tag value from tmi.js, or false when absent */
  isReturningChatter: boolean;
}

export type MessageHandler = (channel: string, user: string | undefined, message: string, msg: ChatMessage) => void;
export type ConnectHandler = () => void;
export type DisconnectHandler = (manually: boolean, reason: Error | null) => void;

export class TwitchIRCClient {
  username: string | undefined;
  accessToken: string | undefined;
  channels: string[];
  client: tmi.Client | null;
  /** The identity object handed to tmi.js; tmi reads its password on every (re)connect */
  private _identity: { username: string | undefined; password: string } | null;
  /** True between disconnect() and the next connect(), so handlers can tell a manual disconnect */
  private _manualDisconnect: boolean;
  private _messageHandlers: MessageHandler[];
  private _connectHandlers: ConnectHandler[];
  private _disconnectHandlers: DisconnectHandler[];
  private _connected: boolean;

  constructor(options: TwitchIRCClientOptions = {}) {
    this.username = options.username;
    this.accessToken = options.accessToken;
    this.channels = (options.channels || []).map(stripHash);
    this.client = null;
    this._identity = null;
    this._manualDisconnect = false;
    this._messageHandlers = [];
    this._connectHandlers = [];
    this._disconnectHandlers = [];
    this._connected = false;
  }

  /**
   * Initialize the TMI client
   */
  _createClient(): void {
    if (!this.accessToken) {
      throw new Error('Cannot create Twitch IRC client: no access token');
    }
    const identity = { username: this.username, password: toPassword(this.accessToken) };
    const client = new tmi.Client({
      options: { debug: false },
      identity,
      channels: this.channels.map(stripHash)
    });
    this.client = client;
    this._identity = identity;

    // Setup internal event handlers. Events from a client that has since been
    // replaced (see updateToken) are ignored.
    client.on('message', (channel: string, tags: tmi.ChatUserstate, message: string, self: boolean) => {
      if (self || this.client !== client) return; // Ignore messages from the bot itself

      // Build a msg object compatible with Twurple's structure
      const msg: ChatMessage = {
        userInfo: {
          userName: tags.username,
          displayName: tags['display-name'] || tags.username,
          userId: tags['user-id'],
          isMod: tags.mod || false,
          isBroadcaster: tags.badges?.broadcaster === '1' || false,
          isSubscriber: tags.subscriber || false,
          isVip: tags.badges?.vip === '1' || false,
          color: tags.color,
          badges: tags.badges || {},
          badgeInfo: tags['badge-info'] || {}
        },
        id: tags.id,
        channelId: tags['room-id'],
        emotes: this._parseEmotes(tags.emotes),
        isFirst: tags['first-msg'] || false,
        isReturningChatter: tags['returning-chatter'] || false
      };

      // Call all message handlers
      const channelName = stripHash(channel);
      for (const handler of this._messageHandlers) {
        try {
          handler(channelName, tags.username, message, msg);
        } catch (error) {
          console.error('Error in message handler:', (error as Error).message);
        }
      }
    });

    client.on('connected', (address: string, port: number) => {
      if (this.client !== client) return;
      this._connected = true;
      for (const handler of this._connectHandlers) {
        try {
          handler();
        } catch (error) {
          console.error('Error in connect handler:', (error as Error).message);
        }
      }
    });

    client.on('disconnected', (reason: string) => {
      if (this.client !== client) return;
      this._connected = false;
      const manually = this._manualDisconnect;
      for (const handler of this._disconnectHandlers) {
        try {
          handler(manually, reason ? new Error(reason) : null);
        } catch (error) {
          console.error('Error in disconnect handler:', (error as Error).message);
        }
      }
    });
  }

  /**
   * Parse emotes from tags into a more usable format
   * Handles both object format { "25": ["0-4", "12-16"] } and string format "25:0-4,12-16/26:5-9"
   */
  _parseEmotes(emotesData: unknown): ParsedEmote[] {
    if (!emotesData) return [];

    const emotes: ParsedEmote[] = [];
    let emotesObj: unknown = emotesData;

    // Handle string format (e.g., "25:0-4,12-16/26:5-9")
    if (typeof emotesData === 'string') {
      const parsed: Record<string, string[]> = {};
      const emotePairs = emotesData.split('/');
      for (const pair of emotePairs) {
        const [emoteId, positions] = pair.split(':');
        if (emoteId && positions) {
          parsed[emoteId] = positions.split(',');
        }
      }
      emotesObj = parsed;
    }

    // Handle object format (e.g., { "25": ["0-4", "12-16"] })
    // Ensure it's a plain object, not Date, RegExp, or other types
    if (typeof emotesObj === 'object' && !(emotesObj instanceof Date) && !(emotesObj instanceof RegExp)) {
      const entries = Object.entries(emotesObj as Record<string, unknown>);
      for (const [emoteId, positions] of entries) {
        // Ensure positions is an array
        const posArray: unknown[] = Array.isArray(positions) ? positions : [];
        for (const pos of posArray) {
          // Skip malformed positions rather than throwing out of the tmi listener
          if (typeof pos !== 'string') continue;
          const [start, end] = pos.split('-').map(Number);
          if (!isNaN(start) && !isNaN(end)) {
            emotes.push({ id: emoteId, start, end });
          }
        }
      }
    }

    return emotes.sort((a, b) => a.start - b.start);
  }

  /**
   * Connect to Twitch IRC
   */
  async connect(): Promise<boolean> {
    this._manualDisconnect = false;
    try {
      if (!this.client) {
        this._createClient();
      }
      await (this.client as tmi.Client).connect();
      return true;
    } catch (error) {
      console.error('Failed to connect to Twitch IRC:', (error as Error).message);
      throw error;
    }
  }

  /**
   * Disconnect from Twitch IRC
   */
  async disconnect(): Promise<void> {
    this._manualDisconnect = true;
    if (this.client) {
      try {
        await this.client.disconnect();
      } catch (error) {
        // tmi.js rejects (with a string) when the socket is not open: already disconnected
        console.log('IRC client already disconnected:', errorMessage(error));
      }
    }
    this._connected = false;
  }

  /**
   * Send a message to a channel
   * @param channel - Channel name (with or without #)
   * @param message - Message to send
   */
  say(channel: string, message: string): void {
    if (!this.client || !this._connected) {
      console.error('Cannot send message: not connected');
      return;
    }

    const channelName = stripHash(channel);
    this.client.say(channelName, message).catch((error: Error) => {
      console.error(`Failed to send message to ${channelName}:`, error.message);
    });
  }

  /**
   * Send a /me action message
   */
  action(channel: string, message: string): void {
    if (!this.client || !this._connected) {
      console.error('Cannot send action: not connected');
      return;
    }

    const channelName = stripHash(channel);
    this.client.action(channelName, message).catch((error: Error) => {
      console.error(`Failed to send action to ${channelName}:`, error.message);
    });
  }

  /**
   * Register a message handler (equivalent to chatClient.onMessage())
   * @param handler - (channel, user, message, msg) => void
   */
  onMessage(handler: MessageHandler): void {
    this._messageHandlers.push(handler);
  }

  /**
   * Register a connect handler (equivalent to chatClient.onConnect())
   * @param handler - () => void
   */
  onConnect(handler: ConnectHandler): void {
    this._connectHandlers.push(handler);
  }

  /**
   * Register a disconnect handler (equivalent to chatClient.onDisconnect())
   * @param handler - (manually, reason) => void
   */
  onDisconnect(handler: DisconnectHandler): void {
    this._disconnectHandlers.push(handler);
  }

  /**
   * Join a channel
   */
  async join(channel: string): Promise<void> {
    if (!this.client) return;

    const channelName = stripHash(channel);
    if (!this.channels.includes(channelName)) {
      this.channels.push(channelName);
    }

    try {
      await this.client.join(channelName);
    } catch (error) {
      console.error(`Failed to join ${channelName}:`, (error as Error).message);
    }
  }

  /**
   * Leave/part a channel
   */
  async part(channel: string): Promise<void> {
    if (!this.client) return;

    const channelName = stripHash(channel);
    this.channels = this.channels.filter(ch => ch !== channelName);

    try {
      await this.client.part(channelName);
    } catch (error) {
      console.error(`Failed to part ${channelName}:`, (error as Error).message);
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this._connected;
  }

  /**
   * Update access token (for token refresh)
   */
  async updateToken(newToken: string): Promise<void> {
    this.accessToken = newToken;
    // An existing client (connected or not) reads this on its next (re)connect,
    // so tmi.js auto-reconnects and later connect() calls use the new token
    if (this._identity) {
      this._identity.password = toPassword(newToken);
    }
    // Reconnect a live connection with a fresh client logged in with the new token
    if (this.client && this._connected) {
      try {
        console.log('Token updated - reconnecting IRC client...');
        await this._retireClient();
        await this.connect();
        console.log('IRC client reconnected with new token');
      } catch (error) {
        console.error('Failed to reconnect IRC client with new token:', (error as Error).message);
        throw error;
      }
    }
  }

  /**
   * Detach and close the current tmi client. Its events stop reaching the
   * registered handlers first, so closing it is not reported as a disconnect.
   */
  private async _retireClient(): Promise<void> {
    const old = this.client;
    if (!old) return;
    this.client = null;
    this._identity = null;
    this._connected = false;
    old.removeAllListeners('message');
    old.removeAllListeners('connected');
    old.removeAllListeners('disconnected');
    try {
      await old.disconnect();
    } catch (error) {
      console.log('IRC client already disconnected:', errorMessage(error));
    }
  }
}

/** Channel names are stored and sent without the leading '#' */
function stripHash(channel: string): string {
  return channel.replace(/^#/, '');
}

/** tmi.js password for an access token, with exactly one oauth: prefix */
function toPassword(accessToken: string): string {
  return `oauth:${accessToken.replace(/^oauth:/, '')}`;
}

/** tmi.js rejects with plain strings as well as Errors */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
