/**
 * End-to-end harness: runs the real bot and the real dashboard in-process
 * against a fake Twitch, with fake timers so tests control the clock.
 *
 * The calling test file must mock the network edges first:
 *   jest.mock('axios', () => require('./harness/redirect').axiosMock());
 *   jest.mock('ws', () => require('./harness/redirect').wsMock());
 *   jest.mock('tmi.js', () => require('./harness/redirect').tmiMock());
 *   jest.mock('dotenv', () => ({ config: jest.fn() }));
 *   jest.mock('../../src/lib/console-timestamp', () => ({}));
 *
 * After the TypeScript migration only `loadBot` changes; the tests stay as they are.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { setTimeout as realSleep } from 'timers/promises';
import { startFakeTwitch, FakeTwitch, ALL_SCOPES } from './fake-twitch';
import { inflight } from './redirect';

const ROOT = path.join(__dirname, '..', '..', '..');

/** Wall clock captured before jest fake timers replace Date (they fake hrtime and performance too) */
const realNow: () => number = Date.now.bind(Date);

export const BROADCASTER = { id: '1001', login: 'caster', display_name: 'Caster' };
export const BOT_USER = { id: '2002', login: 'excella_bot', display_name: 'Excella_Bot' };

export interface ChatTags {
  mod?: boolean;
  broadcaster?: boolean;
  subscriber?: boolean;
  vip?: boolean;
  firstMsg?: boolean;
  displayName?: string;
  userId?: string;
}

export interface BotOptions {
  /** Extra environment variables for the bot (and dashboard) */
  env?: Record<string, string>;
  /** Scopes for the bot token (default: everything) */
  botScopes?: string[];
  /** Give the bot a separate broadcaster token */
  broadcasterToken?: boolean | { scopes?: string[]; ttlSec?: number };
  /** Bot token lifetime in seconds (default 4 hours); 0 = already expired */
  botTokenTtlSec?: number;
  /** Seed dashboard data files before start: file name -> JSON content */
  dashboardData?: Record<string, unknown>;
  /** Extra users known to fake Twitch */
  users?: Array<{ id: string; login: string; display_name: string }>;
  /** Hook to seed fake Twitch state before the bot starts */
  seed?: (twitch: FakeTwitch) => void;
}

export interface BotHarness {
  twitch: FakeTwitch;
  dir: string;
  logsDir: string;
  envPath: string;
  dashboardUrl: string;
  /** Messages the bot sent to chat, oldest first */
  said: () => string[];
  /** Messages sent since the last call to `take()` */
  take: () => string[];
  /** Send a chat message as `user` and wait for the bot to finish reacting */
  chat: (user: string, text: string, tags?: ChatTags) => Promise<string[]>;
  /** Wait until all pending HTTP traffic and timers at the current time have settled */
  settle: () => Promise<void>;
  /** Advance the fake clock and let the bot react */
  advance: (ms: number) => Promise<void>;
  /** Read a dashboard data file */
  readData: <T = any>(file: string) => T;
  /** Write a dashboard data file */
  writeData: (file: string, data: unknown) => void;
  /** Requests the bot made to the dashboard, as "METHOD /path" */
  dashboardCalls: () => Array<{ route: string; body: any }>;
  /** Fire an EventSub event and wait for the bot to react */
  event: (type: string, event: Record<string, unknown>) => Promise<string[]>;
  exitCodes: () => number[];
  stop: () => Promise<void>;
}

const BASE_ENV_KEYS = [
  'TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'TWITCH_ACCESS_TOKEN', 'TWITCH_REFRESH_TOKEN',
  'TWITCH_BROADCASTER_NAME', 'TWITCH_CHANNELS', 'TWITCH_SCOPES', 'TWITCH_BROADCASTER_ACCESS_TOKEN',
  'TWITCH_BROADCASTER_REFRESH_TOKEN', 'TWITCH_BROADCASTER_SCOPES', 'DASHBOARD_PORT', 'ENV_PATH',
  'BACKUP_DIR', 'E2E_FAKE_TWITCH', 'DASHBOARD_INTERNAL_SECRET', 'YOUTUBE_API_KEY', 'TTS_PROVIDER'
];

export async function startBot(options: BotOptions = {}): Promise<BotHarness> {
  const savedEnv = { ...process.env };
  inflight.count = 0; // drop anything a previous test left unanswered
  const twitch = await startFakeTwitch();
  twitch.state.users.push(BROADCASTER, BOT_USER, ...(options.users || []));
  options.seed?.(twitch);

  const botToken = twitch.issueToken(BOT_USER.login, {
    scopes: options.botScopes || ALL_SCOPES,
    ttlSec: options.botTokenTtlSec ?? 4 * 3600
  });
  let casterToken: { access: string; refresh: string } | null = null;
  if (options.broadcasterToken) {
    const opts = typeof options.broadcasterToken === 'object' ? options.broadcasterToken : {};
    casterToken = twitch.issueToken(BROADCASTER.login, { scopes: opts.scopes || ALL_SCOPES, ttlSec: opts.ttlSec });
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'excella-e2e-'));
  const logsDir = path.join(dir, 'logs');
  const envPath = path.join(dir, '.env');
  fs.mkdirSync(logsDir, { recursive: true });
  for (const [file, data] of Object.entries(options.dashboardData || {})) {
    fs.writeFileSync(path.join(logsDir, file), JSON.stringify(data, null, 2));
  }

  for (const key of BASE_ENV_KEYS) delete process.env[key];
  const env: Record<string, string> = {
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'test-client-secret',
    TWITCH_ACCESS_TOKEN: botToken.access,
    TWITCH_REFRESH_TOKEN: botToken.refresh,
    TWITCH_BROADCASTER_NAME: BROADCASTER.login,
    TWITCH_CHANNELS: BROADCASTER.login,
    TWITCH_SCOPES: (options.botScopes || ALL_SCOPES).join(' '),
    ENV_PATH: envPath,
    BACKUP_DIR: path.join(dir, 'backups'),
    E2E_FAKE_TWITCH: twitch.base,
    ...(casterToken ? {
      TWITCH_BROADCASTER_ACCESS_TOKEN: casterToken.access,
      TWITCH_BROADCASTER_REFRESH_TOKEN: casterToken.refresh,
      TWITCH_BROADCASTER_SCOPES: ALL_SCOPES.join(' ')
    } : {}),
    ...(options.env || {})
  };
  Object.assign(process.env, env);
  fs.writeFileSync(envPath, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');

  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });

  // Dashboard first, on a random port, so the bot can reach it
  let dashboard: any;
  let tmi: any;
  const pending = { open: 0 };
  const dashboardLog: Array<{ route: string; body: any }> = [];
  jest.isolateModules(() => {
    const { createDashboard } = require(path.join(ROOT, 'src', 'dashboard', 'server'));
    dashboard = createDashboard({ logsDir, uploadsDir: path.join(dir, 'uploads'), envPath, initTts: false });
    tmi = require('tmi.js');
  });
  dashboard.server.prependListener('request', (req: any, res: any) => {
    pending.open += 1;
    // Captured now: Express rewrites req.url inside mounted routers before a bodiless request ends
    const route = `${req.method} ${req.url.split('?')[0]}`;
    let body = '';
    req.on('data', (c: Buffer) => { body += c; });
    req.on('end', () => {
      let parsed: unknown = body;
      try { parsed = body ? JSON.parse(body) : undefined; } catch { /* keep text */ }
      dashboardLog.push({ route, body: parsed });
    });
    res.on('close', () => { pending.open -= 1; });
  });
  await dashboard.init();
  await new Promise<void>((resolve) => dashboard.server.listen(0, '127.0.0.1', resolve));
  const dashboardPort = (dashboard.server.address() as AddressInfo).port;
  process.env.DASHBOARD_PORT = String(dashboardPort);

  const exitCodes: number[] = [];
  const exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCodes.push(code ?? 0);
    throw new Error(`process.exit(${code})`);
  }) as never);
  const listenersBefore = process.listeners('unhandledRejection');

  // Load the bot (src/bot/main runs start() on load)
  jest.isolateModules(() => {
    jest.doMock('tmi.js', () => tmi);
    require(path.join(ROOT, 'src', 'bot', 'main'));
  });

  const client = () => tmi.Client.instances[tmi.Client.instances.length - 1];
  let taken = 0;


  /**
   * Wait until nothing is in flight and no new traffic or chat has appeared for
   * a while. Quiet is measured in real time as well as loop turns, so a busy
   * machine (slow file and socket I/O) does not end the wait early.
   */
  async function settle() {
    const QUIET_TURNS = 8;
    const QUIET_MS = 40;
    let quiet = 0;
    let quietSince = realNow();
    let lastCount = -1;
    for (let i = 0; i < 4000; i++) {
      await jest.advanceTimersByTimeAsync(0);
      await realSleep(2);
      const count = twitch.requests.length + dashboardLog.length + (client()?.said.length || 0);
      if (pending.open === 0 && inflight.count === 0 && count === lastCount) {
        quiet += 1;
      } else {
        quiet = 0;
        quietSince = realNow();
      }
      lastCount = count;
      if (quiet >= QUIET_TURNS && realNow() - quietSince >= QUIET_MS) break;
    }
  }

  await settle();
  // Under load the bot may still be starting; wait (briefly) for chat to connect
  // unless startup ended the process
  for (let i = 0; i < 200 && !client()?.connected && exitCodes.length === 0; i++) {
    await settle();
  }

  const harness: BotHarness = {
    twitch,
    dir,
    logsDir,
    envPath,
    dashboardUrl: `http://127.0.0.1:${dashboardPort}`,
    said: () => (client()?.said || []).map((s: { message: string }) => s.message),
    take: () => {
      const all = harness.said();
      const fresh = all.slice(taken);
      taken = all.length;
      return fresh;
    },
    async chat(user, text, tags = {}) {
      harness.take();
      const known = twitch.state.users.find((u) => u.login === user.toLowerCase());
      const badges: Record<string, string> = {};
      if (tags.broadcaster) badges.broadcaster = '1';
      if (tags.vip) badges.vip = '1';
      client().emit('message', `#${BROADCASTER.login}`, {
        username: user.toLowerCase(),
        'display-name': tags.displayName || user,
        'user-id': tags.userId || known?.id || `9${user.length}${user.charCodeAt(0)}`,
        mod: tags.mod || false,
        subscriber: tags.subscriber || false,
        badges,
        'first-msg': tags.firstMsg || false,
        'room-id': BROADCASTER.id,
        id: `msg-${Date.now()}-${Math.random()}`
      }, text, false);
      await settle();
      return harness.take();
    },
    settle,
    async advance(ms) {
      await jest.advanceTimersByTimeAsync(ms);
      await settle();
    },
    readData: (file) => JSON.parse(fs.readFileSync(path.join(logsDir, file), 'utf8')),
    writeData: (file, data) => fs.writeFileSync(path.join(logsDir, file), JSON.stringify(data, null, 2)),
    dashboardCalls: () => dashboardLog.slice(),
    async event(type, event) {
      harness.take();
      twitch.emitEvent(type, event);
      await settle();
      return harness.take();
    },
    exitCodes: () => exitCodes.slice(),
    async stop() {
      // Close the servers while fake timers are still installed, so reconnect
      // attempts the bot schedules in response land on the fake clock and are cleared
      await dashboard.close();
      await twitch.close();
      await realSleep(5);
      jest.clearAllTimers();
      for (const listener of process.listeners('unhandledRejection')) {
        if (!listenersBefore.includes(listener)) process.removeListener('unhandledRejection', listener);
      }
      exitSpy.mockRestore();
      jest.useRealTimers();
      fs.rmSync(dir, { recursive: true, force: true });
      process.env = savedEnv;
    }
  };
  return harness;
}
