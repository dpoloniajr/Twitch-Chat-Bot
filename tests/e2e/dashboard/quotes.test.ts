/**
 * Characterization: dashboard/routes/quotes.js (mounted at /api/quotes)
 */
jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('../../../src/lib/console-timestamp', () => ({}));

import { startDashboard, silenceConsole, openWs, Dash } from './helpers';

const DEFAULT_CONFIG = { maxQuotes: 10000, minLength: 5, maxLength: 500, allowDuplicates: false };

describe('dashboard /api/quotes', () => {
  let d: Dash;
  beforeEach(async () => {
    silenceConsole();
    d = await startDashboard();
  });
  afterEach(async () => {
    await d.close();
  });

  const add = (text: string, addedBy = 'Mod', extra: Record<string, unknown> = {}) =>
    d.post('/api/quotes', { text, addedBy, ...extra });

  describe('GET /', () => {
    it('creates quotes.json and returns an empty page', async () => {
      expect(d.exists('quotes.json')).toBe(false);
      const res = await d.get('/api/quotes');
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ quotes: [], totalQuotes: 0, totalPages: 0, currentPage: 1, pageSize: 20 });
      expect(d.readJson('quotes.json')).toEqual({ quotes: [], config: DEFAULT_CONFIG, nextId: 1, savedAt: expect.any(String) });
    });

    it('paginates and clamps the page number', async () => {
      d.writeJson('quotes.json', {
        quotes: Array.from({ length: 25 }, (_, i) => ({ id: i + 1, text: `quote ${i + 1}`, addedBy: 'm' })),
        config: DEFAULT_CONFIG, nextId: 26
      });
      const p2 = (await d.get('/api/quotes?page=2')).json;
      expect(p2).toMatchObject({ totalQuotes: 25, totalPages: 2, currentPage: 2, pageSize: 20 });
      expect(p2.quotes.map((q: { id: number }) => q.id)).toEqual([21, 22, 23, 24, 25]);
      const big = (await d.get('/api/quotes?page=99&pageSize=10')).json;
      expect(big).toMatchObject({ totalPages: 3, currentPage: 3, pageSize: 10 });
      expect(big.quotes).toHaveLength(5);
      const zero = (await d.get('/api/quotes?page=0&pageSize=0')).json;
      expect(zero).toMatchObject({ currentPage: 1, pageSize: 20 });
    });

    it('searches text, addedBy and game case-insensitively', async () => {
      await add('The cake is a lie', 'alice', { game: 'Portal' });
      await add('Hello world quote', 'bob');
      await add('Another one here', 'carol', { game: 'Halo' });
      const ids = async (q: string) => (await d.get(`/api/quotes?search=${q}`)).json.quotes.map((x: { id: number }) => x.id);
      expect(await ids('CAKE')).toEqual([1]);
      expect(await ids('bob')).toEqual([2]);
      expect(await ids('halo')).toEqual([3]);
      expect(await ids('zzz')).toEqual([]);
    });

    it('search works when quotes lack addedBy or have non-string fields (e.g. imported)', async () => {
      await d.post('/api/quotes/import', { quotes: [{ text: 'imported without author' }, { text: 'odd game', game: 5, addedBy: 7 }] });
      await add('found by author', 'xavier');
      const res = await d.get('/api/quotes?search=x');
      expect(res.status).toBe(200);
      expect(res.json.quotes.map((q: { text: string }) => q.text)).toEqual(['found by author']);
      expect((await d.get('/api/quotes?search=author')).json.totalQuotes).toBe(2);
    });
  });

  describe('POST /', () => {
    it('adds a quote with trimmed text, lowercased author and sequential id', async () => {
      const res = await add('  Quote number one  ', 'SomeMod', { game: 'Elden Ring', context: '' });
      expect(res.status).toBe(201);
      expect(res.json).toEqual({
        success: true,
        quote: { id: 1, text: 'Quote number one', addedBy: 'somemod', addedAt: expect.any(String), game: 'Elden Ring' }
      });
      expect((await add('Quote number two')).json.quote.id).toBe(2);
      const file = d.readJson('quotes.json');
      expect(file.nextId).toBe(3);
      expect(file.quotes).toHaveLength(2);
      expect('context' in file.quotes[0]).toBe(false);
    });

    it('validates required fields and length boundaries', async () => {
      const missing = await d.post('/api/quotes', { text: 'hello there' });
      expect(missing.status).toBe(400);
      expect(missing.json).toEqual({ error: 'Text and addedBy are required' });
      const short = await add('  abcd  ');
      expect(short.status).toBe(400);
      expect(short.json).toEqual({ error: 'Quote must be at least 5 characters' });
      expect((await add('abcde')).status).toBe(201);
      expect((await add('x'.repeat(500))).status).toBe(201);
      const long = await add('y'.repeat(501));
      expect(long.status).toBe(400);
      expect(long.json).toEqual({ error: 'Quote must be at most 500 characters' });
    });

    it('rejects case-insensitive duplicates unless allowDuplicates', async () => {
      await add('Same quote text');
      const dup = await add('SAME QUOTE TEXT');
      expect(dup.status).toBe(400);
      expect(dup.json).toEqual({ error: 'This quote already exists as #1' });

      const file = d.readJson('quotes.json');
      file.config.allowDuplicates = true;
      d.writeJson('quotes.json', file);
      expect((await add('SAME QUOTE TEXT')).status).toBe(201);
    });

    it('enforces maxQuotes', async () => {
      d.writeJson('quotes.json', { quotes: [{ id: 1, text: 'existing', addedBy: 'm' }], config: { ...DEFAULT_CONFIG, maxQuotes: 1 }, nextId: 2 });
      const res = await add('one more quote');
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: 'Maximum quote limit reached' });
    });

    it('concurrent adds get unique sequential ids (file lock)', async () => {
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => add(`concurrent quote ${i}`)));
      expect(results.every(r => r.status === 201)).toBe(true);
      const ids = results.map(r => r.json.quote.id).sort((a: number, b: number) => a - b);
      expect(ids).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      const file = d.readJson('quotes.json');
      expect(file.quotes).toHaveLength(20);
      expect(file.nextId).toBe(21);
    });

    it('concurrent duplicate adds: exactly one wins', async () => {
      const results = await Promise.all(Array.from({ length: 6 }, () => add('racing duplicate')));
      expect(results.filter(r => r.status === 201)).toHaveLength(1);
      expect(d.readJson('quotes.json').quotes).toHaveLength(1);
    });
  });

  describe('GET /:id and /random', () => {
    it('GET /:id returns the quote or 404', async () => {
      await add('first quote');
      expect((await d.get('/api/quotes/1')).json).toMatchObject({ id: 1, text: 'first quote' });
      const missing = await d.get('/api/quotes/2');
      expect(missing.status).toBe(404);
      expect(missing.json).toEqual({ error: 'Quote not found' });
      expect((await d.get('/api/quotes/abc')).status).toBe(404);
      // parseInt('1abc') === 1
      expect((await d.get('/api/quotes/1abc')).json.id).toBe(1);
    });

    it('GET /random 404s when empty and picks Math.random() * length', async () => {
      const empty = await d.get('/api/quotes/random');
      expect(empty.status).toBe(404);
      expect(empty.json).toEqual({ error: 'No quotes available' });
      await add('quote alpha');
      await add('quote beta');
      await add('quote gamma');
      jest.spyOn(Math, 'random').mockReturnValue(0.5);
      expect((await d.get('/api/quotes/random')).json.text).toBe('quote beta');
    });

    it('GET /config returns the config and GET /export all quotes (not quote lookups)', async () => {
      await add('some quote');
      const cfg = await d.get('/api/quotes/config');
      expect(cfg.status).toBe(200);
      expect(cfg.json).toEqual(DEFAULT_CONFIG);
      const exp = await d.get('/api/quotes/export');
      expect(exp.status).toBe(200);
      expect(exp.json).toEqual({ quotes: [expect.objectContaining({ id: 1, text: 'some quote' })], exportedAt: expect.any(String) });
    });

    it('PUT /config merges into the config and is used by later adds', async () => {
      await d.get('/api/quotes');
      const res = await d.put('/api/quotes/config', { minLength: 1 });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ success: true, config: { ...DEFAULT_CONFIG, minLength: 1 } });
      expect(d.readJson('quotes.json').config).toEqual({ ...DEFAULT_CONFIG, minLength: 1 });
      expect((await add('ok')).status).toBe(201);
    });
  });

  describe('PUT /:id', () => {
    it('updates text, game and context; empty strings remove game/context', async () => {
      await add('original text', 'm', { game: 'G', context: 'C' });
      const res = await d.put('/api/quotes/1', { text: '  edited text ', game: '' });
      expect(res.json).toEqual({ success: true, quote: { id: 1, text: 'edited text', addedBy: 'm', addedAt: expect.any(String), context: 'C' } });
      const res2 = await d.put('/api/quotes/1', { context: 'new' });
      expect(res2.json.quote).toMatchObject({ text: 'edited text', context: 'new' });
      expect(d.readJson('quotes.json').quotes[0]).toEqual({ id: 1, text: 'edited text', addedBy: 'm', addedAt: expect.any(String), context: 'new' });
    });

    it('validates text length and 404s on unknown ids', async () => {
      await add('original text');
      const short = await d.put('/api/quotes/1', { text: 'abc' });
      expect(short.status).toBe(400);
      expect(short.json).toEqual({ error: 'Quote must be at least 5 characters' });
      const missing = await d.put('/api/quotes/9', { text: 'valid text' });
      expect(missing.status).toBe(404);
    });

    it('rejects editing into a duplicate of another quote unless allowDuplicates', async () => {
      await add('first unique');
      await add('second unique');
      const dup = await d.put('/api/quotes/2', { text: 'FIRST UNIQUE' });
      expect(dup.status).toBe(400);
      expect(dup.json).toEqual({ error: 'This quote already exists as #1' });
      expect(d.readJson('quotes.json').quotes[1].text).toBe('second unique');
      // Re-saving a quote with its own text (e.g. changing case) is not a duplicate
      expect((await d.put('/api/quotes/2', { text: 'SECOND UNIQUE' })).status).toBe(200);
      const file = d.readJson('quotes.json');
      file.config.allowDuplicates = true;
      d.writeJson('quotes.json', file);
      expect((await d.put('/api/quotes/2', { text: 'FIRST UNIQUE' })).status).toBe(200);
    });
  });

  describe('DELETE /:id', () => {
    it('removes the quote; ids are not reused', async () => {
      await add('quote one!');
      await add('quote two!');
      expect((await d.del('/api/quotes/1')).json).toEqual({ success: true });
      const missing = await d.del('/api/quotes/1');
      expect(missing.status).toBe(404);
      expect(missing.json).toEqual({ error: 'Quote not found' });
      expect((await add('quote three!')).json.quote.id).toBe(3);
      expect(d.readJson('quotes.json').quotes.map((q: { id: number }) => q.id)).toEqual([2, 3]);
    });
  });

  describe('POST /import', () => {
    it('requires an array', async () => {
      const res = await d.post('/api/quotes/import', { quotes: 'nope' });
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: 'Quotes must be an array' });
    });

    it('merges by default, skipping duplicates and quotes without text, and re-numbers ids', async () => {
      await add('existing quote');
      const res = await d.post('/api/quotes/import', {
        quotes: [
          { id: 99, text: 'Imported A', addedBy: 'x', extra: true },
          { text: 'EXISTING QUOTE' },
          { addedBy: 'no text' },
          { text: 'imported a' },
          { text: 'x' }
        ]
      });
      // 'x' is shorter than config.minLength, so it is skipped too
      expect(res.json).toEqual({ success: true, imported: 1, skipped: 4 });
      const file = d.readJson('quotes.json');
      // Only known fields are kept; addedAt is filled in when missing
      expect(file.quotes).toEqual([
        expect.objectContaining({ id: 1, text: 'existing quote' }),
        { id: 2, text: 'Imported A', addedBy: 'x', addedAt: expect.any(String) }
      ]);
      expect(file.nextId).toBe(3);
    });

    it('enforces the configured length limits, trims text and normalizes fields', async () => {
      const long = 'y'.repeat(501);
      const res = await d.post('/api/quotes/import', {
        quotes: [
          { text: '  padded quote  ', addedBy: '  MixedCase ', addedAt: '2024-01-02T03:04:05.000Z', game: ' Game ', context: '' },
          { text: long },
          { text: 'okay quote', addedAt: 'not a date', addedBy: 42 },
          null
        ]
      });
      expect(res.json).toEqual({ success: true, imported: 2, skipped: 2 });
      expect(d.readJson('quotes.json').quotes).toEqual([
        { id: 1, text: 'padded quote', addedBy: 'mixedcase', addedAt: '2024-01-02T03:04:05.000Z', game: 'Game' },
        { id: 2, text: 'okay quote', addedBy: 'unknown', addedAt: expect.any(String) }
      ]);
    });

    it('merge into a quotes.json without quotes/nextId (hand-edited) works', async () => {
      d.writeJson('quotes.json', { config: DEFAULT_CONFIG });
      const res = await d.post('/api/quotes/import', { quotes: [{ text: 'first import' }] });
      expect(res.json).toEqual({ success: true, imported: 1, skipped: 0 });
      expect(d.readJson('quotes.json')).toMatchObject({ quotes: [{ id: 1, text: 'first import' }], nextId: 2 });
      d.writeJson('quotes.json', { quotes: [{ id: 7, text: 'kept' }], config: DEFAULT_CONFIG });
      await d.post('/api/quotes/import', { quotes: [{ text: 'next one' }] });
      expect(d.readJson('quotes.json').quotes.map((q: { id: number }) => q.id)).toEqual([7, 8]);
    });

    it('skips entries that are not objects with string text', async () => {
      const res = await d.post('/api/quotes/import', { quotes: [null, 5, { text: 12 }, { text: 'valid one' }] });
      expect(res.json).toEqual({ success: true, imported: 1, skipped: 3 });
    });

    it('merge:false replaces all quotes and restarts ids at 1', async () => {
      await add('old quote 1');
      await add('old quote 2');
      const res = await d.post('/api/quotes/import', { merge: false, quotes: [{ text: 'old quote 1' }, { text: 'brand new' }] });
      expect(res.json).toEqual({ success: true, imported: 2, skipped: 0 });
      const file = d.readJson('quotes.json');
      expect(file.quotes.map((q: { id: number; text: string }) => [q.id, q.text])).toEqual([[1, 'old quote 1'], [2, 'brand new']]);
      expect(file.nextId).toBe(3);
    });
  });

  describe('quote-update broadcasts', () => {
    it('add and edit broadcast the quote itself (same JSON as GET /random)', async () => {
      const ws = await openWs(d);
      let since = ws.messages.length;
      const created = await add('Broadcast me please', 'Mod', { game: 'Halo' });
      const msg = await ws.waitFor('quote-update', since);
      expect(msg.data).toEqual(created.json.quote);
      expect(msg.data).toEqual((await d.get('/api/quotes/random')).json);

      since = ws.messages.length;
      const edited = await d.put('/api/quotes/1', { text: 'Edited quote text' });
      expect((await ws.waitFor('quote-update', since)).data).toEqual(edited.json.quote);
      ws.close();
    });

    it('delete, import and config changes broadcast a payload without text', async () => {
      await add('to be deleted');
      const ws = await openWs(d);
      let since = ws.messages.length;
      await d.del('/api/quotes/1');
      expect((await ws.waitFor('quote-update', since)).data).toEqual({ id: 1, deleted: true });
      since = ws.messages.length;
      await d.post('/api/quotes/import', { quotes: [{ text: 'imported quote' }] });
      expect((await ws.waitFor('quote-update', since)).data).toEqual({ imported: 1, skipped: 0 });
      since = ws.messages.length;
      await d.put('/api/quotes/config', { maxLength: 100 });
      expect((await ws.waitFor('quote-update', since)).data).toEqual({ config: { ...DEFAULT_CONFIG, maxLength: 100 } });
      ws.close();
    });

    it('failed writes broadcast nothing', async () => {
      const ws = await openWs(d);
      const since = ws.messages.length;
      await add('x');
      await d.put('/api/quotes/99', { text: 'nope nope' });
      await d.del('/api/quotes/99');
      await new Promise(r => setTimeout(r, 100));
      expect(ws.messages.slice(since).filter(m => m.type === 'quote-update')).toEqual([]);
      ws.close();
    });
  });
});
