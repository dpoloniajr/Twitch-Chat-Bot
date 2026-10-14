/**
 * Characterization: token generator app wiring (static files, /api/current-tokens,
 * redirects, 404s, JSON errors, factory defaults and start()).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { createTokenGenerator, Harness, postJson, quietOutput, startHarness } from './harness';

describe('token generator server', () => {
  quietOutput();
  let h: Harness;

  afterEach(async () => {
    if (h) await h.close();
  });

  it('serves the setup page from public/token-generator', async () => {
    h = await startHarness();
    const res = await fetch(`${h.base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(await res.text()).toContain('<title>Twitch Bot Token Generator</title>');

    const js = await fetch(`${h.base}/app.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toMatch(/javascript/);
  });

  it('GET /api/current-tokens reports tokens and scopes from .env', async () => {
    h = await startHarness({
      env: [
        'TWITCH_ACCESS_TOKEN=bot-token',
        'TWITCH_SCOPES=chat:read  chat:edit',
        'TWITCH_BROADCASTER_ACCESS_TOKEN="caster-token"',
        'TWITCH_BROADCASTER_SCOPES=bits:read'
      ].join('\n')
    });
    const res = await fetch(`${h.base}/api/current-tokens`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      botToken: 'bot-token',
      botScopes: ['chat:read', 'chat:edit'],
      broadcasterToken: 'caster-token',
      broadcasterScopes: ['bits:read']
    });
  });

  it('GET /api/current-tokens returns nulls and empty lists without a .env', async () => {
    h = await startHarness();
    const res = await fetch(`${h.base}/api/current-tokens`);
    expect(await res.json()).toEqual({ botToken: null, botScopes: [], broadcasterToken: null, broadcasterScopes: [] });
  });

  it('GET /api/current-tokens sends a 500 JSON error when .env cannot be read', async () => {
    h = await startHarness();
    fs.mkdirSync(h.envPath); // reading a directory throws EISDIR
    const res = await fetch(`${h.base}/api/current-tokens`);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/EISDIR/);
  });

  it('redirects /api/scope-presets (any method and sub-path) to /api/scopes/presets', async () => {
    h = await startHarness();
    for (const [method, url] of [['GET', '/api/scope-presets'], ['POST', '/api/scope-presets/x/y']]) {
      const res = await fetch(`${h.base}${url}`, { method, redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/api/scopes/presets');
    }
    const followed = await fetch(`${h.base}/api/scope-presets`);
    expect(followed.status).toBe(200);
    expect(Object.keys(await followed.json())).toContain('basic-bot');
  });

  it('answers unknown routes with the Express 404 page', async () => {
    h = await startHarness();
    const res = await fetch(`${h.base}/api/nope`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('Cannot GET /api/nope');

    const del = await fetch(`${h.base}/api/env/status`, { method: 'DELETE' });
    expect(del.status).toBe(404);
  });

  it('turns malformed JSON bodies into a 400 JSON error', async () => {
    h = await startHarness();
    const res = await fetch(`${h.base}/api/env/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json'
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe('string');
  });

  it('ignores bodies that are not JSON (routes see an empty body and answer 400)', async () => {
    h = await startHarness();
    const res = await fetch(`${h.base}/api/env/restore`, { method: 'POST', body: 'backupName=x' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: 'backupName is required' });
    const empty = await postJson(`${h.base}/api/env/restore`, {});
    expect(empty.status).toBe(400);
  });

  it('builds the redirect URI from the configured port', async () => {
    h = await startHarness({ port: 4567 });
    expect(h.gen.port).toBe(4567);
    expect(h.gen.redirectUri).toBe('http://localhost:4567/callback');
    expect(h.gen.envManager.envPath).toBe(h.envPath);
    expect(h.gen.envManager.backupDir).toBe(h.backupDir);
    expect(h.gen.accountManager.accountsFile).toBe(h.accountsFile);
    expect(fs.existsSync(h.keyFile)).toBe(true);
    expect(fs.existsSync(h.backupDir)).toBe(true);
  });
});

describe('createTokenGenerator defaults', () => {
  quietOutput();
  const saved = { ...process.env };
  const cwd = process.cwd();
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-generator-defaults-'));
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('uses TOKEN_GENERATOR_PORT, ENV_PATH, BACKUP_DIR and the working folder', () => {
    process.env.TOKEN_GENERATOR_PORT = '4999';
    process.env.ENV_PATH = 'custom.env';
    process.env.BACKUP_DIR = 'my-backups';
    const gen = createTokenGenerator({ logDir: path.join(dir, 'logs') });
    expect(gen.port).toBe('4999');
    expect(gen.redirectUri).toBe('http://localhost:4999/callback');
    expect(gen.envManager.envPath).toBe(path.join(fs.realpathSync(dir), 'custom.env'));
    expect(gen.envManager.backupDir).toBe(path.join(fs.realpathSync(dir), 'my-backups'));
    expect(gen.accountManager.accountsFile).toBe('accounts.encrypted.json');
    expect(gen.accountManager.keyFile).toBe('.encryption-key');
    expect(fs.existsSync(path.join(dir, '.encryption-key'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'my-backups'))).toBe(true);
  });

  it('falls back to port 3000, .env and backups', () => {
    delete process.env.TOKEN_GENERATOR_PORT;
    delete process.env.ENV_PATH;
    delete process.env.BACKUP_DIR;
    const gen = createTokenGenerator({ logDir: path.join(dir, 'logs') });
    expect(gen.port).toBe(3000);
    expect(gen.redirectUri).toBe('http://localhost:3000/callback');
    expect(gen.envManager.envPath).toBe(path.join(fs.realpathSync(dir), '.env'));
    expect(gen.envManager.backupDir).toBe(path.join(fs.realpathSync(dir), 'backups'));
  });

  it('start() listens on the configured port and logs the URL', async () => {
    const logDir = path.join(dir, 'logs');
    const gen = createTokenGenerator({ port: 0, envPath: path.join(dir, '.env'), backupDir: path.join(dir, 'b'), logDir });
    const server: Server = gen.start();
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/env/status`);
      expect(res.status).toBe(200);
      const log = fs.readFileSync(path.join(logDir, 'token-generator.log'), 'utf8');
      expect(log).toMatch(/\[INFO\] \[TokenGenerator\] Token Generator Server running at http:\/\/localhost:0\n$/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
