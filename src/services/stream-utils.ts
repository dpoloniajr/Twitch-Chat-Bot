/**
 * Stream Utilities
 * Uptime, watchtime, and stream information
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/logger';

const logger = createLogger('StreamUtils');

/**
 * User watch session
 */
export interface WatchSession {
  username: string;
  joinedAt: string;
  lastSeen: string;
  isActive: boolean;
}

/**
 * User watchtime data
 */
export interface WatchtimeData {
  totalMinutes: number;
  sessions: number;
  lastSession?: string;
  firstSeen: string;
}

/**
 * Stream session info
 */
export interface StreamSession {
  startedAt: string;
  endedAt?: string;
  peakViewers: number;
  averageViewers: number;
  viewerSamples: number[];
  totalChatMessages: number;
  uniqueChatters: Set<string>;
}

/**
 * Stream utilities manager
 */
export class StreamUtilsManager {
  private activeSessions: Map<string, WatchSession>;
  private watchtimeData: Map<string, WatchtimeData>;
  private currentStream: StreamSession | null = null;
  private dataPath: string;
  private dirty: boolean = false;
  private saveInterval: NodeJS.Timeout | null = null;
  private updateInterval: NodeJS.Timeout | null = null;
  private botStartTime: Date;

  constructor(options?: {
    dataPath?: string;
    autoSaveIntervalMs?: number;
    updateIntervalMs?: number;
  }) {
    this.activeSessions = new Map();
    this.watchtimeData = new Map();
    this.dataPath = options?.dataPath || path.join(process.cwd(), 'dashboard', 'logs', 'watchtime.json');
    this.botStartTime = new Date();

    this.loadData();

    // Auto-save periodically
    const autoSaveInterval = options?.autoSaveIntervalMs || 300000; // 5 minutes
    if (autoSaveInterval > 0) {
      this.saveInterval = setInterval(() => this.saveIfDirty(), autoSaveInterval);
    }

    // Update watchtime periodically
    const updateInterval = options?.updateIntervalMs || 60000; // 1 minute
    if (updateInterval > 0) {
      this.updateInterval = setInterval(() => this.updateWatchtime(), updateInterval);
    }
  }

  /**
   * Load watchtime data from file
   */
  private loadData(): void {
    try {
      if (fs.existsSync(this.dataPath)) {
        const content = fs.readFileSync(this.dataPath, 'utf-8');
        const parsed = JSON.parse(content);

        if (parsed.watchtime) {
          this.watchtimeData = new Map(Object.entries(parsed.watchtime));
        }

        logger.info('Loaded watchtime data', { userCount: this.watchtimeData.size });
      }
    } catch (error) {
      logger.error('Failed to load watchtime data', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Save watchtime data to file
   */
  saveData(): void {
    try {
      const dir = path.dirname(this.dataPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const saveData = {
        watchtime: Object.fromEntries(this.watchtimeData),
        savedAt: new Date().toISOString(),
      };

      fs.writeFileSync(this.dataPath, JSON.stringify(saveData, null, 2));
      this.dirty = false;
      logger.debug('Saved watchtime data', { userCount: this.watchtimeData.size });
    } catch (error) {
      logger.error('Failed to save watchtime data', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Save if there are pending changes
   */
  private saveIfDirty(): void {
    if (this.dirty) {
      this.saveData();
    }
  }

  // ==================== Stream Status ====================

  /**
   * Mark stream as online
   */
  streamOnline(): void {
    this.currentStream = {
      startedAt: new Date().toISOString(),
      peakViewers: 0,
      averageViewers: 0,
      viewerSamples: [],
      totalChatMessages: 0,
      uniqueChatters: new Set(),
    };

    logger.info('Stream marked as online');
  }

  /**
   * Mark stream as offline
   */
  streamOffline(): void {
    if (this.currentStream) {
      this.currentStream.endedAt = new Date().toISOString();

      // Close all active sessions
      for (const [username, session] of this.activeSessions) {
        this.endSession(username);
      }

      logger.info('Stream marked as offline', {
        duration: this.getStreamUptimeMinutes(),
        peakViewers: this.currentStream.peakViewers,
      });

      this.currentStream = null;
    }
  }

  /**
   * Check if stream is online
   */
  isStreamOnline(): boolean {
    return this.currentStream !== null && !this.currentStream.endedAt;
  }

  /**
   * Get stream uptime in minutes
   */
  getStreamUptimeMinutes(): number {
    if (!this.currentStream) {
      return 0;
    }

    const startTime = new Date(this.currentStream.startedAt);
    const now = new Date();
    return Math.floor((now.getTime() - startTime.getTime()) / 60000);
  }

  /**
   * Get formatted stream uptime
   */
  getFormattedUptime(): string {
    const minutes = this.getStreamUptimeMinutes();

    if (minutes === 0) {
      return 'Stream is offline';
    }

    return this.formatDuration(minutes);
  }

  /**
   * Update viewer count
   */
  updateViewerCount(count: number): void {
    if (!this.currentStream) return;

    this.currentStream.viewerSamples.push(count);

    if (count > this.currentStream.peakViewers) {
      this.currentStream.peakViewers = count;
    }

    // Calculate average
    const sum = this.currentStream.viewerSamples.reduce((a, b) => a + b, 0);
    this.currentStream.averageViewers = Math.round(sum / this.currentStream.viewerSamples.length);
  }

  // ==================== Watchtime Tracking ====================

  /**
   * User joined (started watching)
   */
  userJoined(username: string): void {
    const normalized = username.toLowerCase();

    if (this.activeSessions.has(normalized)) {
      // Update last seen
      const session = this.activeSessions.get(normalized)!;
      session.lastSeen = new Date().toISOString();
      session.isActive = true;
      return;
    }

    this.activeSessions.set(normalized, {
      username: normalized,
      joinedAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      isActive: true,
    });

    // Initialize watchtime data if needed
    if (!this.watchtimeData.has(normalized)) {
      this.watchtimeData.set(normalized, {
        totalMinutes: 0,
        sessions: 0,
        firstSeen: new Date().toISOString(),
      });
      this.dirty = true;
    }
  }

  /**
   * User left (stopped watching)
   */
  userLeft(username: string): void {
    const normalized = username.toLowerCase();
    this.endSession(normalized);
  }

  /**
   * User sent a message (activity indicator)
   */
  userActive(username: string): void {
    const normalized = username.toLowerCase();

    if (!this.activeSessions.has(normalized)) {
      this.userJoined(normalized);
    }

    const session = this.activeSessions.get(normalized)!;
    session.lastSeen = new Date().toISOString();
    session.isActive = true;

    // Track chat message in stream stats
    if (this.currentStream) {
      this.currentStream.totalChatMessages++;
      this.currentStream.uniqueChatters.add(normalized);
    }
  }

  /**
   * End a watch session and credit time
   */
  private endSession(username: string): void {
    const session = this.activeSessions.get(username);
    if (!session) return;

    const joinTime = new Date(session.joinedAt);
    const lastSeen = new Date(session.lastSeen);
    const minutesWatched = Math.floor((lastSeen.getTime() - joinTime.getTime()) / 60000);

    if (minutesWatched > 0) {
      const data = this.watchtimeData.get(username);
      if (data) {
        data.totalMinutes += minutesWatched;
        data.sessions++;
        data.lastSession = new Date().toISOString();
        this.dirty = true;
      }
    }

    this.activeSessions.delete(username);
  }

  /**
   * Update watchtime for all active users
   */
  private updateWatchtime(): void {
    const now = new Date();
    const inactiveThreshold = 10 * 60 * 1000; // 10 minutes

    for (const [username, session] of this.activeSessions) {
      const lastSeen = new Date(session.lastSeen);
      const timeSinceLastSeen = now.getTime() - lastSeen.getTime();

      // Mark inactive sessions
      if (timeSinceLastSeen > inactiveThreshold) {
        if (session.isActive) {
          session.isActive = false;
          logger.debug('User marked inactive', { username, timeSinceLastSeen });
        }
      }

      // Credit 1 minute of watchtime for active users
      if (session.isActive) {
        const data = this.watchtimeData.get(username);
        if (data) {
          data.totalMinutes++;
          this.dirty = true;
        }
      }
    }

    // Clean up very old inactive sessions (1 hour)
    const cleanupThreshold = 60 * 60 * 1000;
    for (const [username, session] of this.activeSessions) {
      const lastSeen = new Date(session.lastSeen);
      if (now.getTime() - lastSeen.getTime() > cleanupThreshold) {
        this.endSession(username);
      }
    }
  }

  /**
   * Get user watchtime in minutes
   */
  getWatchtime(username: string): number {
    const normalized = username.toLowerCase();
    const data = this.watchtimeData.get(normalized);
    return data?.totalMinutes || 0;
  }

  /**
   * Get formatted watchtime for a user
   */
  getFormattedWatchtime(username: string): string {
    const minutes = this.getWatchtime(username);

    if (minutes === 0) {
      return 'No watchtime recorded';
    }

    return this.formatDuration(minutes);
  }

  /**
   * Get user watchtime data
   */
  getWatchtimeData(username: string): WatchtimeData | null {
    return this.watchtimeData.get(username.toLowerCase()) || null;
  }

  /**
   * Get watchtime leaderboard
   */
  getWatchtimeLeaderboard(limit: number = 10): Array<{
    username: string;
    totalMinutes: number;
    rank: number;
  }> {
    const entries = Array.from(this.watchtimeData.entries())
      .map(([username, data]) => ({
        username,
        totalMinutes: data.totalMinutes,
        rank: 0,
      }))
      .sort((a, b) => b.totalMinutes - a.totalMinutes)
      .slice(0, limit);

    entries.forEach((entry, index) => {
      entry.rank = index + 1;
    });

    return entries;
  }

  /**
   * Get user's watchtime rank
   */
  getWatchtimeRank(username: string): number | null {
    const normalized = username.toLowerCase();
    const sorted = Array.from(this.watchtimeData.entries())
      .sort((a, b) => b[1].totalMinutes - a[1].totalMinutes);

    const index = sorted.findIndex(([name]) => name === normalized);
    return index >= 0 ? index + 1 : null;
  }

  // ==================== Bot Uptime ====================

  /**
   * Get bot uptime in minutes
   */
  getBotUptimeMinutes(): number {
    const now = new Date();
    return Math.floor((now.getTime() - this.botStartTime.getTime()) / 60000);
  }

  /**
   * Get formatted bot uptime
   */
  getFormattedBotUptime(): string {
    return this.formatDuration(this.getBotUptimeMinutes());
  }

  // ==================== Utilities ====================

  /**
   * Format duration in human-readable format
   */
  formatDuration(minutes: number): string {
    if (minutes < 60) {
      return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
    }

    if (minutes < 1440) {
      const hours = Math.floor(minutes / 60);
      const mins = minutes % 60;
      let result = `${hours} hour${hours !== 1 ? 's' : ''}`;
      if (mins > 0) {
        result += ` ${mins} minute${mins !== 1 ? 's' : ''}`;
      }
      return result;
    }

    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    let result = `${days} day${days !== 1 ? 's' : ''}`;
    if (hours > 0) {
      result += ` ${hours} hour${hours !== 1 ? 's' : ''}`;
    }
    return result;
  }

  /**
   * Get current stream stats
   */
  getStreamStats(): {
    isOnline: boolean;
    uptimeMinutes: number;
    peakViewers: number;
    averageViewers: number;
    totalMessages: number;
    uniqueChatters: number;
  } | null {
    if (!this.currentStream) {
      return null;
    }

    return {
      isOnline: this.isStreamOnline(),
      uptimeMinutes: this.getStreamUptimeMinutes(),
      peakViewers: this.currentStream.peakViewers,
      averageViewers: this.currentStream.averageViewers,
      totalMessages: this.currentStream.totalChatMessages,
      uniqueChatters: this.currentStream.uniqueChatters.size,
    };
  }

  /**
   * Get active viewer count
   */
  getActiveViewerCount(): number {
    let count = 0;
    for (const session of this.activeSessions.values()) {
      if (session.isActive) {
        count++;
      }
    }
    return count;
  }

  /**
   * Clean up and stop intervals
   */
  destroy(): void {
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
      this.saveInterval = null;
    }
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }

    // End all active sessions
    for (const username of this.activeSessions.keys()) {
      this.endSession(username);
    }

    this.saveIfDirty();
  }
}

// Singleton instance
let defaultManager: StreamUtilsManager | null = null;

export function getStreamUtilsManager(): StreamUtilsManager {
  if (!defaultManager) {
    defaultManager = new StreamUtilsManager();
  }
  return defaultManager;
}

export function resetStreamUtilsManager(): void {
  if (defaultManager) {
    defaultManager.destroy();
    defaultManager = null;
  }
}
