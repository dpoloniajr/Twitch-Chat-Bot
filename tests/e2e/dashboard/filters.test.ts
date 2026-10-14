/**
 * Characterization: dashboard/routes/filters.js (mounted at /api/filters)
 */
jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('../../../src/lib/console-timestamp', () => ({}));

import * as fs from 'fs';
import { startDashboard, openWs, silenceConsole, Dash } from './helpers';

const DEFAULT_FILTERS = {
  blacklistWords: [],
  filterUrls: false,
  filterAllCaps: false,
  filterRepeatChars: false,
  filterSpam: false,
  timeoutDurationSeconds: 60,
  filterAction: 'warn'
};

describe('dashboard /api/filters', () => {
  let d: Dash;
  beforeEach(async () => {
    silenceConsole();
    d = await startDashboard({ envFile: 'CHAT_FILTER_WORDS=fromenv\nOTHER=keep\n' });
  });
  afterEach(async () => {
    await d.close();
  });

  // The .env words the dashboard loads at startup (beforeEach writes CHAT_FILTER_WORDS=fromenv)
  const ENV_FILTERS = { ...DEFAULT_FILTERS, blacklistWords: ['fromenv'] };

  it('GET / returns the settings loaded from .env at startup', async () => {
    expect((await d.get('/api/filters')).json).toEqual(ENV_FILTERS);
  });

  describe('POST /', () => {
    it('updates the given flags, writes .env and broadcasts', async () => {
      const ws = await openWs(d);
      const since = ws.messages.length;
      const res = await d.post('/api/filters', { filterUrls: 'yes', filterAllCaps: 0, filterRepeatChars: true, filterSpam: true, filterAction: 'timeout', timeoutDurationSeconds: 120 });
      expect(res.json).toEqual({
        success: true,
        filters: { ...ENV_FILTERS, filterUrls: true, filterAllCaps: false, filterRepeatChars: true, filterSpam: true, filterAction: 'timeout', timeoutDurationSeconds: 120 }
      });
      expect(d.readEnv()).toBe([
        'CHAT_FILTER_WORDS=fromenv',
        'OTHER=keep',
        'CHAT_FILTER_URLS=true',
        'CHAT_FILTER_ALLCAPS=false',
        'CHAT_FILTER_REPEAT=true',
        'CHAT_FILTER_SPAM=true',
        'CHAT_FILTER_ACTION=timeout',
        'CHAT_FILTER_TIMEOUT_SEC=120',
        ''
      ].join('\n'));
      const msg = await ws.waitFor('filters', since);
      expect(msg.data.filterAction).toBe('timeout');
      expect((await d.get('/api/filters')).json.filterUrls).toBe(true);
      ws.close();
    });

    it('replaces an existing .env line in place', async () => {
      await d.post('/api/filters', { filterSpam: true });
      await d.post('/api/filters', { filterSpam: false });
      expect(d.readEnv()).toBe('CHAT_FILTER_WORDS=fromenv\nOTHER=keep\nCHAT_FILTER_SPAM=false\n');
    });

    it('ignores invalid filterAction values', async () => {
      const res = await d.post('/api/filters', { filterAction: 'ban' });
      expect(res.json.filters.filterAction).toBe('warn');
      expect(d.readEnv()).toBe('CHAT_FILTER_WORDS=fromenv\nOTHER=keep\n');
    });

    it('clamps the timeout to 10..3600', async () => {
      expect((await d.post('/api/filters', { timeoutDurationSeconds: 5 })).json.filters.timeoutDurationSeconds).toBe(10);
      expect((await d.post('/api/filters', { timeoutDurationSeconds: '99999' })).json.filters.timeoutDurationSeconds).toBe(3600);
      expect(d.readEnv()).toContain('CHAT_FILTER_TIMEOUT_SEC=3600');
    });

    it.each(['abc', null, '', {}])('a non-numeric timeout %p is a 400 and nothing is written', async (timeoutDurationSeconds) => {
      const res = await d.post('/api/filters', { filterSpam: true, timeoutDurationSeconds });
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ success: false, error: 'timeoutDurationSeconds must be a number' });
      expect(d.readEnv()).toBe('CHAT_FILTER_WORDS=fromenv\nOTHER=keep\n');
      expect((await d.get('/api/filters')).json).toEqual(ENV_FILTERS);
    });

    it('an empty body changes nothing', async () => {
      const res = await d.post('/api/filters', {});
      expect(res.json).toEqual({ success: true, filters: ENV_FILTERS });
      expect((await d.request('POST', '/api/filters')).json).toEqual({ success: true, filters: ENV_FILTERS });
    });
  });

  describe('words', () => {
    it('POST /words normalizes, de-duplicates and writes CHAT_FILTER_WORDS', async () => {
      const res = await d.post('/api/filters/words', { word: '  BadWord ' });
      expect(res.json).toEqual({ success: true, words: ['fromenv', 'badword'] });
      const again = await d.post('/api/filters/words', { word: 'badword' });
      expect(again.json).toEqual({ success: true, words: ['fromenv', 'badword'] });
      await d.post('/api/filters/words', { word: 'other' });
      // The words saved in .env are kept and extended
      expect(d.readEnv()).toBe('CHAT_FILTER_WORDS=fromenv|badword|other\nOTHER=keep\n');
    });

    it('POST /words validates the word', async () => {
      const missing = await d.post('/api/filters/words', {});
      expect(missing.status).toBe(400);
      expect(missing.json).toEqual({ success: false, error: 'word is required' });
      const num = await d.post('/api/filters/words', { word: 5 });
      expect(num.status).toBe(400);
      expect(num.json.error).toBe('word must be a string');
    });

    it('POST /words with only whitespace is a 400', async () => {
      const res = await d.post('/api/filters/words', { word: '   ' });
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ success: false, error: 'Word must be a non-empty string' });
    });

    it('POST /words rejects a word with a line break (it would inject .env lines)', async () => {
      const res = await d.post('/api/filters/words', { word: 'bad\nINJECTED=1' });
      expect(res.status).toBe(400);
      expect(d.readEnv()).toBe('CHAT_FILTER_WORDS=fromenv\nOTHER=keep\n');
    });

    it('DELETE /words/:word removes it (URL-decoded, lowercased) and rewrites .env', async () => {
      await d.post('/api/filters/words', { word: 'bad word' });
      await d.post('/api/filters/words', { word: 'keep' });
      const res = await d.del('/api/filters/words/BAD%20WORD');
      expect(res.json).toEqual({ success: true, words: ['fromenv', 'keep'] });
      expect(d.readEnv()).toContain('CHAT_FILTER_WORDS=fromenv|keep\n');
      const missing = await d.del('/api/filters/words/nothere');
      expect(missing.status).toBe(200);
      expect(missing.json).toEqual({ success: true, words: ['fromenv', 'keep'] });
      // A word loaded from .env can be removed too
      expect((await d.del('/api/filters/words/FromEnv')).json).toEqual({ success: true, words: ['keep'] });
    });

    it('DELETE /words/:word decodes once, so "%"-containing words can be removed', async () => {
      await d.post('/api/filters/words', { word: '100%' });
      await d.post('/api/filters/words', { word: 'a%20b' });
      expect((await d.del('/api/filters/words/100%25')).json).toEqual({ success: true, words: ['fromenv', 'a%20b'] });
      expect((await d.del('/api/filters/words/a%2520b')).json).toEqual({ success: true, words: ['fromenv'] });
      expect(d.state.getChatFilters().blacklistWords).toEqual(['fromenv']);
    });

    it('creates .env when missing', async () => {
      fs.rmSync(d.envPath);
      await d.post('/api/filters/words', { word: 'x' });
      expect(d.readEnv()).toBe('CHAT_FILTER_WORDS=fromenv|x\n');
    });
  });
});

describe('dashboard /api/filters: loading .env at startup', () => {
  let d: Dash | null = null;
  beforeEach(() => silenceConsole());
  afterEach(async () => {
    await d?.close();
    d = null;
  });

  it('parses every CHAT_FILTER_* key the way the bot does', async () => {
    d = await startDashboard({
      envFile: [
        'CHAT_FILTER_WORDS= Foo |bar||FOO',
        'CHAT_FILTER_URLS=true',
        'CHAT_FILTER_ALLCAPS=1',
        'CHAT_FILTER_REPEAT=yes',
        'CHAT_FILTER_SPAM=false',
        'CHAT_FILTER_TIMEOUT_SEC=300',
        'CHAT_FILTER_ACTION=timeout'
      ].join('\r\n')
    });
    expect((await d.get('/api/filters')).json).toEqual({
      blacklistWords: ['foo', 'bar'],
      filterUrls: true,
      filterAllCaps: true,
      filterRepeatChars: false,
      filterSpam: false,
      timeoutDurationSeconds: 300,
      filterAction: 'timeout'
    });
  });

  it('keeps the defaults for missing or invalid values', async () => {
    d = await startDashboard({ envFile: 'CHAT_FILTER_TIMEOUT_SEC=abc\nCHAT_FILTER_ACTION=ban\n' });
    expect((await d.get('/api/filters')).json).toEqual(DEFAULT_FILTERS);
  });

  it('works without a .env file', async () => {
    d = await startDashboard();
    expect((await d.get('/api/filters')).json).toEqual(DEFAULT_FILTERS);
  });
});
