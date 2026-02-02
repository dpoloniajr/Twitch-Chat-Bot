const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const { withFileLock } = require('../lib/utils');
const state = require('../lib/state');

module.exports = function(paths) {
  const { obsConfigFile, eventSubEventsFile } = paths;

  // Helper function to handle the recent events response
  const handleRecentEventsRequest = async (req, res, eventType = 'all') => {
    try {
      const finalEventType = eventType || req.params.type?.toLowerCase() || 'all';
      const events = JSON.parse(await fs.readFile(eventSubEventsFile, 'utf8'));

      const typeMap = {
        follow: 'follow',
        subscriber: 'subscription',
        subscription: 'subscription',
        bits: 'bits',
        cheer: 'bits',
        raid: 'raid',
        redemption: 'redemption'
      };

      let filtered = events;
      if (finalEventType !== 'all') {
        const targetType = typeMap[finalEventType];
        if (!targetType) {
          return res.status(400).json({ error: 'Invalid event type' });
        }
        filtered = events.filter(e => {
          const eType = e.event || e.alertType;
          return targetType === 'subscription' ? (eType === 'subscription' || eType === 'subscriber') : eType === targetType;
        });
      }

      filtered = filtered.reverse().slice(0, 50);
      const recentEvents = filtered.map(e => ({
        type: e.event || e.alertType,
        user: e.user || e.userName || e.username,
        timestamp: e.timestamp,
        ...e
      }));

      res.json({ type: finalEventType, count: recentEvents.length, events: recentEvents });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  };

  router.get('/config', async (req, res) => {
    try {
      const data = await fs.readFile(obsConfigFile, 'utf8');
      res.json(JSON.parse(data));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/config', async (req, res) => {
    try {
      const config = req.body;
      if (!config.overlays) return res.status(400).json({ error: 'Missing overlays object' });

      await withFileLock(obsConfigFile, async () => {
        await fs.writeFile(obsConfigFile, JSON.stringify(config, null, 2));
      });
      state.broadcastState({ type: 'obsConfig', data: config });
      res.json({ success: true, config });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/recent', (req, res) => handleRecentEventsRequest(req, res, 'all'));
  router.get('/recent/:type', (req, res) => handleRecentEventsRequest(req, res));

  return router;
};
