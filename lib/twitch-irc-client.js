/**
 * TwitchIRCClient - Twitch IRC chat client
 * Replaces @twurple/chat with tmi.js
 */

const tmi = require('tmi.js');

class TwitchIRCClient {
  constructor(options = {}) {
    this.username = options.username;
    this.accessToken = options.accessToken;
    this.channels = options.channels || [];
    this.client = null;
    this._messageHandlers = [];
    this._connectHandlers = [];
    this._disconnectHandlers = [];
    this._connected = false;
  }

  /**
   * Initialize the TMI client
   */
  _createClient() {
    this.client = new tmi.Client({
      options: { debug: false },
      identity: {
        username: this.username,
        password: `oauth:${this.accessToken.replace(/^oauth:/, '')}`
      },
      channels: this.channels.map(ch => ch.replace(/^#/, ''))
    });

    // Setup internal event handlers
    this.client.on('message', (channel, tags, message, self) => {
      if (self) return; // Ignore messages from the bot itself

      // Build a msg object compatible with Twurple's structure
      const msg = {
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
      const channelName = channel.replace(/^#/, '');
      for (const handler of this._messageHandlers) {
        try {
          handler(channelName, tags.username, message, msg);
        } catch (error) {
          console.error('Error in message handler:', error.message);
        }
      }
    });

    this.client.on('connected', (address, port) => {
      this._connected = true;
      for (const handler of this._connectHandlers) {
        try {
          handler();
        } catch (error) {
          console.error('Error in connect handler:', error.message);
        }
      }
    });

    this.client.on('disconnected', (reason) => {
      this._connected = false;
      for (const handler of this._disconnectHandlers) {
        try {
          handler(false, reason ? new Error(reason) : null);
        } catch (error) {
          console.error('Error in disconnect handler:', error.message);
        }
      }
    });
  }

  /**
   * Parse emotes from tags into a more usable format
   */
  _parseEmotes(emotesString) {
    if (!emotesString) return [];

    const emotes = [];
    const entries = Object.entries(emotesString);

    for (const [emoteId, positions] of entries) {
      for (const pos of positions) {
        const [start, end] = pos.split('-').map(Number);
        emotes.push({ id: emoteId, start, end });
      }
    }

    return emotes.sort((a, b) => a.start - b.start);
  }

  /**
   * Connect to Twitch IRC
   */
  async connect() {
    if (!this.client) {
      this._createClient();
    }

    try {
      await this.client.connect();
      return true;
    } catch (error) {
      console.error('Failed to connect to Twitch IRC:', error.message);
      throw error;
    }
  }

  /**
   * Disconnect from Twitch IRC
   */
  async disconnect() {
    if (this.client) {
      await this.client.disconnect();
    }
    this._connected = false;
  }

  /**
   * Send a message to a channel
   * @param {string} channel - Channel name (with or without #)
   * @param {string} message - Message to send
   */
  say(channel, message) {
    if (!this.client || !this._connected) {
      console.error('Cannot send message: not connected');
      return;
    }

    const channelName = channel.replace(/^#/, '');
    this.client.say(channelName, message).catch(error => {
      console.error(`Failed to send message to ${channelName}:`, error.message);
    });
  }

  /**
   * Send a /me action message
   * @param {string} channel
   * @param {string} message
   */
  action(channel, message) {
    if (!this.client || !this._connected) return;

    const channelName = channel.replace(/^#/, '');
    this.client.action(channelName, message).catch(error => {
      console.error(`Failed to send action to ${channelName}:`, error.message);
    });
  }

  /**
   * Register a message handler (equivalent to chatClient.onMessage())
   * @param {Function} handler - (channel, user, message, msg) => void
   */
  onMessage(handler) {
    this._messageHandlers.push(handler);
  }

  /**
   * Register a connect handler (equivalent to chatClient.onConnect())
   * @param {Function} handler - () => void
   */
  onConnect(handler) {
    this._connectHandlers.push(handler);
  }

  /**
   * Register a disconnect handler (equivalent to chatClient.onDisconnect())
   * @param {Function} handler - (manually, reason) => void
   */
  onDisconnect(handler) {
    this._disconnectHandlers.push(handler);
  }

  /**
   * Join a channel
   * @param {string} channel
   */
  async join(channel) {
    if (!this.client) return;

    const channelName = channel.replace(/^#/, '');
    if (!this.channels.includes(channelName)) {
      this.channels.push(channelName);
    }

    try {
      await this.client.join(channelName);
    } catch (error) {
      console.error(`Failed to join ${channelName}:`, error.message);
    }
  }

  /**
   * Leave/part a channel
   * @param {string} channel
   */
  async part(channel) {
    if (!this.client) return;

    const channelName = channel.replace(/^#/, '');
    this.channels = this.channels.filter(ch => ch !== channelName);

    try {
      await this.client.part(channelName);
    } catch (error) {
      console.error(`Failed to part ${channelName}:`, error.message);
    }
  }

  /**
   * Check if connected
   */
  isConnected() {
    return this._connected;
  }

  /**
   * Update access token (for token refresh)
   */
  updateToken(newToken) {
    this.accessToken = newToken;
    // Need to reconnect with new token
    if (this.client && this._connected) {
      console.log('Token updated - reconnecting IRC client...');
      this.disconnect().then(() => {
        this._createClient();
        this.connect();
      });
    }
  }
}

module.exports = TwitchIRCClient;
