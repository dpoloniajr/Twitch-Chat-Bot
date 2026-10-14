/** @jest-environment jsdom */
/**
 * Tests for dashboard/public/manage.js (compiled from
 * src/web/dashboard/public/manage.ts) running with app.js in the real
 * dashboard index.html: the schema-driven Settings form and the Song Queue,
 * Loyalty, Quotes, Counters and Backups pages. fetch is mocked per route.
 */
import { loadPage, flush, click, change, PageHarness, MockResponseInit, REPO_ROOT } from '../support/static-page-harness';

const EVIL = '<img src=x onerror="window.pwned=1">';

const CONFIG = {
  groups: [
    { id: 'general', title: 'General', description: 'General things' },
    { id: 'tts', title: 'Text-to-Speech' },
    { id: 'twitch', title: 'Twitch Account' },
    { id: 'empty', title: 'Nothing here' }
  ],
  settings: [
    { key: 'COMMAND_REFRESH_INTERVAL', group: 'general', label: 'Command refresh interval', type: 'integer', default: 60, min: 5, max: 3600, unit: 'seconds', readOnly: false, applies: 'bot', value: 30, isSet: true, fromEnvironment: false },
    { key: 'ANNOUNCEMENT_INTERVAL_MS', group: 'general', label: 'Announcement interval', type: 'integer', default: 900000, min: 60000, max: 86400000, scale: 60000, unit: 'minutes', readOnly: false, applies: 'bot', value: null, isSet: false, fromEnvironment: false },
    { key: 'HYPE_ENABLED', group: 'general', label: 'Hype detector', type: 'boolean', default: true, readOnly: false, applies: 'bot', value: true, isSet: false, fromEnvironment: false },
    { key: 'TWITCH_CHANNELS', group: 'general', label: 'Channels', type: 'list', separator: ',', readOnly: false, applies: 'bot', value: ['a', 'b'], isSet: true, fromEnvironment: false },
    { key: 'HYPE_MESSAGE', group: 'general', label: EVIL, description: EVIL, type: 'string', default: 'Hype!', readOnly: false, applies: 'bot', value: EVIL, isSet: true, fromEnvironment: false },
    { key: 'TTS_PROVIDER', group: 'tts', label: 'Provider', type: 'enum', default: 'browser', options: ['browser', 'elevenlabs', 'openai'], readOnly: false, applies: 'live', value: 'openai', isSet: true, fromEnvironment: false },
    { key: 'OPENAI_API_KEY', group: 'tts', label: 'OpenAI API key', type: 'secret', readOnly: false, applies: 'live', value: null, isSet: true, fromEnvironment: false },
    { key: 'ELEVENLABS_API_KEY', group: 'tts', label: 'ElevenLabs API key', type: 'secret', readOnly: false, applies: 'live', value: null, isSet: false, fromEnvironment: false },
    { key: 'TWITCH_CLIENT_ID', group: 'twitch', label: 'Client ID', type: 'string', readOnly: false, applies: 'bot', value: 'fromdocker', isSet: true, fromEnvironment: true },
    { key: 'TWITCH_ACCESS_TOKEN', group: 'twitch', label: 'Bot access token', type: 'secret', readOnly: true, readOnlyReason: 'Created by the token generator.', applies: 'bot', value: null, isSet: true, fromEnvironment: false },
    { key: 'TWITCH_SCOPES', group: 'twitch', label: 'Scopes', type: 'list', separator: ' ', readOnly: true, applies: 'bot', value: ['chat:read', 'chat:edit'], isSet: true, fromEnvironment: false }
  ]
};

const SONGS = {
  active: [
    { id: 's1', videoId: 'v1', title: `Now ${EVIL}`, channelTitle: 'Chan', requester: 'alice', requesterDisplayName: 'Alice', durationFormatted: '3:00', position: 1, pointsCost: 0 },
    { id: 's2', videoId: 'v2', title: 'Next song', channelTitle: 'Chan', requester: 'bob', durationFormatted: '4:00', position: 2, pointsCost: 50 }
  ],
  config: { enabled: true, cost: 50, maxDuration: 600, maxPerUser: 3, allowDuplicates: false, priority: 'subs' }
};

const BLOCKLIST = { videos: ['badvid'], channels: [], keywords: [EVIL] };

function routes(extra: Record<string, MockResponseInit> = {}): Record<string, MockResponseInit> {
  return {
    'GET /api/config': { body: CONFIG },
    'GET /api/song-queue': { body: SONGS },
    'GET /api/song-queue/blocklist': { body: BLOCKLIST },
    'GET /api/loyalty/config': { body: { enabled: true, currencyName: 'coin', currencyNamePlural: 'coins', pointsPerMinute: 10, pointsPerMessage: 5, maxPointsPerMessage: 50, messageCooldownSeconds: 30, subscriberMultiplier: 2, vipMultiplier: 1.5, pointsPerLevel: 1000 } },
    'GET /api/loyalty/stats': { body: { totalUsers: 2, totalPointsInCirculation: 1500, totalPointsEarned: 2000, totalPointsSpent: 500, averagePoints: 750, topLevel: 2 } },
    'GET /api/loyalty/leaderboard?limit=50': { body: [{ username: EVIL, points: 1000, level: 2, watchTimeMinutes: 60, rank: 1 }, { username: 'bob', points: 500, rank: 2 }] },
    'GET /api/loyalty/transactions?limit=25': { body: [{ timestamp: '2026-01-01T00:00:00Z', username: 'bob', type: 'earn', amount: 5, reason: 'chat' }] },
    'GET /api/quotes/config': { body: { minLength: 5, maxLength: 500, maxQuotes: 10000, allowDuplicates: false } },
    'GET /api/quotes?*': { body: { quotes: [{ id: 1, text: EVIL, addedBy: 'mod', game: 'Chess' }, { id: 2, text: 'Second' }], totalQuotes: 25, totalPages: 2, currentPage: 1 } },
    'GET /api/counters': { body: [{ name: 'wins', value: 3, description: 'Win counter' }, { name: 'deaths', value: 7, description: EVIL }] },
    'GET /api/backup/list': { body: [{ filename: 'backup-1.json', createdAt: '2026-01-02T00:00:00Z', size: 2048, includes: ['quotes', 'loyalty'] }] },
    ...extra
  };
}

async function boot(extra: Record<string, MockResponseInit> = {}, confirmResult = true): Promise<PageHarness> {
  const h = loadPage({
    html: 'dashboard/public/index.html',
    script: 'dashboard/public/app.js',
    extraScripts: ['dashboard/public/manage.js'],
    routes: routes(extra),
    confirmResult
  });
  await flush();
  return h;
}

async function open(h: PageHarness, page: string): Promise<void> {
  click(h.document.querySelector(`a[href="#${page}"]`)!);
  await flush();
}

const row = (h: PageHarness, key: string) => h.document.querySelector(`[data-setting="${key}"]`) as HTMLElement;
const input = (h: PageHarness, key: string) => h.$(`setting-${key}`) as HTMLInputElement;
const typeInto = (h: PageHarness, el: HTMLInputElement, value: string) => {
  el.value = value;
  el.dispatchEvent(new h.window.Event('input', { bubbles: true }));
};
const buttonIn = (el: Element, label: string) =>
  [...el.querySelectorAll('button')].find(b => b.textContent === label) as HTMLButtonElement;

describe('manage.js: page hooks', () => {
  it('index.html has no duplicate element ids (the pages look elements up by id)', () => {
    const html = require('fs').readFileSync(require('path').join(REPO_ROOT, 'dashboard/public/index.html'), 'utf8') as string;
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  it('loads each page\'s data when it is first shown', async () => {
    const h = await boot();
    expect(h.callsTo('/api/config')).toHaveLength(0);
    await open(h, 'settings');
    expect(h.callsTo('/api/config')).toHaveLength(1);
    await open(h, 'songs');
    expect(h.callsTo('/api/song-queue/blocklist')).toHaveLength(1);
    await open(h, 'loyalty');
    expect(h.callsTo('/api/loyalty/stats')).toHaveLength(1);
    await open(h, 'quotes');
    expect(h.callsTo('/api/quotes/config')).toHaveLength(1);
    await open(h, 'counters');
    expect(h.callsTo('/api/counters')).toHaveLength(1);
    await open(h, 'backups');
    expect(h.callsTo('/api/backup/list')).toHaveLength(1);
    expect(h.scriptErrors).toEqual([]);
  });

  it('socket updates refresh only pages that were opened', async () => {
    const h = await boot();
    h.sockets[0].emit({ type: 'song-queue-update', data: {} });
    h.sockets[0].emit({ type: 'loyalty-update', data: [] });
    h.sockets[0].emit({ type: 'quote-update', data: {} });
    h.sockets[0].emit({ type: 'counter-update', data: [] });
    await flush();
    expect(h.callsTo('/api/song-queue')).toHaveLength(0);
    expect(h.callsTo('/api/loyalty')).toHaveLength(0);
    expect(h.callsTo('/api/quotes')).toHaveLength(0);

    await open(h, 'songs');
    await open(h, 'loyalty');
    await open(h, 'quotes');
    await open(h, 'counters');
    const before = h.fetchCalls.length;
    h.sockets[0].emit({ type: 'song-queue-update', data: {} });
    h.sockets[0].emit({ type: 'loyalty-update', data: [] });
    h.sockets[0].emit({ type: 'quote-update', data: {} });
    await flush();
    const urls = h.fetchCalls.slice(before).map(c => c.url);
    expect(urls).toEqual(expect.arrayContaining(['/api/song-queue', '/api/loyalty/stats', '/api/quotes/config']));

    // counter-update carries the list itself: rendered without a fetch
    const beforeCounters = h.fetchCalls.length;
    h.sockets[0].emit({ type: 'counter-update', data: [{ name: 'live', value: 42 }] });
    await flush();
    expect(h.fetchCalls.length).toBe(beforeCounters);
    expect(h.$('countersList').textContent).toContain('live');
    expect(h.$('countersList').textContent).not.toContain('wins');
    // a malformed counter-update is ignored
    h.sockets[0].emit({ type: 'counter-update', data: 'oops' });
    await flush();
    expect(h.$('countersList').textContent).toContain('live');
  });
});

describe('manage.js: Settings', () => {
  it('builds one panel per non-empty group, with badges, units and descriptions', async () => {
    const h = await boot();
    await open(h, 'settings');
    const sections = [...h.$('settingsForm').querySelectorAll('section')].map(s => (s as HTMLElement).dataset.group);
    expect(sections).toEqual(['general', 'tts', 'twitch']);
    expect(row(h, 'COMMAND_REFRESH_INTERVAL').textContent).toContain('(seconds)');
    expect(row(h, 'COMMAND_REFRESH_INTERVAL').textContent).toContain('Restart bot to apply');
    expect(row(h, 'TTS_PROVIDER').textContent).toContain('Applies immediately');
    expect(input(h, 'COMMAND_REFRESH_INTERVAL').value).toBe('30');
    expect(input(h, 'COMMAND_REFRESH_INTERVAL').type).toBe('number');
    expect(input(h, 'HYPE_ENABLED').checked).toBe(true);
    expect(input(h, 'TWITCH_CHANNELS').value).toBe('a, b');
    expect((h.$('setting-TTS_PROVIDER') as unknown as HTMLSelectElement).value).toBe('openai');
    expect(h.$('settingsSaveBtn').disabled).toBe(true);
  });

  it('shows scaled values and defaults (ms shown as minutes)', async () => {
    const h = await boot();
    await open(h, 'settings');
    const el = input(h, 'ANNOUNCEMENT_INTERVAL_MS');
    expect(el.value).toBe('');
    expect(el.placeholder).toBe('Default: 15');
    expect(el.min).toBe('1');
    expect(el.max).toBe('1440');
  });

  it('never shows a secret: a password field with a set/not-set placeholder', async () => {
    const h = await boot();
    await open(h, 'settings');
    const key = input(h, 'OPENAI_API_KEY');
    expect(key.type).toBe('password');
    expect(key.value).toBe('');
    expect(key.placeholder).toContain('set; type to replace');
    expect(input(h, 'ELEVENLABS_API_KEY').placeholder).toBe('Not set');
    // read-only secrets show only a badge, no input at all
    expect(h.document.getElementById('setting-TWITCH_ACCESS_TOKEN')).toBeNull();
    expect(row(h, 'TWITCH_ACCESS_TOKEN').textContent).toContain('Set');
    expect(row(h, 'TWITCH_ACCESS_TOKEN').textContent).toContain('Created by the token generator.');
  });

  it('locks read-only and environment-owned settings and explains why', async () => {
    const h = await boot();
    await open(h, 'settings');
    expect(input(h, 'TWITCH_SCOPES').disabled).toBe(true);
    expect(input(h, 'TWITCH_SCOPES').value).toBe('chat:read chat:edit');
    expect(input(h, 'TWITCH_CLIENT_ID').disabled).toBe(true);
    expect(row(h, 'TWITCH_CLIENT_ID').textContent).toContain('Set by the system environment');
    expect(buttonIn(row(h, 'TWITCH_CLIENT_ID'), 'Use default')).toBeUndefined();
  });

  it('renders labels, descriptions and values as text (XSS)', async () => {
    const h = await boot();
    await open(h, 'settings');
    expect(h.$('settingsForm').querySelector('img')).toBeNull();
    expect(input(h, 'HYPE_MESSAGE').value).toBe(EVIL);
    expect(row(h, 'HYPE_MESSAGE').textContent).toContain(EVIL);
    expect((h.window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });

  it('sends only the edited settings, converted to stored units', async () => {
    const h = await boot({ 'PUT /api/config': { body: { success: true, changed: ['ANNOUNCEMENT_INTERVAL_MS'], restart: ['bot'], ...CONFIG } } });
    await open(h, 'settings');
    typeInto(h, input(h, 'ANNOUNCEMENT_INTERVAL_MS'), '2.5');
    change(input(h, 'HYPE_ENABLED'), false);
    typeInto(h, input(h, 'TWITCH_CHANNELS'), 'a, c');
    typeInto(h, input(h, 'OPENAI_API_KEY'), 'sk-new');
    const select = h.$('setting-TTS_PROVIDER') as unknown as HTMLSelectElement;
    select.value = '';
    select.dispatchEvent(new h.window.Event('change'));
    expect(h.$('settingsSaveBtn').disabled).toBe(false);
    expect(h.$('settingsSaveBtn').textContent).toBe('Save Changes (5)');
    expect(row(h, 'HYPE_ENABLED').classList.contains('mgr-dirty')).toBe(true);

    h.window.eval('mgrSaveSettings()');
    await flush();
    expect(h.callsTo('/api/config', 'PUT')[0].body).toEqual({ values: {
      ANNOUNCEMENT_INTERVAL_MS: 150000,
      HYPE_ENABLED: false,
      TWITCH_CHANNELS: 'a, c',
      OPENAI_API_KEY: 'sk-new',
      TTS_PROVIDER: null
    } });
    expect(h.$('settingsStatus').textContent).toBe('Saved 1 setting.');
    expect(h.$('settingsRestartNotice').hidden).toBe(false);
    expect(h.$('settingsRestartText').textContent).toBe('Saved. Restart the bot to apply.');
    expect(h.$('settingsSaveBtn').disabled).toBe(true);
  });

  it('emptying a field sends null (use the default); clearing a typed secret drops the edit', async () => {
    const h = await boot({ 'PUT /api/config': { body: { success: true, changed: [], restart: [], ...CONFIG } } });
    await open(h, 'settings');
    typeInto(h, input(h, 'COMMAND_REFRESH_INTERVAL'), '');
    typeInto(h, input(h, 'ELEVENLABS_API_KEY'), 'x');
    typeInto(h, input(h, 'ELEVENLABS_API_KEY'), '');
    h.window.eval('mgrSaveSettings()');
    await flush();
    expect(h.callsTo('/api/config', 'PUT')[0].body).toEqual({ values: { COMMAND_REFRESH_INTERVAL: null } });
  });

  it('"Use default" and "Clear" queue a removal', async () => {
    const h = await boot({ 'PUT /api/config': { body: { success: true, changed: [], restart: [], ...CONFIG } } });
    await open(h, 'settings');
    click(buttonIn(row(h, 'COMMAND_REFRESH_INTERVAL'), 'Use default'));
    expect(input(h, 'COMMAND_REFRESH_INTERVAL').value).toBe('');
    click(buttonIn(row(h, 'OPENAI_API_KEY'), 'Clear'));
    expect(buttonIn(row(h, 'ELEVENLABS_API_KEY'), 'Clear')).toBeUndefined(); // not set: nothing to clear
    h.window.eval('mgrSaveSettings()');
    await flush();
    expect(h.callsTo('/api/config', 'PUT')[0].body).toEqual({ values: { COMMAND_REFRESH_INTERVAL: null, OPENAI_API_KEY: null } });
  });

  it('refuses to save a number field holding text the browser cannot read', async () => {
    const h = await boot();
    await open(h, 'settings');
    const el = input(h, 'COMMAND_REFRESH_INTERVAL');
    Object.defineProperty(el, 'validity', { configurable: true, get: () => ({ badInput: true }) });
    typeInto(h, el, '');
    h.window.eval('mgrSaveSettings()');
    await flush();
    expect(h.callsTo('/api/config', 'PUT')).toHaveLength(0);
    expect(h.$('settingsStatus').textContent).toBe('Not saved: enter a number for Command refresh interval.');
    // fixing the field allows the save
    Object.defineProperty(el, 'validity', { configurable: true, get: () => ({ badInput: false }) });
    typeInto(h, el, '20');
    h.window.eval('mgrSaveSettings()');
    await flush();
    expect(h.callsTo('/api/config', 'PUT')[0].body).toEqual({ values: { COMMAND_REFRESH_INTERVAL: 20 } });
  });

  it('shows the server\'s validation error and keeps the edit', async () => {
    const h = await boot({ 'PUT /api/config': { status: 400, body: { success: false, error: 'Command refresh interval (COMMAND_REFRESH_INTERVAL) must be at least 5' } } });
    await open(h, 'settings');
    typeInto(h, input(h, 'COMMAND_REFRESH_INTERVAL'), '1');
    h.window.eval('mgrSaveSettings()');
    await flush();
    expect(h.callsTo('/api/config', 'PUT')[0].body).toEqual({ values: { COMMAND_REFRESH_INTERVAL: 1 } });
    expect(h.$('settingsStatus').textContent).toBe('Not saved: Command refresh interval (COMMAND_REFRESH_INTERVAL) must be at least 5');
    expect(h.$('settingsStatus').className).toContain('mgr-status-error');
    expect(h.$('settingsSaveBtn').disabled).toBe(false);
  });

  it('reloads the form when a save answer carries no settings', async () => {
    const h = await boot({ 'PUT /api/config': { body: { success: true } } });
    await open(h, 'settings');
    change(input(h, 'HYPE_ENABLED'), false);
    h.window.eval('mgrSaveSettings()');
    await flush();
    expect(h.callsTo('/api/config', 'GET')).toHaveLength(2);
    expect(h.$('settingsStatus').textContent).toBe('Nothing changed.');
    expect(h.scriptErrors).toEqual([]);
  });

  it('does nothing when there is nothing to save', async () => {
    const h = await boot();
    await open(h, 'settings');
    h.window.eval('mgrSaveSettings()');
    await flush();
    expect(h.callsTo('/api/config', 'PUT')).toHaveLength(0);
  });

  it('mentions every process that must restart', async () => {
    const h = await boot({ 'PUT /api/config': { body: { success: true, changed: ['A', 'B'], restart: ['bot', 'dashboard'], ...CONFIG } } });
    await open(h, 'settings');
    change(input(h, 'HYPE_ENABLED'), false);
    h.window.eval('mgrSaveSettings()');
    await flush();
    expect(h.$('settingsStatus').textContent).toBe('Saved 2 settings.');
    expect(h.$('settingsRestartText').textContent).toContain('Restart the bot and the dashboard to apply.');
    expect(h.$('settingsRestartText').textContent).toContain('stop and start npm start');
  });

  it('no restart notice for live-only changes', async () => {
    const h = await boot({ 'PUT /api/config': { body: { success: true, changed: ['TTS_PROVIDER'], restart: [], ...CONFIG } } });
    await open(h, 'settings');
    change(input(h, 'HYPE_ENABLED'), false);
    h.window.eval('mgrSaveSettings()');
    await flush();
    expect(h.$('settingsRestartNotice').hidden).toBe(true);
  });

  it('reports a load failure and a network error', async () => {
    let h = await boot({ 'GET /api/config': { status: 500, body: { error: 'boom' } } });
    await open(h, 'settings');
    expect(h.$('settingsStatus').textContent).toBe('Could not load settings: boom');
    h = await boot({ 'GET /api/config': { networkError: new Error('offline') } });
    await open(h, 'settings');
    expect(h.$('settingsStatus').textContent).toBe('Could not load settings: Could not reach the dashboard');
    h = await boot({ 'GET /api/config': { status: 502, jsonError: new Error('not json') } });
    await open(h, 'settings');
    expect(h.$('settingsStatus').textContent).toBe('Could not load settings: Request failed (502)');
  });

  it('"Discard Changes" reloads from the server', async () => {
    const h = await boot();
    await open(h, 'settings');
    typeInto(h, input(h, 'COMMAND_REFRESH_INTERVAL'), '99');
    h.window.eval('mgrLoadSettings()');
    await flush();
    expect(input(h, 'COMMAND_REFRESH_INTERVAL').value).toBe('30');
    expect(h.$('settingsSaveBtn').disabled).toBe(true);
  });
});

describe('manage.js: Song Queue', () => {
  it('shows the current song, the queue, the settings and the blocklist as text', async () => {
    const h = await boot();
    await open(h, 'songs');
    expect(h.$('songsNowPlaying').textContent).toContain(`Now ${EVIL}`);
    expect(h.$('songsNowPlaying').textContent).toContain('requested by Alice');
    const rows = h.$('songsQueueList').querySelectorAll('tr');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('1 ▶');
    expect(rows[1].textContent).toContain('bob');
    expect(h.$('songsCost').value).toBe('50');
    expect(h.$('songsMaxDuration').value).toBe('10');
    expect(h.$('songsPriority').value).toBe('subs');
    expect(h.$('songsBlocklist').textContent).toContain('badvid');
    expect(h.$('songsBlocklist').textContent).toContain(EVIL);
    expect(h.document.querySelector('#songs img')).toBeNull();
  });

  it('shows empty states', async () => {
    const h = await boot({ 'GET /api/song-queue': { body: { active: [], config: {} } }, 'GET /api/song-queue/blocklist': { body: {} } });
    await open(h, 'songs');
    expect(h.$('songsNowPlaying').textContent).toBe('Nothing is playing.');
    expect(h.$('songsQueueList').textContent).toBe('The queue is empty.');
    expect(h.$('songsBlocklist').textContent).toBe('Nothing is blocked.');
  });

  it('skips the song that is shown as playing', async () => {
    const h = await boot({ 'POST /api/song-queue/skip': { body: { success: true } } });
    await open(h, 'songs');
    h.window.eval('mgrSkipSong()');
    await flush();
    expect(h.callsTo('/api/song-queue/skip', 'POST')[0].body).toEqual({ songId: 's1' });
    expect(h.$('songsStatus').textContent).toBe('Skipped the current song.');
  });

  it('reports a body-level failure (200 with success:false)', async () => {
    const h = await boot({ 'POST /api/song-queue/skip': { body: { success: false, error: 'Song already skipped.' } } });
    await open(h, 'songs');
    h.window.eval('mgrSkipSong()');
    await flush();
    expect(h.$('songsStatus').textContent).toBe('Song already skipped.');
  });

  it('removes by position after confirming', async () => {
    const h = await boot({ 'DELETE /api/song-queue/2': { body: { success: true } } });
    await open(h, 'songs');
    click(buttonIn(h.$('songsQueueList').querySelectorAll('tr')[1], 'Remove'));
    await flush();
    expect(h.confirmMock).toHaveBeenCalledWith('Remove "Next song" from the queue? The requester gets their points back.');
    expect(h.callsTo('/api/song-queue/2', 'DELETE')).toHaveLength(1);
    expect(h.$('songsStatus').textContent).toBe('Removed "Next song".');
  });

  it('does not remove or clear when the confirm is cancelled', async () => {
    const h = await boot({}, false);
    await open(h, 'songs');
    click(buttonIn(h.$('songsQueueList').querySelectorAll('tr')[1], 'Remove'));
    h.window.eval('mgrClearQueue()');
    await flush();
    expect(h.fetchCalls.filter(c => c.method !== 'GET')).toHaveLength(0);
  });

  it('clears the queue', async () => {
    const h = await boot({ 'POST /api/song-queue/clear': { body: { success: true } } });
    await open(h, 'songs');
    h.window.eval('mgrClearQueue()');
    await flush();
    expect(h.callsTo('/api/song-queue/clear', 'POST')).toHaveLength(1);
  });

  it('saves settings in the API\'s units and validates first', async () => {
    const h = await boot({ 'PUT /api/song-queue/config': { body: { success: true } } });
    await open(h, 'songs');
    h.$('songsMaxDuration').value = '0';
    h.window.eval('mgrSaveSongConfig()');
    await flush();
    expect(h.$('songsStatus').textContent).toBe('Max length must be at least 1 minute.');
    h.$('songsCost').value = '-1';
    h.window.eval('mgrSaveSongConfig()');
    expect(h.$('songsStatus').textContent).toBe('Cost must be 0 or more.');
    h.$('songsCost').value = '25.7';
    h.$('songsMaxDuration').value = '4.5';
    h.$('songsMaxPerUser').value = '';
    h.window.eval('mgrSaveSongConfig()');
    expect(h.$('songsStatus').textContent).toBe('Max songs per viewer must be at least 1.');
    expect(h.callsTo('/api/song-queue/config', 'PUT')).toHaveLength(0);
    h.$('songsMaxPerUser').value = '2';
    h.$('songsEnabled').checked = false;
    h.window.eval('mgrSaveSongConfig()');
    await flush();
    expect(h.callsTo('/api/song-queue/config', 'PUT')[0].body).toEqual({
      enabled: false, allowDuplicates: false, cost: 25, maxDuration: 270, maxPerUser: 2, priority: 'subs'
    });
    expect(h.$('songsStatus').textContent).toBe('Song request settings saved.');
  });

  it('blocks and unblocks (URL-encoded)', async () => {
    const h = await boot({ 'POST /api/song-queue/block': { body: { success: true } }, 'DELETE /api/song-queue/block/*': { body: { success: true } } });
    await open(h, 'songs');
    h.window.eval('mgrBlockSong()');
    expect(h.$('songsStatus').textContent).toBe('Enter what to block.');
    h.$('songsBlockType').value = 'keyword';
    h.$('songsBlockValue').value = '  100% loud  ';
    h.window.eval('mgrBlockSong()');
    await flush();
    expect(h.callsTo('/api/song-queue/block', 'POST')[0].body).toEqual({ type: 'keyword', value: '100% loud' });
    expect(h.$('songsBlockValue').value).toBe('');
    click(h.$('songsBlocklist').querySelector('.mgr-chip-remove')!);
    await flush();
    expect(h.callsTo('/api/song-queue/block/badvid', 'DELETE')).toHaveLength(1);
    click(h.$('songsBlocklist').querySelectorAll('.mgr-chip-remove')[1]);
    await flush();
    expect(h.callsTo(`/api/song-queue/block/${encodeURIComponent(EVIL)}`, 'DELETE')).toHaveLength(1);
  });

  it('reports a failed queue load', async () => {
    const h = await boot({ 'GET /api/song-queue': { status: 403, body: { error: 'Forbidden' } } });
    await open(h, 'songs');
    expect(h.$('songsStatus').textContent).toBe('Could not load the queue: Forbidden');
  });
});

describe('manage.js: Loyalty', () => {
  it('fills settings, stats, leaderboard and transactions (as text)', async () => {
    const h = await boot();
    await open(h, 'loyalty');
    expect(h.$('loyaltyEnabled').checked).toBe(true);
    expect(h.$('loyaltyCurrencyNamePlural').value).toBe('coins');
    expect(h.$('loyaltyVipMultiplier').value).toBe('1.5');
    expect(h.$('loyaltyStats').textContent).toContain('coins held');
    expect(h.$('loyaltyStats').textContent).toContain((1500).toLocaleString());
    expect(h.$('loyaltyLeaderboard').textContent).toContain(EVIL);
    expect(h.$('loyaltyLeaderboard').querySelectorAll('tr')[1].textContent).toContain('0 min');
    expect(h.$('loyaltyTransactions').textContent).toContain('chat');
    expect(h.document.querySelector('#loyalty img')).toBeNull();
  });

  it('"Edit" prefills the set-points form', async () => {
    const h = await boot();
    await open(h, 'loyalty');
    click(buttonIn(h.$('loyaltyLeaderboard').querySelectorAll('tr')[1], 'Edit'));
    expect(h.$('loyaltyUser').value).toBe('bob');
    expect(h.$('loyaltyPoints').value).toBe('500');
  });

  it('saves settings, dropping empty numbers and blank names', async () => {
    const h = await boot({ 'PUT /api/loyalty/config': { body: { success: true } } });
    await open(h, 'loyalty');
    h.$('loyaltyPointsPerMinute').value = '';
    h.$('loyaltyCurrencyName').value = '  ';
    h.$('loyaltyEnabled').checked = false;
    h.window.eval('mgrSaveLoyaltyConfig()');
    await flush();
    expect(h.callsTo('/api/loyalty/config', 'PUT')[0].body).toEqual({
      enabled: false, currencyNamePlural: 'coins', pointsPerMessage: 5, maxPointsPerMessage: 50,
      messageCooldownSeconds: 30, subscriberMultiplier: 2, vipMultiplier: 1.5, pointsPerLevel: 1000
    });
    expect(h.$('loyaltyStatus').textContent).toBe('Points settings saved.');
  });

  it('shows the server\'s validation error', async () => {
    const h = await boot({ 'PUT /api/loyalty/config': { status: 400, body: { error: 'vipMultiplier must be between 0 and 100' } } });
    await open(h, 'loyalty');
    h.window.eval('mgrSaveLoyaltyConfig()');
    await flush();
    expect(h.$('loyaltyStatus').textContent).toBe('vipMultiplier must be between 0 and 100');
  });

  it.each([
    ['', '5', 'Enter a valid Twitch username.'],
    ['bad name', '5', 'Enter a valid Twitch username.'],
    ['bob', '', 'Points must be a whole number, 0 or more.'],
    ['bob', '-1', 'Points must be a whole number, 0 or more.'],
    ['bob', '1.5', 'Points must be a whole number, 0 or more.']
  ])('set points validates (%p, %p)', async (user, points, message) => {
    const h = await boot();
    await open(h, 'loyalty');
    h.$('loyaltyUser').value = user;
    h.$('loyaltyPoints').value = points;
    h.window.eval('mgrSetUserPoints()');
    await flush();
    expect(h.$('loyaltyStatus').textContent).toBe(message);
    expect(h.fetchCalls.filter(c => c.method === 'PUT')).toHaveLength(0);
  });

  it('sets a viewer\'s points (lower-cased, @ stripped)', async () => {
    const h = await boot({ 'PUT /api/loyalty/user/bob/points': { body: { success: true } } });
    await open(h, 'loyalty');
    h.$('loyaltyUser').value = '@Bob';
    h.$('loyaltyPoints').value = '1200';
    h.window.eval('mgrSetUserPoints()');
    await flush();
    expect(h.callsTo('/api/loyalty/user/bob/points', 'PUT')[0].body).toEqual({ points: 1200, reason: 'Set from dashboard' });
    expect(h.$('loyaltyStatus').textContent).toBe(`Bob now has ${(1200).toLocaleString()} points.`);
  });

  it('reports a failed load (e.g. a corrupt loyalty.json)', async () => {
    const h = await boot({ 'GET /api/loyalty/config': { status: 503, body: { error: 'loyalty.json is unreadable' } } });
    await open(h, 'loyalty');
    expect(h.$('loyaltyStatus').textContent).toBe('Could not load loyalty data: loyalty.json is unreadable');
  });
});

describe('manage.js: Quotes', () => {
  it('lists quotes as text with paging', async () => {
    const h = await boot();
    await open(h, 'quotes');
    expect(h.$('quotesList').textContent).toContain(EVIL);
    expect(h.$('quotesList').querySelectorAll('tr')[1].textContent).toContain('-');
    expect(h.$('quotesPageInfo').textContent).toBe('Page 1 of 2 (25 quotes)');
    expect(h.$('quotesPrev').disabled).toBe(true);
    expect(h.$('quotesNext').disabled).toBe(false);
    expect(h.$('quotesMaxLength').value).toBe('500');
    expect(h.document.querySelector('#quotes img')).toBeNull();
  });

  it('searches and pages with the right query', async () => {
    const h = await boot();
    await open(h, 'quotes');
    h.window.eval('mgrQuotesPage(1)');
    await flush();
    expect(h.fetchCalls.some(c => c.url === '/api/quotes?page=2&pageSize=20')).toBe(true);
    h.$('quotesSearch').value = 'a&b';
    h.window.eval('mgrLoadQuotes(1)');
    await flush();
    expect(h.fetchCalls.some(c => c.url === '/api/quotes?page=1&pageSize=20&search=a%26b')).toBe(true);
    // paging past the end does nothing
    const before = h.fetchCalls.length;
    h.window.eval('mgrQuotesPage(-1)');
    await flush();
    expect(h.fetchCalls.length).toBe(before);
  });

  it('adds a quote, with the game only when given', async () => {
    const h = await boot({ 'POST /api/quotes': { status: 201, body: { success: true, quote: { id: 26 } } } });
    await open(h, 'quotes');
    h.window.eval('mgrAddQuote()');
    expect(h.$('quotesStatus').textContent).toBe('Enter the quote text.');
    h.$('quoteText').value = ' Hello there ';
    h.$('quoteAddedBy').value = '';
    h.window.eval('mgrAddQuote()');
    await flush();
    expect(h.callsTo('/api/quotes', 'POST')[0].body).toEqual({ text: 'Hello there', addedBy: 'dashboard' });
    expect(h.$('quotesStatus').textContent).toBe('Added quote #26.');
    expect(h.$('quoteText').value).toBe('');
  });

  it('edits through a prompt and deletes after confirming', async () => {
    const h = await boot({ 'PUT /api/quotes/2': { body: { success: true } }, 'DELETE /api/quotes/2': { body: { success: true } } });
    const promptMock = jest.fn().mockReturnValueOnce(null).mockReturnValueOnce('   ').mockReturnValueOnce(' New text ');
    (h.window as unknown as { prompt: unknown }).prompt = promptMock;
    await open(h, 'quotes');
    const second = h.$('quotesList').querySelectorAll('tr')[1];
    click(buttonIn(second, 'Edit'));
    await flush();
    expect(h.callsTo('/api/quotes/2', 'PUT')).toHaveLength(0);
    click(buttonIn(second, 'Edit'));
    await flush();
    expect(h.$('quotesStatus').textContent).toBe('A quote cannot be empty.');
    click(buttonIn(second, 'Edit'));
    await flush();
    expect(promptMock).toHaveBeenLastCalledWith('Edit quote #2', 'Second');
    expect(h.callsTo('/api/quotes/2', 'PUT')[0].body).toEqual({ text: 'New text' });
    click(buttonIn(h.$('quotesList').querySelectorAll('tr')[1], 'Delete'));
    await flush();
    expect(h.callsTo('/api/quotes/2', 'DELETE')).toHaveLength(1);
  });

  it('validates and saves quote settings', async () => {
    const h = await boot({ 'PUT /api/quotes/config': { body: { success: true } } });
    await open(h, 'quotes');
    h.$('quotesMaxLength').value = '3';
    h.window.eval('mgrSaveQuotesConfig()');
    expect(h.$('quotesStatus').textContent).toContain('the maximum at least the minimum');
    h.$('quotesMaxLength').value = '300';
    h.$('quotesMaxQuotes').value = '0';
    h.window.eval('mgrSaveQuotesConfig()');
    expect(h.$('quotesStatus').textContent).toBe('Maximum quotes must be at least 1.');
    h.$('quotesMaxQuotes').value = '50';
    h.$('quotesAllowDuplicates').checked = true;
    h.window.eval('mgrSaveQuotesConfig()');
    await flush();
    expect(h.callsTo('/api/quotes/config', 'PUT')[0].body).toEqual({ minLength: 5, maxLength: 300, maxQuotes: 50, allowDuplicates: true });
  });

  it('exports as a downloaded file', async () => {
    const h = await boot({ 'GET /api/quotes/export': { body: { quotes: [{ id: 1 }, { id: 2 }], exportedAt: 'x' } } });
    const createObjectURL = jest.fn(() => 'blob:quotes');
    const revokeObjectURL = jest.fn();
    Object.assign(h.window.URL, { createObjectURL, revokeObjectURL });
    const clicks: string[] = [];
    h.window.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicks.push(this.download);
    };
    await open(h, 'quotes');
    h.window.eval('mgrExportQuotes()');
    await flush();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clicks).toHaveLength(1);
    expect(clicks[0]).toMatch(/^quotes-\d{4}-\d{2}-\d{2}\.json$/);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:quotes');
    expect(h.$('quotesStatus').textContent).toBe('Exported 2 quotes.');
  });

  function chooseFile(h: PageHarness, inputId: string, content: string, name = 'file.json'): void {
    const file = new h.window.File([content], name, { type: 'application/json' });
    Object.defineProperty(h.$(inputId), 'files', { configurable: true, value: [file] });
  }

  it('imports an export file or a bare array, and rejects bad files', async () => {
    const h = await boot({ 'POST /api/quotes/import': { body: { success: true, imported: 2, skipped: 1 } } });
    await open(h, 'quotes');
    h.window.eval('mgrImportQuotes()');
    await flush();
    expect(h.$('quotesStatus').textContent).toBe('Choose a file first.');

    chooseFile(h, 'quotesImportFile', 'not json', 'bad.json');
    h.window.eval('mgrImportQuotes()');
    await flush(20);
    expect(h.$('quotesStatus').textContent).toBe('bad.json is not a valid JSON file.');

    chooseFile(h, 'quotesImportFile', '{"other":1}');
    h.window.eval('mgrImportQuotes()');
    await flush(20);
    expect(h.$('quotesStatus').textContent).toBe('That file has no quotes list.');

    chooseFile(h, 'quotesImportFile', JSON.stringify({ quotes: [{ text: 'a' }] }));
    h.window.eval('mgrImportQuotes()');
    await flush(20);
    expect(h.callsTo('/api/quotes/import', 'POST')[0].body).toEqual({ quotes: [{ text: 'a' }], merge: true });
    expect(h.$('quotesStatus').textContent).toBe('Imported 2 quotes (1 skipped).');

    chooseFile(h, 'quotesImportFile', JSON.stringify([{ text: 'b' }]));
    h.window.eval('mgrImportQuotes()');
    await flush(20);
    expect(h.callsTo('/api/quotes/import', 'POST')[1].body).toEqual({ quotes: [{ text: 'b' }], merge: true });
  });
});

describe('manage.js: Counters', () => {
  it('lists counters sorted by name, descriptions as text', async () => {
    const h = await boot();
    await open(h, 'counters');
    const rows = h.$('countersList').querySelectorAll('tr');
    expect(rows[0].textContent).toContain('deaths');
    expect(rows[0].textContent).toContain(EVIL);
    expect(rows[1].textContent).toContain('wins');
    expect(h.document.querySelector('#counters img')).toBeNull();
  });

  it('increments, decrements, resets, sets and deletes (URL-encoded names)', async () => {
    const h = await boot({ 'POST /api/counters/*': { body: { success: true } }, 'PUT /api/counters/*': { body: { success: true } }, 'DELETE /api/counters/*': { body: { success: true } } });
    h.routes.set('GET /api/counters', { body: [{ name: 'boss kills', value: 1 }] });
    await open(h, 'counters');
    const r = () => h.$('countersList').querySelector('tr')!;
    click(buttonIn(r(), '+'));
    await flush();
    click(buttonIn(r(), '−'));
    await flush();
    click(buttonIn(r(), 'Reset'));
    await flush();
    expect(h.fetchCalls.filter(c => c.method === 'POST').map(c => [c.url, c.body])).toEqual([
      ['/api/counters/boss%20kills/increment', { amount: 1 }],
      ['/api/counters/boss%20kills/decrement', { amount: 1 }],
      ['/api/counters/boss%20kills/reset', {}]
    ]);

    const setInput = r().querySelector('input')!;
    setInput.value = '2.5';
    click(buttonIn(r(), 'Set'));
    await flush();
    expect(h.$('countersStatus').textContent).toBe('Enter a whole number to set.');
    r().querySelector('input')!.value = '-4';
    click(buttonIn(r(), 'Set'));
    await flush();
    expect(h.callsTo('/api/counters/boss%20kills', 'PUT')[0].body).toEqual({ value: -4 });

    click(buttonIn(r(), 'Delete'));
    await flush();
    expect(h.confirmMock).toHaveBeenCalledWith('Delete the "boss kills" counter?');
    expect(h.callsTo('/api/counters/boss%20kills', 'DELETE')).toHaveLength(1);
  });

  it('shows the server error of a failed action', async () => {
    const h = await boot({ 'POST /api/counters/*': { status: 404, body: { error: 'Counter not found' } } });
    await open(h, 'counters');
    click(buttonIn(h.$('countersList').querySelector('tr')!, '+'));
    await flush();
    expect(h.$('countersStatus').textContent).toBe('Counter not found');
  });

  it('creates a counter', async () => {
    const h = await boot({ 'POST /api/counters': { status: 201, body: { success: true } } });
    await open(h, 'counters');
    h.window.eval('mgrCreateCounter()');
    expect(h.$('countersStatus').textContent).toBe('Enter a counter name.');
    h.$('newCounterName').value = 'falls';
    h.$('newCounterInitial').value = '1.5';
    h.window.eval('mgrCreateCounter()');
    expect(h.$('countersStatus').textContent).toBe('The start value must be a whole number.');
    h.$('newCounterInitial').value = '';
    h.window.eval('mgrCreateCounter()');
    await flush();
    expect(h.callsTo('/api/counters', 'POST')[0].body).toEqual({ name: 'falls', initialValue: 0 });
    expect(h.$('newCounterName').value).toBe('');
  });
});

describe('manage.js: Backups', () => {
  it('lists backups', async () => {
    const h = await boot();
    await open(h, 'backups');
    const text = h.$('backupsList').textContent!;
    expect(text).toContain('backup-1.json');
    expect(text).toContain('2.0 KB');
    expect(text).toContain('quotes, loyalty');
  });

  it('shows an empty list', async () => {
    const h = await boot({ 'GET /api/backup/list': { body: [] } });
    await open(h, 'backups');
    expect(h.$('backupsList').textContent).toBe('No backups yet.');
  });

  it('creates a backup', async () => {
    const h = await boot({ 'POST /api/backup/create': { body: { success: true, filename: 'backup-2.json' } } });
    await open(h, 'backups');
    h.window.eval('mgrCreateBackup()');
    await flush();
    expect(h.$('backupsStatus').textContent).toBe('Created backup-2.json.');
  });

  it('restores: fetches the backup, posts it, and reports what was restored', async () => {
    const BACKUP = { metadata: { createdAt: 'x', includes: ['quotes'] }, quotes: { quotes: [] } };
    const h = await boot({
      'GET /api/backup/backup-1.json': { body: BACKUP },
      'POST /api/backup/restore': { body: { success: true, restored: ['quotes'], errors: ['loyalty'] } }
    });
    await open(h, 'backups');
    click(buttonIn(h.$('backupsList').querySelector('tr')!, 'Restore'));
    await flush();
    expect(h.callsTo('/api/backup/restore', 'POST')[0].body).toEqual({ backup: BACKUP });
    expect(h.$('backupsStatus').textContent).toBe('Restored quotes. Failed: loyalty. Restart the bot to reload them.');
    expect(h.$('backupsStatus').className).toContain('mgr-status-error');
  });

  it('does not restore or delete when cancelled', async () => {
    const h = await boot({}, false);
    await open(h, 'backups');
    click(buttonIn(h.$('backupsList').querySelector('tr')!, 'Restore'));
    click(buttonIn(h.$('backupsList').querySelector('tr')!, 'Delete'));
    await flush();
    expect(h.fetchCalls.filter(c => c.url.startsWith('/api/backup/backup-1') || c.method !== 'GET')).toHaveLength(0);
  });

  it('a missing backup stops the restore', async () => {
    const h = await boot({ 'GET /api/backup/backup-1.json': { status: 404, body: { error: 'Backup not found' } } });
    await open(h, 'backups');
    click(buttonIn(h.$('backupsList').querySelector('tr')!, 'Restore'));
    await flush();
    expect(h.callsTo('/api/backup/restore')).toHaveLength(0);
    expect(h.$('backupsStatus').textContent).toBe('Restore failed: Backup not found');
  });

  it('deletes and downloads', async () => {
    const h = await boot({ 'DELETE /api/backup/backup-1.json': { body: { success: true } }, 'GET /api/backup/backup-1.json': { body: { metadata: {} } } });
    Object.assign(h.window.URL, { createObjectURL: jest.fn(() => 'blob:b'), revokeObjectURL: jest.fn() });
    const clicks: string[] = [];
    h.window.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicks.push(this.download);
    };
    await open(h, 'backups');
    click(buttonIn(h.$('backupsList').querySelector('tr')!, 'Download'));
    await flush();
    expect(clicks).toEqual(['backup-1.json']);
    click(buttonIn(h.$('backupsList').querySelector('tr')!, 'Delete'));
    await flush();
    expect(h.callsTo('/api/backup/backup-1.json', 'DELETE')).toHaveLength(1);
    expect(h.$('backupsStatus').textContent).toBe('Deleted backup-1.json.');
  });

  it('uploads a chosen backup file', async () => {
    const h = await boot({ 'POST /api/backup/upload': { body: { success: true, filename: 'uploaded.json' } } });
    await open(h, 'backups');
    const file = new h.window.File([JSON.stringify({ metadata: { includes: [] } })], 'mine.json');
    Object.defineProperty(h.$('backupUploadFile'), 'files', { configurable: true, value: [file] });
    h.window.eval('mgrUploadBackup()');
    await flush(20);
    expect(h.callsTo('/api/backup/upload', 'POST')[0].body).toEqual({ backup: { metadata: { includes: [] } } });
    expect(h.$('backupsStatus').textContent).toBe('Uploaded as uploaded.json.');
  });
});
