/**
 * Analytics and Statistics Tracking
 * Track usage patterns, command statistics, and viewer metrics
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/logger';

const logger = createLogger('Analytics');

/**
 * Time bucket for grouping data
 */
export type TimeBucket = 'hour' | 'day' | 'week' | 'month';

/**
 * Command execution record
 */
export interface CommandExecution {
  command: string;
  username: string;
  channel: string;
  timestamp: string;
  success: boolean;
  responseTime?: number;
}

/**
 * Hourly statistics
 */
export interface HourlyStats {
  hour: string; // ISO date string truncated to hour
  commands: number;
  uniqueUsers: number;
  messages: number;
  follows?: number;
  subscriptions?: number;
  bits?: number;
}

/**
 * Command statistics
 */
export interface CommandStats {
  name: string;
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  uniqueUsers: number;
  averageResponseTime?: number;
  lastUsed?: string;
}

/**
 * User activity statistics
 */
export interface UserActivityStats {
  username: string;
  totalCommands: number;
  totalMessages: number;
  favoriteCommands: Array<{ command: string; count: number }>;
  firstSeen: string;
  lastSeen: string;
  daysActive: number;
}

/**
 * Stream session statistics
 */
export interface StreamSessionStats {
  startedAt: string;
  endedAt?: string;
  durationMinutes: number;
  peakViewers: number;
  averageViewers: number;
  newFollowers: number;
  subscriptions: number;
  bitsReceived: number;
  chatMessages: number;
  uniqueChatters: number;
  commandsExecuted: number;
}

/**
 * Analytics configuration
 */
export interface AnalyticsConfig {
  /** Keep detailed data for this many days */
  retentionDays: number;
  /** Sample rate for high-frequency events (0-1) */
  sampleRate: number;
  /** Track individual command executions */
  trackCommands: boolean;
  /** Track chat messages */
  trackMessages: boolean;
  /** Track viewer metrics */
  trackViewers: boolean;
}

const DEFAULT_CONFIG: AnalyticsConfig = {
  retentionDays: 30,
  sampleRate: 1,
  trackCommands: true,
  trackMessages: true,
  trackViewers: true,
};

/**
 * Analytics manager class
 */
export class AnalyticsManager {
  private config: AnalyticsConfig;
  private dataPath: string;
  private commandExecutions: CommandExecution[] = [];
  private hourlyStats: Map<string, HourlyStats> = new Map();
  private commandStats: Map<string, CommandStats> = new Map();
  private streamSessions: StreamSessionStats[] = [];
  private currentSession: StreamSessionStats | null = null;
  private dirty = false;
  private saveInterval: NodeJS.Timeout | null = null;

  constructor(options?: {
    dataPath?: string;
    config?: Partial<AnalyticsConfig>;
    autoSaveIntervalMs?: number;
  }) {
    this.config = { ...DEFAULT_CONFIG, ...options?.config };
    this.dataPath = options?.dataPath || path.join(process.cwd(), 'dashboard', 'logs', 'analytics.json');

    this.loadData();

    // Auto-save periodically
    const autoSaveInterval = options?.autoSaveIntervalMs || 300000; // 5 minutes
    if (autoSaveInterval > 0) {
      this.saveInterval = setInterval(() => this.saveIfDirty(), autoSaveInterval);
    }
  }

  /**
   * Load analytics data from file
   */
  private loadData(): void {
    try {
      if (fs.existsSync(this.dataPath)) {
        const content = fs.readFileSync(this.dataPath, 'utf-8');
        const parsed = JSON.parse(content);

        if (parsed.commandExecutions) {
          this.commandExecutions = parsed.commandExecutions;
        }
        if (parsed.hourlyStats) {
          this.hourlyStats = new Map(Object.entries(parsed.hourlyStats));
        }
        if (parsed.commandStats) {
          this.commandStats = new Map(Object.entries(parsed.commandStats));
        }
        if (parsed.streamSessions) {
          this.streamSessions = parsed.streamSessions;
        }
        if (parsed.config) {
          this.config = { ...this.config, ...parsed.config };
        }

        logger.info('Loaded analytics data');
      }
    } catch (error) {
      logger.error('Failed to load analytics data', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Save analytics data to file
   */
  saveData(): void {
    try {
      const dir = path.dirname(this.dataPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Clean up old data before saving
      this.cleanupOldData();

      const saveData = {
        commandExecutions: this.commandExecutions,
        hourlyStats: Object.fromEntries(this.hourlyStats),
        commandStats: Object.fromEntries(this.commandStats),
        streamSessions: this.streamSessions,
        config: this.config,
        savedAt: new Date().toISOString(),
      };

      fs.writeFileSync(this.dataPath, JSON.stringify(saveData, null, 2));
      this.dirty = false;
      logger.debug('Saved analytics data');
    } catch (error) {
      logger.error('Failed to save analytics data', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Save if dirty
   */
  private saveIfDirty(): void {
    if (this.dirty) {
      this.saveData();
    }
  }

  /**
   * Clean up old data based on retention policy
   */
  private cleanupOldData(): void {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.config.retentionDays);
    const cutoffStr = cutoff.toISOString();

    // Clean command executions
    this.commandExecutions = this.commandExecutions.filter(
      (e) => e.timestamp > cutoffStr
    );

    // Clean hourly stats
    for (const [key, stats] of this.hourlyStats) {
      if (stats.hour < cutoffStr) {
        this.hourlyStats.delete(key);
      }
    }

    // Keep only recent stream sessions
    this.streamSessions = this.streamSessions.slice(-100);
  }

  /**
   * Get hour key for a timestamp
   */
  private getHourKey(date: Date = new Date()): string {
    return date.toISOString().substring(0, 13) + ':00:00.000Z';
  }

  /**
   * Get or create hourly stats bucket
   */
  private getHourlyStatsBucket(date: Date = new Date()): HourlyStats {
    const key = this.getHourKey(date);
    let stats = this.hourlyStats.get(key);

    if (!stats) {
      stats = {
        hour: key,
        commands: 0,
        uniqueUsers: 0,
        messages: 0,
      };
      this.hourlyStats.set(key, stats);
    }

    return stats;
  }

  // ==================== Command Tracking ====================

  /**
   * Track a command execution
   */
  trackCommand(execution: Omit<CommandExecution, 'timestamp'>): void {
    if (!this.config.trackCommands) return;

    // Apply sample rate for high-frequency tracking
    if (this.config.sampleRate < 1 && Math.random() > this.config.sampleRate) {
      return;
    }

    const fullExecution: CommandExecution = {
      ...execution,
      timestamp: new Date().toISOString(),
    };

    this.commandExecutions.push(fullExecution);

    // Update command stats
    let cmdStats = this.commandStats.get(execution.command);
    if (!cmdStats) {
      cmdStats = {
        name: execution.command,
        totalExecutions: 0,
        successfulExecutions: 0,
        failedExecutions: 0,
        uniqueUsers: 0,
      };
      this.commandStats.set(execution.command, cmdStats);
    }

    cmdStats.totalExecutions++;
    if (execution.success) {
      cmdStats.successfulExecutions++;
    } else {
      cmdStats.failedExecutions++;
    }
    cmdStats.lastUsed = fullExecution.timestamp;

    if (execution.responseTime !== undefined) {
      const avgTime = cmdStats.averageResponseTime || 0;
      const total = cmdStats.totalExecutions;
      cmdStats.averageResponseTime = Math.round(
        (avgTime * (total - 1) + execution.responseTime) / total
      );
    }

    // Update hourly stats
    const hourly = this.getHourlyStatsBucket();
    hourly.commands++;

    this.dirty = true;
  }

  /**
   * Get command statistics
   */
  getCommandStats(limit: number = 20): CommandStats[] {
    return Array.from(this.commandStats.values())
      .sort((a, b) => b.totalExecutions - a.totalExecutions)
      .slice(0, limit);
  }

  /**
   * Get statistics for a specific command
   */
  getCommandStatsByName(command: string): CommandStats | null {
    return this.commandStats.get(command.toLowerCase()) || null;
  }

  // ==================== Message Tracking ====================

  /**
   * Track a chat message
   */
  trackMessage(username: string, channel: string): void {
    if (!this.config.trackMessages) return;

    const hourly = this.getHourlyStatsBucket();
    hourly.messages++;

    if (this.currentSession) {
      this.currentSession.chatMessages++;
    }

    this.dirty = true;
  }

  // ==================== Event Tracking ====================

  /**
   * Track a follow event
   */
  trackFollow(): void {
    const hourly = this.getHourlyStatsBucket();
    hourly.follows = (hourly.follows || 0) + 1;

    if (this.currentSession) {
      this.currentSession.newFollowers++;
    }

    this.dirty = true;
  }

  /**
   * Track a subscription event
   */
  trackSubscription(): void {
    const hourly = this.getHourlyStatsBucket();
    hourly.subscriptions = (hourly.subscriptions || 0) + 1;

    if (this.currentSession) {
      this.currentSession.subscriptions++;
    }

    this.dirty = true;
  }

  /**
   * Track bits received
   */
  trackBits(amount: number): void {
    const hourly = this.getHourlyStatsBucket();
    hourly.bits = (hourly.bits || 0) + amount;

    if (this.currentSession) {
      this.currentSession.bitsReceived += amount;
    }

    this.dirty = true;
  }

  // ==================== Stream Session Tracking ====================

  /**
   * Start tracking a new stream session
   */
  startStreamSession(): void {
    this.currentSession = {
      startedAt: new Date().toISOString(),
      durationMinutes: 0,
      peakViewers: 0,
      averageViewers: 0,
      newFollowers: 0,
      subscriptions: 0,
      bitsReceived: 0,
      chatMessages: 0,
      uniqueChatters: 0,
      commandsExecuted: 0,
    };

    logger.info('Started tracking stream session');
    this.dirty = true;
  }

  /**
   * End the current stream session
   */
  endStreamSession(): StreamSessionStats | null {
    if (!this.currentSession) return null;

    this.currentSession.endedAt = new Date().toISOString();
    this.currentSession.durationMinutes = Math.round(
      (new Date(this.currentSession.endedAt).getTime() -
        new Date(this.currentSession.startedAt).getTime()) /
        60000
    );

    this.streamSessions.push(this.currentSession);
    const session = this.currentSession;
    this.currentSession = null;

    logger.info('Ended stream session', {
      duration: session.durationMinutes,
      peakViewers: session.peakViewers,
    });

    this.dirty = true;
    return session;
  }

  /**
   * Update viewer count for current session
   */
  updateViewerCount(count: number): void {
    if (!this.currentSession) return;

    if (count > this.currentSession.peakViewers) {
      this.currentSession.peakViewers = count;
    }

    // Running average
    const sampleWeight = 0.1;
    this.currentSession.averageViewers = Math.round(
      this.currentSession.averageViewers * (1 - sampleWeight) +
        count * sampleWeight
    );

    this.dirty = true;
  }

  /**
   * Get recent stream sessions
   */
  getStreamSessions(limit: number = 10): StreamSessionStats[] {
    return this.streamSessions.slice(-limit).reverse();
  }

  // ==================== Reporting ====================

  /**
   * Get hourly statistics for a time range
   */
  getHourlyStats(
    startDate: Date,
    endDate: Date = new Date()
  ): HourlyStats[] {
    const stats: HourlyStats[] = [];
    const start = startDate.toISOString();
    const end = endDate.toISOString();

    for (const [key, value] of this.hourlyStats) {
      if (value.hour >= start && value.hour <= end) {
        stats.push(value);
      }
    }

    return stats.sort((a, b) => a.hour.localeCompare(b.hour));
  }

  /**
   * Get daily aggregated statistics
   */
  getDailyStats(days: number = 7): Array<{
    date: string;
    commands: number;
    messages: number;
    follows: number;
    subscriptions: number;
    bits: number;
  }> {
    const result: Map<string, {
      date: string;
      commands: number;
      messages: number;
      follows: number;
      subscriptions: number;
      bits: number;
    }> = new Map();

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    for (const [, stats] of this.hourlyStats) {
      if (stats.hour < startDate.toISOString()) continue;

      const dateKey = stats.hour.substring(0, 10);
      let day = result.get(dateKey);

      if (!day) {
        day = {
          date: dateKey,
          commands: 0,
          messages: 0,
          follows: 0,
          subscriptions: 0,
          bits: 0,
        };
        result.set(dateKey, day);
      }

      day.commands += stats.commands;
      day.messages += stats.messages;
      day.follows += stats.follows || 0;
      day.subscriptions += stats.subscriptions || 0;
      day.bits += stats.bits || 0;
    }

    return Array.from(result.values()).sort((a, b) =>
      a.date.localeCompare(b.date)
    );
  }

  /**
   * Get summary statistics
   */
  getSummary(): {
    totalCommands: number;
    totalMessages: number;
    totalFollows: number;
    totalSubscriptions: number;
    totalBits: number;
    totalStreamSessions: number;
    totalStreamMinutes: number;
    averageSessionDuration: number;
    topCommands: Array<{ name: string; count: number }>;
  } {
    let totalCommands = 0;
    let totalMessages = 0;
    let totalFollows = 0;
    let totalSubscriptions = 0;
    let totalBits = 0;

    for (const stats of this.hourlyStats.values()) {
      totalCommands += stats.commands;
      totalMessages += stats.messages;
      totalFollows += stats.follows || 0;
      totalSubscriptions += stats.subscriptions || 0;
      totalBits += stats.bits || 0;
    }

    const totalStreamMinutes = this.streamSessions.reduce(
      (sum, s) => sum + s.durationMinutes,
      0
    );

    const topCommands = Array.from(this.commandStats.values())
      .sort((a, b) => b.totalExecutions - a.totalExecutions)
      .slice(0, 5)
      .map((c) => ({ name: c.name, count: c.totalExecutions }));

    return {
      totalCommands,
      totalMessages,
      totalFollows,
      totalSubscriptions,
      totalBits,
      totalStreamSessions: this.streamSessions.length,
      totalStreamMinutes,
      averageSessionDuration:
        this.streamSessions.length > 0
          ? Math.round(totalStreamMinutes / this.streamSessions.length)
          : 0,
      topCommands,
    };
  }

  /**
   * Get configuration
   */
  getConfig(): AnalyticsConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<AnalyticsConfig>): void {
    this.config = { ...this.config, ...updates };
    this.dirty = true;
    logger.info('Analytics config updated');
  }

  /**
   * Clean up
   */
  destroy(): void {
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
      this.saveInterval = null;
    }
    this.saveIfDirty();
  }
}

// Singleton
let defaultManager: AnalyticsManager | null = null;

export function getAnalyticsManager(): AnalyticsManager {
  if (!defaultManager) {
    defaultManager = new AnalyticsManager();
  }
  return defaultManager;
}

export function resetAnalyticsManager(): void {
  if (defaultManager) {
    defaultManager.destroy();
    defaultManager = null;
  }
}
