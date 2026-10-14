/**
 * Characterization: dashboard/routes/loyalty.js + dashboard/lib/loyalty-store.js (mounted at /api/loyalty)
 */
jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('../../../src/lib/console-timestamp', () => ({}));

import * as fs from 'fs';
import * as path from 'path';
import { startDashboard, silenceConsole, waitUntil, openWs, Dash } from './helpers';

const DEFAULT_CONFIG = {
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
};

const user = (points: number, extra: Record<string, unknown> = {}) => ({
  points, totalEarned: points, totalSpent: 0, watchTimeMinutes: 0, messageCount: 0,
  lastSeen: '2026-01-01T00:00:00.000Z', firstSeen: '2026-01-01T00:00:00.000Z', level: 1,
  lastMessagePointsAt: null, lastWatchTimeAwardedAt: null, ...extra
});

const seedLoyalty = (users: Record<string, unknown>, config: Record<string, unknown> = DEFAULT_CONFIG) =>
  ({ 'loyalty.json': { users, config, transactions: [] } });

describe('dashboard /api/loyalty', () => {
  let d: Dash;
  afterEach(async () => {
    await d.close();
  });

  describe('before loyalty.json exists', () => {
    beforeEach(async () => {
      silenceConsole();
      d = await startDashboard();
    });

    it('init() does not create loyalty.json', () => {
      expect(d.exists('loyalty.json')).toBe(false);
    });

    it('write routes create loyalty.json with the defaults on a fresh install', async () => {
      const award = await d.post('/api/loyalty/award-message', { username: 'Viewer' });
      expect(award.status).toBe(200);
      expect(award.json).toEqual({ success: true, pointsEarned: 5, newBalance: 5, onCooldown: false });
      const file = d.readJson('loyalty.json');
      expect(file.config).toEqual(DEFAULT_CONFIG);
      expect(file.users.viewer).toMatchObject({ points: 5, messageCount: 1 });
    });

    it.each([
      ['POST /add', 'POST', '/api/loyalty/add', { username: 'a', amount: 5 }, 200],
      ['PUT /user/:username/points', 'PUT', '/api/loyalty/user/a/points', { points: 5 }, 200],
      ['POST /deduct (unknown user)', 'POST', '/api/loyalty/deduct', { username: 'a', amount: 5 }, 404],
      ['POST /gamba (unknown user)', 'POST', '/api/loyalty/gamba', { username: 'a', amount: 1 }, 404],
      ['POST /duel (no points yet)', 'POST', '/api/loyalty/duel', { challenger: 'a', opponent: 'b' }, 400]
    ])('%s works on a fresh install instead of answering 503', async (_label, method, url, body, status) => {
      const res = await d.request(method, url, { body });
      expect(res.status).toBe(status);
      expect(d.readJson('loyalty.json').config).toEqual(DEFAULT_CONFIG);
    });

    it('GET / creates the file with the default config', async () => {
      const res = await d.get('/api/loyalty');
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ users: {}, config: DEFAULT_CONFIG, transactions: [], savedAt: expect.any(String) });
      expect(d.readJson('loyalty.json').config).toEqual(DEFAULT_CONFIG);
    });
  });

  describe('with loyalty.json', () => {
    beforeEach(async () => {
      silenceConsole();
      d = await startDashboard({ seed: seedLoyalty({ alice: user(100), bob: user(50, { level: 3, watchTimeMinutes: 12 }), carol: user(0) }) });
    });

    describe('config', () => {
      it('GET /config returns the config', async () => {
        expect((await d.get('/api/loyalty/config')).json).toEqual(DEFAULT_CONFIG);
      });

      it('PUT /config merges without validation', async () => {
        const res = await d.put('/api/loyalty/config', { pointsPerMessage: 7, junk: 'x' });
        expect(res.json).toEqual({ success: true, config: { ...DEFAULT_CONFIG, pointsPerMessage: 7, junk: 'x' } });
        expect(d.readJson('loyalty.json').config.junk).toBe('x');
      });
    });

    describe('reads', () => {
      it('GET /leaderboard sorts by points with ranks and a limit', async () => {
        const res = await d.get('/api/loyalty/leaderboard');
        expect(res.json).toEqual([
          { username: 'alice', points: 100, level: 1, watchTimeMinutes: 0, rank: 1 },
          { username: 'bob', points: 50, level: 3, watchTimeMinutes: 12, rank: 2 },
          { username: 'carol', points: 0, level: 1, watchTimeMinutes: 0, rank: 3 }
        ]);
        expect((await d.get('/api/loyalty/leaderboard?limit=1')).json).toHaveLength(1);
      });

      it('GET /user/:username is case-insensitive and includes rank; 404 when missing', async () => {
        const res = await d.get('/api/loyalty/user/BOB');
        expect(res.json).toEqual({ ...user(50, { level: 3, watchTimeMinutes: 12 }), username: 'bob', rank: 2 });
        const missing = await d.get('/api/loyalty/user/nobody');
        expect(missing.status).toBe(404);
        expect(missing.json).toEqual({ error: 'User not found' });
      });

      it('GET /stats aggregates users', async () => {
        expect((await d.get('/api/loyalty/stats')).json).toEqual({
          totalUsers: 3,
          totalPointsInCirculation: 150,
          totalPointsEarned: 150,
          totalPointsSpent: 0,
          averagePoints: 50,
          averageLevel: 1.7,
          topLevel: 3
        });
      });
    });

    describe('POST /add and /deduct', () => {
      it('add creates the user (lowercased) and records a bonus transaction', async () => {
        const res = await d.post('/api/loyalty/add', { username: 'NewGuy', amount: 25, reason: 'Gift' });
        expect(res.json).toEqual({ success: true, newBalance: 25 });
        const file = d.readJson('loyalty.json');
        expect(file.users.newguy).toMatchObject({ points: 25, totalEarned: 25, totalSpent: 0, level: 1 });
        expect(file.transactions).toEqual([
          { username: 'newguy', amount: 25, type: 'bonus', reason: 'Gift', balance: 25, timestamp: expect.any(String) }
        ]);
        expect(file.savedAt).toEqual(expect.any(String));
      });

      it('add and deduct validate username and positive numeric amount', async () => {
        for (const body of [{ amount: 5 }, { username: 'a', amount: 0 }, { username: 'a', amount: -1 }, { username: 'a', amount: '5' }]) {
          const add = await d.post('/api/loyalty/add', body);
          expect(add.status).toBe(400);
          expect(add.json).toEqual({ error: 'username and a positive amount are required' });
          const deduct = await d.post('/api/loyalty/deduct', body);
          expect(deduct.status).toBe(400);
        }
      });

      it('deduct spends points and records the transaction', async () => {
        const res = await d.post('/api/loyalty/deduct', { username: 'Alice', amount: 30 });
        expect(res.json).toEqual({ success: true, newBalance: 70 });
        const file = d.readJson('loyalty.json');
        expect(file.users.alice).toMatchObject({ points: 70, totalSpent: 30 });
        expect(file.transactions[0]).toMatchObject({ username: 'alice', amount: -30, type: 'spend', reason: 'Deduction', balance: 70 });
      });

      it('deduct reports insufficient points with balance and required; unknown user is 404', async () => {
        const res = await d.post('/api/loyalty/deduct', { username: 'bob', amount: 51 });
        expect(res.status).toBe(400);
        expect(res.json).toEqual({ error: 'Insufficient points. This request costs 51 points. You have 50.', balance: 50, required: 51 });
        const missing = await d.post('/api/loyalty/deduct', { username: 'ghost', amount: 5 });
        expect(missing.status).toBe(404);
        expect(missing.json).toEqual({ error: 'You have no loyalty points yet. This request costs 5 points.' });
        expect(d.readJson('loyalty.json').transactions).toEqual([]);
      });

      it('concurrent adds are all applied (file lock)', async () => {
        const results = await Promise.all(Array.from({ length: 20 }, () => d.post('/api/loyalty/add', { username: 'racer', amount: 1 })));
        expect(results.every(r => r.status === 200)).toBe(true);
        const file = d.readJson('loyalty.json');
        expect(file.users.racer.points).toBe(20);
        expect(file.transactions).toHaveLength(20);
        expect(results.map(r => r.json.newBalance).sort((a: number, b: number) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      });

      it('concurrent deducts never overspend (file lock)', async () => {
        const results = await Promise.all(Array.from({ length: 10 }, () => d.post('/api/loyalty/deduct', { username: 'bob', amount: 10 })));
        expect(results.filter(r => r.status === 200)).toHaveLength(5);
        expect(results.filter(r => r.status === 400)).toHaveLength(5);
        expect(d.readJson('loyalty.json').users.bob.points).toBe(0);
      });
    });

    describe('PUT /user/:username/points', () => {
      it('sets points, clamps negatives to 0 and records the delta', async () => {
        const res = await d.put('/api/loyalty/user/Alice/points', { points: 40, reason: 'fix' });
        expect(res.json).toEqual({ success: true, user: expect.objectContaining({ points: 40 }) });
        const neg = await d.put('/api/loyalty/user/alice/points', { points: -5 });
        expect(neg.json.user.points).toBe(0);
        const created = await d.put('/api/loyalty/user/Newbie/points', { points: 9 });
        expect(created.json.user.points).toBe(9);
        const tx = d.readJson('loyalty.json').transactions;
        expect(tx.map((t: { username: string; amount: number; type: string; reason: string }) => [t.username, t.amount, t.type, t.reason])).toEqual([
          ['alice', -60, 'admin', 'fix'],
          ['alice', -40, 'admin', 'Admin adjustment'],
          ['newbie', 9, 'admin', 'Admin adjustment']
        ]);
      });

      it('requires numeric points', async () => {
        const res = await d.put('/api/loyalty/user/alice/points', { points: '5' });
        expect(res.status).toBe(400);
        expect(res.json).toEqual({ error: 'Points must be a number' });
      });
    });

    describe('POST /award-message', () => {
      it('awards pointsPerMessage, then applies the cooldown', async () => {
        const first = await d.post('/api/loyalty/award-message', { username: ' Dave ' });
        expect(first.json).toEqual({ success: true, pointsEarned: 5, newBalance: 5, onCooldown: false });
        const second = await d.post('/api/loyalty/award-message', { username: 'dave' });
        expect(second.json).toEqual({ success: true, pointsEarned: 0, newBalance: 0, onCooldown: true });
        const dave = d.readJson('loyalty.json').users.dave;
        expect(dave).toMatchObject({ points: 5, isSubscriber: false, isVip: false, lastMessagePointsAt: expect.any(Number) });
      });

      it('applies subscriber (x2) over VIP (x1.5, floored) multipliers and the per-message cap', async () => {
        expect((await d.post('/api/loyalty/award-message', { username: 's', isSubscriber: true, isVip: true })).json.pointsEarned).toBe(10);
        expect((await d.post('/api/loyalty/award-message', { username: 'v', isVip: 1 })).json.pointsEarned).toBe(7);
        await d.put('/api/loyalty/config', { pointsPerMessage: 40, maxPointsPerMessage: 50 });
        expect((await d.post('/api/loyalty/award-message', { username: 's2', isSubscriber: true })).json.pointsEarned).toBe(50);
      });

      it('returns 0 points when disabled or when the amount rounds to 0', async () => {
        await d.put('/api/loyalty/config', { enabled: false });
        expect((await d.post('/api/loyalty/award-message', { username: 'x' })).json).toEqual({ success: true, pointsEarned: 0, newBalance: 0, onCooldown: false });
        expect(d.readJson('loyalty.json').users.x).toBeUndefined();
        await d.put('/api/loyalty/config', { enabled: true, pointsPerMessage: 0 });
        expect((await d.post('/api/loyalty/award-message', { username: 'y' })).json.pointsEarned).toBe(0);
      });

      it('requires a string username', async () => {
        const res = await d.post('/api/loyalty/award-message', { username: 5 });
        expect(res.status).toBe(400);
        expect(res.json).toEqual({ error: 'username (string) is required' });
      });
    });

    describe('POST /gamba', () => {
      it('win: bet is spent and 2x is paid back', async () => {
        jest.spyOn(Math, 'random').mockReturnValue(0.1);
        const res = await d.post('/api/loyalty/gamba', { username: 'Alice', amount: 40 });
        expect(res.json).toEqual({ success: true, won: true, oldBalance: 100, newBalance: 140, amountBet: 40, winnings: 80 });
        const tx = d.readJson('loyalty.json').transactions;
        expect(tx.map((t: { amount: number; type: string; reason: string }) => [t.amount, t.type, t.reason])).toEqual([
          [-40, 'spend', 'Gamba bet'], [80, 'bonus', 'Gamba win']
        ]);
      });

      it('loss: bet is spent', async () => {
        jest.spyOn(Math, 'random').mockReturnValue(0.5);
        const res = await d.post('/api/loyalty/gamba', { username: 'alice', amount: '40' });
        expect(res.json).toEqual({ success: true, won: false, oldBalance: 100, newBalance: 60, amountBet: 40, winnings: 0 });
      });

      it('"all" (any case) bets the full balance', async () => {
        jest.spyOn(Math, 'random').mockReturnValue(0.9);
        expect((await d.post('/api/loyalty/gamba', { username: 'bob', amount: 'ALL' })).json).toMatchObject({ amountBet: 50, newBalance: 0 });
        const broke = await d.post('/api/loyalty/gamba', { username: 'bob', amount: 'all' });
        expect(broke.status).toBe(400);
        expect(broke.json).toEqual({ error: 'You have no points to bet.', balance: 0 });
      });

      it('validates amount', async () => {
        const cases: Array<[unknown, string]> = [
          [undefined, 'amount is required. Use a number or "all".'],
          ['', 'amount is required. Use a number or "all".'],
          ['abc', 'amount must be a positive number or "all".'],
          [0, 'amount must be a positive number or "all".'],
          [0.5, 'amount must be a positive number or "all".'],
          [-3, 'amount must be a positive number or "all".'],
          [10001, 'Bet must be between 1 and 10000 points.']
        ];
        for (const [amount, error] of cases) {
          const res = await d.post('/api/loyalty/gamba', { username: 'alice', amount });
          expect(res.status).toBe(400);
          expect(res.json).toEqual({ error });
        }
        const noUser = await d.post('/api/loyalty/gamba', { amount: 5 });
        expect(noUser.status).toBe(400);
        expect(noUser.json).toEqual({ error: 'username (string) is required' });
      });

      it('rejects null, whitespace and non-finite amounts without touching the balance', async () => {
        // NaN and +/-Infinity arrive as null once serialised to JSON (as the bot's HTTP client sends them)
        const before = d.readJson('loyalty.json');
        const cases: Array<[unknown, string]> = [
          [null, 'amount is required. Use a number or "all".'],
          [NaN, 'amount is required. Use a number or "all".'],
          [Infinity, 'amount is required. Use a number or "all".'],
          [-Infinity, 'amount is required. Use a number or "all".'],
          ['  ', 'amount must be a positive number or "all".']
        ];
        for (const [amount, error] of cases) {
          const res = await d.post('/api/loyalty/gamba', { username: 'alice', amount });
          expect(res.status).toBe(400);
          expect(res.json).toEqual({ error });
        }
        const after = d.readJson('loyalty.json');
        expect(after.users.alice.points).toBe(100);
        expect(after.transactions).toEqual(before.transactions);
      });

      it.each([1e21, 1e5, '2e4'])('rejects the out-of-range bet %p (no exponent misparse to 1)', async (amount) => {
        const res = await d.post('/api/loyalty/gamba', { username: 'alice', amount });
        expect(res.status).toBe(400);
        expect(res.json).toEqual({ error: 'Bet must be between 1 and 10000 points.' });
        expect(d.readJson('loyalty.json').users.alice.points).toBe(100);
      });

      it('floors a fractional bet', async () => {
        jest.spyOn(Math, 'random').mockReturnValue(0.9);
        const res = await d.post('/api/loyalty/gamba', { username: 'alice', amount: 2.9 });
        expect(res.json).toMatchObject({ success: true, amountBet: 2, newBalance: 98 });
      });

      it('unknown user is 404, insufficient balance is 400 with balance', async () => {
        const missing = await d.post('/api/loyalty/gamba', { username: 'ghost', amount: 1 });
        expect(missing.status).toBe(404);
        expect(missing.json).toEqual({ error: 'You have no loyalty points yet.' });
        const poor = await d.post('/api/loyalty/gamba', { username: 'bob', amount: 51 });
        expect(poor.status).toBe(400);
        expect(poor.json).toEqual({ error: 'Insufficient points. You have 50.', balance: 50 });
      });
    });

    describe('POST /duel', () => {
      it('both pay the stake and the winner gets 2x', async () => {
        jest.spyOn(Math, 'random').mockReturnValue(0.1);
        const res = await d.post('/api/loyalty/duel', { challenger: 'Alice', opponent: '@Bob', stake: 20 });
        expect(res.json).toEqual({ success: true, winner: 'alice', challengerBalance: 120, opponentBalance: 30 });
        const file = d.readJson('loyalty.json');
        expect(file.users.bob).toMatchObject({ points: 30, totalSpent: 20 });
        expect(file.transactions.map((t: { username: string; amount: number; reason: string }) => [t.username, t.amount, t.reason])).toEqual([
          ['alice', -20, 'Duel stake'], ['bob', -20, 'Duel stake'], ['alice', 40, 'Duel win']
        ]);
      });

      it('defaults a missing stake to 50', async () => {
        jest.spyOn(Math, 'random').mockReturnValue(0.9);
        expect((await d.post('/api/loyalty/duel', { challenger: 'alice', opponent: 'bob' })).json)
          .toEqual({ success: true, winner: 'bob', challengerBalance: 50, opponentBalance: 100 });
      });

      it.each([0, 'abc', 0.5, '-1', true])('rejects stake %p with 400 instead of using the default', async (stake) => {
        const res = await d.post('/api/loyalty/duel', { challenger: 'alice', opponent: 'bob', stake });
        expect(res.status).toBe(400);
        expect(res.json).toEqual({ error: 'stake must be at least 1.' });
        expect(d.readJson('loyalty.json').users.alice.points).toBe(100);
      });

      it('validates participants and stake', async () => {
        const missing = await d.post('/api/loyalty/duel', { challenger: 'alice' });
        expect(missing.status).toBe(400);
        expect(missing.json).toEqual({ error: 'challenger and opponent (strings) are required' });
        const neg = await d.post('/api/loyalty/duel', { challenger: 'alice', opponent: 'bob', stake: -5 });
        expect(neg.status).toBe(400);
        expect(neg.json).toEqual({ error: 'stake must be at least 1.' });
        const self = await d.post('/api/loyalty/duel', { challenger: 'Alice', opponent: '@alice' });
        expect(self.status).toBe(400);
        expect(self.json).toEqual({ error: 'You cannot duel yourself.' });
      });

      it('insufficient challenger/opponent balances are 400 and write nothing', async () => {
        const c = await d.post('/api/loyalty/duel', { challenger: 'carol', opponent: 'alice', stake: 10 });
        expect(c.status).toBe(400);
        expect(c.json).toEqual({ error: "carol doesn't have enough points (0). Need 10." });
        const o = await d.post('/api/loyalty/duel', { challenger: 'alice', opponent: 'Ghost', stake: 10 });
        expect(o.status).toBe(400);
        expect(o.json).toEqual({ error: "Ghost doesn't have enough points (0). Need 10." });
        expect(d.readJson('loyalty.json').users.ghost).toBeUndefined();
      });
    });

    it('GET /transactions returns newest first, filtered and limited', async () => {
      await d.post('/api/loyalty/add', { username: 'alice', amount: 1 });
      await d.post('/api/loyalty/add', { username: 'bob', amount: 2 });
      await d.post('/api/loyalty/add', { username: 'alice', amount: 3 });
      const all = (await d.get('/api/loyalty/transactions')).json;
      expect(all.map((t: { amount: number }) => t.amount)).toEqual([3, 2, 1]);
      const alice = (await d.get('/api/loyalty/transactions?username=ALICE&limit=1')).json;
      expect(alice.map((t: { amount: number }) => t.amount)).toEqual([3]);
    });

    it('trims transaction history to 1000 once it exceeds 2000', async () => {
      const file = d.readJson('loyalty.json');
      file.transactions = Array.from({ length: 2000 }, (_, i) => ({ username: 'x', amount: i }));
      d.writeJson('loyalty.json', file);
      await d.post('/api/loyalty/add', { username: 'alice', amount: 1 });
      const tx = d.readJson('loyalty.json').transactions;
      expect(tx).toHaveLength(1000);
      expect(tx[0].amount).toBe(1001);
      expect(tx[999]).toMatchObject({ username: 'alice', amount: 1 });
    });
  });
});

describe('loyalty watch-time timer', () => {
  let d: Dash;
  beforeEach(() => {
    silenceConsole();
    // Fake only setInterval/clearInterval so HTTP, fs and the file lock keep real timers
    jest.useFakeTimers({
      doNotFake: ['Date', 'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout']
    });
  });
  afterEach(async () => {
    await d.close();
    jest.useRealTimers();
  });

  it('every minute awards watch time to users seen in the last 10 minutes', async () => {
    const now = Date.now();
    d = await startDashboard({
      seed: seedLoyalty({
        // Never awarded before: paid from lastSeen (firstSeen days ago is not paid out)
        present: user(0, { lastSeen: new Date(now - 5 * 60000 - 1000).toISOString(), firstSeen: new Date(now - 3 * 24 * 3600000).toISOString() }),
        sub: user(0, { lastSeen: new Date(now - 2 * 60000 - 1000).toISOString(), firstSeen: new Date(now - 2 * 60000).toISOString(), isSubscriber: true }),
        away: user(0, { lastSeen: new Date(now - 11 * 60000).toISOString(), firstSeen: new Date(now - 60 * 60000).toISOString() })
      })
    });
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(60000);
    await waitUntil(() => d.readJson('loyalty.json').users.present.points > 0);
    const file = d.readJson('loyalty.json');
    expect(file.users.present).toMatchObject({ points: 50, totalEarned: 50, watchTimeMinutes: 5, lastWatchTimeAwardedAt: expect.any(Number) });
    expect(file.users.sub).toMatchObject({ points: 40, watchTimeMinutes: 2 });
    expect(file.users.away.points).toBe(0);
    expect(file.transactions.map((t: { username: string; reason: string }) => [t.username, t.reason])).toEqual([
      ['present', 'Watch time'], ['sub', 'Watch time']
    ]);
  });

  it('close() stops the timer', async () => {
    d = await startDashboard();
    expect(jest.getTimerCount()).toBe(1);
    await d.close();
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('dashboard /api/loyalty: corrupt loyalty.json', () => {
  let d: Dash;
  const CORRUPT = '{"users": {"alice": {"points": 900}';
  beforeEach(async () => {
    silenceConsole();
    d = await startDashboard();
    fs.writeFileSync(path.join(d.logsDir, 'loyalty.json'), CORRUPT);
  });
  afterEach(async () => {
    await d.close();
  });

  it('every route answers 503, the file is never overwritten, a copy is kept and the error is logged', async () => {
    const calls: Array<[string, string, unknown]> = [
      ['GET', '/api/loyalty', undefined],
      ['GET', '/api/loyalty/user/alice', undefined],
      ['PUT', '/api/loyalty/config', { pointsPerMessage: 1 }],
      ['POST', '/api/loyalty/award-message', { username: 'alice' }],
      ['POST', '/api/loyalty/add', { username: 'alice', amount: 5 }],
      ['POST', '/api/loyalty/deduct', { username: 'alice', amount: 5 }],
      ['PUT', '/api/loyalty/user/alice/points', { points: 0 }],
      ['POST', '/api/loyalty/gamba', { username: 'alice', amount: 1 }],
      ['POST', '/api/loyalty/duel', { challenger: 'alice', opponent: 'bob' }]
    ];
    for (const [method, url, body] of calls) {
      const res = await d.request(method, url, { body });
      expect([method, url, res.status]).toEqual([method, url, 503]);
      expect(res.json.error).toMatch(/unreadable.*blocked until it is repaired or removed/);
    }
    expect(fs.readFileSync(path.join(d.logsDir, 'loyalty.json'), 'utf8')).toBe(CORRUPT);
    const copies = fs.readdirSync(d.logsDir).filter(f => f.startsWith('loyalty.json.corrupt-'));
    expect(copies).toHaveLength(1);
    expect(fs.readFileSync(path.join(d.logsDir, copies[0]), 'utf8')).toBe(CORRUPT);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[Loyalty] ERROR'));
  });
});

describe('dashboard /api/loyalty: loyalty-update broadcasts', () => {
  let d: Dash;
  beforeEach(async () => {
    silenceConsole();
    d = await startDashboard({ seed: seedLoyalty({ alice: user(100), bob: user(50, { level: 3 }) }) });
  });
  afterEach(async () => {
    await d.close();
  });

  const leaderboard = async () => (await d.get('/api/loyalty/leaderboard?limit=100')).json;

  it.each([
    ['POST /add', 'POST', '/api/loyalty/add', { username: 'carol', amount: 500 }],
    ['POST /deduct', 'POST', '/api/loyalty/deduct', { username: 'alice', amount: 10 }],
    ['PUT /user/:username/points', 'PUT', '/api/loyalty/user/bob/points', { points: 7 }],
    ['POST /award-message', 'POST', '/api/loyalty/award-message', { username: 'dave' }],
    ['POST /gamba', 'POST', '/api/loyalty/gamba', { username: 'alice', amount: 5 }],
    ['POST /duel', 'POST', '/api/loyalty/duel', { challenger: 'alice', opponent: 'bob', stake: 10 }]
  ])('%s broadcasts the GET /leaderboard?limit=100 JSON', async (_label, method, url, body) => {
    const ws = await openWs(d);
    const since = ws.messages.length;
    expect((await d.request(method, url, { body })).status).toBe(200);
    const msg = await ws.waitFor('loyalty-update', since);
    expect(msg.data).toEqual(await leaderboard());
    ws.close();
  });

  it('caps the broadcast at 100 entries, highest points first', async () => {
    const users: Record<string, unknown> = {};
    for (let i = 0; i < 120; i++) users[`u${i}`] = user(i);
    d.writeJson('loyalty.json', { users, config: DEFAULT_CONFIG, transactions: [] });
    const ws = await openWs(d);
    const since = ws.messages.length;
    await d.post('/api/loyalty/add', { username: 'u0', amount: 1000 });
    const msg = await ws.waitFor('loyalty-update', since);
    expect(msg.data).toHaveLength(100);
    expect(msg.data[0]).toEqual({ username: 'u0', points: 1000, level: 1, watchTimeMinutes: 0, rank: 1 });
    ws.close();
  });

  it('failed writes and award-message on cooldown broadcast nothing', async () => {
    const ws = await openWs(d);
    const since = ws.messages.length;
    await d.post('/api/loyalty/deduct', { username: 'bob', amount: 999 });
    await d.post('/api/loyalty/award-message', { username: 'erin' });
    await ws.waitFor('loyalty-update', since);
    const after = ws.messages.length;
    await d.post('/api/loyalty/award-message', { username: 'erin' });
    await new Promise(r => setTimeout(r, 100));
    // Only the first award (points earned) was broadcast, not the failed deduct
    expect(ws.messages.slice(since).filter(m => m.type === 'loyalty-update')).toHaveLength(1);
    expect(ws.messages.slice(after).filter(m => m.type === 'loyalty-update')).toEqual([]);
    expect(d.readJson('loyalty.json').users.erin.messageCount).toBe(2);
    ws.close();
  });
});
