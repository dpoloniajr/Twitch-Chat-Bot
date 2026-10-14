/**
 * Shared loyalty data access helpers used by loyalty.js and song-queue.js routes.
 *
 * Centralises all read/write/transaction logic for loyalty.json so both route
 * files stay in sync on the schema without duplicating code.
 */

import * as fsSync from 'fs';
import { promises as fs } from 'fs';
import { withCrossProcessLock, writeFileAtomic } from '../../lib/file-lock';
import type {
  AddPointsResult,
  AwardMessageResult,
  DeductPointsResult,
  DuelResult,
  GambaResult,
  LoyaltyData,
  LoyaltyErrorCode,
  LoyaltyTransactionInput,
  LoyaltyTransactionRecord,
  LoyaltyUserRecord,
  SetPointsResult,
  WatchTimeResult
} from './types';

/** Maximum number of transactions to keep in history */
const TRANSACTION_HISTORY_MAX = 2000;
/** Number of transactions to keep when trimming history */
const TRANSACTION_HISTORY_TRIM_SIZE = 1000;
/** Milliseconds per minute (used for watch time calculations) */
const MILLISECONDS_PER_MINUTE = 60000;

const DEFAULT_USER = (): LoyaltyUserRecord => ({
  points: 0,
  totalEarned: 0,
  totalSpent: 0,
  watchTimeMinutes: 0,
  messageCount: 0,
  lastSeen: new Date().toISOString(),
  firstSeen: new Date().toISOString(),
  level: 1,
  lastMessagePointsAt: null,
  lastWatchTimeAwardedAt: null
});

/** loyalty.json contents for a fresh install */
export const DEFAULT_LOYALTY_DATA = (): LoyaltyData => ({
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

/**
 * loyalty.json exists but cannot be read or parsed. Every store operation refuses
 * to run (and so never overwrites the file) until someone repairs or removes it.
 * statusCode makes the dashboard's error handler answer 503 with this message.
 */
export class LoyaltyDataCorruptError extends Error {
  statusCode = 503;
  /** Copy of the unreadable file, or null if it could not be made */
  backupPath: string | null;

  constructor(loyaltyFile: string, backupPath: string | null, cause: unknown) {
    super(`Loyalty data file ${loyaltyFile} is unreadable (${(cause as Error)?.message || cause}); ` +
      'loyalty changes are blocked until it is repaired or removed' +
      (backupPath ? ` (a copy was saved to ${backupPath})` : ''));
    this.name = 'LoyaltyDataCorruptError';
    this.backupPath = backupPath;
  }
}

/**
 * Keep a copy of a corrupt loyalty.json next to it (once per file version, named
 * after its mtime) so the balances can be recovered by hand. Returns its path.
 */
function backupCorruptFile(loyaltyFile: string): string | null {
  try {
    const { mtimeMs } = fsSync.statSync(loyaltyFile);
    const backupPath = `${loyaltyFile}.corrupt-${Math.floor(mtimeMs)}`;
    if (!fsSync.existsSync(backupPath)) {
      fsSync.copyFileSync(loyaltyFile, backupPath);
    }
    return backupPath;
  } catch {
    return null;
  }
}

/**
 * Read loyalty.json. Returns null if the file does not exist yet (loyalty
 * system not configured) so callers can degrade gracefully.
 * Throws LoyaltyDataCorruptError (after backing the file up and logging) when the
 * file exists but cannot be read or holds invalid JSON: treating it as missing
 * would let the defaults overwrite every balance.
 * @param loyaltyFile - Absolute path to loyalty.json
 */
export async function readLoyaltyData(loyaltyFile: string): Promise<LoyaltyData | null> {
  let content: string;
  try {
    content = await fs.readFile(loyaltyFile, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw corrupt(loyaltyFile, error);
  }
  try {
    const data = JSON.parse(content) as unknown;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('not a JSON object');
    }
    return data as LoyaltyData;
  } catch (error) {
    throw corrupt(loyaltyFile, error);
  }
}

/** Back up and loudly report an unreadable loyalty.json; returns the error to throw */
function corrupt(loyaltyFile: string, cause: unknown): LoyaltyDataCorruptError {
  const error = new LoyaltyDataCorruptError(loyaltyFile, backupCorruptFile(loyaltyFile), cause);
  console.error(`[Loyalty] ERROR: ${error.message}`);
  return error;
}

/**
 * Read loyalty.json, creating it with DEFAULT_LOYALTY_DATA when it does not exist
 * yet (fresh install). Creation needs no lock: the defaults are written to a
 * temporary file and hard-linked into place, which is atomic and fails if another
 * caller created the file first (that file is then read instead). So read-only
 * routes can call this without waiting for a writer holding the lock.
 */
export async function readOrInitLoyaltyData(loyaltyFile: string): Promise<LoyaltyData> {
  const data = await readLoyaltyData(loyaltyFile);
  if (data) return data;

  const defaults = DEFAULT_LOYALTY_DATA();
  defaults.savedAt = new Date().toISOString();
  const tmpFile = `${loyaltyFile}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.init`;
  await fs.writeFile(tmpFile, JSON.stringify(defaults, null, 2));
  try {
    await fs.link(tmpFile, loyaltyFile);
    return defaults;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await readLoyaltyData(loyaltyFile);
    if (!existing) throw error;
    return existing;
  } finally {
    await fs.unlink(tmpFile).catch(() => {});
  }
}

/**
 * Write loyalty.json, stamping a `savedAt` timestamp (mutates `data`).
 * @param loyaltyFile - Absolute path to loyalty.json
 */
export async function writeLoyaltyData(loyaltyFile: string, data: LoyaltyData): Promise<void> {
  data.savedAt = new Date().toISOString();
  await writeFileAtomic(loyaltyFile, JSON.stringify(data, null, 2));
}

/**
 * Ensures a user exists in the loyalty data. Mutates data.users in place.
 * @param data - Loyalty data object
 * @param username - Username to ensure exists
 * @returns Normalized username (lowercased)
 */
function ensureUserExists(data: LoyaltyData, username: string): string {
  const normalizedUsername = username.toLowerCase();
  if (!data.users) data.users = {};
  if (!data.users[normalizedUsername]) {
    data.users[normalizedUsername] = DEFAULT_USER();
  }
  return normalizedUsername;
}

/**
 * Append a transaction entry and trim the history to at most 2 000 entries.
 * Mutates `data` in place; caller must persist afterward.
 * @param data - Full loyalty data object
 * @param tx   - Transaction fields (username, amount, type, reason, balance)
 */
export function appendTransaction(data: LoyaltyData, tx: LoyaltyTransactionInput): void {
  if (!data.transactions) data.transactions = [];
  const entry: LoyaltyTransactionRecord = {
    ...tx,
    timestamp: new Date().toISOString()
  };
  data.transactions.push(entry);
  if (data.transactions.length > TRANSACTION_HISTORY_MAX) {
    data.transactions = data.transactions.slice(-TRANSACTION_HISTORY_TRIM_SIZE);
  }
}

/**
 * Deduct points from a user. Writes loyalty.json on success.
 *
 * Returns `{ success: true, notConfigured: true }` (nothing charged) when
 * loyalty.json does not exist.
 */
export async function deductPoints(
  loyaltyFile: string,
  username: string,
  amount: number,
  reason?: string
): Promise<DeductPointsResult> {
  return withCrossProcessLock(loyaltyFile, async (): Promise<DeductPointsResult> => {
    const data = await readLoyaltyData(loyaltyFile);
    if (!data) return { success: true, notConfigured: true }; // Loyalty system not configured – graceful fallback

    const normalizedUsername = username.toLowerCase();
    const userData = data.users?.[normalizedUsername];

    if (!userData) {
      return {
        success: false,
        code: 'USER_NOT_FOUND',
        error: `You have no loyalty points yet. This request costs ${amount} points.`
      };
    }

    if ((userData.points || 0) < amount) {
      return {
        success: false,
        code: 'INSUFFICIENT_POINTS',
        balance: userData.points || 0,
        error: `Insufficient points. This request costs ${amount} points. You have ${userData.points || 0}.`
      };
    }

    // NOTE (pre-existing): with amount <= 0 (the route rejects it) a user with no `points`
    // field passes the check above and ends up with NaN; for any positive amount points is set.
    userData.points! -= amount;
    userData.totalSpent = (userData.totalSpent || 0) + amount;

    appendTransaction(data, {
      username: normalizedUsername,
      amount: -amount,
      type: 'spend',
      reason: reason || 'Deduction',
      balance: userData.points!
    });

    await writeLoyaltyData(loyaltyFile, data);
    return { success: true, newBalance: userData.points };
  });
}

/**
 * Refund points to a user. Restores balance and reverses totalSpent without
 * inflating totalEarned (it was not a new earning event).
 * No-op if `amount` is 0 or the loyalty file does not exist.
 *
 */
export async function refundPoints(
  loyaltyFile: string,
  username: string,
  amount: number,
  reason?: string
): Promise<void> {
  if (!amount || amount <= 0) return;

  return withCrossProcessLock(loyaltyFile, async () => {
    const data = await readLoyaltyData(loyaltyFile);
    if (!data) return;

    const normalizedUsername = ensureUserExists(data, username);
    const userData = data.users![normalizedUsername];

    userData.points = (userData.points || 0) + amount;
    // Reverse the spend without counting as a new earn
    userData.totalSpent = Math.max(0, (userData.totalSpent || 0) - amount);

    appendTransaction(data, {
      username: normalizedUsername,
      amount,
      type: 'refund',
      reason: reason || 'Refund',
      balance: userData.points
    });

    await writeLoyaltyData(loyaltyFile, data);
  });
}

/**
 * Add points to a user (bonus/admin). Creates the user if not present.
 *
 */
export async function addPoints(
  loyaltyFile: string,
  username: string,
  amount: number,
  reason?: string,
  type: 'bonus' | 'admin' = 'bonus'
): Promise<AddPointsResult> {
  return withCrossProcessLock(loyaltyFile, async (): Promise<AddPointsResult> => {
    const data = await readOrInitLoyaltyData(loyaltyFile);

    const normalizedUsername = ensureUserExists(data, username);
    const userData = data.users![normalizedUsername];

    userData.points = (userData.points || 0) + amount;
    userData.totalEarned = (userData.totalEarned || 0) + amount;

    appendTransaction(data, {
      username: normalizedUsername,
      amount,
      type,
      reason: reason || 'Addition',
      balance: userData.points
    });

    await writeLoyaltyData(loyaltyFile, data);
    return { success: true, newBalance: userData.points };
  });
}

/**
 * Set a user's points to an exact value (admin operation).
 * Creates the user if not present. Records an 'admin' transaction.
 *
 */
export async function setPoints(
  loyaltyFile: string,
  username: string,
  points: number,
  reason?: string
): Promise<SetPointsResult> {
  return withCrossProcessLock(loyaltyFile, async (): Promise<SetPointsResult> => {
    const data = await readOrInitLoyaltyData(loyaltyFile);

    const normalizedUsername = ensureUserExists(data, username);
    const userData = data.users![normalizedUsername];

    const oldPoints = userData.points || 0;
    userData.points = Math.max(0, points);

    appendTransaction(data, {
      username: normalizedUsername,
      amount: userData.points - oldPoints,
      type: 'admin',
      reason: reason || 'Admin adjustment',
      balance: userData.points
    });

    await writeLoyaltyData(loyaltyFile, data);
    return { success: true, user: userData };
  });
}

/**
 * Parse a timestamp from user data (ISO string or ms number) to ms.
 */
function parseTimestampMs(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const n = Date.parse(value);
  return Number.isNaN(n) ? null : n;
}

/**
 * Record a chat message and award points for it. Every message counts towards
 * messageCount and refreshes lastSeen and the sub/VIP flags (which keeps the user
 * "present" for watch time); points follow the cooldown, config amount and
 * sub/VIP multipliers. Creates loyalty.json and the user if not present.
 */
export async function awardMessagePoints(
  loyaltyFile: string,
  username: string,
  isSubscriber: boolean,
  isVip: boolean
): Promise<AwardMessageResult> {
  return withCrossProcessLock(loyaltyFile, async (): Promise<AwardMessageResult> => {
    const data = await readOrInitLoyaltyData(loyaltyFile);

    const config = data.config || {};
    if (config.enabled === false) return { success: true, pointsEarned: 0 };

    const normalizedUsername = ensureUserExists(data, username);
    const userData = data.users![normalizedUsername];

    const now = Date.now();
    userData.messageCount = (Number(userData.messageCount) || 0) + 1;
    userData.lastSeen = new Date(now).toISOString();
    userData.isSubscriber = isSubscriber;
    userData.isVip = isVip;

    const cooldownMs = (config.messageCooldownSeconds ?? 30) * 1000;
    const lastAt = parseTimestampMs(userData.lastMessagePointsAt);
    if (lastAt != null && (now - lastAt) < cooldownMs) {
      await writeLoyaltyData(loyaltyFile, data);
      return { success: true, pointsEarned: 0, onCooldown: true };
    }

    let amount = config.pointsPerMessage ?? 5;
    if (isSubscriber) amount *= config.subscriberMultiplier ?? 2;
    else if (isVip) amount *= config.vipMultiplier ?? 1.5;
    amount = Math.floor(amount);
    amount = Math.min(amount, config.maxPointsPerMessage ?? 50);
    if (!Number.isFinite(amount) || amount <= 0) {
      await writeLoyaltyData(loyaltyFile, data);
      return { success: true, pointsEarned: 0 };
    }

    userData.points = (userData.points || 0) + amount;
    userData.totalEarned = (userData.totalEarned || 0) + amount;
    userData.lastMessagePointsAt = now;

    appendTransaction(data, {
      username: normalizedUsername,
      amount,
      type: 'earn',
      reason: 'Chat message',
      balance: userData.points
    });

    await writeLoyaltyData(loyaltyFile, data);
    return { success: true, pointsEarned: amount, newBalance: userData.points };
  });
}

/** Default presence window: treat user as "watching" if lastSeen within this many ms */
const WATCH_TIME_PRESENCE_MS = 10 * 60 * 1000; // 10 minutes
/** How often to run the watch-time award pass (ms) */
export const WATCH_TIME_INTERVAL_MS = 60 * 1000; // 1 minute

/**
 * Process watch-time awards for all users considered "present" (lastSeen within presence window).
 * Call under lock; mutates data and writes once.
 *
 * Minutes are counted from the last award, or from lastSeen when the user was never
 * awarded or the last award is older than the presence window (they were away), so a
 * returning viewer is not paid for the time they were gone.
 */
export async function processWatchTimeAwards(loyaltyFile: string): Promise<WatchTimeResult> {
  return withCrossProcessLock(loyaltyFile, async (): Promise<WatchTimeResult> => {
    const data = await readLoyaltyData(loyaltyFile);
    if (!data) return { success: false, notConfigured: true, awarded: 0 };

    const config = data.config || {};
    if (config.enabled === false) return { success: true, awarded: 0 };

    const now = Date.now();
    const presenceMs = WATCH_TIME_PRESENCE_MS;
    const pointsPerMinute = config.pointsPerMinute ?? 10;
    const subscriberMultiplier = config.subscriberMultiplier ?? 2;
    const vipMultiplier = config.vipMultiplier ?? 1.5;

    let awarded = 0;
    const users = data.users || {};

    for (const [key, userData] of Object.entries(users)) {
      const lastSeenMs = parseTimestampMs(userData.lastSeen);
      if (lastSeenMs == null || (now - lastSeenMs) > presenceMs) continue;

      const lastAwardedMs = parseTimestampMs(userData.lastWatchTimeAwardedAt);
      const startMs = lastAwardedMs != null && (now - lastAwardedMs) <= presenceMs ? lastAwardedMs : lastSeenMs;
      const minutesToAward = Math.floor((now - startMs) / MILLISECONDS_PER_MINUTE);
      if (!(minutesToAward > 0)) continue;

      let points = minutesToAward * pointsPerMinute;
      if (userData.isSubscriber) points *= subscriberMultiplier;
      else if (userData.isVip) points *= vipMultiplier;
      points = Math.floor(points);
      if (!Number.isFinite(points) || points <= 0) continue;

      userData.points = (userData.points || 0) + points;
      userData.totalEarned = (userData.totalEarned || 0) + points;
      userData.watchTimeMinutes = (userData.watchTimeMinutes || 0) + minutesToAward;
      userData.lastWatchTimeAwardedAt = now;

      appendTransaction(data, {
        username: key,
        amount: points,
        type: 'earn',
        reason: 'Watch time',
        balance: userData.points
      });
      awarded += 1;
    }

    if (awarded > 0) await writeLoyaltyData(loyaltyFile, data);
    return { success: true, awarded };
  });
}

/** Default duel stake (points) if not specified */
export const DEFAULT_DUEL_STAKE = 50;

/**
 * Normalise a duel stake: missing (undefined/null/'') means DEFAULT_DUEL_STAKE,
 * otherwise a whole number of at least 1 point. Returns null for anything else
 * (0, negative, non-numeric), which callers reject instead of using the default.
 */
export function parseDuelStake(stake: unknown): number | null {
  if (stake === undefined || stake === null || stake === '') return DEFAULT_DUEL_STAKE;
  if (typeof stake !== 'number' && typeof stake !== 'string') return null;
  const amount = Math.floor(Number(stake));
  return Number.isFinite(amount) && amount >= 1 ? amount : null;
}
/** Min/max gamba bet (points) */
export const GAMBA_MIN = 1;
export const GAMBA_MAX = 10000;

/**
 * Validates gamba bet amount before processing
 * @param amount - Bet amount or 'all'
 */
function validateGambaBetAmount(amount: number | string): { valid: boolean; error?: string; isAll: boolean } {
  const isAll = amount === 'all' || String(amount).toLowerCase() === 'all';
  if (isAll) {
    return { valid: true, isAll: true };
  }

  const bet = Math.floor(Number(amount));
  if (!Number.isFinite(bet) || bet < GAMBA_MIN || bet > GAMBA_MAX) {
    return {
      valid: false,
      isAll: false,
      error: `Bet must be between ${GAMBA_MIN} and ${GAMBA_MAX} points.`
    };
  }

  return { valid: true, isAll: false };
}

/**
 * Validates user has sufficient balance for bet
 * @param userData - User loyalty data
 * @param bet - Bet amount
 */
function validateGambaBalance(
  userData: LoyaltyUserRecord | undefined,
  bet: number
): { valid: boolean; error?: string; code?: LoyaltyErrorCode; balance?: number } {
  if (!userData) {
    return {
      valid: false,
      code: 'USER_NOT_FOUND',
      error: 'You have no loyalty points yet.'
    };
  }

  const balance = userData.points || 0;

  if (bet < GAMBA_MIN) {
    return {
      valid: false,
      code: 'INSUFFICIENT_POINTS',
      balance,
      error: 'You have no points to bet.'
    };
  }

  if (balance < bet) {
    return {
      valid: false,
      code: 'INSUFFICIENT_POINTS',
      balance,
      error: `Insufficient points. You have ${balance}.`
    };
  }

  return { valid: true };
}

/**
 * Processes gamba win logic
 * @param data - Loyalty data
 * @param userData - User loyalty data
 * @param normalizedUsername - Username (lowercase)
 * @param bet - Bet amount
 */
function processGambaWin(data: LoyaltyData, userData: LoyaltyUserRecord, normalizedUsername: string, bet: number): void {
  const winnings = bet * 2;
  userData.points! += winnings;
  userData.totalEarned = (userData.totalEarned || 0) + winnings;
  appendTransaction(data, {
    username: normalizedUsername,
    amount: winnings,
    type: 'bonus',
    reason: 'Gamba win',
    balance: userData.points!
  });
}

/**
 * Run a single-user gamble: deduct amount, 50% chance to double (2x return).
 * All under one lock so balance is consistent.
 *
 * @param amount - Points to bet (number >= GAMBA_MIN, <= GAMBA_MAX), or 'all' to bet full balance (resolved inside lock)
 */
export async function runGamba(loyaltyFile: string, username: string, amount: number | string): Promise<GambaResult> {
  const validation = validateGambaBetAmount(amount);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  return withCrossProcessLock(loyaltyFile, async (): Promise<GambaResult> => {
    const data = await readOrInitLoyaltyData(loyaltyFile);

    const normalizedUsername = username.toLowerCase();
    const userData = data.users?.[normalizedUsername];
    const balance = userData?.points || 0;
    const bet = validation.isAll
      ? Math.min(Math.floor(balance), GAMBA_MAX)
      : Math.floor(Number(amount));

    const balanceValidation = validateGambaBalance(userData, bet);
    if (!balanceValidation.valid) {
      return {
        success: false,
        code: balanceValidation.code,
        balance: balanceValidation.balance,
        error: balanceValidation.error
      };
    }

    // validateGambaBalance passed, so the user exists and holds at least `bet` (>= 1) points
    const user = userData!;
    const oldBalance = user.points;
    user.points! -= bet;
    user.totalSpent = (user.totalSpent || 0) + bet;
    appendTransaction(data, {
      username: normalizedUsername,
      amount: -bet,
      type: 'spend',
      reason: 'Gamba bet',
      balance: user.points!
    });

    const won = Math.random() < 0.5;
    if (won) {
      processGambaWin(data, user, normalizedUsername, bet);
    }

    await writeLoyaltyData(loyaltyFile, data);
    return {
      success: true,
      won,
      oldBalance,
      newBalance: user.points,
      amountBet: bet,
      winnings: won ? bet * 2 : 0
    };
  });
}

/**
 * Run a duel: both users pay stake, one random winner gets 2× stake. All under one lock.
 *
 * @param challenger - Username of challenger
 * @param opponent - Username of opponent
 * @param stake - Points each must put up (default DEFAULT_DUEL_STAKE)
 */
// NOTE (pre-existing): the insufficient-points errors quote the raw (un-normalized,
// possibly @-prefixed) usernames.
export async function runDuel(
  loyaltyFile: string,
  challenger: string,
  opponent: string,
  stake: number | string = DEFAULT_DUEL_STAKE
): Promise<DuelResult> {
  const amount = parseDuelStake(stake);
  if (amount === null) {
    return { success: false, error: 'Stake must be at least 1 point.' };
  }
  const c = challenger.toLowerCase().replace(/^@+/, '').trim();
  const o = opponent.toLowerCase().replace(/^@+/, '').trim();
  if (!c || !o) {
    return { success: false, error: 'Challenger and opponent usernames are required.' };
  }
  if (c === o) {
    return { success: false, error: 'You cannot duel yourself.' };
  }

  return withCrossProcessLock(loyaltyFile, async (): Promise<DuelResult> => {
    const data = await readOrInitLoyaltyData(loyaltyFile);

    // Note: c and o are already lowercased from preprocessing above
    if (!data.users) data.users = {};
    if (!data.users[c]) data.users[c] = DEFAULT_USER();
    if (!data.users[o]) data.users[o] = DEFAULT_USER();

    const challengerData = data.users[c];
    const opponentData = data.users[o];
    const cBalance = challengerData.points || 0;
    const oBalance = opponentData.points || 0;

    if (cBalance < amount) {
      return { success: false, code: 'CHALLENGER_INSUFFICIENT', error: `${challenger} doesn't have enough points (${cBalance}). Need ${amount}.` };
    }
    if (oBalance < amount) {
      return { success: false, code: 'OPPONENT_INSUFFICIENT', error: `${opponent} doesn't have enough points (${oBalance}). Need ${amount}.` };
    }

    challengerData.points! -= amount;
    challengerData.totalSpent = (challengerData.totalSpent || 0) + amount;
    appendTransaction(data, { username: c, amount: -amount, type: 'spend', reason: 'Duel stake', balance: challengerData.points! });
    opponentData.points! -= amount;
    opponentData.totalSpent = (opponentData.totalSpent || 0) + amount;
    appendTransaction(data, { username: o, amount: -amount, type: 'spend', reason: 'Duel stake', balance: opponentData.points! });

    const winner = Math.random() < 0.5 ? c : o;
    const winnerData = data.users[winner];
    const winnings = amount * 2;
    winnerData.points! += winnings;
    winnerData.totalEarned = (winnerData.totalEarned || 0) + winnings;
    appendTransaction(data, { username: winner, amount: winnings, type: 'bonus', reason: 'Duel win', balance: winnerData.points! });

    await writeLoyaltyData(loyaltyFile, data);
    return {
      success: true,
      winner,
      challengerBalance: data.users[c].points,
      opponentBalance: data.users[o].points
    };
  });
}

/** One row of the loyalty leaderboard (GET /api/loyalty/leaderboard, 'loyalty-update' broadcasts) */
export interface LeaderboardEntry {
  username: string;
  points: number;
  level: number;
  watchTimeMinutes: number;
  rank: number;
}

/** The top `limit` users by points, highest first, ranked from 1 */
export function buildLeaderboard(data: LoyaltyData, limit: number): LeaderboardEntry[] {
  return Object.entries(data.users || {})
    .map(([username, userData]) => ({
      username,
      points: userData.points || 0,
      level: userData.level || 1,
      watchTimeMinutes: userData.watchTimeMinutes || 0
    }))
    .sort((a, b) => b.points - a.points)
    .slice(0, limit)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
}
