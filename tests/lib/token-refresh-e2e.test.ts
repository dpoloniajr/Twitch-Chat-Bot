/**
 * End-to-end token refresh: a local HTTP server stands in for Twitch's OAuth
 * and Helix endpoints, and the real TokenManager, TwitchHelixAPI (axios) and
 * EnvManager run against it with a temporary .env file.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';

/* eslint-disable @typescript-eslint/no-require-imports */
const axios = require('axios');
const { TokenManager, createTokenPersister } = require('../../src/lib/token-manager');
const { TwitchHelixAPI } = require('../../src/lib/twitch-helix-api');
const { EnvManager } = require('../../src/lib/env-manager');
/* eslint-enable @typescript-eslint/no-require-imports */

interface FakeTwitch {
  base: string;
  /** access token -> epoch ms when it expires */
  live: Map<string, number>;
  /** refresh tokens Twitch will accept */
  refreshTokens: Set<string>;
  tokenRequests: URLSearchParams[];
  helixAuth: string[];
  close: () => Promise<void>;
}

async function startFakeTwitch(): Promise<FakeTwitch> {
  const live = new Map<string, number>();
  const refreshTokens = new Set<string>();
  const tokenRequests: URLSearchParams[] = [];
  const helixAuth: string[] = [];
  let issued = 0;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      const auth = String(req.headers.authorization || '');
      const token = auth.replace(/^(OAuth|Bearer) /, '');
      const expiresAt = live.get(token);
      const alive = expiresAt !== undefined && expiresAt > Date.now();

      if (req.url === '/oauth2/validate') {
        if (!alive) return send(401, { status: 401, message: 'invalid access token' });
        return send(200, {
          client_id: 'cid', login: 'excella_bot', user_id: '42',
          scopes: ['chat:read', 'chat:edit'],
          expires_in: Math.floor((expiresAt! - Date.now()) / 1000)
        });
      }

      if (req.url === '/oauth2/token' && req.method === 'POST') {
        const params = new URLSearchParams(body);
        tokenRequests.push(params);
        if (
          req.headers['content-type'] !== 'application/x-www-form-urlencoded' ||
          params.get('grant_type') !== 'refresh_token' ||
          params.get('client_id') !== 'cid' ||
          params.get('client_secret') !== 'secret'
        ) {
          return send(400, { status: 400, message: 'missing or invalid parameters' });
        }
        if (!refreshTokens.has(params.get('refresh_token') || '')) {
          return send(400, { status: 400, message: 'Invalid refresh token' });
        }
        issued += 1;
        const access = `access-${issued}`;
        const refresh = `refresh-${issued}`;
        live.set(access, Date.now() + 4 * 3600 * 1000);
        refreshTokens.add(refresh);
        return send(200, {
          access_token: access, refresh_token: refresh, expires_in: 4 * 3600,
          scope: ['chat:read', 'chat:edit'], token_type: 'bearer'
        });
      }

      if (req.url?.startsWith('/helix/users')) {
        helixAuth.push(auth);
        if (!alive) return send(401, { status: 401, message: 'Invalid OAuth token' });
        return send(200, { data: [{ id: '42', login: 'excella_bot', display_name: 'Excella_Bot' }] });
      }

      send(404, { message: 'not found' });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base, live, refreshTokens, tokenRequests, helixAuth,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

const ENV_FILE = [
  '# Twitch bot credentials',
  '# TWITCH_ACCESS_TOKEN=commented-out-old-token',
  'TWITCH_CLIENT_ID=cid',
  'TWITCH_BROADCASTER_ACCESS_TOKEN=caster-access',
  'TWITCH_BROADCASTER_REFRESH_TOKEN=caster-refresh',
  'TWITCH_ACCESS_TOKEN=expired-access',
  'TWITCH_REFRESH_TOKEN=refresh-0',
  'DASHBOARD_PORT=3001',
  ''
].join('\r\n');

describe('token refresh end to end', () => {
  let twitch: FakeTwitch;
  let dir: string;
  let envPath: string;
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const makeManager = () => {
    const tm = new TokenManager({
      clientId: 'cid',
      clientSecret: 'secret',
      tokens: { bot: { accessToken: 'expired-access', refreshToken: 'refresh-0' } },
      http: axios.create({ timeout: 2000 }),
      validateUrl: `${twitch.base}/oauth2/validate`,
      tokenUrl: `${twitch.base}/oauth2/token`,
      persist: createTokenPersister({
        accountName: null, envPath, AccountManager: jest.fn(), EnvManager, logger
      }),
      logger
    });
    return tm;
  };

  const makeHelix = (tm: { getAccessToken: (t: string) => string; refresh: (t: string) => Promise<unknown> }) => {
    const api = new TwitchHelixAPI({ clientId: 'cid', accessToken: tm.getAccessToken('bot') });
    api.http.defaults.baseURL = `${twitch.base}/helix`;
    api.setOnTokenRefresh(() => tm.refresh('bot'));
    return api;
  };

  beforeEach(async () => {
    twitch = await startFakeTwitch();
    twitch.refreshTokens.add('refresh-0');
    twitch.live.set('caster-access', Date.now() + 3600 * 1000);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-e2e-'));
    envPath = path.join(dir, '.env');
    fs.writeFileSync(envPath, ENV_FILE);
    process.env.BACKUP_DIR = path.join(dir, 'backups');
    jest.clearAllMocks();
  });

  afterEach(async () => {
    delete process.env.BACKUP_DIR;
    await twitch.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refreshes an expired bot token at startup and saves it to the right .env lines', async () => {
    const tm = makeManager();

    await expect(tm.ensureValid('bot')).resolves.toBe(true);

    expect(tm.getAccessToken('bot')).toBe('access-1');
    expect(tm.cache.bot.scopes).toEqual(['chat:read', 'chat:edit']);
    const lines = fs.readFileSync(envPath, 'utf8').split('\n').map((l) => l.replace(/\r$/, ''));
    expect(lines).toContain('TWITCH_ACCESS_TOKEN=access-1');
    expect(lines).toContain('TWITCH_REFRESH_TOKEN=refresh-1');
    // Comments, broadcaster keys and unrelated settings are untouched
    expect(lines).toContain('# TWITCH_ACCESS_TOKEN=commented-out-old-token');
    expect(lines).toContain('TWITCH_BROADCASTER_ACCESS_TOKEN=caster-access');
    expect(lines).toContain('TWITCH_BROADCASTER_REFRESH_TOKEN=caster-refresh');
    expect(lines).toContain('DASHBOARD_PORT=3001');
  });

  it('adds the token keys when .env does not have them yet', async () => {
    fs.writeFileSync(envPath, 'TWITCH_CLIENT_ID=cid\n');
    const tm = makeManager();

    await tm.refresh('bot');

    const env = new EnvManager(envPath).parseEnv(fs.readFileSync(envPath, 'utf8'));
    expect(env).toMatchObject({ TWITCH_ACCESS_TOKEN: 'access-1', TWITCH_REFRESH_TOKEN: 'refresh-1' });
  });

  it('keeps the new token in memory when .env cannot be written', async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir);
    fs.mkdirSync(envPath); // a directory where the file should be: every write fails
    const tm = makeManager();

    await expect(tm.refresh('bot')).resolves.toEqual({ accessToken: 'access-1', refreshToken: 'refresh-1' });
    expect(tm.getAccessToken('bot')).toBe('access-1');
  });

  it('recovers a Helix call that hits an expired token, then keeps using the new one', async () => {
    const tm = makeManager();
    const api = makeHelix(tm);

    const user = await api.getUserByName('excella_bot');

    expect(user).toMatchObject({ id: '42' });
    expect(twitch.helixAuth).toEqual(['Bearer expired-access', 'Bearer access-1']);
    expect(twitch.tokenRequests).toHaveLength(1);

    await api.getUserByName('excella_bot');
    expect(twitch.helixAuth[2]).toBe('Bearer access-1');
    expect(twitch.tokenRequests).toHaveLength(1);
  });

  it('refreshes once when several Helix calls hit an expired token together', async () => {
    const tm = makeManager();
    const api = makeHelix(tm);

    const users = await Promise.all([
      api.getUserByName('excella_bot'),
      api.getUserByName('excella_bot'),
      api.getUserByName('excella_bot')
    ]);

    expect(users.every((u: { id: string } | null) => u?.id === '42')).toBe(true);
    expect(twitch.tokenRequests).toHaveLength(1);
  });

  it('gives up cleanly when Twitch rejects the refresh token', async () => {
    twitch.refreshTokens.clear();
    const tm = makeManager();
    const api = makeHelix(tm);

    await expect(tm.ensureValid('bot')).resolves.toBe(false);
    expect(logger.error.mock.calls.flat().join(' ')).toContain('Invalid refresh token (HTTP 400)');
    // The Helix call fails once without looping
    await expect(api.getUserByName('excella_bot')).resolves.toBeNull();
    expect(twitch.helixAuth).toEqual(['Bearer expired-access']);
    expect(fs.readFileSync(envPath, 'utf8')).toBe(ENV_FILE);
  });
});
