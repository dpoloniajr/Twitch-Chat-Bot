/**
 * Dashboard API Routes for Loyalty System
 */

const express = require('express');
const path = require('path');
const { readLoyaltyData, writeLoyaltyData, deductPoints, addPoints, setPoints, awardMessagePoints, processWatchTimeAwards, runGamba, runDuel, WATCH_TIME_INTERVAL_MS } = require('../lib/loyalty-store');

module.exports = function(logsDir) {
  const router = express.Router();
  const loyaltyFile = path.join(logsDir, 'loyalty.json');

  // Initialize file if needed
  const initFile = async () => {
    const data = await readLoyaltyData(loyaltyFile);
    if (!data) {
      await writeLoyaltyData(loyaltyFile, {
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
        transactions: []
      });
    }
  };

  // Read loyalty data (always initialised)
  const readData = async () => {
    await initFile();
    return readLoyaltyData(loyaltyFile);
  };

  // Write loyalty data
  const writeData = (data) => writeLoyaltyData(loyaltyFile, data);

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

      const result = await setPoints(loyaltyFile, username, points, reason);
      if (!result.success) {
        return res.status(503).json({ error: result.error });
      }
      res.json({ success: true, user: result.user });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/loyalty/deduct - Deduct points from user
  router.post('/deduct', async (req, res, next) => {
    try {
      const { username, amount, reason } = req.body;

      if (!username || typeof amount !== 'number' || amount <= 0) {
        return res.status(400).json({ error: 'username and a positive amount are required' });
      }

      const result = await deductPoints(loyaltyFile, username, amount, reason);

      if (result.notConfigured) {
        return res.status(503).json({ error: 'Loyalty system not configured' });
      }
      if (!result.success) {
        if (result.code === 'USER_NOT_FOUND') {
          return res.status(404).json({ error: 'User not found' });
        }
        return res.status(400).json({
          error: result.error,
          balance: result.balance,
          required: amount
        });
      }

      res.json({ success: true, newBalance: result.newBalance });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/loyalty/add - Add points to user
  router.post('/add', async (req, res, next) => {
    try {
      const { username, amount, reason } = req.body;

      if (!username || typeof amount !== 'number' || amount <= 0) {
        return res.status(400).json({ error: 'username and a positive amount are required' });
      }

      const result = await addPoints(loyaltyFile, username, amount, reason, 'bonus');
      if (result.notConfigured) {
        return res.status(503).json({ error: 'Loyalty system not configured' });
      }
      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }
      res.json({ success: true, newBalance: result.newBalance });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/loyalty/award-message - Award points for a chat message (cooldown & config applied)
  router.post('/award-message', async (req, res, next) => {
    try {
      const { username, isSubscriber, isVip } = req.body;
      if (!username || typeof username !== 'string') {
        return res.status(400).json({ error: 'username (string) is required' });
      }
      const result = await awardMessagePoints(loyaltyFile, username.trim(), !!isSubscriber, !!isVip);
      if (result.notConfigured) {
        return res.status(503).json({ error: 'Loyalty system not configured' });
      }
      res.json({
        pointsEarned: result.pointsEarned ?? 0,
        newBalance: result.newBalance ?? 0,
        onCooldown: result.onCooldown ?? false
      });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/loyalty/gamba - Gamble points (50% win = 2x, 50% lose)
  router.post('/gamba', async (req, res, next) => {
    try {
      const { username, amount } = req.body;
      if (!username || typeof username !== 'string') {
        return res.status(400).json({ error: 'username (string) is required' });
      }
      let bet = amount;
      if (bet !== 'all' && String(bet).toLowerCase() !== 'all') {
        bet = parseInt(Number(bet), 10);
        if (!Number.isFinite(bet) || bet < 1) {
          return res.status(400).json({ error: 'amount must be a positive number or "all".' });
        }
      }
      const result = await runGamba(loyaltyFile, username.trim(), bet);
      if (result.notConfigured) {
        return res.status(503).json({ error: 'Loyalty system not configured' });
      }
      if (!result.success) {
        if (result.code === 'USER_NOT_FOUND') {
          return res.status(404).json({ error: result.error });
        }
        return res.status(400).json({ error: result.error, balance: result.balance });
      }
      res.json({
        success: true,
        won: result.won,
        newBalance: result.newBalance,
        amountBet: result.amountBet,
        winnings: result.winnings ?? 0
      });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/loyalty/duel - Duel two users; winner takes both stakes
  router.post('/duel', async (req, res, next) => {
    try {
      const { challenger, opponent, stake } = req.body;
      if (!challenger || !opponent || typeof challenger !== 'string' || typeof opponent !== 'string') {
        return res.status(400).json({ error: 'challenger and opponent (strings) are required' });
      }
      const amount = Math.floor(Number(stake)) || 50;
      if (amount < 1) {
        return res.status(400).json({ error: 'stake must be at least 1.' });
      }
      const result = await runDuel(loyaltyFile, challenger.trim(), opponent.trim(), amount);
      if (result.notConfigured) {
        return res.status(503).json({ error: 'Loyalty system not configured' });
      }
      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }
      res.json({
        success: true,
        winner: result.winner,
        challengerBalance: result.challengerBalance,
        opponentBalance: result.opponentBalance
      });
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

  // Run watch-time awards every minute for users considered "present" (lastSeen within 10 min)
  setInterval(() => {
    processWatchTimeAwards(loyaltyFile).catch(err => console.error('Loyalty watch-time award error:', err));
  }, WATCH_TIME_INTERVAL_MS);

  return router;
};
