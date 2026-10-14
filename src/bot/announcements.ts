/**
 * Announcement scheduler: posts the configured ANNOUNCEMENTS in rotation,
 * as Helix announcements when the bot has the scope, else as chat messages.
 */

import * as featureScopes from '../lib/feature-scopes';
import type { AnnouncementSettings } from './config';
import type { BotContext } from './context';

export interface Announcements {
  startAnnouncements: () => Promise<void>;
  stopAnnouncements: () => void;
}

export function createAnnouncements(ctx: BotContext, settings: AnnouncementSettings): Announcements {
  const ANNOUNCEMENT_INTERVAL_MS = settings.intervalMs;
  const ANNOUNCEMENTS = settings.messages;
  let announcementTimer: ReturnType<typeof setInterval> | null = null;

  async function startAnnouncements(): Promise<void> {
    if (!ANNOUNCEMENTS.length || ANNOUNCEMENT_INTERVAL_MS < 60000) return;
    if (announcementTimer) clearInterval(announcementTimer);
    let idx = 0;
    announcementTimer = setInterval(async () => {
      try {
        const msg = ANNOUNCEMENTS[idx % ANNOUNCEMENTS.length];
        idx++;
        for (const channel of ctx.config.channels) {
          // Use live scopes from last token validation (falls back to config if not yet populated)
          const liveScopes = ctx.cachedTokenValidation.bot.scopes.length > 0
            ? ctx.cachedTokenValidation.bot.scopes
            : ctx.config.scopes;
          if (featureScopes.hasRequiredScopes('announcements', liveScopes, 'bot')) {
            // A 401 here is already refreshed and retried once by the Helix client
            // Only started after init() resolved both ids
            const result = await ctx.apiClient.sendAnnouncement(ctx.state.broadcasterId as string, ctx.state.tokenUserId as string, msg, 'purple');
            if (!result.success) {
              ctx.sendChatMessage(channel, msg);
            }
          } else {
            ctx.sendChatMessage(channel, msg);
          }
        }
      } catch (e) {
        // ignore announcement errors
      }
    }, ANNOUNCEMENT_INTERVAL_MS);
  }

  function stopAnnouncements(): void {
    if (announcementTimer) clearInterval(announcementTimer);
    announcementTimer = null;
  }

  return { startAnnouncements, stopAnnouncements };
}
