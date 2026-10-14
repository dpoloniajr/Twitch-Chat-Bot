/**
 * TTS: the !tts command and channel point TTS redemptions, with per-user and
 * global cooldowns. Redemptions that arrive during the global cooldown wait in
 * the redemption queue instead of being dropped.
 */

import { createRedemptionTTSQueue, type RedemptionQueue } from '../lib/tts-redemption-queue';
import { TTS_CONFIG } from './config';
import type { BotContext, ChatMessage } from './context';
import type { ChatFilter } from './chat-filter';
import type { DashboardClient } from './dashboard-client';

export interface TTSRedemption {
  channel: string;
  username: string;
  args: string[];
  msg: ChatMessage | null;
}

export type TTSResult = boolean | 'defer';

export interface TTS {
  handleTTS: (
    channel: string,
    username: string,
    args: string[],
    msg: ChatMessage | null,
    isRedemption?: boolean,
    options?: { fromQueue?: boolean }
  ) => Promise<TTSResult>;
  getTTSGlobalCooldownRemainingMs: (now?: number) => number;
  ttsRedemptionQueue: RedemptionQueue<TTSRedemption>;
}

export function createTTS(ctx: BotContext, filter: ChatFilter, dashboard: DashboardClient): TTS {
  const { sendChatMessage } = ctx;
  const { logCommandExecution, sendAlert } = dashboard;

  const ttsUserCooldowns = new Map<string, number>(); // Per-user TTS cooldowns
  let lastGlobalTTSTime = 0; // Global TTS cooldown

  function getTTSGlobalCooldownRemainingMs(now: number = Date.now()): number {
    const elapsedMs = now - lastGlobalTTSTime;
    const cooldownMs = TTS_CONFIG.GLOBAL_COOLDOWN_SEC * 1000;
    return Math.max(0, cooldownMs - elapsedMs);
  }

  const ttsRedemptionQueue = createRedemptionTTSQueue<TTSRedemption>({
    getCooldownRemainingMs: () => getTTSGlobalCooldownRemainingMs(),
    processRedemption: async ({ channel, username, args, msg }) => {
      return handleTTS(channel, username, args, msg, true, { fromQueue: true });
    },
    maxSize: TTS_CONFIG.REDEMPTION_QUEUE_MAX_SIZE
  });

  async function handleTTS(
    channel: string,
    username: string,
    args: string[],
    msg: ChatMessage | null,
    isRedemption = false,
    options: { fromQueue?: boolean } = {}
  ): Promise<TTSResult> {
    const text = args.join(' ').trim();

    // Normalize username to lowercase for consistent cooldown tracking
    const normalizedUsername = username.toLowerCase();

    // Validate text length
    if (!text) {
      if (!isRedemption) {
        sendChatMessage(channel, `@${username} Usage: !tts <message> (max ${TTS_CONFIG.MAX_LENGTH} characters)`);
      }
      return false; // Don't apply cooldown
    }

    if (text.length > TTS_CONFIG.MAX_LENGTH) {
      sendChatMessage(channel, `@${username} TTS message too long! Max ${TTS_CONFIG.MAX_LENGTH} characters (you used ${text.length}).`);
      return false; // Don't apply cooldown
    }

    // Apply content filtering (exempt mods and broadcaster, skip side effects)
    const isMod = msg?.userInfo?.isMod || false;
    const isBroadcaster = msg?.userInfo?.isBroadcaster || false;

    if (!isMod && !isBroadcaster) {
      // Check filters without updating message history (avoid spam detection side effects)
      const violations = filter.checkChatFiltersWithoutSideEffects(text);
      if (violations.length > 0) {
        sendChatMessage(channel, `@${username} TTS message blocked: contains filtered content (${violations.join(', ')}).`);
        logCommandExecution(username, '!tts', args, false);
        return false; // Don't apply cooldown
      }
    }

    // Check global cooldown
    const now = Date.now();
    const cooldownRemainingMs = getTTSGlobalCooldownRemainingMs(now);
    if (cooldownRemainingMs > 0) {
      const remainingSec = Math.max(1, Math.ceil(cooldownRemainingMs / 1000));

      if (isRedemption) {
        if (options.fromQueue) {
          return 'defer';
        }

        const enqueueResult = ttsRedemptionQueue.enqueue({
          channel,
          username,
          args: Array.isArray(args) ? [...args] : [],
          msg
        });

        if (!enqueueResult.accepted) {
          console.warn(`[TTS] Dropping redemption for @${username}: queue is full (${enqueueResult.size}/${TTS_CONFIG.REDEMPTION_QUEUE_MAX_SIZE})`);
          return false;
        }

        console.log(`[TTS] Queued redemption for @${username} due to global cooldown (${remainingSec}s remaining). Queue size: ${enqueueResult.size}`);
        return true;
      }

      sendChatMessage(channel, `@${username} TTS is on global cooldown. Try again in ${remainingSec}s.`);
      return false; // Don't apply user cooldown
    }

    // Check per-user cooldown (unless it's a redemption)
    if (!isRedemption) {
      const lastUserTTS = ttsUserCooldowns.get(normalizedUsername) || 0;
      const timeSinceLastUserTTS = now - lastUserTTS;
      if (timeSinceLastUserTTS < TTS_CONFIG.PER_USER_COOLDOWN_SEC * 1000) {
        const remainingSec = Math.max(1, Math.ceil((TTS_CONFIG.PER_USER_COOLDOWN_SEC * 1000 - timeSinceLastUserTTS) / 1000));
        sendChatMessage(channel, `@${username} You're on TTS cooldown. Try again in ${remainingSec}s.`);
        return false;
      }
    }

    // Commit cooldowns now, before any async work, so concurrent calls (e.g. two
    // redemptions arriving back-to-back) can't both pass the checks above while
    // this call is still awaiting TTS generation.
    lastGlobalTTSTime = now;
    ttsUserCooldowns.set(normalizedUsername, now);

    // Cleanup old user cooldowns once the map grows past 100 entries
    if (ttsUserCooldowns.size > 100) {
      const cutoffTime = now - (TTS_CONFIG.PER_USER_COOLDOWN_SEC * 1000 * 2);
      for (const [user, timestamp] of ttsUserCooldowns.entries()) {
        if (timestamp < cutoffTime) {
          ttsUserCooldowns.delete(user);
        }
      }
    }

    // Generate TTS audio via dashboard API (only if API provider is configured, not browser)
    let audioUrl: string | null = null;
    let useBrowserTTS = true;

    // Check TTS provider config - skip API call if using browser TTS
    const ttsProvider = ctx.env.TTS_PROVIDER || 'browser';
    const shouldUseAPI = ttsProvider !== 'browser';

    if (shouldUseAPI) {
      try {
        const ttsResponse = await ctx.http.post(`${ctx.dashboardBaseUrl}/api/tts/generate`, {
          text,
          voice: null, // Use default voice
          provider: null // Use configured provider
        }, { timeout: 30000 });

        if (ttsResponse.data.success && !ttsResponse.data.useBrowserTTS) {
          // API TTS generated successfully
          audioUrl = ttsResponse.data.audioUrl;
          useBrowserTTS = false;
        }
      } catch (err) {
        console.error('[TTS] Failed to generate API TTS:', (err as Error).message);
        // Fall back to browser TTS
      }
    }

    // Send TTS alert to OBS overlay
    sendAlert('tts', {
      user: username,
      message: text,
      timestamp: new Date().toISOString(),
      audioUrl, // URL to generated audio file (or null for browser TTS)
      useBrowserTTS, // Flag to indicate whether to use browser TTS
      config: {
        ttsEnabled: true,
        ttsTemplate: text,
        duration: 5000 + (text.length * 50) // Base 5s + 50ms per character
      }
    });

    // Log successful TTS
    logCommandExecution(username, '!tts', args, true);

    return true; // Successfully processed
  }

  return { handleTTS, getTTSGlobalCooldownRemainingMs, ttsRedemptionQueue };
}
