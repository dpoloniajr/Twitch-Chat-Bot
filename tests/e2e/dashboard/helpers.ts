/**
 * Shared helper for the dashboard HTTP characterization suite.
 *
 * Builds the real dashboard (dashboard/server.js createDashboard) on a temp
 * directory, listens on an ephemeral port and talks to it over real HTTP and
 * WebSocket. No bot, no fake Twitch.
 *
 * The calling test file must mock:
 *   jest.mock('dotenv', () => ({ config: jest.fn() }));
 *   jest.mock('../../../src/lib/console-timestamp', () => ({}));
 *
 * Each startDashboard() loads the dashboard modules in an isolated module
 * registry (jest.isolateModules) because several routers (api, filters, alerts,
 * obs, uploads) and dashboard/lib/state.js are module-level singletons: a second
 * createDashboard() in the same registry adds its routes behind the first
 * dashboard's routes (see server.test.ts for that characterization).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import type { AddressInfo } from 'net';

export const ROOT = path.join(__dirname, '..', '..', '..');

export interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
}

export interface RequestOptions {
  body?: unknown;
  /** Raw body string sent as-is (with the given or a JSON content type) */
  raw?: string;
  headers?: Record<string, string>;
  /** Connect to this host instead of 127.0.0.1 */
  host?: string;
  /** Client-side timeout in ms (default 5000); on timeout resolves with status 0 */
  timeoutMs?: number;
}

export interface DashboardModule {
  createDashboard: (options: Record<string, unknown>) => {
    app: unknown;
    server: http.Server;
    wss: { clients: Set<unknown> };
    paths: Record<string, string>;
    init: () => Promise<unknown>;
    close: () => Promise<void>;
  };
}

export interface StateModule {
  getBotState: () => Record<string, unknown>;
  getChatFilters: () => Record<string, unknown>;
  broadcastState: (data: unknown) => void;
}

export interface Dash {
  root: string;
  logsDir: string;
  uploadsDir: string;
  envPath: string;
  port: number;
  paths: Record<string, string>;
  state: StateModule;
  request: (method: string, urlPath: string, opts?: RequestOptions) => Promise<HttpResult>;
  get: (urlPath: string, opts?: RequestOptions) => Promise<HttpResult>;
  post: (urlPath: string, body?: unknown, opts?: RequestOptions) => Promise<HttpResult>;
  put: (urlPath: string, body?: unknown, opts?: RequestOptions) => Promise<HttpResult>;
  del: (urlPath: string, opts?: RequestOptions) => Promise<HttpResult>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readJson: <T = any>(file: string) => T;
  writeJson: (file: string, data: unknown) => void;
  exists: (file: string) => boolean;
  readEnv: () => string;
  close: () => Promise<void>;
}

export interface DashOptions {
  /** Environment variables to set while the dashboard is loaded (undefined = delete) */
  env?: Record<string, string | undefined>;
  /** Files written into logsDir before init(): file name -> JSON content */
  seed?: Record<string, unknown>;
  /** Initial .env content (default: no .env file) */
  envFile?: string;
  /** Address to listen on (default 127.0.0.1) */
  listenHost?: string;
}

/** Env vars the dashboard or tts-service read; cleared so the host environment cannot leak in */
const CONTROLLED_ENV = [
  'DASHBOARD_INTERNAL_SECRET',
  'COMMAND_REFRESH_INTERVAL',
  'TTS_PROVIDER',
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_VOICE_ID',
  'ELEVENLABS_MODEL',
  'OPENAI_API_KEY',
  'OPENAI_TTS_VOICE',
  'OPENAI_TTS_MODEL',
  'TTS_CACHE_ENABLED',
  'TTS_CACHE_MAX_AGE',
  'TTS_CACHE_MAX_SIZE'
];

export function httpRequest(port: number, method: string, urlPath: string, opts: RequestOptions = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    let payload: string | undefined;
    const headers: Record<string, string> = { ...(opts.headers || {}) };
    if (opts.raw !== undefined) {
      payload = opts.raw;
      if (!headers['content-type']) headers['content-type'] = 'application/json';
    } else if (opts.body !== undefined) {
      payload = JSON.stringify(opts.body);
      headers['content-type'] = 'application/json';
    }
    if (payload !== undefined) headers['content-length'] = String(Buffer.byteLength(payload));

    const req = http.request({
      host: opts.host || '127.0.0.1',
      port,
      method,
      path: urlPath,
      headers,
      agent: false
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode || 0, headers: res.headers, text, json });
      });
    });
    req.setTimeout(opts.timeoutMs ?? 5000, () => {
      req.destroy();
      resolve({ status: 0, headers: {}, text: '', json: undefined });
    });
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNRESET' && req.destroyed) return;
      reject(err);
    });
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** First non-internal IPv4 address of this machine, if any (used to test non-localhost callers) */
export function externalIPv4(): string | null {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const addr of list || []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}

export async function startDashboard(options: DashOptions = {}): Promise<Dash> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-e2e-'));
  const logsDir = path.join(root, 'logs');
  const uploadsDir = path.join(root, 'uploads');
  const envPath = path.join(root, '.env');

  if (options.seed) {
    fs.mkdirSync(logsDir, { recursive: true });
    for (const [file, data] of Object.entries(options.seed)) {
      fs.writeFileSync(path.join(logsDir, file), JSON.stringify(data, null, 2));
    }
  }
  if (options.envFile !== undefined) fs.writeFileSync(envPath, options.envFile);

  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = new Set([...CONTROLLED_ENV, ...Object.keys(options.env || {})]);
  for (const key of envKeys) {
    savedEnv[key] = process.env[key];
    const value = options.env?.[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  // createDashboard() requires the route modules itself, so it must run inside the
  // isolated registry too, or the routers would come from the shared registry
  let state!: StateModule;
  let dashboard!: ReturnType<DashboardModule['createDashboard']>;
  jest.isolateModules(() => {
    const mod: DashboardModule = require('../../../src/dashboard/server');
    state = require('../../../src/dashboard/lib/state');
    dashboard = mod.createDashboard({ logsDir, uploadsDir, envPath, initTts: false });
  });

  await dashboard.init();
  await new Promise<void>((resolve) => dashboard.server.listen(0, options.listenHost || '127.0.0.1', () => resolve()));
  const port = (dashboard.server.address() as AddressInfo).port;

  const request = (method: string, urlPath: string, opts?: RequestOptions) => httpRequest(port, method, urlPath, opts);
  let closed = false;

  return {
    root,
    logsDir,
    uploadsDir,
    envPath,
    port,
    paths: dashboard.paths,
    state,
    request,
    get: (p, o) => request('GET', p, o),
    post: (p, body, o) => request('POST', p, { ...o, body }),
    put: (p, body, o) => request('PUT', p, { ...o, body }),
    del: (p, o) => request('DELETE', p, o),
    readJson: (file) => JSON.parse(fs.readFileSync(path.join(logsDir, file), 'utf8')),
    writeJson: (file, data) => fs.writeFileSync(path.join(logsDir, file), JSON.stringify(data, null, 2)),
    exists: (file) => fs.existsSync(path.join(logsDir, file)),
    readEnv: () => fs.readFileSync(envPath, 'utf8'),
    close: async () => {
      if (closed) return;
      closed = true;
      await dashboard.close();
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

export interface WsClient {
  messages: Array<{ type: string; data: unknown }>;
  /** Resolves with the next message of `type` received after `since` (index into messages) */
  waitFor: (type: string, since?: number, timeoutMs?: number) => Promise<{ type: string; data: any }>;
  close: () => void;
}

/** Open a WebSocket client to the dashboard and record every message */
export async function openWs(dash: Dash): Promise<WsClient> {
  // Real ws (this suite does not mock it)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const WebSocket = require('ws');
  const ws = new WebSocket(`ws://127.0.0.1:${dash.port}`);
  const messages: Array<{ type: string; data: unknown }> = [];
  const listeners: Array<() => void> = [];
  ws.on('message', (raw: Buffer) => {
    messages.push(JSON.parse(raw.toString()));
    for (const l of [...listeners]) l();
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const waitFor = (type: string, since = 0, timeoutMs = 3000) => new Promise<{ type: string; data: any }>((resolve, reject) => {
    const check = () => {
      const found = messages.slice(since).find(m => m.type === type);
      if (found) {
        listeners.splice(listeners.indexOf(check), 1);
        clearTimeout(timer);
        resolve(found as { type: string; data: any });
      }
    };
    const timer = setTimeout(() => {
      listeners.splice(listeners.indexOf(check), 1);
      reject(new Error(`No "${type}" message within ${timeoutMs}ms; got ${messages.map(m => m.type).join(', ')}`));
    }, timeoutMs);
    listeners.push(check);
    check();
  });
  return { messages, waitFor, close: () => ws.terminate() };
}

/** Silence console output from the dashboard; call in beforeEach */
export function silenceConsole(): void {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
}

/** Wait (real time) until `predicate` is true or throw after timeoutMs */
export async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out');
    await new Promise(r => setTimeout(r, 10));
  }
}
