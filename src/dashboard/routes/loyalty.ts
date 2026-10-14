/**
 * Dashboard API Routes for Loyalty System
 */

import express, { type Response, type Router } from 'express';
import * as path from 'path';
import { withCrossProcessLock } from '../../lib/file-lock';
import {
  readLoyaltyData,
  readOrInitLoyaltyData,
  writeLoyaltyData,
  buildLeaderboard,
  parseDuelStake,
  deductPoints,
  addPoints,
  setPoints,
  awardMessagePoints,
  processWatchTimeAwards,
  runGamba,
  runDuel,
  GAMBA_MIN,
  WATCH_TIME_INTERVAL_MS
} from '../lib/loyalty-store';
import type { BroadcastMessage, LoyaltyData, LoyaltyOpResult, LoyaltyUserRecord } from '../lib/types';

/** Leaderboard size sent with 'loyalty-update' broadcasts (overlays slice it to their own limit) */
export const LOYALTY_BROADCAST_LIMIT = 100;

/** The loyalty router, plus stop() to clear its watch-time timer */
export interface LoyaltyRouter extends Router {
  stop: () => void;
  /** Broadcast the current leaderboard ('loyalty-update'); for other writers of loyalty.json */
  publish: () => Promise<void>;
}

/** Numeric loyalty settings and their allowed range */
const LOYALTY_NUMBER_FIELDS: Record<string, { min: number; max: number; integer: boolean }> = {
  pointsPerMinute: { min: 0, max: 100000, integer: true },
  pointsPerMessage: { min: 0, max: 100000, integer: true },
  maxPointsPerMessage: { min: 0, max: 1000000, integer: true },
  messageCooldownSeconds: { min: 0, max: 86400, integer: true },
  pointsPerLevel: { min: 1, max: 100000000, integer: true },
  subscriberMultiplier: { min: 0, max: 100, integer: false },
  vipMultiplier: { min: 0, max: 100, integer: false }
};
const LOYALTY_TEXT_FIELDS = ['currencyName', 'currencyNamePlural'];

/**
 * Validate a PUT /config body: only known settings, each with the right type and
 * range. Returns an error message, or null when the update is valid.
 */
export function validateLoyaltyConfigUpdate(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'Body must be an object of settings';
  const entries = Object.entries(body as Record<string, unknown>);
  if (entries.length === 0) return 'No settings given';
  for (const [key, value] of entries) {
    const range = LOYALTY_NUMBER_FIELDS[key];
    if (range) {
      if (typeof value !== 'number' || !Number.isFinite(value) || (range.integer && !Number.isInteger(value))) {
        return `${key} must be ${range.integer ? 'a whole number' : 'a number'}`;
      }
      if (value < range.min || value > range.max) return `${key} must be between ${range.min} and ${range.max}`;
    } else if (LOYALTY_TEXT_FIELDS.includes(key)) {
      if (typeof value !== 'string' || value.trim() === '' || value.length > 30) return `${key} must be 1-30 characters`;
    } else if (key === 'enabled') {
      if (typeof value !== 'boolean') return 'enabled must be true or false';
    } else {
      return `Unknown loyalty setting: ${key}`;
    }
  }
  return null;
}

/**
 * Middleware to handle common loyalty operation response patterns
 * @param result - Result object from loyalty-store functions
 * @param res - Express response object
 * @param successData - Additional data to include in successful response
 * @returns True if handled, false if not
 */
function handleLoyaltyResult(result: LoyaltyOpResult, res: Response, successData: Record<string, unknown> = {}): boolean {
  if (result.notConfigured) {
    res.status(503).json({ error: 'Loyalty system not configured' });
    return true;
  }
  if (!result.success) {
    if (result.code === 'USER_NOT_FOUND') {
      res.status(404).json({ error: result.error });
      return true;
    }
    res.status(400).json({
      error: result.error,
      ...(result.balance !== undefined && { balance: result.balance })
    });
    return true;
  }
  res.json({ success: true, ...successData });
  return true;
}

/**
 * Build the /api/loyalty router for the loyalty.json in `logsDir`. Starts a
 * one-minute watch-time award timer (unref'd); call router.stop() to clear it.
 * Whenever points change, `broadcast` (if given) receives a 'loyalty-update'
 * message whose data is GET /leaderboard?limit=100.
 */
export function createLoyaltyRouter(logsDir: string, broadcast?: (message: BroadcastMessage) => void): LoyaltyRouter {
  const router = express.Router() as LoyaltyRouter;
  const loyaltyFile = path.join(logsDir, 'loyalty.json');

  // Read loyalty data, creating the file with defaults on a fresh install.
  // A corrupt file throws LoyaltyDataCorruptError (503) and is never overwritten.
  const readData = (): Promise<LoyaltyData> => readOrInitLoyaltyData(loyaltyFile);

  // Write loyalty data
  const writeData = (data: LoyaltyData): Promise<void> => writeLoyaltyData(loyaltyFile, data);

  // Push the current leaderboard to the dashboard and overlays after points changed
  const publish = async (): Promise<void> => {
    if (!broadcast) return;
    try {
      const data = await readLoyaltyData(loyaltyFile);
      if (data) broadcast({ type: 'loyalty-update', data: buildLeaderboard(data, LOYALTY_BROADCAST_LIMIT) });
    } catch (error) {
      console.error('Loyalty broadcast failed:', (error as Error).message);
    }
  };
  router.publish = publish;

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

  // PUT /api/loyalty/config - Update loyalty config (known settings only, validated)
  router.put('/config', async (req, res, next) => {
    try {
      const invalid = validateLoyaltyConfigUpdate(req.body);
      if (invalid) {
        res.status(400).json({ error: invalid });
        return;
      }
      const config = await withCrossProcessLock(loyaltyFile, async () => {
        const data = await readOrInitLoyaltyData(loyaltyFile);
        const updates = Object.fromEntries(Object.entries(req.body as Record<string, unknown>)
          .map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value]));
        data.config = { ...data.config, ...updates };
        await writeData(data);
        return data.config;
      });
      res.json({ success: true, config });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/loyalty/leaderboard - Get leaderboard
  router.get('/leaderboard', async (req, res, next) => {
    try {
      const limit = parseInt(req.query.limit as string) || 10;
      const data = await readData();
      res.json(buildLeaderboard(data, limit));
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
        res.status(404).json({ error: 'User not found' });
        return;
      }

      // Calculate rank
      const sorted = Object.entries(data.users as Record<string, LoyaltyUserRecord>)
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
      const { points, reason } = req.body as { points?: unknown; reason?: string };

      if (typeof points !== 'number') {
        res.status(400).json({ error: 'Points must be a number' });
        return;
      }

      const result = await setPoints(loyaltyFile, username, points, reason);
      if (!result.success) {
        res.status(503).json({ error: result.error });
        return;
      }
      await publish();
      res.json({ success: true, user: result.user });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/loyalty/deduct - Deduct points from user
  router.post('/deduct', async (req, res, next) => {
    try {
      const { username, amount, reason } = req.body as { username?: string; amount?: unknown; reason?: string };

      if (!username || typeof amount !== 'number' || amount <= 0) {
        res.status(400).json({ error: 'username and a positive amount are required' });
        return;
      }

      // Create loyalty.json on a fresh install, so an unknown user is a 404 rather than
      // deductPoints' "not configured" free pass
      await readData();
      const result = await deductPoints(loyaltyFile, username, amount, reason);
      if (result.success) await publish();

      // Handle insufficient points case with 'required' field for API contract
      // The 'required' field contains the amount that was requested to be deducted,
      // allowing API consumers to show "You need X points but only have Y"
      if (!result.success && result.code === 'INSUFFICIENT_POINTS') {
        res.status(400).json({
          error: result.error,
          balance: result.balance,
          required: amount
        });
        return;
      }

      handleLoyaltyResult(result, res, { newBalance: result.newBalance });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/loyalty/add - Add points to user
  router.post('/add', async (req, res, next) => {
    try {
      const { username, amount, reason } = req.body as { username?: string; amount?: unknown; reason?: string };

      if (!username || typeof amount !== 'number' || amount <= 0) {
        res.status(400).json({ error: 'username and a positive amount are required' });
        return;
      }

      const result = await addPoints(loyaltyFile, username, amount, reason, 'bonus');
      if (!result.success) {
        res.status(400).json({ error: result.error });
        return;
      }
      await publish();
      res.json({ success: true, newBalance: result.newBalance });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/loyalty/award-message - Award points for a chat message (cooldown & config applied)
  router.post('/award-message', async (req, res, next) => {
    try {
      const { username, isSubscriber, isVip } = req.body as { username?: unknown; isSubscriber?: unknown; isVip?: unknown };
      if (!username || typeof username !== 'string') {
        res.status(400).json({ error: 'username (string) is required' });
        return;
      }
      const result = await awardMessagePoints(loyaltyFile, username.trim(), !!isSubscriber, !!isVip);
      if (result.pointsEarned) await publish();
      handleLoyaltyResult(result, res, {
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
      const { username, amount } = req.body as { username?: unknown; amount?: unknown };
      if (!username || typeof username !== 'string') {
        res.status(400).json({ error: 'username (string) is required' });
        return;
      }
      if (amount === undefined || amount === null || amount === '' ||
          (typeof amount === 'number' && !Number.isFinite(amount))) {
        res.status(400).json({ error: 'amount is required. Use a number or "all".' });
        return;
      }
      let bet = amount as number | string;
      if (bet !== 'all' && String(bet).toLowerCase() !== 'all') {
        // Validate it's a valid number before parsing
        const numValue = Number(bet);
        if (!Number.isFinite(numValue)) {
          res.status(400).json({ error: 'amount must be a positive number or "all".' });
          return;
        }
        // Math.floor, not parseInt: parseInt(String(1e21)) would read "1e+21" as 1
        bet = Math.floor(numValue);
        if (bet < GAMBA_MIN) {
          res.status(400).json({ error: 'amount must be a positive number or "all".' });
          return;
        }
      }
      const result = await runGamba(loyaltyFile, username.trim(), bet);
      if (result.success) await publish();
      handleLoyaltyResult(result, res, {
        won: result.won,
        oldBalance: result.oldBalance,
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
      const { challenger, opponent, stake } = req.body as { challenger?: unknown; opponent?: unknown; stake?: unknown };
      if (!challenger || !opponent || typeof challenger !== 'string' || typeof opponent !== 'string') {
        res.status(400).json({ error: 'challenger and opponent (strings) are required' });
        return;
      }
      // A missing stake uses the default; 0, negative or non-numeric stakes are rejected
      const amount = parseDuelStake(stake);
      if (amount === null) {
        res.status(400).json({ error: 'stake must be at least 1.' });
        return;
      }
      const result = await runDuel(loyaltyFile, challenger.trim(), opponent.trim(), amount);
      if (result.success) await publish();
      handleLoyaltyResult(result, res, {
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
      const limit = parseInt(req.query.limit as string) || 50;
      const username = (req.query.username as string | undefined)?.toLowerCase();
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
  const watchTimeTimer = setInterval(() => {
    processWatchTimeAwards(loyaltyFile)
      .then(result => (result.awarded > 0 ? publish() : undefined))
      .catch(err => console.error('Loyalty watch-time award error:', err));
  }, WATCH_TIME_INTERVAL_MS);
  // The HTTP server keeps the process alive; this timer alone shouldn't
  watchTimeTimer.unref();
  router.stop = () => clearInterval(watchTimeTimer);

  return router;
}
