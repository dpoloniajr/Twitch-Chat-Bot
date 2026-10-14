/**
 * Channel commands: !clip, !followage, !shoutout / !so, !title and !game.
 */

import * as featureScopes from '../lib/feature-scopes';
import { errorMessage } from '../lib/twitch-helix-api';
import { getBroadcasterApiHeaders, getBroadcasterScopes } from './auth';
import type { BotContext, HttpError } from './context';
import type { Cooldowns } from './cooldowns';
import type { DashboardClient } from './dashboard-client';

export type ClipResult = { success: true; url: string } | { success: false; error: string; message?: string };
export type FollowAgeResult = { success: true; message: string } | { success: false; error?: string; message?: string };
export type ShoutoutResult =
  | { success: true; message: string; username: string; gameName: string; isLive: boolean; channelUrl: string }
  | { success: false; error: string; message?: string };
export type TitleResult = { success: true; title: string } | { success: false; error: string; message?: string };
export type GameResult = { success: true; gameId: string; gameName: string } | { success: false; error: string; message?: string };

export interface ChannelCommands {
  createClip: () => Promise<ClipResult>;
  getFollowAge: (username: string) => Promise<FollowAgeResult>;
  sendShoutout: (targetUsername: string) => Promise<ShoutoutResult>;
  updateStreamTitle: (newTitle: string) => Promise<TitleResult>;
  updateStreamGame: (gameName: string) => Promise<GameResult>;
  handleClip: (channel: string, username: string) => Promise<void>;
  /** These handlers resolve to true on success, which is when the command's cooldown starts */
  handleFollowage: (channel: string, username: string, targetUser: string | undefined) => Promise<boolean>;
  handleShoutout: (channel: string, username: string, targetUser: string | undefined) => Promise<boolean>;
  handleTitle: (channel: string, username: string, newTitle: string) => Promise<boolean>;
  handleGame: (channel: string, username: string, gameQuery: string) => Promise<boolean>;
}

/** Helix lookups that report API errors instead of treating them as "not found" */
const STRICT = { throwOnError: true } as const;

/** Chat text for a Helix call that failed while doing `step` */
function apiFailure(step: string, error: unknown): string {
  return `Twitch API error while ${step}: ${errorMessage(error)}`;
}

/** Strip one pair of surrounding quotes, as the usage text (!title "new title") shows them */
export function unquoteTitle(text: string): string {
  return text.trim().replace(/^["“](.*)["”]$/s, '$1').trim();
}

export function createChannelCommands(ctx: BotContext, cooldowns: Cooldowns, dashboard: DashboardClient): ChannelCommands {
  const { state, config, sendChatMessage } = ctx;
  const { logCommandExecution } = dashboard;

  // Create a clip
  async function createClip(): Promise<ClipResult> {
    try {
      if (!state.initComplete) {
        return { success: false, error: 'Bot is still initializing. Please try again in a moment.' };
      }

      if (!state.broadcasterId) {
        return { success: false, error: 'Bot not initialized. Broadcaster ID is missing. Restart the bot.' };
      }

      // Check the scopes the bot token really has (from the last validation). config.scopes is not
      // enough: the startup scope sync adds every scope enabled features need, granted or not.
      const liveScopes = ctx.cachedTokenValidation.bot.scopes.length > 0
        ? ctx.cachedTokenValidation.bot.scopes
        : config.scopes;
      if (!featureScopes.hasRequiredScopes('clips', liveScopes, 'bot')) {
        console.error('Missing required scope: clips:edit');
        return { success: false, error: 'Missing clips:edit scope. Please re-authorize with the token generator.' };
      }

      // Ensure broadcasterId is a string
      const channelId = String(state.broadcasterId);
      console.log('[DEBUG] Calling create clip via Helix API. channelId:', channelId, 'scopes:', liveScopes);

      // The Helix client sends only Twitch headers (ctx.http would add the dashboard secret)
      const result = await ctx.apiClient.createClip(channelId);
      if (!result.success) {
        return { success: false, error: result.error };
      }

      const clipId = result.clipId;
      const clipUrl = `https://clips.twitch.tv/${clipId}`;
      console.log('[DEBUG] Clip created successfully. ID:', clipId, 'URL:', clipUrl);
      return { success: true, url: clipUrl };
    } catch (e) {
      const error = e as HttpError;
      console.error('Failed to create clip:', error?.response?.data || error);
      const errorMsg = (error?.response?.data?.message) || error.message || error.toString();
      return { success: false, error: errorMsg };
    }
  }

  // Get follow age
  async function getFollowAge(username: string): Promise<FollowAgeResult> {
    let step = 'looking up the user';
    try {
      const user = await ctx.apiClient.getUserByName(username, STRICT);
      if (!user) return { success: false, error: 'User not found' };

      // getChannelFollowers returns a paginated result with a 'data' property
      // Chat only connects after init() resolved broadcasterId
      step = 'checking the follow';
      const followsResult = await ctx.apiClient.getChannelFollowers(state.broadcasterId as string, user.id, STRICT);
      const follows = followsResult?.data || [];

      if (!follows || follows.length === 0) {
        return { success: false, message: 'Not following' };
      }

      // Debug log to check the follower data structure
      console.log('[DEBUG] Follower data:', follows[0]);

      const followedAt = new Date(follows[0].followDate || follows[0].followedAt);
      if (isNaN(followedAt.getTime())) {
        console.error('[DEBUG] Invalid followedAt date:', follows[0]);
        return { success: false, error: 'Invalid follow date' };
      }

      const now = new Date();
      const diff = now.getTime() - followedAt.getTime();

      const years = Math.floor(diff / (1000 * 60 * 60 * 24 * 365.25));
      const months = Math.floor((diff % (1000 * 60 * 60 * 24 * 365.25)) / (1000 * 60 * 60 * 24 * 30.44));
      const days = Math.floor((diff % (1000 * 60 * 60 * 24 * 30.44)) / (1000 * 60 * 60 * 24));

      let ageStr = '';
      if (years > 0) ageStr += `${years} year${years > 1 ? 's' : ''} `;
      if (months > 0) ageStr += `${months} month${months > 1 ? 's' : ''} `;
      if (days > 0 || ageStr === '') ageStr += `${days} day${days !== 1 ? 's' : ''}`;

      return { success: true, message: `Following for ${ageStr.trim()}` };
    } catch (error) {
      console.error('Failed to get follow age:', (error as Error).message);
      return { success: false, error: apiFailure(step, error) };
    }
  }

  // Send shoutout
  async function sendShoutout(targetUsername: string): Promise<ShoutoutResult> {
    let step = 'looking up the user';
    try {
      const user = await ctx.apiClient.getUserByName(targetUsername, STRICT);
      if (!user) return { success: false, error: 'User not found' };

      if (!state.tokenUserId) {
        return { success: false, error: 'Bot token missing user context; restart after re-auth.' };
      }

      // Get the user's channel information to find last played game
      const channelInfo = await ctx.apiClient.getChannelInfo(user.id);
      const gameName = channelInfo?.gameName || 'something awesome';

      // Check if the target user is live
      step = 'checking whether they are live';
      const streamInfo = await ctx.apiClient.getStreamByUserId(user.id, STRICT);
      const isLive = streamInfo !== null;

      if (isLive) {
        // Send the shoutout via API if they're live
        const shoutoutResult = await ctx.apiClient.sendShoutout(state.broadcasterId as string, user.id, state.tokenUserId);
        if (!shoutoutResult.success) {
          console.warn('Shoutout API failed:', shoutoutResult.error);
          // Continue anyway - we'll still send the chat message
        }
      }

      return {
        success: true,
        message: `Shoutout to ${user.displayName}! Check out their channel: https://twitch.tv/${user.name || user.login} - They're playing ${gameName}${isLive ? ' - go follow them!' : ''}`,
        username: user.displayName,
        gameName: gameName,
        isLive: isLive,
        channelUrl: `https://twitch.tv/${user.name || user.login}`
      };
    } catch (error) {
      console.error('Failed to send shoutout:', (error as Error).message);
      return { success: false, error: apiFailure(step, error) };
    }
  }

  // Update stream title (mods/broadcaster only)
  async function updateStreamTitle(newTitle: string): Promise<TitleResult> {
    try {
      if (!state.initComplete || !state.broadcasterId) {
        return { success: false, error: 'Bot not initialized yet. Try again shortly.' };
      }
      if (!featureScopes.hasRequiredScopes('channel_updates', getBroadcasterScopes(ctx), 'broadcaster')) {
        return { success: false, error: 'Missing scope: channel:manage:broadcast. Re-authorize via the token generator.' };
      }
      const title = String(newTitle || '').trim();
      if (!title) {
        return { success: false, error: 'Title cannot be empty.' };
      }
      await ctx.rawHttp.patch(
        `https://api.twitch.tv/helix/channels?broadcaster_id=${state.broadcasterId}`,
        { title },
        {
          headers: getBroadcasterApiHeaders(ctx)
        }
      );
      return { success: true, title };
    } catch (e) {
      const error = e as HttpError;
      const msg = (error?.response?.data?.message) || error.message || 'Unknown error';
      return { success: false, error: msg };
    }
  }

  // Update stream game/category (mods/broadcaster only)
  async function updateStreamGame(gameName: string): Promise<GameResult> {
    try {
      if (!state.initComplete || !state.broadcasterId) {
        return { success: false, error: 'Bot not initialized yet. Try again shortly.' };
      }
      if (!featureScopes.hasRequiredScopes('channel_updates', getBroadcasterScopes(ctx), 'broadcaster')) {
        return { success: false, error: 'Missing scope: channel:manage:broadcast. Re-authorize via the token generator.' };
      }
      const name = String(gameName || '').trim();
      if (!name) {
        return { success: false, error: 'Game name cannot be empty.' };
      }

      // Resolve game ID by name via Helix API
      const headers = getBroadcasterApiHeaders(ctx);
      let gameId: string | null = null;
      let resolvedName = name;
      // Last lookup error, so an outage is not reported as an unknown game
      let lookupError: unknown = null;
      try {
        const resp = await ctx.rawHttp.get('https://api.twitch.tv/helix/games', { params: { name }, headers });
        const game = resp.data?.data?.[0] || null;
        if (game) {
          gameId = game.id;
          resolvedName = game.name || name;
        }
      } catch (e) {
        lookupError = e;
      }

      // Fallback to search categories
      if (!gameId) {
        try {
          const resp = await ctx.rawHttp.get('https://api.twitch.tv/helix/search/categories', { params: { query: name }, headers });
          const cat = resp.data?.data?.[0] || null;
          if (cat) {
            gameId = cat.id;
            resolvedName = cat.name || name;
          }
        } catch (e) {
          lookupError = e;
        }
      }

      if (!gameId && lookupError) {
        return { success: false, error: apiFailure(`looking up "${name}"`, lookupError) };
      }
      if (!gameId) {
        return { success: false, error: `Could not find a game/category named "${name}".` };
      }

      await ctx.rawHttp.patch(
        `https://api.twitch.tv/helix/channels?broadcaster_id=${state.broadcasterId}`,
        { game_id: gameId },
        {
          headers: getBroadcasterApiHeaders(ctx)
        }
      );
      return { success: true, gameId, gameName: resolvedName };
    } catch (e) {
      const error = e as HttpError;
      const msg = (error?.response?.data?.message) || error.message || 'Unknown error';
      return { success: false, error: msg };
    }
  }

  // ==================== COMMAND HANDLERS ====================

  async function handleClip(channel: string, username: string): Promise<void> {
    if (!state.initComplete) {
      sendChatMessage(channel, '@' + username + ' Bot is still initializing. Please try again in a moment.');
      return;
    }
    // Use configurable cooldown from dashboard
    const cooldownSeconds = cooldowns.getCommandCooldown('!clip');
    if (cooldowns.isOnCooldown('clip', cooldownSeconds)) {
      const remainingSec = cooldowns.remainingSeconds('clip', cooldownSeconds);
      sendChatMessage(channel, `@${username} !clip is on cooldown. Try again in ${remainingSec}s.`);
      return;
    }
    const result = await createClip();
    if (!result.success) {
      sendChatMessage(channel, `@${username} Error: ${result.error || result.message}`);
      logCommandExecution(username, '!clip', [], 'failed');
    } else {
      sendChatMessage(channel, `@${username} Clip created! ${result.url}`);
      logCommandExecution(username, '!clip', [], 'success');
      cooldowns.setCooldown('clip');
    }
  }

  async function handleFollowage(channel: string, username: string, targetUser: string | undefined): Promise<boolean> {
    if (!targetUser) {
      sendChatMessage(channel, `@${username} Usage: !followage [username]`);
      return false;
    }
    const result = await getFollowAge(targetUser);
    if (!result.success) {
      sendChatMessage(channel, `@${username} Error: ${result.error || result.message}`);
      logCommandExecution(username, '!followage', [targetUser], 'failed');
      return false;
    }
    sendChatMessage(channel, `@${username} ${result.message}`);
    logCommandExecution(username, '!followage', [targetUser], 'success');
    return true;
  }

  async function handleShoutout(channel: string, username: string, targetUser: string | undefined): Promise<boolean> {
    if (!targetUser) {
      sendChatMessage(channel, `@${username} Usage: !shoutout [username]`);
      return false;
    }
    const result = await sendShoutout(targetUser);
    if (!result.success) {
      sendChatMessage(channel, `@${username} Error: ${result.error || result.message}`);
      logCommandExecution(username, '!shoutout', [targetUser], 'failed');
      return false;
    }
    sendChatMessage(channel, result.message);
    logCommandExecution(username, '!shoutout', [targetUser], 'success');
    return true;
  }

  async function handleTitle(channel: string, username: string, newTitle: string): Promise<boolean> {
    const title = unquoteTitle(newTitle);
    if (!title) {
      sendChatMessage(channel, 'Usage: !title "new title"');
      return false;
    }
    const result = await updateStreamTitle(title);
    if (!result.success) {
      sendChatMessage(channel, `Error: ${result.error || result.message}`);
      logCommandExecution(username, '!title', [title], 'failed');
      return false;
    }
    sendChatMessage(channel, `✓ Stream title updated to: "${title}"`);
    logCommandExecution(username, '!title', [title], 'success');
    return true;
  }

  async function handleGame(channel: string, username: string, gameQuery: string): Promise<boolean> {
    if (!gameQuery) {
      sendChatMessage(channel, 'Usage: !game <game name>');
      return false;
    }
    const result = await updateStreamGame(gameQuery);
    if (!result.success) {
      sendChatMessage(channel, `Error: ${result.error || result.message}`);
      logCommandExecution(username, '!game', [gameQuery], 'failed');
      return false;
    }
    sendChatMessage(channel, `✓ Game updated to: ${result.gameName}`);
    logCommandExecution(username, '!game', [gameQuery], 'success');
    return true;
  }

  return {
    createClip, getFollowAge, sendShoutout, updateStreamTitle, updateStreamGame,
    handleClip, handleFollowage, handleShoutout, handleTitle, handleGame
  };
}
