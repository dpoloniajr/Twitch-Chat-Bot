/**
 * Dashboard API Routes for Counters System
 */

const express = require('express');
const path = require('path');
const fs = require('fs').promises;

module.exports = function(logsDir) {
  const router = express.Router();
  const countersFile = path.join(logsDir, 'counters.json');

  // Initialize file if needed
  const initFile = async () => {
    try {
      await fs.access(countersFile);
    } catch {
      const defaultCounters = {
        deaths: { name: 'deaths', value: 0, createdAt: new Date().toISOString(), createdBy: 'system', lastModifiedAt: new Date().toISOString(), lastModifiedBy: 'system', description: 'Death counter' },
        wins: { name: 'wins', value: 0, createdAt: new Date().toISOString(), createdBy: 'system', lastModifiedAt: new Date().toISOString(), lastModifiedBy: 'system', description: 'Win counter' },
        losses: { name: 'losses', value: 0, createdAt: new Date().toISOString(), createdBy: 'system', lastModifiedAt: new Date().toISOString(), lastModifiedBy: 'system', description: 'Loss counter' }
      };

      await fs.writeFile(countersFile, JSON.stringify({
        counters: defaultCounters,
        history: [],
        config: {
          maxCounters: 100,
          maxValue: 999999,
          minValue: -999999,
          keepHistory: true,
          maxHistoryEntries: 100
        },
        savedAt: new Date().toISOString()
      }, null, 2));
    }
  };

  // Read counters data
  const readData = async () => {
    await initFile();
    const content = await fs.readFile(countersFile, 'utf-8');
    return JSON.parse(content);
  };

  // Write counters data
  const writeData = async (data) => {
    data.savedAt = new Date().toISOString();
    await fs.writeFile(countersFile, JSON.stringify(data, null, 2));
  };

  // GET /api/counters - Get all counters
  router.get('/', async (req, res, next) => {
    try {
      const data = await readData();
      const counters = Object.values(data.counters || {});
      res.json(counters);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/counters/:name - Get a specific counter
  router.get('/:name', async (req, res, next) => {
    try {
      const { name } = req.params;
      const normalizedName = name.toLowerCase().trim().replace(/\s+/g, '_');
      const data = await readData();
      const counter = data.counters?.[normalizedName];

      if (!counter) {
        return res.status(404).json({ error: 'Counter not found' });
      }

      res.json(counter);
    } catch (error) {
      next(error);
    }
  });

  // POST /api/counters - Create a new counter
  router.post('/', async (req, res, next) => {
    try {
      const { name, initialValue = 0, description, createdBy = 'dashboard' } = req.body;

      if (!name) {
        return res.status(400).json({ error: 'Name is required' });
      }

      const normalizedName = name.toLowerCase().trim().replace(/\s+/g, '_');

      if (normalizedName.length < 1 || normalizedName.length > 50) {
        return res.status(400).json({ error: 'Counter name must be 1-50 characters' });
      }

      const data = await readData();
      const config = data.config || {};

      if (data.counters?.[normalizedName]) {
        return res.status(400).json({ error: `Counter "${normalizedName}" already exists` });
      }

      const counterCount = Object.keys(data.counters || {}).length;
      if (counterCount >= (config.maxCounters || 100)) {
        return res.status(400).json({ error: 'Maximum counter limit reached' });
      }

      const clampedValue = Math.max(
        config.minValue || -999999,
        Math.min(config.maxValue || 999999, initialValue)
      );

      const counter = {
        name: normalizedName,
        value: clampedValue,
        createdAt: new Date().toISOString(),
        createdBy: createdBy.toLowerCase(),
        lastModifiedAt: new Date().toISOString(),
        lastModifiedBy: createdBy.toLowerCase(),
        description: description || undefined
      };

      if (!data.counters) data.counters = {};
      data.counters[normalizedName] = counter;

      await writeData(data);
      res.status(201).json({ success: true, counter });
    } catch (error) {
      next(error);
    }
  });

  // PUT /api/counters/:name - Update counter value
  router.put('/:name', async (req, res, next) => {
    try {
      const { name } = req.params;
      const { value, modifiedBy = 'dashboard', reason } = req.body;
      const normalizedName = name.toLowerCase().trim().replace(/\s+/g, '_');

      if (typeof value !== 'number') {
        return res.status(400).json({ error: 'Value must be a number' });
      }

      const data = await readData();
      const counter = data.counters?.[normalizedName];

      if (!counter) {
        return res.status(404).json({ error: 'Counter not found' });
      }

      const config = data.config || {};
      const previousValue = counter.value;
      const clampedValue = Math.max(
        config.minValue || -999999,
        Math.min(config.maxValue || 999999, value)
      );

      counter.value = clampedValue;
      counter.lastModifiedAt = new Date().toISOString();
      counter.lastModifiedBy = modifiedBy.toLowerCase();

      // Record history
      if (config.keepHistory !== false) {
        if (!data.history) data.history = [];
        data.history.push({
          counterName: normalizedName,
          previousValue,
          newValue: clampedValue,
          change: clampedValue - previousValue,
          modifiedBy: modifiedBy.toLowerCase(),
          timestamp: new Date().toISOString(),
          reason: reason || undefined
        });

        // Trim history
        const maxHistory = (config.maxHistoryEntries || 100) * Object.keys(data.counters).length;
        if (data.history.length > maxHistory * 2) {
          data.history = data.history.slice(-maxHistory);
        }
      }

      await writeData(data);
      res.json({ success: true, counter });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/counters/:name/increment - Increment counter
  router.post('/:name/increment', async (req, res, next) => {
    try {
      const { name } = req.params;
      const { amount = 1, reason } = req.body;
      const normalizedName = name.toLowerCase().trim().replace(/\s+/g, '_');

      const data = await readData();
      const counter = data.counters?.[normalizedName];

      if (!counter) {
        return res.status(404).json({ error: 'Counter not found' });
      }

      req.body.value = counter.value + amount;
      req.body.reason = reason || `+${amount}`;

      // Forward to PUT handler
      return router.handle({ ...req, method: 'PUT' }, res, next);
    } catch (error) {
      next(error);
    }
  });

  // POST /api/counters/:name/decrement - Decrement counter
  router.post('/:name/decrement', async (req, res, next) => {
    try {
      const { name } = req.params;
      const { amount = 1, reason } = req.body;
      const normalizedName = name.toLowerCase().trim().replace(/\s+/g, '_');

      const data = await readData();
      const counter = data.counters?.[normalizedName];

      if (!counter) {
        return res.status(404).json({ error: 'Counter not found' });
      }

      req.body.value = counter.value - amount;
      req.body.reason = reason || `-${amount}`;

      // Forward to PUT handler
      return router.handle({ ...req, method: 'PUT' }, res, next);
    } catch (error) {
      next(error);
    }
  });

  // POST /api/counters/:name/reset - Reset counter to zero
  router.post('/:name/reset', async (req, res, next) => {
    try {
      const { name } = req.params;

      req.body.value = 0;
      req.body.reason = 'Reset';

      // Forward to PUT handler
      return router.handle({ ...req, method: 'PUT', params: { name } }, res, next);
    } catch (error) {
      next(error);
    }
  });

  // DELETE /api/counters/:name - Delete a counter
  router.delete('/:name', async (req, res, next) => {
    try {
      const { name } = req.params;
      const normalizedName = name.toLowerCase().trim().replace(/\s+/g, '_');

      const data = await readData();

      if (!data.counters?.[normalizedName]) {
        return res.status(404).json({ error: 'Counter not found' });
      }

      delete data.counters[normalizedName];

      // Remove history for this counter
      if (data.history) {
        data.history = data.history.filter(h => h.counterName !== normalizedName);
      }

      await writeData(data);
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/counters/:name/history - Get counter history
  router.get('/:name/history', async (req, res, next) => {
    try {
      const { name } = req.params;
      const limit = parseInt(req.query.limit) || 20;
      const normalizedName = name.toLowerCase().trim().replace(/\s+/g, '_');

      const data = await readData();
      const history = (data.history || [])
        .filter(h => h.counterName === normalizedName)
        .slice(-limit)
        .reverse();

      res.json(history);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/counters/config - Get config
  router.get('/config', async (req, res, next) => {
    try {
      const data = await readData();
      res.json(data.config || {});
    } catch (error) {
      next(error);
    }
  });

  return router;
};
