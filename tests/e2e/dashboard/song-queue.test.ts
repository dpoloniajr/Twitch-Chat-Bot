/**
 * Characterization: dashboard/routes/song-queue.js (mounted at /api/song-queue).
 * The x-bot-secret guard in front of it is covered in server.test.ts.
 */
jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('../../../src/lib/console-timestamp', () => ({}));

import * as fs from 'fs';
import * as path from 'path';
import { startDashboard, openWs, silenceConsole, Dash } from './helpers';

const DEFAULT_CONFIG = { enabled: true, cost: 0, maxDuration: 600, maxPerUser: 3, allowDuplicates: false, priority: 'everyone' };

const song = (n: number, extra: Record<string, unknown> = {}) => ({
  videoId: `vid${n}`,
  title: `Song ${n}`,
  channelTitle: `Channel ${n}`,
  channelId: `ch${n}`,
  durationSeconds: 200,
  durationFormatted: '3:20',
  requester: `user${n}`,
  ...extra
});

const loyaltyWith = (users: Record<string, number>) => ({
  users: Object.fromEntries(Object.entries(users).map(([u, points]) => [u, { points, totalEarned: points, totalSpent: 0 }])),
  config: {},
  transactions: []
});

describe('dashboard /api/song-queue', () => {
  let d: Dash;
  beforeEach(async () => {
    silenceConsole();
    d = await startDashboard();
  });
  afterEach(async () => {
    await d.close();
  });

  const add = (body: Record<string, unknown>) => d.post('/api/song-queue/add', body);

  describe('GET and config', () => {
    it('GET / creates song-queue.json with the default config', async () => {
      const res = await d.get('/api/song-queue');
      expect(res.json).toEqual({ active: [], history: [], config: DEFAULT_CONFIG, savedAt: expect.any(String) });
      expect(d.readJson('song-queue.json').config).toEqual(DEFAULT_CONFIG);
      expect((await d.get('/api/song-queue/config')).json).toEqual(DEFAULT_CONFIG);
    });

    it('PUT /config merges valid keys and broadcasts', async () => {
      const ws = await openWs(d);
      const since = ws.messages.length;
      const res = await d.put('/api/song-queue/config', { cost: 100, priority: 'subs', enabled: false });
      expect(res.json).toEqual({ success: true, config: { ...DEFAULT_CONFIG, cost: 100, priority: 'subs', enabled: false } });
      expect(d.readJson('song-queue.json').config.cost).toBe(100);
      expect((await ws.waitFor('song-queue-config-update', since)).data.cost).toBe(100);
      ws.close();
    });

    it('PUT /config validates keys and values', async () => {
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ bogus: 1, other: 2 }, 'Invalid config keys: bogus, other'],
        [{ enabled: 'yes' }, 'enabled must be a boolean'],
        [{ cost: -1 }, 'cost must be a non-negative number'],
        [{ cost: '5' }, 'cost must be a non-negative number'],
        [{ maxDuration: 0 }, 'maxDuration must be a positive number'],
        [{ maxPerUser: 0 }, 'maxPerUser must be a positive number'],
        [{ allowDuplicates: 1 }, 'allowDuplicates must be a boolean'],
        [{ priority: 'mods' }, 'priority must be everyone, subs, or vips']
      ];
      for (const [body, error] of cases) {
        const res = await d.put('/api/song-queue/config', body);
        expect(res.status).toBe(400);
        expect(res.json).toEqual({ success: false, error });
      }
      expect((await d.get('/api/song-queue/config')).json).toEqual(DEFAULT_CONFIG);
      // boundary values are accepted
      expect((await d.put('/api/song-queue/config', { cost: 0, maxDuration: 1, maxPerUser: 1 })).status).toBe(200);
    });
  });

  describe('POST /add', () => {
    it('adds songs with defaults, positions and a broadcast', async () => {
      const ws = await openWs(d);
      const since = ws.messages.length;
      const res = await add({ videoId: 'v1', title: 'T1', requester: 'Alice', durationSeconds: 200 });
      expect(res.json).toEqual({
        success: true,
        song: {
          id: expect.stringMatching(/^[0-9a-f]{16}$/),
          videoId: 'v1', title: 'T1', channelTitle: 'Unknown', channelId: '', thumbnail: '',
          requester: 'Alice', requesterDisplayName: 'Alice', durationSeconds: 200, addedAt: expect.any(String), position: 1, pointsCost: 0
        },
        position: 1,
        queueLength: 1
      });
      const res2 = await add(song(2));
      expect(res2.json).toMatchObject({ position: 2, queueLength: 2 });
      const file = d.readJson('song-queue.json');
      expect(file.active.map((s: { videoId: string; position: number }) => [s.videoId, s.position])).toEqual([['v1', 1], ['vid2', 2]]);
      const msg = await ws.waitFor('song-queue-update', since);
      expect(msg.data).toMatchObject({ action: 'add', song: { videoId: 'v1' } });
      ws.close();
    });

    it('requires videoId, title and requester', async () => {
      const res = await add({ videoId: 'v', title: 't' });
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: 'Missing required fields: videoId, title, requester' });
    });

    it('403 when disabled', async () => {
      await d.put('/api/song-queue/config', { enabled: false });
      const res = await add(song(1));
      expect(res.status).toBe(403);
      expect(res.json).toEqual({ error: 'Song requests are currently disabled.' });
    });

    it('subs / vips restrictions with mod and broadcaster bypass', async () => {
      await d.put('/api/song-queue/config', { priority: 'subs' });
      const viewer = await add(song(1));
      expect(viewer.status).toBe(403);
      expect(viewer.json).toEqual({ error: 'Song requests are restricted to subscribers only.' });
      expect((await add(song(2, { requesterIsSub: true }))).status).toBe(200);
      expect((await add(song(3, { requesterIsMod: true }))).status).toBe(200);
      await d.put('/api/song-queue/config', { priority: 'vips' });
      const sub = await add(song(4, { requesterIsSub: true }));
      expect(sub.status).toBe(403);
      expect(sub.json).toEqual({ error: 'Song requests are restricted to VIPs only.' });
      expect((await add(song(5, { requesterIsVip: true }))).status).toBe(200);
      expect((await add(song(6, { requesterIsBroadcaster: true }))).status).toBe(200);
    });

    it('rejects songs longer than maxDuration (boundary allowed)', async () => {
      expect((await add(song(1, { durationSeconds: 600 }))).status).toBe(200);
      const res = await add(song(2, { durationSeconds: 601 }));
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: 'Song is too long. Maximum duration is 10 minutes.' });
      for (const durationSeconds of [undefined, -1, '60', null]) {
        const bad = await add(song(3, { durationSeconds: durationSeconds as any }));
        expect(bad.status).toBe(400);
        expect(bad.json).toEqual({ error: 'Missing or invalid durationSeconds' });
      }
      expect((await add(song(4, { durationSeconds: 0 }))).status).toBe(200);
    });

    it('enforces maxPerUser case-insensitively, mods exempt', async () => {
      for (let i = 1; i <= 3; i++) expect((await add(song(i, { requester: i === 2 ? 'BOB' : 'bob' }))).status).toBe(200);
      const res = await add(song(4, { requester: 'Bob' }));
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: 'You already have 3 song(s) in the queue. Maximum per user is 3.' });
      expect((await add(song(5, { requester: 'bob', requesterIsMod: true }))).status).toBe(200);
    });

    it('rejects duplicates unless allowDuplicates', async () => {
      await add(song(1));
      const dup = await add(song(1, { requester: 'other' }));
      expect(dup.status).toBe(400);
      expect(dup.json).toEqual({ error: 'This song is already in the queue.' });
      await d.put('/api/song-queue/config', { allowDuplicates: true });
      expect((await add(song(1, { requester: 'other' }))).status).toBe(200);
    });

    it('rejects blocked videos, channels and keywords (case-insensitive, title or channel name)', async () => {
      await d.post('/api/song-queue/block', { type: 'video', value: 'vid1' });
      await d.post('/api/song-queue/block', { type: 'channel', value: 'ch2' });
      await d.post('/api/song-queue/block', { type: 'keyword', value: 'EarRape' });
      expect((await add(song(1))).json).toEqual({ error: 'This video is blocked.' });
      expect((await add(song(2))).json).toEqual({ error: 'Videos from this channel are blocked.' });
      const kw = await add(song(3, { title: 'Loud earrape remix' }));
      expect(kw.status).toBe(403);
      expect(kw.json).toEqual({ error: 'Song contains blocked keyword: EarRape' });
      expect((await add(song(4, { channelTitle: 'EARRAPE TV' }))).status).toBe(403);
      expect((await add(song(5))).status).toBe(200);
    });

    describe('with a points cost', () => {
      beforeEach(async () => {
        await d.put('/api/song-queue/config', { cost: 100 });
      });

      it('is free when loyalty.json does not exist, and records pointsCost 0 (nothing was charged)', async () => {
        const res = await add(song(1));
        expect(res.status).toBe(200);
        expect(res.json.song.pointsCost).toBe(0);
        expect(d.exists('loyalty.json')).toBe(false);
      });

      it('refuses (503) rather than giving a free song when loyalty.json is corrupt', async () => {
        fs.writeFileSync(path.join(d.logsDir, 'loyalty.json'), '{ broken');
        const res = await add(song(1));
        expect(res.status).toBe(503);
        expect(d.readJson('song-queue.json').active).toEqual([]);
      });

      it('deducts points; 402 for unknown or poor requesters; mods are exempt', async () => {
        d.writeJson('loyalty.json', loyaltyWith({ rich: 150, poor: 99 }));
        const ok = await add(song(1, { requester: 'Rich', title: 'Paid Song' }));
        expect(ok.json.song.pointsCost).toBe(100);
        const loyalty = d.readJson('loyalty.json');
        expect(loyalty.users.rich).toMatchObject({ points: 50, totalSpent: 100 });
        expect(loyalty.transactions[0]).toMatchObject({ username: 'rich', amount: -100, type: 'spend', reason: 'Song request: Paid Song' });

        const poor = await add(song(2, { requester: 'poor' }));
        expect(poor.status).toBe(402);
        expect(poor.json).toEqual({ error: 'Insufficient points. This request costs 100 points. You have 99.' });
        const ghost = await add(song(3, { requester: 'ghost' }));
        expect(ghost.status).toBe(402);
        expect(ghost.json).toEqual({ error: 'You have no loyalty points yet. This request costs 100 points.' });

        const mod = await add(song(4, { requester: 'poor', requesterIsMod: true }));
        expect(mod.json.song.pointsCost).toBe(0);
        const broadcaster = await add(song(5, { requester: 'poor', requesterIsBroadcaster: true }));
        expect(broadcaster.json.song.pointsCost).toBe(0);
        expect(d.readJson('loyalty.json').users.poor.points).toBe(99);

        // Removing the free songs refunds nothing
        await d.del('/api/song-queue/2');
        await d.del('/api/song-queue/2');
        expect(d.readJson('loyalty.json').users.poor).toMatchObject({ points: 99, totalSpent: 0 });
      });

      it('concurrent paid requests are charged exactly once each, never overspending', async () => {
        d.writeJson('loyalty.json', loyaltyWith({ fan: 250 }));
        await d.put('/api/song-queue/config', { maxPerUser: 10 });
        const results = await Promise.all(Array.from({ length: 5 }, (_, i) => add(song(i, { requester: 'fan' }))));
        expect(results.map(r => r.status).sort()).toEqual([200, 200, 402, 402, 402]);
        expect(d.readJson('loyalty.json').users.fan.points).toBe(50);
        expect(d.readJson('song-queue.json').active).toHaveLength(2);
      });

      it('charges and refunds broadcast loyalty-update', async () => {
        d.writeJson('loyalty.json', loyaltyWith({ rich: 150 }));
        const ws = await openWs(d);
        let since = ws.messages.length;
        await add(song(1, { requester: 'rich' }));
        expect((await ws.waitFor('loyalty-update', since)).data).toEqual([{ username: 'rich', points: 50, level: 1, watchTimeMinutes: 0, rank: 1 }]);
        since = ws.messages.length;
        await d.del('/api/song-queue/1');
        expect((await ws.waitFor('loyalty-update', since)).data[0].points).toBe(150);
        ws.close();
      });
    });
  });

  describe('POST /skip', () => {
    it('empty queue answers 200 with success:false', async () => {
      const res = await d.post('/api/song-queue/skip');
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ success: false, error: 'No song to skip. Queue is empty.' });
    });

    it('moves the first song to history and renumbers', async () => {
      await add(song(1));
      await add(song(2));
      const ws = await openWs(d);
      const since = ws.messages.length;
      const res = await d.post('/api/song-queue/skip');
      expect(res.json).toEqual({ success: true, skippedSong: expect.objectContaining({ videoId: 'vid1' }), queueLength: 1 });
      const file = d.readJson('song-queue.json');
      expect(file.active.map((s: { videoId: string; position: number }) => [s.videoId, s.position])).toEqual([['vid2', 1]]);
      expect(file.history[0]).toMatchObject({ videoId: 'vid1', action: 'skipped', skippedAt: expect.any(String) });
      expect((await ws.waitFor('song-queue-update', since)).data.action).toBe('skip');
      ws.close();
    });

    it('with a stale songId does nothing', async () => {
      const first = await add(song(1));
      await d.post('/api/song-queue/skip', { songId: first.json.song.id });
      const again = await d.post('/api/song-queue/skip', { songId: first.json.song.id });
      expect(again.json).toEqual({ success: false, error: 'No song to skip. Queue is empty.' });
      await add(song(2));
      const stale = await d.post('/api/song-queue/skip', { songId: first.json.song.id });
      expect(stale.json).toEqual({ success: false, error: 'Song already skipped.' });
      expect(d.readJson('song-queue.json').active).toHaveLength(1);
    });

    it('does not refund points', async () => {
      d.writeJson('loyalty.json', loyaltyWith({ fan: 100 }));
      await d.put('/api/song-queue/config', { cost: 40 });
      await add(song(1, { requester: 'fan' }));
      await d.post('/api/song-queue/skip');
      expect(d.readJson('loyalty.json').users.fan.points).toBe(60);
    });

    it('keeps at most 100 history entries', async () => {
      await d.get('/api/song-queue');
      const q = d.readJson('song-queue.json');
      q.history = Array.from({ length: 100 }, (_, i) => ({ videoId: `h${i}` }));
      d.writeJson('song-queue.json', q);
      await add(song(1));
      await d.post('/api/song-queue/skip');
      const history = d.readJson('song-queue.json').history;
      expect(history).toHaveLength(100);
      expect(history[0].videoId).toBe('vid1');
      expect(history[99].videoId).toBe('h98');
    });
  });

  describe('DELETE /:target', () => {
    beforeEach(async () => {
      d.writeJson('loyalty.json', loyaltyWith({ user1: 100, user2: 100, user3: 100 }));
      await d.put('/api/song-queue/config', { cost: 10 });
      await add(song(1, { title: 'Alpha' }));
      await add(song(2, { title: '2pac Changes' }));
      await add(song(3, { title: 'Gamma', channelTitle: 'Special Channel' }));
    });

    it('removes by position, refunds and renumbers', async () => {
      const res = await d.del('/api/song-queue/1');
      expect(res.json).toEqual({ success: true, removedSong: expect.objectContaining({ title: 'Alpha' }), queueLength: 2 });
      const file = d.readJson('song-queue.json');
      expect(file.active.map((s: { position: number }) => s.position)).toEqual([1, 2]);
      expect(file.history[0]).toMatchObject({ title: 'Alpha', action: 'removed' });
      const loyalty = d.readJson('loyalty.json');
      expect(loyalty.users.user1).toMatchObject({ points: 100, totalSpent: 0 });
      expect(loyalty.transactions.at(-1)).toMatchObject({ username: 'user1', amount: 10, type: 'refund', reason: 'Song request removed: Alpha' });
    });

    it('treats mixed strings and out-of-range numbers as keywords', async () => {
      const byKeyword = await d.del('/api/song-queue/2pac');
      expect(byKeyword.json.removedSong.title).toBe('2pac Changes');
      const byChannel = await d.del('/api/song-queue/special%20channel');
      expect(byChannel.json.removedSong.title).toBe('Gamma');
      const outOfRange = await d.del('/api/song-queue/9');
      expect(outOfRange.status).toBe(200);
      expect(outOfRange.json).toEqual({ success: false, error: 'No song found matching "9".' });
      expect((await d.del('/api/song-queue/0')).json.success).toBe(false);
    });

    it('empty queue answers success:false', async () => {
      await d.post('/api/song-queue/clear');
      expect((await d.del('/api/song-queue/1')).json).toEqual({ success: false, error: 'Queue is empty.' });
    });
  });

  describe('blocklist', () => {
    it('GET /blocklist creates an empty blocklist and lists what POST /block adds', async () => {
      expect((await d.get('/api/song-queue/blocklist')).json).toEqual({ videos: [], channels: [], keywords: [] });
      await d.post('/api/song-queue/block', { type: 'video', value: 'vid1' });
      await d.post('/api/song-queue/block', { type: 'channel', value: 'ch9' });
      await d.post('/api/song-queue/block', { type: 'keyword', value: 'Earrape' });
      expect((await d.get('/api/song-queue/blocklist')).json).toEqual({ videos: ['vid1'], channels: ['ch9'], keywords: ['Earrape'] });
      await d.del('/api/song-queue/block/ch9');
      expect((await d.get('/api/song-queue/blocklist')).json.channels).toEqual([]);
    });

    it('GET /blocklist fills in lists a hand-edited file lacks, and never returns savedAt', async () => {
      d.writeJson('song-blocklist.json', { videos: ['x'], savedAt: '2026-01-01' });
      expect((await d.get('/api/song-queue/blocklist')).json).toEqual({ videos: ['x'], channels: [], keywords: [] });
    });

    it('POST /block validates input', async () => {
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ type: 'video' }, 'Missing required fields: type, value'],
        [{ type: 'user', value: 'x' }, 'type must be video, channel, or keyword'],
        [{ type: 'video', value: '   ' }, 'value cannot be empty']
      ];
      for (const [body, error] of cases) {
        const res = await d.post('/api/song-queue/block', body);
        expect(res.status).toBe(400);
        expect(res.json).toEqual({ success: false, error });
      }
    });

    it('POST /block writes the blocklist, removes matching queued songs and refunds them', async () => {
      d.writeJson('loyalty.json', loyaltyWith({ user1: 100, user2: 100 }));
      await d.put('/api/song-queue/config', { cost: 10 });
      await add(song(1, { title: 'Bad Words Song' }));
      await add(song(2));
      const ws = await openWs(d);
      const since = ws.messages.length;
      const res = await d.post('/api/song-queue/block', { type: 'keyword', value: ' bad words ' });
      expect(res.json).toEqual({ success: true, type: 'keyword', value: 'bad words', removedCount: 1 });
      expect(d.readJson('song-blocklist.json')).toEqual({ videos: [], channels: [], keywords: ['bad words'], savedAt: expect.any(String) });
      const q = d.readJson('song-queue.json');
      expect(q.active.map((s: { videoId: string; position: number }) => [s.videoId, s.position])).toEqual([['vid2', 1]]);
      expect(q.history[0]).toMatchObject({ videoId: 'vid1', action: 'blocked', blockType: 'keyword', blockValue: 'bad words' });
      expect(d.readJson('loyalty.json').users.user1.points).toBe(100);
      const update = await ws.waitFor('song-queue-update', since);
      expect(update.data).toMatchObject({ action: 'block-removed', removedCount: 1 });
      const blockMsg = await ws.waitFor('song-queue-blocklist-update', since);
      expect(blockMsg.data).toEqual({ action: 'add', blockType: 'keyword', value: 'bad words' });
      ws.close();
    });

    it('POST /block rejects duplicates (keywords case-insensitively)', async () => {
      await d.post('/api/song-queue/block', { type: 'video', value: 'abc' });
      await d.post('/api/song-queue/block', { type: 'channel', value: 'UC1' });
      await d.post('/api/song-queue/block', { type: 'keyword', value: 'Word' });
      expect((await d.post('/api/song-queue/block', { type: 'video', value: 'abc' })).json.error).toBe('Video is already blocked.');
      expect((await d.post('/api/song-queue/block', { type: 'channel', value: 'UC1' })).json.error).toBe('Channel is already blocked.');
      expect((await d.post('/api/song-queue/block', { type: 'keyword', value: 'WORD' })).json.error).toBe('Keyword is already blocked.');
      // video ids are case-sensitive
      expect((await d.post('/api/song-queue/block', { type: 'video', value: 'ABC' })).status).toBe(200);
    });

    it('DELETE /block/:id removes videos, channels or keywords', async () => {
      await d.post('/api/song-queue/block', { type: 'video', value: 'abc' });
      await d.post('/api/song-queue/block', { type: 'channel', value: 'UC1' });
      await d.post('/api/song-queue/block', { type: 'keyword', value: 'Some Word' });
      expect((await d.del('/api/song-queue/block/abc')).json).toEqual({ success: true, type: 'video', value: 'abc' });
      expect((await d.del('/api/song-queue/block/UC1')).json).toEqual({ success: true, type: 'channel', value: 'UC1' });
      expect((await d.del('/api/song-queue/block/some%20word')).json).toEqual({ success: true, type: 'keyword', value: 'Some Word' });
      expect(d.readJson('song-blocklist.json')).toMatchObject({ videos: [], channels: [], keywords: [] });
      const missing = await d.del('/api/song-queue/block/abc');
      expect(missing.status).toBe(200);
      expect(missing.json).toEqual({ success: false, error: '"abc" not found in blocklist.' });
      const blank = await d.del('/api/song-queue/block/%20');
      expect(blank.status).toBe(400);
      expect(blank.json).toEqual({ success: false, error: 'Identifier cannot be empty' });
    });

    it('DELETE /block/:id decodes the id once, so "%" and "%xx" text in keywords works', async () => {
      await d.post('/api/song-queue/block', { type: 'keyword', value: '100%' });
      await d.post('/api/song-queue/block', { type: 'keyword', value: 'a%20b' });
      expect((await d.del('/api/song-queue/block/100%25')).json).toEqual({ success: true, type: 'keyword', value: '100%' });
      expect((await d.del('/api/song-queue/block/a%2520b')).json).toEqual({ success: true, type: 'keyword', value: 'a%20b' });
      expect(d.readJson('song-blocklist.json').keywords).toEqual([]);
    });
  });

  describe('POST /clear', () => {
    it('empty queue', async () => {
      expect((await d.post('/api/song-queue/clear')).json).toEqual({ success: true, clearedCount: 0, message: 'Queue is already empty.' });
    });

    it('moves everything to history and refunds each paid song', async () => {
      d.writeJson('loyalty.json', loyaltyWith({ user1: 50, user2: 50 }));
      await d.put('/api/song-queue/config', { cost: 20 });
      await add(song(1));
      await add(song(2));
      const one = await d.post('/api/song-queue/clear');
      expect(one.json).toEqual({ success: true, clearedCount: 2, message: 'Cleared 2 songs from the queue.' });
      const q = d.readJson('song-queue.json');
      expect(q.active).toEqual([]);
      expect(q.history.map((s: { videoId: string; action: string }) => [s.videoId, s.action])).toEqual([['vid1', 'cleared'], ['vid2', 'cleared']]);
      const loyalty = d.readJson('loyalty.json');
      expect(loyalty.users.user1.points).toBe(50);
      expect(loyalty.users.user2.points).toBe(50);
      await add(song(3, { requesterIsMod: true }));
      expect((await d.post('/api/song-queue/clear')).json.message).toBe('Cleared 1 song from the queue.');
      // The mod paid nothing, so clearing refunds nothing (no loyalty user is created)
      expect(d.readJson('loyalty.json').users.user3).toBeUndefined();
    });
  });

  describe('concurrent writes (file locks)', () => {
    it('parallel adds keep every song, numbered 1..n', async () => {
      await d.put('/api/song-queue/config', { maxPerUser: 20 });
      const results = await Promise.all(Array.from({ length: 12 }, (_, i) => add(song(i))));
      expect(results.every(r => r.status === 200)).toBe(true);
      const active = d.readJson('song-queue.json').active as Array<{ videoId: string; position: number }>;
      expect(active.map(s => s.videoId).sort()).toEqual(Array.from({ length: 12 }, (_, i) => `vid${i}`).sort());
      expect(active.map(s => s.position)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    });

    it('parallel blocks keep every entry', async () => {
      await Promise.all(Array.from({ length: 10 }, (_, i) => d.post('/api/song-queue/block', { type: 'keyword', value: `word${i}` })));
      expect(d.readJson('song-blocklist.json').keywords.sort()).toEqual(Array.from({ length: 10 }, (_, i) => `word${i}`).sort());
    });

    it('a skip racing with adds and removals loses nothing', async () => {
      await d.put('/api/song-queue/config', { maxPerUser: 20 });
      for (let i = 0; i < 4; i++) await add(song(i));
      await Promise.all([
        d.post('/api/song-queue/skip'),
        add(song(10)),
        add(song(11)),
        d.del('/api/song-queue/Song%203')
      ]);
      const q = d.readJson('song-queue.json');
      expect(q.active.map((s: { videoId: string }) => s.videoId).sort()).toEqual(['vid1', 'vid10', 'vid11', 'vid2']);
      expect(q.history).toHaveLength(2);
      expect(fs.readdirSync(d.logsDir).filter(f => f.endsWith('.lock'))).toEqual([]);
    });
  });
});
