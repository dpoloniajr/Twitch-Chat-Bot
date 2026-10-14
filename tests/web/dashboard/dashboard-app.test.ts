/** @jest-environment jsdom */
/**
 * Characterization tests for dashboard/public/app.js (compiled from
 * src/web/dashboard/public/app.ts) running in the real dashboard index.html.
 */
import * as fs from 'fs';
import * as path from 'path';
import { loadPage, flush, click, change, PageHarness, MockResponseInit, REPO_ROOT } from '../support/static-page-harness';

const STATUS = {
  isConnected: true,
  channels: ['chan1', 'chan2'],
  commandsExecuted: 42,
  lastCommand: { user: 'alice', command: '!hello', timestamp: '2026-01-02T03:04:05Z' },
  broadcasterName: 'streamer',
  scopes: ['chat:read', 'chat:edit'],
  commands: [{ name: '!hello', description: 'Say <hi>' }],
};

const ALERT_CONFIG = {
  global: { enabled: true, defaultVolume: 0.5, defaultDuration: 7, defaultDelay: 2, ttsEnabled: true, ttsVoice: 'en-GB', ttsRate: 1.5, ttsPitch: 0.9 },
  alertTypes: {
    follow: {
      enabled: false, duration: 9, volume: 0.3, messageTemplate: 'Thanks {user}',
      enterAnimation: 'fadeIn', exitAnimation: 'fadeOut', textColor: '#112233', borderColor: '#445566', fontSize: 40,
      sound: 'custom', image: '/uploads/images/pic.png', video: '/uploads/videos/clip.mp4', customSound: '/uploads/sounds/ding.mp3',
      ttsEnabled: true, ttsTemplate: '{user} followed',
    },
    bits: { enabled: true, minBits: 50 },
    raid: { enabled: true, minViewers: 5 },
  },
};

const OBS_CONFIG = {
  overlays: {
    alerts: { duration: 6, volume: 0.4, enabled: false },
    recentEvents: { limit: 7, showTime: false, enabled: true },
    chatBox: { messageTimeout: 12, hideBot: true, enabled: true },
    goalBar: { type: 'subscriber', goal: 250, enabled: true },
  },
};

const FILTERS = {
  filterUrls: true, filterAllCaps: false, filterRepeatChars: true, filterSpam: false,
  filterAction: 'timeout', timeoutDurationSeconds: 120, blacklistWords: ['bad', 'wor"d'],
};

function defaultRoutes(): Record<string, MockResponseInit> {
  return {
    'GET /api/status': { body: STATUS },
    'GET /api/logs': { body: [
      { timestamp: '2026-01-01T00:00:00Z', user: 'u1', command: '!a', channel: 'c', success: true },
      { timestamp: '2026-01-01T00:00:01Z', user: 'u2<b>', command: '!b', channel: 'c', success: false },
    ] },
    'GET /api/stats': { body: {
      low: { commands: 1, firstSeen: '2026-01-01T00:00:00Z', lastCommand: '2026-01-01T00:00:00Z' },
      high: { commands: 9, firstSeen: '2026-01-01T00:00:00Z', lastCommand: '2026-01-01T00:00:00Z' },
    } },
    'GET /api/custom-commands': { body: [
      { name: '!zed', response: 'Z', level: 'mod', fetchEnabled: true, cooldownSeconds: 10 },
      { name: "!it's", response: 'R <x>' },
    ] },
    'GET /api/builtin-commands': { body: [
      { name: '!uptime', description: 'Shows uptime', perm: 'everyone', cooldownSeconds: 5 },
      { name: '!so', perm: 'mod' },
    ] },
    'GET /api/announcements': { body: ['one', 'two'] },
    'GET /api/redemptions': { body: [] },
    'GET /api/eventsub-events': { body: [] },
    'GET /api/filters': { body: FILTERS },
    'GET /obs/config': { body: OBS_CONFIG },
    'GET /api/alerts/config': { body: ALERT_CONFIG },
  };
}

async function boot(extra: Record<string, MockResponseInit> = {}, confirmResult = true): Promise<PageHarness> {
  const h = loadPage({
    html: 'dashboard/public/index.html',
    script: 'dashboard/public/app.js',
    routes: { ...defaultRoutes(), ...extra },
    confirmResult,
  });
  // jsdom fires DOMContentLoaded itself, asynchronously after construction
  await flush();
  return h;
}

describe('dashboard app: initial load', () => {
  it('opens a WebSocket to the page host and fetches all initial data', async () => {
    const h = await boot();
    expect(h.sockets).toHaveLength(1);
    expect(h.sockets[0].url).toBe('ws://localhost:3000');
    const urls = h.fetchCalls.map(c => `${c.method} ${c.url}`);
    expect(urls).toEqual(expect.arrayContaining([
      'GET /api/status', 'GET /api/logs', 'GET /api/stats', 'GET /api/custom-commands',
      'GET /api/builtin-commands', 'GET /api/announcements', 'GET /api/redemptions',
      'GET /api/eventsub-events', 'GET /api/filters', 'GET /obs/config', 'GET /api/alerts/config',
    ]));
    // first DOMContentLoaded listener's fetches happen in order, before the alert config one
    expect(urls.slice(0, 11)).toEqual([
      'GET /api/status', 'GET /api/logs', 'GET /api/stats', 'GET /api/custom-commands',
      'GET /api/builtin-commands', 'GET /api/announcements', 'GET /api/redemptions',
      'GET /api/eventsub-events', 'GET /api/filters', 'GET /obs/config', 'GET /api/alerts/config',
    ]);
  });

  it('renders /api/status into the dashboard and settings fields', async () => {
    const h = await boot();
    expect(h.$('botStatus').textContent).toBe('Connected');
    expect(h.$('statusIndicator').className).toBe('status-indicator connected');
    expect(h.$('channelsList').textContent).toBe('chan1, chan2');
    expect(h.$('commandCount').textContent).toBe('42');
    expect(h.$('lastCommand').textContent).toBe('alice: !hello');
    expect(h.$('lastCommandTime').textContent).toBe(new Date(STATUS.lastCommand.timestamp).toLocaleString());
    expect(h.$('broadcasterName').value).toBe('streamer');
    expect(h.$('channels').value).toBe('chan1, chan2');
    expect(h.$('scopes').value).toBe('chat:read chat:edit');
    expect(h.$('commandsList').querySelector('.command-name')!.textContent).toBe('!hello');
    expect(h.$('commandsList').querySelector('.command-desc')!.innerHTML).toBe('Say &lt;hi&gt;');
  });

  it('renders disconnected/default state for an empty status', async () => {
    const h = await boot({ 'GET /api/status': { body: {} } });
    expect(h.$('botStatus').textContent).toBe('Disconnected');
    expect(h.$('statusIndicator').className).toBe('status-indicator disconnected');
    expect(h.$('channelsList').textContent).toBe('-');
    expect(h.$('commandCount').textContent).toBe('0');
    expect(h.$('lastCommand').textContent).toBe('None');
    expect(h.$('broadcasterName').value).toBe('-');
    expect(h.$('scopes').value).toBe('-');
  });

  it('renders logs newest first with escaping and success classes', async () => {
    const h = await boot();
    const rows = h.$('logsList').querySelectorAll('tr');
    expect(rows).toHaveLength(2);
    expect(rows[0].children[1].innerHTML).toBe('u2&lt;b&gt;');
    expect(rows[0].children[4].className).toBe('status-error');
    expect(rows[0].children[4].textContent!.trim()).toBe('✗ Failed');
    expect(rows[1].children[4].textContent!.trim()).toBe('✓ Success');
  });

  it('renders stats sorted by command count', async () => {
    const h = await boot();
    const names = Array.from(h.$('statsList').querySelectorAll('strong')).map(e => e.textContent);
    expect(names).toEqual(['high', 'low']);
  });

  it('renders custom commands sorted by name with defaults', async () => {
    const h = await boot();
    const rows = h.$('customCommandsList').querySelectorAll('tr');
    expect(rows).toHaveLength(2);
    expect(rows[0].children[0].textContent).toBe("!it's");
    expect(rows[0].children[1].innerHTML).toBe('R &lt;x&gt;');
    expect(rows[0].children[2].textContent).toBe('everyone');
    expect(rows[0].children[3].textContent).toBe('No');
    expect(rows[0].children[4].textContent).toBe('0s');
    expect(rows[1].children[3].textContent).toBe('Yes');
    expect(rows[1].children[4].textContent).toBe('10s');
  });

  it('renders built-in commands with cooldown inputs', async () => {
    const h = await boot();
    expect((h.$('cooldown-uptime') as HTMLInputElement).value).toBe('5');
    const rows = h.$('builtinCommandsList').querySelectorAll('tr');
    expect(rows[0].children[1].textContent).toBe('Shows uptime');
    expect(rows[0].children[2].textContent).toBe('Everyone');
    expect(rows[1].children[1].textContent).toBe('Built-in command');
    expect(rows[1].children[2].textContent).toBe('Moderator');
  });

  it('loads announcements into the textarea, tolerating non-arrays', async () => {
    let h = await boot();
    expect(h.$('announcementsList').value).toBe('one\ntwo');
    h = await boot({ 'GET /api/announcements': { body: { nope: true } } });
    expect(h.$('announcementsList').value).toBe('');
  });

  it('shows empty states for redemptions and EventSub events', async () => {
    const h = await boot();
    expect(h.$('redemptionsList').textContent).toBe('No redemptions yet');
    expect(h.$('eventSubEventsList').textContent).toBe('No events yet (enable EventSub in .env)');
  });

  it('renders redemptions and events newest first, max 20', async () => {
    const reds = Array.from({ length: 25 }, (_, i) => ({ user: `u${i}`, reward: 'R', input: i === 24 ? '<i>x</i>' : '', timestamp: 0 }));
    const evs = [{ type: 'follow', details: 'a <b>', timestamp: 0 }, { timestamp: 0 }];
    const h = await boot({ 'GET /api/redemptions': { body: reds }, 'GET /api/eventsub-events': { body: evs } });
    const items = h.$('redemptionsList').querySelectorAll('.event-item');
    expect(items).toHaveLength(20);
    expect(items[0].querySelector('strong')!.textContent).toBe('u24');
    expect(items[0].querySelector('em')!.innerHTML).toBe('&lt;i&gt;x&lt;/i&gt;');
    const evItems = h.$('eventSubEventsList').querySelectorAll('.event-item-type');
    expect(Array.from(evItems).map(e => e.textContent)).toEqual(['Event', 'follow']);
  });

  it('populates chat filter settings and the blacklist', async () => {
    const h = await boot();
    expect(h.$('filterUrls').checked).toBe(true);
    expect(h.$('filterAllCaps').checked).toBe(false);
    expect(h.$('filterRepeatChars').checked).toBe(true);
    expect(h.$('filterAction').value).toBe('timeout');
    expect(h.$('timeoutDuration').value).toBe('120');
    const words = Array.from(h.$('blacklistContainer').querySelectorAll('.blacklist-word span')).map(s => s.textContent);
    expect(words).toEqual(['bad', 'wor"d']);
  });

  it('populates OBS overlay config and builds overlay URLs', async () => {
    const h = await boot();
    expect(h.$('alertsDuration').value).toBe('6');
    expect(h.$('alertsEnabled').checked).toBe(false);
    expect(h.$('recentEventsShowTime').checked).toBe(false);
    expect(h.$('chatBoxHideBot').checked).toBe(true);
    expect(h.$('goalBarType').value).toBe('subscriber');
    expect(h.$('alertsUrl').value).toBe('http://localhost:3000/obs/overlays/alerts.html?duration=6000&volume=0.4');
    expect(h.$('recentEventsUrl').value).toBe('http://localhost:3000/obs/overlays/recent-events.html?limit=7&showTime=false');
    expect(h.$('chatBoxUrl').value).toBe('http://localhost:3000/obs/overlays/chat-box.html?timeout=12000&hideBot=true');
    expect(h.$('goalBarUrl').value).toBe('http://localhost:3000/obs/overlays/goal-bar.html?goal=250&type=subscriber');
    expect(h.$('ttsUrl').value).toMatch(/^http:\/\/localhost:3000\/obs\/overlays\/tts-display\.html/);
    expect(h.$('leaderboardUrl').value).toMatch(/^http:\/\/localhost:3000\/obs\/overlays\/leaderboard\.html/);
    expect(h.$('counterUrl').value).toMatch(/^http:\/\/localhost:3000\/obs\/overlays\/counter-display\.html/);
    expect(h.$('quoteUrl').value).toMatch(/^http:\/\/localhost:3000\/obs\/overlays\/quote-display\.html/);
  });

  it('populates the alert configuration UI', async () => {
    const h = await boot();
    expect(h.$('globalEnabled').checked).toBe(true);
    expect(h.$('globalVolume').value).toBe('0.5');
    expect(h.$('globalVolumeDisplay').textContent).toBe('0.5');
    expect(h.$('globalDuration').value).toBe('7');
    expect(h.$('globalTtsEnabled').checked).toBe(true);
    expect(h.$('globalTtsVoice').value).toBe('en-GB');
    expect(h.$('globalTtsRateDisplay').textContent).toBe('1.5');
    expect(h.$('globalTtsPitchDisplay').textContent).toBe('0.9');
    expect(h.$('follow-enabled').checked).toBe(false);
    expect(h.$('follow-duration').value).toBe('9');
    expect(h.$('follow-volume-display').textContent).toBe('0.3');
    expect(h.$('follow-messageTemplate').value).toBe('Thanks {user}');
    expect(h.$('follow-enterAnimation').value).toBe('fadeIn');
    expect(h.$('follow-textColor').value).toBe('#112233');
    expect(h.$('follow-fontSize').value).toBe('40');
    expect(h.$('follow-sound').value).toBe('custom');
    expect(h.$('follow-customSound-group').style.display).toBe('block');
    expect(h.$('follow-image-name').textContent).toBe('pic.png');
    expect(h.$('follow-image-clear').style.display).toBe('inline-block');
    expect(h.$('follow-video-name').textContent).toBe('clip.mp4');
    expect(h.$('follow-customSound-name').textContent).toBe('ding.mp3');
    expect(h.$('bits-minBits').value).toBe('50');
    expect(h.$('raid-minViewers').value).toBe('5');
  });

  it('logs (does not throw) when an initial load fails', async () => {
    const h = await boot({ 'GET /api/logs': { networkError: new Error('down') }, 'GET /api/stats': { jsonError: new Error('bad json') } });
    expect(h.consoleError).toHaveBeenCalledWith('Failed to load logs:', expect.any(Error));
    expect(h.consoleError).toHaveBeenCalledWith('Failed to load stats:', expect.any(Error));
  });
});

describe('dashboard app: WebSocket messages', () => {
  it('state message replaces bot state and re-renders', async () => {
    const h = await boot();
    h.sockets[0].emit({ type: 'state', data: { isConnected: false, channels: ['x'], commandsExecuted: 3 } });
    expect(h.$('botStatus').textContent).toBe('Disconnected');
    expect(h.$('channelsList').textContent).toBe('x');
    expect(h.$('commandCount').textContent).toBe('3');
  });

  it('log message prepends a row and caps at 100 rows', async () => {
    const h = await boot({ 'GET /api/logs': { body: [] } });
    for (let i = 0; i < 101; i++) {
      h.sockets[0].emit({ type: 'log', data: { timestamp: 0, user: `u${i}`, command: '!c', channel: 'ch', success: i % 2 === 0 } });
    }
    const rows = h.$('logsList').querySelectorAll('tr');
    expect(rows).toHaveLength(100);
    expect(rows[0].children[1].textContent).toBe('u100');
    expect(rows[99].children[1].textContent).toBe('u1');
  });

  it('chat message prepends to the feed (message escaped) and caps at 200', async () => {
    const h = await boot();
    h.sockets[0].emit({ type: 'chat', data: { timestamp: 0, user: 'bob', channel: 'chan', message: '<b>hi</b>' } });
    const msg = h.$('chatFeed').querySelector('.chat-message')!;
    expect(msg.querySelector('.chat-text')!.innerHTML).toBe('&lt;b&gt;hi&lt;/b&gt;');
    expect(msg.querySelector('.chat-user')!.textContent).toContain('bob');
    expect(msg.querySelector('.chat-time')!.textContent).toContain('#chan');
    for (let i = 0; i < 205; i++) {
      h.sockets[0].emit({ type: 'chat', data: { timestamp: 0, user: 'u', channel: 'c', message: String(i) } });
    }
    expect(h.$('chatFeed').querySelectorAll('.chat-message')).toHaveLength(200);
  });

  it('customCommands and builtinCommands messages re-render the tables', async () => {
    const h = await boot();
    h.sockets[0].emit({ type: 'customCommands', data: [{ name: '!new', response: 'r' }] });
    expect(h.$('customCommandsList').querySelectorAll('tr')).toHaveLength(1);
    h.sockets[0].emit({ type: 'builtinCommands', data: [{ name: '!only', cooldownSeconds: 2 }] });
    expect(h.$('builtinCommandsList').querySelectorAll('tr')).toHaveLength(1);
    expect(h.$('cooldown-only').value).toBe('2');
  });

  it.each([
    ['stats', '/api/stats'],
    ['redemption', '/api/redemptions'],
    ['eventsub-event', '/api/eventsub-events'],
    ['announcements', '/api/announcements'],
    ['filters', '/api/filters'],
  ])('%s message refetches %s', async (type, url) => {
    const h = await boot();
    const before = h.callsTo(url).length;
    h.sockets[0].emit({ type });
    expect(h.callsTo(url).length).toBe(before + 1);
  });

  it('reconnects 3s after the socket closes', async () => {
    const h = await boot();
    h.sockets[0].onclose!({});
    expect(h.timers.map(t => t.delay)).toContain(3000);
    h.runTimers(3000);
    expect(h.sockets).toHaveLength(2);
    expect(h.sockets[1].url).toBe('ws://localhost:3000');
  });

  it('uses wss: on https pages', () => {
    const h = loadPage({ html: 'dashboard/public/index.html', script: 'dashboard/public/app.js', url: 'https://example.test:8443/' });
    h.window.eval('initWebSocket()');
    expect(h.sockets[0].url).toBe('wss://example.test:8443');
  });
});

describe('dashboard app: actions', () => {
  it('nav links switch pages via inline onclick', async () => {
    const h = await boot();
    const link = h.document.querySelector('a[href="#settings"]')!;
    click(link);
    expect(h.$('settings').classList.contains('active')).toBe(true);
    expect(h.$('dashboard').classList.contains('active')).toBe(false);
    expect(link.classList.contains('active')).toBe(true);
    expect(h.document.querySelectorAll('.nav-link.active')).toHaveLength(1);
    await flush();
    // Settings data is loaded by manage.js (tests/web/dashboard/manage.test.ts); app.js alone fetches nothing
    expect(h.callsTo('/api/config')).toHaveLength(0);
    expect(h.scriptErrors).toEqual([]);
  });

  it('command tester validates username and logs the test command', async () => {
    const h = await boot();
    h.$('testerUsername').value = '  ';
    h.window.eval('testCommand()');
    expect(h.$('testerResult').textContent).toBe('Please enter a username');
    expect(h.$('testerResult').className).toBe('result-box error');
    expect(h.callsTo('/api/logs', 'POST')).toHaveLength(0);

    h.$('testerUsername').value = 'carol';
    h.$('testerCommand').value = '!followage';
    h.$('testerArgs').value = '2d6';
    h.window.eval('testCommand()');
    expect(h.$('testerResult').className).toBe('result-box success');
    expect(h.$('testerResult').style.display).toBe('block');
    expect(h.$('testerResult').textContent).toContain('Command executed: !followage 2d6');
    expect(h.callsTo('/api/logs', 'POST')[0].body).toEqual({ user: 'carol', command: '!followage 2d6', channel: 'chan1', success: true });
  });

  it('clearLogs asks for confirmation then DELETEs and reloads', async () => {
    let h = await boot({}, false);
    h.window.eval('clearLogs()');
    await flush();
    expect(h.callsTo('/api/logs', 'DELETE')).toHaveLength(0);
    h = await boot();
    h.window.eval('clearLogs()');
    await flush();
    expect(h.callsTo('/api/logs', 'DELETE')).toHaveLength(1);
    expect(h.callsTo('/api/logs', 'GET')).toHaveLength(2); // initial load + reload
  });

  it('saveCommand requires name and response', async () => {
    const h = await boot();
    h.window.eval('saveCommand()');
    await flush();
    expect(h.alerts[0]).toMatch(/Command name and response are required/);
    expect(h.callsTo('/api/custom-commands', 'POST')).toHaveLength(0);
  });

  it('saveCommand posts the form, resets it and reloads', async () => {
    const h = await boot();
    h.$('ccName').value = ' !greet ';
    h.$('ccResponse').value = ' hello ';
    h.$('ccLevel').value = 'mod';
    h.$('ccFetchUrl').value = ' http://x ';
    h.$('ccFetchEnabled').value = 'true';
    h.$('ccCooldown').value = '15';
    const before = h.callsTo('/api/custom-commands', 'GET').length;
    h.window.eval('saveCommand()');
    await flush();
    expect(h.callsTo('/api/custom-commands', 'POST')[0].body).toEqual({
      name: '!greet', response: 'hello', level: 'mod', fetchUrl: 'http://x', fetchEnabled: true, cooldownSeconds: 15,
    });
    expect(h.$('ccName').value).toBe('');
    expect(h.$('ccLevel').value).toBe('everyone');
    expect(h.$('ccFetchEnabled').value).toBe('false');
    expect(h.$('ccCooldown').value).toBe('0');
    expect(h.callsTo('/api/custom-commands', 'GET').length).toBe(before + 1);
  });

  it('Edit/Delete buttons on custom commands prefill or delete via attached listeners', async () => {
    const h = await boot();
    const row = h.$('customCommandsList').querySelectorAll('tr')[1];
    click(row.querySelector('.btn-secondary')!);
    expect(h.$('ccName').value).toBe('!zed');
    expect(h.$('ccResponse').value).toBe('Z');
    expect(h.$('ccLevel').value).toBe('mod');
    expect(h.$('ccFetchEnabled').value).toBe('true');
    expect(h.$('ccCooldown').value).toBe('10');
    // a name containing a quote reaches deleteCommand() unchanged
    click(h.$('customCommandsList').querySelectorAll('tr')[0].querySelector('.btn-danger')!);
    await flush();
    expect(h.confirmMock).toHaveBeenCalledWith("Delete !it's?");
    expect(h.callsTo('/api/custom-commands/', 'DELETE')[0].url).toBe("/api/custom-commands/!it's");
  });

  it('built-in command Update button PUTs the cooldown', async () => {
    const h = await boot({ 'PUT /api/builtin-commands/!so': { ok: false, status: 400, body: { error: 'nope' } } });
    h.$('cooldown-uptime').value = '12';
    click(h.$('builtinCommandsList').querySelectorAll('tr')[0].querySelector('button')!);
    await flush();
    const put = h.callsTo('/api/builtin-commands/', 'PUT')[0];
    expect(put.url).toBe('/api/builtin-commands/!uptime');
    expect(put.body).toEqual({ cooldownSeconds: 12 });
    expect(h.alerts).toContain('!uptime cooldown updated to 12s');
    click(h.$('builtinCommandsList').querySelectorAll('tr')[1].querySelector('button')!);
    await flush();
    expect(h.alerts).toContain('Failed to update: nope');
  });

  it('saveAnnouncements posts trimmed non-empty lines', async () => {
    const h = await boot();
    h.$('announcementsList').value = ' a \n\n b\n';
    h.window.eval('saveAnnouncements()');
    await flush();
    expect(h.callsTo('/api/announcements', 'POST')[0].body).toEqual({ announcements: ['a', 'b'] });
    expect(h.alerts).toContain('Announcements saved. Restart bot to apply changes.');
  });

  it('createPoll validates, posts the !poll command and clears after 3s', async () => {
    const h = await boot();
    h.window.eval('createPoll()');
    expect(h.alerts).toEqual(['Poll title required']);
    h.$('pollTitle').value = 'Best?';
    h.$('pollOptions').value = 'a';
    h.window.eval('createPoll()');
    expect(h.alerts[1]).toBe('At least 2 options required');
    h.$('pollOptions').value = 'a, b,,c,d,e,f';
    h.$('pollDuration').value = '';
    h.window.eval('createPoll()');
    await flush();
    expect(h.callsTo('/api/chat', 'POST')[0].body).toEqual({ command: '!poll start "Best?" a;b;c;d;e 60' });
    expect(h.$('pollResult').textContent).toBe('Poll created: Best?');
    h.runTimers(3000);
    expect(h.$('pollTitle').value).toBe('');
    expect(h.$('pollResult').innerHTML).toBe('');
  });

  it('createPoll shows an error when the request fails', async () => {
    const h = await boot({ 'POST /api/chat': { networkError: new Error('boom') } });
    h.$('pollTitle').value = 'T';
    h.$('pollOptions').value = 'a,b';
    h.window.eval('createPoll()');
    await flush();
    expect(h.$('pollResult').textContent).toBe('Error: boom');
  });

  it('createPrediction posts the !prediction command', async () => {
    const h = await boot();
    h.$('predTitle').value = 'Win?';
    h.$('predOutcomes').value = 'yes,no,maybe';
    h.$('predDuration').value = '90';
    h.window.eval('createPrediction()');
    await flush();
    expect(h.callsTo('/api/chat', 'POST')[0].body).toEqual({ command: '!prediction start "Win?" yes;no 90' });
    expect(h.$('predResult').textContent).toBe('Prediction created: Win?');
    h.$('predOutcomes').value = 'one';
    h.window.eval('createPrediction()');
    expect(h.alerts).toContain('Exactly 2 outcomes required');
  });

  it('filters: toggles post a single setting; failure reloads filters', async () => {
    const h = await boot({ 'POST /api/filters': { body: { success: false, error: 'x' } } });
    const before = h.callsTo('/api/filters', 'GET').length;
    change(h.$('filterUrls'), false);
    await flush();
    expect(h.callsTo('/api/filters', 'POST')[0].body).toEqual({ filterUrls: false });
    expect(h.consoleError).toHaveBeenCalledWith('Failed to update filter:', 'x');
    expect(h.callsTo('/api/filters', 'GET').length).toBe(before + 1);
    h.window.eval("updateFilterSetting('unknownKey', 1)");
    expect(h.callsTo('/api/filters', 'POST')[1].body).toEqual({});
  });

  it('filters: add word via button and Enter key, remove word via button', async () => {
    const h = await boot({
      'POST /api/filters/words': { body: { success: true, words: ['bad', 'wor"d', 'new'] } },
      'DELETE /api/filters/words/*': { body: { success: true, words: ['wor"d'] } },
    });
    h.window.eval('addFilterWord()');
    expect(h.alerts).toEqual(['Please enter a word to filter']);
    h.$('newWord').value = ' new ';
    const keyEvent = new h.window.KeyboardEvent('keypress', { key: 'Enter', bubbles: true });
    h.$('newWord').dispatchEvent(keyEvent);
    await flush();
    expect(h.callsTo('/api/filters/words', 'POST')[0].body).toEqual({ word: 'new' });
    expect(h.$('newWord').value).toBe('');
    expect(h.$('blacklistContainer').querySelectorAll('.blacklist-word')).toHaveLength(3);

    click(h.$('blacklistContainer').querySelectorAll('.remove-filter-btn')[0]);
    await flush();
    expect(h.confirmMock).toHaveBeenCalledWith('Remove "bad" from filter?');
    expect(h.callsTo('/api/filters/words/', 'DELETE')[0].url).toBe('/api/filters/words/bad');
    expect(h.$('blacklistContainer').querySelectorAll('.blacklist-word')).toHaveLength(1);
  });

  it('filters: empty blacklist and add-word error', async () => {
    const h = await boot({
      'GET /api/filters': { body: { ...FILTERS, blacklistWords: [] } },
      'POST /api/filters/words': { body: { success: false, error: 'dup' } },
    });
    expect(h.$('blacklistContainer').textContent).toBe('No words in blacklist yet.');
    h.$('newWord').value = 'x';
    h.window.eval('addFilterWord()');
    await flush();
    expect(h.alerts).toEqual(['Error adding word: dup']);
  });

  it('OBS overlay config: validates and posts settings; failure reloads config', async () => {
    const h = await boot({ 'POST /obs/config/chatBox': { ok: false, status: 400, body: { error: 'bad' } } });
    h.window.eval("updateOverlayConfig('alerts', 'volume', '2')");
    await flush();
    expect(h.alerts).toEqual(['Volume must be a number between 0 and 1']);
    change(h.$('alertsDuration'), '8');
    await flush();
    expect(h.callsTo('/obs/config/alerts', 'POST')[0].body).toEqual({ duration: 8 });
    expect(h.$('alertsUrl').value).toBe('http://localhost:3000/obs/overlays/alerts.html?duration=8000&volume=0.4');
    change(h.$('alertsEnabled'), true);
    await flush();
    expect(h.callsTo('/obs/config/alerts', 'POST')[1].body).toEqual({ enabled: true });
    const before = h.callsTo('/obs/config', 'GET').length;
    h.window.eval("updateOverlayConfig('chatBox', 'messageTimeout', '3')");
    await flush();
    expect(h.alerts).toContain('Failed to update chatBox: bad');
    expect(h.callsTo('/obs/config', 'GET').length).toBe(before + 1);
    for (const [setting, msg] of [
      ['duration', 'Duration must be a positive number'],
      ['limit', 'Max events must be a positive number'],
      ['messageTimeout', 'Message timeout must be a positive number'],
      ['goal', 'Goal must be a positive number'],
    ]) {
      h.window.eval(`updateOverlayConfig('x', '${setting}', '0')`);
      await flush();
      expect(h.alerts).toContain(msg);
    }
  });

  it('copy buttons select the URL, copy, and reset after 2s', async () => {
    const h = await boot();
    const btn = h.$('alertsUrl').parentElement!.querySelector('button')!;
    click(btn);
    expect(h.execCommandMock).toHaveBeenCalledWith('copy');
    expect(btn.textContent).toBe('Copied!');
    expect(btn.style.backgroundColor).toBe('rgb(0, 204, 102)');
    h.runTimers(2000);
    expect(btn.textContent).toBe('Copy');
    expect(btn.style.backgroundColor).toBe('');
  });

  it('testOverlay sends test alerts or opens the recent events overlay', async () => {
    const h = await boot();
    h.$('ttsDuration').value = '4';
    h.window.eval("testOverlay('alerts'); testOverlay('tts'); testOverlay('recentEvents'); testOverlay('other')");
    const posts = h.callsTo('/api/test-alert', 'POST').map(c => c.body);
    expect(posts).toEqual([
      { alertType: 'follow', user: 'TestUser', message: 'This is a test alert' },
      { alertType: 'tts', user: 'TestUser', message: 'This is a test TTS message. Welcome to the stream!', config: { duration: 4000 } },
    ]);
    expect(h.alerts).toEqual(['Test alert sent! Check your alerts overlay.', 'Test TTS sent! Check your TTS display overlay.']);
    expect(h.openMock).toHaveBeenCalledWith('http://localhost:3000/obs/overlays/recent-events.html', '_blank');
  });

  it('alert settings: per-type updates, volume display and custom sound toggle', async () => {
    const h = await boot({ 'POST /api/alerts/config/follow': { body: { config: { enabled: true } } } });
    change(h.$('follow-volume'), '0.6');
    await flush();
    expect(h.callsTo('/api/alerts/config/follow', 'POST')[0].body).toEqual({ volume: 0.6 });
    expect(h.$('follow-volume-display').textContent).toBe('0.6');
    change(h.$('follow-sound'), 'none');
    await flush();
    expect(h.$('follow-customSound-group').style.display).toBe('none');
    expect(h.window.eval('alertConfig.alertTypes.follow')).toEqual({ enabled: true });
  });

  it('alert settings: global and variation updates', async () => {
    const h = await boot();
    change(h.$('globalVolume'), '0.2');
    expect(h.$('globalVolumeDisplay').textContent).toBe('0.2');
    expect(h.callsTo('/api/alerts/config/global', 'POST')[0].body).toEqual({ defaultVolume: 0.2 });
    change(h.$('globalTtsRate'), '1.2');
    expect(h.$('globalTtsRateDisplay').textContent).toBe('1.2');
    change(h.$('globalTtsPitch'), '0.7');
    expect(h.$('globalTtsPitchDisplay').textContent).toBe('0.7');
    expect(h.window.eval('alertConfig.global.ttsPitch')).toBe(0.7);

    h.window.eval("updateVariation('follow', 'big', 'enabled', false)");
    expect(h.callsTo('/api/alerts/config/follow/variation/big', 'POST')[0].body).toEqual({ enabled: false });
    expect(h.window.eval('alertConfig.alertTypes.follow.variations')).toEqual({ big: { enabled: false } });
    // unknown alert type: no request
    h.window.eval("updateVariation('nope', 'x', 'enabled', true)");
    expect(h.callsTo('/api/alerts/config/nope')).toHaveLength(0);
  });

  it('global settings are ignored before the alert config loads', () => {
    const h = loadPage({ html: 'dashboard/public/index.html', script: 'dashboard/public/app.js' });
    h.window.eval("updateGlobalSetting('defaultVolume', 0.1)");
    expect(h.fetchCalls).toHaveLength(0);
  });

  it('alert type tabs and collapsible sections toggle classes', async () => {
    const h = await boot();
    const tabs = h.document.querySelectorAll('.alert-tab');
    click(tabs[2]);
    expect(h.$('bits-config').classList.contains('active')).toBe(true);
    expect(h.$('follow-config').classList.contains('active')).toBe(false);
    expect(tabs[2].classList.contains('active')).toBe(true);
    expect(tabs[0].classList.contains('active')).toBe(false);
    const header = h.$('global-settings').previousElementSibling!;
    click(header);
    expect(h.$('global-settings').classList.contains('collapsed')).toBe(true);
    expect(header.classList.contains('collapsed')).toBe(true);
    click(header);
    expect(h.$('global-settings').classList.contains('collapsed')).toBe(false);
  });

  it('clearAlertMedia nulls the setting and hides the clear button', async () => {
    const h = await boot({ 'POST /api/alerts/config/follow': { body: { config: {} } } });
    click(h.$('follow-image-clear'));
    await flush();
    expect(h.callsTo('/api/alerts/config/follow', 'POST')[0].body).toEqual({ image: null });
    expect(h.$('follow-image-name').textContent).toBe('');
    expect(h.$('follow-image-clear').style.display).toBe('none');
  });

  it('uploadAlertMedia posts base64 data then saves the uploaded path', async () => {
    const h = await boot({
      'POST /api/uploads/image': { body: { path: '/uploads/images/new.png' } },
      'POST /api/alerts/config/follow': { body: { config: {} } },
    });
    const input = h.document.querySelector('input[type=file][onchange*="\'follow\', \'image\'"]') as HTMLInputElement;
    const file = new h.window.File(['abc'], 'new.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { value: [file] });
    change(input);
    for (let i = 0; i < 20 && h.callsTo('/api/alerts/config/follow').length === 0; i++) await flush();
    await flush();
    expect(h.callsTo('/api/uploads/image', 'POST')[0].body).toEqual({ data: 'data:image/png;base64,YWJj', filename: 'new.png' });
    expect(h.callsTo('/api/alerts/config/follow', 'POST')[0].body).toEqual({ image: '/uploads/images/new.png' });
    expect(h.$('follow-image-name').textContent).toBe('new.png');
    expect(h.$('follow-image-clear').style.display).toBe('inline-block');
  });

  it('uploadAlertMedia alerts on upload failure and ignores unknown media types', async () => {
    const h = await boot({ 'POST /api/uploads/video': { ok: false, status: 413, body: { error: 'too big' } } });
    const input = h.document.createElement('input');
    const file = new h.window.File(['x'], 'v.mp4', { type: 'video/mp4' });
    Object.defineProperty(input, 'files', { value: [file] });
    h.window.__input = input;
    h.window.eval("uploadAlertMedia('follow', 'bogus', __input)");
    h.window.eval("uploadAlertMedia('follow', 'video', __input)");
    for (let i = 0; i < 20 && h.alerts.length === 0; i++) await flush();
    expect(h.alerts).toEqual(['Upload failed: too big']);
    expect(h.callsTo('/api/uploads/')).toHaveLength(1);
  });

  it('resetAlertType confirms, posts and reloads the config', async () => {
    const h = await boot();
    click(h.document.querySelector('button[onclick="resetAlertType(\'follow\')"]')!);
    await flush();
    expect(h.callsTo('/api/alerts/config/reset', 'POST')[0].body).toEqual({ alertType: 'follow' });
    expect(h.callsTo('/api/alerts/config', 'GET').filter(c => c.url === '/api/alerts/config')).toHaveLength(2);
    expect(h.alerts).toContain('follow alert settings reset to defaults');
  });

  it('test panel: type change toggles fields and sendTestAlert posts type-specific data', async () => {
    const h = await boot();
    change(h.$('testAlertType'), 'bits');
    expect(h.$('testBitsGroup').style.display).toBe('block');
    expect(h.$('testTierGroup').style.display).toBe('none');
    h.$('testAlertBits').value = '';
    h.$('testAlertUser').value = '';
    h.window.eval('sendTestAlert()');
    change(h.$('testAlertType'), 'subscription');
    h.$('testAlertTier').value = '2000';
    h.$('testAlertMessage').value = 'hey';
    h.window.eval('sendTestAlert()');
    change(h.$('testAlertType'), 'raid');
    h.window.eval('sendTestAlert()');
    change(h.$('testAlertType'), 'redemption');
    h.$('testAlertReward').value = '';
    h.window.eval('sendTestAlert()');
    await flush();
    expect(h.callsTo('/api/alerts/test', 'POST').map(c => c.body)).toEqual([
      { alertType: 'bits', user: 'TestUser', useConfig: true, amount: 100 },
      { alertType: 'subscription', user: 'TestUser', message: 'hey', useConfig: true, tier: '2000' },
      { alertType: 'raid', user: 'TestUser', message: 'hey', useConfig: true, viewers: 50 },
      { alertType: 'redemption', user: 'TestUser', message: 'hey', useConfig: true, reward: 'Test Reward' },
    ]);
  });

  it('per-type Test Alert buttons and Test All send the canned payloads', async () => {
    const h = await boot();
    click(h.document.querySelector('button[onclick="testAlertType(\'raid\')"]')!);
    await flush();
    expect(h.callsTo('/api/alerts/test', 'POST')[0].body).toEqual({ alertType: 'raid', user: 'TestUser', useConfig: true, viewers: 50 });

    h.window.eval('testAllAlertTypes()');
    const types: unknown[] = [];
    for (let i = 0; i < 6; i++) {
      await flush();
      expect(h.timers.filter(t => t.delay === 2000)).toHaveLength(1);
      h.runTimers(2000);
    }
    await flush();
    for (const c of h.callsTo('/api/alerts/test', 'POST').slice(1)) types.push((c.body as { alertType: string }).alertType);
    expect(types).toEqual(['follow', 'subscription', 'bits', 'raid', 'redemption', 'first_chatter']);
    expect(h.callsTo('/api/alerts/test', 'POST')[2].body).toEqual({ alertType: 'subscription', user: 'TestUser', useConfig: true, tier: '1000', message: 'Test subscription message!' });
  });

  it('restartBot confirms then POSTs', async () => {
    let h = await boot({}, false);
    h.window.eval('restartBot()');
    await flush();
    expect(h.callsTo('/api/bot/restart')).toHaveLength(0);
    h = await boot({ 'POST /api/bot/restart': { ok: false, status: 500 } });
    h.window.eval('restartBot()');
    await flush();
    expect(h.callsTo('/api/bot/restart', 'POST')).toHaveLength(1);
    expect(h.alerts).toEqual(['Failed to send restart signal']);
  });

  it('generated tables carry no inline handlers', async () => {
    const h = await boot();
    for (const id of ['customCommandsList', 'builtinCommandsList', 'logsList', 'chatFeed']) {
      expect([id, h.$(id).querySelectorAll('[onclick]').length]).toEqual([id, 0]);
    }
  });

  it('escapeHtml escapes all five characters and blanks null/undefined', () => {
    const h = loadPage({ html: 'dashboard/public/index.html', script: 'dashboard/public/app.js' });
    expect(h.window.escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#039;&amp;&#039;&lt;/a&gt;');
    expect(h.window.escapeHtml(null)).toBe('');
    expect(h.window.escapeHtml(undefined)).toBe('');
    expect(h.window.escapeHtml(5)).toBe('5');
  });

  it('every inline handler in index.html refers to a global function of app.js or manage.js', () => {
    const h = loadPage({ html: 'dashboard/public/index.html', script: 'dashboard/public/app.js', extraScripts: ['dashboard/public/manage.js'] });
    const html = fs.readFileSync(path.join(REPO_ROOT, 'dashboard/public/index.html'), 'utf8');
    const names = new Set<string>();
    for (const m of html.matchAll(/\son[a-z]+="([^"]*)"/g)) {
      for (const call of m[1].matchAll(/([A-Za-z_$][\w$]*)\(/g)) names.add(call[1]);
    }
    const builtins = new Set(['parseInt', 'parseFloat', 'if']);
    for (const name of names) {
      if (builtins.has(name)) continue;
      expect([name, typeof h.window[name]]).toEqual([name, 'function']);
    }
    expect(names.size).toBeGreaterThan(20);
  });
});

describe('dashboard app: untrusted text is rendered as text (XSS)', () => {
  const EVIL = '<img src=x onerror="window.pwned=1">';

  it('WebSocket log rows escape user, command and channel', async () => {
    const h = await boot({ 'GET /api/logs': { body: [] } });
    h.sockets[0].emit({ type: 'log', data: { timestamp: 0, user: EVIL, command: `!c ${EVIL}`, channel: `<b>${EVIL}</b>`, success: true } });
    const row = h.$('logsList').querySelector('tr')!;
    expect(row.querySelector('img')).toBeNull();
    expect(row.querySelector('b')).toBeNull();
    expect(row.children[1].textContent).toBe(EVIL);
    expect(row.children[2].textContent).toBe(`!c ${EVIL}`);
    expect(row.children[3].textContent).toBe(`<b>${EVIL}</b>`);
  });

  it('WebSocket chat messages escape the user and channel', async () => {
    const h = await boot();
    h.sockets[0].emit({ type: 'chat', data: { timestamp: 0, user: EVIL, channel: '<i>chan</i>', message: 'hi' } });
    const msg = h.$('chatFeed').querySelector('.chat-message')!;
    expect(msg.querySelector('img')).toBeNull();
    expect(msg.querySelector('i')).toBeNull();
    expect(msg.querySelector('.chat-user')!.textContent).toContain(EVIL);
    expect(msg.querySelector('.chat-time')!.textContent).toContain('#<i>chan</i>');
  });

  it('poll and prediction titles and error messages are escaped', async () => {
    let h = await boot();
    h.$('pollTitle').value = EVIL;
    h.$('pollOptions').value = 'a,b';
    h.window.eval('createPoll()');
    await flush();
    expect(h.$('pollResult').querySelector('img')).toBeNull();
    expect(h.$('pollResult').textContent).toBe(`Poll created: ${EVIL}`);

    h.$('predTitle').value = EVIL;
    h.$('predOutcomes').value = 'yes,no';
    h.window.eval('createPrediction()');
    await flush();
    expect(h.$('predResult').querySelector('img')).toBeNull();
    expect(h.$('predResult').textContent).toBe(`Prediction created: ${EVIL}`);

    h = await boot({ 'POST /api/chat': { networkError: new Error(EVIL) } });
    h.$('predTitle').value = 'T';
    h.$('predOutcomes').value = 'yes,no';
    h.window.eval('createPrediction()');
    await flush();
    expect(h.$('predResult').querySelector('img')).toBeNull();
    expect(h.$('predResult').textContent).toBe(`Error: ${EVIL}`);
  });

  it('a built-in command name cannot break out of its Update button', async () => {
    const name = `!x');window.pwned=1;('`;
    const h = await boot({ 'GET /api/builtin-commands': { body: [{ name, cooldownSeconds: 1 }, { name: '!q"><img src=x>', cooldownSeconds: 2 }] } });
    const rows = h.$('builtinCommandsList').querySelectorAll('tr');
    expect(h.$('builtinCommandsList').querySelector('img')).toBeNull();
    expect(rows[0].querySelector('strong')!.textContent).toBe(name);
    // the cooldown input id keeps the raw name, so the Update handler still finds it
    expect((h.$(`cooldown-${name.replace('!', '')}`) as HTMLInputElement).value).toBe('1');
    expect((h.$('cooldown-q"><img src=x>') as HTMLInputElement).value).toBe('2');

    click(rows[0].querySelector('button')!);
    await flush();
    expect(h.window.pwned).toBeUndefined();
    const put = h.callsTo('/api/builtin-commands/', 'PUT')[0];
    expect(put.url).toBe(`/api/builtin-commands/${encodeURIComponent(name)}`);
    expect(put.body).toEqual({ cooldownSeconds: 1 });
  });

  it('a custom command name cannot break out of its Edit/Delete buttons', async () => {
    const name = `!y\\');window.pwned=1;//`;
    const h = await boot({ 'GET /api/custom-commands': { body: [{ name, response: 'r' }] } });
    const row = h.$('customCommandsList').querySelector('tr')!;
    click(row.querySelector('.btn-secondary')!);
    expect(h.$('ccName').value).toBe(name);
    click(row.querySelector('.btn-danger')!);
    await flush();
    expect(h.window.pwned).toBeUndefined();
    expect(h.confirmMock).toHaveBeenCalledWith(`Delete ${name}?`);
    expect(h.callsTo('/api/custom-commands/', 'DELETE')[0].url).toBe(`/api/custom-commands/${encodeURIComponent(name)}`);
  });
});
