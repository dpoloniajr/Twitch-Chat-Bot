/**
 * Moderation Commands Module
 * Provides ban, timeout, unban, and permit functionality
 */

import { CommandResult, TwitchUser } from '../types';
import { createLogger } from '../utils/logger';
import { REQUIRED_SCOPES } from '../config/constants';

const logger = createLogger('Moderation');

/**
 * Interface for the API client (to be injected)
 */
export interface ModerationApiClient {
  getUserByName(username: string): Promise<TwitchUser | null>;
  banUser(
    broadcasterId: string,
    moderatorId: string,
    userId: string,
    reason?: string
  ): Promise<{ success: boolean; error?: string }>;
  unbanUser(
    broadcasterId: string,
    moderatorId: string,
    userId: string
  ): Promise<{ success: boolean; error?: string }>;
  timeoutUser(
    broadcasterId: string,
    moderatorId: string,
    userId: string,
    duration: number,
    reason?: string
  ): Promise<{ success: boolean; error?: string }>;
}

/**
 * Moderation manager for handling user bans, timeouts, and permits
 */
export class ModerationManager {
  private apiClient: ModerationApiClient;
  private broadcasterId: string;
  private moderatorId: string;
  private scopes: string[];
  private permitList: Map<string, number>; // username -> expiry timestamp
  private permitDurationMs: number;

  constructor(options: {
    apiClient: ModerationApiClient;
    broadcasterId: string;
    moderatorId: string;
    scopes: string[];
    permitDurationSeconds?: number;
  }) {
    this.apiClient = options.apiClient;
    this.broadcasterId = options.broadcasterId;
    this.moderatorId = options.moderatorId;
    this.scopes = options.scopes;
    this.permitList = new Map();
    this.permitDurationMs = (options.permitDurationSeconds || 60) * 1000;
  }

  /**
   * Check if required scope is available
   */
  private hasScope(scope: string): boolean {
    return this.scopes.includes(scope);
  }

  /**
   * Ban a user from the channel
   */
  async banUser(username: string, reason?: string): Promise<CommandResult> {
    if (!this.hasScope(REQUIRED_SCOPES.MODERATOR_MANAGE_BANNED_USERS)) {
      return {
        success: false,
        error: `Missing scope: ${REQUIRED_SCOPES.MODERATOR_MANAGE_BANNED_USERS}`,
      };
    }

    try {
      const user = await this.apiClient.getUserByName(username);
      if (!user) {
        return { success: false, error: `User "${username}" not found` };
      }

      const result = await this.apiClient.banUser(
        this.broadcasterId,
        this.moderatorId,
        user.id,
        reason
      );

      if (!result.success) {
        logger.warn('Ban failed', { username, error: result.error });
        return { success: false, error: result.error || 'Failed to ban user' };
      }

      logger.info('User banned', { username, reason });
      return {
        success: true,
        message: `${user.displayName || username} has been banned${reason ? `: ${reason}` : ''}`,
        data: { userId: user.id, username: user.displayName || username },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Ban error', { username, error: message });
      return { success: false, error: message };
    }
  }

  /**
   * Unban a user from the channel
   */
  async unbanUser(username: string): Promise<CommandResult> {
    if (!this.hasScope(REQUIRED_SCOPES.MODERATOR_MANAGE_BANNED_USERS)) {
      return {
        success: false,
        error: `Missing scope: ${REQUIRED_SCOPES.MODERATOR_MANAGE_BANNED_USERS}`,
      };
    }

    try {
      const user = await this.apiClient.getUserByName(username);
      if (!user) {
        return { success: false, error: `User "${username}" not found` };
      }

      const result = await this.apiClient.unbanUser(
        this.broadcasterId,
        this.moderatorId,
        user.id
      );

      if (!result.success) {
        logger.warn('Unban failed', { username, error: result.error });
        return { success: false, error: result.error || 'Failed to unban user' };
      }

      logger.info('User unbanned', { username });
      return {
        success: true,
        message: `${user.displayName || username} has been unbanned`,
        data: { userId: user.id, username: user.displayName || username },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Unban error', { username, error: message });
      return { success: false, error: message };
    }
  }

  /**
   * Timeout a user for a specified duration
   */
  async timeoutUser(
    username: string,
    durationSeconds: number,
    reason?: string
  ): Promise<CommandResult> {
    if (!this.hasScope(REQUIRED_SCOPES.MODERATOR_MANAGE_BANNED_USERS)) {
      return {
        success: false,
        error: `Missing scope: ${REQUIRED_SCOPES.MODERATOR_MANAGE_BANNED_USERS}`,
      };
    }

    // Validate duration (1 second to 2 weeks)
    const minDuration = 1;
    const maxDuration = 1209600; // 2 weeks in seconds
    const duration = Math.max(minDuration, Math.min(maxDuration, durationSeconds));

    try {
      const user = await this.apiClient.getUserByName(username);
      if (!user) {
        return { success: false, error: `User "${username}" not found` };
      }

      const result = await this.apiClient.timeoutUser(
        this.broadcasterId,
        this.moderatorId,
        user.id,
        duration,
        reason
      );

      if (!result.success) {
        logger.warn('Timeout failed', { username, duration, error: result.error });
        return { success: false, error: result.error || 'Failed to timeout user' };
      }

      logger.info('User timed out', { username, duration, reason });
      return {
        success: true,
        message: `${user.displayName || username} has been timed out for ${this.formatDuration(duration)}${reason ? `: ${reason}` : ''}`,
        data: {
          userId: user.id,
          username: user.displayName || username,
          duration,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Timeout error', { username, error: message });
      return { success: false, error: message };
    }
  }

  /**
   * Untimeout a user (remove active timeout)
   */
  async untimeoutUser(username: string): Promise<CommandResult> {
    // Untimeout is the same as unban for timeouts in Twitch API
    return this.unbanUser(username);
  }

  /**
   * Grant a temporary permit to a user (allows them to post links, etc.)
   */
  permitUser(username: string, durationSeconds?: number): CommandResult {
    const normalizedUsername = username.toLowerCase().replace(/^@/, '');
    const duration = durationSeconds ? durationSeconds * 1000 : this.permitDurationMs;
    const expiry = Date.now() + duration;

    this.permitList.set(normalizedUsername, expiry);

    logger.info('Permit granted', { username: normalizedUsername, durationMs: duration });

    return {
      success: true,
      message: `${username} has been permitted for ${this.formatDuration(duration / 1000)}`,
      data: { username: normalizedUsername, expiresAt: expiry },
    };
  }

  /**
   * Check if a user has an active permit
   */
  hasPermit(username: string): boolean {
    const normalizedUsername = username.toLowerCase();
    const expiry = this.permitList.get(normalizedUsername);

    if (!expiry) {
      return false;
    }

    if (Date.now() > expiry) {
      this.permitList.delete(normalizedUsername);
      return false;
    }

    return true;
  }

  /**
   * Revoke a user's permit
   */
  revokePermit(username: string): boolean {
    const normalizedUsername = username.toLowerCase().replace(/^@/, '');
    return this.permitList.delete(normalizedUsername);
  }

  /**
   * Clean up expired permits
   */
  cleanupExpiredPermits(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [username, expiry] of this.permitList.entries()) {
      if (now > expiry) {
        this.permitList.delete(username);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug('Cleaned up expired permits', { count: cleaned });
    }

    return cleaned;
  }

  /**
   * Format duration in human-readable format
   */
  private formatDuration(seconds: number): string {
    if (seconds < 60) {
      return `${seconds} second${seconds !== 1 ? 's' : ''}`;
    }

    if (seconds < 3600) {
      const minutes = Math.floor(seconds / 60);
      return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
    }

    if (seconds < 86400) {
      const hours = Math.floor(seconds / 3600);
      return `${hours} hour${hours !== 1 ? 's' : ''}`;
    }

    const days = Math.floor(seconds / 86400);
    return `${days} day${days !== 1 ? 's' : ''}`;
  }

  /**
   * Parse duration string (e.g., "10m", "1h", "1d") to seconds
   */
  static parseDuration(input: string): number | null {
    const match = input.match(/^(\d+)([smhd]?)$/i);
    if (!match) {
      return null;
    }

    const value = parseInt(match[1], 10);
    const unit = (match[2] || 's').toLowerCase();

    switch (unit) {
      case 's':
        return value;
      case 'm':
        return value * 60;
      case 'h':
        return value * 3600;
      case 'd':
        return value * 86400;
      default:
        return value;
    }
  }

  /**
   * Update configuration
   */
  updateConfig(options: {
    broadcasterId?: string;
    moderatorId?: string;
    scopes?: string[];
    permitDurationSeconds?: number;
  }): void {
    if (options.broadcasterId) this.broadcasterId = options.broadcasterId;
    if (options.moderatorId) this.moderatorId = options.moderatorId;
    if (options.scopes) this.scopes = options.scopes;
    if (options.permitDurationSeconds) {
      this.permitDurationMs = options.permitDurationSeconds * 1000;
    }
  }

  /**
   * Get current permit count
   */
  getPermitCount(): number {
    this.cleanupExpiredPermits();
    return this.permitList.size;
  }
}

// Export types for external use
export type { CommandResult };
