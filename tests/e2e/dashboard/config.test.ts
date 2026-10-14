/**
 * E2E: the Settings page API (src/dashboard/routes/config.ts, mounted at
 * /api/config) over real HTTP against a real dashboard on a temp .env.
 * Covers secrets never leaving the server, all-or-nothing validation, read-only
 * and environment-owned keys, restart reporting, live TTS reconfiguration and
 * the CSRF guard.
 */
jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('../../../src/lib/console-timestamp', () => ({}));

import * as dotenv from 'dotenv';
import { startDashboard, silenceConsole, Dash } from './helpers';

const SECRET = 'sk-THIS-MUST-NEVER-LEAK-1234';
const ENV_FILE = [
  '# my bot',
  'TWITCH_CLIENT_ID=abc123',
  `TWITCH_CLIENT_SECRET=${SECRET}-client`,
  `TWITCH_ACCESS_TOKEN=${SECRET}-access`,
  `OPENAI_API_KEY=${SECRET}-openai`,
  'TWITCH_CHANNELS=chan_one,chan_two',
  'TWITCH_SCOPES=chat:read chat:edit',
  'COMMAND_REFRESH_INTERVAL=30',
  ''
].join('\n');

/** The parsed .env (via the real dotenv, like the bot reads it) */
const parsedEnv = (d: Dash) => jest.requireActual<typeof dotenv>('dotenv').parse(d.readEnv());

describe('dashboard /api/config', () => {
  let d: Dash;

  beforeEach(async () => {
    silenceConsole();
    // The dashboard process has .env loaded into process.env (dashboard/main.ts runs dotenv)
    const env = jest.requireActual<typeof dotenv>('dotenv').parse(ENV_FILE);
    d = await startDashboard({ envFile: ENV_FILE, env });
  });
  afterEach(async () => {
    await d.close();
  });

  const setting = (body: { settings: Array<{ key: string }> }, key: string) =>
    body.settings.find(s => s.key === key) as Record<string, unknown>;

  describe('GET', () => {
    it('lists the groups and every setting with its current value', async () => {
      const res = await d.get('/api/config');
      expect(res.status).toBe(200);
      expect(res.json.groups.map((g: { id: string }) => g.id)).toEqual(
        ['general', 'welcome', 'announcements', 'tts', 'integrations', 'twitch', 'server']
      );
      expect(setting(res.json, 'COMMAND_REFRESH_INTERVAL')).toMatchObject({ value: 30, isSet: true, applies: 'bot', readOnly: false });
      expect(setting(res.json, 'TWITCH_CHANNELS')).toMatchObject({ value: ['chan_one', 'chan_two'] });
      expect(setting(res.json, 'TWITCH_SCOPES')).toMatchObject({ value: ['chat:read', 'chat:edit'], readOnly: true });
      expect(setting(res.json, 'HYPE_ENABLED')).toMatchObject({ value: true, isSet: false, default: true });
    });

    it('never returns a secret value, only whether it is set', async () => {
      const res = await d.get('/api/config');
      expect(res.text).not.toContain(SECRET);
      expect(setting(res.json, 'TWITCH_CLIENT_SECRET')).toMatchObject({ type: 'secret', value: null, isSet: true });
      expect(setting(res.json, 'TWITCH_ACCESS_TOKEN')).toMatchObject({ value: null, isSet: true, readOnly: true });
      expect(setting(res.json, 'OPENAI_API_KEY')).toMatchObject({ value: null, isSet: true });
      expect(setting(res.json, 'ELEVENLABS_API_KEY')).toMatchObject({ value: null, isSet: false });
    });

    it('works without a .env file', async () => {
      await d.close();
      d = await startDashboard();
      const res = await d.get('/api/config');
      expect(res.status).toBe(200);
      expect(setting(res.json, 'TWITCH_CLIENT_ID')).toMatchObject({ value: null, isSet: false });
    });
  });

  describe('PUT', () => {
    it('saves values to .env, reports what changed and what must restart', async () => {
      const res = await d.put('/api/config', { values: {
        COMMAND_REFRESH_INTERVAL: 45,
        HYPE_MESSAGE: 'Chat is #1 "hype" 🔥',
        TWITCH_CHANNELS: ['chan_one', 'chan_three'],
        TTS_PROVIDER: 'openai'
      } });
      expect(res.status).toBe(200);
      expect(res.json.success).toBe(true);
      expect(res.json.changed.sort()).toEqual(['COMMAND_REFRESH_INTERVAL', 'HYPE_MESSAGE', 'TTS_PROVIDER', 'TWITCH_CHANNELS']);
      expect(res.json.restart).toEqual(['bot']);
      expect(setting(res.json, 'COMMAND_REFRESH_INTERVAL').value).toBe(45);

      const env = parsedEnv(d);
      expect(env).toMatchObject({
        COMMAND_REFRESH_INTERVAL: '45',
        HYPE_MESSAGE: 'Chat is #1 "hype" 🔥',
        TWITCH_CHANNELS: 'chan_one,chan_three',
        TTS_PROVIDER: 'openai',
        TWITCH_CLIENT_SECRET: `${SECRET}-client`
      });
      // Untouched lines (including the comment) stay where they were
      expect(d.readEnv().startsWith('# my bot\nTWITCH_CLIENT_ID=abc123\n')).toBe(true);
      // GET sees the saved values
      expect(setting((await d.get('/api/config')).json, 'HYPE_MESSAGE').value).toBe('Chat is #1 "hype" 🔥');
    });

    it('replaces a secret without ever echoing it', async () => {
      const res = await d.put('/api/config', { values: { YOUTUBE_API_KEY: 'AIza-new-key', OPENAI_API_KEY: 'sk-replaced' } });
      expect(res.status).toBe(200);
      expect(res.text).not.toContain('AIza-new-key');
      expect(res.text).not.toContain('sk-replaced');
      expect(setting(res.json, 'YOUTUBE_API_KEY')).toMatchObject({ value: null, isSet: true });
      expect(parsedEnv(d)).toMatchObject({ YOUTUBE_API_KEY: 'AIza-new-key', OPENAI_API_KEY: 'sk-replaced' });
    });

    it('null removes a key (back to its default) and clears a secret', async () => {
      const res = await d.put('/api/config', { values: { COMMAND_REFRESH_INTERVAL: null, OPENAI_API_KEY: null } });
      expect(res.json.changed.sort()).toEqual(['COMMAND_REFRESH_INTERVAL', 'OPENAI_API_KEY']);
      const env = parsedEnv(d);
      expect(env).not.toHaveProperty('COMMAND_REFRESH_INTERVAL');
      expect(env).not.toHaveProperty('OPENAI_API_KEY');
      expect(setting(res.json, 'COMMAND_REFRESH_INTERVAL')).toMatchObject({ value: null, isSet: false });
      expect(setting(res.json, 'OPENAI_API_KEY')).toMatchObject({ isSet: false });
    });

    it('turning DEBUG off removes it (the logger treats any value as on)', async () => {
      await d.put('/api/config', { values: { DEBUG: true } });
      expect(parsedEnv(d).DEBUG).toBe('true');
      const res = await d.put('/api/config', { values: { DEBUG: false } });
      expect(parsedEnv(d)).not.toHaveProperty('DEBUG');
      expect(setting(res.json, 'DEBUG').value).toBe(false);
    });

    it('saving the current values changes nothing and asks for no restart', async () => {
      const before = d.readEnv();
      const res = await d.put('/api/config', { values: { COMMAND_REFRESH_INTERVAL: 30, TWITCH_CHANNELS: 'chan_one, chan_two', HYPE_MESSAGE: null } });
      expect(res.json).toMatchObject({ success: true, changed: [], restart: [] });
      expect(d.readEnv()).toBe(before);
    });

    it('collects every process that must restart', async () => {
      const res = await d.put('/api/config', { values: { DASHBOARD_PORT: 4001, TOKEN_GENERATOR_PORT: 4000, YOUTUBE_API_KEY: 'k', TTS_VOICE_IGNORED: undefined } });
      expect(res.json.restart.sort()).toEqual(['bot', 'dashboard', 'token-generator']);
    });

    it('TTS settings apply to the running dashboard immediately', async () => {
      expect((await d.get('/api/tts/config')).json).toMatchObject({ provider: 'browser', providers: { openai: { available: true, voice: 'alloy' } } });
      const res = await d.put('/api/config', { values: { TTS_PROVIDER: 'elevenlabs', ELEVENLABS_API_KEY: 'el-key', ELEVENLABS_VOICE_ID: 'Voice123', OPENAI_TTS_VOICE: 'nova' } });
      expect(res.json.restart).toEqual([]);
      const tts = (await d.get('/api/tts/config')).json;
      expect(tts).toMatchObject({
        provider: 'elevenlabs',
        providers: { elevenlabs: { available: true, voice: 'Voice123' }, openai: { voice: 'nova' } }
      });
      expect(JSON.stringify(tts)).not.toContain('el-key');
    });

    describe('rejections leave .env untouched', () => {
      let before: string;
      beforeEach(() => {
        before = d.readEnv();
      });
      afterEach(() => {
        expect(d.readEnv()).toBe(before);
      });

      it.each([
        ['no body', undefined, 'values must be an object of setting keys'],
        ['values missing', {}, 'values must be an object of setting keys'],
        ['values is an array', { values: [['HYPE_ENABLED', true]] }, 'values must be an object of setting keys'],
        ['values is a string', { values: 'HYPE_ENABLED=true' }, 'values must be an object of setting keys'],
        ['values is null', { values: null }, 'values must be an object of setting keys'],
        ['values is empty', { values: {} }, 'values must contain at least one setting'],
        ['an unknown key', { values: { HYPE_ENABLED: false, NOT_A_SETTING: 'x' } }, 'Unknown setting: NOT_A_SETTING'],
        ['a chat filter key (owned by the Filters page)', { values: { CHAT_FILTER_URLS: 'true' } }, 'Unknown setting: CHAT_FILTER_URLS'],
        ['a prototype key', { values: { constructor: 'x' } }, 'Unknown setting: constructor'],
        ['a token', { values: { TWITCH_ACCESS_TOKEN: 'stolen' } }, 'TWITCH_ACCESS_TOKEN cannot be changed from the dashboard'],
        ['the listen address', { values: { DASHBOARD_HOST: '0.0.0.0' } }, 'DASHBOARD_HOST cannot be changed from the dashboard'],
        ['the bot secret', { values: { DASHBOARD_INTERNAL_SECRET: null } }, 'DASHBOARD_INTERNAL_SECRET cannot be changed from the dashboard'],
        ['a bad value next to good ones', { values: { HYPE_ENABLED: false, COMMAND_REFRESH_INTERVAL: 1 } }, 'Command refresh interval (COMMAND_REFRESH_INTERVAL) must be at least 5'],
        ['a line break (would add .env lines)', { values: { HYPE_MESSAGE: 'hi\nDASHBOARD_HOST=0.0.0.0' } }, 'Hype message (HYPE_MESSAGE) cannot contain line breaks'],
        ['a value that cannot be quoted', { values: { HYPE_MESSAGE: `it's "both"` } }, `HYPE_MESSAGE value cannot contain both ' and " (or ' and a backslash)`],
        ['a bad channel name', { values: { TWITCH_CHANNELS: ['good', 'bad name'] } }, 'Channels (TWITCH_CHANNELS) entries must be a Twitch username (letters, digits and underscores, up to 25 characters)'],
        ['a wrong type', { values: { HYPE_ENABLED: 'false' } }, 'Hype detector (HYPE_ENABLED) must be true or false']
      ])('%s', async (_label, body, error) => {
        const res = body === undefined ? await d.request('PUT', '/api/config') : await d.put('/api/config', body);
        expect(res.status).toBe(400);
        expect(res.json).toEqual({ success: false, error });
      });

      it('more than 100 keys', async () => {
        const values = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`K${i}`, 'x']));
        const res = await d.put('/api/config', { values });
        expect(res.status).toBe(400);
        expect(res.json.error).toBe('too many settings in one request');
      });

      it('a malformed JSON body', async () => {
        const res = await d.request('PUT', '/api/config', { raw: '{"values": {' });
        expect(res.status).toBe(400);
      });

      it('a cross-site request (CSRF)', async () => {
        const res = await d.request('PUT', '/api/config', { headers: { origin: 'http://evil.example' }, body: { values: { HYPE_ENABLED: false } } });
        expect(res.status).toBe(403);
        expect(res.json).toEqual({ error: 'Forbidden: cross-site request' });
      });
    });

    it('accepts a same-origin request from the dashboard page', async () => {
      const res = await d.request('PUT', '/api/config', {
        headers: { origin: `http://127.0.0.1:${d.port}` },
        body: { values: { HYPE_ENABLED: false } }
      });
      expect(res.status).toBe(200);
      expect(parsedEnv(d).HYPE_ENABLED).toBe('false');
    });

    it('does not need the bot secret (the page cannot hold it)', async () => {
      await d.close();
      d = await startDashboard({ envFile: ENV_FILE, env: { DASHBOARD_INTERNAL_SECRET: 's3cret' } });
      const res = await d.put('/api/config', { values: { HYPE_ENABLED: false } });
      expect(res.status).toBe(200);
    });

    it('serializes concurrent saves so none is lost', async () => {
      const keys = ['HYPE_MESSAGE', 'FIRST_CHATTER_MESSAGE', 'TTS_REWARD_TITLE', 'ELEVENLABS_MODEL'];
      const results = await Promise.all(keys.map((key, i) => d.put('/api/config', { values: { [key]: `value${i}` } })));
      for (const res of results) expect(res.status).toBe(200);
      const env = parsedEnv(d);
      keys.forEach((key, i) => expect(env[key]).toBe(`value${i}`));
    });
  });
});

describe('dashboard /api/config: keys set by the system environment', () => {
  let d: Dash;
  beforeEach(async () => {
    silenceConsole();
    // e.g. docker-compose passes TWITCH_CLIENT_ID; .env says something else (dotenv never overrides it)
    d = await startDashboard({
      envFile: 'TWITCH_CLIENT_ID=fromfile\n',
      env: { TWITCH_CLIENT_ID: 'fromdocker', YOUTUBE_API_KEY: 'docker-yt-key' }
    });
  });
  afterEach(async () => {
    await d.close();
  });

  it('flags them and reports the value that is really in effect', async () => {
    const res = await d.get('/api/config');
    expect(res.json.settings.find((s: { key: string }) => s.key === 'TWITCH_CLIENT_ID')).toMatchObject({ value: 'fromdocker', fromEnvironment: true });
    expect(res.json.settings.find((s: { key: string }) => s.key === 'YOUTUBE_API_KEY')).toMatchObject({ value: null, isSet: true, fromEnvironment: true });
    expect(res.text).not.toContain('docker-yt-key');
  });

  it('refuses to edit them, since the .env change would be ignored', async () => {
    const res = await d.put('/api/config', { values: { TWITCH_CLIENT_ID: 'newid' } });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/TWITCH_CLIENT_ID is set by the system environment/);
    expect(d.readEnv()).toBe('TWITCH_CLIENT_ID=fromfile\n');
  });

  it('still edits other keys', async () => {
    const res = await d.put('/api/config', { values: { HYPE_ENABLED: false } });
    expect(res.status).toBe(200);
    expect(res.json.settings.find((s: { key: string }) => s.key === 'HYPE_ENABLED')).toMatchObject({ value: false, fromEnvironment: false });
  });
});

describe('dashboard /api/config: environment keys captured at startup (dashboard/main.ts)', () => {
  let d: Dash;
  beforeEach(async () => {
    silenceConsole();
    d = await startDashboard({
      envFile: 'TWITCH_CLIENT_ID=same\nHYPE_MESSAGE=old\n',
      env: { TWITCH_CLIENT_ID: 'same', HYPE_MESSAGE: 'old' },
      environmentKeys: ['TWITCH_CLIENT_ID']
    });
  });
  afterEach(async () => {
    await d.close();
  });

  it('locks a captured key even when .env holds the same value', async () => {
    const res = await d.get('/api/config');
    expect(res.json.settings.find((s: { key: string }) => s.key === 'TWITCH_CLIENT_ID')).toMatchObject({ fromEnvironment: true });
    expect((await d.put('/api/config', { values: { TWITCH_CLIENT_ID: 'other' } })).status).toBe(400);
  });

  it('a hand edit of .env while the dashboard runs does not lock the key', async () => {
    require('fs').writeFileSync(d.envPath, 'TWITCH_CLIENT_ID=same\nHYPE_MESSAGE=edited by hand\n');
    const res = await d.get('/api/config');
    expect(res.json.settings.find((s: { key: string }) => s.key === 'HYPE_MESSAGE')).toMatchObject({ value: 'edited by hand', fromEnvironment: false });
    expect((await d.put('/api/config', { values: { HYPE_MESSAGE: 'from the page' } })).status).toBe(200);
    expect(d.readEnv()).toBe('TWITCH_CLIENT_ID=same\nHYPE_MESSAGE=from the page\n');
  });
});
