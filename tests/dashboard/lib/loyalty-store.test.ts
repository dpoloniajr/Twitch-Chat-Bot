/**
 * Tests for src/dashboard/lib/loyalty-store.ts: points math, cooldowns, watch time,
 * gamba/duel outcomes (Math.random mocked) and missing/corrupt loyalty.json.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as store from '../../../src/dashboard/lib/loyalty-store';
import type { LoyaltyData, LoyaltyUserRecord } from '../../../src/dashboard/lib/types';

const {
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
  WATCH_TIME_INTERVAL_MS,
  LoyaltyDataCorruptError,
  readOrInitLoyaltyData,
  DEFAULT_LOYALTY_DATA,
  parseDuelStake,
  buildLeaderboard
} = store;

const MINUTE = 60 * 1000;

describe('loyalty-store', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loyalty-store-'));
    file = path.join(dir, 'loyalty.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seed(data: LoyaltyData): void {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  }

  function load(): LoyaltyData {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  function user(fields: Partial<LoyaltyUserRecord> = {}): LoyaltyUserRecord {
    return {
      points: 0,
      totalEarned: 0,
      totalSpent: 0,
      watchTimeMinutes: 0,
      messageCount: 0,
      lastSeen: new Date().toISOString(),
      firstSeen: new Date().toISOString(),
      level: 1,
      lastMessagePointsAt: null,
      lastWatchTimeAwardedAt: null,
      ...fields
    };
  }

  function mockRandom(value: number): jest.SpyInstance {
    return jest.spyOn(Math, 'random').mockReturnValue(value);
  }

  function mockNow(ms: number): jest.SpyInstance {
    return jest.spyOn(Date, 'now').mockReturnValue(ms);
  }

  it('exports its constants', () => {
    expect(DEFAULT_DUEL_STAKE).toBe(50);
    expect(GAMBA_MIN).toBe(1);
    expect(GAMBA_MAX).toBe(10000);
    expect(WATCH_TIME_INTERVAL_MS).toBe(60000);
  });

  describe('readLoyaltyData / writeLoyaltyData', () => {
    it('returns null when the file does not exist', async () => {
      await expect(readLoyaltyData(file)).resolves.toBeNull();
    });

    it.each([['invalid JSON', '{ not json'], ['a JSON array', '[]'], ['JSON null', 'null']])(
      'refuses a corrupt file (%s): throws a 503 error, keeps the file and saves one copy beside it',
      async (_label, content) => {
        const log = jest.spyOn(console, 'error').mockImplementation(() => {});
        fs.writeFileSync(file, content);
        const err = await readLoyaltyData(file).catch(e => e);
        expect(err).toBeInstanceOf(LoyaltyDataCorruptError);
        expect(err.statusCode).toBe(503);
        expect(err.message).toContain('loyalty changes are blocked');
        expect(fs.readFileSync(file, 'utf8')).toBe(content);
        expect(fs.readFileSync(err.backupPath, 'utf8')).toBe(content);
        expect(path.dirname(err.backupPath)).toBe(dir);
        expect(log).toHaveBeenCalledWith(expect.stringContaining('[Loyalty] ERROR'));

        // Reading again reuses the same copy instead of piling up backups
        await expect(readLoyaltyData(file)).rejects.toBeInstanceOf(LoyaltyDataCorruptError);
        expect(fs.readdirSync(dir).filter(f => f.includes('.corrupt-'))).toHaveLength(1);
      }
    );

    it('treats an unreadable path (a directory) as corrupt, not as missing', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      fs.mkdirSync(file);
      await expect(readLoyaltyData(file)).rejects.toBeInstanceOf(LoyaltyDataCorruptError);
    });

    it('readOrInitLoyaltyData creates the defaults on a fresh install and reads an existing file', async () => {
      const created = await readOrInitLoyaltyData(file);
      expect(created).toEqual({ ...DEFAULT_LOYALTY_DATA(), savedAt: expect.any(String) });
      expect(load()).toEqual(created);
      seed({ users: { a: user({ points: 3 }) } });
      expect((await readOrInitLoyaltyData(file)).users!.a.points).toBe(3);
    });

    it('parses an existing file', async () => {
      seed({ users: { a: user({ points: 3 }) } });
      const data = await readLoyaltyData(file);
      expect(data?.users?.a.points).toBe(3);
    });

    it('stamps savedAt on the object and writes pretty JSON', async () => {
      const data: LoyaltyData = { users: {} };
      await writeLoyaltyData(file, data);
      expect(typeof data.savedAt).toBe('string');
      expect(Number.isNaN(Date.parse(data.savedAt!))).toBe(false);
      const raw = fs.readFileSync(file, 'utf8');
      expect(raw).toBe(JSON.stringify(data, null, 2));
    });
  });

  describe('appendTransaction', () => {
    it('creates the history and stamps a timestamp', () => {
      const data: LoyaltyData = {};
      appendTransaction(data, { username: 'a', amount: 5, type: 'earn', reason: 'x', balance: 5 });
      expect(data.transactions).toHaveLength(1);
      expect(data.transactions![0]).toMatchObject({ username: 'a', amount: 5, type: 'earn', reason: 'x', balance: 5 });
      expect(typeof data.transactions![0].timestamp).toBe('string');
    });

    it('keeps up to 2000 entries, then trims to the newest 1000', () => {
      const data: LoyaltyData = { transactions: [] };
      for (let i = 0; i < 2000; i++) {
        appendTransaction(data, { username: 'a', amount: i, type: 'earn', reason: 'x', balance: i });
      }
      expect(data.transactions).toHaveLength(2000);
      appendTransaction(data, { username: 'a', amount: 2000, type: 'earn', reason: 'x', balance: 2000 });
      expect(data.transactions).toHaveLength(1000);
      expect(data.transactions![0].amount).toBe(1001);
      expect(data.transactions![999].amount).toBe(2000);
    });
  });

  describe('deductPoints', () => {
    it('succeeds without charging when loyalty is not configured', async () => {
      await expect(deductPoints(file, 'a', 10, 'x')).resolves.toEqual({ success: true, notConfigured: true });
      expect(fs.existsSync(file)).toBe(false);
    });

    it('refuses (instead of charging nothing) when the file is corrupt, and leaves it untouched', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      fs.writeFileSync(file, 'garbage');
      await expect(deductPoints(file, 'a', 10, 'x')).rejects.toBeInstanceOf(LoyaltyDataCorruptError);
      expect(fs.readFileSync(file, 'utf8')).toBe('garbage');
    });

    it('reports an unknown user', async () => {
      seed({ users: {} });
      await expect(deductPoints(file, 'Ghost', 25, 'x')).resolves.toEqual({
        success: false,
        code: 'USER_NOT_FOUND',
        error: 'You have no loyalty points yet. This request costs 25 points.'
      });
    });

    it('reports insufficient points with the balance', async () => {
      seed({ users: { a: user({ points: 7 }) } });
      await expect(deductPoints(file, 'A', 10, 'x')).resolves.toEqual({
        success: false,
        code: 'INSUFFICIENT_POINTS',
        balance: 7,
        error: 'Insufficient points. This request costs 10 points. You have 7.'
      });
    });

    it('treats a missing points field as 0', async () => {
      seed({ users: { a: {} } });
      const result = await deductPoints(file, 'a', 1, 'x');
      expect(result).toMatchObject({ success: false, code: 'INSUFFICIENT_POINTS', balance: 0 });
    });

    it('deducts, tracks totalSpent and records a spend transaction', async () => {
      seed({ users: { a: user({ points: 100, totalSpent: 5 }) } });
      await expect(deductPoints(file, 'A', 30, undefined)).resolves.toEqual({ success: true, newBalance: 70 });
      const data = load();
      expect(data.users!.a).toMatchObject({ points: 70, totalSpent: 35 });
      expect(data.transactions).toEqual([
        expect.objectContaining({ username: 'a', amount: -30, type: 'spend', reason: 'Deduction', balance: 70 })
      ]);
      expect(typeof data.savedAt).toBe('string');
    });
  });

  describe('refundPoints', () => {
    it('is a no-op for a zero, negative or missing amount', async () => {
      seed({ users: { a: user({ points: 1 }) } });
      const before = fs.readFileSync(file, 'utf8');
      await expect(refundPoints(file, 'a', 0, 'x')).resolves.toBeUndefined();
      await expect(refundPoints(file, 'a', -5, 'x')).resolves.toBeUndefined();
      await expect(refundPoints(file, 'a', NaN, 'x')).resolves.toBeUndefined();
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
    });

    it('does nothing when loyalty is not configured', async () => {
      await expect(refundPoints(file, 'a', 5, 'x')).resolves.toBeUndefined();
      expect(fs.existsSync(file)).toBe(false);
    });

    it('restores points, reverses totalSpent (not below 0) without touching totalEarned', async () => {
      seed({ users: { a: user({ points: 10, totalSpent: 3, totalEarned: 50 }) } });
      await refundPoints(file, 'A', 5, undefined);
      const data = load();
      expect(data.users!.a).toMatchObject({ points: 15, totalSpent: 0, totalEarned: 50 });
      expect(data.transactions![0]).toMatchObject({ username: 'a', amount: 5, type: 'refund', reason: 'Refund', balance: 15 });
    });

    it('creates the user when missing', async () => {
      seed({});
      await refundPoints(file, 'New', 20, 'Song removed');
      const data = load();
      expect(data.users!.new).toMatchObject({ points: 20, totalSpent: 0, level: 1 });
      expect(data.transactions![0].reason).toBe('Song removed');
    });
  });

  describe('addPoints', () => {
    it('creates loyalty.json on a fresh install', async () => {
      await expect(addPoints(file, 'a', 5, 'x')).resolves.toEqual({ success: true, newBalance: 5 });
      expect(load()).toMatchObject({ config: DEFAULT_LOYALTY_DATA().config, users: { a: { points: 5 } } });
    });

    it.each([
      ['addPoints', () => addPoints(file, 'a', 5, 'x')],
      ['setPoints', () => setPoints(file, 'a', 5, 'x')],
      ['awardMessagePoints', () => awardMessagePoints(file, 'a', false, false)],
      ['processWatchTimeAwards', () => processWatchTimeAwards(file)],
      ['runGamba', () => runGamba(file, 'a', 5)],
      ['runDuel', () => runDuel(file, 'a', 'b', 5)],
      ['refundPoints', () => refundPoints(file, 'a', 5, 'x')]
    ])('%s never overwrites a corrupt file', async (_label, op) => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      fs.writeFileSync(file, '{"users": {"a": {"points": 999}');
      await expect(op()).rejects.toBeInstanceOf(LoyaltyDataCorruptError);
      expect(fs.readFileSync(file, 'utf8')).toBe('{"users": {"a": {"points": 999}');
    });

    it('creates the user and records a bonus by default', async () => {
      seed({ users: {} });
      await expect(addPoints(file, 'Bob', 40, undefined)).resolves.toEqual({ success: true, newBalance: 40 });
      const data = load();
      expect(data.users!.bob).toMatchObject({ points: 40, totalEarned: 40 });
      expect(data.transactions![0]).toMatchObject({ type: 'bonus', reason: 'Addition', amount: 40, balance: 40 });
    });

    it('records the given type', async () => {
      seed({ users: { bob: user({ points: 10, totalEarned: 10 }) } });
      await addPoints(file, 'bob', 5, 'Fix', 'admin');
      const data = load();
      expect(data.users!.bob).toMatchObject({ points: 15, totalEarned: 15 });
      expect(data.transactions![0]).toMatchObject({ type: 'admin', reason: 'Fix' });
    });
  });

  describe('setPoints', () => {
    it('creates loyalty.json on a fresh install', async () => {
      await expect(setPoints(file, 'a', 5, 'x')).resolves.toMatchObject({ success: true, user: { points: 5 } });
      expect(load().users!.a.points).toBe(5);
    });

    it('sets an exact value and records the difference', async () => {
      seed({ users: { a: user({ points: 30 }) } });
      const result = await setPoints(file, 'A', 100, undefined);
      expect(result.success).toBe(true);
      expect(result.user).toMatchObject({ points: 100 });
      expect(load().transactions![0]).toMatchObject({ amount: 70, type: 'admin', reason: 'Admin adjustment', balance: 100 });
    });

    it('clamps negative values to 0', async () => {
      seed({ users: { a: user({ points: 30 }) } });
      const result = await setPoints(file, 'a', -10, 'reset');
      expect(result.user!.points).toBe(0);
      expect(load().transactions![0]).toMatchObject({ amount: -30, balance: 0, reason: 'reset' });
    });
  });

  describe('awardMessagePoints', () => {
    const NOW = Date.parse('2026-01-01T12:00:00Z');

    it('creates loyalty.json with the defaults on a fresh install and awards the message', async () => {
      await expect(awardMessagePoints(file, 'a', false, false)).resolves.toEqual({ success: true, pointsEarned: 5, newBalance: 5 });
      expect(load()).toMatchObject({ config: DEFAULT_LOYALTY_DATA().config, users: { a: { points: 5, messageCount: 1 } } });
    });

    it('counts every message and refreshes lastSeen and the sub/VIP flags, even on cooldown', async () => {
      mockNow(NOW);
      seed({ users: { a: user({ messageCount: 4, lastSeen: new Date(NOW - 5 * MINUTE).toISOString(), lastMessagePointsAt: NOW - 1000 }) } });
      await awardMessagePoints(file, 'a', true, false);
      expect(load().users!.a).toMatchObject({ messageCount: 5, lastSeen: new Date(NOW).toISOString(), isSubscriber: true, points: 0 });
    });

    it('starts the count for a record without messageCount', async () => {
      seed({ users: { a: { points: 1 } } });
      await awardMessagePoints(file, 'a', false, false);
      expect(load().users!.a.messageCount).toBe(1);
    });

    it('awards nothing while the system is disabled', async () => {
      seed({ config: { enabled: false }, users: {} });
      await expect(awardMessagePoints(file, 'a', false, false)).resolves.toEqual({ success: true, pointsEarned: 0 });
      expect(load().users).toEqual({});
    });

    it('uses the default amount and records the award', async () => {
      mockNow(NOW);
      seed({ users: {} });
      await expect(awardMessagePoints(file, 'Viewer', false, false)).resolves.toEqual({
        success: true,
        pointsEarned: 5,
        newBalance: 5
      });
      const data = load();
      expect(data.users!.viewer).toMatchObject({
        points: 5,
        totalEarned: 5,
        messageCount: 1,
        lastSeen: new Date(NOW).toISOString(),
        lastMessagePointsAt: NOW,
        isSubscriber: false,
        isVip: false
      });
      expect(data.transactions![0]).toMatchObject({ username: 'viewer', type: 'earn', reason: 'Chat message', amount: 5 });
    });

    it.each([
      ['subscriber (x2)', true, false, 10],
      ['VIP (x1.5, floored)', false, true, 7],
      ['subscriber takes precedence over VIP', true, true, 10]
    ])('applies the %s multiplier', async (_label, isSub, isVip, expected) => {
      seed({ users: {} });
      const result = await awardMessagePoints(file, 'a', isSub, isVip);
      expect(result.pointsEarned).toBe(expected);
      expect(load().users!.a).toMatchObject({ isSubscriber: isSub, isVip });
    });

    it('uses config values and caps at maxPointsPerMessage', async () => {
      seed({ config: { pointsPerMessage: 40, subscriberMultiplier: 3, maxPointsPerMessage: 100 }, users: {} });
      await expect(awardMessagePoints(file, 'a', true, false)).resolves.toMatchObject({ pointsEarned: 100 });
    });

    it('awards nothing when the configured amount rounds to 0 (the message is still counted)', async () => {
      seed({ config: { pointsPerMessage: 0 }, users: {} });
      await expect(awardMessagePoints(file, 'a', false, false)).resolves.toEqual({ success: true, pointsEarned: 0 });
      expect(load().users!.a).toMatchObject({ points: 0, messageCount: 1 });
    });

    it('awards nothing for a non-numeric configured amount instead of writing NaN', async () => {
      seed({ config: { pointsPerMessage: 'lots' as unknown as number }, users: { a: user({ points: 7 }) } });
      await expect(awardMessagePoints(file, 'a', false, false)).resolves.toEqual({ success: true, pointsEarned: 0 });
      expect(load().users!.a.points).toBe(7);
    });

    it.each([
      ['an epoch-ms number', NOW - 10 * 1000],
      ['an ISO string', new Date(NOW - 10 * 1000).toISOString()]
    ])('is on cooldown when lastMessagePointsAt is %s within the window', async (_label, lastAt) => {
      mockNow(NOW);
      seed({ users: { a: user({ points: 1, lastMessagePointsAt: lastAt }) } });
      await expect(awardMessagePoints(file, 'a', false, false)).resolves.toEqual({
        success: true,
        pointsEarned: 0,
        onCooldown: true
      });
      const data = load();
      expect(data.users!.a).toMatchObject({ points: 1, lastMessagePointsAt: lastAt, messageCount: 1 });
      expect(data.transactions).toBeUndefined();
    });

    it('awards again once the cooldown has passed', async () => {
      mockNow(NOW);
      seed({ config: { messageCooldownSeconds: 10 }, users: { a: user({ points: 1, lastMessagePointsAt: NOW - 10 * 1000 }) } });
      await expect(awardMessagePoints(file, 'a', false, false)).resolves.toMatchObject({ pointsEarned: 5, newBalance: 6 });
    });

    it('ignores an unparseable lastMessagePointsAt', async () => {
      seed({ users: { a: user({ lastMessagePointsAt: 'not a date' }) } });
      await expect(awardMessagePoints(file, 'a', false, false)).resolves.toMatchObject({ pointsEarned: 5 });
    });
  });

  describe('processWatchTimeAwards', () => {
    const NOW = Date.parse('2026-01-01T12:00:00Z');
    const iso = (ms: number) => new Date(ms).toISOString();

    beforeEach(() => {
      mockNow(NOW);
    });

    it('reports not configured without creating the file', async () => {
      await expect(processWatchTimeAwards(file)).resolves.toEqual({ success: false, notConfigured: true, awarded: 0 });
      expect(fs.existsSync(file)).toBe(false);
    });

    it('awards nothing while disabled', async () => {
      seed({ config: { enabled: false }, users: { a: user({ lastSeen: iso(NOW), firstSeen: iso(NOW - 5 * MINUTE) }) } });
      await expect(processWatchTimeAwards(file)).resolves.toEqual({ success: true, awarded: 0 });
    });

    it('handles a file without users', async () => {
      seed({});
      await expect(processWatchTimeAwards(file)).resolves.toEqual({ success: true, awarded: 0 });
    });

    it('pays whole minutes since the last award to present users', async () => {
      seed({
        users: {
          a: user({ points: 1, lastSeen: iso(NOW - MINUTE), lastWatchTimeAwardedAt: NOW - 3.5 * MINUTE })
        }
      });
      await expect(processWatchTimeAwards(file)).resolves.toEqual({ success: true, awarded: 1 });
      const data = load();
      expect(data.users!.a).toMatchObject({
        points: 31,
        totalEarned: 30,
        watchTimeMinutes: 3,
        lastWatchTimeAwardedAt: NOW
      });
      expect(data.transactions![0]).toMatchObject({ username: 'a', amount: 30, type: 'earn', reason: 'Watch time', balance: 31 });
    });

    it('pays a never-awarded user from lastSeen, not from firstSeen', async () => {
      seed({
        users: {
          old: user({ lastSeen: iso(NOW - 4 * MINUTE), firstSeen: iso(NOW - 3 * 24 * 60 * MINUTE) }),
          nofirst: { lastSeen: iso(NOW - 2 * MINUTE) }
        }
      });
      await expect(processWatchTimeAwards(file)).resolves.toEqual({ success: true, awarded: 2 });
      const data = load();
      expect(data.users!.old).toMatchObject({ points: 40, watchTimeMinutes: 4, lastWatchTimeAwardedAt: NOW });
      expect(data.users!.nofirst).toMatchObject({ points: 20, totalEarned: 20, watchTimeMinutes: 2 });
    });

    it('pays a returning viewer from lastSeen, not for the time they were away', async () => {
      seed({ users: { back: user({ lastSeen: iso(NOW - 3 * MINUTE), lastWatchTimeAwardedAt: NOW - 120 * MINUTE }) } });
      await processWatchTimeAwards(file);
      expect(load().users!.back).toMatchObject({ points: 30, watchTimeMinutes: 3 });
    });

    it.each([
      ['an ISO string', (ms: number) => iso(ms)],
      ['a numeric string', (ms: number) => String(ms)],
      ['garbage', () => 'soon']
    ])('handles lastWatchTimeAwardedAt given as %s without writing NaN points', async (_label, stamp) => {
      seed({ users: { a: user({ points: 5, lastSeen: iso(NOW - 2 * MINUTE), lastWatchTimeAwardedAt: stamp(NOW - MINUTE) as unknown as number }) } });
      await processWatchTimeAwards(file);
      const a = load().users!.a;
      expect(Number.isFinite(a.points)).toBe(true);
      expect(a.points).toBeGreaterThan(5);
    });

    it('skips users absent for more than 10 minutes or with no valid lastSeen', async () => {
      seed({
        users: {
          gone: user({ lastSeen: iso(NOW - 10 * MINUTE - 1), firstSeen: iso(NOW - 60 * MINUTE) }),
          edge: user({ lastSeen: iso(NOW - 10 * MINUTE), firstSeen: iso(NOW - 60 * MINUTE) }),
          bad: user({ lastSeen: 'nope', firstSeen: iso(NOW - 60 * MINUTE) })
        }
      });
      await expect(processWatchTimeAwards(file)).resolves.toEqual({ success: true, awarded: 1 });
      const data = load();
      expect(data.users!.gone.points).toBe(0);
      expect(data.users!.bad.points).toBe(0);
      expect(data.users!.edge).toMatchObject({ points: 100, watchTimeMinutes: 10 });
    });

    it('does not write the file when nobody earned a full minute', async () => {
      seed({ users: { a: user({ lastSeen: iso(NOW), lastWatchTimeAwardedAt: NOW - 59 * 1000 }) } });
      const before = fs.readFileSync(file, 'utf8');
      await expect(processWatchTimeAwards(file)).resolves.toEqual({ success: true, awarded: 0 });
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
    });

    it('applies subscriber and (floored) VIP multipliers from config', async () => {
      seed({
        config: { pointsPerMinute: 3, subscriberMultiplier: 4, vipMultiplier: 1.5 },
        users: {
          sub: user({ isSubscriber: true, isVip: true, lastSeen: iso(NOW), lastWatchTimeAwardedAt: NOW - MINUTE }),
          vip: user({ isVip: true, lastSeen: iso(NOW), lastWatchTimeAwardedAt: NOW - MINUTE })
        }
      });
      await processWatchTimeAwards(file);
      const data = load();
      expect(data.users!.sub.points).toBe(12);
      expect(data.users!.vip.points).toBe(4);
    });

    it('skips users whose multiplied award floors to 0', async () => {
      seed({
        config: { pointsPerMinute: 0 },
        users: { a: user({ lastSeen: iso(NOW), lastWatchTimeAwardedAt: NOW - 5 * MINUTE }) }
      });
      await expect(processWatchTimeAwards(file)).resolves.toEqual({ success: true, awarded: 0 });
    });
  });

  describe('runGamba', () => {
    it.each([0, -5, GAMBA_MAX + 1, 'abc', NaN, Infinity])('rejects bet %p before reading the file', async (bet) => {
      await expect(runGamba(file, 'a', bet as number | string)).resolves.toEqual({
        success: false,
        error: 'Bet must be between 1 and 10000 points.'
      });
      expect(fs.existsSync(file)).toBe(false);
    });

    it('creates loyalty.json on a fresh install (the gambler is then unknown)', async () => {
      await expect(runGamba(file, 'a', 10)).resolves.toMatchObject({ success: false, code: 'USER_NOT_FOUND' });
      expect(load().users).toEqual({});
    });

    it('reports an unknown user', async () => {
      seed({ users: {} });
      await expect(runGamba(file, 'nobody', 10)).resolves.toEqual({
        success: false,
        code: 'USER_NOT_FOUND',
        balance: undefined,
        error: 'You have no loyalty points yet.'
      });
    });

    it('reports insufficient points', async () => {
      seed({ users: { a: user({ points: 5 }) } });
      await expect(runGamba(file, 'a', 10)).resolves.toEqual({
        success: false,
        code: 'INSUFFICIENT_POINTS',
        balance: 5,
        error: 'Insufficient points. You have 5.'
      });
    });

    it('reports "all" with an empty balance', async () => {
      seed({ users: { a: user({ points: 0 }) } });
      await expect(runGamba(file, 'a', 'all')).resolves.toEqual({
        success: false,
        code: 'INSUFFICIENT_POINTS',
        balance: 0,
        error: 'You have no points to bet.'
      });
    });

    it('a win returns twice the bet', async () => {
      mockRandom(0.49);
      seed({ users: { a: user({ points: 100, totalEarned: 100 }) } });
      await expect(runGamba(file, 'A', 30)).resolves.toEqual({
        success: true,
        won: true,
        oldBalance: 100,
        newBalance: 130,
        amountBet: 30,
        winnings: 60
      });
      const data = load();
      expect(data.users!.a).toMatchObject({ points: 130, totalSpent: 30, totalEarned: 160 });
      expect(data.transactions!.map(t => [t.type, t.reason, t.amount, t.balance])).toEqual([
        ['spend', 'Gamba bet', -30, 70],
        ['bonus', 'Gamba win', 60, 130]
      ]);
    });

    it('a loss (Math.random() >= 0.5) keeps only the bet transaction', async () => {
      mockRandom(0.5);
      seed({ users: { a: user({ points: 100 }) } });
      await expect(runGamba(file, 'a', 30)).resolves.toEqual({
        success: true,
        won: false,
        oldBalance: 100,
        newBalance: 70,
        amountBet: 30,
        winnings: 0
      });
      expect(load().transactions).toHaveLength(1);
    });

    it('"all" (any case) bets the floored balance, capped at GAMBA_MAX', async () => {
      mockRandom(0.9);
      seed({ users: { rich: user({ points: 25000 }), poor: user({ points: 12.7 }) } });
      await expect(runGamba(file, 'rich', 'ALL')).resolves.toMatchObject({ amountBet: 10000, newBalance: 15000 });
      await expect(runGamba(file, 'poor', 'all')).resolves.toMatchObject({ amountBet: 12 });
      expect(load().users!.poor.points).toBeCloseTo(0.7);
    });

    it('floors fractional and numeric-string bets', async () => {
      mockRandom(0.9);
      seed({ users: { a: user({ points: 100 }) } });
      await expect(runGamba(file, 'a', '10.9')).resolves.toMatchObject({ amountBet: 10, newBalance: 90 });
      await expect(runGamba(file, 'a', 5.5)).resolves.toMatchObject({ amountBet: 5, newBalance: 85 });
    });
  });

  describe('runDuel', () => {
    it('rejects a negative stake', async () => {
      await expect(runDuel(file, 'a', 'b', -5)).resolves.toEqual({ success: false, error: 'Stake must be at least 1 point.' });
    });

    it('rejects missing usernames and self-duels (after stripping @ and case)', async () => {
      await expect(runDuel(file, '@', 'b')).resolves.toEqual({
        success: false,
        error: 'Challenger and opponent usernames are required.'
      });
      await expect(runDuel(file, '@@Foo', 'foo')).resolves.toEqual({ success: false, error: 'You cannot duel yourself.' });
    });

    it('creates loyalty.json on a fresh install (nobody has points yet)', async () => {
      await expect(runDuel(file, 'a', 'b', 10)).resolves.toMatchObject({ success: false, code: 'CHALLENGER_INSUFFICIENT' });
      expect(fs.existsSync(file)).toBe(true);
    });

    it('reports an insufficient challenger, then opponent, quoting the raw names', async () => {
      seed({ users: { a: user({ points: 5 }), b: user({ points: 100 }) } });
      const before = fs.readFileSync(file, 'utf8');
      await expect(runDuel(file, '@A', 'b', 10)).resolves.toEqual({
        success: false,
        code: 'CHALLENGER_INSUFFICIENT',
        error: "@A doesn't have enough points (5). Need 10."
      });
      await expect(runDuel(file, 'b', 'A', 10)).resolves.toEqual({
        success: false,
        code: 'OPPONENT_INSUFFICIENT',
        error: "A doesn't have enough points (5). Need 10."
      });
      // Unknown users are only created in memory; nothing is written on failure
      await expect(runDuel(file, 'b', 'stranger', 10)).resolves.toMatchObject({ code: 'OPPONENT_INSUFFICIENT' });
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
    });

    it('the challenger wins when Math.random() < 0.5', async () => {
      mockRandom(0.1);
      seed({ users: { a: user({ points: 100 }), b: user({ points: 100 }) } });
      await expect(runDuel(file, 'A', '@b', 20)).resolves.toEqual({
        success: true,
        winner: 'a',
        challengerBalance: 120,
        opponentBalance: 80
      });
      const data = load();
      expect(data.users!.a).toMatchObject({ totalSpent: 20, totalEarned: 40 });
      expect(data.users!.b).toMatchObject({ totalSpent: 20, totalEarned: 0 });
      expect(data.transactions!.map(t => [t.username, t.type, t.reason, t.amount, t.balance])).toEqual([
        ['a', 'spend', 'Duel stake', -20, 80],
        ['b', 'spend', 'Duel stake', -20, 80],
        ['a', 'bonus', 'Duel win', 40, 120]
      ]);
    });

    it('the opponent wins otherwise', async () => {
      mockRandom(0.5);
      seed({ users: { a: user({ points: 100 }), b: user({ points: 100 }) } });
      await expect(runDuel(file, 'a', 'b', '30')).resolves.toEqual({
        success: true,
        winner: 'b',
        challengerBalance: 70,
        opponentBalance: 130
      });
    });

    it('uses the default stake only when none is given', async () => {
      mockRandom(0.1);
      seed({ users: { a: user({ points: 1000 }), b: user({ points: 1000 }) } });
      await expect(runDuel(file, 'a', 'b')).resolves.toMatchObject({ challengerBalance: 1050, opponentBalance: 950 });
      await expect(runDuel(file, 'a', 'b', '')).resolves.toMatchObject({ challengerBalance: 1100, opponentBalance: 900 });
    });

    it.each([0, '0', 0.5, 'lots', NaN, Infinity])('rejects stake %p instead of falling back to the default', async (stake) => {
      seed({ users: { a: user({ points: 1000 }), b: user({ points: 1000 }) } });
      await expect(runDuel(file, 'a', 'b', stake as number)).resolves.toEqual({ success: false, error: 'Stake must be at least 1 point.' });
      expect(load().users!.a.points).toBe(1000);
    });

    it('parseDuelStake floors valid stakes and returns null for invalid ones', () => {
      expect(parseDuelStake(undefined)).toBe(DEFAULT_DUEL_STAKE);
      expect(parseDuelStake(null)).toBe(DEFAULT_DUEL_STAKE);
      expect(parseDuelStake('')).toBe(DEFAULT_DUEL_STAKE);
      expect(parseDuelStake(7.9)).toBe(7);
      expect(parseDuelStake('12')).toBe(12);
      expect(parseDuelStake(1e21)).toBe(1e21);
      expect(parseDuelStake(0)).toBeNull();
      expect(parseDuelStake(-3)).toBeNull();
      expect(parseDuelStake({})).toBeNull();
      expect(parseDuelStake(true)).toBeNull();
    });
  });

  describe('buildLeaderboard', () => {
    it('ranks users by points (missing fields default), limited to `limit`', () => {
      const data: LoyaltyData = { users: { a: { points: 5 }, b: user({ points: 50, level: 3, watchTimeMinutes: 7 }), c: {} } };
      expect(buildLeaderboard(data, 2)).toEqual([
        { username: 'b', points: 50, level: 3, watchTimeMinutes: 7, rank: 1 },
        { username: 'a', points: 5, level: 1, watchTimeMinutes: 0, rank: 2 }
      ]);
      expect(buildLeaderboard({}, 10)).toEqual([]);
    });
  });
});
