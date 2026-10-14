/**
 * Dashboard API Routes for Song Request Queue System
 */

import express, { type RequestHandler, type Router } from 'express';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as crypto from 'crypto';
import { withCrossProcessLock, writeFileAtomic } from '../../lib/file-lock';
import { deductPoints, refundPoints } from '../lib/loyalty-store';
import type { BroadcastMessage } from '../lib/types';

/** Who may request songs */
export type SongQueuePriority = 'everyone' | 'subs' | 'vips';

/** song-queue.json config block */
export interface SongQueueConfig {
  enabled: boolean;
  cost: number;
  /** Seconds */
  maxDuration: number;
  maxPerUser: number;
  allowDuplicates: boolean;
  priority: SongQueuePriority;
  [key: string]: unknown;
}

/** A queued song */
export interface QueuedSong {
  id: string;
  videoId: string;
  title: string;
  channelTitle: string;
  channelId: string;
  durationSeconds?: number;
  durationFormatted?: string;
  thumbnail: string;
  requester: string;
  requesterDisplayName: string;
  addedAt: string;
  position: number;
  pointsCost: number;
  [key: string]: unknown;
}

/** A song moved to history (skipped, removed, blocked or cleared) */
export interface SongHistoryEntry extends QueuedSong {
  action: 'skipped' | 'removed' | 'blocked' | 'cleared';
  skippedAt?: string;
  removedAt?: string;
  blockedAt?: string;
  clearedAt?: string;
  blockType?: string;
  blockValue?: string;
}

/** Shape of song-queue.json */
export interface SongQueueData {
  active: QueuedSong[];
  history?: SongHistoryEntry[];
  config: SongQueueConfig;
  savedAt?: string;
  [key: string]: unknown;
}

/** Shape of song-blocklist.json */
export interface SongBlocklist {
  videos: string[];
  channels: string[];
  keywords: string[];
  savedAt?: string;
  [key: string]: unknown;
}

/** The part of dashboard state the router uses (optional: no broadcasts without it) */
export interface SongQueueBroadcaster {
  broadcastState?: (data: BroadcastMessage) => void;
}

/** POST /add body */
interface AddSongBody {
  videoId?: string;
  title?: string;
  channelTitle?: string;
  channelId?: string;
  durationSeconds?: number;
  durationFormatted?: string;
  thumbnail?: string;
  requester?: string;
  requesterDisplayName?: string;
  requesterIsSub?: boolean;
  requesterIsVip?: boolean;
  requesterIsMod?: boolean;
  requesterIsBroadcaster?: boolean;
}

/**
 * Build the /api/song-queue router for the song-queue.json, song-blocklist.json
 * and loyalty.json in `logsDir`. Updates are broadcast through `state`;
 * `onLoyaltyChange` is called after a charge or refund changed loyalty points.
 */
export function createSongQueueRouter(
  logsDir: string,
  state?: SongQueueBroadcaster | null,
  onLoyaltyChange?: () => void
): Router {
  const router = express.Router();
  const queueFile = path.join(logsDir, 'song-queue.json');
  const blocklistFile = path.join(logsDir, 'song-blocklist.json');
  const loyaltyFile = path.join(logsDir, 'loyalty.json');

  // Initialize queue file if needed
  const initQueueFile = async (): Promise<void> => {
    try {
      await fs.access(queueFile);
    } catch {
      await fs.writeFile(queueFile, JSON.stringify({
        active: [],
        history: [],
        config: {
          enabled: true,
          cost: 0,
          maxDuration: 600, // 10 minutes in seconds
          maxPerUser: 3,
          allowDuplicates: false,
          priority: 'everyone' // 'everyone', 'subs', 'vips'
        },
        savedAt: new Date().toISOString()
      }, null, 2));
    }
  };

  // Initialize blocklist file if needed
  const initBlocklistFile = async (): Promise<void> => {
    try {
      await fs.access(blocklistFile);
    } catch {
      await fs.writeFile(blocklistFile, JSON.stringify({
        videos: [],
        channels: [],
        keywords: [],
        savedAt: new Date().toISOString()
      }, null, 2));
    }
  };

  // Read queue data
  const readQueueData = async (): Promise<SongQueueData> => {
    await initQueueFile();
    const content = await fs.readFile(queueFile, 'utf-8');
    return JSON.parse(content) as SongQueueData;
  };

  // Write queue data atomically (write routes hold the file's lock, see locked())
  const writeQueueData = async (data: SongQueueData): Promise<void> => {
    data.savedAt = new Date().toISOString();
    await writeFileAtomic(queueFile, JSON.stringify(data, null, 2));
  };

  // Read blocklist data
  const readBlocklistData = async (): Promise<SongBlocklist> => {
    await initBlocklistFile();
    const content = await fs.readFile(blocklistFile, 'utf-8');
    return JSON.parse(content) as SongBlocklist;
  };

  // Write blocklist data atomically (write routes hold the file's lock, see locked())
  const writeBlocklistData = async (data: SongBlocklist): Promise<void> => {
    data.savedAt = new Date().toISOString();
    await writeFileAtomic(blocklistFile, JSON.stringify(data, null, 2));
  };

  // Refund a song's points (no-op without loyalty.json) and report the change
  const refund = async (username: string, amount: number, reason: string): Promise<void> => {
    await refundPoints(loyaltyFile, username, amount, reason);
    onLoyaltyChange?.();
  };

  /**
   * Run a write route while holding the cross-process locks of `files` (taken in
   * the order given), so concurrent requests cannot interleave their
   * read-modify-write cycles and lose updates.
   */
  const locked = (files: string[], handler: RequestHandler): RequestHandler => (req, res, next) => {
    const run = files.reduceRight<() => Promise<unknown>>(
      (inner, file) => () => withCrossProcessLock(file, inner),
      async () => handler(req, res, next)
    );
    run().catch(next);
  };

  // GET /api/song-queue - Get current queue
  router.get('/', async (req, res, next) => {
    try {
      const data = await readQueueData();
      res.json(data);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/song-queue/config - Get configuration
  router.get('/config', async (req, res, next) => {
    try {
      const data = await readQueueData();
      res.json(data.config || {});
    } catch (error) {
      next(error);
    }
  });

  // GET /api/song-queue/blocklist - Get blocked videos, channels and keywords
  router.get('/blocklist', async (req, res, next) => {
    try {
      const data = await readBlocklistData();
      res.json({ videos: data.videos || [], channels: data.channels || [], keywords: data.keywords || [] });
    } catch (error) {
      next(error);
    }
  });

  // PUT /api/song-queue/config - Update configuration
  router.put('/config', locked([queueFile], async (req, res, next) => {
    try {
      const updates = req.body as Record<string, unknown>;

      // Validate incoming config values
      const validKeys = ['enabled', 'cost', 'maxDuration', 'maxPerUser', 'allowDuplicates', 'priority'];
      const invalidKeys = Object.keys(updates).filter(k => !validKeys.includes(k));

      if (invalidKeys.length > 0) {
        res.status(400).json({
          success: false,
          error: `Invalid config keys: ${invalidKeys.join(', ')}`
        });
        return;
      }

      // Validate types and values
      if (updates.enabled !== undefined && typeof updates.enabled !== 'boolean') {
        res.status(400).json({ success: false, error: 'enabled must be a boolean' });
        return;
      }
      if (updates.cost !== undefined && (typeof updates.cost !== 'number' || updates.cost < 0)) {
        res.status(400).json({ success: false, error: 'cost must be a non-negative number' });
        return;
      }
      if (updates.maxDuration !== undefined && (typeof updates.maxDuration !== 'number' || updates.maxDuration < 1)) {
        res.status(400).json({ success: false, error: 'maxDuration must be a positive number' });
        return;
      }
      if (updates.maxPerUser !== undefined && (typeof updates.maxPerUser !== 'number' || updates.maxPerUser < 1)) {
        res.status(400).json({ success: false, error: 'maxPerUser must be a positive number' });
        return;
      }
      if (updates.allowDuplicates !== undefined && typeof updates.allowDuplicates !== 'boolean') {
        res.status(400).json({ success: false, error: 'allowDuplicates must be a boolean' });
        return;
      }
      if (updates.priority !== undefined && !['everyone', 'subs', 'vips'].includes(updates.priority as string)) {
        res.status(400).json({ success: false, error: 'priority must be everyone, subs, or vips' });
        return;
      }

      // Read current data, merge config, and save
      const queueData = await readQueueData();
      queueData.config = {
        ...queueData.config,
        ...updates
      };

      await writeQueueData(queueData);

      // Broadcast config update via WebSocket
      if (state && state.broadcastState) {
        state.broadcastState({
          type: 'song-queue-config-update',
          data: queueData.config
        });
      }

      res.json({
        success: true,
        config: queueData.config
      });
    } catch (error) {
      next(error);
    }
  }));

  // POST /api/song-queue/add - Add song to queue
  router.post('/add', locked([queueFile], async (req, res, next) => {
    try {
      const {
        videoId,
        title,
        channelTitle,
        channelId,
        durationSeconds,
        durationFormatted,
        thumbnail,
        requester,
        requesterDisplayName,
        requesterIsSub,
        requesterIsVip,
        requesterIsMod,
        requesterIsBroadcaster
      } = req.body as AddSongBody;

      // Validate required fields
      if (!videoId || !title || !requester) {
        res.status(400).json({ error: 'Missing required fields: videoId, title, requester' });
        return;
      }

      const queueData = await readQueueData();
      const config = queueData.config;

      // Check if song requests are enabled
      if (!config.enabled) {
        res.status(403).json({ error: 'Song requests are currently disabled.' });
        return;
      }

      // Check priority/restriction
      if (config.priority === 'subs' && !requesterIsSub && !requesterIsMod && !requesterIsBroadcaster) {
        res.status(403).json({ error: 'Song requests are restricted to subscribers only.' });
        return;
      }
      if (config.priority === 'vips' && !requesterIsVip && !requesterIsMod && !requesterIsBroadcaster) {
        res.status(403).json({ error: 'Song requests are restricted to VIPs only.' });
        return;
      }

      // Check duration limit (a song of unknown length cannot be checked, so it is refused)
      if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds < 0) {
        res.status(400).json({ error: 'Missing or invalid durationSeconds' });
        return;
      }
      if (durationSeconds > config.maxDuration) {
        const maxMinutes = Math.floor(config.maxDuration / 60);
        res.status(400).json({
          error: `Song is too long. Maximum duration is ${maxMinutes} minutes.`
        });
        return;
      }

      // Check per-user limit (mods and broadcasters are exempt)
      if (!requesterIsMod && !requesterIsBroadcaster) {
        const userSongsInQueue = queueData.active.filter(song =>
          song.requester.toLowerCase() === requester.toLowerCase()
        ).length;
        if (userSongsInQueue >= config.maxPerUser) {
          res.status(400).json({
            error: `You already have ${config.maxPerUser} song(s) in the queue. Maximum per user is ${config.maxPerUser}.`
          });
          return;
        }
      }

      // Check for duplicates
      if (!config.allowDuplicates) {
        const isDuplicate = queueData.active.some(song => song.videoId === videoId);
        if (isDuplicate) {
          res.status(400).json({ error: 'This song is already in the queue.' });
          return;
        }
      }

      // Check blocklist
      const blocklist = await readBlocklistData();

      // Check video ID
      if (blocklist.videos.includes(videoId)) {
        res.status(403).json({ error: 'This video is blocked.' });
        return;
      }

      // Check channel ID
      if (channelId && blocklist.channels.includes(channelId)) {
        res.status(403).json({ error: 'Videos from this channel are blocked.' });
        return;
      }

      // Check keywords in title and channel name
      const titleLower = title.toLowerCase();
      const channelLower = (channelTitle || '').toLowerCase();
      for (const keyword of blocklist.keywords) {
        const keywordLower = keyword.toLowerCase();
        if (titleLower.includes(keywordLower) || channelLower.includes(keywordLower)) {
          res.status(403).json({ error: `Song contains blocked keyword: ${keyword}` });
          return;
        }
      }

      // Charge loyalty points if a cost is configured. Mods and the broadcaster are free,
      // and a missing loyalty.json means loyalty is not set up (free); pointsCost records
      // only what was actually deducted, so removals never refund unpaid points.
      let pointsCost = 0;
      const cost = config.cost || 0;
      if (cost > 0 && !requesterIsMod && !requesterIsBroadcaster) {
        const deductResult = await deductPoints(
          loyaltyFile,
          requester,
          cost,
          `Song request: ${title}`
        );
        if (!deductResult.success) {
          res.status(402).json({ error: deductResult.error });
          return;
        }
        if (!deductResult.notConfigured) {
          pointsCost = cost;
          onLoyaltyChange?.();
        }
      }

      // Generate unique ID
      const songId = crypto.randomBytes(8).toString('hex');

      // Create song object
      const song: QueuedSong = {
        id: songId,
        videoId,
        title,
        channelTitle: channelTitle || 'Unknown',
        channelId: channelId || '',
        durationSeconds,
        durationFormatted,
        thumbnail: thumbnail || '',
        requester,
        requesterDisplayName: requesterDisplayName || requester,
        addedAt: new Date().toISOString(),
        position: queueData.active.length + 1,
        pointsCost
      };

      // Add to queue
      queueData.active.push(song);

      // Update positions
      queueData.active.forEach((s, index) => {
        s.position = index + 1;
      });

      // Save to file
      await writeQueueData(queueData);

      // Broadcast WebSocket update
      if (state && state.broadcastState) {
        state.broadcastState({
          type: 'song-queue-update',
          data: {
            active: queueData.active,
            action: 'add',
            song
          }
        });
      }

      // Return success with position
      res.json({
        success: true,
        song,
        position: song.position,
        queueLength: queueData.active.length
      });
    } catch (error) {
      next(error);
    }
  }));

  // POST /api/song-queue/skip - Skip current song (moderator only)
  // Accepts optional body: { songId: string } — if provided, only skips when the
  // current song matches, preventing duplicate skips from multiple overlay instances.
  router.post('/skip', locked([queueFile], async (req, res, next) => {
    try {
      const queueData = await readQueueData();

      if (queueData.active.length === 0) {
        res.json({
          success: false,
          error: 'No song to skip. Queue is empty.'
        });
        return;
      }

      // If caller provided a songId, verify it still matches the current (first) song.
      // This prevents a race where multiple overlay instances each call skip on end,
      // causing the queue to advance more than once.
      const { songId } = (req.body || {}) as { songId?: string };
      if (songId && queueData.active[0].id !== songId) {
        res.json({
          success: false,
          error: 'Song already skipped.'
        });
        return;
      }

      // Remove the first song (currently playing)
      const skippedSong = queueData.active.shift() as QueuedSong;

      // Update positions for remaining songs
      queueData.active.forEach((s, index) => {
        s.position = index + 1;
      });

      // Move skipped song to history
      if (!queueData.history) {
        queueData.history = [];
      }
      queueData.history.unshift({
        ...skippedSong,
        skippedAt: new Date().toISOString(),
        action: 'skipped'
      });

      // Keep history limited to last 100 songs
      if (queueData.history.length > 100) {
        queueData.history = queueData.history.slice(0, 100);
      }

      // Save to file
      await writeQueueData(queueData);

      // Broadcast WebSocket update
      if (state && state.broadcastState) {
        state.broadcastState({
          type: 'song-queue-update',
          data: {
            active: queueData.active,
            action: 'skip',
            skippedSong
          }
        });
      }

      res.json({
        success: true,
        skippedSong,
        queueLength: queueData.active.length
      });
    } catch (error) {
      next(error);
    }
  }));

  // DELETE /api/song-queue/block/:id - Remove from blocklist (moderator only)
  // :id can be a video ID, channel ID, or keyword text
  router.delete('/block/:id', locked([blocklistFile], async (req, res, next) => {
    try {
      // Express has already URL-decoded the param (decoding again breaks "100%")
      const identifier = (req.params.id as string).trim();

      if (!identifier) {
        res.status(400).json({ success: false, error: 'Identifier cannot be empty' });
        return;
      }

      const blocklist = await readBlocklistData();
      const identifierLower = identifier.toLowerCase();

      let removedType: 'video' | 'channel' | 'keyword' | null = null;
      let removedValue: string | null = null;

      // Check videos list first
      const videoIndex = blocklist.videos.indexOf(identifier);
      if (videoIndex !== -1) {
        blocklist.videos.splice(videoIndex, 1);
        removedType = 'video';
        removedValue = identifier;
      }

      // Check channels list
      if (!removedType) {
        const channelIndex = blocklist.channels.indexOf(identifier);
        if (channelIndex !== -1) {
          blocklist.channels.splice(channelIndex, 1);
          removedType = 'channel';
          removedValue = identifier;
        }
      }

      // Check keywords list (case-insensitive)
      if (!removedType) {
        const keywordIndex = blocklist.keywords.findIndex(k => k.toLowerCase() === identifierLower);
        if (keywordIndex !== -1) {
          removedValue = blocklist.keywords[keywordIndex];
          blocklist.keywords.splice(keywordIndex, 1);
          removedType = 'keyword';
        }
      }

      if (!removedType) {
        res.json({
          success: false,
          error: `"${identifier}" not found in blocklist.`
        });
        return;
      }

      await writeBlocklistData(blocklist);

      // Broadcast blocklist update
      if (state && state.broadcastState) {
        state.broadcastState({
          type: 'song-queue-blocklist-update',
          data: { action: 'remove', blockType: removedType, value: removedValue }
        });
      }

      res.json({
        success: true,
        type: removedType,
        value: removedValue
      });
    } catch (error) {
      next(error);
    }
  }));

  // DELETE /api/song-queue/:target - Remove song by position or keyword (moderator only)
  router.delete('/:target', locked([queueFile], async (req, res, next) => {
    try {
      const target = req.params.target as string;
      const queueData = await readQueueData();

      if (queueData.active.length === 0) {
        res.json({
          success: false,
          error: 'Queue is empty.'
        });
        return;
      }

      let removedSong: QueuedSong | null = null;
      let removedIndex = -1;

      // Check if target is a strict integer position (reject mixed strings like "2pac")
      const position = /^\d+$/.test(target) ? parseInt(target, 10) : NaN;
      if (!isNaN(position) && position >= 1 && position <= queueData.active.length) {
        // Remove by position
        removedIndex = position - 1;
        removedSong = queueData.active[removedIndex];
      } else {
        // Remove by keyword (search in title or channel)
        const keyword = target.toLowerCase();
        removedIndex = queueData.active.findIndex(song =>
          song.title.toLowerCase().includes(keyword) ||
          song.channelTitle.toLowerCase().includes(keyword)
        );

        if (removedIndex !== -1) {
          removedSong = queueData.active[removedIndex];
        }
      }

      if (!removedSong) {
        res.json({
          success: false,
          error: `No song found matching "${target}".`
        });
        return;
      }

      // Remove the song
      queueData.active.splice(removedIndex, 1);

      // Update positions
      queueData.active.forEach((s, index) => {
        s.position = index + 1;
      });

      // Move removed song to history
      if (!queueData.history) {
        queueData.history = [];
      }
      queueData.history.unshift({
        ...removedSong,
        removedAt: new Date().toISOString(),
        action: 'removed'
      });

      // Keep history limited to last 100 songs
      if (queueData.history.length > 100) {
        queueData.history = queueData.history.slice(0, 100);
      }

      // Save to file
      await writeQueueData(queueData);

      // Refund loyalty points to requester
      if (removedSong.pointsCost > 0) {
        await refund(
          removedSong.requester,
          removedSong.pointsCost,
          `Song request removed: ${removedSong.title}`
        );
      }

      // Broadcast WebSocket update
      if (state && state.broadcastState) {
        state.broadcastState({
          type: 'song-queue-update',
          data: {
            active: queueData.active,
            action: 'remove',
            removedSong
          }
        });
      }

      res.json({
        success: true,
        removedSong,
        queueLength: queueData.active.length
      });
    } catch (error) {
      next(error);
    }
  }));

  // POST /api/song-queue/block - Add to blocklist (moderator only)
  // Body: { type: 'video'|'channel'|'keyword', value: string }
  // If type is 'video', value is a video ID; 'channel' for channel ID; 'keyword' for text
  router.post('/block', locked([blocklistFile, queueFile], async (req, res, next) => {
    try {
      const { type, value } = req.body as { type?: string; value?: string };

      if (!type || !value) {
        res.status(400).json({ success: false, error: 'Missing required fields: type, value' });
        return;
      }

      const validTypes = ['video', 'channel', 'keyword'];
      if (!validTypes.includes(type)) {
        res.status(400).json({ success: false, error: 'type must be video, channel, or keyword' });
        return;
      }

      const normalizedValue = value.trim();
      if (!normalizedValue) {
        res.status(400).json({ success: false, error: 'value cannot be empty' });
        return;
      }

      const blocklist = await readBlocklistData();

      // Check if already blocked
      if (type === 'video' && blocklist.videos.includes(normalizedValue)) {
        res.status(400).json({ success: false, error: 'Video is already blocked.' });
        return;
      }
      if (type === 'channel' && blocklist.channels.includes(normalizedValue)) {
        res.status(400).json({ success: false, error: 'Channel is already blocked.' });
        return;
      }
      if (type === 'keyword') {
        const keywordLower = normalizedValue.toLowerCase();
        if (blocklist.keywords.some(k => k.toLowerCase() === keywordLower)) {
          res.status(400).json({ success: false, error: 'Keyword is already blocked.' });
          return;
        }
      }

      // Add to appropriate blocklist
      if (type === 'video') {
        blocklist.videos.push(normalizedValue);
      } else if (type === 'channel') {
        blocklist.channels.push(normalizedValue);
      } else {
        blocklist.keywords.push(normalizedValue);
      }

      await writeBlocklistData(blocklist);

      // Remove matching songs from queue
      const queueData = await readQueueData();
      const blockedAt = new Date().toISOString();
      const removedSongs: QueuedSong[] = [];

      queueData.active = queueData.active.filter(song => {
        let isBlocked = false;
        if (type === 'video' && song.videoId === normalizedValue) isBlocked = true;
        if (type === 'channel' && song.channelId === normalizedValue) isBlocked = true;
        if (type === 'keyword') {
          const keywordLower = normalizedValue.toLowerCase();
          const titleLower = (song.title || '').toLowerCase();
          const channelLower = (song.channelTitle || '').toLowerCase();
          if (titleLower.includes(keywordLower) || channelLower.includes(keywordLower)) isBlocked = true;
        }
        if (isBlocked) {
          removedSongs.push(song);
          return false;
        }
        return true;
      });

      const removedCount = removedSongs.length;

      if (removedCount > 0) {
        // Update positions for remaining songs
        queueData.active.forEach((s, index) => {
          s.position = index + 1;
        });

        // Move blocked songs to history
        if (!queueData.history) {
          queueData.history = [];
        }
        queueData.history.unshift(...removedSongs.map((song): SongHistoryEntry => ({
          ...song,
          blockedAt,
          action: 'blocked',
          blockType: type,
          blockValue: normalizedValue
        })));
        if (queueData.history.length > 100) {
          queueData.history = queueData.history.slice(0, 100);
        }

        await writeQueueData(queueData);

        // Refund loyalty points for removed songs
        for (const song of removedSongs) {
          if (song.pointsCost > 0) {
            await refund(
              song.requester,
              song.pointsCost,
              `Song blocked from queue: ${song.title}`
            );
          }
        }

        // Broadcast queue update
        if (state && state.broadcastState) {
          state.broadcastState({
            type: 'song-queue-update',
            data: {
              active: queueData.active,
              action: 'block-removed',
              blockType: type,
              blockValue: normalizedValue,
              removedCount
            }
          });
        }
      }

      // Broadcast blocklist update
      if (state && state.broadcastState) {
        state.broadcastState({
          type: 'song-queue-blocklist-update',
          data: { action: 'add', blockType: type, value: normalizedValue }
        });
      }

      res.json({
        success: true,
        type,
        value: normalizedValue,
        removedCount
      });
    } catch (error) {
      next(error);
    }
  }));

  // POST /api/song-queue/clear - Clear entire queue (moderator only)
  router.post('/clear', locked([queueFile], async (req, res, next) => {
    try {
      const queueData = await readQueueData();
      const clearedCount = queueData.active.length;

      if (clearedCount === 0) {
        res.json({
          success: true,
          clearedCount: 0,
          message: 'Queue is already empty.'
        });
        return;
      }

      // Move all songs to history
      if (!queueData.history) {
        queueData.history = [];
      }

      const clearedSongs = queueData.active.map((song): SongHistoryEntry => ({
        ...song,
        clearedAt: new Date().toISOString(),
        action: 'cleared'
      }));

      queueData.history.unshift(...clearedSongs);

      // Keep history limited to last 100 songs
      if (queueData.history.length > 100) {
        queueData.history = queueData.history.slice(0, 100);
      }

      // Clear the active queue
      queueData.active = [];

      // Save to file
      await writeQueueData(queueData);

      // Refund loyalty points for all cleared songs
      for (const song of clearedSongs) {
        if (song.pointsCost > 0) {
          await refund(
            song.requester,
            song.pointsCost,
            `Queue cleared: ${song.title}`
          );
        }
      }

      // Broadcast WebSocket update
      if (state && state.broadcastState) {
        state.broadcastState({
          type: 'song-queue-update',
          data: {
            active: [],
            action: 'clear',
            clearedCount
          }
        });
      }

      res.json({
        success: true,
        clearedCount,
        message: `Cleared ${clearedCount} song${clearedCount !== 1 ? 's' : ''} from the queue.`
      });
    } catch (error) {
      next(error);
    }
  }));

  return router;
}
