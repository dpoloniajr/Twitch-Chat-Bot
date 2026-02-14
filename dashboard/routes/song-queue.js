/**
 * Dashboard API Routes for Song Request Queue System
 */

const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const { deductPoints, refundPoints } = require('../lib/loyalty-store');

module.exports = function(logsDir, state) {
  const router = express.Router();
  const queueFile = path.join(logsDir, 'song-queue.json');
  const blocklistFile = path.join(logsDir, 'song-blocklist.json');
  const loyaltyFile = path.join(logsDir, 'loyalty.json');

  // Initialize queue file if needed
  const initQueueFile = async () => {
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
  const initBlocklistFile = async () => {
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
  const readQueueData = async () => {
    await initQueueFile();
    const content = await fs.readFile(queueFile, 'utf-8');
    return JSON.parse(content);
  };

  // Write queue data
  const writeQueueData = async (data) => {
    data.savedAt = new Date().toISOString();
    await fs.writeFile(queueFile, JSON.stringify(data, null, 2));
  };

  // Read blocklist data
  const readBlocklistData = async () => {
    await initBlocklistFile();
    const content = await fs.readFile(blocklistFile, 'utf-8');
    return JSON.parse(content);
  };

  // Write blocklist data
  const writeBlocklistData = async (data) => {
    data.savedAt = new Date().toISOString();
    await fs.writeFile(blocklistFile, JSON.stringify(data, null, 2));
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

  // PUT /api/song-queue/config - Update configuration
  router.put('/config', async (req, res, next) => {
    try {
      const updates = req.body;

      // Validate incoming config values
      const validKeys = ['enabled', 'cost', 'maxDuration', 'maxPerUser', 'allowDuplicates', 'priority'];
      const invalidKeys = Object.keys(updates).filter(k => !validKeys.includes(k));

      if (invalidKeys.length > 0) {
        return res.status(400).json({
          success: false,
          error: `Invalid config keys: ${invalidKeys.join(', ')}`
        });
      }

      // Validate types and values
      if (updates.enabled !== undefined && typeof updates.enabled !== 'boolean') {
        return res.status(400).json({ success: false, error: 'enabled must be a boolean' });
      }
      if (updates.cost !== undefined && (typeof updates.cost !== 'number' || updates.cost < 0)) {
        return res.status(400).json({ success: false, error: 'cost must be a non-negative number' });
      }
      if (updates.maxDuration !== undefined && (typeof updates.maxDuration !== 'number' || updates.maxDuration < 1)) {
        return res.status(400).json({ success: false, error: 'maxDuration must be a positive number' });
      }
      if (updates.maxPerUser !== undefined && (typeof updates.maxPerUser !== 'number' || updates.maxPerUser < 1)) {
        return res.status(400).json({ success: false, error: 'maxPerUser must be a positive number' });
      }
      if (updates.allowDuplicates !== undefined && typeof updates.allowDuplicates !== 'boolean') {
        return res.status(400).json({ success: false, error: 'allowDuplicates must be a boolean' });
      }
      if (updates.priority !== undefined && !['everyone', 'subs', 'vips'].includes(updates.priority)) {
        return res.status(400).json({ success: false, error: 'priority must be everyone, subs, or vips' });
      }

      // Read current data, merge config, and save
      const queueData = await readQueueData();
      queueData.config = {
        ...queueData.config,
        ...updates
      };

      await writeQueueData(queueData);

      // Broadcast config update via WebSocket
      if (state && state.wss) {
        state.wss.clients.forEach(client => {
          if (client.readyState === 1) { // WebSocket.OPEN
            client.send(JSON.stringify({
              type: 'song-queue-config-update',
              data: queueData.config
            }));
          }
        });
      }

      res.json({
        success: true,
        config: queueData.config
      });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/song-queue/add - Add song to queue
  router.post('/add', async (req, res, next) => {
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
      } = req.body;

      // Validate required fields
      if (!videoId || !title || !requester) {
        return res.status(400).json({ error: 'Missing required fields: videoId, title, requester' });
      }

      const queueData = await readQueueData();
      const config = queueData.config;

      // Check if song requests are enabled
      if (!config.enabled) {
        return res.status(403).json({ error: 'Song requests are currently disabled.' });
      }

      // Check priority/restriction
      if (config.priority === 'subs' && !requesterIsSub && !requesterIsMod && !requesterIsBroadcaster) {
        return res.status(403).json({ error: 'Song requests are restricted to subscribers only.' });
      }
      if (config.priority === 'vips' && !requesterIsVip && !requesterIsMod && !requesterIsBroadcaster) {
        return res.status(403).json({ error: 'Song requests are restricted to VIPs only.' });
      }

      // Check duration limit
      if (durationSeconds > config.maxDuration) {
        const maxMinutes = Math.floor(config.maxDuration / 60);
        return res.status(400).json({
          error: `Song is too long. Maximum duration is ${maxMinutes} minutes.`
        });
      }

      // Check per-user limit
      const userSongsInQueue = queueData.active.filter(song =>
        song.requester.toLowerCase() === requester.toLowerCase()
      ).length;
      if (userSongsInQueue >= config.maxPerUser) {
        return res.status(400).json({
          error: `You already have ${config.maxPerUser} song(s) in the queue. Maximum per user is ${config.maxPerUser}.`
        });
      }

      // Check for duplicates
      if (!config.allowDuplicates) {
        const isDuplicate = queueData.active.some(song => song.videoId === videoId);
        if (isDuplicate) {
          return res.status(400).json({ error: 'This song is already in the queue.' });
        }
      }

      // Check blocklist
      const blocklist = await readBlocklistData();

      // Check video ID
      if (blocklist.videos.includes(videoId)) {
        return res.status(403).json({ error: 'This video is blocked.' });
      }

      // Check channel ID
      if (channelId && blocklist.channels.includes(channelId)) {
        return res.status(403).json({ error: 'Videos from this channel are blocked.' });
      }

      // Check keywords in title and channel name
      const titleLower = title.toLowerCase();
      const channelLower = (channelTitle || '').toLowerCase();
      for (const keyword of blocklist.keywords) {
        const keywordLower = keyword.toLowerCase();
        if (titleLower.includes(keywordLower) || channelLower.includes(keywordLower)) {
          return res.status(403).json({ error: `Song contains blocked keyword: ${keyword}` });
        }
      }

      // Check loyalty points if cost is configured
      const pointsCost = config.cost || 0;
      if (pointsCost > 0 && !requesterIsMod && !requesterIsBroadcaster) {
        const deductResult = await deductPoints(
          loyaltyFile,
          requester,
          pointsCost,
          `Song request: ${title}`
        );
        if (!deductResult.success) {
          return res.status(402).json({ error: deductResult.error });
        }
      }

      // Generate unique ID
      const songId = crypto.randomBytes(8).toString('hex');

      // Create song object
      const song = {
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
  });

  // POST /api/song-queue/skip - Skip current song (moderator only)
  router.post('/skip', async (req, res, next) => {
    try {
      const queueData = await readQueueData();

      if (queueData.active.length === 0) {
        return res.json({
          success: false,
          error: 'No song to skip. Queue is empty.'
        });
      }

      // Remove the first song (currently playing)
      const skippedSong = queueData.active.shift();

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
  });

  // DELETE /api/song-queue/block/:id - Remove from blocklist (moderator only)
  // :id can be a video ID, channel ID, or keyword text
  router.delete('/block/:id', async (req, res, next) => {
    try {
      const identifier = decodeURIComponent(req.params.id).trim();

      if (!identifier) {
        return res.status(400).json({ success: false, error: 'Identifier cannot be empty' });
      }

      const blocklist = await readBlocklistData();
      const identifierLower = identifier.toLowerCase();

      let removedType = null;
      let removedValue = null;

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
        return res.json({
          success: false,
          error: `"${identifier}" not found in blocklist.`
        });
      }

      await writeBlocklistData(blocklist);

      // Broadcast blocklist update
      if (state && state.wss) {
        state.wss.clients.forEach(client => {
          if (client.readyState === 1) {
            client.send(JSON.stringify({
              type: 'song-queue-blocklist-update',
              data: { action: 'remove', blockType: removedType, value: removedValue }
            }));
          }
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
  });

  // DELETE /api/song-queue/:target - Remove song by position or keyword (moderator only)
  router.delete('/:target', async (req, res, next) => {
    try {
      const { target } = req.params;
      const queueData = await readQueueData();

      if (queueData.active.length === 0) {
        return res.json({
          success: false,
          error: 'Queue is empty.'
        });
      }

      let removedSong = null;
      let removedIndex = -1;

      // Check if target is a number (position)
      const position = parseInt(target, 10);
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
        return res.json({
          success: false,
          error: `No song found matching "${target}".`
        });
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
        await refundPoints(
          loyaltyFile,
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
  });

  // POST /api/song-queue/block - Add to blocklist (moderator only)
  // Body: { type: 'video'|'channel'|'keyword', value: string }
  // If type is 'video', value is a video ID; 'channel' for channel ID; 'keyword' for text
  router.post('/block', async (req, res, next) => {
    try {
      const { type, value } = req.body;

      if (!type || !value) {
        return res.status(400).json({ success: false, error: 'Missing required fields: type, value' });
      }

      const validTypes = ['video', 'channel', 'keyword'];
      if (!validTypes.includes(type)) {
        return res.status(400).json({ success: false, error: 'type must be video, channel, or keyword' });
      }

      const normalizedValue = value.trim();
      if (!normalizedValue) {
        return res.status(400).json({ success: false, error: 'value cannot be empty' });
      }

      const blocklist = await readBlocklistData();

      // Check if already blocked
      if (type === 'video' && blocklist.videos.includes(normalizedValue)) {
        return res.status(400).json({ success: false, error: 'Video is already blocked.' });
      }
      if (type === 'channel' && blocklist.channels.includes(normalizedValue)) {
        return res.status(400).json({ success: false, error: 'Channel is already blocked.' });
      }
      if (type === 'keyword') {
        const keywordLower = normalizedValue.toLowerCase();
        if (blocklist.keywords.some(k => k.toLowerCase() === keywordLower)) {
          return res.status(400).json({ success: false, error: 'Keyword is already blocked.' });
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
      const removedSongs = [];

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
        queueData.history.unshift(...removedSongs.map(song => ({
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
            await refundPoints(
              loyaltyFile,
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
      if (state && state.wss) {
        state.wss.clients.forEach(client => {
          if (client.readyState === 1) {
            client.send(JSON.stringify({
              type: 'song-queue-blocklist-update',
              data: { action: 'add', blockType: type, value: normalizedValue }
            }));
          }
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
  });

  // POST /api/song-queue/clear - Clear entire queue (moderator only)
  router.post('/clear', async (req, res, next) => {
    try {
      const queueData = await readQueueData();
      const clearedCount = queueData.active.length;

      if (clearedCount === 0) {
        return res.json({
          success: true,
          clearedCount: 0,
          message: 'Queue is already empty.'
        });
      }

      // Move all songs to history
      if (!queueData.history) {
        queueData.history = [];
      }

      const clearedSongs = queueData.active.map(song => ({
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
          await refundPoints(
            loyaltyFile,
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
  });

  return router;
};
