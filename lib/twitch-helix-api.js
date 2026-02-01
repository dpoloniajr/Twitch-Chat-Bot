/**
 * TwitchHelixAPI - Direct Twitch Helix API client
 * Replaces @twurple/api with native HTTP calls
 */

const axios = require('axios');

const HELIX_BASE_URL = 'https://api.twitch.tv/helix';
const OAUTH_VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';
const API_TIMEOUT = 5000;

class TwitchHelixAPI {
  constructor(options = {}) {
    this.clientId = options.clientId;
    this.accessToken = options.accessToken;
    this.timeout = options.timeout || API_TIMEOUT;

    // Create axios instance with defaults
    this.http = axios.create({
      baseURL: HELIX_BASE_URL,
      timeout: this.timeout
    });
  }

  /**
   * Update the access token (e.g., after refresh)
   */
  setAccessToken(token) {
    this.accessToken = token;
  }

  /**
   * Get headers for Helix API requests
   */
  getHeaders() {
    return {
      'Client-ID': this.clientId,
      'Authorization': `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json'
    };
  }

  // ==================== TOKEN INFO ====================

  /**
   * Validate token and get token info (equivalent to apiClient.getTokenInfo())
   * @returns {Promise<{userId: string, login: string, scopes: string[], expiresIn: number} | null>}
   */
  async getTokenInfo() {
    try {
      const response = await axios.get(OAUTH_VALIDATE_URL, {
        headers: { 'Authorization': `Bearer ${this.accessToken}` },
        timeout: this.timeout
      });

      const data = response.data;
      return {
        userId: data.user_id,
        login: data.login,
        scopes: data.scopes || [],
        expiresIn: data.expires_in,
        clientId: data.client_id
      };
    } catch (error) {
      if (error.response?.status === 401) {
        return null;
      }
      throw error;
    }
  }

  // ==================== USERS ====================

  /**
   * Get user by login name (equivalent to apiClient.users.getUserByName())
   * @param {string} login - The username/login
   * @returns {Promise<{id: string, login: string, displayName: string, profileImageUrl: string, description: string, createdAt: Date} | null>}
   */
  async getUserByName(login) {
    try {
      const response = await this.http.get('/users', {
        params: { login },
        headers: this.getHeaders()
      });

      const user = response.data?.data?.[0];
      if (!user) return null;

      return this._mapUser(user);
    } catch (error) {
      console.error('Error getting user by name:', error.message);
      return null;
    }
  }

  /**
   * Get user by ID (equivalent to apiClient.users.getUserById())
   * @param {string} userId - The user ID
   * @returns {Promise<{id: string, login: string, displayName: string, profileImageUrl: string, description: string, createdAt: Date} | null>}
   */
  async getUserById(userId) {
    try {
      const response = await this.http.get('/users', {
        params: { id: userId },
        headers: this.getHeaders()
      });

      const user = response.data?.data?.[0];
      if (!user) return null;

      return this._mapUser(user);
    } catch (error) {
      console.error('Error getting user by ID:', error.message);
      return null;
    }
  }

  /**
   * Get multiple users by IDs
   * @param {string[]} userIds - Array of user IDs (max 100)
   * @returns {Promise<Array>}
   */
  async getUsersByIds(userIds) {
    try {
      const params = new URLSearchParams();
      userIds.slice(0, 100).forEach(id => params.append('id', id));

      const response = await this.http.get('/users', {
        params,
        headers: this.getHeaders()
      });

      return (response.data?.data || []).map(u => this._mapUser(u));
    } catch (error) {
      console.error('Error getting users by IDs:', error.message);
      return [];
    }
  }

  _mapUser(user) {
    return {
      id: user.id,
      login: user.login,
      name: user.login, // Twurple compatibility
      displayName: user.display_name,
      profileImageUrl: user.profile_image_url,
      description: user.description,
      broadcasterType: user.broadcaster_type,
      createdAt: new Date(user.created_at)
    };
  }

  // ==================== CHANNELS ====================

  /**
   * Get channel info by broadcaster ID (equivalent to apiClient.channels.getChannelInfoById())
   * @param {string} broadcasterId
   * @returns {Promise<{id: string, broadcasterLogin: string, broadcasterName: string, gameName: string, gameId: string, title: string, language: string} | null>}
   */
  async getChannelInfo(broadcasterId) {
    try {
      const response = await this.http.get('/channels', {
        params: { broadcaster_id: broadcasterId },
        headers: this.getHeaders()
      });

      const channel = response.data?.data?.[0];
      if (!channel) return null;

      return {
        id: channel.broadcaster_id,
        broadcasterLogin: channel.broadcaster_login,
        broadcasterName: channel.broadcaster_name,
        gameName: channel.game_name,
        gameId: channel.game_id,
        title: channel.title,
        language: channel.broadcaster_language,
        tags: channel.tags || []
      };
    } catch (error) {
      console.error('Error getting channel info:', error.message);
      return null;
    }
  }

  /**
   * Get channel followers (equivalent to apiClient.channels.getChannelFollowers())
   * @param {string} broadcasterId - The broadcaster's user ID
   * @param {string} [userId] - Optional specific user ID to check
   * @returns {Promise<{data: Array, total: number, cursor: string}>}
   */
  async getChannelFollowers(broadcasterId, userId = null) {
    try {
      const params = { broadcaster_id: broadcasterId };
      if (userId) {
        params.user_id = userId;
      }

      const response = await this.http.get('/channels/followers', {
        params,
        headers: this.getHeaders()
      });

      const followers = (response.data?.data || []).map(f => ({
        userId: f.user_id,
        userLogin: f.user_login,
        userName: f.user_name,
        followDate: new Date(f.followed_at),
        followedAt: new Date(f.followed_at) // Twurple compatibility
      }));

      return {
        data: followers,
        total: response.data?.total || followers.length,
        cursor: response.data?.pagination?.cursor
      };
    } catch (error) {
      console.error('Error getting channel followers:', error.message);
      return { data: [], total: 0 };
    }
  }

  /**
   * Update channel info (title, game, etc.)
   * @param {string} broadcasterId
   * @param {Object} data - { title?: string, game_id?: string }
   */
  async updateChannel(broadcasterId, data) {
    try {
      await this.http.patch('/channels', data, {
        params: { broadcaster_id: broadcasterId },
        headers: this.getHeaders()
      });
      return { success: true };
    } catch (error) {
      const msg = error?.response?.data?.message || error.message;
      console.error('Error updating channel:', msg);
      return { success: false, error: msg };
    }
  }

  // ==================== STREAMS ====================

  /**
   * Get stream by user ID (equivalent to apiClient.streams.getStreamByUserId())
   * @param {string} userId
   * @returns {Promise<{id: string, userId: string, userLogin: string, userName: string, gameId: string, gameName: string, title: string, viewerCount: number, startedAt: Date, thumbnailUrl: string, isMature: boolean} | null>}
   */
  async getStreamByUserId(userId) {
    try {
      const response = await this.http.get('/streams', {
        params: { user_id: userId },
        headers: this.getHeaders()
      });

      const stream = response.data?.data?.[0];
      if (!stream) return null;

      return {
        id: stream.id,
        userId: stream.user_id,
        userLogin: stream.user_login,
        userName: stream.user_name,
        gameId: stream.game_id,
        gameName: stream.game_name,
        type: stream.type,
        title: stream.title,
        viewerCount: stream.viewer_count,
        startedAt: new Date(stream.started_at),
        thumbnailUrl: stream.thumbnail_url,
        language: stream.language,
        isMature: stream.is_mature
      };
    } catch (error) {
      console.error('Error getting stream:', error.message);
      return null;
    }
  }

  /**
   * Get multiple streams by user IDs
   * @param {string[]} userIds
   * @returns {Promise<Array>}
   */
  async getStreamsByUserIds(userIds) {
    try {
      const params = new URLSearchParams();
      userIds.slice(0, 100).forEach(id => params.append('user_id', id));

      const response = await this.http.get('/streams', {
        params,
        headers: this.getHeaders()
      });

      return (response.data?.data || []).map(s => ({
        id: s.id,
        userId: s.user_id,
        userLogin: s.user_login,
        userName: s.user_name,
        gameId: s.game_id,
        gameName: s.game_name,
        title: s.title,
        viewerCount: s.viewer_count,
        startedAt: new Date(s.started_at)
      }));
    } catch (error) {
      console.error('Error getting streams:', error.message);
      return [];
    }
  }

  // ==================== CHAT ====================

  /**
   * Send an announcement in chat (equivalent to apiClient.chat.createAnnouncement())
   * @param {string} broadcasterId
   * @param {string} moderatorId
   * @param {string} message
   * @param {string} color - 'blue', 'green', 'orange', 'purple', or 'primary'
   */
  async sendAnnouncement(broadcasterId, moderatorId, message, color = 'primary') {
    try {
      await this.http.post('/chat/announcements',
        { message, color },
        {
          params: { broadcaster_id: broadcasterId, moderator_id: moderatorId },
          headers: this.getHeaders()
        }
      );
      return { success: true };
    } catch (error) {
      const msg = error?.response?.data?.message || error.message;
      console.error('Error sending announcement:', msg);
      return { success: false, error: msg };
    }
  }

  /**
   * Send a shoutout
   * @param {string} fromBroadcasterId
   * @param {string} toBroadcasterId
   * @param {string} moderatorId
   */
  async sendShoutout(fromBroadcasterId, toBroadcasterId, moderatorId) {
    try {
      await this.http.post('/chat/shoutouts', null, {
        params: {
          from_broadcaster_id: fromBroadcasterId,
          to_broadcaster_id: toBroadcasterId,
          moderator_id: moderatorId
        },
        headers: this.getHeaders()
      });
      return { success: true };
    } catch (error) {
      const msg = error?.response?.data?.message || error.message;
      console.error('Error sending shoutout:', msg);
      return { success: false, error: msg };
    }
  }

  // ==================== CLIPS ====================

  /**
   * Create a clip
   * @param {string} broadcasterId
   * @returns {Promise<{success: boolean, clipId?: string, editUrl?: string, error?: string}>}
   */
  async createClip(broadcasterId) {
    try {
      const response = await this.http.post('/clips',
        { broadcaster_id: broadcasterId },
        { headers: this.getHeaders() }
      );

      const clip = response.data?.data?.[0];
      if (!clip) {
        return { success: false, error: 'No clip data returned' };
      }

      return {
        success: true,
        clipId: clip.id,
        editUrl: clip.edit_url
      };
    } catch (error) {
      const msg = error?.response?.data?.message || error.message;
      console.error('Error creating clip:', msg);
      return { success: false, error: msg };
    }
  }

  // ==================== MODERATION ====================

  /**
   * Timeout a user
   * @param {string} broadcasterId
   * @param {string} moderatorId
   * @param {string} userId
   * @param {number} duration - Duration in seconds
   * @param {string} [reason]
   */
  async timeoutUser(broadcasterId, moderatorId, userId, duration, reason = '') {
    try {
      await this.http.post('/moderation/bans',
        {
          data: {
            user_id: userId,
            duration,
            reason
          }
        },
        {
          params: { broadcaster_id: broadcasterId, moderator_id: moderatorId },
          headers: this.getHeaders()
        }
      );
      return { success: true };
    } catch (error) {
      const msg = error?.response?.data?.message || error.message;
      console.error('Error timing out user:', msg);
      return { success: false, error: msg };
    }
  }

  /**
   * Ban a user
   * @param {string} broadcasterId
   * @param {string} moderatorId
   * @param {string} userId
   * @param {string} [reason]
   */
  async banUser(broadcasterId, moderatorId, userId, reason = '') {
    try {
      await this.http.post('/moderation/bans',
        {
          data: {
            user_id: userId,
            reason
          }
        },
        {
          params: { broadcaster_id: broadcasterId, moderator_id: moderatorId },
          headers: this.getHeaders()
        }
      );
      return { success: true };
    } catch (error) {
      const msg = error?.response?.data?.message || error.message;
      console.error('Error banning user:', msg);
      return { success: false, error: msg };
    }
  }

  // ==================== GAMES ====================

  /**
   * Get game by name
   * @param {string} name
   * @returns {Promise<{id: string, name: string, boxArtUrl: string} | null>}
   */
  async getGameByName(name) {
    try {
      const response = await this.http.get('/games', {
        params: { name },
        headers: this.getHeaders()
      });

      const game = response.data?.data?.[0];
      if (!game) return null;

      return {
        id: game.id,
        name: game.name,
        boxArtUrl: game.box_art_url
      };
    } catch (error) {
      console.error('Error getting game:', error.message);
      return null;
    }
  }

  /**
   * Search categories/games
   * @param {string} query
   * @returns {Promise<Array>}
   */
  async searchCategories(query) {
    try {
      const response = await this.http.get('/search/categories', {
        params: { query },
        headers: this.getHeaders()
      });

      return (response.data?.data || []).map(cat => ({
        id: cat.id,
        name: cat.name,
        boxArtUrl: cat.box_art_url
      }));
    } catch (error) {
      console.error('Error searching categories:', error.message);
      return [];
    }
  }

  // ==================== POLLS ====================

  /**
   * Create a poll
   * @param {Object} options
   */
  async createPoll(options) {
    try {
      const response = await this.http.post('/polls', options, {
        headers: this.getHeaders()
      });

      const poll = response.data?.data?.[0];
      return { success: true, poll };
    } catch (error) {
      const msg = error?.response?.data?.message || error.message;
      console.error('Error creating poll:', msg);
      return { success: false, error: msg };
    }
  }

  /**
   * End a poll
   * @param {string} broadcasterId
   * @param {string} pollId
   * @param {string} status - 'TERMINATED' or 'ARCHIVED'
   */
  async endPoll(broadcasterId, pollId, status = 'TERMINATED') {
    try {
      const response = await this.http.patch('/polls',
        { broadcaster_id: broadcasterId, id: pollId, status },
        { headers: this.getHeaders() }
      );
      return { success: true, poll: response.data?.data?.[0] };
    } catch (error) {
      const msg = error?.response?.data?.message || error.message;
      console.error('Error ending poll:', msg);
      return { success: false, error: msg };
    }
  }

  // ==================== PREDICTIONS ====================

  /**
   * Create a prediction
   * @param {Object} options
   */
  async createPrediction(options) {
    try {
      const response = await this.http.post('/predictions', options, {
        headers: this.getHeaders()
      });

      const prediction = response.data?.data?.[0];
      return { success: true, prediction };
    } catch (error) {
      const msg = error?.response?.data?.message || error.message;
      console.error('Error creating prediction:', msg);
      return { success: false, error: msg };
    }
  }

  /**
   * Resolve/end a prediction
   * @param {string} broadcasterId
   * @param {string} predictionId
   * @param {string} status - 'RESOLVED', 'CANCELED', or 'LOCKED'
   * @param {string} [winningOutcomeId] - Required if status is 'RESOLVED'
   */
  async resolvePrediction(broadcasterId, predictionId, status, winningOutcomeId = null) {
    try {
      const body = {
        broadcaster_id: broadcasterId,
        id: predictionId,
        status
      };
      if (winningOutcomeId) {
        body.winning_outcome_id = winningOutcomeId;
      }

      const response = await this.http.patch('/predictions', body, {
        headers: this.getHeaders()
      });
      return { success: true, prediction: response.data?.data?.[0] };
    } catch (error) {
      const msg = error?.response?.data?.message || error.message;
      console.error('Error resolving prediction:', msg);
      return { success: false, error: msg };
    }
  }
}

module.exports = TwitchHelixAPI;
