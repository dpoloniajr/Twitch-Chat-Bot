/**
 * Dashboard API Routes for Loyalty System
 */

const express = require('express');
const path = require('path');
const fs = require('fs').promises;

module.exports = function(logsDir) {
  const router = express.Router();
  const loyaltyFile = path.join(logsDir, 'loyalty.json');

  // Initialize file if needed
  const initFile = async () => {
    try {
      await fs.access(loyaltyFile);
    } catch {
      await fs.writeFile(loyaltyFile, JSON.stringify({
        users: {},
        config: {
          pointsPerMinute: 10,
          pointsPerMessage: 5,
          subscriberMultiplier: 2,
          vipMultiplier: 1.5,
          maxPointsPerMessage: 50,
          messageCooldownSeconds: 30,
          currencyName: 'point',
          currencyNamePlural: 'points',
          pointsPerLevel: 1000,
          enabled: true
        },
        transactions: [],
        savedAt: new Date().toISOString()
      }, null, 2));
    }
  };

  // Read loyalty data
  const readData = async () => {
    await initFile();
    const content = await fs.readFile(loyaltyFile, 'utf-8');
    return JSON.parse(content);
  };

  // Write loyalty data
  const writeData = async (data) => {
    data.savedAt = new Date().toISOString();
    await fs.writeFile(loyaltyFile, JSON.stringify(data, null, 2));
  };

  // GET /api/loyalty - Get all loyalty data
  router.get('/', async (req, res, next) => {
    try {
      const data = await readData();
      res.json(data);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/loyalty/config - Get loyalty config
  router.get('/config', async (req, res, next) => {
    try {
      const data = await readData();
      res.json(data.config || {});
    } catch (error) {
      next(error);
    }
  });

  // PUT /api/loyalty/config - Update loyalty config
  router.put('/config', async (req, res, next) => {
    try {
      const data = await readData();
      data.config = { ...data.config, ...req.body };
      await writeData(data);
      res.json({ success: true, config: data.config });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/loyalty/leaderboard - Get leaderboard
  router.get('/leaderboard', async (req, res, next) => {
    try {
      const limit = parseInt(req.query.limit) || 10;
      const data = await readData();

      const leaderboard = Object.entries(data.users || {})
        .map(([username, userData]) => ({
          username,
          points: userData.points || 0,
          level: userData.level || 1,
          watchTimeMinutes: userData.watchTimeMinutes || 0
        }))
        .sort((a, b) => b.points - a.points)
        .slice(0, limit)
        .map((entry, index) => ({ ...entry, rank: index + 1 }));

      res.json(leaderboard);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/loyalty/user/:username - Get user data
  router.get('/user/:username', async (req, res, next) => {
    try {
      const { username } = req.params;
      const data = await readData();
      const userData = data.users?.[username.toLowerCase()];

      if (!userData) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Calculate rank
      const sorted = Object.entries(data.users)
        .sort((a, b) => (b[1].points || 0) - (a[1].points || 0));
      const rank = sorted.findIndex(([name]) => name === username.toLowerCase()) + 1;

      res.json({ ...userData, username: username.toLowerCase(), rank });
    } catch (error) {
      next(error);
    }
  });

  // PUT /api/loyalty/user/:username/points - Set user points (admin)
  router.put('/user/:username/points', async (req, res, next) => {
    try {
      const { username } = req.params;
      const { points, reason } = req.body;

      if (typeof points !== 'number') {
        return res.status(400).json({ error: 'Points must be a number' });
      }

      const data = await readData();
      const normalizedUsername = username.toLowerCase();

      if (!data.users) data.users = {};
      if (!data.users[normalizedUsername]) {
        data.users[normalizedUsername] = {
          points: 0,
          totalEarned: 0,
          totalSpent: 0,
          watchTimeMinutes: 0,
          messageCount: 0,
          lastSeen: new Date().toISOString(),
          firstSeen: new Date().toISOString(),
          level: 1
        };
      }

      const oldPoints = data.users[normalizedUsername].points;
      data.users[normalizedUsername].points = Math.max(0, points);

      // Record transaction
      if (!data.transactions) data.transactions = [];
      data.transactions.push({
        username: normalizedUsername,
        amount: points - oldPoints,
        type: 'admin',
        reason: reason || 'Admin adjustment',
        timestamp: new Date().toISOString(),
        balance: data.users[normalizedUsername].points
      });

      // Trim transactions
      if (data.transactions.length > 2000) {
        data.transactions = data.transactions.slice(-1000);
      }

      await writeData(data);
      res.json({ success: true, user: data.users[normalizedUsername] });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/loyalty/transactions - Get recent transactions
  router.get('/transactions', async (req, res, next) => {
    try {
      const limit = parseInt(req.query.limit) || 50;
      const username = req.query.username?.toLowerCase();
      const data = await readData();

      let transactions = data.transactions || [];
      if (username) {
        transactions = transactions.filter(t => t.username === username);
      }

      res.json(transactions.slice(-limit).reverse());
    } catch (error) {
      next(error);
    }
  });

  // GET /api/loyalty/stats - Get loyalty statistics
  router.get('/stats', async (req, res, next) => {
    try {
      const data = await readData();
      const users = Object.values(data.users || {});

      const stats = {
        totalUsers: users.length,
        totalPointsInCirculation: users.reduce((sum, u) => sum + (u.points || 0), 0),
        totalPointsEarned: users.reduce((sum, u) => sum + (u.totalEarned || 0), 0),
        totalPointsSpent: users.reduce((sum, u) => sum + (u.totalSpent || 0), 0),
        averagePoints: users.length > 0
          ? Math.round(users.reduce((sum, u) => sum + (u.points || 0), 0) / users.length)
          : 0,
        averageLevel: users.length > 0
          ? Math.round(users.reduce((sum, u) => sum + (u.level || 1), 0) / users.length * 10) / 10
          : 1,
        topLevel: Math.max(...users.map(u => u.level || 1), 1)
      };

      res.json(stats);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
