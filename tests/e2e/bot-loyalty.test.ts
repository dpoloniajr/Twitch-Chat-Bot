/**
 * E2E characterization: loyalty chat commands (!balance, !leaderboard, !gamba, !duel)
 * plus !quote and !counter. These call the real dashboard routes
 * (dashboard/routes/loyalty.js, quotes.js, counters.js, dashboard/lib/loyalty-store.js),
 * so assertions cover both the chat output and the data files they leave behind.
 *
 * Default built-in cooldowns come from dashboard/server.js initLogs():
 * !balance 5s, !leaderboard 10s, !gamba 10s, !duel 15s, !quote 5s, !counter 5s.
 * Cooldowns are global per command (not per user): Excella.js keys them by command name.
 * Only a successful command starts its cooldown; usage errors and dashboard errors do not.
 */
jest.mock('axios', () => require('./harness/redirect').axiosMock());
jest.mock('ws', () => require('./harness/redirect').wsMock());
jest.mock('tmi.js', () => require('./harness/redirect').tmiMock());
jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('../../src/lib/console-timestamp', () => ({}));

import * as fs from 'fs';
import * as path from 'path';
import { BotHarness, BotOptions } from './harness/bot';
import { chatPumped, loyaltyFile, silenceConsole, startReadyBot, talk } from './harness/loyalty-helpers';

interface LoyaltyUser {
  points: number;
  totalSpent?: number;
  totalEarned?: number;
}
interface LoyaltyTx {
  username: string;
  amount: number;
  type: string;
  reason: string;
  balance: number;
}
interface LoyaltyData {
  users: Record<string, LoyaltyUser>;
  config: Record<string, unknown>;
  transactions: LoyaltyTx[];
}
interface CommandLog {
  user: string;
  command: string;
  success: boolean;
}

const BASE_USERS = { alice: { points: 100 }, bob: { points: 250 }, carol: { points: 5 } };

describe('bot loyalty commands', () => {
  let bot: BotHarness | null = null;

  async function start(options: BotOptions = {}): Promise<BotHarness> {
    bot = await startReadyBot(options);
    return bot;
  }
  function withLoyalty(users: Record<string, { points: number }> = BASE_USERS, config: Record<string, unknown> = {}): BotOptions {
    return { dashboardData: { 'loyalty.json': loyaltyFile(users, config) } };
  }
  const logsFor = (b: BotHarness, command: string) =>
    b.dashboardCalls().filter((c) => c.route === 'POST /api/logs' && c.body.command === command).map((c) => c.body);

  beforeEach(() => {
    silenceConsole();
  });
  afterEach(async () => {
    if (bot) await bot.stop();
    bot = null;
  });

  describe('!balance', () => {
    it('shows the caller balance and rank using the configured currency name', async () => {
      const b = await start(withLoyalty());
      expect(await talk(b, 'alice', '!balance')).toEqual(['@alice alice has 100 coins (Rank: #2)']);
      expect(b.dashboardCalls().map((c) => c.route)).toEqual(expect.arrayContaining([
        'GET /api/loyalty/user/alice', 'GET /api/loyalty/config'
      ]));
      expect(logsFor(b, '!balance')).toEqual([expect.objectContaining({ user: 'alice', args: '', success: true })]);
    });

    it('looks up another user, stripping @ but keeping the typed casing in the reply', async () => {
      const b = await start(withLoyalty());
      expect(await talk(b, 'alice', '!balance @@Bob')).toEqual(['@alice Bob has 250 coins (Rank: #1)']);
      expect(b.dashboardCalls().some((c) => c.route === 'GET /api/loyalty/user/bob')).toBe(true);
    });

    it('reports a user with no data (404) without starting the cooldown', async () => {
      const b = await start(withLoyalty());
      expect(await talk(b, 'alice', '!balance nobody')).toEqual(['@alice User "nobody" has no loyalty data yet.']);
      expect(logsFor(b, '!balance')).toEqual([expect.objectContaining({ args: 'nobody', success: false })]);
      expect(await talk(b, 'alice', '!balance')).toEqual(['@alice alice has 100 coins (Rank: #2)']);
      expect(await talk(b, 'alice', '!balance')).toEqual(['@alice !balance is on cooldown. Try again in 5s.']);
    });

    it('rejects a bare "@" as an invalid username without calling the dashboard or starting a cooldown', async () => {
      const b = await start(withLoyalty());
      expect(await talk(b, 'alice', '!balance @')).toEqual(['@alice Invalid username.']);
      expect(b.dashboardCalls().some((c) => c.route.startsWith('GET /api/loyalty/user'))).toBe(false);
      expect(await talk(b, 'alice', '!balance')).toEqual(['@alice alice has 100 coins (Rank: #2)']);
    });

    it('shows 0 for a user with zero points', async () => {
      const b = await start(withLoyalty({ alice: { points: 0 } }));
      expect(await talk(b, 'alice', '!balance')).toEqual(['@alice alice has 0 coins (Rank: #1)']);
    });

    it('cooldown is global across users and expires after 5s', async () => {
      const b = await start(withLoyalty());
      await talk(b, 'alice', '!balance');
      expect(await talk(b, 'bob', '!balance')).toEqual(['@bob !balance is on cooldown. Try again in 5s.']);
      await b.advance(3000);
      expect(await talk(b, 'bob', '!balance')).toEqual(['@bob !balance is on cooldown. Try again in 2s.']);
      await b.advance(2000);
      expect(await talk(b, 'bob', '!balance')).toEqual(['@bob bob has 250 coins (Rank: #1)']);
    });

    it('uses the cooldown from builtinCommands.json (0 = no cooldown)', async () => {
      const b = await start({
        dashboardData: {
          'loyalty.json': loyaltyFile(BASE_USERS),
          'builtinCommands.json': [{ name: '!balance', cooldownSeconds: 0 }]
        }
      });
      expect(await talk(b, 'alice', '!balance')).toHaveLength(1);
      expect(await talk(b, 'alice', '!balance')).toEqual(['@alice alice has 100 coins (Rank: #2)']);
    });

    it('without loyalty.json the first chat message creates it with defaults and earns points', async () => {
      const b = await start();
      expect(fs.existsSync(path.join(b.logsDir, 'loyalty.json'))).toBe(false);
      // A first message earns 5 points (the default); the next one is inside the 30s message cooldown
      await talk(b, 'alice', 'hello');
      expect(await talk(b, 'alice', '!balance')).toEqual(['@alice alice has 5 points (Rank: #1)']);
      const data = b.readData<LoyaltyData>('loyalty.json');
      expect(data.users.alice).toEqual(expect.objectContaining({ points: 5, messageCount: 2 }));
      expect(data.config).toEqual(expect.objectContaining({ pointsPerMessage: 5, currencyNamePlural: 'points', enabled: true }));
    });

    it('a corrupt loyalty.json is kept (with a backup copy) and reported as an error', async () => {
      const b = await start();
      const file = path.join(b.logsDir, 'loyalty.json');
      fs.writeFileSync(file, '{ not json');
      expect(await talk(b, 'alice', '!balance')).toEqual(['@alice Error: Could not fetch balance.']);
      expect(fs.readFileSync(file, 'utf8')).toBe('{ not json');
      expect(fs.readdirSync(b.logsDir).some((f) => f.startsWith('loyalty.json.corrupt-'))).toBe(true);
    });

    it('caches the loyalty config for 5 minutes', async () => {
      const b = await start({
        ...withLoyalty(),
        dashboardData: {
          // No watch-time points, so the balance stays put while the clock advances
          'loyalty.json': loyaltyFile(BASE_USERS, { pointsPerMinute: 0 }),
          'builtinCommands.json': [{ name: '!balance', cooldownSeconds: 0 }]
        }
      });
      expect(await talk(b, 'alice', '!balance')).toEqual(['@alice alice has 100 coins (Rank: #2)']);
      const data = b.readData<LoyaltyData>('loyalty.json');
      data.config.currencyNamePlural = 'gems';
      b.writeData('loyalty.json', data);
      expect(await talk(b, 'alice', '!balance')).toEqual(['@alice alice has 100 coins (Rank: #2)']);
      await b.advance(5 * 60 * 1000);
      expect(await talk(b, 'alice', '!balance')).toEqual(['@alice alice has 100 gems (Rank: #2)']);
    });
  });

  describe('!leaderboard', () => {
    it('lists the top users by points with the configured currency name', async () => {
      const b = await start(withLoyalty());
      expect(await talk(b, 'alice', '!leaderboard')).toEqual([
        'Top Loyalists: 1. bob (250 coins) | 2. alice (100 coins) | 3. carol (5 coins)'
      ]);
      expect(b.dashboardCalls().some((c) => c.route === 'GET /api/loyalty/leaderboard')).toBe(true);
      expect(logsFor(b, '!leaderboard')).toEqual([expect.objectContaining({ user: 'alice', success: true })]);
    });

    it('shows at most 5 entries', async () => {
      const users: Record<string, { points: number }> = {};
      for (let i = 1; i <= 7; i++) users[`user${i}`] = { points: i * 10 };
      const b = await start(withLoyalty(users));
      const [line] = await talk(b, 'alice', '!leaderboard');
      expect(line).toBe('Top Loyalists: 1. user7 (70 coins) | 2. user6 (60 coins) | 3. user5 (50 coins) | 4. user4 (40 coins) | 5. user3 (30 coins)');
    });

    it('says there is no data when nobody has points, logs failure, and starts no cooldown', async () => {
      // Loyalty disabled, so the chat messages themselves create no user records
      const b = await start(withLoyalty({}, { enabled: false }));
      expect(await talk(b, 'alice', '!leaderboard')).toEqual(['No loyalty data available yet.']);
      expect(logsFor(b, '!leaderboard')).toEqual([expect.objectContaining({ success: false })]);
      expect(await talk(b, 'bob', '!leaderboard')).toEqual(['No loyalty data available yet.']);
    });

    it('a successful leaderboard starts the 10s cooldown', async () => {
      const b = await start(withLoyalty());
      expect(await talk(b, 'alice', '!leaderboard')).toHaveLength(1);
      expect(await talk(b, 'bob', '!leaderboard')).toEqual(['@bob !leaderboard is on cooldown. Try again in 10s.']);
    });
  });

  describe('!gamba', () => {
    it.each([
      ['!gamba'],
      ['!gamba abc'],
      ['!gamba 0'],
      ['!gamba -5'],
      ['!gamba 10abc'],
      ['!gamba 2.5'],
      ['!gamba allin']
    ])('"%s" replies with usage, calls nothing and starts no cooldown', async (text) => {
      const b = await start(withLoyalty());
      expect(await talk(b, 'alice', text)).toEqual([
        '@alice Usage: !gamba <amount> or !gamba all — bet points (50% win = 2x, 50% lose).'
      ]);
      expect(b.dashboardCalls().some((c) => c.route === 'POST /api/loyalty/gamba')).toBe(false);
      jest.spyOn(Math, 'random').mockReturnValue(0.9);
      expect(await chatPumped(b, 'alice', '!gamba 1')).toEqual(['@alice lost 1 coins. Balance: 100 → 99. Better luck next time!']);
    });

    it('a win pays 2x the bet on top of the deducted stake, reports the profit, and records both transactions', async () => {
      const b = await start(withLoyalty());
      jest.spyOn(Math, 'random').mockReturnValue(0.1);
      expect(await chatPumped(b, 'alice', '!gamba 10')).toEqual(['@alice won 10 coins! Balance: 100 → 110.']);
      expect(b.dashboardCalls().find((c) => c.route === 'POST /api/loyalty/gamba')?.body).toEqual({ username: 'alice', amount: 10 });
      const data = b.readData<LoyaltyData>('loyalty.json');
      expect(data.users.alice).toEqual(expect.objectContaining({ points: 110, totalSpent: 10, totalEarned: 20 }));
      expect(data.transactions.map(({ username, amount, type, reason, balance }) => ({ username, amount, type, reason, balance }))).toEqual([
        { username: 'alice', amount: -10, type: 'spend', reason: 'Gamba bet', balance: 90 },
        { username: 'alice', amount: 20, type: 'bonus', reason: 'Gamba win', balance: 110 }
      ]);
      expect(logsFor(b, '!gamba')).toEqual([expect.objectContaining({ user: 'alice', args: '10', success: true })]);
    });

    it('a loss deducts the bet', async () => {
      const b = await start(withLoyalty());
      jest.spyOn(Math, 'random').mockReturnValue(0.5);
      expect(await chatPumped(b, 'alice', '!gamba 10')).toEqual(['@alice lost 10 coins. Balance: 100 → 90. Better luck next time!']);
      expect(b.readData<LoyaltyData>('loyalty.json').users.alice.points).toBe(90);
    });

    it('"all" (any case) bets the whole balance', async () => {
      const b = await start(withLoyalty());
      jest.spyOn(Math, 'random').mockReturnValue(0.1);
      expect(await chatPumped(b, 'alice', '!gamba ALL')).toEqual(['@alice won 100 coins! Balance: 100 → 200.']);
      expect(b.dashboardCalls().find((c) => c.route === 'POST /api/loyalty/gamba')?.body).toEqual({ username: 'alice', amount: 'all' });
    });

    it('"all" with a zero balance is rejected by the dashboard', async () => {
      const b = await start(withLoyalty({ alice: { points: 0 } }));
      expect(await chatPumped(b, 'alice', '!gamba all')).toEqual(['@alice You have no points to bet.']);
    });

    it('betting more than the balance is rejected, file unchanged, and no cooldown starts', async () => {
      const b = await start(withLoyalty());
      expect(await chatPumped(b, 'alice', '!gamba 101')).toEqual(['@alice Insufficient points. You have 100.']);
      expect(b.readData<LoyaltyData>('loyalty.json').users.alice.points).toBe(100);
      expect(b.readData<LoyaltyData>('loyalty.json').transactions).toEqual([]);
      expect(logsFor(b, '!gamba')).toEqual([expect.objectContaining({ success: false })]);
      jest.spyOn(Math, 'random').mockReturnValue(0.9);
      expect(await chatPumped(b, 'alice', '!gamba 1')).toEqual(['@alice lost 1 coins. Balance: 100 → 99. Better luck next time!']);
    });

    it('bets above 10000 are rejected', async () => {
      const b = await start(withLoyalty({ alice: { points: 50_000 } }));
      expect(await chatPumped(b, 'alice', '!gamba 10001')).toEqual(['@alice Bet must be between 1 and 10000 points.']);
    });

    it('"all" is capped at 10000', async () => {
      const b = await start(withLoyalty({ alice: { points: 50_000 } }));
      jest.spyOn(Math, 'random').mockReturnValue(0.9);
      expect(await chatPumped(b, 'alice', '!gamba all')).toEqual(['@alice lost 10000 coins. Balance: 50000 → 40000. Better luck next time!']);
    });

    it('a new user (created with 0 points by their own message) cannot bet', async () => {
      const b = await start(withLoyalty());
      expect(await chatPumped(b, 'dave', '!gamba 5')).toEqual(['@dave Insufficient points. You have 0.']);
    });

    it('without loyalty.json the message creates it and its earned points can be bet', async () => {
      const b = await start();
      jest.spyOn(Math, 'random').mockReturnValue(0.9);
      expect(await chatPumped(b, 'alice', '!gamba 5')).toEqual(['@alice lost 5 points. Balance: 5 → 0. Better luck next time!']);
      expect(fs.existsSync(path.join(b.logsDir, 'loyalty.json'))).toBe(true);
    });

    it('has a 10s global cooldown after a bet', async () => {
      const b = await start(withLoyalty());
      jest.spyOn(Math, 'random').mockReturnValue(0.9);
      await chatPumped(b, 'alice', '!gamba 10');
      expect(await talk(b, 'bob', '!gamba 10')).toEqual(['@bob !gamba is on cooldown. Try again in 10s.']);
      await b.advance(10_000);
      expect(await chatPumped(b, 'bob', '!gamba 10')).toEqual(['@bob lost 10 coins. Balance: 250 → 240. Better luck next time!']);
    });
  });

  describe('!duel', () => {
    const CHALLENGE = (opponent: string, challenger: string, stake = 50) =>
      `@${opponent} ${challenger} challenges you to a duel for ${stake} coins! Type !duel accept or !duel decline within 60s.`;
    const duelCalls = (b: BotHarness) => b.dashboardCalls().filter((c) => c.route === 'POST /api/loyalty/duel');

    it('replies with usage when no opponent is given (no cooldown)', async () => {
      const b = await start(withLoyalty());
      expect(await talk(b, 'alice', '!duel')).toEqual(['@alice Usage: !duel @<user> [stake] — challenge someone (default stake 50 points).']);
      expect(await talk(b, 'alice', '!duel @')).toEqual(['@alice Usage: !duel @<user> [stake] — challenge someone (default stake 50 points).']);
      expect(duelCalls(b)).toHaveLength(0);
      expect(await talk(b, 'alice', '!duel bob')).toEqual([CHALLENGE('bob', 'alice')]);
    });

    it('refuses a duel against yourself, case-insensitively', async () => {
      const b = await start(withLoyalty());
      expect(await talk(b, 'alice', '!duel @ALICE')).toEqual(['@alice You cannot duel yourself.']);
    });

    it('a challenge moves no points until the opponent accepts; then the default stake of 50 is fought for', async () => {
      const b = await start(withLoyalty());
      jest.spyOn(Math, 'random').mockReturnValue(0.1);
      expect(await talk(b, 'alice', '!duel @Bob')).toEqual([CHALLENGE('bob', 'alice')]);
      expect(duelCalls(b)).toHaveLength(0);
      expect(b.readData<LoyaltyData>('loyalty.json').transactions).toEqual([]);

      expect(await chatPumped(b, 'bob', '!duel accept')).toEqual(['@alice @bob Duel! alice wins 100 coins! alice: 150 | bob: 200.']);
      expect(duelCalls(b).map((c) => c.body)).toEqual([{ challenger: 'alice', opponent: 'bob', stake: 50 }]);
      const data = b.readData<LoyaltyData>('loyalty.json');
      expect(data.users.alice.points).toBe(150);
      expect(data.users.bob.points).toBe(200);
      expect(data.transactions.map((t) => [t.username, t.amount, t.reason])).toEqual([
        ['alice', -50, 'Duel stake'], ['bob', -50, 'Duel stake'], ['alice', 100, 'Duel win']
      ]);
      expect(logsFor(b, '!duel accept')).toEqual([expect.objectContaining({ user: 'bob', args: 'alice bob 50', success: true })]);
      // The challenge is used up
      expect(await talk(b, 'bob', '!duel accept')).toEqual(['@bob You have no duel challenge to answer.']);
    });

    it('uses a custom stake; opponent wins', async () => {
      const b = await start(withLoyalty());
      jest.spyOn(Math, 'random').mockReturnValue(0.5);
      expect(await talk(b, 'alice', '!duel bob 30')).toEqual([CHALLENGE('bob', 'alice', 30)]);
      expect(await chatPumped(b, 'BOB', '!DUEL ACCEPT')).toEqual(['@alice @bob Duel! bob wins 60 coins! alice: 70 | bob: 280.']);
    });

    it.each([['abc'], ['0'], ['-5'], ['30abc']])('invalid stake "%s" falls back to 50', async (stake) => {
      const b = await start(withLoyalty());
      jest.spyOn(Math, 'random').mockReturnValue(0.1);
      expect(await talk(b, 'alice', `!duel bob ${stake}`)).toEqual([CHALLENGE('bob', 'alice')]);
      await chatPumped(b, 'bob', '!duel accept');
      expect(duelCalls(b)[0].body.stake).toBe(50);
    });

    it('the opponent can decline: nothing is written', async () => {
      const b = await start(withLoyalty());
      await talk(b, 'alice', '!duel bob');
      expect(await talk(b, 'bob', '!duel decline')).toEqual(['@alice bob declined your duel.']);
      expect(await talk(b, 'bob', '!duel accept')).toEqual(['@bob You have no duel challenge to answer.']);
      expect(duelCalls(b)).toHaveLength(0);
      expect(b.readData<LoyaltyData>('loyalty.json').transactions).toEqual([]);
    });

    it('a challenge expires after 60s', async () => {
      const b = await start(withLoyalty());
      await talk(b, 'alice', '!duel bob');
      await b.advance(60_000);
      expect(await talk(b, 'bob', '!duel accept')).toEqual(['@bob You have no duel challenge to answer.']);
      expect(duelCalls(b)).toHaveLength(0);
    });

    it('only the challenged user can answer', async () => {
      const b = await start(withLoyalty());
      await talk(b, 'alice', '!duel bob');
      expect(await talk(b, 'carol', '!duel accept')).toEqual(['@carol You have no duel challenge to answer.']);
      expect(await talk(b, 'alice', '!duel accept')).toEqual(['@alice You have no duel challenge to answer.']);
      expect(duelCalls(b)).toHaveLength(0);
    });

    it('a user with a pending challenge cannot be challenged by someone else until it expires', async () => {
      const b = await start({ dashboardData: { 'loyalty.json': loyaltyFile(BASE_USERS), 'builtinCommands.json': [{ name: '!duel', cooldownSeconds: 0 }] } });
      await talk(b, 'alice', '!duel bob');
      expect(await talk(b, 'carol', '!duel bob')).toEqual(['@carol bob already has a duel challenge waiting. Try again later.']);
      // The challenger may restate their own challenge, e.g. with a new stake
      expect(await talk(b, 'alice', '!duel bob 20')).toEqual([CHALLENGE('bob', 'alice', 20)]);
      await b.advance(60_000);
      expect(await talk(b, 'carol', '!duel bob 5')).toEqual([CHALLENGE('bob', 'carol', 5)]);
    });

    it('issuing a challenge starts the 15s cooldown, but answering is not blocked by it', async () => {
      const b = await start(withLoyalty());
      jest.spyOn(Math, 'random').mockReturnValue(0.1);
      await talk(b, 'alice', '!duel bob');
      expect(await talk(b, 'carol', '!duel alice')).toEqual(['@carol !duel is on cooldown. Try again in 15s.']);
      expect(await chatPumped(b, 'bob', '!duel accept')).toEqual(['@alice @bob Duel! alice wins 100 coins! alice: 150 | bob: 200.']);
    });

    it('challenger without enough points: error on accept, nothing written', async () => {
      const b = await start(withLoyalty());
      await talk(b, 'alice', '!duel bob 500');
      expect(await chatPumped(b, 'bob', '!duel accept')).toEqual(["@alice @bob alice doesn't have enough points (100). Need 500."]);
      expect(b.readData<LoyaltyData>('loyalty.json').transactions).toEqual([]);
      expect(logsFor(b, '!duel accept')).toEqual([expect.objectContaining({ args: 'alice bob 500', success: false })]);
    });

    it('opponent without enough points (or unknown) is refused and not persisted', async () => {
      const b = await start({ dashboardData: { 'loyalty.json': loyaltyFile(BASE_USERS), 'builtinCommands.json': [{ name: '!duel', cooldownSeconds: 0 }] } });
      await talk(b, 'alice', '!duel carol');
      expect(await chatPumped(b, 'carol', '!duel accept')).toEqual(["@alice @carol carol doesn't have enough points (5). Need 50."]);
      await talk(b, 'alice', '!duel @Nobody 10');
      expect(await chatPumped(b, 'nobody', '!duel accept')).toEqual(["@alice @nobody nobody doesn't have enough points (0). Need 10."]);
      const data = b.readData<LoyaltyData>('loyalty.json');
      expect(data.transactions).toEqual([]);
      expect([data.users.alice.points, data.users.bob.points, data.users.carol.points]).toEqual([100, 250, 5]);
    });
  });

  describe('!quote', () => {
    const quotes = (list: Array<Record<string, unknown>>) => ({
      'quotes.json': { quotes: list, config: { maxQuotes: 10000, minLength: 5, maxLength: 500, allowDuplicates: false }, nextId: list.length + 1 }
    });

    it('shows a random quote with author and game', async () => {
      const b = await start({ dashboardData: quotes([
        { id: 1, text: 'First quote', addedBy: 'bob', game: 'Chess' },
        { id: 2, text: 'Second quote', addedBy: 'carol' }
      ]) });
      jest.spyOn(Math, 'random').mockReturnValue(0.99);
      expect(await talk(b, 'alice', '!quote')).toEqual(['"Second quote" — carol']);
      expect(logsFor(b, '!quote')).toEqual([expect.objectContaining({ user: 'alice', success: true })]);
      await b.advance(5000);
      jest.spyOn(Math, 'random').mockReturnValue(0);
      expect(await talk(b, 'alice', '!quote')).toEqual(['"First quote" — bob (Chess)']);
    });

    it('falls back to "Unknown" when the quote has no author', async () => {
      const b = await start({ dashboardData: quotes([{ id: 1, text: 'Orphan quote' }]) });
      expect(await talk(b, 'alice', '!quote')).toEqual(['"Orphan quote" — Unknown']);
    });

    it('with no quotes says so, creates quotes.json, and starts no cooldown', async () => {
      const b = await start();
      expect(await talk(b, 'alice', '!quote')).toEqual(['No quotes available yet.']);
      expect(b.readData<{ quotes: unknown[] }>('quotes.json').quotes).toEqual([]);
      expect(logsFor(b, '!quote')).toEqual([expect.objectContaining({ success: false })]);
      expect(await talk(b, 'bob', '!quote')).toEqual(['No quotes available yet.']);
    });

    it('a quote starts the 5s cooldown', async () => {
      const b = await start({ dashboardData: quotes([{ id: 1, text: 'Only quote', addedBy: 'bob' }]) });
      expect(await talk(b, 'alice', '!quote')).toEqual(['"Only quote" — bob']);
      expect(await talk(b, 'bob', '!quote')).toEqual(['@bob !quote is on cooldown. Try again in 5s.']);
    });
  });

  describe('!counter', () => {
    const counters = {
      'counters.json': {
        counters: {
          deaths: { name: 'deaths', value: 7 },
          boss_kills: { name: 'boss_kills', value: 3 }
        },
        history: [],
        config: { maxCounters: 100, maxValue: 999999, minValue: -999999, keepHistory: true, maxHistoryEntries: 100 }
      }
    };

    it('shows a counter value (name is case-insensitive)', async () => {
      const b = await start({ dashboardData: counters });
      const out = await talk(b, 'alice', '!counter Deaths');
      expect(out).toEqual(['deaths: 7']);
      expect(b.dashboardCalls().some((c) => c.route === 'GET /api/counters/Deaths')).toBe(true);
      expect(logsFor(b, '!counter')).toEqual([expect.objectContaining({ args: 'Deaths', success: true })]);
    });

    it('joins multi-word names; the dashboard maps spaces to underscores', async () => {
      const b = await start({ dashboardData: counters });
      expect(await talk(b, 'alice', '!counter boss   kills')).toEqual(['boss_kills: 3']);
      expect(b.dashboardCalls().some((c) => c.route === 'GET /api/counters/boss%20kills')).toBe(true);
    });

    it('is read-only: it never changes the counter', async () => {
      const b = await start({ dashboardData: counters });
      await talk(b, 'alice', '!counter deaths +1');
      expect(b.readData<{ counters: Record<string, { value: number }> }>('counters.json').counters.deaths.value).toBe(7);
    });

    it('without counters.json the default counters are created', async () => {
      const b = await start();
      expect(await talk(b, 'alice', '!counter deaths')).toEqual(['deaths: 0']);
      expect(Object.keys(b.readData<{ counters: object }>('counters.json').counters)).toEqual(['deaths', 'wins', 'losses']);
    });

    it('usage without a name (no cooldown)', async () => {
      const b = await start({ dashboardData: counters });
      expect(await talk(b, 'alice', '!counter')).toEqual(['@alice Usage: !counter <name>']);
      expect(await talk(b, 'alice', '!counter deaths')).toEqual(['deaths: 7']);
    });

    it('unknown counter reports not found without a cooldown; a found one applies the 5s cooldown', async () => {
      const b = await start({ dashboardData: counters });
      expect(await talk(b, 'alice', '!counter nope')).toEqual(['@alice Counter "nope" not found.']);
      expect(logsFor(b, '!counter')).toEqual([expect.objectContaining({ success: false })]);
      expect(await talk(b, 'alice', '!counter deaths')).toEqual(['deaths: 7']);
      expect(await talk(b, 'alice', '!counter deaths')).toEqual(['@alice !counter is on cooldown. Try again in 5s.']);
      await b.advance(4000);
      expect(await talk(b, 'alice', '!counter deaths')).toEqual(['@alice !counter is on cooldown. Try again in 1s.']);
      await b.advance(1000);
      expect(await talk(b, 'alice', '!counter deaths')).toEqual(['deaths: 7']);
    });
  });
});
