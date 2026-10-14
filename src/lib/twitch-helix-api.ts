/**
 * TwitchHelixAPI - Direct Twitch Helix API client
 * Replaces @twurple/api with native HTTP calls
 */

import axios from 'axios';
import type { AxiosError, AxiosInstance, AxiosResponse, InternalAxiosRequestConfig } from 'axios';

const HELIX_BASE_URL = 'https://api.twitch.tv/helix';
const OAUTH_VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';
const API_TIMEOUT = 5000;

export interface TwitchHelixAPIOptions {
  clientId?: string;
  accessToken?: string;
  /** Request timeout in ms (default 5000) */
  timeout?: number;
}

export interface RefreshedTokenPair {
  accessToken: string;
  refreshToken: string;
}

/**
 * Called when a 401 is encountered. Must return { accessToken, refreshToken } on
 * success, or null on failure.
 */
export type TokenRefreshCallback = () => Promise<RefreshedTokenPair | null>;

export type HelixHeaders = {
  'Client-ID': string | undefined;
  Authorization: string;
  'Content-Type': string;
};

export interface TokenInfo {
  userId: string;
  login: string;
  scopes: string[];
  expiresIn: number;
  clientId: string;
}

export interface HelixUser {
  id: string;
  login: string;
  /** Twurple compatibility */
  name: string;
  displayName: string;
  profileImageUrl: string;
  description: string;
  broadcasterType: string;
  createdAt: Date;
}

export interface HelixChannelInfo {
  id: string;
  broadcasterLogin: string;
  broadcasterName: string;
  gameName: string;
  gameId: string;
  title: string;
  language: string;
  tags: string[];
}

export interface HelixFollower {
  userId: string;
  userLogin: string;
  userName: string;
  followDate: Date;
  /** Twurple compatibility */
  followedAt: Date;
}

export interface HelixFollowersResult {
  data: HelixFollower[];
  total: number;
  cursor?: string;
}

export interface HelixStream {
  id: string;
  userId: string;
  userLogin: string;
  userName: string;
  gameId: string;
  gameName: string;
  type: string;
  title: string;
  viewerCount: number;
  startedAt: Date;
  thumbnailUrl: string;
  language: string;
  isMature: boolean;
}

export type HelixStreamSummary = Pick<
  HelixStream,
  'id' | 'userId' | 'userLogin' | 'userName' | 'gameId' | 'gameName' | 'title' | 'viewerCount' | 'startedAt'
>;

export interface HelixGame {
  id: string;
  name: string;
  boxArtUrl: string;
}

export interface SuccessResult {
  success: true;
}

export interface FailureResult {
  success: false;
  error: string;
}

export type ActionResult = SuccessResult | FailureResult;

/** Options for read methods that otherwise report API errors as "nothing found" */
export interface LookupOptions {
  /** Rethrow API errors, so callers can tell an outage from a missing user, follow or stream */
  throwOnError?: boolean;
}

export type AnnouncementResult = SuccessResult | (FailureResult & { status: number | undefined });

export type AnnouncementColor = 'blue' | 'green' | 'orange' | 'purple' | 'primary';

export type ClipResult = (SuccessResult & { clipId: string; editUrl: string }) | FailureResult;

export interface UpdateChannelData {
  title?: string;
  game_id?: string;
  [key: string]: unknown;
}

/** Raw poll / prediction payloads are passed through from Twitch untouched */
export type PollResult = (SuccessResult & { poll: any }) | FailureResult;
export type PredictionResult = (SuccessResult & { prediction: any }) | FailureResult;

export type PollEndStatus = 'TERMINATED' | 'ARCHIVED';
export type PredictionEndStatus = 'RESOLVED' | 'CANCELED' | 'LOCKED';

/** Twitch error bodies carry a human-readable `message` */
type HelixError = AxiosError<{ message?: string } | undefined>;

type RetriableRequestConfig = InternalAxiosRequestConfig & { _retried?: boolean };

/** Raw Helix list envelope; item fields are the snake_case Twitch payload */
interface HelixEnvelope {
  data?: any[];
  total?: number;
  pagination?: { cursor?: string };
}

export class TwitchHelixAPI {
  clientId: string | undefined;
  accessToken: string | undefined;
  timeout: number;
  http: AxiosInstance;
  private _onTokenRefresh: TokenRefreshCallback | null;
  private _refreshPromise: Promise<RefreshedTokenPair | null> | null;

  constructor(options: TwitchHelixAPIOptions = {}) {
    this.clientId = options.clientId;
    this.accessToken = options.accessToken;
    this.timeout = options.timeout || API_TIMEOUT;
    this._onTokenRefresh = null;
    this._refreshPromise = null;

    // Create axios instance with defaults
    this.http = axios.create({
      baseURL: HELIX_BASE_URL,
      timeout: this.timeout
    });

    // Intercept 401 responses: refresh the token and retry once.
    // Concurrent 401s share one refresh, and a request sent with a token that
    // has since been replaced is retried with the current token without refreshing.
    this.http.interceptors.response.use(
      response => response,
      async (error: HelixError) => {
        const originalRequest = error?.config as RetriableRequestConfig | undefined;
        if (
          error?.response?.status !== 401 ||
          !originalRequest ||
          originalRequest._retried ||
          !this._onTokenRefresh
        ) {
          return Promise.reject(error);
        }
        originalRequest._retried = true;

        const sentWith = String(originalRequest.headers?.['Authorization'] || '').replace(/^Bearer /, '');
        let token = this.accessToken;
        if (sentWith === token) {
          const refreshed = await this._refreshAccessToken();
          if (!refreshed) return Promise.reject(error);
          token = refreshed.accessToken;
        }
        originalRequest.headers['Authorization'] = `Bearer ${token}`;
        return this.http(originalRequest);
      }
    );
  }

  /**
   * Run the registered refresh callback, sharing one call between concurrent 401s.
   */
  private _refreshAccessToken(): Promise<RefreshedTokenPair | null> {
    if (!this._refreshPromise) {
      const run = async (): Promise<RefreshedTokenPair | null> => {
        try {
          const refreshed = await this._onTokenRefresh!();
          if (refreshed?.accessToken) {
            this.setAccessToken(refreshed.accessToken);
            return refreshed;
          }
          return null;
        } catch (refreshError) {
          console.error('Token refresh after 401 failed:', (refreshError as Error | null)?.message ?? refreshError);
          return null;
        }
      };
      // Cleared in a .finally() attached after the assignment, so even a callback
      // that throws synchronously cannot leave a settled promise behind
      this._refreshPromise = run().finally(() => {
        this._refreshPromise = null;
      });
    }
    return this._refreshPromise;
  }

  /**
   * Register a callback invoked when a 401 is encountered.
   * The callback must return { accessToken, refreshToken } on success, or null on failure.
   */
  setOnTokenRefresh(fn: TokenRefreshCallback | null): void {
    this._onTokenRefresh = fn;
  }

  /**
   * Update the access token (e.g., after refresh)
   */
  setAccessToken(token: string | undefined): void {
    this.accessToken = token;
  }

  /**
   * Get headers for Helix API requests
   */
  getHeaders(): HelixHeaders {
    return {
      'Client-ID': this.clientId,
      'Authorization': `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json'
    };
  }

  // ==================== TOKEN INFO ====================

  /**
   * Validate token and get token info (equivalent to apiClient.getTokenInfo())
   */
  async getTokenInfo(): Promise<TokenInfo | null> {
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
      if ((error as HelixError).response?.status === 401) {
        return null;
      }
      throw error;
    }
  }

  // ==================== USERS ====================

  /**
   * Get user by login name (equivalent to apiClient.users.getUserByName())
   * @param login - The username/login
   * @param options - throwOnError: rethrow API errors instead of returning null
   */
  async getUserByName(login: string, { throwOnError = false }: LookupOptions = {}): Promise<HelixUser | null> {
    try {
      // Input validation: ensure login is a string
      if (typeof login !== 'string') {
        console.error('getUserByName: login must be a string, received:', typeof login);
        return null;
      }

      // Sanitize input: strip @ symbols, trim whitespace, normalize to lowercase
      // Also remove trailing punctuation that might be accidentally included
      const cleanLogin = login
        .replace(/^@+/, '')          // Remove leading @ symbols
        .trim()                       // Remove surrounding whitespace
        .replace(/[.,;:!?]+$/, '')   // Remove trailing punctuation
        .toLowerCase();               // Normalize to lowercase (Twitch usernames are case-insensitive)

      // Avoid unnecessary API call if username is empty after sanitization
      if (!cleanLogin) {
        return null;
      }

      const response: AxiosResponse<HelixEnvelope> = await this.http.get('/users', {
        params: { login: cleanLogin },
        headers: this.getHeaders()
      });

      const user = response.data?.data?.[0];
      if (!user) return null;

      return this._mapUser(user);
    } catch (error) {
      console.error('Error getting user by name:', (error as Error).message);
      if (throwOnError) throw error;
      return null;
    }
  }

  /**
   * Get user by ID (equivalent to apiClient.users.getUserById())
   * @param userId - The user ID
   */
  async getUserById(userId: string): Promise<HelixUser | null> {
    try {
      const response: AxiosResponse<HelixEnvelope> = await this.http.get('/users', {
        params: { id: userId },
        headers: this.getHeaders()
      });

      const user = response.data?.data?.[0];
      if (!user) return null;

      return this._mapUser(user);
    } catch (error) {
      console.error('Error getting user by ID:', (error as Error).message);
      return null;
    }
  }

  /**
   * Get multiple users by IDs
   * @param userIds - Array of user IDs (max 100)
   */
  async getUsersByIds(userIds: string[]): Promise<HelixUser[]> {
    try {
      const params = new URLSearchParams();
      userIds.slice(0, 100).forEach(id => params.append('id', id));

      const response: AxiosResponse<HelixEnvelope> = await this.http.get('/users', {
        params,
        headers: this.getHeaders()
      });

      return (response.data?.data || []).map(u => this._mapUser(u));
    } catch (error) {
      console.error('Error getting users by IDs:', (error as Error).message);
      return [];
    }
  }

  /** Map a raw Helix user payload to the Twurple-compatible shape */
  _mapUser(user: any): HelixUser {
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
   */
  async getChannelInfo(broadcasterId: string): Promise<HelixChannelInfo | null> {
    try {
      const response: AxiosResponse<HelixEnvelope> = await this.http.get('/channels', {
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
      console.error('Error getting channel info:', (error as Error).message);
      return null;
    }
  }

  /**
   * Get channel followers (equivalent to apiClient.channels.getChannelFollowers())
   * @param broadcasterId - The broadcaster's user ID
   * @param userId - Optional specific user ID to check
   * @param options - throwOnError: rethrow API errors instead of returning an empty result
   */
  async getChannelFollowers(
    broadcasterId: string,
    userId: string | null = null,
    { throwOnError = false }: LookupOptions = {}
  ): Promise<HelixFollowersResult> {
    try {
      const params: { broadcaster_id: string; user_id?: string } = { broadcaster_id: broadcasterId };
      if (userId) {
        params.user_id = userId;
      }

      const response: AxiosResponse<HelixEnvelope> = await this.http.get('/channels/followers', {
        params,
        headers: this.getHeaders()
      });

      const followers: HelixFollower[] = (response.data?.data || []).map(f => ({
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
      console.error('Error getting channel followers:', (error as Error).message);
      if (throwOnError) throw error;
      return { data: [], total: 0 };
    }
  }

  /**
   * Update channel info (title, game, etc.)
   * @param data - { title?: string, game_id?: string }
   */
  async updateChannel(broadcasterId: string, data: UpdateChannelData): Promise<ActionResult> {
    try {
      await this.http.patch('/channels', data, {
        params: { broadcaster_id: broadcasterId },
        headers: this.getHeaders()
      });
      return { success: true };
    } catch (error) {
      const msg = errorMessage(error);
      console.error('Error updating channel:', msg);
      return { success: false, error: msg };
    }
  }

  // ==================== STREAMS ====================

  /**
   * Get stream by user ID (equivalent to apiClient.streams.getStreamByUserId())
   * @param options - throwOnError: rethrow API errors instead of returning null (offline)
   */
  async getStreamByUserId(userId: string, { throwOnError = false }: LookupOptions = {}): Promise<HelixStream | null> {
    try {
      const response: AxiosResponse<HelixEnvelope> = await this.http.get('/streams', {
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
      console.error('Error getting stream:', (error as Error).message);
      if (throwOnError) throw error;
      return null;
    }
  }

  /**
   * Get multiple streams by user IDs
   */
  async getStreamsByUserIds(userIds: string[]): Promise<HelixStreamSummary[]> {
    try {
      const params = new URLSearchParams();
      userIds.slice(0, 100).forEach(id => params.append('user_id', id));

      const response: AxiosResponse<HelixEnvelope> = await this.http.get('/streams', {
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
      console.error('Error getting streams:', (error as Error).message);
      return [];
    }
  }

  // ==================== CHAT ====================

  /**
   * Send an announcement in chat (equivalent to apiClient.chat.createAnnouncement())
   * @param color - 'blue', 'green', 'orange', 'purple', or 'primary'
   */
  async sendAnnouncement(
    broadcasterId: string,
    moderatorId: string,
    message: string,
    color: AnnouncementColor = 'primary'
  ): Promise<AnnouncementResult> {
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
      const msg = errorMessage(error);
      const status = (error as HelixError)?.response?.status;
      console.error('Error sending announcement:', msg);
      return { success: false, error: msg, status };
    }
  }

  /**
   * Send a shoutout
   */
  async sendShoutout(fromBroadcasterId: string, toBroadcasterId: string, moderatorId: string): Promise<ActionResult> {
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
      const msg = errorMessage(error);
      console.error('Error sending shoutout:', msg);
      return { success: false, error: msg };
    }
  }

  // ==================== CLIPS ====================

  /**
   * Create a clip
   */
  async createClip(broadcasterId: string): Promise<ClipResult> {
    try {
      // No body: Helix Create Clip takes broadcaster_id in the query string
      const response: AxiosResponse<HelixEnvelope> = await this.http.post('/clips',
        undefined,
        {
          headers: this.getHeaders(),
          params: {
            broadcaster_id: broadcasterId
          }
        }
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
      const msg = errorMessage(error);
      console.error('Error creating clip:', msg);
      return { success: false, error: msg };
    }
  }

  // ==================== MODERATION ====================

  /**
   * Timeout a user
   * @param duration - Duration in seconds
   */
  async timeoutUser(
    broadcasterId: string,
    moderatorId: string,
    userId: string,
    duration: number,
    reason = ''
  ): Promise<ActionResult> {
    try {
      // Helix Ban User expects the fields wrapped in a `data` object
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
      const msg = errorMessage(error);
      console.error('Error timing out user:', msg);
      return { success: false, error: msg };
    }
  }

  /**
   * Ban a user
   */
  async banUser(broadcasterId: string, moderatorId: string, userId: string, reason = ''): Promise<ActionResult> {
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
      const msg = errorMessage(error);
      console.error('Error banning user:', msg);
      return { success: false, error: msg };
    }
  }

  /**
   * Delete one chat message (Helix DELETE /moderation/chat)
   * Requires moderator:manage:chat_messages on the moderator's token.
   * @param messageId - The IRC message id (the `id` tag)
   */
  async deleteChatMessage(broadcasterId: string, moderatorId: string, messageId: string): Promise<ActionResult> {
    try {
      await this.http.delete('/moderation/chat', {
        params: { broadcaster_id: broadcasterId, moderator_id: moderatorId, message_id: messageId },
        headers: this.getHeaders()
      });
      return { success: true };
    } catch (error) {
      const msg = errorMessage(error);
      console.error('Error deleting chat message:', msg);
      return { success: false, error: msg };
    }
  }

  // ==================== GAMES ====================

  /**
   * Get game by name
   */
  async getGameByName(name: string): Promise<HelixGame | null> {
    try {
      const response: AxiosResponse<HelixEnvelope> = await this.http.get('/games', {
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
      console.error('Error getting game:', (error as Error).message);
      return null;
    }
  }

  /**
   * Search categories/games
   */
  async searchCategories(query: string): Promise<HelixGame[]> {
    try {
      const response: AxiosResponse<HelixEnvelope> = await this.http.get('/search/categories', {
        params: { query },
        headers: this.getHeaders()
      });

      return (response.data?.data || []).map(cat => ({
        id: cat.id,
        name: cat.name,
        boxArtUrl: cat.box_art_url
      }));
    } catch (error) {
      console.error('Error searching categories:', (error as Error).message);
      return [];
    }
  }

  // ==================== POLLS ====================

  /**
   * Create a poll
   * @param options - Raw Helix poll body (broadcaster_id, title, choices, duration, ...)
   */
  async createPoll(options: Record<string, unknown>): Promise<PollResult> {
    try {
      const response: AxiosResponse<HelixEnvelope> = await this.http.post('/polls', options, {
        headers: this.getHeaders()
      });

      const poll = response.data?.data?.[0];
      return { success: true, poll };
    } catch (error) {
      const msg = errorMessage(error);
      console.error('Error creating poll:', msg);
      return { success: false, error: msg };
    }
  }

  /**
   * End a poll
   * @param status - 'TERMINATED' or 'ARCHIVED'
   */
  async endPoll(broadcasterId: string, pollId: string, status: PollEndStatus = 'TERMINATED'): Promise<PollResult> {
    try {
      const response: AxiosResponse<HelixEnvelope> = await this.http.patch('/polls',
        { broadcaster_id: broadcasterId, id: pollId, status },
        { headers: this.getHeaders() }
      );
      return { success: true, poll: response.data?.data?.[0] };
    } catch (error) {
      const msg = errorMessage(error);
      console.error('Error ending poll:', msg);
      return { success: false, error: msg };
    }
  }

  // ==================== PREDICTIONS ====================

  /**
   * Create a prediction
   * @param options - Raw Helix prediction body (broadcaster_id, title, outcomes, prediction_window)
   */
  async createPrediction(options: Record<string, unknown>): Promise<PredictionResult> {
    try {
      const response: AxiosResponse<HelixEnvelope> = await this.http.post('/predictions', options, {
        headers: this.getHeaders()
      });

      const prediction = response.data?.data?.[0];
      return { success: true, prediction };
    } catch (error) {
      const msg = errorMessage(error);
      console.error('Error creating prediction:', msg);
      return { success: false, error: msg };
    }
  }

  /**
   * Resolve/end a prediction
   * @param status - 'RESOLVED', 'CANCELED', or 'LOCKED'
   * @param winningOutcomeId - Required if status is 'RESOLVED'
   */
  async resolvePrediction(
    broadcasterId: string,
    predictionId: string,
    status: PredictionEndStatus,
    winningOutcomeId: string | null = null
  ): Promise<PredictionResult> {
    try {
      const body: { broadcaster_id: string; id: string; status: PredictionEndStatus; winning_outcome_id?: string } = {
        broadcaster_id: broadcasterId,
        id: predictionId,
        status
      };
      if (winningOutcomeId) {
        body.winning_outcome_id = winningOutcomeId;
      }

      const response: AxiosResponse<HelixEnvelope> = await this.http.patch('/predictions', body, {
        headers: this.getHeaders()
      });
      return { success: true, prediction: response.data?.data?.[0] };
    } catch (error) {
      const msg = errorMessage(error);
      console.error('Error resolving prediction:', msg);
      return { success: false, error: msg };
    }
  }
}

/** `error?.response?.data?.message || error.message`, as every write method reports it */
export function errorMessage(error: unknown): string {
  return (error as HelixError)?.response?.data?.message || (error as Error).message;
}
