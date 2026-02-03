/**
 * Rate Limiter Module
 * Advanced rate limiting for commands, API calls, and spam protection
 */

import { createLogger } from './logger';

const logger = createLogger('RateLimiter');

/**
 * Rate limit bucket type
 */
export type BucketType = 'user' | 'channel' | 'global' | 'command';

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
  /** Maximum number of requests/actions allowed */
  maxRequests: number;
  /** Time window in milliseconds */
  windowMs: number;
  /** Penalty duration when limit exceeded (ms) */
  penaltyMs?: number;
  /** Whether to slide the window or use fixed windows */
  sliding?: boolean;
}

/**
 * Rate limit result
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
  retryAfterMs?: number;
  penalized?: boolean;
}

/**
 * Bucket entry
 */
interface BucketEntry {
  timestamps: number[];
  penaltyUntil?: number;
}

/**
 * Rate limiter class with sliding window and token bucket support
 */
export class RateLimiter {
  private buckets: Map<string, BucketEntry> = new Map();
  private config: RateLimitConfig;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(config: RateLimitConfig) {
    this.config = {
      ...config,
      sliding: config.sliding !== false,
    };

    // Cleanup old entries periodically
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, this.config.windowMs * 2);
  }

  /**
   * Check if an action is allowed
   */
  check(key: string): RateLimitResult {
    const now = Date.now();
    let entry = this.buckets.get(key);

    // Check penalty
    if (entry?.penaltyUntil && entry.penaltyUntil > now) {
      return {
        allowed: false,
        remaining: 0,
        resetMs: entry.penaltyUntil - now,
        retryAfterMs: entry.penaltyUntil - now,
        penalized: true,
      };
    }

    if (!entry) {
      entry = { timestamps: [] };
      this.buckets.set(key, entry);
    }

    // Filter timestamps within window
    const windowStart = now - this.config.windowMs;
    entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

    const remaining = this.config.maxRequests - entry.timestamps.length;

    if (remaining <= 0) {
      // Apply penalty if configured
      if (this.config.penaltyMs) {
        entry.penaltyUntil = now + this.config.penaltyMs;
      }

      // Calculate when the oldest request expires
      const oldestTimestamp = entry.timestamps[0] || now;
      const resetMs = oldestTimestamp + this.config.windowMs - now;

      return {
        allowed: false,
        remaining: 0,
        resetMs,
        retryAfterMs: resetMs,
      };
    }

    return {
      allowed: true,
      remaining: remaining - 1,
      resetMs: this.config.windowMs,
    };
  }

  /**
   * Consume a rate limit token
   */
  consume(key: string): RateLimitResult {
    const result = this.check(key);

    if (result.allowed) {
      const entry = this.buckets.get(key)!;
      entry.timestamps.push(Date.now());
    }

    return result;
  }

  /**
   * Reset rate limit for a key
   */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  /**
   * Clear penalty for a key
   */
  clearPenalty(key: string): void {
    const entry = this.buckets.get(key);
    if (entry) {
      entry.penaltyUntil = undefined;
    }
  }

  /**
   * Get remaining capacity
   */
  getRemaining(key: string): number {
    const entry = this.buckets.get(key);
    if (!entry) return this.config.maxRequests;

    const now = Date.now();
    const windowStart = now - this.config.windowMs;
    const validTimestamps = entry.timestamps.filter((t) => t > windowStart);

    return Math.max(0, this.config.maxRequests - validTimestamps.length);
  }

  /**
   * Clean up old entries
   */
  private cleanup(): void {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    for (const [key, entry] of this.buckets.entries()) {
      // Remove expired timestamps
      entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

      // Remove empty entries without active penalties
      if (entry.timestamps.length === 0 && (!entry.penaltyUntil || entry.penaltyUntil <= now)) {
        this.buckets.delete(key);
      }
    }
  }

  /**
   * Destroy the rate limiter
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.buckets.clear();
  }
}

/**
 * Multi-tier rate limiter for complex rate limiting scenarios
 */
export class MultiTierRateLimiter {
  private limiters: Map<string, RateLimiter> = new Map();

  constructor(
    private tiers: Record<string, RateLimitConfig>
  ) {
    for (const [name, config] of Object.entries(tiers)) {
      this.limiters.set(name, new RateLimiter(config));
    }
  }

  /**
   * Check all tiers
   */
  check(keys: Record<string, string>): RateLimitResult {
    let mostRestrictive: RateLimitResult | null = null;

    for (const [tier, key] of Object.entries(keys)) {
      const limiter = this.limiters.get(tier);
      if (!limiter) continue;

      const result = limiter.check(key);

      if (!result.allowed) {
        return result;
      }

      if (!mostRestrictive || result.remaining < mostRestrictive.remaining) {
        mostRestrictive = result;
      }
    }

    return mostRestrictive || { allowed: true, remaining: Infinity, resetMs: 0 };
  }

  /**
   * Consume from all tiers
   */
  consume(keys: Record<string, string>): RateLimitResult {
    // First check if all tiers allow
    const checkResult = this.check(keys);
    if (!checkResult.allowed) {
      return checkResult;
    }

    // Consume from all tiers
    for (const [tier, key] of Object.entries(keys)) {
      const limiter = this.limiters.get(tier);
      if (limiter) {
        limiter.consume(key);
      }
    }

    return checkResult;
  }

  /**
   * Reset specific tier for a key
   */
  reset(tier: string, key: string): void {
    const limiter = this.limiters.get(tier);
    if (limiter) {
      limiter.reset(key);
    }
  }

  /**
   * Clear penalty for specific tier and key
   */
  clearPenalty(tier: string, key: string): void {
    const limiter = this.limiters.get(tier);
    if (limiter) {
      limiter.clearPenalty(key);
    }
  }

  /**
   * Destroy all limiters
   */
  destroy(): void {
    for (const limiter of this.limiters.values()) {
      limiter.destroy();
    }
    this.limiters.clear();
  }
}

/**
 * Command rate limiter with user and channel tiers
 */
export class CommandRateLimiter {
  private limiter: MultiTierRateLimiter;
  private exemptUsers: Set<string> = new Set();
  private customCooldowns: Map<string, number> = new Map();

  constructor(options?: {
    userLimitPerMinute?: number;
    channelLimitPerMinute?: number;
    globalLimitPerSecond?: number;
    defaultCooldownMs?: number;
    penaltyMs?: number;
  }) {
    const opts = {
      userLimitPerMinute: 20,
      channelLimitPerMinute: 60,
      globalLimitPerSecond: 100,
      defaultCooldownMs: 3000,
      penaltyMs: 60000,
      ...options,
    };

    this.limiter = new MultiTierRateLimiter({
      user: {
        maxRequests: opts.userLimitPerMinute,
        windowMs: 60000,
        penaltyMs: opts.penaltyMs,
      },
      channel: {
        maxRequests: opts.channelLimitPerMinute,
        windowMs: 60000,
      },
      global: {
        maxRequests: opts.globalLimitPerSecond,
        windowMs: 1000,
      },
    });
  }

  /**
   * Check if command is allowed for user/channel
   */
  checkCommand(
    command: string,
    username: string,
    channel: string
  ): RateLimitResult {
    // Exempt users bypass rate limits
    if (this.exemptUsers.has(username.toLowerCase())) {
      return { allowed: true, remaining: Infinity, resetMs: 0 };
    }

    return this.limiter.check({
      user: `${username.toLowerCase()}:${command}`,
      channel: `${channel}:${command}`,
      global: command,
    });
  }

  /**
   * Consume rate limit for command
   */
  consumeCommand(
    command: string,
    username: string,
    channel: string
  ): RateLimitResult {
    if (this.exemptUsers.has(username.toLowerCase())) {
      return { allowed: true, remaining: Infinity, resetMs: 0 };
    }

    return this.limiter.consume({
      user: `${username.toLowerCase()}:${command}`,
      channel: `${channel}:${command}`,
      global: command,
    });
  }

  /**
   * Add exempt user (e.g., moderators, broadcaster)
   */
  addExemptUser(username: string): void {
    this.exemptUsers.add(username.toLowerCase());
  }

  /**
   * Remove exempt user
   */
  removeExemptUser(username: string): void {
    this.exemptUsers.delete(username.toLowerCase());
  }

  /**
   * Set custom cooldown for a command
   */
  setCommandCooldown(command: string, cooldownMs: number): void {
    this.customCooldowns.set(command.toLowerCase(), cooldownMs);
  }

  /**
   * Get cooldown for a command
   */
  getCommandCooldown(command: string): number {
    return this.customCooldowns.get(command.toLowerCase()) || 3000;
  }

  /**
   * Destroy the rate limiter
   */
  destroy(): void {
    this.limiter.destroy();
    this.exemptUsers.clear();
    this.customCooldowns.clear();
  }
}

/**
 * Spam detection with pattern analysis
 */
export class SpamDetector {
  private messageHistory: Map<string, Array<{ text: string; timestamp: number }>> = new Map();
  private config: {
    maxDuplicates: number;
    duplicateWindowMs: number;
    maxMessagesPerWindow: number;
    messageWindowMs: number;
    maxCapsPercentage: number;
    minCapsLength: number;
    maxRepeatedChars: number;
  };

  constructor(options?: Partial<SpamDetector['config']>) {
    this.config = {
      maxDuplicates: 3,
      duplicateWindowMs: 30000,
      maxMessagesPerWindow: 10,
      messageWindowMs: 10000,
      maxCapsPercentage: 70,
      minCapsLength: 10,
      maxRepeatedChars: 5,
      ...options,
    };
  }

  /**
   * Check message for spam patterns
   */
  checkMessage(username: string, message: string): {
    isSpam: boolean;
    reasons: string[];
  } {
    const reasons: string[] = [];
    const now = Date.now();
    const userKey = username.toLowerCase();

    // Get or create history
    let history = this.messageHistory.get(userKey);
    if (!history) {
      history = [];
      this.messageHistory.set(userKey, history);
    }

    // Clean old entries
    const cutoff = now - Math.max(this.config.duplicateWindowMs, this.config.messageWindowMs);
    history = history.filter((m) => m.timestamp > cutoff);
    this.messageHistory.set(userKey, history);

    // Check duplicate messages
    const recentDuplicates = history.filter(
      (m) =>
        m.timestamp > now - this.config.duplicateWindowMs &&
        m.text.toLowerCase() === message.toLowerCase()
    ).length;

    if (recentDuplicates >= this.config.maxDuplicates) {
      reasons.push('duplicate_message');
    }

    // Check message rate
    const recentMessages = history.filter(
      (m) => m.timestamp > now - this.config.messageWindowMs
    ).length;

    if (recentMessages >= this.config.maxMessagesPerWindow) {
      reasons.push('message_rate');
    }

    // Check caps percentage
    if (message.length >= this.config.minCapsLength) {
      const letters = message.replace(/[^a-zA-Z]/g, '');
      const upperCase = letters.replace(/[^A-Z]/g, '');
      const capsPercentage = (upperCase.length / letters.length) * 100;

      if (capsPercentage > this.config.maxCapsPercentage) {
        reasons.push('excessive_caps');
      }
    }

    // Check repeated characters
    const repeatedPattern = new RegExp(`(.)\\1{${this.config.maxRepeatedChars},}`, 'i');
    if (repeatedPattern.test(message)) {
      reasons.push('repeated_characters');
    }

    // Add to history
    history.push({ text: message, timestamp: now });

    return {
      isSpam: reasons.length > 0,
      reasons,
    };
  }

  /**
   * Clear history for a user
   */
  clearHistory(username: string): void {
    this.messageHistory.delete(username.toLowerCase());
  }

  /**
   * Clear all history
   */
  clearAllHistory(): void {
    this.messageHistory.clear();
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<SpamDetector['config']>): void {
    this.config = { ...this.config, ...updates };
  }
}

// Singleton instances
let defaultCommandLimiter: CommandRateLimiter | null = null;
let defaultSpamDetector: SpamDetector | null = null;

export function getCommandRateLimiter(): CommandRateLimiter {
  if (!defaultCommandLimiter) {
    defaultCommandLimiter = new CommandRateLimiter();
  }
  return defaultCommandLimiter;
}

export function getSpamDetector(): SpamDetector {
  if (!defaultSpamDetector) {
    defaultSpamDetector = new SpamDetector();
  }
  return defaultSpamDetector;
}

export function resetRateLimiters(): void {
  if (defaultCommandLimiter) {
    defaultCommandLimiter.destroy();
    defaultCommandLimiter = null;
  }
  if (defaultSpamDetector) {
    defaultSpamDetector.clearAllHistory();
    defaultSpamDetector = null;
  }
}
