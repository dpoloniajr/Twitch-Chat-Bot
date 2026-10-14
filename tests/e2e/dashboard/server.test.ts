/**
 * Characterization: dashboard/server.js (createDashboard) - middleware, static files, 404s, error
 * handling, WebSocket broadcast, the song-queue x-bot-secret guard, init() and close().
 */
jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('../../../src/lib/console-timestamp', () => ({}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { startDashboard, openWs, silenceConsole, externalIPv4, httpRequest, ROOT, Dash, DashboardModule } from './helpers';
import { DEFAULT_BUILTIN_COMMANDS } from '../../../src/dashboard/lib/constants';

describe('dashboard server', () => {
  let d: Dash;
  beforeEach(async () => {
    silenceConsole();
    d = await startDashboard();
  });
  afterEach(async () => {
    await d.close();
  });

  it('GET /health', async () => {
    const res = await d.get('/health');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: 'ok' });
  });

  describe('static files', () => {
    it('serves dashboard/public at /', async () => {
      const index = await d.get('/');
      expect(index.status).toBe(200);
      expect(index.headers['content-type']).toMatch(/text\/html/);
      expect(index.text).toBe(fs.readFileSync(path.join(ROOT, 'dashboard', 'public', 'index.html'), 'utf8'));
      expect((await d.get('/app.js')).headers['content-type']).toMatch(/javascript/);
      expect((await d.get('/style.css')).headers['content-type']).toMatch(/text\/css/);
    });

    it('serves uploads from the configured uploads dir', async () => {
      fs.writeFileSync(path.join(d.uploadsDir, 'sounds', 'x.mp3'), 'ID3abc');
      const res = await d.get('/uploads/sounds/x.mp3');
      expect(res.status).toBe(200);
      expect(res.text).toBe('ID3abc');
    });
  });

  describe('404s and errors', () => {
    it('unknown routes get the Express default HTML 404', async () => {
      for (const [method, url] of [['GET', '/nope'], ['GET', '/api/nope'], ['POST', '/api/nope'], ['PATCH', '/api/logs']]) {
        const res = await d.request(method, url);
        expect(res.status).toBe(404);
        expect(res.headers['content-type']).toMatch(/text\/html/);
        expect(res.text).toContain(`Cannot ${method} ${url}`);
      }
    });

    it('malformed JSON is a 400 from the global error handler', async () => {
      const res = await d.request('POST', '/api/chat', { raw: '{"message": ' });
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ success: false, error: expect.stringMatching(/JSON/) });
    });

    it('accepts urlencoded bodies', async () => {
      const res = await d.request('POST', '/api/chat', { raw: 'message=hello&user=v', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ success: true });
    });
  });

  describe('WebSocket', () => {
    it('sends the current state on connect and broadcasts to every client', async () => {
      const a = await openWs(d);
      const b = await openWs(d);
      const first = await a.waitFor('state');
      expect(first.data).toMatchObject({ isConnected: false, commandsExecuted: 0 });
      const sinceA = a.messages.length;
      const sinceB = b.messages.length;
      await d.post('/api/chat', { message: 'hi' });
      expect((await a.waitFor('chat', sinceA)).data.message).toBe('hi');
      expect((await b.waitFor('chat', sinceB)).data.message).toBe('hi');
      a.close();
      b.close();
    });

    it('close() terminates clients and stops listening', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const WebSocket = require('ws');
      const ws = new WebSocket(`ws://127.0.0.1:${d.port}`);
      await new Promise(r => ws.once('open', r));
      const closed = new Promise(r => ws.once('close', r));
      const port = d.port;
      await d.close();
      await closed;
      await expect(httpRequest(port, 'GET', '/health')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    });
  });

  describe('init()', () => {
    it('creates the default data files and upload folders', () => {
      expect(fs.readdirSync(d.logsDir).sort()).toEqual([
        'alert-config.json', 'announcements.json', 'builtinCommands.json', 'commands.json', 'customCommands.json',
        'eventsub-events.json', 'obs-config.json', 'redemptions.json', 'stats.json'
      ]);
      expect(fs.readdirSync(d.uploadsDir).sort()).toEqual(['images', 'sounds', 'videos']);
    });
  });

  it('song-queue writes from localhost are allowed when no secret is configured', async () => {
    expect((await d.post('/api/song-queue/clear')).status).toBe(200);
  });
});

describe('dashboard init() with existing data', () => {
  let d: Dash;
  beforeEach(() => silenceConsole());
  afterEach(async () => {
    await d.close();
  });

  it('keeps existing files and migrates every missing default built-in command', async () => {
    d = await startDashboard({ seed: {
      'builtinCommands.json': [
        { name: '!clip', cooldownSeconds: 1, description: 'mine', permission: 'Everyone' },
        { name: '!hype', cooldownSeconds: 99, description: 'tuned', permission: 'Everyone' }
      ],
      'commands.json': [{ user: 'kept' }]
    } });
    expect(d.readJson('commands.json')).toEqual([{ user: 'kept' }]);
    const commands = d.readJson('builtinCommands.json');
    const defaults = DEFAULT_BUILTIN_COMMANDS.filter(c => c.name !== '!clip' && c.name !== '!hype');
    expect(commands).toEqual([
      { name: '!clip', cooldownSeconds: 1, description: 'mine', permission: 'Everyone' },
      { name: '!hype', cooldownSeconds: 99, description: 'tuned', permission: 'Everyone' },
      ...defaults
    ]);
    // e.g. commands the old 18-entry migration list missed
    expect(commands.map((c: { name: string }) => c.name)).toEqual(expect.arrayContaining(['!followage', '!8ball', '!shoutout', '!so', '!filters']));
  });

  it('a fresh install gets exactly the default built-in commands', async () => {
    d = await startDashboard();
    expect(d.readJson('builtinCommands.json')).toEqual(DEFAULT_BUILTIN_COMMANDS);
  });

  it('an up-to-date builtinCommands.json is not rewritten', async () => {
    d = await startDashboard({ seed: { 'builtinCommands.json': DEFAULT_BUILTIN_COMMANDS } });
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Migrated built-in commands'));
  });

  it('leaves a corrupt builtinCommands.json untouched', async () => {
    d = await startDashboard();
    fs.writeFileSync(d.paths.builtinCommandsFile, '{corrupt');
    // a second dashboard on the same dirs runs init() again
    let mod!: DashboardModule;
    jest.isolateModules(() => { mod = require('../../../src/dashboard/server'); });
    // (only init() matters here)
    const second = mod.createDashboard({ logsDir: d.logsDir, uploadsDir: d.uploadsDir, envPath: d.envPath, initTts: false });
    await second.init();
    await second.close();
    expect(fs.readFileSync(d.paths.builtinCommandsFile, 'utf8')).toBe('{corrupt');
    expect(console.warn).toHaveBeenCalledWith('Could not migrate built-in commands:', expect.any(String));
  });
});

describe('routers are created per createDashboard() call', () => {
  beforeEach(() => silenceConsole());

  it('a second dashboard in the same module registry serves every route from its own files', async () => {
    // Fixed in the TypeScript port: routes/api, filters, alerts, obs and uploads used to create their
    // express.Router() at module load, so every createDashboard() added handlers to the same router
    // and the first dashboard's handlers (and paths) won. Every route module is now a router factory.
    const roots = [fs.mkdtempSync(path.join(os.tmpdir(), 'dash-e2e-')), fs.mkdtempSync(path.join(os.tmpdir(), 'dash-e2e-'))];
    const dashes: Array<ReturnType<DashboardModule['createDashboard']>> = [];
    jest.isolateModules(() => {
      const mod: DashboardModule = require('../../../src/dashboard/server');
      for (const root of roots) {
        dashes.push(mod.createDashboard({ logsDir: path.join(root, 'logs'), uploadsDir: path.join(root, 'uploads'), envPath: path.join(root, '.env'), initTts: false }));
      }
    });
    try {
      const ports: number[] = [];
      for (const dash of dashes) {
        await dash.init();
        await new Promise<void>(r => dash.server.listen(0, '127.0.0.1', () => r()));
        ports.push((dash.server.address() as AddressInfo).port);
      }
      const read = (i: number, file: string) => JSON.parse(fs.readFileSync(path.join(roots[i], 'logs', file), 'utf8'));

      await httpRequest(ports[1], 'POST', '/api/logs', { body: { user: 'second', command: '!x' } });
      expect(read(0, 'commands.json')).toEqual([]);
      expect(read(1, 'commands.json')).toEqual([expect.objectContaining({ user: 'second' })]);

      // filters: .env of the second dashboard
      expect((await httpRequest(ports[1], 'POST', '/api/filters', { body: { filterSpam: false } })).status).toBe(200);
      expect(fs.existsSync(path.join(roots[0], '.env'))).toBe(false);
      expect(fs.readFileSync(path.join(roots[1], '.env'), 'utf8')).toBe('CHAT_FILTER_SPAM=false\n');

      // alerts
      await httpRequest(ports[1], 'POST', '/api/alerts/config', { body: { second: true } });
      expect(read(0, 'alert-config.json').second).toBeUndefined();
      expect(read(1, 'alert-config.json')).toEqual({ second: true });

      // obs
      await httpRequest(ports[1], 'POST', '/obs/config', { body: { overlays: { second: true } } });
      expect(read(0, 'obs-config.json').overlays.second).toBeUndefined();
      expect(read(1, 'obs-config.json')).toEqual({ overlays: { second: true } });

      // uploads: listing reads the second dashboard's folder
      fs.writeFileSync(path.join(roots[1], 'uploads', 'sounds', 'second.mp3'), 'ID3');
      const listed = await httpRequest(ports[1], 'GET', '/api/uploads/sounds');
      expect(listed.json.files.map((f: { filename: string }) => f.filename)).toEqual(['second.mp3']);
      expect((await httpRequest(ports[0], 'GET', '/api/uploads/sounds')).json.files).toEqual([]);

      await httpRequest(ports[1], 'POST', '/api/quotes', { body: { text: 'second quote', addedBy: 'x' } });
      expect(fs.existsSync(path.join(roots[0], 'logs', 'quotes.json'))).toBe(false);
      expect(read(1, 'quotes.json').quotes).toHaveLength(1);
    } finally {
      for (const dash of dashes) await dash.close();
      for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('x-bot-secret guard on bot-only writes (DASHBOARD_INTERNAL_SECRET)', () => {
  let d: Dash;
  const call = (method: string, url: string, headers: Record<string, string> = {}, body?: unknown) =>
    d.request(method, url, { headers, body });
  const BOT = { 'x-bot-secret': 's3cret' };

  // Every write the bot makes that no browser page makes (see src/bot/*.ts)
  const BOT_ONLY: Array<[string, string, unknown]> = [
    ['POST', '/api/redemptions', { user: 'u', reward: 'r' }],
    ['POST', '/api/eventsub-events', { type: 'follow' }],
    ['POST', '/api/update-state', { isConnected: true }],
    ['POST', '/api/hype/trigger', { channel: '#c', count: 1 }],
    ['POST', '/api/loyalty/award-message', { username: 'u' }],
    ['POST', '/api/loyalty/gamba', { username: 'u', amount: 1 }],
    ['POST', '/api/loyalty/duel', { challenger: 'u', opponent: 'v' }],
    ['POST', '/api/loyalty/add', { username: 'u', amount: 5 }],
    ['PUT', '/api/loyalty/config', { pointsPerMessage: 1 }],
    ['PUT', '/api/song-queue/config', { cost: 5 }],
    ['POST', '/api/song-queue/add', { videoId: 'v', title: 't', requester: 'u' }],
    ['POST', '/api/song-queue/block', { type: 'keyword', value: 'k' }],
    ['DELETE', '/api/song-queue/block/k', undefined],
    ['DELETE', '/api/song-queue/1', undefined],
    ['POST', '/api/song-queue/clear', undefined]
  ];

  beforeEach(() => silenceConsole());
  afterEach(async () => {
    await d.close();
  });

  describe('with a secret configured', () => {
    beforeEach(async () => {
      d = await startDashboard({ env: { DASHBOARD_INTERNAL_SECRET: 's3cret' } });
    });

    it.each(BOT_ONLY)('%s %s needs the matching x-bot-secret, even from localhost', async (method, url, body) => {
      for (const headers of [{}, { 'x-bot-secret': 'wrong' }] as Array<Record<string, string>>) {
        const res = await call(method, url, headers, body);
        expect(res.status).toBe(403);
        expect(res.json).toEqual({ error: 'Forbidden' });
      }
      const ok = await call(method, url, BOT, body);
      expect(ok.status).not.toBe(403);
      expect(ok.status).toBeLessThan(500);
    });

    it('a forbidden loyalty write changes nothing', async () => {
      await call('POST', '/api/loyalty/add', {}, { username: 'x', amount: 1000 });
      expect(d.exists('loyalty.json')).toBe(false);
    });

    it('reads stay open', async () => {
      for (const url of ['/api/song-queue', '/api/song-queue/config', '/api/loyalty', '/api/loyalty/leaderboard', '/api/redemptions']) {
        expect((await call('GET', url)).status).toBe(200);
      }
    });

    it('writes the browser pages also make need no secret (the CSRF check covers them)', async () => {
      expect((await call('POST', '/api/chat', {}, { message: 'hi' })).status).toBe(200);
      expect((await call('POST', '/api/test-alert', {}, {})).status).toBe(200);
      expect((await call('POST', '/api/logs', {}, { user: 'u', command: '!x' })).status).toBe(200);
      expect((await call('POST', '/api/counters/deaths/increment')).status).toBe(200);
      // The song player overlay advances the queue itself
      expect((await call('POST', '/api/song-queue/skip')).status).toBe(200);
      expect((await call('POST', '/api/song-queue/SKIP/')).status).toBe(200);
    });

    describe('admin actions from a dashboard page (same-origin Origin header, no secret)', () => {
      const page = () => ({ origin: `http://127.0.0.1:${d.port}` });
      const seedQueue = () => d.writeJson('song-queue.json', {
        active: [
          { id: 's1', videoId: 'v1', title: 'First', channelTitle: 'c', channelId: 'ch1', thumbnail: '', requester: 'u', requesterDisplayName: 'U', addedAt: '', position: 1, pointsCost: 0 },
          { id: 's2', videoId: 'v2', title: 'Second', channelTitle: 'c', channelId: 'ch1', thumbnail: '', requester: 'u', requesterDisplayName: 'U', addedAt: '', position: 2, pointsCost: 0 }
        ],
        history: [],
        config: { enabled: true, maxDuration: 600, maxPerUser: 3, allowDuplicates: false, cost: 0, priority: 'everyone' }
      });

      // The Song Queue and Loyalty pages make these
      const DASHBOARD_ADMIN: Array<[string, string, unknown]> = [
        ['PUT', '/api/loyalty/config', { pointsPerMessage: 1 }],
        ['PUT', '/api/loyalty/user/viewer/points', { points: 50 }],
        ['PUT', '/api/song-queue/config', { cost: 5 }],
        ['POST', '/api/song-queue/block', { type: 'keyword', value: 'k' }],
        ['DELETE', '/api/song-queue/block/k', undefined],
        ['DELETE', '/api/song-queue/2', undefined],
        ['POST', '/api/song-queue/clear', undefined]
      ];

      it.each(DASHBOARD_ADMIN)('%s %s is allowed', async (method, url, body) => {
        seedQueue();
        if (url === '/api/song-queue/block/k') await call('POST', '/api/song-queue/block', BOT, { type: 'keyword', value: 'k' });
        const res = await call(method, url, page(), body);
        expect([method, url, res.status]).toEqual([method, url, 200]);
      });

      it('the edits really land', async () => {
        seedQueue();
        await call('PUT', '/api/loyalty/user/viewer/points', page(), { points: 50 });
        expect(d.readJson('loyalty.json').users.viewer.points).toBe(50);
        await call('DELETE', '/api/song-queue/2', page());
        expect(d.readJson('song-queue.json').active.map((s: { id: string }) => s.id)).toEqual(['s1']);
      });

      // Points-earning and charging writes stay bot-only even from a page
      it.each([
        ['POST', '/api/loyalty/award-message', { username: 'u' }],
        ['POST', '/api/loyalty/gamba', { username: 'u', amount: 1 }],
        ['POST', '/api/loyalty/duel', { challenger: 'u', opponent: 'v' }],
        ['POST', '/api/loyalty/add', { username: 'u', amount: 5 }],
        ['POST', '/api/loyalty/deduct', { username: 'u', amount: 5 }],
        ['POST', '/api/song-queue/add', { videoId: 'v', title: 't', requester: 'u' }],
        ['POST', '/api/song-queue/ADD/', { videoId: 'v', title: 't', requester: 'u' }],
        ['PUT', '/api/loyalty/user/a/b/points', { points: 1 }]
      ])('%s %s still needs the secret', async (method, url, body) => {
        const res = await call(method, url, page(), body);
        expect(res.status).toBe(403);
      });

      it('an empty Origin header is not a page', async () => {
        expect((await call('POST', '/api/song-queue/clear', { origin: '' })).status).toBe(403);
      });

      it('another site is refused by the CSRF check before anything else', async () => {
        const res = await call('PUT', '/api/loyalty/config', { origin: 'http://evil.example' }, { pointsPerMessage: 1 });
        expect(res.status).toBe(403);
        expect(res.json).toEqual({ error: 'Forbidden: cross-site request' });
        expect(d.exists('loyalty.json')).toBe(false);
      });
    });

    it('a case or trailing-slash variant of a bot-only path is still guarded', async () => {
      expect((await call('POST', '/API/LOYALTY/add', {}, { username: 'x', amount: 5 })).status).toBe(403);
      expect((await call('POST', '/api/hype/trigger/', {}, { channel: '#c', count: 1 })).status).toBe(403);
      expect((await call('POST', '/api/Song-Queue/clear')).status).toBe(403);
    });
  });

  it('without a secret, bot-only writes are allowed', async () => {
    d = await startDashboard();
    expect((await call('POST', '/api/song-queue/clear')).status).toBe(200);
    expect((await call('POST', '/api/loyalty/add', {}, { username: 'x', amount: 5 })).status).toBe(200);
  });

  it('the secret is read when the dashboard is created, not per request', async () => {
    d = await startDashboard();
    process.env.DASHBOARD_INTERNAL_SECRET = 'late';
    expect((await call('POST', '/api/song-queue/clear')).status).toBe(200);
  });
});

const EXTERNAL_IP = externalIPv4();
(EXTERNAL_IP ? describe : describe.skip)('x-bot-secret guard for non-localhost callers', () => {
  let d: Dash;
  const ext = (method: string, url: string, headers: Record<string, string> = {}, body?: unknown) =>
    httpRequest(d.port, method, url, { host: EXTERNAL_IP as string, headers, body });

  beforeEach(async () => {
    silenceConsole();
    d = await startDashboard({ env: { DASHBOARD_INTERNAL_SECRET: 's3cret' }, listenHost: '0.0.0.0' });
  });
  afterEach(async () => {
    await d.close();
  });

  it('needs the secret exactly as from localhost', async () => {
    expect((await ext('POST', '/api/song-queue/clear')).status).toBe(403);
    expect((await ext('POST', '/api/loyalty/add', {}, { username: 'x', amount: 1000 })).status).toBe(403);
    expect((await ext('POST', '/api/song-queue/clear', { 'x-bot-secret': 's3cret' })).status).toBe(200);
  });
});

describe('cross-site request guard (CSRF)', () => {
  let d: Dash;
  beforeEach(async () => {
    silenceConsole();
    d = await startDashboard();
  });
  afterEach(async () => {
    await d.close();
  });

  const fromOrigin = (method: string, url: string, origin: string, body?: unknown) =>
    d.request(method, url, { headers: { origin }, body });

  it.each([
    ['POST', '/api/loyalty/add', { username: 'x', amount: 1000 }],
    ['POST', '/api/filters/words', { word: 'evil' }],
    ['POST', '/api/settings', { commandRefreshInterval: 30 }],
    ['DELETE', '/api/logs', undefined],
    ['PUT', '/api/builtin-commands/!clip', { cooldownSeconds: 1 }],
    ['POST', '/obs/config', { overlays: {} }],
    ['DELETE', '/api/backup/x.json', undefined],
    ['PATCH', '/api/logs', undefined]
  ])('rejects a cross-site %s %s with 403 and changes nothing', async (method, url, body) => {
    const before = fs.readFileSync(d.paths.commandLogsFile, 'utf8');
    const res = await fromOrigin(method, url, 'https://evil.example', body);
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ error: 'Forbidden: cross-site request' });
    expect(d.exists('loyalty.json')).toBe(false);
    expect(fs.readFileSync(d.paths.commandLogsFile, 'utf8')).toBe(before);
    expect(fs.existsSync(d.envPath)).toBe(false);
  });

  it('rejects the opaque "null" origin and a different port on the same host', async () => {
    expect((await fromOrigin('POST', '/api/chat', 'null', { message: 'x' })).status).toBe(403);
    expect((await fromOrigin('POST', '/api/chat', 'http://127.0.0.1:1', { message: 'x' })).status).toBe(403);
  });

  it('allows same-origin writes (the dashboard pages and overlays) and requests without Origin (bot, CLI)', async () => {
    expect((await fromOrigin('POST', '/api/chat', `http://127.0.0.1:${d.port}`, { message: 'x' })).status).toBe(200);
    expect((await d.post('/api/chat', { message: 'x' })).status).toBe(200);
  });

  it('allows cross-site reads', async () => {
    expect((await fromOrigin('GET', '/api/status', 'https://evil.example')).status).toBe(200);
  });
});
