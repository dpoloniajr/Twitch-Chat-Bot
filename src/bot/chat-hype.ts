/**
 * CHAT HYPE (ORIGINAL FEATURE)
 * Tracks chat activity and triggers a "hype" moment when message rate crosses a threshold.
 */

import type { HypeSettings } from './config';
import type { BotContext } from './context';

export interface ChatHype {
  getHypeConfig: () => HypeSettings;
  recordChatForHype: (channel: string) => number;
  getHypeCount: (channel: string) => number;
  tryTriggerHype: (channel: string) => void;
  /** Resolves to false when the request was refused (a viewer trying to change settings) */
  handleHype: (channel: string, username: string, args: string[], isMod: boolean) => boolean;
}

export function createChatHype(ctx: BotContext, hypeConfig: HypeSettings, HYPE_WINDOW_MS: number): ChatHype {
  const hypeActivityByChannel = new Map<string, { timestamps: number[] }>(); // channel -> { timestamps: number[] }
  const lastHypeTriggerByChannel = new Map<string, number>(); // channel -> timestamp (ms)

  function getHypeConfig(): HypeSettings {
    return { ...hypeConfig };
  }

  function recordChatForHype(channel: string): number {
    const key = channel.toLowerCase();
    const now = Date.now();
    const cutoff = now - HYPE_WINDOW_MS;

    if (!hypeActivityByChannel.has(key)) {
      hypeActivityByChannel.set(key, { timestamps: [] });
    }
    const entry = hypeActivityByChannel.get(key)!;
    entry.timestamps.push(now);
    while (entry.timestamps.length > 0 && entry.timestamps[0] < cutoff) {
      entry.timestamps.shift();
    }
    return entry.timestamps.length;
  }

  function getHypeCount(channel: string): number {
    const key = channel.toLowerCase();
    const entry = hypeActivityByChannel.get(key);
    if (!entry) return 0;
    const cutoff = Date.now() - HYPE_WINDOW_MS;
    const valid = entry.timestamps.filter(t => t >= cutoff);
    return valid.length;
  }

  function tryTriggerHype(channel: string): void {
    if (!hypeConfig.enabled) return;
    const count = getHypeCount(channel);
    if (count < hypeConfig.minMessages) return;

    const key = channel.toLowerCase();
    const last = lastHypeTriggerByChannel.get(key) || 0;
    const cooldownMs = hypeConfig.cooldownSec * 1000;
    if (Date.now() - last < cooldownMs) return;

    lastHypeTriggerByChannel.set(key, Date.now());
    ctx.sendChatMessage(channel, hypeConfig.message);
    ctx.http.post(`${ctx.dashboardBaseUrl}/api/hype/trigger`, {
      channel,
      count,
      threshold: hypeConfig.minMessages,
      windowSec: hypeConfig.windowSec
    }).catch((err: Error) => {
      console.error('[Hype] Failed to broadcast hype:', err.message);
    });
  }

  function handleHype(channel: string, username: string, args: string[], isMod: boolean): boolean {
    const sub = (args[0] || '').toLowerCase();
    const cfg = getHypeConfig();

    if (!isMod && (sub === 'set' || sub === 'cooldown' || sub === 'toggle')) {
      ctx.sendChatMessage(channel, `@${username} Only moderators can change hype settings.`);
      return false;
    }

    if (sub === 'set' && args[1] != null) {
      const n = parseInt(args[1], 10);
      if (isNaN(n) || n < 5 || n > 200) {
        ctx.sendChatMessage(channel, `@${username} Usage: !hype set <5-200>. Threshold must be between 5 and 200 messages.`);
        return false;
      }
      hypeConfig.minMessages = n;
      ctx.sendChatMessage(channel, `@${username} Hype now triggers at ${n} messages in ${cfg.windowSec}s.`);
      return true;
    }
    if (sub === 'cooldown' && args[1] != null) {
      const n = parseInt(args[1], 10);
      if (isNaN(n) || n < 30 || n > 600) {
        ctx.sendChatMessage(channel, `@${username} Cooldown must be between 30 and 600 seconds.`);
        return false;
      }
      hypeConfig.cooldownSec = n;
      ctx.sendChatMessage(channel, `@${username} Hype cooldown set to ${n}s.`);
      return true;
    }
    if (sub === 'toggle') {
      hypeConfig.enabled = !hypeConfig.enabled;
      ctx.sendChatMessage(channel, `@${username} Hype is now ${hypeConfig.enabled ? 'ON' : 'OFF'}.`);
      return true;
    }

    const count = getHypeCount(channel);
    const threshold = cfg.minMessages;
    const status = hypeConfig.enabled ? `${count} messages in the last ${cfg.windowSec}s. Hype triggers at ${threshold}. (Cooldown: ${cfg.cooldownSec}s)` : 'Hype is currently disabled.';
    ctx.sendChatMessage(channel, `@${username} Chat energy: ${status}`);
    return true;
  }

  return { getHypeConfig, recordChatForHype, getHypeCount, tryTriggerHype, handleHype };
}
