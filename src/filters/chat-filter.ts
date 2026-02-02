/**
 * Chat Filter Module
 * Handles message filtering for blacklist words, URLs, caps, spam, etc.
 */

import {
  ChatFilterConfig,
  FilterStatus,
  FilterViolation,
  FilterAction,
  MessageHistoryEntry,
} from '../types';
import { CACHE, FILTERS } from '../config/constants';
import { createLogger } from '../utils/logger';

const logger = createLogger('ChatFilter');

/**
 * Chat filter manager class
 */
export class ChatFilterManager {
  private config: ChatFilterConfig;
  private messageHistory: Map<string, MessageHistoryEntry>;
  private lastCleanup: number;
  private statusCache: FilterStatus | null = null;
  private statusCacheTimestamp: number = 0;

  constructor(config?: Partial<ChatFilterConfig>) {
    this.config = {
      blacklistWords: config?.blacklistWords || new Set<string>(),
      filterUrls: config?.filterUrls ?? false,
      filterAllCaps: config?.filterAllCaps ?? false,
      filterRepeatChars: config?.filterRepeatChars ?? false,
      filterSpam: config?.filterSpam ?? false,
      timeoutDurationSeconds: config?.timeoutDurationSeconds ?? FILTERS.DEFAULT_TIMEOUT_SECONDS,
      filterAction: config?.filterAction ?? 'warn',
    };
    this.messageHistory = new Map();
    this.lastCleanup = Date.now();
  }

  /**
   * Initialize filter from environment variables
   */
  static fromEnv(): ChatFilterManager {
    const blacklistWords = new Set(
      (process.env.CHAT_FILTER_WORDS || '')
        .split('|')
        .map((w) => w.trim().toLowerCase())
        .filter(Boolean)
    );

    return new ChatFilterManager({
      blacklistWords,
      filterUrls:
        process.env.CHAT_FILTER_URLS === 'true' ||
        process.env.CHAT_FILTER_URLS === '1',
      filterAllCaps:
        process.env.CHAT_FILTER_ALLCAPS === 'true' ||
        process.env.CHAT_FILTER_ALLCAPS === '1',
      filterRepeatChars:
        process.env.CHAT_FILTER_REPEAT === 'true' ||
        process.env.CHAT_FILTER_REPEAT === '1',
      filterSpam:
        process.env.CHAT_FILTER_SPAM === 'true' ||
        process.env.CHAT_FILTER_SPAM === '1',
      timeoutDurationSeconds: Number(
        process.env.CHAT_FILTER_TIMEOUT_SEC || FILTERS.DEFAULT_TIMEOUT_SECONDS
      ),
      filterAction: (process.env.CHAT_FILTER_ACTION as FilterAction) || 'warn',
    });
  }

  /**
   * Check a message for filter violations
   */
  checkMessage(message: string, username: string): FilterViolation[] {
    const text = message.toLowerCase().trim();
    const violations: FilterViolation[] = [];

    // Check blacklist words
    if (this.config.blacklistWords.size > 0) {
      const words = text.split(/\s+/);
      for (const word of words) {
        const cleaned = word.replace(/[^\w]/g, '');
        if (this.config.blacklistWords.has(cleaned)) {
          violations.push('blacklist_word');
          break;
        }
      }
    }

    // Check for URLs
    if (this.config.filterUrls && FILTERS.URL_PATTERN.test(message)) {
      violations.push('url');
    }

    // Check all caps (if more than threshold and at least min length)
    if (
      this.config.filterAllCaps &&
      message.length >= FILTERS.ALL_CAPS_MIN_LENGTH
    ) {
      const capsCount = (message.match(/[A-Z]/g) || []).length;
      if (capsCount / message.length >= FILTERS.ALL_CAPS_THRESHOLD) {
        violations.push('all_caps');
      }
    }

    // Check repeated characters
    if (
      this.config.filterRepeatChars &&
      FILTERS.REPEAT_CHARS_PATTERN.test(message)
    ) {
      violations.push('repeat_chars');
    }

    // Check spam (same message within window from same user)
    if (this.config.filterSpam) {
      const now = Date.now();
      const lastMsg = this.messageHistory.get(username);

      if (
        lastMsg &&
        lastMsg.text === text &&
        now - lastMsg.time < CACHE.SPAM_DETECTION_WINDOW_MS
      ) {
        violations.push('spam');
      }

      // Update message history
      this.messageHistory.set(username, { text, time: now });

      // Periodic cleanup
      this.cleanupMessageHistory(now);
    }

    if (violations.length > 0) {
      logger.debug('Filter violations detected', {
        username,
        violations,
        messageLength: message.length,
      });
    }

    return violations;
  }

  /**
   * Clean up old message history entries
   */
  private cleanupMessageHistory(now: number): void {
    if (now - this.lastCleanup < CACHE.MESSAGE_HISTORY_CLEANUP_INTERVAL_MS) {
      return;
    }

    const expiry = now - CACHE.MESSAGE_HISTORY_EXPIRY_MS;
    for (const [user, msg] of this.messageHistory.entries()) {
      if (msg.time < expiry) {
        this.messageHistory.delete(user);
      }
    }
    this.lastCleanup = now;
  }

  /**
   * Add a word to the blacklist
   */
  addWord(word: string): boolean {
    if (!word || word.trim().length === 0) return false;

    const normalized = word.trim().toLowerCase();
    this.config.blacklistWords.add(normalized);
    this.invalidateCache();
    logger.info('Added word to blacklist', { word: normalized });
    return true;
  }

  /**
   * Remove a word from the blacklist
   */
  removeWord(word: string): boolean {
    if (!word || word.trim().length === 0) return false;

    const normalized = word.trim().toLowerCase();
    const removed = this.config.blacklistWords.delete(normalized);
    if (removed) {
      this.invalidateCache();
      logger.info('Removed word from blacklist', { word: normalized });
    }
    return removed;
  }

  /**
   * Get the current filter status (cached)
   */
  getStatus(): FilterStatus {
    const now = Date.now();

    if (
      this.statusCache &&
      now - this.statusCacheTimestamp < CACHE.FILTER_STATUS_TTL_MS
    ) {
      return this.statusCache;
    }

    this.statusCache = {
      blacklistWords: Array.from(this.config.blacklistWords),
      filterUrls: this.config.filterUrls,
      filterAllCaps: this.config.filterAllCaps,
      filterRepeatChars: this.config.filterRepeatChars,
      filterSpam: this.config.filterSpam,
      timeoutDurationSeconds: this.config.timeoutDurationSeconds,
      filterAction: this.config.filterAction,
    };
    this.statusCacheTimestamp = now;

    return this.statusCache;
  }

  /**
   * Invalidate the status cache
   */
  invalidateCache(): void {
    this.statusCache = null;
    this.statusCacheTimestamp = 0;
  }

  /**
   * Get the configured filter action
   */
  getAction(): FilterAction {
    return this.config.filterAction;
  }

  /**
   * Get the timeout duration in seconds
   */
  getTimeoutDuration(): number {
    return this.config.timeoutDurationSeconds;
  }

  /**
   * Update filter configuration
   */
  updateConfig(updates: Partial<ChatFilterConfig>): void {
    Object.assign(this.config, updates);
    this.invalidateCache();
    logger.info('Filter config updated', { updates: Object.keys(updates) });
  }

  /**
   * Set blacklist words from array
   */
  setBlacklistWords(words: string[]): void {
    this.config.blacklistWords = new Set(
      words.map((w) => w.trim().toLowerCase()).filter(Boolean)
    );
    this.invalidateCache();
  }
}

// Export singleton instance
let defaultFilterManager: ChatFilterManager | null = null;

export function getFilterManager(): ChatFilterManager {
  if (!defaultFilterManager) {
    defaultFilterManager = ChatFilterManager.fromEnv();
  }
  return defaultFilterManager;
}

export function resetFilterManager(): void {
  defaultFilterManager = null;
}
