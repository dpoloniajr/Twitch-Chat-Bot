/**
 * Characterization: dashboard/routes/counters.js (mounted at /api/counters)
 */
jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('../../../src/lib/console-timestamp', () => ({}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startDashboard, silenceConsole, openWs, Dash } from './helpers';

const counter = (name: string, value: number, extra: Record<string, unknown> = {}) => ({
  name, value, createdAt: 't', createdBy: 'system', lastModifiedAt: 't', lastModifiedBy: 'system', ...extra
});

describe('dashboard /api/counters', () => {
  let d: Dash;
  beforeEach(async () => {
    silenceConsole();
    d = await startDashboard();
  });
  afterEach(async () => {
    await d.close();
  });

  describe('GET', () => {
    it('GET / creates counters.json with deaths/wins/losses on first read', async () => {
      expect(d.exists('counters.json')).toBe(false);
      const res = await d.get('/api/counters');
      expect(res.status).toBe(200);
      expect(res.json.map((c: { name: string }) => c.name)).toEqual(['deaths', 'wins', 'losses']);
      expect(res.json[0]).toEqual({
        name: 'deaths', value: 0, createdAt: expect.any(String), createdBy: 'system',
        lastModifiedAt: expect.any(String), lastModifiedBy: 'system', description: 'Death counter'
      });
      const file = d.readJson('counters.json');
      expect(file.config).toEqual({ maxCounters: 100, maxValue: 999999, minValue: -999999, keepHistory: true, maxHistoryEntries: 100 });
      expect(file.history).toEqual([]);
      expect(file.savedAt).toEqual(expect.any(String));
    });

    it('GET /:name normalizes case and whitespace; 404 when missing', async () => {
      d.writeJson('counters.json', { counters: { boss_kills: counter('boss_kills', 3) }, history: [], config: {} });
      expect((await d.get('/api/counters/Boss%20Kills')).json.value).toBe(3);
      const missing = await d.get('/api/counters/nope');
      expect(missing.status).toBe(404);
      expect(missing.json).toEqual({ error: 'Counter not found' });
    });

    it('GET /config returns the counters config (not a counter named "config")', async () => {
      const res = await d.get('/api/counters/config');
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ maxCounters: 100, maxValue: 999999, minValue: -999999, keepHistory: true, maxHistoryEntries: 100 });
      d.writeJson('counters.json', { counters: {}, config: { maxCounters: 5 } });
      expect((await d.get('/api/counters/config')).json).toEqual({ maxCounters: 5 });
      d.writeJson('counters.json', { counters: {} });
      expect((await d.get('/api/counters/config')).json).toEqual({});
    });

    it('"config" is a reserved counter name', async () => {
      const res = await d.post('/api/counters', { name: ' Config ' });
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: 'Counter name "config" is reserved' });
    });
  });

  describe('POST / (create)', () => {
    it('creates a counter with normalized name, lowercased creator and 201', async () => {
      const res = await d.post('/api/counters', { name: '  Boss Kills ', initialValue: 4, description: 'd', createdBy: 'ModUser' });
      expect(res.status).toBe(201);
      expect(res.json).toEqual({
        success: true,
        counter: {
          name: 'boss_kills', value: 4, createdAt: expect.any(String), createdBy: 'moduser',
          lastModifiedAt: expect.any(String), lastModifiedBy: 'moduser', description: 'd'
        }
      });
      const file = d.readJson('counters.json');
      expect(Object.keys(file.counters)).toEqual(['deaths', 'wins', 'losses', 'boss_kills']);
    });

    it('defaults initialValue 0, creator "dashboard" and omits an empty description', async () => {
      await d.post('/api/counters', { name: 'x' });
      const c = d.readJson('counters.json').counters.x;
      expect(c.value).toBe(0);
      expect(c.createdBy).toBe('dashboard');
      expect('description' in c).toBe(false);
    });

    it('validates the name', async () => {
      const none = await d.post('/api/counters', {});
      expect(none.status).toBe(400);
      expect(none.json).toEqual({ error: 'Name is required' });
      const blank = await d.post('/api/counters', { name: '   ' });
      expect(blank.status).toBe(400);
      expect(blank.json).toEqual({ error: 'Counter name must be 1-50 characters' });
      const long = await d.post('/api/counters', { name: 'a'.repeat(51) });
      expect(long.status).toBe(400);
      expect((await d.post('/api/counters', { name: 'a'.repeat(50) })).status).toBe(201);
    });

    it('rejects duplicates (after normalization)', async () => {
      const res = await d.post('/api/counters', { name: 'DEATHS' });
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: 'Counter "deaths" already exists' });
    });

    it('enforces maxCounters', async () => {
      d.writeJson('counters.json', { counters: { a: counter('a', 0), b: counter('b', 0) }, history: [], config: { maxCounters: 2 } });
      const res = await d.post('/api/counters', { name: 'c' });
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: 'Maximum counter limit reached' });
    });

    it('clamps the initial value and coerces numeric strings', async () => {
      expect((await d.post('/api/counters', { name: 'big', initialValue: 5e6 })).json.counter.value).toBe(999999);
      expect((await d.post('/api/counters', { name: 'small', initialValue: -5e6 })).json.counter.value).toBe(-999999);
      expect((await d.post('/api/counters', { name: 'str', initialValue: '12' })).json.counter.value).toBe(12);
    });

    it.each(['abc', null, '', true, [1, 2], {}])('rejects the non-numeric initialValue %p with 400', async (initialValue) => {
      const res = await d.post('/api/counters', { name: 'nan', initialValue });
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: 'initialValue must be a number' });
      expect((await d.get('/api/counters/nan')).status).toBe(404);
    });

    it('a missing initialValue starts at 0', async () => {
      expect((await d.post('/api/counters', { name: 'zero' })).json.counter.value).toBe(0);
    });

    it('without a body is a 400', async () => {
      const res = await d.request('POST', '/api/counters');
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: 'Name is required' });
    });
  });

  describe('value updates', () => {
    it('PUT /:name sets the value and records history without a reason', async () => {
      const res = await d.put('/api/counters/deaths', { value: 10, modifiedBy: 'Mod' });
      expect(res.json).toEqual({
        success: true,
        counter: expect.objectContaining({ name: 'deaths', value: 10, lastModifiedBy: 'mod' })
      });
      const file = d.readJson('counters.json');
      expect(file.history).toEqual([
        { counterName: 'deaths', previousValue: 0, newValue: 10, change: 10, modifiedBy: 'mod', timestamp: expect.any(String) }
      ]);
    });

    it('PUT validates value and 404s on unknown counters', async () => {
      const bad = await d.put('/api/counters/deaths', { value: '10' });
      expect(bad.status).toBe(400);
      expect(bad.json).toEqual({ error: 'Value must be a number' });
      const missing = await d.put('/api/counters/nope', { value: 1 });
      expect(missing.status).toBe(404);
      expect(missing.json).toEqual({ error: 'Counter not found' });
    });

    it('increment / decrement / reset with default and custom amounts', async () => {
      expect((await d.post('/api/counters/deaths/increment')).json.counter.value).toBe(1);
      expect((await d.post('/api/counters/deaths/increment', { amount: 5, reason: 'boss' })).json.counter.value).toBe(6);
      expect((await d.post('/api/counters/deaths/decrement', { amount: 2 })).json.counter.value).toBe(4);
      expect((await d.post('/api/counters/deaths/decrement')).json.counter.value).toBe(3);
      expect((await d.post('/api/counters/deaths/reset')).json.counter.value).toBe(0);
      const reasons = d.readJson('counters.json').history.map((h: { reason: string }) => h.reason);
      expect(reasons).toEqual(['+1', 'boss', '-2', '-1', 'Reset']);
    });

    it('increment validates amount and 404s on unknown counters', async () => {
      const str = await d.post('/api/counters/deaths/increment', { amount: '5' });
      expect(str.status).toBe(400);
      expect(str.json).toEqual({ error: 'Amount must be a number' });
      const dec = await d.post('/api/counters/deaths/decrement', { amount: null });
      expect(dec.status).toBe(400);
      expect((await d.post('/api/counters/nope/increment')).status).toBe(404);
      expect((await d.post('/api/counters/nope/reset')).status).toBe(404);
    });

    it('clamps to maxValue / minValue', async () => {
      await d.put('/api/counters/deaths', { value: 999998 });
      expect((await d.post('/api/counters/deaths/increment', { amount: 10 })).json.counter.value).toBe(999999);
      expect((await d.put('/api/counters/deaths', { value: -1e9 })).json.counter.value).toBe(-999999);
    });

    it('a configured minValue (or maxValue) of 0 is a real bound', async () => {
      d.writeJson('counters.json', { counters: { c: counter('c', 0), n: counter('n', -3) }, history: [], config: { minValue: 0, maxValue: 10 } });
      expect((await d.post('/api/counters/c/decrement')).json.counter.value).toBe(0);
      expect((await d.post('/api/counters/c/increment', { amount: 100 })).json.counter.value).toBe(10);
      expect((await d.post('/api/counters', { name: 'neg', initialValue: -5 })).json.counter.value).toBe(0);
      d.writeJson('counters.json', { counters: { n: counter('n', -3) }, history: [], config: { minValue: -10, maxValue: 0 } });
      expect((await d.post('/api/counters/n/increment', { amount: 50 })).json.counter.value).toBe(0);
    });

    it('keepHistory false records no history', async () => {
      d.writeJson('counters.json', { counters: { c: counter('c', 0) }, config: { keepHistory: false } });
      await d.post('/api/counters/c/increment');
      const file = d.readJson('counters.json');
      expect(file.counters.c.value).toBe(1);
      expect(file.history).toBeUndefined();
    });

    it('trims history to maxHistoryEntries * counters once it exceeds twice that', async () => {
      d.writeJson('counters.json', { counters: { c: counter('c', 0) }, history: [], config: { maxHistoryEntries: 2 } });
      for (let i = 0; i < 4; i++) await d.post('/api/counters/c/increment');
      expect(d.readJson('counters.json').history).toHaveLength(4);
      await d.post('/api/counters/c/increment');
      const history = d.readJson('counters.json').history;
      expect(history).toHaveLength(2);
      expect(history.map((h: { newValue: number }) => h.newValue)).toEqual([4, 5]);
    });
  });

  describe('DELETE and history', () => {
    it('GET /:name/history returns newest first with a limit', async () => {
      for (let i = 0; i < 5; i++) await d.post('/api/counters/wins/increment');
      await d.post('/api/counters/deaths/increment');
      const all = (await d.get('/api/counters/wins/history')).json;
      expect(all.map((h: { newValue: number }) => h.newValue)).toEqual([5, 4, 3, 2, 1]);
      const two = (await d.get('/api/counters/Wins/history?limit=2')).json;
      expect(two.map((h: { newValue: number }) => h.newValue)).toEqual([5, 4]);
      expect((await d.get('/api/counters/ghost/history')).json).toEqual([]);
    });

    it('DELETE removes the counter and its history', async () => {
      await d.post('/api/counters/wins/increment');
      await d.post('/api/counters/deaths/increment');
      expect((await d.del('/api/counters/wins')).json).toEqual({ success: true });
      const file = d.readJson('counters.json');
      expect(file.counters.wins).toBeUndefined();
      expect(file.history.map((h: { counterName: string }) => h.counterName)).toEqual(['deaths']);
      const again = await d.del('/api/counters/wins');
      expect(again.status).toBe(404);
      expect(again.json).toEqual({ error: 'Counter not found' });
    });
  });

  describe('file locking', () => {
    it('concurrent increments are all applied', async () => {
      await d.get('/api/counters');
      const results = await Promise.all(Array.from({ length: 25 }, () => d.post('/api/counters/deaths/increment')));
      expect(results.every(r => r.status === 200)).toBe(true);
      const file = d.readJson('counters.json');
      expect(file.counters.deaths.value).toBe(25);
      expect(file.history).toHaveLength(25);
      expect(fs.existsSync(path.join(d.logsDir, 'counters.json.lock'))).toBe(false);
    });

    it('concurrent creates of the same name: exactly one wins', async () => {
      const results = await Promise.all(Array.from({ length: 8 }, () => d.post('/api/counters', { name: 'race' })));
      expect(results.filter(r => r.status === 201)).toHaveLength(1);
      expect(results.filter(r => r.status === 400)).toHaveLength(7);
    });

    it('waits for a lock held by another live process, then proceeds', async () => {
      await d.get('/api/counters');
      const lockDir = path.join(d.logsDir, 'counters.json.lock');
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, host: os.hostname(), token: 'other', acquiredAt: Date.now() }));
      const started = Date.now();
      const pending = d.post('/api/counters/deaths/increment');
      setTimeout(() => fs.rmSync(lockDir, { recursive: true, force: true }), 300);
      const res = await pending;
      expect(res.status).toBe(200);
      expect(Date.now() - started).toBeGreaterThanOrEqual(250);
      expect(d.readJson('counters.json').counters.deaths.value).toBe(1);
    });

    it('breaks a stale lock left by a dead process', async () => {
      await d.get('/api/counters');
      const lockDir = path.join(d.logsDir, 'counters.json.lock');
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: 2 ** 22 + 12345, host: os.hostname(), token: 'dead', acquiredAt: Date.now() }));
      const res = await d.post('/api/counters/deaths/increment');
      expect(res.status).toBe(200);
      expect(d.readJson('counters.json').counters.deaths.value).toBe(1);
      expect(fs.existsSync(lockDir)).toBe(false);
    });
  });

  describe('counter-update broadcasts', () => {
    it.each([
      ['POST /', 'POST', '/api/counters', { name: 'Boss Kills', initialValue: 2 }],
      ['PUT /:name', 'PUT', '/api/counters/deaths', { value: 4 }],
      ['POST /:name/increment', 'POST', '/api/counters/deaths/increment', {}],
      ['POST /:name/decrement', 'POST', '/api/counters/wins/decrement', { amount: 2 }],
      ['POST /:name/reset', 'POST', '/api/counters/deaths/reset', {}],
      ['DELETE /:name', 'DELETE', '/api/counters/losses', undefined]
    ])('%s broadcasts the GET /api/counters array', async (_label, method, url, body) => {
      await d.get('/api/counters');
      const ws = await openWs(d);
      const since = ws.messages.length;
      const res = await d.request(method, url, { body });
      expect(res.status).toBeLessThan(300);
      const msg = await ws.waitFor('counter-update', since);
      expect(msg.data).toEqual((await d.get('/api/counters')).json);
      expect(Array.isArray(msg.data)).toBe(true);
      ws.close();
    });

    it('failed writes broadcast nothing', async () => {
      const ws = await openWs(d);
      const since = ws.messages.length;
      await d.post('/api/counters/nope/increment');
      await d.post('/api/counters', { name: 'x', initialValue: 'abc' });
      await d.put('/api/counters/deaths', { value: 'x' });
      await new Promise(r => setTimeout(r, 100));
      expect(ws.messages.slice(since).filter(m => m.type === 'counter-update')).toEqual([]);
      ws.close();
    });
  });
});
