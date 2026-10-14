/**
 * Characterization: dashboard/routes/api.js (mounted at /api)
 */
jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('../../../src/lib/console-timestamp', () => ({}));

import * as fs from 'fs';
import * as path from 'path';
import { startDashboard, openWs, silenceConsole, externalIPv4, httpRequest, Dash } from './helpers';

describe('dashboard /api', () => {
  let d: Dash;
  beforeEach(async () => {
    silenceConsole();
    d = await startDashboard();
  });
  afterEach(async () => {
    await d.close();
  });

  describe('GET /api/status', () => {
    it('returns the initial bot state', async () => {
      const res = await d.get('/api/status');
      expect(res.status).toBe(200);
      expect(res.json).toEqual({
        isConnected: false,
        channels: [],
        broadcasterName: '',
        uptime: 0,
        commandsExecuted: 0,
        lastCommand: null,
        commands: [
          { name: '!clip', description: 'Create a clip of the stream' },
          { name: '!followage [username]', description: 'Check how long someone has been following' },
          { name: '!shoutout [username]', description: 'Shout out another streamer (mods only)' },
          { name: '!commands', description: 'Show available commands' }
        ]
      });
    });

    it('POST /api/update-state merges into the state and broadcasts it', async () => {
      const ws = await openWs(d);
      const since = ws.messages.length;
      const res = await d.post('/api/update-state', { isConnected: true, channels: ['#caster'], extra: 1 });
      expect(res.json).toEqual({ success: true });
      const status = (await d.get('/api/status')).json;
      expect(status).toMatchObject({ isConnected: true, channels: ['#caster'], extra: 1, uptime: 0 });
      const msg = await ws.waitFor('state', since);
      expect(msg.data).toMatchObject({ isConnected: true, extra: 1 });
      ws.close();
    });
  });

  describe('command logs', () => {
    it('GET /api/logs starts empty', async () => {
      const res = await d.get('/api/logs');
      expect(res.status).toBe(200);
      expect(res.json).toEqual([]);
    });

    it('POST /api/logs appends to commands.json, bumps commandsExecuted and broadcasts', async () => {
      const ws = await openWs(d);
      const since = ws.messages.length;
      const res = await d.post('/api/logs', { user: 'viewer1', command: '!dice', channel: '#caster' });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ success: true });

      const logs = d.readJson('commands.json');
      expect(logs).toHaveLength(1);
      expect(logs[0]).toEqual({
        timestamp: expect.any(String),
        user: 'viewer1',
        command: '!dice',
        channel: '#caster',
        success: true
      });

      await d.post('/api/logs', { user: 'viewer2', command: '!clip', success: false });
      const logs2 = d.readJson('commands.json');
      expect(logs2[1]).toMatchObject({ user: 'viewer2', success: false });
      // channel omitted -> key dropped by JSON.stringify
      expect('channel' in logs2[1]).toBe(false);

      const status = (await d.get('/api/status')).json;
      expect(status.commandsExecuted).toBe(2);
      expect(status.lastCommand).toMatchObject({ user: 'viewer2', command: '!clip' });

      const logMsg = await ws.waitFor('log', since);
      expect(logMsg.data).toMatchObject({ user: 'viewer1', command: '!dice' });
      ws.close();
    });

    it('POST /api/logs validates required string fields', async () => {
      const missing = await d.post('/api/logs', { command: '!x' });
      expect(missing.status).toBe(400);
      expect(missing.json).toEqual({ success: false, error: 'user is required' });

      const empty = await d.post('/api/logs', { user: '', command: '!x' });
      expect(empty.status).toBe(400);
      expect(empty.json.error).toBe('user is required');

      const wrongType = await d.post('/api/logs', { user: 5, command: '!x' });
      expect(wrongType.status).toBe(400);
      expect(wrongType.json).toEqual({ success: false, error: 'user must be a string' });

      expect(d.readJson('commands.json')).toEqual([]);
    });

    it('POST /api/logs without a body is a 400', async () => {
      const res = await d.request('POST', '/api/logs');
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ success: false, error: 'user is required' });
    });

    it('keeps at most 1000 log entries, dropping the oldest', async () => {
      const seeded = Array.from({ length: 1000 }, (_, i) => ({ timestamp: 't', user: `u${i}`, command: '!x', success: true }));
      d.writeJson('commands.json', seeded);
      await d.post('/api/logs', { user: 'newest', command: '!y' });
      const logs = d.readJson('commands.json');
      expect(logs).toHaveLength(1000);
      expect(logs[0].user).toBe('u1');
      expect(logs[999].user).toBe('newest');
    });

    it('DELETE /api/logs clears the file', async () => {
      await d.post('/api/logs', { user: 'a', command: '!b' });
      const res = await d.del('/api/logs');
      expect(res.json).toEqual({ success: true });
      expect(d.readJson('commands.json')).toEqual([]);
    });

    it('concurrent POST /api/logs keeps every entry (file lock)', async () => {
      await Promise.all(Array.from({ length: 15 }, (_, i) => d.post('/api/logs', { user: `u${i}`, command: '!c' })));
      const logs = d.readJson('commands.json');
      expect(logs).toHaveLength(15);
      expect(new Set(logs.map((l: { user: string }) => l.user)).size).toBe(15);
    });
  });

  describe('user stats', () => {
    it('GET /api/stats starts as an empty object', async () => {
      expect((await d.get('/api/stats')).json).toEqual({});
    });

    it('POST /api/stats/:username creates and increments a lowercased entry', async () => {
      const ws = await openWs(d);
      const since = ws.messages.length;
      expect((await d.post('/api/stats/Viewer1')).json).toEqual({ success: true });
      await d.post('/api/stats/viewer1');
      const stats = d.readJson('stats.json');
      expect(Object.keys(stats)).toEqual(['viewer1']);
      expect(stats.viewer1).toEqual({ commands: 2, firstSeen: expect.any(String), lastCommand: expect.any(String) });
      const msg = await ws.waitFor('stats', since);
      expect(msg.data.viewer1.commands).toBeGreaterThanOrEqual(1);
      ws.close();
    });

    it('concurrent POST /api/stats/:username does not lose increments (file lock)', async () => {
      await Promise.all(Array.from({ length: 12 }, () => d.post('/api/stats/racer')));
      expect(d.readJson('stats.json').racer.commands).toBe(12);
    });
  });

  describe('custom commands', () => {
    it('GET starts empty', async () => {
      expect((await d.get('/api/custom-commands')).json).toEqual([]);
    });

    it('POST normalizes the command and defaults level/cooldown', async () => {
      const ws = await openWs(d);
      const since = ws.messages.length;
      const res = await d.post('/api/custom-commands', { name: '  !Hello ', response: '  Hi there  ', level: 'superuser', cooldownSeconds: -5 });
      expect(res.json).toEqual({ success: true });
      expect(d.readJson('customCommands.json')).toEqual([
        { name: '!hello', response: 'Hi there', level: 'everyone', fetchEnabled: false, fetchUrl: '', cooldownSeconds: 0 }
      ]);
      const msg = await ws.waitFor('customCommands', since);
      expect(msg.data).toHaveLength(1);
      ws.close();
    });

    it('POST keeps valid level, numeric-string cooldown and fetch settings; same name replaces', async () => {
      await d.post('/api/custom-commands', { name: '!a', response: 'one' });
      await d.post('/api/custom-commands', { name: '!b', response: 'two' });
      await d.post('/api/custom-commands', { name: '!A', response: 'uno', level: 'mod', cooldownSeconds: '10', fetchEnabled: 1, fetchUrl: ' http://x ' });
      expect(d.readJson('customCommands.json')).toEqual([
        { name: '!b', response: 'two', level: 'everyone', fetchEnabled: false, fetchUrl: '', cooldownSeconds: 0 },
        { name: '!a', response: 'uno', level: 'mod', fetchEnabled: true, fetchUrl: 'http://x', cooldownSeconds: 10 }
      ]);
    });

    it('POST prefixes a missing ! and rejects names that are not a single word', async () => {
      expect((await d.post('/api/custom-commands', { name: 'plain', response: 'r' })).status).toBe(200);
      expect(d.readJson('customCommands.json')[0].name).toBe('!plain');
      for (const name of ['!', '!two words', 'two words']) {
        const res = await d.post('/api/custom-commands', { name, response: 'r' });
        expect(res.status).toBe(400);
        expect(res.json).toEqual({ success: false, error: 'Command name must be a single word, e.g. !discord' });
      }
      expect(d.readJson('customCommands.json')).toHaveLength(1);
    });

    it('POST validates required fields', async () => {
      const res = await d.post('/api/custom-commands', { name: '!x' });
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ success: false, error: 'response is required' });
      const res2 = await d.post('/api/custom-commands', { name: ['!x'], response: 'r' });
      expect(res2.status).toBe(400);
      expect(res2.json.error).toBe('name must be a string');
    });

    it('DELETE matches with or without the ! prefix; unknown names still succeed', async () => {
      await d.post('/api/custom-commands', { name: '!a', response: 'r' });
      await d.post('/api/custom-commands', { name: '!b', response: 'r' });
      expect((await d.del('/api/custom-commands/A')).json).toEqual({ success: true });
      expect(d.readJson('customCommands.json').map((c: { name: string }) => c.name)).toEqual(['!b']);
      expect((await d.del('/api/custom-commands/!b')).json).toEqual({ success: true });
      expect(d.readJson('customCommands.json')).toEqual([]);
      const missing = await d.del('/api/custom-commands/nope');
      expect(missing.status).toBe(200);
      expect(missing.json).toEqual({ success: true });
    });
  });

  describe('built-in commands', () => {
    it('GET returns the default list written by init()', async () => {
      const res = await d.get('/api/builtin-commands');
      expect(res.status).toBe(200);
      expect(res.json).toHaveLength(34);
      expect(res.json[0]).toEqual({ name: '!clip', cooldownSeconds: 60, description: 'Create a clip of the current stream', permission: 'Everyone' });
      expect(res.json.map((c: { name: string }) => c.name)).toContain('!hype');
    });

    it('PUT /:name updates cooldown (name is lowercased)', async () => {
      const ws = await openWs(d);
      const since = ws.messages.length;
      const res = await d.put('/api/builtin-commands/!CLIP', { cooldownSeconds: 3 });
      expect(res.status).toBe(200);
      expect(res.json.success).toBe(true);
      expect(res.json.commands.find((c: { name: string }) => c.name === '!clip').cooldownSeconds).toBe(3);
      expect(d.readJson('builtinCommands.json')[0].cooldownSeconds).toBe(3);
      await ws.waitFor('builtinCommands', since);
      ws.close();
    });

    it('PUT for an unknown command succeeds without changing the file', async () => {
      const before = fs.readFileSync(d.paths.builtinCommandsFile, 'utf8');
      const res = await d.put('/api/builtin-commands/!nope', { cooldownSeconds: 3 });
      expect(res.status).toBe(200);
      expect(res.json.success).toBe(true);
      expect(fs.readFileSync(d.paths.builtinCommandsFile, 'utf8')).toBe(before);
    });

    it('PUT without ! prefix is a 400', async () => {
      const res = await d.put('/api/builtin-commands/clip', { cooldownSeconds: 3 });
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ success: false, error: 'Command name must start with !' });
    });

    it('PUT validates cooldownSeconds type and minimum', async () => {
      const neg = await d.put('/api/builtin-commands/!clip', { cooldownSeconds: -1 });
      expect(neg.status).toBe(400);
      expect(neg.json.error).toBe('cooldownSeconds must be at least 0');
      const str = await d.put('/api/builtin-commands/!clip', { cooldownSeconds: '5' });
      expect(str.status).toBe(400);
      expect(str.json.error).toBe('cooldownSeconds must be a number');
    });

    it('PUT without cooldownSeconds is a 400 and keeps the stored cooldown', async () => {
      const before = fs.readFileSync(d.paths.builtinCommandsFile, 'utf8');
      for (const body of [{}, { cooldownSeconds: null }]) {
        const res = await d.put('/api/builtin-commands/!clip', body);
        expect(res.status).toBe(400);
        expect(res.json).toEqual({ success: false, error: 'cooldownSeconds is required' });
      }
      expect((await d.request('PUT', '/api/builtin-commands/!clip')).status).toBe(400);
      expect(fs.readFileSync(d.paths.builtinCommandsFile, 'utf8')).toBe(before);
      expect(d.readJson('builtinCommands.json')[0]).toMatchObject({ name: '!clip', cooldownSeconds: 60 });
    });
  });

  describe('POST /api/chat', () => {
    it('broadcasts the chat message', async () => {
      const ws = await openWs(d);
      const since = ws.messages.length;
      const res = await d.post('/api/chat', { message: 'hi', user: 'v', channel: '#c' });
      expect(res.json).toEqual({ success: true });
      const msg = await ws.waitFor('chat', since);
      expect(msg.data).toEqual({ timestamp: expect.any(String), channel: '#c', user: 'v', message: 'hi' });
      ws.close();
    });

    it('requires a message', async () => {
      const res = await d.post('/api/chat', { user: 'v' });
      expect(res.status).toBe(400);
      expect(res.json.error).toBe('message is required');
    });
  });

  describe('redemptions', () => {
    it('POST logs a redemption with a timestamp and broadcasts the raw body', async () => {
      const ws = await openWs(d);
      const since = ws.messages.length;
      const res = await d.post('/api/redemptions', { user: 'v', reward: 'Hydrate', cost: 100 });
      expect(res.json).toEqual({ success: true });
      expect((await d.get('/api/redemptions')).json).toEqual([
        { user: 'v', reward: 'Hydrate', cost: 100, timestamp: expect.any(String) }
      ]);
      const msg = await ws.waitFor('redemption', since);
      expect(msg.data).toEqual({ user: 'v', reward: 'Hydrate', cost: 100 });
      ws.close();
    });

    it('validates user and reward', async () => {
      const res = await d.post('/api/redemptions', { user: 'v' });
      expect(res.status).toBe(400);
      expect(res.json.error).toBe('reward is required');
    });

    it('keeps at most 100 entries', async () => {
      d.writeJson('redemptions.json', Array.from({ length: 100 }, (_, i) => ({ user: `u${i}`, reward: 'r' })));
      await d.post('/api/redemptions', { user: 'last', reward: 'r' });
      const list = d.readJson('redemptions.json');
      expect(list).toHaveLength(100);
      expect(list[0].user).toBe('u1');
      expect(list[99].user).toBe('last');
    });
  });

  describe('eventsub events', () => {
    it('POST logs the event and broadcasts eventsub-event', async () => {
      const ws = await openWs(d);
      const since = ws.messages.length;
      await d.post('/api/eventsub-events', { type: 'channel.follow', user: 'f' });
      expect((await d.get('/api/eventsub-events')).json).toEqual([
        { type: 'channel.follow', user: 'f', timestamp: expect.any(String) }
      ]);
      const msg = await ws.waitFor('eventsub-event', since);
      expect(msg.data).toEqual({ type: 'channel.follow', user: 'f' });
      ws.close();
    });

    it('requires type and caps at 100 entries', async () => {
      const bad = await d.post('/api/eventsub-events', { user: 'f' });
      expect(bad.status).toBe(400);
      expect(bad.json.error).toBe('type is required');
      d.writeJson('eventsub-events.json', Array.from({ length: 100 }, (_, i) => ({ type: 't', n: i })));
      await d.post('/api/eventsub-events', { type: 'new' });
      const list = d.readJson('eventsub-events.json');
      expect(list).toHaveLength(100);
      expect(list[0].n).toBe(1);
      expect(list[99].type).toBe('new');
    });
  });

  describe('announcements', () => {
    it('POST writes announcements.json and ANNOUNCEMENTS in .env, then broadcasts', async () => {
      const ws = await openWs(d);
      const since = ws.messages.length;
      const res = await d.post('/api/announcements', { announcements: ['Follow!', 'Hydrate'] });
      expect(res.json).toEqual({ success: true });
      expect((await d.get('/api/announcements')).json).toEqual(['Follow!', 'Hydrate']);
      expect(d.readEnv()).toBe('ANNOUNCEMENTS=Follow!|Hydrate\n');
      const msg = await ws.waitFor('announcements', since);
      expect(msg.data).toEqual(['Follow!', 'Hydrate']);
      ws.close();
    });

    it('validates announcements is present and an object', async () => {
      const missing = await d.post('/api/announcements', {});
      expect(missing.status).toBe(400);
      expect(missing.json.error).toBe('announcements is required');
      const str = await d.post('/api/announcements', { announcements: 'a|b' });
      expect(str.status).toBe(400);
      expect(str.json.error).toBe('announcements must be a object');
    });

    it.each([
      ['a non-array object', { a: 1 }, 'announcements must be an array of strings'],
      ['an array with a non-string', ['ok', 5], 'announcements must be an array of strings'],
      ['a line break (would inject .env lines)', ['ok', 'two\nINJECTED=1'], 'announcements cannot contain line breaks']
    ])('rejects %s with 400 before writing anything', async (_label, announcements, error) => {
      const before = fs.readFileSync(d.paths.announcementsFile, 'utf8');
      const res = await d.post('/api/announcements', { announcements });
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ success: false, error });
      expect(fs.readFileSync(d.paths.announcementsFile, 'utf8')).toBe(before);
      expect(fs.existsSync(d.envPath)).toBe(false);
    });

    it('writes "$&"-style text literally to .env', async () => {
      fs.writeFileSync(d.envPath, 'ANNOUNCEMENTS=old\n');
      await d.post('/api/announcements', { announcements: ['Win $& prizes', 'x $1'] });
      expect(d.readEnv()).toBe('ANNOUNCEMENTS=Win $& prizes|x $1\n');
    });
  });

  describe('settings', () => {
    it('GET defaults commandRefreshInterval to 60', async () => {
      expect((await d.get('/api/settings')).json).toEqual({ commandRefreshInterval: 60 });
    });

    it('POST updates .env (keeping other lines) and process.env', async () => {
      fs.writeFileSync(d.envPath, 'FOO=bar\nCOMMAND_REFRESH_INTERVAL=60\nBAZ=1');
      const res = await d.post('/api/settings', { commandRefreshInterval: 30 });
      expect(res.json).toEqual({ success: true });
      expect(d.readEnv()).toBe('FOO=bar\nCOMMAND_REFRESH_INTERVAL=30\nBAZ=1');
      expect(process.env.COMMAND_REFRESH_INTERVAL).toBe('30');
      expect((await d.get('/api/settings')).json).toEqual({ commandRefreshInterval: 30 });
    });

    it('POST appends the key when .env lacks it', async () => {
      fs.writeFileSync(d.envPath, 'FOO=bar\n\n');
      await d.post('/api/settings', { commandRefreshInterval: 5 });
      expect(d.readEnv()).toBe('FOO=bar\nCOMMAND_REFRESH_INTERVAL=5\n');
    });

    it('POST validates the interval', async () => {
      const low = await d.post('/api/settings', { commandRefreshInterval: 4 });
      expect(low.status).toBe(400);
      expect(low.json.error).toBe('commandRefreshInterval must be at least 5');
      const str = await d.post('/api/settings', { commandRefreshInterval: '30' });
      expect(str.status).toBe(400);
      expect(str.json.error).toBe('commandRefreshInterval must be a number');
      expect(fs.existsSync(d.envPath)).toBe(false);
    });
  });

  it('POST /api/bot/restart writes restart.flag next to the logs', async () => {
    const res = await d.post('/api/bot/restart');
    expect(res.json).toEqual({ success: true, message: 'Restart signal sent' });
    const flag = fs.readFileSync(path.join(d.logsDir, 'restart.flag'), 'utf8');
    expect(flag).toMatch(/^\d+$/);
  });

  describe('POST /api/test-alert', () => {
    it('defaults to a follow alert from TestUser and broadcasts it', async () => {
      const ws = await openWs(d);
      const since = ws.messages.length;
      const res = await d.post('/api/test-alert', {});
      expect(res.json).toEqual({ success: true, alert: { alertType: 'follow', user: 'TestUser', timestamp: expect.any(String) } });
      const msg = await ws.waitFor('alert', since);
      expect(msg.data.alertType).toBe('follow');
      ws.close();
    });

    it('only keeps type-specific fields for the matching type', async () => {
      const bits = await d.post('/api/test-alert', { alertType: 'bits', amount: '250', tier: '2000', viewers: 5, message: 'm', useBrowserTTS: false, audioUrl: null });
      expect(bits.json.alert).toEqual({
        alertType: 'bits', user: 'TestUser', timestamp: expect.any(String),
        message: 'm', amount: 250, audioUrl: null, useBrowserTTS: false
      });
      const sub = await d.post('/api/test-alert', { alertType: 'subscription', tier: '2000', config: { a: 1 } });
      expect(sub.json.alert).toMatchObject({ tier: '2000', config: { a: 1 } });
      const raid = await d.post('/api/test-alert', { alertType: 'raid', viewers: '12' });
      expect(raid.json.alert.viewers).toBe(12);
      const red = await d.post('/api/test-alert', { alertType: 'redemption', reward: 'R' });
      expect(red.json.alert.reward).toBe('R');
    });

    it('without a body sends the default follow test alert', async () => {
      const res = await d.request('POST', '/api/test-alert');
      expect(res.status).toBe(200);
      expect(res.json.alert).toEqual({ alertType: 'follow', user: 'TestUser', timestamp: expect.any(String) });
    });
  });

  describe('POST /api/hype/trigger', () => {
    it('broadcasts the bot\'s hype event to the dashboard and overlays', async () => {
      const ws = await openWs(d);
      const since = ws.messages.length;
      const res = await d.post('/api/hype/trigger', { channel: '#chan', count: 25, threshold: 20, windowSec: 60 });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ success: true });
      const msg = await ws.waitFor('hype', since);
      expect(msg.data).toEqual({ channel: '#chan', count: 25, threshold: 20, windowSec: 60, timestamp: expect.any(String) });
      ws.close();
    });

    it('drops non-numeric optional fields', async () => {
      const ws = await openWs(d);
      const since = ws.messages.length;
      await d.post('/api/hype/trigger', { channel: '#chan', count: 3, threshold: 'x' });
      expect((await ws.waitFor('hype', since)).data).toEqual({ channel: '#chan', count: 3, timestamp: expect.any(String) });
      ws.close();
    });

    it('validates channel and count (400, nothing broadcast)', async () => {
      expect((await d.request('POST', '/api/hype/trigger')).json).toEqual({ success: false, error: 'channel is required' });
      const bad = await d.post('/api/hype/trigger', { channel: '#c', count: '5' });
      expect(bad.status).toBe(400);
      expect(bad.json.error).toBe('count must be a number');
      expect((await d.post('/api/hype/trigger', { channel: '#c', count: -1 })).status).toBe(400);
    });
  });

  describe('TTS', () => {
    it('GET /api/tts/config reports the browser provider when no keys are configured', async () => {
      expect((await d.get('/api/tts/config')).json).toEqual({
        provider: 'browser',
        cacheEnabled: true,
        cacheSize: 0,
        cacheCount: 0,
        providers: {
          elevenlabs: { available: false, voice: 'EXAVITQu4vr4xnSDxMaL', model: 'eleven_monolingual_v1' },
          openai: { available: false, voice: 'alloy', model: 'tts-1' },
          browser: { available: true }
        }
      });
    });

    it('POST /api/tts/generate validates text', async () => {
      const none = await d.post('/api/tts/generate', {});
      expect(none.status).toBe(400);
      expect(none.json).toEqual({ success: false, error: 'Text is required' });
      const blank = await d.post('/api/tts/generate', { text: '   ' });
      expect(blank.status).toBe(400);
      const long = await d.post('/api/tts/generate', { text: 'x'.repeat(201) });
      expect(long.status).toBe(400);
      expect(long.json).toEqual({ success: false, error: 'Text too long (max 200 characters)' });
    });

    it('POST /api/tts/generate with the browser provider tells the client to speak it', async () => {
      const res = await d.post('/api/tts/generate', { text: 'x'.repeat(200) });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ success: true, provider: 'browser', useBrowserTTS: true });
    });

    it('GET /api/tts/audio/:filename validates the name and 404s on missing files', async () => {
      const bad = await d.get('/api/tts/audio/evil.mp3');
      expect(bad.status).toBe(400);
      expect(bad.json).toEqual({ success: false, error: 'Invalid filename' });
      const missing = await d.get(`/api/tts/audio/${'a'.repeat(64)}.mp3`);
      expect(missing.status).toBe(404);
      expect(missing.json).toEqual({ success: false, error: 'Audio file not found' });
    });
  });
});

const EXTERNAL_IP = externalIPv4();
(EXTERNAL_IP ? describe : describe.skip)('dashboard /api from a non-localhost address', () => {
  let d: Dash;
  beforeEach(async () => {
    silenceConsole();
    d = await startDashboard({ listenHost: '0.0.0.0' });
  });
  afterEach(async () => {
    await d.close();
  });

  it('POST /api/tts/generate is restricted to localhost', async () => {
    const res = await httpRequest(d.port, 'POST', '/api/tts/generate', { host: EXTERNAL_IP as string, body: { text: 'hi' } });
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ success: false, error: 'TTS generation restricted to localhost' });
  });
});
