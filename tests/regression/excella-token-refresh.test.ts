/**
 * Loads the real bot entry point (src/bot/main) with Twitch and the dashboard faked at the HTTP
 * and IRC edges, then drives its token lifecycle with fake timers.
 *
 * Regression: after the first proactive refresh, the bot (then Excella.js) never refreshed
 * again (a stuck "refresh in progress" flag), so the bot token expired a few
 * hours into a stream.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const HOUR = 3600 * 1000;
const LEAD = 5 * 60 * 1000;

interface FakeState {
  /** access token -> expiry epoch ms */
  live: Map<string, number>;
  issued: number;
  tokenPosts: URLSearchParams[];
  rejectRefresh: boolean;
}

const fake: FakeState = { live: new Map(), issued: 0, tokenPosts: [], rejectRefresh: false };
const ircInstances: Array<{ updateToken: jest.Mock; connect: jest.Mock; accessToken: string }> = [];

function httpError(status: number, message: string) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { status, message } }
  });
}

function tokenFrom(config?: { headers?: Record<string, string> }) {
  return String(config?.headers?.Authorization || '').replace(/^(OAuth|Bearer) /, '');
}

async function fakeGet(url: string, config?: { headers?: Record<string, string>; params?: Record<string, string> }) {
  if (url.endsWith('/oauth2/validate')) {
    const expiresAt = fake.live.get(tokenFrom(config));
    if (!expiresAt || expiresAt <= Date.now()) throw httpError(401, 'invalid access token');
    return {
      data: {
        client_id: 'cid', login: 'excella_bot', user_id: '42', scopes: ['chat:read', 'chat:edit'],
        expires_in: Math.floor((expiresAt - Date.now()) / 1000)
      }
    };
  }
  if (url === '/users') {
    return { data: { data: [{ id: config?.params?.id || '1001', login: 'caster', display_name: 'Caster' }] } };
  }
  // Dashboard endpoints: empty lists and configs
  return { data: [] };
}

async function fakePost(url: string, body?: unknown) {
  if (url.endsWith('/oauth2/token')) {
    const params = new URLSearchParams(String(body));
    fake.tokenPosts.push(params);
    if (fake.rejectRefresh) throw httpError(400, 'Invalid refresh token');
    fake.issued += 1;
    const access = `access-${fake.issued}`;
    fake.live.set(access, Date.now() + 4 * HOUR);
    return {
      data: { access_token: access, refresh_token: `refresh-${fake.issued}`, expires_in: 4 * 3600, scope: ['chat:read', 'chat:edit'] }
    };
  }
  return { data: { success: true } };
}

jest.mock('axios', () => {
  const instance = () => {
    const inst: Record<string, unknown> = {
      get: jest.fn((url: string, cfg?: object) => fakeGet(url, cfg as never)),
      post: jest.fn((url: string, body?: unknown) => fakePost(url, body)),
      put: jest.fn(async () => ({ data: { success: true } })),
      delete: jest.fn(async () => ({ data: { success: true } })),
      interceptors: { response: { use: jest.fn() } },
      defaults: {}
    };
    return inst;
  };
  const axios = instance();
  axios.create = jest.fn(() => instance());
  return { __esModule: false, ...axios, default: axios };
});

jest.mock('dotenv', () => ({ config: jest.fn() }));

// The bot imports the TypeScript clients directly (src/bot/main.ts), so mock those modules
jest.mock('../../src/lib/twitch-irc-client', () => ({
  TwitchIRCClient: jest.fn().mockImplementation((opts: { accessToken: string }) => {
    const client = {
      accessToken: opts.accessToken,
      onMessage: jest.fn(),
      onConnect: jest.fn(),
      onDisconnect: jest.fn(),
      connect: jest.fn(async () => true),
      say: jest.fn(),
      updateToken: jest.fn(async (t: string) => { client.accessToken = t; })
    };
    ircInstances.push(client);
    return client;
  })
}));

jest.mock('../../src/lib/twitch-eventsub-ws', () => ({ TwitchEventSubWS: jest.fn() }));
jest.mock('../../src/lib/console-timestamp', () => ({}));

describe('bot token lifecycle (src/bot/main)', () => {
  let dir: string;
  let envPath: string;
  const savedEnv = { ...process.env };
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    // restoreMocks resets spies between tests, so install this one per test
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    fake.live.clear();
    fake.issued = 0;
    fake.tokenPosts = [];
    fake.rejectRefresh = false;
    ircInstances.length = 0;

    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'excella-token-'));
    envPath = path.join(dir, '.env');
    fs.writeFileSync(envPath, 'TWITCH_ACCESS_TOKEN=access-0\nTWITCH_REFRESH_TOKEN=refresh-0\n');
    Object.assign(process.env, {
      TWITCH_CLIENT_ID: 'cid',
      TWITCH_CLIENT_SECRET: 'secret',
      TWITCH_ACCESS_TOKEN: 'access-0',
      TWITCH_REFRESH_TOKEN: 'refresh-0',
      TWITCH_BROADCASTER_NAME: 'caster',
      TWITCH_CHANNELS: 'caster',
      TWITCH_SCOPES: 'chat:read chat:edit',
      ENV_PATH: envPath,
      BACKUP_DIR: path.join(dir, 'backups'),
      DISABLE_EVENTSUB: '1'
    });
    delete process.env.TWITCH_BROADCASTER_ACCESS_TOKEN;
    delete process.env.TWITCH_BROADCASTER_REFRESH_TOKEN;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    process.env = { ...savedEnv };
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Let pending work settle: zero-delay fake timers plus real I/O (the .env
   * write), which fake timers alone don't wait for. Gives up after ~1000 rounds.
   */
  async function waitFor(done: () => boolean) {
    for (let i = 0; i < 1000 && !done(); i++) {
      await jest.advanceTimersByTimeAsync(0);
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  async function startBot() {
    jest.isolateModules(() => {
      require('../../src/bot/main');
    });
    // Let start() run through validation, init and connect (or exit)
    await waitFor(() => ircInstances[0]?.connect.mock.calls.length > 0 || exitSpy.mock.calls.length > 0);
  }

  const envValue = (key: string) =>
    fs.readFileSync(envPath, 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1];

  it('keeps refreshing the bot token every cycle and applies it to IRC and .env', async () => {
    fake.live.set('access-0', Date.now() + 4 * HOUR);
    await startBot();
    const irc = ircInstances[0];
    expect(irc.connect).toHaveBeenCalled();
    expect(fake.tokenPosts).toHaveLength(0);

    for (let cycle = 1; cycle <= 3; cycle++) {
      await jest.advanceTimersByTimeAsync(4 * HOUR - LEAD);
      await waitFor(() => envValue('TWITCH_ACCESS_TOKEN') === `access-${cycle}` && irc.updateToken.mock.calls.length === cycle);
      expect(fake.tokenPosts).toHaveLength(cycle);
      expect(fake.tokenPosts[cycle - 1].get('refresh_token')).toBe(`refresh-${cycle - 1}`);
      expect(irc.updateToken).toHaveBeenLastCalledWith(`access-${cycle}`);
      expect(envValue('TWITCH_ACCESS_TOKEN')).toBe(`access-${cycle}`);
      expect(envValue('TWITCH_REFRESH_TOKEN')).toBe(`refresh-${cycle}`);
      expect(process.env.TWITCH_ACCESS_TOKEN).toBe(`access-${cycle}`);
    }
  });

  it('refreshes an already-expired token at startup before connecting', async () => {
    await startBot();
    const irc = ircInstances[0];

    expect(fake.tokenPosts).toHaveLength(1);
    expect(irc.updateToken).toHaveBeenCalledWith('access-1');
    expect(irc.connect).toHaveBeenCalled();
    expect(irc.updateToken.mock.invocationCallOrder[0]).toBeLessThan(irc.connect.mock.invocationCallOrder[0]);
    expect(envValue('TWITCH_ACCESS_TOKEN')).toBe('access-1');
  });

  it('exits with a clear message when the expired token cannot be refreshed', async () => {
    fake.rejectRefresh = true;
    await startBot();

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errors = (console.error as jest.Mock).mock.calls.flat().join('\n');
    expect(errors).toContain('Invalid refresh token (HTTP 400)');
    expect(errors).toContain('Failed to refresh bot token');
    expect(envValue('TWITCH_ACCESS_TOKEN')).toBe('access-0');
  });
});
