/**
 * Dashboard API Routes for Song Request Queue System
 */

const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');

module.exports = function(logsDir, state) {
  const router = express.Router();
  const queueFile = path.join(logsDir, 'song-queue.json');
  const blocklistFile = path.join(logsDir, 'song-blocklist.json');

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
        pointsCost: config.cost || 0
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

  return router;
};
