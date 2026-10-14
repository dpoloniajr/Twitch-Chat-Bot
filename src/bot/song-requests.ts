/**
 * Song requests: !sr / !songrequest (and !sr config), !song, !queue and the
 * moderator queue commands. The queue lives in the dashboard; YouTube supplies
 * the video metadata.
 */

import { checkModPermission, type BotContext, type ChatMessage, type HttpError } from './context';
import type { Cooldowns } from './cooldowns';
import type { DashboardClient } from './dashboard-client';
import { extractVideoId, formatDuration, isYouTubeUrl, type YouTubeClient, type YouTubeMetadata } from './youtube';

export interface QueuedSong {
  title: string;
  channelTitle: string;
  durationFormatted: string;
  durationSeconds?: number;
  requester: string;
  [key: string]: unknown;
}

export interface SongQueueData {
  active: QueuedSong[];
  [key: string]: unknown;
}

export interface SongQueueConfig {
  enabled?: boolean;
  [key: string]: unknown;
}

export type AddSongResult = { success: true; position?: number; [key: string]: unknown } | { success: false; error: string };

export interface SongCommands {
  getSongQueueConfig: () => Promise<SongQueueConfig | null>;
  addSongToQueue: (songData: Record<string, unknown>) => Promise<AddSongResult>;
  getSongQueue: () => Promise<SongQueueData | null>;
  handleSongRequest: (channel: string, username: string, msg: ChatMessage, args: string[]) => Promise<void>;
  /** Resolves false when nothing was shown, so the command cooldown is not started */
  handleCurrentSong: (channel: string, username: string) => Promise<boolean>;
  /** Resolves false when nothing was shown, so the command cooldown is not started */
  handleQueueInfo: (channel: string, username: string) => Promise<boolean>;
  handleSkipSong: (channel: string, username: string, msg: ChatMessage) => Promise<void>;
  handleRemoveSong: (channel: string, username: string, args: string[], msg: ChatMessage) => Promise<void>;
  handleClearQueue: (channel: string, username: string, msg: ChatMessage) => Promise<void>;
  handleBlockSong: (channel: string, username: string, args: string[]) => Promise<void>;
  handleUnblockSong: (channel: string, username: string, args: string[]) => Promise<void>;
  handleSongRequestConfig: (channel: string, username: string, msg: ChatMessage, args: string[]) => Promise<void>;
}

type SettingValue = boolean | number | string;

/** What a !blocksong / !unblocksong argument refers to */
export interface BlockTarget {
  type: 'video' | 'channel' | 'keyword';
  value: string;
  /** Set for a youtube.com/@handle URL: value is the handle until resolved to a channel id */
  handle?: string;
}

/**
 * Parse a block target: a channel URL (youtube.com/channel/UC... or /@handle),
 * a video URL, or else a keyword (including YouTube URLs with no video id).
 */
export function parseBlockTarget(input: string): BlockTarget {
  if (isYouTubeUrl(input)) {
    const channelMatch = input.match(/youtube\.com\/(?:channel\/(UC[\w-]+)|@([\w.-]+))/i);
    if (channelMatch) {
      if (channelMatch[1]) return { type: 'channel', value: channelMatch[1] }; // UC... ID
      return { type: 'channel', value: channelMatch[2], handle: channelMatch[2] }; // @handle
    }
    const videoId = extractVideoId(input);
    if (videoId) {
      return { type: 'video', value: videoId };
    }
  }
  return { type: 'keyword', value: input };
}

/** The dashboard's own error text for a failed request (e.g. a 400), else the HTTP error message */
function dashboardErrorMessage(error: unknown): string {
  const e = error as HttpError;
  const body = e.response?.data;
  return (body && typeof body.error === 'string' && body.error) || e.message;
}

/** Song request settings that !sr config can change (own keys only, never prototype names) */
const CONFIG_SETTINGS = ['enabled', 'cost', 'maxduration', 'maxperuser', 'duplicates', 'priority'];

export function createSongCommands(
  ctx: BotContext,
  cooldowns: Cooldowns,
  dashboard: DashboardClient,
  youtube: YouTubeClient
): SongCommands {
  const { http, dashboardBaseUrl, sendChatMessage } = ctx;
  const { logCommandExecution } = dashboard;
  const YOUTUBE_API_KEY = youtube.apiKey;

  /**
   * Parse a !blocksong / !unblocksong argument. Songs only carry a channel id,
   * so a @handle is resolved to its UC... id; null when it cannot be resolved.
   */
  async function resolveBlockTarget(input: string): Promise<BlockTarget | null> {
    const target = parseBlockTarget(input);
    if (!target.handle) return target;
    const channelId = await youtube.resolveChannelHandle(target.handle);
    return channelId ? { type: 'channel', value: channelId } : null;
  }

  /**
   * Get song queue configuration from dashboard API
   * @returns Configuration object or null if error
   */
  async function getSongQueueConfig(): Promise<SongQueueConfig | null> {
    try {
      const response = await http.get(`${dashboardBaseUrl}/api/song-queue/config`);
      return response.data;
    } catch (error) {
      console.error('Error fetching song queue config:', (error as Error).message);
      return null;
    }
  }

  /**
   * Add song to queue via dashboard API
   * @returns Response with success status and message
   */
  async function addSongToQueue(songData: Record<string, unknown>): Promise<AddSongResult> {
    try {
      const response = await http.post(`${dashboardBaseUrl}/api/song-queue/add`, songData);
      return { success: true, ...response.data };
    } catch (e) {
      const error = e as HttpError;
      if (error.response?.data) {
        return { success: false, error: error.response.data.error || 'Failed to add song to queue' };
      }
      return { success: false, error: error.message };
    }
  }

  /**
   * Get current song queue from dashboard API
   * @returns Queue data or null on error
   */
  async function getSongQueue(): Promise<SongQueueData | null> {
    try {
      const response = await http.get(`${dashboardBaseUrl}/api/song-queue`);
      return response.data;
    } catch (error) {
      console.error('Error fetching song queue:', (error as Error).message);
      return null;
    }
  }

  /**
   * Handle song request command (!sr / !songrequest)
   */
  async function handleSongRequest(channel: string, username: string, msg: ChatMessage, args: string[]): Promise<void> {
    // Check if we have YouTube API key configured
    if (!YOUTUBE_API_KEY) {
      sendChatMessage(channel, `@${username} Song requests are not configured (missing YouTube API key).`);
      return;
    }

    // Check cooldown (30 seconds per user)
    const cooldownKey = `sr_${username.toLowerCase()}`;
    const cooldownSeconds = 30;
    if (cooldowns.isOnCooldown(cooldownKey, cooldownSeconds)) {
      const remainingSec = cooldowns.remainingSeconds(cooldownKey, cooldownSeconds);
      sendChatMessage(channel, `@${username} Song requests are on cooldown. Try again in ${remainingSec}s.`);
      return;
    }

    // Get the input (everything after the command)
    const input = args.join(' ').trim();
    if (!input) {
      sendChatMessage(channel, `@${username} Usage: !sr <YouTube URL or search query>`);
      return;
    }

    // Check if song requests are enabled before calling YouTube API (saves quota)
    const srConfig = await getSongQueueConfig();
    if (srConfig && srConfig.enabled === false) {
      sendChatMessage(channel, `@${username} Song requests are currently disabled.`);
      return;
    }

    let videoId: string | null = null;
    let metadata: YouTubeMetadata | null = null;

    // Check if input is a YouTube URL or search query
    if (isYouTubeUrl(input)) {
      // Extract video ID from URL
      videoId = extractVideoId(input);
      if (!videoId) {
        sendChatMessage(channel, `@${username} Invalid YouTube URL.`);
        return;
      }

      // Fetch metadata
      metadata = await youtube.getYouTubeMetadata(videoId);
      if (!metadata) {
        sendChatMessage(channel, `@${username} Could not fetch video information. Please try again.`);
        return;
      }
    } else {
      // A bare 11-character video ID is looked up directly; input that only
      // looks like one (no such video) is searched for instead
      if (/^[a-zA-Z0-9_-]{11}$/.test(input)) {
        metadata = await youtube.getYouTubeMetadata(input);
      }
    }

    if (!metadata) {
      // Search YouTube for the query
      const searchResults = await youtube.searchYouTube(input, 1);
      if (!searchResults) {
        sendChatMessage(channel, `@${username} Could not search YouTube right now. Please try again.`);
        return;
      }
      if (searchResults.length === 0) {
        sendChatMessage(channel, `@${username} No results found for: "${input}"`);
        return;
      }

      videoId = searchResults[0];

      // Fetch metadata for the first result
      metadata = await youtube.getYouTubeMetadata(videoId);
      if (!metadata) {
        sendChatMessage(channel, `@${username} Could not fetch video information. Please try again.`);
        return;
      }
    }

    // Prepare song data
    const songData = {
      videoId: metadata.videoId,
      title: metadata.title,
      channelTitle: metadata.channelTitle,
      channelId: metadata.channelId,
      durationSeconds: metadata.durationSeconds,
      durationFormatted: metadata.durationFormatted,
      thumbnail: metadata.thumbnail,
      requester: username,
      requesterDisplayName: msg.userInfo.displayName || username,
      requesterIsSub: msg.userInfo.isSubscriber || false,
      requesterIsVip: msg.userInfo.isVip || false,
      requesterIsMod: msg.userInfo.isMod || false,
      requesterIsBroadcaster: msg.userInfo.isBroadcaster || false
    };

    // Add song to queue via dashboard API
    const result = await addSongToQueue(songData);

    if (!result.success) {
      sendChatMessage(channel, `@${username} ${result.error}`);
      logCommandExecution(username, '!sr', [input], 'failed');
      return;
    }

    // Success! Set cooldown and notify user
    cooldowns.setCooldown(cooldownKey);
    const position = result.position || '?';
    sendChatMessage(channel, `@${username} Added to queue (position ${position}): "${metadata.title}" [${metadata.durationFormatted}]`);
    logCommandExecution(username, '!sr', [input], 'success');
  }

  /**
   * Handle current song command (!song / !currentsong)
   * Shows the currently playing song (first in queue) and what's up next
   */
  async function handleCurrentSong(channel: string, username: string): Promise<boolean> {
    // Check if we have YouTube API key configured
    if (!YOUTUBE_API_KEY) {
      sendChatMessage(channel, `@${username} Song requests are not configured.`);
      return false;
    }

    const queueData = await getSongQueue();
    if (!queueData || !queueData.active) {
      sendChatMessage(channel, `@${username} Error fetching song queue.`);
      logCommandExecution(username, '!song', [], 'failed');
      return false;
    }

    if (queueData.active.length === 0) {
      sendChatMessage(channel, `@${username} No songs in the queue.`);
      logCommandExecution(username, '!song', [], 'success');
      return true;
    }

    const current = queueData.active[0];
    const currentMsg = `Now playing: "${current.title}" by ${current.channelTitle} [${current.durationFormatted}] (requested by @${current.requester})`;

    if (queueData.active.length > 1) {
      const next = queueData.active[1];
      sendChatMessage(channel, `${currentMsg} | Next up: "${next.title}" [${next.durationFormatted}]`);
    } else {
      sendChatMessage(channel, currentMsg);
    }

    logCommandExecution(username, '!song', [], 'success');
    return true;
  }

  /**
   * Handle queue info command (!queue)
   * Shows queue statistics and next few songs
   */
  async function handleQueueInfo(channel: string, username: string): Promise<boolean> {
    // Check if we have YouTube API key configured
    if (!YOUTUBE_API_KEY) {
      sendChatMessage(channel, `@${username} Song requests are not configured.`);
      return false;
    }

    const queueData = await getSongQueue();
    if (!queueData || !queueData.active) {
      sendChatMessage(channel, `@${username} Error fetching song queue.`);
      logCommandExecution(username, '!queue', [], 'failed');
      return false;
    }

    if (queueData.active.length === 0) {
      sendChatMessage(channel, `@${username} The queue is empty. Use !sr <URL or search query> to add a song!`);
      logCommandExecution(username, '!queue', [], 'success');
      return true;
    }

    // Calculate total duration
    const totalSeconds = queueData.active.reduce((sum, song) => sum + (song.durationSeconds || 0), 0);
    const totalFormatted = formatDuration(totalSeconds);

    // Build message with queue stats
    const count = queueData.active.length;
    let message = `Queue: ${count} song${count !== 1 ? 's' : ''} (${totalFormatted} total)`;

    // Show next 3 songs (starting from position 2, after the current song)
    if (queueData.active.length > 1) {
      const nextSongs = queueData.active.slice(1, 4); // Get songs at positions 2, 3, 4
      message += ' | Up next: ';
      const songList = nextSongs.map((song, idx) =>
        `${idx + 2}. "${song.title}" [${song.durationFormatted}]`
      ).join(', ');
      message += songList;
    }

    sendChatMessage(channel, message);
    logCommandExecution(username, '!queue', [], 'success');
    return true;
  }

  /**
   * Handle skip song command (!skip / !skipsong) - Moderator only
   * Removes the currently playing song (first in queue)
   */
  async function handleSkipSong(channel: string, username: string, msg: ChatMessage): Promise<void> {
    // Check if we have YouTube API key configured
    if (!YOUTUBE_API_KEY) {
      sendChatMessage(channel, `@${username} Song requests are not configured.`);
      return;
    }

    // Check mod permission
    if (!checkModPermission(msg, channel, username)) {
      sendChatMessage(channel, `@${username} Only moderators can skip songs.`);
      logCommandExecution(username, '!skip', [], 'failed');
      return;
    }

    try {
      // Call dashboard API to skip the current song
      const response = await http.post(
        `${dashboardBaseUrl}/api/song-queue/skip`,
        {},
        { timeout: 5000 }
      );

      if (response.data && response.data.success) {
        const skippedSong = response.data.skippedSong;
        if (skippedSong) {
          sendChatMessage(channel, `⏭️ Skipped: "${skippedSong.title}" by ${skippedSong.channelTitle}`);
        } else {
          sendChatMessage(channel, `@${username} No song to skip.`);
        }
        logCommandExecution(username, '!skip', [], 'success');
      } else {
        sendChatMessage(channel, `@${username} ${response.data?.error || 'Failed to skip song.'}`);
        logCommandExecution(username, '!skip', [], 'failed');
      }
    } catch (error) {
      console.error('Skip song error:', (error as Error).message);
      sendChatMessage(channel, `@${username} Error skipping song: ${(error as Error).message}`);
      logCommandExecution(username, '!skip', [], 'failed');
    }
  }

  /**
   * Handle remove song command (!removesong) - Moderator only
   * Removes a song by position (number) or by keyword (searches title/channel)
   */
  async function handleRemoveSong(channel: string, username: string, args: string[], msg: ChatMessage): Promise<void> {
    // Check if we have YouTube API key configured
    if (!YOUTUBE_API_KEY) {
      sendChatMessage(channel, `@${username} Song requests are not configured.`);
      return;
    }

    // Check mod permission
    if (!checkModPermission(msg, channel, username)) {
      sendChatMessage(channel, `@${username} Only moderators can remove songs.`);
      logCommandExecution(username, '!removesong', args, 'failed');
      return;
    }

    if (!args || args.length === 0) {
      sendChatMessage(channel, `@${username} Usage: !removesong <position or keyword>`);
      logCommandExecution(username, '!removesong', [], 'failed');
      return;
    }

    const target = args.join(' ');

    try {
      // Call dashboard API to remove the song
      const response = await http.delete(
        `${dashboardBaseUrl}/api/song-queue/${encodeURIComponent(target)}`,
        { timeout: 5000 }
      );

      if (response.data && response.data.success) {
        const removedSong = response.data.removedSong;
        if (removedSong) {
          sendChatMessage(channel, `🗑️ Removed: "${removedSong.title}" by ${removedSong.channelTitle} (requested by @${removedSong.requester})`);
        } else {
          sendChatMessage(channel, `@${username} No song found matching "${target}".`);
        }
        logCommandExecution(username, '!removesong', [target], 'success');
      } else {
        sendChatMessage(channel, `@${username} ${response.data?.error || 'Failed to remove song.'}`);
        logCommandExecution(username, '!removesong', [target], 'failed');
      }
    } catch (error) {
      console.error('Remove song error:', (error as Error).message);
      sendChatMessage(channel, `@${username} Error removing song: ${(error as Error).message}`);
      logCommandExecution(username, '!removesong', [target], 'failed');
    }
  }

  /**
   * Handle clear queue command (!clearqueue) - Moderator only
   * Clears all songs from the active queue
   */
  async function handleClearQueue(channel: string, username: string, msg: ChatMessage): Promise<void> {
    // Check if we have YouTube API key configured
    if (!YOUTUBE_API_KEY) {
      sendChatMessage(channel, `@${username} Song requests are not configured.`);
      return;
    }

    // Check mod permission
    if (!checkModPermission(msg, channel, username)) {
      sendChatMessage(channel, `@${username} Only moderators can clear the queue.`);
      logCommandExecution(username, '!clearqueue', [], 'failed');
      return;
    }

    try {
      // Call dashboard API to clear the queue
      const response = await http.post(
        `${dashboardBaseUrl}/api/song-queue/clear`,
        {},
        { timeout: 5000 }
      );

      if (response.data && response.data.success) {
        const count = response.data.clearedCount || 0;
        if (count > 0) {
          sendChatMessage(channel, `🗑️ Cleared ${count} song${count !== 1 ? 's' : ''} from the queue.`);
        } else {
          sendChatMessage(channel, `@${username} Queue is already empty.`);
        }
        logCommandExecution(username, '!clearqueue', [], 'success');
      } else {
        sendChatMessage(channel, `@${username} ${response.data?.error || 'Failed to clear queue.'}`);
        logCommandExecution(username, '!clearqueue', [], 'failed');
      }
    } catch (error) {
      console.error('Clear queue error:', (error as Error).message);
      sendChatMessage(channel, `@${username} Error clearing queue: ${(error as Error).message}`);
      logCommandExecution(username, '!clearqueue', [], 'failed');
    }
  }

  /**
   * Handle block song command (!blocksong) - Moderator only
   * Blocks a video, channel, or keyword from being requested
   */
  async function handleBlockSong(channel: string, username: string, args: string[]): Promise<void> {
    // Check if we have YouTube API key configured
    if (!YOUTUBE_API_KEY) {
      sendChatMessage(channel, `@${username} Song requests are not configured.`);
      return;
    }

    if (!args || args.length === 0) {
      sendChatMessage(channel, `@${username} Usage: !blocksong <url|channel|keyword>`);
      logCommandExecution(username, '!blocksong', [], 'failed');
      return;
    }

    const input = args.join(' ');

    try {
      // A channel URL, a video URL, or a keyword
      const target = await resolveBlockTarget(input);
      if (!target) {
        sendChatMessage(channel, `@${username} Could not find that YouTube channel.`);
        logCommandExecution(username, '!blocksong', [input], 'failed');
        return;
      }

      // Call dashboard API to add to blocklist
      const response = await http.post(
        `${dashboardBaseUrl}/api/song-queue/block`,
        {
          type: target.type,
          value: target.value
        },
        { timeout: 5000 }
      );

      if (response.data && response.data.success) {
        const { type, value, removedCount } = response.data;
        let message = '';

        if (type === 'video') {
          message = `🚫 Blocked video: ${value}`;
        } else if (type === 'channel') {
          message = `🚫 Blocked channel: ${value}`;
        } else {
          message = `🚫 Blocked keyword: "${value}"`;
        }

        if (removedCount > 0) {
          message += ` (removed ${removedCount} song${removedCount !== 1 ? 's' : ''} from queue)`;
        }

        sendChatMessage(channel, message);
        logCommandExecution(username, '!blocksong', [input], 'success');
      } else {
        sendChatMessage(channel, `@${username} ${response.data?.error || 'Failed to block.'}`);
        logCommandExecution(username, '!blocksong', [input], 'failed');
      }
    } catch (error) {
      console.error('Block song error:', (error as Error).message);
      sendChatMessage(channel, `@${username} Error blocking: ${dashboardErrorMessage(error)}`);
      logCommandExecution(username, '!blocksong', [input], 'failed');
    }
  }

  /**
   * Handle unblock song command (!unblocksong) - Moderator only
   * Removes a video, channel, or keyword from the blocklist
   */
  async function handleUnblockSong(channel: string, username: string, args: string[]): Promise<void> {
    // Check if we have YouTube API key configured
    if (!YOUTUBE_API_KEY) {
      sendChatMessage(channel, `@${username} Song requests are not configured.`);
      return;
    }

    if (!args || args.length === 0) {
      sendChatMessage(channel, `@${username} Usage: !unblocksong <id|keyword>`);
      logCommandExecution(username, '!unblocksong', [], 'failed');
      return;
    }

    const identifier = args.join(' ');

    try {
      // Accept the same URLs as !blocksong: unblock by the id they were blocked under
      const target = await resolveBlockTarget(identifier);
      if (!target) {
        sendChatMessage(channel, `@${username} Could not find that YouTube channel.`);
        logCommandExecution(username, '!unblocksong', [identifier], 'failed');
        return;
      }
      const blockedValue = target.value;

      // Call dashboard API to remove from blocklist
      const response = await http.delete(
        `${dashboardBaseUrl}/api/song-queue/block/${encodeURIComponent(blockedValue)}`,
        { timeout: 5000 }
      );

      if (response.data && response.data.success) {
        const { type, value } = response.data;
        let message = '';

        if (type === 'video') {
          message = `✅ Unblocked video: ${value}`;
        } else if (type === 'channel') {
          message = `✅ Unblocked channel: ${value}`;
        } else {
          message = `✅ Unblocked keyword: "${value}"`;
        }

        sendChatMessage(channel, message);
        logCommandExecution(username, '!unblocksong', [identifier], 'success');
      } else {
        sendChatMessage(channel, `@${username} ${response.data?.error || 'Failed to unblock.'}`);
        logCommandExecution(username, '!unblocksong', [identifier], 'failed');
      }
    } catch (error) {
      console.error('Unblock song error:', (error as Error).message);
      sendChatMessage(channel, `@${username} Error unblocking: ${dashboardErrorMessage(error)}`);
      logCommandExecution(username, '!unblocksong', [identifier], 'failed');
    }
  }

  async function handleSongRequestConfig(channel: string, username: string, msg: ChatMessage, args: string[]): Promise<void> {
    // Check if we have YouTube API key configured
    if (!YOUTUBE_API_KEY) {
      sendChatMessage(channel, `@${username} Song requests are not configured.`);
      return;
    }

    // Check mod permission
    if (!checkModPermission(msg, channel, username)) {
      sendChatMessage(channel, `@${username} Only moderators can configure song requests.`);
      logCommandExecution(username, '!sr config', args, 'failed');
      return;
    }

    // Parse: !sr config <setting> <value>
    if (args.length < 2) {
      sendChatMessage(channel, `@${username} Usage: !sr config <setting> <value> | Settings: enabled, cost, maxduration, maxperuser, duplicates, priority`);
      return;
    }

    const setting = args[0].toLowerCase();
    const valueStr = args.slice(1).join(' ');

    // Validate setting name and convert value
    const validSettings: Record<string, (val: string) => SettingValue> = {
      enabled: (val) => {
        const lower = val.toLowerCase();
        if (lower === 'on' || lower === 'true' || lower === 'yes' || lower === '1') return true;
        if (lower === 'off' || lower === 'false' || lower === 'no' || lower === '0') return false;
        throw new Error('Value must be on/off, true/false, yes/no, or 1/0');
      },
      cost: (val) => {
        if (!/^\d+$/.test(val)) throw new Error('Value must be a non-negative integer');
        const num = parseInt(val, 10);
        if (num < 0) throw new Error('Value must be a non-negative number');
        return num;
      },
      maxduration: (val) => {
        if (!/^\d+$/.test(val)) throw new Error('Value must be a positive integer (minutes)');
        const num = parseInt(val, 10);
        if (num < 1) throw new Error('Value must be a positive number (minutes)');
        return num * 60; // Convert minutes to seconds
      },
      maxperuser: (val) => {
        if (!/^\d+$/.test(val)) throw new Error('Value must be a positive integer');
        const num = parseInt(val, 10);
        if (num < 1) throw new Error('Value must be a positive number');
        return num;
      },
      duplicates: (val) => {
        const lower = val.toLowerCase();
        if (lower === 'on' || lower === 'true' || lower === 'yes' || lower === '1') return true;
        if (lower === 'off' || lower === 'false' || lower === 'no' || lower === '0') return false;
        throw new Error('Value must be on/off, true/false, yes/no, or 1/0');
      },
      priority: (val) => {
        const lower = val.toLowerCase();
        if (!['everyone', 'subs', 'vips'].includes(lower)) {
          throw new Error('Value must be everyone, subs, or vips');
        }
        return lower;
      }
    };

    // Only the listed settings: a plain lookup would also accept "constructor" or "__proto__"
    if (!CONFIG_SETTINGS.includes(setting)) {
      sendChatMessage(channel, `@${username} Invalid setting. Valid settings: enabled, cost, maxduration, maxperuser, duplicates, priority`);
      return;
    }

    try {
      // Convert and validate value
      const convertedValue = validSettings[setting](valueStr);

      // Build config update object
      const configUpdate: Record<string, SettingValue> = { [setting]: convertedValue };

      // Special handling for duplicates -> allowDuplicates
      if (setting === 'duplicates') {
        delete configUpdate.duplicates;
        configUpdate.allowDuplicates = convertedValue;
      }

      // Special handling for maxduration -> maxDuration
      if (setting === 'maxduration') {
        delete configUpdate.maxduration;
        configUpdate.maxDuration = convertedValue;
      }

      // Special handling for maxperuser -> maxPerUser
      if (setting === 'maxperuser') {
        delete configUpdate.maxperuser;
        configUpdate.maxPerUser = convertedValue;
      }

      // Call dashboard API to update config
      const response = await http.put(
        `${dashboardBaseUrl}/api/song-queue/config`,
        configUpdate,
        { timeout: 5000 }
      );

      if (response.data && response.data.success) {
        // Format user-friendly response
        let displayValue: SettingValue = convertedValue;
        if (setting === 'maxduration') {
          displayValue = `${Math.floor((convertedValue as number) / 60)} minutes`;
        } else if (typeof convertedValue === 'boolean') {
          displayValue = convertedValue ? 'on' : 'off';
        }

        sendChatMessage(channel, `✓ Song request ${setting} set to: ${displayValue}`);
        logCommandExecution(username, '!sr config', args, 'success');
      } else {
        sendChatMessage(channel, `@${username} ${response.data?.error || 'Failed to update config.'}`);
        logCommandExecution(username, '!sr config', args, 'failed');
      }
    } catch (error) {
      console.error('Song request config error:', (error as Error).message);
      if ((error as Error).message.includes('must be')) {
        sendChatMessage(channel, `@${username} ${(error as Error).message}`);
      } else {
        sendChatMessage(channel, `@${username} Error updating config: ${(error as Error).message}`);
      }
      logCommandExecution(username, '!sr config', args, 'failed');
    }
  }

  return {
    getSongQueueConfig, addSongToQueue, getSongQueue,
    handleSongRequest, handleCurrentSong, handleQueueInfo, handleSkipSong, handleRemoveSong,
    handleClearQueue, handleBlockSong, handleUnblockSong, handleSongRequestConfig
  };
}
