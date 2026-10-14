/**
 * Loyalty, quote and counter commands. The dashboard owns this data; every
 * command goes through its HTTP API (/api/loyalty, /api/quotes, /api/counters).
 */

import type { BotContext, HttpError } from './context';
import type { DashboardClient } from './dashboard-client';
import { parseWholeNumber } from './fun-commands';

export interface LoyaltyConfig {
  currencyNamePlural?: string;
  [key: string]: unknown;
}

export interface LoyaltyCommands {
  getLoyaltyConfig: () => Promise<LoyaltyConfig>;
  /**
   * Handlers resolve to true on success, which is when the command's cooldown starts.
   * Invalid input and dashboard errors (including "not found") resolve to false.
   */
  handleBalance: (channel: string, username: string, args: string[]) => Promise<boolean>;
  handleLeaderboard: (channel: string, username: string) => Promise<boolean>;
  handleQuote: (channel: string, username: string) => Promise<boolean>;
  handleCounter: (channel: string, username: string, args: string[]) => Promise<boolean>;
  handleGamba: (channel: string, username: string, args: string[]) => Promise<boolean>;
  /** !duel @user [stake]: challenge someone; the duel runs once they accept */
  handleDuel: (channel: string, username: string, args: string[]) => Promise<boolean>;
  /** !duel accept / !duel decline from the challenged user */
  handleDuelResponse: (channel: string, username: string, accept: boolean) => Promise<boolean>;
}

/** A duel challenge waiting for the opponent's answer */
interface PendingDuel {
  challenger: string;
  stake: number;
  expiresAt: number;
}

// Cache for loyalty config (TTL: 5 minutes)
const LOYALTY_CONFIG_CACHE_TTL = 5 * 60 * 1000;
/** How long a challenged user has to answer a duel */
export const DUEL_ACCEPT_SECONDS = 60;
const DEFAULT_DUEL_STAKE = 50;

export function createLoyaltyCommands(ctx: BotContext, dashboard: DashboardClient): LoyaltyCommands {
  const { http, dashboardBaseUrl, sendChatMessage } = ctx;
  const { logCommandExecution } = dashboard;

  let loyaltyConfigCache: LoyaltyConfig | null = null;
  let loyaltyConfigCacheTime = 0;
  /** opponent (lowercase) -> the challenge they can accept; expired entries are dropped on use */
  const pendingDuels = new Map<string, PendingDuel>();

  async function currencyName(): Promise<string> {
    return (await getLoyaltyConfig()).currencyNamePlural || 'points';
  }

  async function getLoyaltyConfig(): Promise<LoyaltyConfig> {
    const now = Date.now();
    if (loyaltyConfigCache && (now - loyaltyConfigCacheTime) < LOYALTY_CONFIG_CACHE_TTL) {
      return loyaltyConfigCache;
    }
    try {
      const response = await http.get(`${dashboardBaseUrl}/api/loyalty/config`, { timeout: 3000 });
      loyaltyConfigCache = response.data;
      loyaltyConfigCacheTime = now;
      return loyaltyConfigCache as LoyaltyConfig;
    } catch {
      return { currencyNamePlural: 'points' };
    }
  }

  async function handleBalance(channel: string, username: string, args: string[]): Promise<boolean> {
    // Sanitize input: strip @ symbols, trim whitespace
    const targetUser = (args[0] || username).replace(/^@+/, '').trim();
    if (!targetUser) {
      sendChatMessage(channel, `@${username} Invalid username.`);
      return false; // Don't apply cooldown on invalid input
    }
    try {
      const encodedUser = encodeURIComponent(targetUser.toLowerCase());
      const response = await http.get(`${dashboardBaseUrl}/api/loyalty/user/${encodedUser}`, { timeout: 3000 });
      const userData = response.data;
      const config = await getLoyaltyConfig();
      const currencyName = config.currencyNamePlural || 'points';
      sendChatMessage(channel, `@${username} ${targetUser} has ${userData.points || 0} ${currencyName}${userData.rank ? ` (Rank: #${userData.rank})` : ''}`);
      logCommandExecution(username, '!balance', args, true);
      return true;
    } catch (e) {
      const error = e as HttpError;
      if (error.response?.status === 404) {
        sendChatMessage(channel, `@${username} User "${targetUser}" has no loyalty data yet.`);
      } else {
        sendChatMessage(channel, `@${username} Error: Could not fetch balance.`);
      }
      logCommandExecution(username, '!balance', args, false);
      return false;
    }
  }

  async function handleLeaderboard(channel: string, username: string): Promise<boolean> {
    try {
      const response = await http.get(`${dashboardBaseUrl}/api/loyalty/leaderboard?limit=5`, { timeout: 3000 });
      const leaderboard: Array<{ rank: number; username: string; points: number }> = response.data;
      if (leaderboard.length === 0) {
        sendChatMessage(channel, `No loyalty data available yet.`);
        logCommandExecution(username, '!leaderboard', [], false); // Log empty results as unsuccessful
        return false;
      }
      const currency = await currencyName();
      const message = 'Top Loyalists: ' + leaderboard.map(u => `${u.rank}. ${u.username} (${u.points} ${currency})`).join(' | ');
      sendChatMessage(channel, message);
      logCommandExecution(username, '!leaderboard', [], true);
      return true;
    } catch (error) {
      sendChatMessage(channel, `Error: Could not fetch leaderboard.`);
      logCommandExecution(username, '!leaderboard', [], false);
      return false;
    }
  }

  async function handleQuote(channel: string, username: string): Promise<boolean> {
    try {
      const response = await http.get(`${dashboardBaseUrl}/api/quotes/random`, { timeout: 3000 });
      const quote = response.data;
      sendChatMessage(channel, `"${quote.text}" — ${quote.addedBy || 'Unknown'}${quote.game ? ` (${quote.game})` : ''}`);
      logCommandExecution(username, '!quote', [], true);
      return true;
    } catch (e) {
      const error = e as HttpError;
      if (error.response?.status === 404) {
        sendChatMessage(channel, `No quotes available yet.`);
      } else {
        sendChatMessage(channel, `Error: Could not fetch quote.`);
      }
      logCommandExecution(username, '!quote', [], false);
      return false;
    }
  }

  async function handleCounter(channel: string, username: string, args: string[]): Promise<boolean> {
    if (!args[0]) {
      sendChatMessage(channel, `@${username} Usage: !counter <name>`);
      return false; // Don't apply cooldown on invalid input
    }
    // Sanitize input: join all args (supports multi-word names), trim, and URL encode
    const counterName = args.join(' ').trim();
    if (!counterName) {
      sendChatMessage(channel, `@${username} Invalid counter name.`);
      return false; // Don't apply cooldown on invalid input
    }
    try {
      const encodedName = encodeURIComponent(counterName);
      const response = await http.get(`${dashboardBaseUrl}/api/counters/${encodedName}`, { timeout: 3000 });
      const counter = response.data;
      sendChatMessage(channel, `${counter.name}: ${counter.value}`);
      logCommandExecution(username, '!counter', args, true);
      return true;
    } catch (e) {
      const error = e as HttpError;
      if (error.response?.status === 404) {
        sendChatMessage(channel, `@${username} Counter "${counterName}" not found.`);
      } else {
        sendChatMessage(channel, `@${username} Error: Could not fetch counter.`);
      }
      logCommandExecution(username, '!counter', args, false);
      return false;
    }
  }

  async function handleGamba(channel: string, username: string, args: string[]): Promise<boolean> {
    const raw = (args[0] || '').toString().trim().toLowerCase();

    // Require explicit amount
    if (!raw) {
      sendChatMessage(channel, `@${username} Usage: !gamba <amount> or !gamba all — bet points (50% win = 2x, 50% lose).`);
      return false;
    }

    const amount = raw === 'all' ? 'all' : parseWholeNumber(raw);

    // Validate numeric amounts
    if (amount !== 'all' && (Number.isNaN(amount) || amount < 1)) {
      sendChatMessage(channel, `@${username} Usage: !gamba <amount> or !gamba all — bet points (50% win = 2x, 50% lose).`);
      return false;
    }

    try {
      const response = await http.post(`${dashboardBaseUrl}/api/loyalty/gamba`, {
        username: username.toLowerCase(),
        amount: raw === 'all' ? 'all' : amount
      }, { timeout: 5000 });
      const data = response.data;
      const config = await getLoyaltyConfig();
      const currency = config.currencyNamePlural || 'points';

      // Format balance display with fallback for older API versions
      const balanceDisplay = data.oldBalance !== undefined
        ? `Balance: ${data.oldBalance} → ${data.newBalance}.`
        : `New balance: ${data.newBalance}.`;

      if (data.won) {
        // `winnings` is the 2x payout, which includes the returned stake; report the profit
        const profit = data.amountBet !== undefined ? data.winnings - data.amountBet : data.winnings;
        sendChatMessage(channel, `@${username} won ${profit} ${currency}! ${balanceDisplay}`);
      } else {
        sendChatMessage(channel, `@${username} lost ${data.amountBet} ${currency}. ${balanceDisplay} Better luck next time!`);
      }
      logCommandExecution(username, '!gamba', args, true);
      return true;
    } catch (e) {
      const error = e as HttpError;
      const errMsg = error.response?.data?.error || error.message;
      sendChatMessage(channel, `@${username} ${errMsg}`);
      logCommandExecution(username, '!gamba', args, false);
      return false;
    }
  }

  async function handleDuel(channel: string, username: string, args: string[]): Promise<boolean> {
    const opponentRaw = (args[0] || '').replace(/^@+/, '').trim();
    const stakeRaw = args[1];
    if (!opponentRaw) {
      sendChatMessage(channel, `@${username} Usage: !duel @<user> [stake] — challenge someone (default stake 50 points).`);
      return false;
    }
    const challenger = username.toLowerCase();
    const opponent = opponentRaw.toLowerCase();
    if (challenger === opponent) {
      sendChatMessage(channel, `@${username} You cannot duel yourself.`);
      return false;
    }
    const stake = stakeRaw ? parseWholeNumber(stakeRaw) : DEFAULT_DUEL_STAKE;
    const amount = Number.isFinite(stake) && stake >= 1 ? stake : DEFAULT_DUEL_STAKE;

    const pending = pendingDuels.get(opponent);
    if (pending && pending.expiresAt > Date.now() && pending.challenger !== challenger) {
      sendChatMessage(channel, `@${username} ${opponent} already has a duel challenge waiting. Try again later.`);
      return false;
    }
    pendingDuels.set(opponent, { challenger, stake: amount, expiresAt: Date.now() + DUEL_ACCEPT_SECONDS * 1000 });
    const currency = await currencyName();
    sendChatMessage(channel, `@${opponent} ${challenger} challenges you to a duel for ${amount} ${currency}! Type !duel accept or !duel decline within ${DUEL_ACCEPT_SECONDS}s.`);
    return true;
  }

  async function handleDuelResponse(channel: string, username: string, accept: boolean): Promise<boolean> {
    const opponent = username.toLowerCase();
    const pending = pendingDuels.get(opponent);
    pendingDuels.delete(opponent);
    if (!pending || pending.expiresAt <= Date.now()) {
      sendChatMessage(channel, `@${username} You have no duel challenge to answer.`);
      return false;
    }
    const { challenger, stake } = pending;
    if (!accept) {
      sendChatMessage(channel, `@${challenger} ${opponent} declined your duel.`);
      return true;
    }

    const logArgs = [challenger, opponent, String(stake)];
    try {
      const response = await http.post(`${dashboardBaseUrl}/api/loyalty/duel`, {
        challenger,
        opponent,
        stake
      }, { timeout: 5000 });
      const data = response.data;
      const currency = await currencyName();
      sendChatMessage(channel, `@${challenger} @${opponent} Duel! ${data.winner} wins ${stake * 2} ${currency}! ${challenger}: ${data.challengerBalance} | ${opponent}: ${data.opponentBalance}.`);
      logCommandExecution(username, '!duel accept', logArgs, true);
      return true;
    } catch (e) {
      const error = e as HttpError;
      const errMsg = error.response?.data?.error || error.message;
      sendChatMessage(channel, `@${challenger} @${opponent} ${errMsg}`);
      logCommandExecution(username, '!duel accept', logArgs, false);
      return false;
    }
  }

  return { getLoyaltyConfig, handleBalance, handleLeaderboard, handleQuote, handleCounter, handleGamba, handleDuel, handleDuelResponse };
}
