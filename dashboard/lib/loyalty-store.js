/**
 * Shared loyalty data access helpers used by loyalty.js and song-queue.js routes.
 *
 * Centralises all read/write/transaction logic for loyalty.json so both route
 * files stay in sync on the schema without duplicating code.
 */

const fs = require('fs').promises;
const { withCrossProcessLock } = require('../../lib/file-lock');

/** Maximum number of transactions to keep in history */
const TRANSACTION_HISTORY_MAX = 2000;
/** Number of transactions to keep when trimming history */
const TRANSACTION_HISTORY_TRIM_SIZE = 1000;
/** Milliseconds per minute (used for watch time calculations) */
const MILLISECONDS_PER_MINUTE = 60000;

const DEFAULT_USER = () => ({
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

/**
 * Read loyalty.json. Returns null if the file does not exist yet (loyalty
 * system not configured) so callers can degrade gracefully.
 * @param {string} loyaltyFile - Absolute path to loyalty.json
 * @returns {object|null}
 */
async function readLoyaltyData(loyaltyFile) {
  try {
    await fs.access(loyaltyFile);
    const content = await fs.readFile(loyaltyFile, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Write loyalty.json, stamping a `savedAt` timestamp.
 * @param {string} loyaltyFile - Absolute path to loyalty.json
 * @param {object} data
 */
async function writeLoyaltyData(loyaltyFile, data) {
  data.savedAt = new Date().toISOString();
  await fs.writeFile(loyaltyFile, JSON.stringify(data, null, 2));
}

/**
 * Ensures a user exists in the loyalty data. Mutates data.users in place.
 * @param {object} data - Loyalty data object
 * @param {string} username - Username to ensure exists
 * @returns {string} Normalized username (lowercased)
 */
function ensureUserExists(data, username) {
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
 * @param {object} data - Full loyalty data object
 * @param {object} tx   - Transaction fields (username, amount, type, reason, balance)
 */
function appendTransaction(data, tx) {
  if (!data.transactions) data.transactions = [];
  data.transactions.push({
    ...tx,
    timestamp: new Date().toISOString()
  });
  if (data.transactions.length > TRANSACTION_HISTORY_MAX) {
    data.transactions = data.transactions.slice(-TRANSACTION_HISTORY_TRIM_SIZE);
  }
}

/**
 * Deduct points from a user. Writes loyalty.json on success.
 *
 * @param {string} loyaltyFile
 * @param {string} username
 * @param {number} amount
 * @param {string} reason
 * @returns {{ success: boolean, error?: string, newBalance?: number }}
 */
async function deductPoints(loyaltyFile, username, amount, reason) {
  return withCrossProcessLock(loyaltyFile, async () => {
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

    userData.points -= amount;
    userData.totalSpent = (userData.totalSpent || 0) + amount;

    appendTransaction(data, {
      username: normalizedUsername,
      amount: -amount,
      type: 'spend',
      reason: reason || 'Deduction',
      balance: userData.points
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
 * @param {string} loyaltyFile
 * @param {string} username
 * @param {number} amount
 * @param {string} reason
 */
async function refundPoints(loyaltyFile, username, amount, reason) {
  if (!amount || amount <= 0) return;

  return withCrossProcessLock(loyaltyFile, async () => {
    const data = await readLoyaltyData(loyaltyFile);
    if (!data) return;

    const normalizedUsername = ensureUserExists(data, username);
    const userData = data.users[normalizedUsername];

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
 * @param {string} loyaltyFile
 * @param {string} username
 * @param {number} amount
 * @param {string} reason
 * @param {'bonus'|'admin'} [type='bonus']
 * @returns {{ success: boolean, newBalance: number }}
 */
async function addPoints(loyaltyFile, username, amount, reason, type = 'bonus') {
  return withCrossProcessLock(loyaltyFile, async () => {
    const data = await readLoyaltyData(loyaltyFile);
    if (!data) return { success: false, notConfigured: true, error: 'Loyalty system not configured' };

    const normalizedUsername = ensureUserExists(data, username);
    const userData = data.users[normalizedUsername];

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
 * @param {string} loyaltyFile
 * @param {string} username
 * @param {number} points
 * @param {string} reason
 * @returns {{ success: boolean, user: object }}
 */
async function setPoints(loyaltyFile, username, points, reason) {
  return withCrossProcessLock(loyaltyFile, async () => {
    const data = await readLoyaltyData(loyaltyFile);
    if (!data) return { success: false, error: 'Loyalty system not configured' };

    const normalizedUsername = ensureUserExists(data, username);
    const userData = data.users[normalizedUsername];

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
 * @param {string|number|null} value
 * @returns {number|null}
 */
function parseTimestampMs(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  const n = Date.parse(value);
  return Number.isNaN(n) ? null : n;
}

/**
 * Award points for a chat message. Applies cooldown, config amount, and sub/VIP multipliers.
 * Updates lastSeen and lastMessagePointsAt. Creates user if not present.
 *
 * @param {string} loyaltyFile
 * @param {string} username
 * @param {boolean} isSubscriber
 * @param {boolean} isVip
 * @returns {{ success: boolean, notConfigured?: boolean, pointsEarned: number, newBalance?: number, onCooldown?: boolean }}
 */
async function awardMessagePoints(loyaltyFile, username, isSubscriber, isVip) {
  return withCrossProcessLock(loyaltyFile, async () => {
    const data = await readLoyaltyData(loyaltyFile);
    if (!data) return { success: false, notConfigured: true, pointsEarned: 0 };

    const config = data.config || {};
    if (config.enabled === false) return { success: true, pointsEarned: 0 };

    const normalizedUsername = ensureUserExists(data, username);
    const userData = data.users[normalizedUsername];

    const now = Date.now();
    const cooldownMs = (config.messageCooldownSeconds ?? 30) * 1000;
    const lastAt = parseTimestampMs(userData.lastMessagePointsAt);
    if (lastAt != null && (now - lastAt) < cooldownMs) {
      return { success: true, pointsEarned: 0, onCooldown: true };
    }

    let amount = config.pointsPerMessage ?? 5;
    if (isSubscriber) amount *= config.subscriberMultiplier ?? 2;
    else if (isVip) amount *= config.vipMultiplier ?? 1.5;
    amount = Math.floor(amount);
    amount = Math.min(amount, config.maxPointsPerMessage ?? 50);
    if (amount <= 0) return { success: true, pointsEarned: 0 };

    userData.points = (userData.points || 0) + amount;
    userData.totalEarned = (userData.totalEarned || 0) + amount;
    userData.lastMessagePointsAt = now;
    userData.lastSeen = new Date().toISOString();
    userData.isSubscriber = isSubscriber;
    userData.isVip = isVip;

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
const WATCH_TIME_INTERVAL_MS = 60 * 1000; // 1 minute

/**
 * Process watch-time awards for all users considered "present" (lastSeen within presence window).
 * Call under lock; mutates data and writes once.
 *
 * @param {string} loyaltyFile
 * @returns {{ success: boolean, notConfigured?: boolean, awarded: number }}
 */
async function processWatchTimeAwards(loyaltyFile) {
  return withCrossProcessLock(loyaltyFile, async () => {
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

      const lastAwardedMs = userData.lastWatchTimeAwardedAt != null
        ? userData.lastWatchTimeAwardedAt
        : parseTimestampMs(userData.firstSeen) || lastSeenMs;
      const elapsedMs = now - lastAwardedMs;
      const minutesToAward = Math.floor(elapsedMs / MILLISECONDS_PER_MINUTE);
      if (minutesToAward <= 0) continue;

      let points = minutesToAward * pointsPerMinute;
      if (userData.isSubscriber) points *= subscriberMultiplier;
      else if (userData.isVip) points *= vipMultiplier;
      points = Math.floor(points);
      if (points <= 0) continue;

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
const DEFAULT_DUEL_STAKE = 50;
/** Min/max gamba bet (points) */
const GAMBA_MIN = 1;
const GAMBA_MAX = 10000;

/**
 * Validates gamba bet amount before processing
 * @param {number|string} amount - Bet amount or 'all'
 * @returns {{ valid: boolean, error?: string, isAll: boolean }}
 */
function validateGambaBetAmount(amount) {
  const isAll = amount === 'all' || String(amount).toLowerCase() === 'all';
  if (isAll) {
    return { valid: true, isAll: true };
  }

  const bet = Math.floor(Number(amount));
  if (bet < GAMBA_MIN || bet > GAMBA_MAX) {
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
 * @param {object} userData - User loyalty data
 * @param {number} bet - Bet amount
 * @returns {{ valid: boolean, error?: string, code?: string, balance?: number }}
 */
function validateGambaBalance(userData, bet) {
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
 * @param {object} data - Loyalty data
 * @param {object} userData - User loyalty data
 * @param {string} normalizedUsername - Username (lowercase)
 * @param {number} bet - Bet amount
 */
function processGambaWin(data, userData, normalizedUsername, bet) {
  const winnings = bet * 2;
  userData.points += winnings;
  userData.totalEarned = (userData.totalEarned || 0) + winnings;
  appendTransaction(data, {
    username: normalizedUsername,
    amount: winnings,
    type: 'bonus',
    reason: 'Gamba win',
    balance: userData.points
  });
}

/**
 * Run a single-user gamble: deduct amount, 50% chance to double (2x return).
 * All under one lock so balance is consistent.
 *
 * @param {string} loyaltyFile
 * @param {string} username
 * @param {number|string} amount - Points to bet (number >= GAMBA_MIN, <= GAMBA_MAX), or 'all' to bet full balance (resolved inside lock)
 * @returns {{ success: boolean, notConfigured?: boolean, error?: string, code?: string, won?: boolean, newBalance?: number, amountBet?: number, winnings?: number }}
 */
async function runGamba(loyaltyFile, username, amount) {
  const validation = validateGambaBetAmount(amount);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  return withCrossProcessLock(loyaltyFile, async () => {
    const data = await readLoyaltyData(loyaltyFile);
    if (!data) return { success: false, notConfigured: true };

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

    userData.points -= bet;
    userData.totalSpent = (userData.totalSpent || 0) + bet;
    appendTransaction(data, {
      username: normalizedUsername,
      amount: -bet,
      type: 'spend',
      reason: 'Gamba bet',
      balance: userData.points
    });

    const won = Math.random() < 0.5;
    if (won) {
      processGambaWin(data, userData, normalizedUsername, bet);
    }

    await writeLoyaltyData(loyaltyFile, data);
    return {
      success: true,
      won,
      newBalance: userData.points,
      amountBet: bet,
      winnings: won ? bet * 2 : 0
    };
  });
}

/**
 * Run a duel: both users pay stake, one random winner gets 2× stake. All under one lock.
 *
 * @param {string} loyaltyFile
 * @param {string} challenger - Username of challenger
 * @param {string} opponent - Username of opponent
 * @param {number} stake - Points each must put up (default DEFAULT_DUEL_STAKE)
 * @returns {{ success: boolean, notConfigured?: boolean, error?: string, code?: string, winner?: string, challengerBalance?: number, opponentBalance?: number }}
 */
async function runDuel(loyaltyFile, challenger, opponent, stake = DEFAULT_DUEL_STAKE) {
  const amount = Math.floor(Number(stake)) || DEFAULT_DUEL_STAKE;
  if (amount < 1) {
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

  return withCrossProcessLock(loyaltyFile, async () => {
    const data = await readLoyaltyData(loyaltyFile);
    if (!data) return { success: false, notConfigured: true };

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

    challengerData.points -= amount;
    challengerData.totalSpent = (challengerData.totalSpent || 0) + amount;
    appendTransaction(data, { username: c, amount: -amount, type: 'spend', reason: 'Duel stake', balance: challengerData.points });
    opponentData.points -= amount;
    opponentData.totalSpent = (opponentData.totalSpent || 0) + amount;
    appendTransaction(data, { username: o, amount: -amount, type: 'spend', reason: 'Duel stake', balance: opponentData.points });

    const winner = Math.random() < 0.5 ? c : o;
    const winnerData = data.users[winner];
    const winnings = amount * 2;
    winnerData.points += winnings;
    winnerData.totalEarned = (winnerData.totalEarned || 0) + winnings;
    appendTransaction(data, { username: winner, amount: winnings, type: 'bonus', reason: 'Duel win', balance: winnerData.points });

    await writeLoyaltyData(loyaltyFile, data);
    return {
      success: true,
      winner,
      challengerBalance: data.users[c].points,
      opponentBalance: data.users[o].points
    };
  });
}

module.exports = {
  readLoyaltyData,
  writeLoyaltyData,
  appendTransaction,
  deductPoints,
  refundPoints,
  addPoints,
  setPoints,
  awardMessagePoints,
  processWatchTimeAwards,
  runGamba,
  runDuel,
  DEFAULT_DUEL_STAKE,
  GAMBA_MIN,
  GAMBA_MAX,
  WATCH_TIME_INTERVAL_MS
};
