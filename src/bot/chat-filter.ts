/**
 * Chat filtering: blacklist words, URLs, caps, repeated characters and spam,
 * plus the moderator commands that edit the blacklist.
 *
 * NOTE: src/filters/chat-filter.ts (ChatFilterManager) implements the same checks
 * but is not used here; it differs in logging and configuration plumbing.
 */

import * as featureScopes from '../lib/feature-scopes';
import type { ChatFilterSettings } from './config';
import type { BotContext } from './context';

export type FilterViolation = 'blacklist_word' | 'url' | 'all_caps' | 'repeat_chars' | 'spam';

export interface FilterStatus {
  blacklistWords: string[];
  filterUrls: boolean;
  filterAllCaps: boolean;
  filterRepeatChars: boolean;
  filterSpam: boolean;
  timeoutDurationSeconds: number;
  filterAction: string;
}

/**
 * Outcome of a blacklist edit: 'saved' (also persisted via the dashboard), 'unsaved' (applied in
 * memory only because the dashboard call failed), 'missing' (word was not listed) or 'invalid' (empty)
 */
export type FilterWordResult = 'saved' | 'unsaved' | 'missing' | 'invalid';

export interface ChatFilter {
  settings: ChatFilterSettings;
  checkChatFilters: (message: string, username: string) => FilterViolation[];
  checkChatFiltersWithoutSideEffects: (message: string) => FilterViolation[];
  /** Resolves to whether Twitch confirmed the timeout */
  timeoutUser: (channel: string, username: string, durationSeconds: number) => Promise<boolean>;
  /** Delete one chat message on Twitch by its IRC id; resolves to whether Twitch confirmed it */
  deleteMessage: (messageId: string | undefined) => Promise<boolean>;
  addFilterWord: (word: string) => Promise<FilterWordResult>;
  removeFilterWord: (word: string) => Promise<FilterWordResult>;
  getFilterStatus: () => FilterStatus;
  invalidateFilterStatusCache: () => void;
}

const FILTER_CACHE_TTL = 5000; // 5 second cache TTL

export function createChatFilter(ctx: BotContext, chatFilters: ChatFilterSettings): ChatFilter {
  // Filter status cache for performance optimization
  let filterStatusCache: FilterStatus | null = null;
  let filterCacheTimestamp = 0;

  const messageHistory = new Map<string, { text: string; time: number }>(); // Track user messages for spam detection
  // Message history cleanup tracking
  let lastMessageHistoryCleanup = Date.now();

  function checkChatFilters(message: string, username: string): FilterViolation[] {
    const text = message.toLowerCase().trim();
    const violations: FilterViolation[] = [];

    // Check blacklist words
    if (chatFilters.blacklistWords.size > 0) {
      const words = text.split(/\s+/);
      for (const word of words) {
        const cleaned = word.replace(/[^\w]/g, '');
        if (chatFilters.blacklistWords.has(cleaned)) {
          violations.push('blacklist_word');
          break;
        }
      }
    }

    // Check for URLs
    if (chatFilters.filterUrls && /https?:\/\/|www\./i.test(message)) {
      violations.push('url');
    }

    // Check all caps (if more than 50% caps and at least 5 chars)
    if (chatFilters.filterAllCaps && message.length >= 5) {
      const capsCount = (message.match(/[A-Z]/g) || []).length;
      if (capsCount / message.length >= 0.5) {
        violations.push('all_caps');
      }
    }

    // Check repeated characters (3+ same char in a row)
    if (chatFilters.filterRepeatChars && /(.)\1{2,}/.test(message)) {
      violations.push('repeat_chars');
    }

    // Check spam (same message within 5 seconds from same user)
    if (chatFilters.filterSpam) {
      const now = Date.now();
      if (messageHistory.has(username)) {
        const lastMsg = messageHistory.get(username)!;
        if (lastMsg.text === text && now - lastMsg.time < 5000) {
          violations.push('spam');
        }
      }
      messageHistory.set(username, { text, time: now });

      // Periodic cleanup: remove messages older than 10 minutes (run every 60 seconds)
      if (now - lastMessageHistoryCleanup > 60000) {
        const tenMinutesAgo = now - 600000;
        for (const [user, msg] of messageHistory.entries()) {
          if (msg.time < tenMinutesAgo) {
            messageHistory.delete(user);
          }
        }
        lastMessageHistoryCleanup = now;
      }
    }

    return violations;
  }

  // Check chat filters without side effects (for TTS validation)
  // This version doesn't update messageHistory to avoid affecting spam detection
  function checkChatFiltersWithoutSideEffects(message: string): FilterViolation[] {
    const text = message.toLowerCase().trim();
    const violations: FilterViolation[] = [];

    // Check blacklist words
    if (chatFilters.blacklistWords.size > 0) {
      const words = text.split(/\s+/);
      for (const word of words) {
        const cleaned = word.replace(/[^\w]/g, '');
        if (chatFilters.blacklistWords.has(cleaned)) {
          violations.push('blacklist_word');
          break;
        }
      }
    }

    // Check for URLs
    if (chatFilters.filterUrls && /https?:\/\/|www\./i.test(message)) {
      violations.push('url');
    }

    // Check all caps (if more than 50% caps and at least 5 chars)
    if (chatFilters.filterAllCaps && message.length >= 5) {
      const capsCount = (message.match(/[A-Z]/g) || []).length;
      if (capsCount / message.length >= 0.5) {
        violations.push('all_caps');
      }
    }

    // Check repeated characters (3+ same char in a row)
    if (chatFilters.filterRepeatChars && /(.)\1{2,}/.test(message)) {
      violations.push('repeat_chars');
    }

    // Note: Spam detection is intentionally skipped in this version
    // as it requires message history tracking which would be a side effect

    return violations;
  }

  /** Whether the bot token really has the moderation scopes (live validation, else configured scopes) */
  function canModerate(): boolean {
    const liveScopes = ctx.cachedTokenValidation.bot.scopes.length > 0
      ? ctx.cachedTokenValidation.bot.scopes
      : ctx.config.scopes;
    return featureScopes.hasRequiredScopes('moderation', liveScopes, 'bot');
  }

  // Timeout a user for violating chat filters
  async function timeoutUser(channel: string, username: string, durationSeconds: number): Promise<boolean> {
    try {
      const { tokenUserId, broadcasterId } = ctx.state;
      if (!tokenUserId || !broadcasterId || !canModerate()) return false;

      // Get user ID first
      const user = await ctx.apiClient.getUserByName(username);
      if (!user) return false;

      // Use Helix API to timeout the user
      const result = await ctx.apiClient.timeoutUser(broadcasterId, tokenUserId, user.id, durationSeconds);
      return result.success;
    } catch (error) {
      console.error(`Failed to timeout ${username}:`, (error as Error).message);
      return false;
    }
  }

  // Delete a message that violated chat filters
  async function deleteMessage(messageId: string | undefined): Promise<boolean> {
    try {
      const { tokenUserId, broadcasterId } = ctx.state;
      if (!messageId || !tokenUserId || !broadcasterId || !canModerate()) return false;
      const result = await ctx.apiClient.deleteChatMessage(broadcasterId, tokenUserId, messageId);
      return result.success;
    } catch (error) {
      console.error(`Failed to delete message ${messageId}:`, (error as Error).message);
      return false;
    }
  }

  /** Persist a blacklist edit through the dashboard filter API (which writes CHAT_FILTER_WORDS to .env) */
  async function persist(edit: () => Promise<unknown>, word: string): Promise<FilterWordResult> {
    try {
      await edit();
      return 'saved';
    } catch (error) {
      console.error(`Failed to save filter word "${word}" to the dashboard:`, (error as Error).message);
      return 'unsaved';
    }
  }

  // Add word to blacklist filter
  async function addFilterWord(word: string): Promise<FilterWordResult> {
    const normalized = (word || '').trim().toLowerCase();
    if (!normalized) return 'invalid';
    chatFilters.blacklistWords.add(normalized);
    invalidateFilterStatusCache();
    return persist(() => ctx.http.post(`${ctx.dashboardBaseUrl}/api/filters/words`, { word: normalized }), normalized);
  }

  // Remove word from blacklist filter
  async function removeFilterWord(word: string): Promise<FilterWordResult> {
    const normalized = (word || '').trim().toLowerCase();
    if (!normalized) return 'invalid';
    if (!chatFilters.blacklistWords.delete(normalized)) return 'missing';
    invalidateFilterStatusCache();
    return persist(
      () => ctx.http.delete(`${ctx.dashboardBaseUrl}/api/filters/words/${encodeURIComponent(normalized)}`),
      normalized
    );
  }

  // Get filter status with caching
  function getFilterStatus(): FilterStatus {
    const now = Date.now();

    // Return cached result if still valid
    if (filterStatusCache && (now - filterCacheTimestamp) < FILTER_CACHE_TTL) {
      return filterStatusCache;
    }

    // Regenerate cache
    filterStatusCache = {
      blacklistWords: Array.from(chatFilters.blacklistWords),
      filterUrls: chatFilters.filterUrls,
      filterAllCaps: chatFilters.filterAllCaps,
      filterRepeatChars: chatFilters.filterRepeatChars,
      filterSpam: chatFilters.filterSpam,
      timeoutDurationSeconds: chatFilters.timeoutDurationSeconds,
      filterAction: chatFilters.filterAction
    };
    filterCacheTimestamp = now;

    return filterStatusCache;
  }

  // Invalidate filter status cache
  function invalidateFilterStatusCache(): void {
    filterStatusCache = null;
    filterCacheTimestamp = 0;
  }

  return {
    settings: chatFilters,
    checkChatFilters,
    checkChatFiltersWithoutSideEffects,
    timeoutUser,
    deleteMessage,
    addFilterWord,
    removeFilterWord,
    getFilterStatus,
    invalidateFilterStatusCache
  };
}
