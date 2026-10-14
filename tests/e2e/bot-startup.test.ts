/**
 * E2E characterization: bot startup (createBot's start() and init(), checkRequiredScopes,
 * setupEventSub, setupBroadcasterEventSub, the custom command refresh timer and the
 * restart.flag watcher, all in src/bot/).
 *
 * Token refresh lifecycle (proactive refresh cycles) is covered by
 * tests/regression/excella-token-refresh.test.ts and is not repeated here.
 */
jest.mock('axios', () => require('./harness/redirect').axiosMock());
jest.mock('ws', () => require('./harness/redirect').wsMock());
jest.mock('tmi.js', () => require('./harness/redirect').tmiMock());
jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('../../src/lib/console-timestamp', () => ({}));

import * as fs from 'fs';
// The CommonJS module object (what src/bot/main.ts sees), whose properties can be spied on
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeFs: typeof import('fs') = require('fs');
import * as path from 'path';
import { startBot, BotHarness, BotOptions, BROADCASTER, BOT_USER } from './harness/bot';
import { ALL_SCOPES } from './harness/fake-twitch';

const ROOT = path.join(__dirname, '..', '..');
const RESTART_FLAG = path.join(ROOT, 'dashboard', 'logs', 'restart.flag');

interface FakeTmi {
  opts: { identity: { username: string; password: string }; channels: string[] };
  connectCount: number;
  connected: boolean;
}
interface IrcWrapper {
  client: FakeTmi | null;
  isConnected: () => boolean;
}
const irc = (): IrcWrapper => (global as unknown as { chatClient: IrcWrapper }).chatClient;

const BOT_SUB_TYPES = ['stream.online', 'stream.offline'];
const BROADCASTER_SUB_TYPES = [
  'channel.follow',
  'channel.raid',
  'channel.channel_points_custom_reward_redemption.add',
  'channel.subscribe',
  'channel.subscription.message',
  'channel.subscription.gift',
  'channel.cheer'
];

let logSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;
let bot: BotHarness | null = null;

const lines = (spy: jest.SpyInstance): string[] =>
  spy.mock.calls.map((args: unknown[]) => args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));

const envFile = (b: BotHarness): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(b.envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
};

async function start(options: BotOptions = {}): Promise<BotHarness> {
  bot = await startBot(options);
  return bot;
}

describe('bot startup', () => {
  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => {
    if (bot) await bot.stop();
    bot = null;
    // Let the bot's EventSub sockets report their close while console is still silenced
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  describe('normal start, single account (no broadcaster token)', () => {
    it('connects IRC with the bot token and joins the configured channels', async () => {
      const b = await start();
      const client = irc().client!;
      expect(client).toBeTruthy();
      expect(client.connectCount).toBe(1);
      expect(irc().isConnected()).toBe(true);
      // Logs in as the account the bot token belongs to, not as TWITCH_BROADCASTER_NAME
      expect(client.opts.identity.username).toBe(BOT_USER.login);
      expect(client.opts.identity.password).toBe(`oauth:${b.twitch.state.subscriptions[0].token}`);
      expect(client.opts.identity.password).toBe('oauth:access-excella_bot-1');
      expect(client.opts.channels).toEqual(['caster']);
      expect(b.exitCodes()).toEqual([]);
      expect(lines(logSpy)).toEqual(expect.arrayContaining([
        'Starting Twitch bot...',
        '✓ Bot token is valid',
        '✓ All required scopes for enabled features are present.',
        'Got broadcaster ID: 1001',
        'Token user ID: 2002 (excella_bot)',
        '[EventSub-Broadcaster] Broadcaster token not available. Skipping broadcaster EventSub setup.',
        'Chat client connected!',
        '✓ Connected to Twitch chat',
        '✓ Joined channels: caster',
        'Bot is ready!'
      ]));
    });

    it('subscribes only stream.online/offline, on one session, with the bot token', async () => {
      const b = await start();
      const subs = b.twitch.state.subscriptions;
      expect(subs.map((s) => s.type)).toEqual(BOT_SUB_TYPES);
      for (const s of subs) {
        expect(s.version).toBe('1');
        expect(s.condition).toEqual({ broadcaster_user_id: '1001' });
        expect(s.token).toBe('access-excella_bot-1');
        expect(s.sessionId).toBe('session-1');
      }
      expect(b.twitch.eventSubSessions()).toBe(1);
      // Broadcaster-only events have no subscription, so they never reach the bot
      expect(b.twitch.emitEvent('channel.follow', { user_name: 'x' })).toBe(0);
    });

    it('makes Twitch and dashboard requests in a fixed order', async () => {
      const b = await start();
      expect(b.twitch.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        'GET /oauth2/validate', // tokenManager.ensureValid('bot')
        'GET /oauth2/validate', // apiClient.getTokenInfo() in init()
        'GET /helix/users', // getUserByName(broadcaster)
        'GET /helix/users', // getUserById(token user)
        'POST /helix/eventsub/subscriptions',
        'POST /helix/eventsub/subscriptions'
      ]);
      expect(b.twitch.calls('GET /helix/users').map((r) => r.query)).toEqual([{ login: 'caster' }, { id: '2002' }]);
      const calls = b.dashboardCalls();
      expect(calls.map((c) => c.route)).toEqual([
        'GET /api/builtin-commands',
        'POST /api/update-state',
        'GET /api/custom-commands',
        // built-in command config is reloaded after every custom command load
        'GET /api/builtin-commands'
      ]);
      const state = calls[1].body;
      expect(state).toMatchObject({ isConnected: true, channels: ['caster'], broadcasterName: 'caster' });
      expect(state.scopes).toEqual(expect.arrayContaining(ALL_SCOPES));
      expect(state.commands).toHaveLength(11);
      expect(typeof state.uptime).toBe('number');
    });

    it('leaves .env alone when it already lists the scopes the token has, and adds no broadcaster scopes', async () => {
      const b = await start();
      const before = fs.readFileSync(b.envPath, 'utf8');
      const env = envFile(b);
      expect(env.TWITCH_BROADCASTER_SCOPES).toBeUndefined();
      expect(env.TWITCH_BROADCASTER_ACCESS_TOKEN).toBeUndefined();
      expect(env.TWITCH_SCOPES.split(' ')).toEqual(ALL_SCOPES);
      expect(fs.readFileSync(b.envPath, 'utf8')).toBe(before);
      expect(lines(logSpy).some((l) => l.includes('Updated .env with the scopes'))).toBe(false);
    });

    it('rewrites an over-claiming TWITCH_SCOPES to the scopes Twitch granted', async () => {
      const granted = ALL_SCOPES.filter((s) => s !== 'clips:edit');
      // .env (and process.env) claim clips:edit, which the token does not have
      const b = await start({ botScopes: granted, env: { TWITCH_SCOPES: [...granted, 'clips:edit'].join(' ') } });
      expect(envFile(b).TWITCH_SCOPES.split(' ')).toEqual([...granted].sort());
      expect(lines(logSpy)).toEqual(expect.arrayContaining([
        '✓ Updated .env with the scopes Twitch reports for your tokens.',
        '  - Removed from bot (not granted): clips:edit'
      ]));
      // and the missing scope is reported instead of being assumed
      expect(lines(warnSpy)).toContain('- Clips: Missing clips:edit');
    });
  });

  describe('with a broadcaster token', () => {
    it('opens a second EventSub session and subscribes broadcaster events with the broadcaster token', async () => {
      const b = await start({ broadcasterToken: true });
      const subs = b.twitch.state.subscriptions;
      expect(subs.map((s) => s.type)).toEqual([...BOT_SUB_TYPES, ...BROADCASTER_SUB_TYPES]);
      expect(b.twitch.eventSubSessions()).toBe(2);
      for (const s of subs.filter((x) => BOT_SUB_TYPES.includes(x.type))) {
        expect(s.token).toBe('access-excella_bot-1');
        expect(s.sessionId).toBe('session-1');
      }
      for (const s of subs.filter((x) => BROADCASTER_SUB_TYPES.includes(x.type))) {
        expect(s.token).toBe('access-caster-2');
        expect(s.sessionId).toBe('session-2');
      }
      const byType = Object.fromEntries(subs.map((s) => [s.type, s]));
      expect(byType['channel.follow'].version).toBe('2');
      expect(byType['channel.follow'].condition).toEqual({ broadcaster_user_id: '1001', moderator_user_id: '1001' });
      expect(byType['channel.raid'].condition).toEqual({ to_broadcaster_user_id: '1001' });
      expect(byType['channel.cheer'].condition).toEqual({ broadcaster_user_id: '1001' });
      // Hype train, ad break, etc. are not subscribed at all
      expect(subs.map((s) => s.type)).not.toEqual(expect.arrayContaining(['channel.hype_train.begin']));
      expect(subs.map((s) => s.type)).not.toEqual(expect.arrayContaining(['channel.ad_break.begin']));
      expect(lines(logSpy)).toContain('Broadcaster EventSub listener initialized successfully');
    });

    it('validates the broadcaster token once (cached for setupBroadcasterEventSub)', async () => {
      const b = await start({ broadcasterToken: true });
      expect(b.twitch.calls('GET /oauth2/validate').map((r) => r.token)).toEqual([
        'access-excella_bot-1', 'access-caster-2', 'access-excella_bot-1'
      ]);
      expect(lines(logSpy)).toContain('✓ Broadcaster token is valid');
    });

    it('subscribes only what the live broadcaster scopes allow (raid needs none)', async () => {
      const b = await start({ broadcasterToken: { scopes: ['channel:read:redemptions'] } });
      const broadcasterSubs = b.twitch.state.subscriptions.filter((s) => s.sessionId === 'session-2').map((s) => s.type);
      expect(broadcasterSubs).toEqual(['channel.raid', 'channel.channel_points_custom_reward_redemption.add']);
      expect(lines(warnSpy)).toEqual(expect.arrayContaining([
        '[EventSub-Broadcaster] Skipping follow subscription: missing moderator:read:followers scope',
        '[EventSub-Broadcaster] Skipping subscription events: missing channel:read:subscriptions scope',
        '[EventSub-Broadcaster] Skipping bits/cheer events: missing bits:read scope'
      ]));
      // checkRequiredScopes uses the live broadcaster scopes too
      expect(lines(warnSpy)).toContain('\n⚠️  MISSING REQUIRED SCOPES DETECTED');
      expect(lines(warnSpy).some((l) => l.startsWith('- Followage: Missing moderator:read:followers'))).toBe(true);
      expect(lines(warnSpy)).not.toContain('NOTE: You are using a single account setup. Your bot token needs broadcaster-level scopes.');
    });

    it('still subscribes raids (which need no scope) when none of the four event scopes are present', async () => {
      const b = await start({ broadcasterToken: { scopes: ['chat:read'] } });
      expect(b.twitch.state.subscriptions.map((s) => s.type)).toEqual([...BOT_SUB_TYPES, 'channel.raid']);
      expect(b.twitch.eventSubSessions()).toBe(2);
      expect(lines(warnSpy)).toEqual(expect.arrayContaining([
        '[EventSub-Broadcaster] Broadcaster token missing required scopes (only raids will be received):',
        '[EventSub-Broadcaster] Visit http://localhost:3000 to regenerate broadcaster token with proper scopes.',
        '[EventSub-Broadcaster] Skipping follow subscription: missing moderator:read:followers scope'
      ]));
      expect(await b.event('channel.raid', { from_broadcaster_user_name: 'Raider', viewers: 3 })).toEqual(['Incoming raid from Raider with 3 viewers! Welcome!']);
    });

    it('subscribes raids when only some unrelated scopes are missing', async () => {
      const b = await start({ broadcasterToken: { scopes: ALL_SCOPES.filter((s) => s !== 'bits:read' && s !== 'moderator:read:followers') } });
      const types = b.twitch.state.subscriptions.map((s) => s.type);
      expect(types).toContain('channel.raid');
      expect(types).not.toContain('channel.cheer');
      expect(types).not.toContain('channel.follow');
    });

    it('skips the broadcaster session when the broadcaster token is dead and cannot be refreshed', async () => {
      const b = await start({
        broadcasterToken: { ttlSec: 0 },
        seed: (t) => t.state.failures.set('POST /oauth2/token', { status: 400, message: 'Invalid refresh token' })
      });
      expect(lines(warnSpy)).toEqual(expect.arrayContaining([
        '⚠️  Failed to refresh broadcaster token. EventSub features will be disabled.',
        '[EventSub-Broadcaster] Broadcaster token is invalid or expired. Skipping broadcaster EventSub setup.'
      ]));
      // No WebSocket and no subscription attempts with the dead token
      expect(b.twitch.eventSubSessions()).toBe(1);
      expect(b.twitch.calls('POST /helix/eventsub/subscriptions').filter((r) => r.token === 'access-caster-2')).toEqual([]);
      expect(b.twitch.state.subscriptions.map((s) => s.type)).toEqual(BOT_SUB_TYPES);
      // The bot itself keeps running
      expect(b.exitCodes()).toEqual([]);
      expect(irc().isConnected()).toBe(true);
    });
  });

  describe('expired bot token at start', () => {
    it('refreshes it, saves it to .env and continues with the new token', async () => {
      const b = await start({ botTokenTtlSec: 0 });
      expect(b.twitch.calls('POST /oauth2/token')).toHaveLength(1);
      const refreshed = b.twitch.calls('POST /oauth2/token')[0].body as Record<string, string>;
      expect(refreshed).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'refresh-excella_bot-1' });
      const env = envFile(b);
      expect(env.TWITCH_ACCESS_TOKEN).toMatch(/^refreshed-access-\d+$/);
      expect(env.TWITCH_REFRESH_TOKEN).toBe('refresh-excella_bot-1');
      const subs = b.twitch.state.subscriptions;
      expect(subs.map((s) => s.type)).toEqual(BOT_SUB_TYPES);
      expect(subs.every((s) => s.token === env.TWITCH_ACCESS_TOKEN)).toBe(true);
      expect(irc().client!.opts.identity.password).toBe(`oauth:${env.TWITCH_ACCESS_TOKEN}`);
      expect(b.exitCodes()).toEqual([]);
    });
  });

  describe('unrecoverable bot token', () => {
    it('exits with code 1 before init, IRC or EventSub', async () => {
      const b = await start({
        botTokenTtlSec: 0,
        seed: (t) => t.state.failures.set('POST /oauth2/token', { status: 400, message: 'Invalid refresh token' })
      });
      expect(b.exitCodes()).toEqual([1]);
      expect(lines(errorSpy)).toContain('✗ Failed to refresh bot token. Please visit http://localhost:3000 to generate new tokens.');
      expect(irc().client).toBeNull();
      expect(b.twitch.eventSubSessions()).toBe(0);
      expect(b.twitch.state.subscriptions).toEqual([]);
      expect(b.twitch.calls('GET /helix/users')).toEqual([]);
      expect(b.dashboardCalls()).toEqual([]);
    });
  });

  describe('missing scopes', () => {
    it('warns per feature, still connects, and disables bot EventSub when broadcaster-level scopes are missing', async () => {
      const scopes = ALL_SCOPES.filter((s) => s !== 'clips:edit' && s !== 'bits:read');
      const b = await start({ botScopes: scopes });
      const warns = lines(warnSpy);
      expect(warns).toEqual(expect.arrayContaining([
        '\n⚠️  MISSING REQUIRED SCOPES DETECTED',
        'NOTE: You are using a single account setup. Your bot token needs broadcaster-level scopes.',
        'The following features may not work correctly:',
        '- Clips: Missing clips:edit',
        '- EventSub Alerts: Missing bits:read',
        '- Bits Tracking: Missing bits:read',
        '\nTo fix this, please re-authorize your accounts using the Token Generator:',
        '👉 http://localhost:3000\n',
        'EventSub disabled: token scopes lack required permissions. Re-authorize with proper scopes.'
      ]));
      expect(b.twitch.state.subscriptions).toEqual([]);
      expect(b.twitch.eventSubSessions()).toBe(0);
      expect(irc().isConnected()).toBe(true);
      expect(b.exitCodes()).toEqual([]);
      // The missing scopes are not written into .env: it keeps listing only what the token has
      const env = envFile(b);
      expect(env.TWITCH_SCOPES.split(' ')).not.toContain('clips:edit');
      expect(env.TWITCH_SCOPES.split(' ')).not.toContain('bits:read');
      expect(lines(logSpy).some((l) => l.startsWith('  - Added to bot'))).toBe(false);
    });

    it('uses TOKEN_GENERATOR_PORT in the re-authorize hint', async () => {
      await start({ botScopes: ALL_SCOPES.filter((s) => s !== 'clips:edit'), env: { TOKEN_GENERATOR_PORT: '4555' } });
      expect(lines(warnSpy)).toContain('👉 http://localhost:4555\n');
    });
  });

  describe('broadcaster user lookup failure', () => {
    it('logs a clear error and exits with code 1 before IRC, EventSub and the command refresh timer', async () => {
      const b = await start({ env: { TWITCH_BROADCASTER_NAME: 'ghost' } });
      expect(lines(errorSpy)).toEqual(expect.arrayContaining([
        'Failed to initialize bot: Broadcaster "ghost" not found. Check your .env TWITCH_BROADCASTER_NAME',
        '✗ Failed to initialize broadcaster ID. Check TWITCH_BROADCASTER_NAME and the bot token, then restart the bot.'
      ]));
      // No zombie process: it exits non-zero so a process manager notices
      expect(b.exitCodes()).toEqual([1]);
      expect(irc().client).toBeNull();
      expect(b.twitch.eventSubSessions()).toBe(0);
      expect(b.dashboardCalls()).toEqual([]);
      await b.advance(5 * 60 * 1000);
      expect(b.dashboardCalls()).toEqual([]);
      // Only the broadcaster lookup ran; the token-user lookup comes after the failing check
      expect(b.twitch.calls('GET /helix/users').map((r) => r.query)).toEqual([{ login: 'ghost' }]);
    });

    it('treats a Helix /users failure the same way as an unknown broadcaster', async () => {
      const b = await start({
        seed: (t) => t.state.failures.set('GET /helix/users', { status: 500, message: 'boom' })
      });
      expect(lines(errorSpy)).toContain('Failed to initialize bot: Broadcaster "caster" not found. Check your .env TWITCH_BROADCASTER_NAME');
      expect(irc().client).toBeNull();
      expect(b.exitCodes()).toEqual([1]);
    });
  });

  describe('EventSub subscription failure', () => {
    it('logs a failed subscription and continues with the rest', async () => {
      const b = await start({
        seed: (t) => t.state.failures.set('POST /helix/eventsub/subscriptions', { status: 500, message: 'nope', times: 1 })
      });
      expect(b.twitch.calls('POST /helix/eventsub/subscriptions')).toHaveLength(2);
      expect(b.twitch.state.subscriptions.map((s) => s.type)).toEqual(['stream.offline']);
      expect(lines(warnSpy)).toContain('[EventSub-Bot] Stream online subscription failed: Request failed with status code 500');
      expect(lines(errorSpy)).toContain('[EventSub-WS] Failed to subscribe to stream.online: nope');
      expect(lines(logSpy)).toContain('✓ Bot EventSub listener initialized successfully');
      expect(irc().isConnected()).toBe(true);
    });
  });

  describe('periodic custom command refresh', () => {
    it('reloads custom commands from the dashboard every 60s by default', async () => {
      const b = await start();
      const gets = () => b.dashboardCalls().filter((c) => c.route === 'GET /api/custom-commands').length;
      expect(gets()).toBe(1);
      b.writeData('customCommands.json', [{ name: '!hello', response: 'Hello {user}!' }]);
      // Still the cached (empty) list
      expect(await b.chat('viewer1', '!hello')).toEqual([]);
      await b.advance(59_999);
      expect(gets()).toBe(1);
      await b.advance(1);
      expect(gets()).toBe(2);
      expect(await b.chat('viewer1', '!hello')).toEqual(['Hello viewer1!']);
      await b.advance(60_000);
      expect(gets()).toBe(3);
    });

    it('honours COMMAND_REFRESH_INTERVAL (seconds) and re-reads it on each cycle', async () => {
      const b = await start({ env: { COMMAND_REFRESH_INTERVAL: '10' } });
      const gets = () => b.dashboardCalls().filter((c) => c.route === 'GET /api/custom-commands').length;
      await b.advance(10_000);
      expect(gets()).toBe(2);
      // Changed at runtime (as POST /api/settings does): the already-scheduled timer still fires at 10s
      // and loads; the new 30s period applies from the next cycle on
      process.env.COMMAND_REFRESH_INTERVAL = '30';
      await b.advance(10_000);
      expect(gets()).toBe(3);
      await b.advance(29_999);
      expect(gets()).toBe(3);
      await b.advance(1);
      expect(gets()).toBe(4);
      // and shortening it takes effect after the current 30s cycle
      process.env.COMMAND_REFRESH_INTERVAL = '15';
      await b.advance(30_000);
      expect(gets()).toBe(5);
      await b.advance(15_000);
      expect(gets()).toBe(6);
    });

    it.each(['0', 'abc', '-5', ''])('falls back to the 60s default for COMMAND_REFRESH_INTERVAL=%p (no busy poll)', async (value) => {
      const b = await start({ env: { COMMAND_REFRESH_INTERVAL: value } });
      const gets = () => b.dashboardCalls().filter((c) => c.route === 'GET /api/custom-commands').length;
      await b.advance(1_000);
      expect(gets()).toBe(1);
      await b.advance(58_999);
      expect(gets()).toBe(1);
      await b.advance(1);
      expect(gets()).toBe(2);
    });

    it('raises a COMMAND_REFRESH_INTERVAL below 5s to the 5s minimum', async () => {
      const b = await start({ env: { COMMAND_REFRESH_INTERVAL: '0.001' } });
      const gets = () => b.dashboardCalls().filter((c) => c.route === 'GET /api/custom-commands').length;
      await b.advance(4_999);
      expect(gets()).toBe(1);
      await b.advance(1);
      expect(gets()).toBe(2);
    });

    it('keeps the cached commands when the dashboard fails during a refresh', async () => {
      const b = await start({ dashboardData: { 'customCommands.json': [{ name: '!hi', response: 'hi there' }] } });
      expect(await b.chat('viewer1', '!hi')).toEqual(['hi there']);
      fs.writeFileSync(path.join(b.logsDir, 'customCommands.json'), '{not json');
      await b.advance(60_000);
      expect(lines(warnSpy)).toContain('⚠️  Dashboard unreachable, using cached commands (1)');
      expect(await b.chat('viewer1', '!hi')).toEqual(['hi there']);
    });
  });

  describe('restart.flag watcher', () => {
    // The watcher polls path.join(__dirname, 'dashboard', 'logs', 'restart.flag') in the real repo.
    // To avoid touching the repo (and racing other suites' bots), fs.existsSync/unlinkSync are faked
    // for that one path only.
    function fakeRestartFlag(unlinkError?: Error) {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const realExists = nodeFs.existsSync;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const realUnlink = nodeFs.unlinkSync;
      let present = false;
      const exists = jest.spyOn(nodeFs, 'existsSync').mockImplementation((p: fs.PathLike) =>
        String(p) === RESTART_FLAG ? present : realExists(p));
      const unlink = jest.spyOn(nodeFs, 'unlinkSync').mockImplementation((p: fs.PathLike) => {
        if (String(p) !== RESTART_FLAG) return realUnlink(p);
        if (unlinkError) throw unlinkError;
        present = false;
      });
      return { set: (v: boolean) => { present = v; }, exists, unlink };
    }

    it('checks every 5s and exits with code 0 after removing the flag', async () => {
      const b = await start();
      const flag = fakeRestartFlag();
      await b.advance(4_000);
      expect(flag.exists.mock.calls.filter(([p]) => String(p) === RESTART_FLAG)).toHaveLength(0);
      await b.advance(1_000);
      expect(flag.exists.mock.calls.filter(([p]) => String(p) === RESTART_FLAG)).toHaveLength(1);
      expect(b.exitCodes()).toEqual([]);

      flag.set(true);
      // process.exit is mocked to throw, so the timer tick rejects
      await expect(b.advance(5_000)).rejects.toThrow('process.exit(0)');
      expect(b.exitCodes()).toEqual([0]);
      expect(flag.unlink).toHaveBeenCalledWith(RESTART_FLAG);
      expect(lines(logSpy)).toContain('🔄 Restart flag detected. Restarting bot...');
    });

    it('still exits with code 0 when the flag cannot be removed', async () => {
      const b = await start();
      const flag = fakeRestartFlag(new Error('EPERM'));
      flag.set(true);
      await expect(b.advance(5_000)).rejects.toThrow('process.exit(0)');
      expect(b.exitCodes()).toEqual([0]);
      expect(lines(errorSpy)).toContain('Failed to remove restart flag: EPERM');
    });
  });
});
