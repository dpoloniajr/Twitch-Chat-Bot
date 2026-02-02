/**
 * Loyalty Points System
 * Tracks viewer points earned by watching and chatting
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/logger';

const logger = createLogger('Loyalty');

/**
 * User loyalty data
 */
export interface UserLoyaltyData {
  points: number;
  totalEarned: number;
  totalSpent: number;
  watchTimeMinutes: number;
  messageCount: number;
  lastSeen: string;
  firstSeen: string;
  level: number;
}

/**
 * Loyalty system configuration
 */
export interface LoyaltyConfig {
  /** Points earned per minute of watch time */
  pointsPerMinute: number;
  /** Points earned per chat message */
  pointsPerMessage: number;
  /** Bonus points for subscribers (multiplier) */
  subscriberMultiplier: number;
  /** Bonus points for VIPs (multiplier) */
  vipMultiplier: number;
  /** Maximum points per message (prevents spam farming) */
  maxPointsPerMessage: number;
  /** Cooldown between earning message points (seconds) */
  messageCooldownSeconds: number;
  /** Currency name (singular) */
  currencyName: string;
  /** Currency name (plural) */
  currencyNamePlural: string;
  /** Points required per level */
  pointsPerLevel: number;
  /** Enable/disable the system */
  enabled: boolean;
}

/**
 * Loyalty leaderboard entry
 */
export interface LeaderboardEntry {
  username: string;
  points: number;
  level: number;
  rank: number;
}

/**
 * Loyalty transaction
 */
export interface LoyaltyTransaction {
  username: string;
  amount: number;
  type: 'earn' | 'spend' | 'bonus' | 'admin';
  reason: string;
  timestamp: string;
  balance: number;
}

const DEFAULT_CONFIG: LoyaltyConfig = {
  pointsPerMinute: 10,
  pointsPerMessage: 5,
  subscriberMultiplier: 2,
  vipMultiplier: 1.5,
  maxPointsPerMessage: 50,
  messageCooldownSeconds: 30,
  currencyName: 'point',
  currencyNamePlural: 'points',
  pointsPerLevel: 1000,
  enabled: true,
};

/**
 * Loyalty points manager
 */
export class LoyaltyManager {
  private data: Map<string, UserLoyaltyData>;
  private config: LoyaltyConfig;
  private dataPath: string;
  private lastMessagePoints: Map<string, number>; // username -> timestamp
  private transactions: LoyaltyTransaction[];
  private maxTransactionHistory: number = 1000;
  private dirty: boolean = false;
  private saveInterval: NodeJS.Timeout | null = null;

  constructor(options?: {
    dataPath?: string;
    config?: Partial<LoyaltyConfig>;
    autoSaveIntervalMs?: number;
  }) {
    this.data = new Map();
    this.config = { ...DEFAULT_CONFIG, ...options?.config };
    this.dataPath = options?.dataPath || path.join(process.cwd(), 'dashboard', 'logs', 'loyalty.json');
    this.lastMessagePoints = new Map();
    this.transactions = [];

    this.loadData();

    // Auto-save periodically
    const autoSaveInterval = options?.autoSaveIntervalMs || 60000;
    if (autoSaveInterval > 0) {
      this.saveInterval = setInterval(() => this.saveIfDirty(), autoSaveInterval);
    }
  }

  /**
   * Load loyalty data from file
   */
  private loadData(): void {
    try {
      if (fs.existsSync(this.dataPath)) {
        const content = fs.readFileSync(this.dataPath, 'utf-8');
        const parsed = JSON.parse(content);

        if (parsed.users) {
          this.data = new Map(Object.entries(parsed.users));
        }
        if (parsed.config) {
          this.config = { ...this.config, ...parsed.config };
        }
        if (parsed.transactions) {
          this.transactions = parsed.transactions;
        }

        logger.info('Loaded loyalty data', { userCount: this.data.size });
      }
    } catch (error) {
      logger.error('Failed to load loyalty data', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Save loyalty data to file
   */
  saveData(): void {
    try {
      const dir = path.dirname(this.dataPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const saveData = {
        users: Object.fromEntries(this.data),
        config: this.config,
        transactions: this.transactions.slice(-this.maxTransactionHistory),
        savedAt: new Date().toISOString(),
      };

      fs.writeFileSync(this.dataPath, JSON.stringify(saveData, null, 2));
      this.dirty = false;
      logger.debug('Saved loyalty data', { userCount: this.data.size });
    } catch (error) {
      logger.error('Failed to save loyalty data', {
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

  /**
   * Get or create user data
   */
  private getOrCreateUser(username: string): UserLoyaltyData {
    const normalized = username.toLowerCase();
    let user = this.data.get(normalized);

    if (!user) {
      user = {
        points: 0,
        totalEarned: 0,
        totalSpent: 0,
        watchTimeMinutes: 0,
        messageCount: 0,
        lastSeen: new Date().toISOString(),
        firstSeen: new Date().toISOString(),
        level: 1,
      };
      this.data.set(normalized, user);
      this.dirty = true;
    }

    return user;
  }

  /**
   * Calculate user level based on total earned points
   */
  private calculateLevel(totalEarned: number): number {
    return Math.floor(totalEarned / this.config.pointsPerLevel) + 1;
  }

  /**
   * Award points to a user
   */
  awardPoints(
    username: string,
    amount: number,
    reason: string,
    type: 'earn' | 'bonus' | 'admin' = 'earn'
  ): { newBalance: number; levelUp: boolean; newLevel?: number } {
    if (!this.config.enabled || amount <= 0) {
      const user = this.getOrCreateUser(username);
      return { newBalance: user.points, levelUp: false };
    }

    const user = this.getOrCreateUser(username);
    const oldLevel = user.level;

    user.points += amount;
    user.totalEarned += amount;
    user.lastSeen = new Date().toISOString();
    user.level = this.calculateLevel(user.totalEarned);

    this.dirty = true;

    // Record transaction
    this.recordTransaction(username, amount, type, reason, user.points);

    const levelUp = user.level > oldLevel;
    if (levelUp) {
      logger.info('User leveled up', { username, newLevel: user.level });
    }

    return {
      newBalance: user.points,
      levelUp,
      newLevel: levelUp ? user.level : undefined,
    };
  }

  /**
   * Deduct points from a user
   */
  deductPoints(
    username: string,
    amount: number,
    reason: string
  ): { success: boolean; newBalance: number; error?: string } {
    if (!this.config.enabled) {
      return { success: false, newBalance: 0, error: 'Loyalty system is disabled' };
    }

    const user = this.getOrCreateUser(username);

    if (user.points < amount) {
      return {
        success: false,
        newBalance: user.points,
        error: `Insufficient ${this.config.currencyNamePlural}. You have ${user.points}, but need ${amount}.`,
      };
    }

    user.points -= amount;
    user.totalSpent += amount;
    user.lastSeen = new Date().toISOString();
    this.dirty = true;

    // Record transaction
    this.recordTransaction(username, -amount, 'spend', reason, user.points);

    return { success: true, newBalance: user.points };
  }

  /**
   * Award points for watching (called periodically)
   */
  awardWatchTimePoints(
    username: string,
    minutesWatched: number,
    isSubscriber: boolean = false,
    isVip: boolean = false
  ): { pointsEarned: number; newBalance: number } {
    if (!this.config.enabled) {
      return { pointsEarned: 0, newBalance: 0 };
    }

    let points = minutesWatched * this.config.pointsPerMinute;

    // Apply multipliers
    if (isSubscriber) {
      points *= this.config.subscriberMultiplier;
    } else if (isVip) {
      points *= this.config.vipMultiplier;
    }

    points = Math.floor(points);

    const user = this.getOrCreateUser(username);
    user.watchTimeMinutes += minutesWatched;

    const result = this.awardPoints(username, points, 'Watch time bonus');

    return { pointsEarned: points, newBalance: result.newBalance };
  }

  /**
   * Award points for chatting
   */
  awardMessagePoints(
    username: string,
    isSubscriber: boolean = false,
    isVip: boolean = false
  ): { pointsEarned: number; newBalance: number; onCooldown: boolean } {
    if (!this.config.enabled) {
      return { pointsEarned: 0, newBalance: 0, onCooldown: false };
    }

    // Check cooldown
    const now = Date.now();
    const lastPoints = this.lastMessagePoints.get(username.toLowerCase());
    const cooldownMs = this.config.messageCooldownSeconds * 1000;

    if (lastPoints && now - lastPoints < cooldownMs) {
      const user = this.getOrCreateUser(username);
      user.messageCount++;
      this.dirty = true;
      return { pointsEarned: 0, newBalance: user.points, onCooldown: true };
    }

    this.lastMessagePoints.set(username.toLowerCase(), now);

    let points = this.config.pointsPerMessage;

    // Apply multipliers
    if (isSubscriber) {
      points *= this.config.subscriberMultiplier;
    } else if (isVip) {
      points *= this.config.vipMultiplier;
    }

    points = Math.min(Math.floor(points), this.config.maxPointsPerMessage);

    const user = this.getOrCreateUser(username);
    user.messageCount++;

    const result = this.awardPoints(username, points, 'Chat message');

    return { pointsEarned: points, newBalance: result.newBalance, onCooldown: false };
  }

  /**
   * Get user points
   */
  getPoints(username: string): number {
    const user = this.data.get(username.toLowerCase());
    return user?.points || 0;
  }

  /**
   * Get user data
   */
  getUserData(username: string): UserLoyaltyData | null {
    return this.data.get(username.toLowerCase()) || null;
  }

  /**
   * Get leaderboard
   */
  getLeaderboard(limit: number = 10): LeaderboardEntry[] {
    const entries = Array.from(this.data.entries())
      .map(([username, data]) => ({
        username,
        points: data.points,
        level: data.level,
        rank: 0,
      }))
      .sort((a, b) => b.points - a.points)
      .slice(0, limit);

    // Assign ranks
    entries.forEach((entry, index) => {
      entry.rank = index + 1;
    });

    return entries;
  }

  /**
   * Get user rank
   */
  getUserRank(username: string): number | null {
    const normalized = username.toLowerCase();
    const sorted = Array.from(this.data.entries())
      .sort((a, b) => b[1].points - a[1].points);

    const index = sorted.findIndex(([name]) => name === normalized);
    return index >= 0 ? index + 1 : null;
  }

  /**
   * Set user points (admin)
   */
  setPoints(username: string, amount: number, reason: string = 'Admin adjustment'): number {
    const user = this.getOrCreateUser(username);
    const diff = amount - user.points;

    user.points = Math.max(0, amount);
    this.dirty = true;

    this.recordTransaction(username, diff, 'admin', reason, user.points);

    logger.info('Points set by admin', { username, amount, reason });

    return user.points;
  }

  /**
   * Record a transaction
   */
  private recordTransaction(
    username: string,
    amount: number,
    type: LoyaltyTransaction['type'],
    reason: string,
    balance: number
  ): void {
    this.transactions.push({
      username: username.toLowerCase(),
      amount,
      type,
      reason,
      timestamp: new Date().toISOString(),
      balance,
    });

    // Trim old transactions
    if (this.transactions.length > this.maxTransactionHistory * 2) {
      this.transactions = this.transactions.slice(-this.maxTransactionHistory);
    }
  }

  /**
   * Get user transactions
   */
  getUserTransactions(username: string, limit: number = 10): LoyaltyTransaction[] {
    const normalized = username.toLowerCase();
    return this.transactions
      .filter((t) => t.username === normalized)
      .slice(-limit)
      .reverse();
  }

  /**
   * Transfer points between users
   */
  transferPoints(
    fromUsername: string,
    toUsername: string,
    amount: number
  ): { success: boolean; error?: string } {
    if (!this.config.enabled) {
      return { success: false, error: 'Loyalty system is disabled' };
    }

    if (amount <= 0) {
      return { success: false, error: 'Amount must be positive' };
    }

    const fromUser = this.getOrCreateUser(fromUsername);
    if (fromUser.points < amount) {
      return {
        success: false,
        error: `Insufficient ${this.config.currencyNamePlural}. You have ${fromUser.points}.`,
      };
    }

    // Deduct from sender
    fromUser.points -= amount;
    fromUser.totalSpent += amount;
    this.recordTransaction(fromUsername, -amount, 'spend', `Transfer to ${toUsername}`, fromUser.points);

    // Add to receiver
    this.awardPoints(toUsername, amount, `Transfer from ${fromUsername}`, 'bonus');

    this.dirty = true;

    logger.info('Points transferred', { from: fromUsername, to: toUsername, amount });

    return { success: true };
  }

  /**
   * Get configuration
   */
  getConfig(): LoyaltyConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<LoyaltyConfig>): void {
    this.config = { ...this.config, ...updates };
    this.dirty = true;
    logger.info('Loyalty config updated', { updates: Object.keys(updates) });
  }

  /**
   * Get currency name
   */
  getCurrencyName(amount: number = 2): string {
    return amount === 1 ? this.config.currencyName : this.config.currencyNamePlural;
  }

  /**
   * Get total user count
   */
  getUserCount(): number {
    return this.data.size;
  }

  /**
   * Get total points in circulation
   */
  getTotalPoints(): number {
    let total = 0;
    for (const user of this.data.values()) {
      total += user.points;
    }
    return total;
  }

  /**
   * Clean up and stop auto-save
   */
  destroy(): void {
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
      this.saveInterval = null;
    }
    this.saveIfDirty();
  }
}

// Singleton instance
let defaultManager: LoyaltyManager | null = null;

export function getLoyaltyManager(): LoyaltyManager {
  if (!defaultManager) {
    defaultManager = new LoyaltyManager();
  }
  return defaultManager;
}

export function resetLoyaltyManager(): void {
  if (defaultManager) {
    defaultManager.destroy();
    defaultManager = null;
  }
}
