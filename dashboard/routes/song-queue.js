/**
 * Dashboard API Routes for Song Request Queue System
 */

const express = require('express');
const path = require('path');
const fs = require('fs').promises;

module.exports = function(logsDir) {
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

  return router;
};
