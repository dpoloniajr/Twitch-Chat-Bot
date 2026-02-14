/**
 * Shared loyalty data access helpers used by loyalty.js and song-queue.js routes.
 *
 * Centralises all read/write/transaction logic for loyalty.json so both route
 * files stay in sync on the schema without duplicating code.
 */

const fs = require('fs').promises;
const { withCrossProcessLock } = require('../../lib/file-lock');

const DEFAULT_USER = () => ({
  points: 0,
  totalEarned: 0,
  totalSpent: 0,
  watchTimeMinutes: 0,
  messageCount: 0,
  lastSeen: new Date().toISOString(),
  firstSeen: new Date().toISOString(),
  level: 1
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
  if (data.transactions.length > 2000) {
    data.transactions = data.transactions.slice(-1000);
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

    const normalizedUsername = username.toLowerCase();

    if (!data.users) data.users = {};
    if (!data.users[normalizedUsername]) {
      data.users[normalizedUsername] = DEFAULT_USER();
    }

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
    if (!data) return { success: false, error: 'Loyalty system not configured' };

    const normalizedUsername = username.toLowerCase();

    if (!data.users) data.users = {};
    if (!data.users[normalizedUsername]) {
      data.users[normalizedUsername] = DEFAULT_USER();
    }

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

    const normalizedUsername = username.toLowerCase();

    if (!data.users) data.users = {};
    if (!data.users[normalizedUsername]) {
      data.users[normalizedUsername] = DEFAULT_USER();
    }

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

module.exports = { readLoyaltyData, writeLoyaltyData, appendTransaction, deductPoints, refundPoints, addPoints, setPoints };
