/**
 * EventSub setup: the bot listener (stream online/offline) and the
 * broadcaster listener (follows, raids, redemptions, subs, gift subs, cheers).
 */

import * as featureScopes from '../lib/feature-scopes';
import type { ChannelRedemptionAddEvent } from '../lib/twitch-eventsub-ws';
import { getBroadcasterApiHeaders } from './auth';
import { TTS_CONFIG } from './config';
import type { BotContext } from './context';
import type { DashboardClient } from './dashboard-client';
import type { TTS } from './tts';

export interface EventSubSetup {
  setupEventSub: () => Promise<void>;
  setupBroadcasterEventSub: () => Promise<void>;
}

/** Twitch tier id ('1000' / '2000' / '3000') as shown in chat; unknown or missing is Tier 1 */
function tierName(tier: string | undefined): string {
  return tier === '3000' ? 'Tier 3' : tier === '2000' ? 'Tier 2' : 'Tier 1';
}

/** "1 month", "12 months" */
function monthsText(months: number): string {
  return `${months} month${months === 1 ? '' : 's'}`;
}

/**
 * Whether a channel point reward is the TTS reward. With TTS_REWARD_TITLE set
 * the title must equal it (ignoring case and surrounding spaces); otherwise the
 * title must contain the word "TTS" (so "TTS Message" matches, "Pet the Mutts" does not).
 */
export function isTTSReward(rewardTitle: string, configuredTitle: string | undefined): boolean {
  const title = rewardTitle.trim().toLowerCase();
  const configured = (configuredTitle || '').trim().toLowerCase();
  if (configured) return title === configured;
  const word = TTS_CONFIG.CHANNEL_POINTS_REWARD_TITLE.toLowerCase();
  return title.split(/[^a-z0-9]+/).includes(word);
}

export function createEventSubSetup(ctx: BotContext, dashboard: DashboardClient, tts: TTS): EventSubSetup {
  const { state, config, env, sendChatMessage } = ctx;
  const { logEventSubEvent, sendAlert } = dashboard;
  const eventSubDisabled = () => featureScopes.isTruthyEnvValue(env.DISABLE_EVENTSUB);

  // Redemptions are logged one at a time: the dashboard appends each to
  // redemptions.json under a file lock that a burst of parallel posts overruns
  // (the first one is sent at once, later ones wait for the post before them)
  let redemptionLog: Promise<unknown> | null = null;
  function logRedemption(entry: { user: string; reward: string; input: string }): void {
    const send = () => ctx.http.post(`${ctx.dashboardBaseUrl}/api/redemptions`, entry).catch(() => {});
    const next: Promise<unknown> = redemptionLog ? redemptionLog.then(send) : send();
    redemptionLog = next;
    void next.then(() => {
      if (redemptionLog === next) redemptionLog = null;
    });
  }

  /**
   * Refund a redemption by cancelling it on Twitch. Needs channel:manage:redemptions,
   * and Twitch only allows it for rewards created with this app's client ID.
   */
  async function refundRedemption(ev: ChannelRedemptionAddEvent, user: string): Promise<void> {
    if (!ev.id || !ev.rewardId) return;
    if (!ctx.cachedTokenValidation.broadcaster.scopes.includes('channel:manage:redemptions')) {
      console.warn(`[EventSub-Broadcaster] Cannot refund ${user}'s redemption: broadcaster token lacks channel:manage:redemptions`);
      return;
    }
    try {
      await ctx.rawHttp.patch(
        'https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions',
        { status: 'CANCELED' },
        {
          params: { broadcaster_id: ev.broadcasterUserId || state.broadcasterId, reward_id: ev.rewardId, id: ev.id },
          headers: getBroadcasterApiHeaders(ctx)
        }
      );
      console.log(`[EventSub-Broadcaster] Refunded ${user}'s rejected TTS redemption`);
    } catch (err) {
      const error = err as { message: string; response?: { data?: { message?: string } } };
      console.warn(`[EventSub-Broadcaster] Could not refund ${user}'s redemption:`, error.response?.data?.message || error.message);
    }
  }

  async function setupEventSub(): Promise<void> {
    if (state.eventSub) return;
    // Allow disabling EventSub via env if token auth is problematic
    if (eventSubDisabled()) {
      console.log(`EventSub disabled via DISABLE_EVENTSUB=${env.DISABLE_EVENTSUB}`);
      return;
    }
    // Guard: valid broadcaster ID required
    if (!state.broadcasterId || !/^\d+$/.test(String(state.broadcasterId))) {
      console.warn('EventSub disabled: broadcasterId invalid or non-numeric', state.broadcasterId);
      return;
    }
    if (!state.tokenUserId) {
      console.warn('EventSub disabled: no user token context');
      return;
    }
    // Guard: token scopes must include user/moderator permissions for basic EventSub
    if (!featureScopes.hasRequiredScopes('eventsub', config.scopes, 'broadcaster')) {
      console.warn('EventSub disabled: token scopes lack required permissions. Re-authorize with proper scopes.');
      return;
    }
    try {
      const eventSub = ctx.createEventSub({
        clientId: config.clientId,
        accessToken: config.accessToken
      });
      state.eventSub = eventSub;
      await eventSub.start();

      // Stream online/offline
      const subId = String(state.broadcasterId);
      console.log('[EventSub-Bot] Subscribing with broadcasterId:', subId, 'isNumeric:', /^\d+$/.test(subId), 'tokenUserId:', state.tokenUserId);

      // These subscriptions work with bot token
      try {
        await eventSub.onStreamOnline(subId, ev => {
          console.log('EventSub: Stream online');
          config.channels.forEach(ch => sendChatMessage(ch, 'Stream is now live!'));
        });
      } catch (err) {
        console.warn('[EventSub-Bot] Stream online subscription failed:', (err as Error).message);
      }

      try {
        await eventSub.onStreamOffline(subId, ev => {
          console.log('EventSub: Stream offline');
        });
      } catch (err) {
        console.warn('[EventSub-Bot] Stream offline subscription failed:', (err as Error).message);
      }

      console.log('✓ Bot EventSub listener initialized successfully');
    } catch (err) {
      console.error('Bot EventSub setup failed:', (err as Error | undefined)?.message || err);
    }
  }

  // Setup separate EventSub listener for broadcaster account (for follows, raids, etc.)
  async function setupBroadcasterEventSub(): Promise<void> {
    if (state.broadcasterEventSub) return;

    // Guard: broadcaster API client required
    if (!state.broadcasterApiClient) {
      console.log('[EventSub-Broadcaster] Broadcaster token not available. Skipping broadcaster EventSub setup.');
      return;
    }

    if (eventSubDisabled()) {
      console.log(`[EventSub-Broadcaster] EventSub disabled via DISABLE_EVENTSUB=${env.DISABLE_EVENTSUB}`);
      return;
    }

    if (!state.broadcasterId || !/^\d+$/.test(String(state.broadcasterId))) {
      console.warn('[EventSub-Broadcaster] broadcasterId invalid or non-numeric', state.broadcasterId);
      return;
    }

    // Validate broadcaster token and use actual scopes from Twitch (not just env var).
    // A dead token (startup refresh failed) would only collect 401s, so skip.
    if (!await ctx.tokenManager.validate('broadcaster')) {
      console.warn('[EventSub-Broadcaster] Broadcaster token is invalid or expired. Skipping broadcaster EventSub setup.');
      return;
    }
    const broadcasterScopes = ctx.cachedTokenValidation.broadcaster.scopes.length > 0
      ? ctx.cachedTokenValidation.broadcaster.scopes
      : (env.TWITCH_BROADCASTER_SCOPES || '').split(' ').filter(s => s);
    const hasFollowersScope = featureScopes.hasRequiredScopes('followage', broadcasterScopes, 'broadcaster');
    const hasRedemptionsScope = featureScopes.hasRequiredScopes('redemptions', broadcasterScopes, 'broadcaster');
    const hasSubscriptionsScope = featureScopes.hasRequiredScopes('subscriptions', broadcasterScopes, 'broadcaster');
    const hasBitsScope = featureScopes.hasRequiredScopes('bits', broadcasterScopes, 'broadcaster');

    // Raids need no scope, so the session is opened even when all of these are missing
    if (!hasFollowersScope && !hasRedemptionsScope && !hasSubscriptionsScope && !hasBitsScope) {
      console.warn('[EventSub-Broadcaster] Broadcaster token missing required scopes (only raids will be received):');
      console.warn('[EventSub-Broadcaster]   - moderator:read:followers (for follow events)');
      console.warn('[EventSub-Broadcaster]   - channel:read:redemptions (for redemption events)');
      console.warn('[EventSub-Broadcaster]   - channel:read:subscriptions (for subscription events)');
      console.warn('[EventSub-Broadcaster]   - bits:read (for bits/cheer events)');
      console.warn('[EventSub-Broadcaster] Visit http://localhost:3000 to regenerate broadcaster token with proper scopes.');
    }

    try {
      const broadcasterEventSub = ctx.createEventSub({
        clientId: config.clientId,
        accessToken: env.TWITCH_BROADCASTER_ACCESS_TOKEN
      });
      state.broadcasterEventSub = broadcasterEventSub;
      await broadcasterEventSub.start();

      const subId = String(state.broadcasterId);
      console.log('[EventSub-Broadcaster] Subscribing with broadcasterId:', subId);

      // Follows (requires broadcaster auth with moderator:read:followers scope)
      if (hasFollowersScope) {
        try {
          // onChannelFollow requires (broadcasterId, moderatorUserId, handler)
          // Use broadcasterUserId since the broadcaster token is authorized to the broadcaster account
          await broadcasterEventSub.onChannelFollow(subId, state.broadcasterUserId as string, ev => {
            const name = ev.userDisplayName || ev.userName || 'someone';
            config.channels.forEach(ch => sendChatMessage(ch, `Thanks for the follow, ${name}!`));

            // Log event and send alert to OBS overlay
            logEventSubEvent('follow', { user: name });
            sendAlert('follow', { user: name });
          });
          console.log('[EventSub-Broadcaster] Follow subscription active');
        } catch (err) {
          console.warn('[EventSub-Broadcaster] Follow subscription failed:', (err as Error).message);
        }
      } else {
        console.warn('[EventSub-Broadcaster] Skipping follow subscription: missing moderator:read:followers scope');
      }

      // Raids
      try {
        await broadcasterEventSub.onChannelRaidTo(subId, ev => {
          const from = ev.raidingBroadcasterDisplayName || ev.raidingBroadcasterName || ev.raidingBroadcasterLogin || 'someone';
          const viewers = ev.viewers ?? 0;
          config.channels.forEach(ch => sendChatMessage(ch, `Incoming raid from ${from} with ${viewers} viewers! Welcome!`));

          // Log event and send alert to OBS overlay
          logEventSubEvent('raid', { user: from, viewers: Number(viewers) });
          sendAlert('raid', { user: from, viewers: Number(viewers) });
        });
        console.log('[EventSub-Broadcaster] Raid subscription active');
      } catch (err) {
        console.warn('[EventSub-Broadcaster] Raid subscription failed:', (err as Error).message);
      }

      // Channel Points redemptions (requires broadcaster auth with channel:read:redemptions scope)
      if (hasRedemptionsScope) {
        try {
          await broadcasterEventSub.onChannelRedemptionAdd(subId, async ev => {
            const reward = ev.rewardTitle || 'Reward';
            const user = ev.userDisplayName || ev.userName;
            const input = ev.userInput || '';
            console.log('[EventSub-Broadcaster] Redemption:', reward, 'by', user, 'input:', input);
            // Log to dashboard
            logRedemption({ user, reward, input });

            if (input && isTTSReward(reward, env.TTS_REWARD_TITLE)) {
              // Process as TTS (bypasses per-user cooldown but respects global cooldown)
              const channel = ev.broadcasterUserLogin
                ? `#${ev.broadcasterUserLogin}`
                : config.channels[0];
              const args = input.split(' ');
              const result = await tts.handleTTS(channel, user, args, null, true);
              // Rejected (too long, filtered, queue full): give the points back
              if (result === false) await refundRedemption(ev, user);
            } else {
              // Basic mapping: echo to chat for non-TTS redemptions
              config.channels.forEach(ch => sendChatMessage(ch, `${user} redeemed: ${reward}${input ? ' - ' + input : ''}`));

              // Log event and send alert to OBS overlay
              logEventSubEvent('redemption', { user, reward, message: input });
              sendAlert('redemption', { user, reward, message: input });
            }
          });
          console.log('[EventSub-Broadcaster] Channel Points redemption subscription active');
        } catch (err) {
          console.warn('[EventSub-Broadcaster] Redemption subscription failed:', (err as Error).message);
        }
      } else {
        console.warn('[EventSub-Broadcaster] Skipping redemption subscription: missing channel:read:redemptions scope');
      }

      // Subscriptions (requires broadcaster auth with channel:read:subscriptions scope)
      if (hasSubscriptionsScope) {
        try {
          // Regular subscription
          await broadcasterEventSub.onChannelSubscription(subId, ev => {
            const user = ev.userDisplayName || ev.userName || 'someone';
            const tier = tierName(ev.tier);
            const isGift = ev.isGift || false;

            console.log('[EventSub-Broadcaster] Subscription:', user, tier, isGift ? '(gifted)' : '');

            if (!isGift) {
              config.channels.forEach(ch => sendChatMessage(ch, `Thank you ${user} for the ${tier} sub!`));
            }

            // Log event and send alert to OBS overlay
            logEventSubEvent('subscription', { user, tier, isGift });
            if (!isGift) {
              sendAlert('subscription', { user, tier });
            }
          });
          console.log('[EventSub-Broadcaster] Subscription event active');
        } catch (err) {
          console.warn('[EventSub-Broadcaster] Subscription event failed:', (err as Error).message);
        }

        try {
          // Subscription message (resubs with message)
          await broadcasterEventSub.onChannelSubscriptionMessage(subId, ev => {
            const user = ev.userDisplayName || ev.userName || 'someone';
            const tier = tierName(ev.tier);
            const months = ev.cumulativeMonths || 1;
            const message = ev.messageText || '';

            console.log('[EventSub-Broadcaster] Resub:', user, tier, months, 'months');

            config.channels.forEach(ch => {
              const msgPart = message ? ` "${message}"` : '';
              sendChatMessage(ch, `Thank you ${user} for ${monthsText(months)} at ${tier}!${msgPart}`);
            });

            // Log event and send alert to OBS overlay
            logEventSubEvent('subscription', { user, tier, months, message });
            sendAlert('subscription', { user, tier, message: `${monthsText(months)}${message ? ' - ' + message : ''}` });
          });
          console.log('[EventSub-Broadcaster] Subscription message event active');
        } catch (err) {
          console.warn('[EventSub-Broadcaster] Subscription message event failed:', (err as Error).message);
        }

        try {
          // Gift subscription
          await broadcasterEventSub.onChannelSubscriptionGift(subId, ev => {
            const gifter = ev.gifterDisplayName || ev.gifterName || 'Anonymous';
            const tier = tierName(ev.tier);
            const amount = ev.amount || 1;
            const isAnonymous = ev.isAnonymous || false;
            const total = ev.cumulativeAmount || amount;

            console.log('[EventSub-Broadcaster] Gift Sub:', gifter, 'gifted', amount, tier, 'subs');

            const gifterName = isAnonymous ? 'An anonymous gifter' : gifter;
            config.channels.forEach(ch => {
              sendChatMessage(ch, `${gifterName} gifted ${amount} ${tier} sub${amount > 1 ? 's' : ''}! (${total} total)`);
            });

            // Log event and send alert to OBS overlay
            logEventSubEvent('subscription_gift', { user: gifterName, tier, amount, total, isAnonymous });
            sendAlert('subscription', {
              user: gifterName,
              tier,
              message: `Gifted ${amount} sub${amount > 1 ? 's' : ''}!`
            });
          });
          console.log('[EventSub-Broadcaster] Gift subscription event active');
        } catch (err) {
          console.warn('[EventSub-Broadcaster] Gift subscription event failed:', (err as Error).message);
        }
      } else {
        console.warn('[EventSub-Broadcaster] Skipping subscription events: missing channel:read:subscriptions scope');
      }

      // Bits/Cheers (requires broadcaster auth with bits:read scope)
      if (hasBitsScope) {
        try {
          await broadcasterEventSub.onChannelCheer(subId, ev => {
            const user = ev.userDisplayName || ev.userName || 'Anonymous';
            const bits = ev.bits || 0;
            const message = ev.message || '';
            const isAnonymous = ev.isAnonymous || false;

            console.log('[EventSub-Broadcaster] Cheer:', user, 'cheered', bits, 'bits');

            const cheererName = isAnonymous ? 'Anonymous' : user;
            config.channels.forEach(ch => {
              const msgPart = message ? ` "${message}"` : '';
              sendChatMessage(ch, `${cheererName} cheered ${bits} bits!${msgPart}`);
            });

            // Log event and send alert to OBS overlay
            logEventSubEvent('bits', { user: cheererName, amount: bits, message, isAnonymous });
            sendAlert('bits', { user: cheererName, amount: bits, message });
          });
          console.log('[EventSub-Broadcaster] Bits/Cheer event active');
        } catch (err) {
          console.warn('[EventSub-Broadcaster] Bits/Cheer event failed:', (err as Error).message);
        }
      } else {
        console.warn('[EventSub-Broadcaster] Skipping bits/cheer events: missing bits:read scope');
      }

      console.log('Broadcaster EventSub listener initialized successfully');
    } catch (err) {
      console.error('Broadcaster EventSub setup failed:', (err as Error | undefined)?.message || err);
    }
  }

  return { setupEventSub, setupBroadcasterEventSub };
}
