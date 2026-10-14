/**
 * Unit tests for the bot factory (src/bot/create-bot.ts) with every client
 * injected as a fake: no network, no process.env, no load-time side effects.
 * Bot behavior itself is characterized end to end in tests/e2e/bot-*.test.ts.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createBot, type Bot } from '../../src/bot/create-bot';
import type { BotDeps, ChatMessage } from '../../src/bot/context';
import {
  isCompleteConfig,
  parseAccountArg,
  readBotConfig,
  readHypeSettings,
  readChatFilterSettings,
  readCommandRefreshMs,
  readFirstChatterSettings
} from '../../src/bot/config';
import { isTTSReward } from '../../src/bot/eventsub';
import { parseBlockTarget } from '../../src/bot/song-requests';
import type { MessageHandler } from '../../src/lib/twitch-irc-client';

type Handler = MessageHandler;

function fakeChat() {
  const chat = {
    said: [] as Array<{ channel: string; message: string }>,
    handlers: [] as Handler[],
    connect: jest.fn(async () => true),
    disconnect: jest.fn(async () => {}),
    updateToken: jest.fn(async () => {}),
    say: jest.fn((channel: string, message: string) => { chat.said.push({ channel, message }); }),
    onMessage: jest.fn((h: Handler) => { chat.handlers.push(h); }),
    onConnect: jest.fn(),
    onDisconnect: jest.fn()
  };
  return chat;
}

function fakeHttp(routes: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const respond = (method: string) => jest.fn(async (url: string, body?: unknown) => {
    calls.push({ method, url, body });
    const key = Object.keys(routes).find((k) => url.endsWith(k));
    return { data: key ? routes[key] : [] };
  });
  return { calls, get: respond('GET'), post: respond('POST'), put: respond('PUT'), patch: respond('PATCH'), delete: respond('DELETE') };
}

function message(user: string, mod = false): ChatMessage {
  return {
    userInfo: {
      userName: user, displayName: user, userId: '77', isMod: mod, isBroadcaster: false,
      isSubscriber: false, isVip: false, color: undefined, badges: {}, badgeInfo: {}
    },
    id: 'm1', channelId: '1001', emotes: [], isFirst: false, isReturningChatter: false
  };
}

describe('createBot', () => {
  let dir: string;
  let bot: Bot | null = null;
  let chat: ReturnType<typeof fakeChat>;
  let http: ReturnType<typeof fakeHttp>;
  let exit: jest.Mock;
  let flagPresent: boolean;
  const savedBackupDir = process.env.BACKUP_DIR;

  function deps(env: Record<string, string> = {}): BotDeps {
    chat = fakeChat();
    http = fakeHttp({ '/api/builtin-commands': [], '/api/custom-commands': [{ name: '!hi', response: 'hello {user}' }] });
    exit = jest.fn(() => { throw new Error('exit'); });
    const scopes = ['chat:read', 'chat:edit'];
    return {
      env: { ENV_PATH: path.join(dir, '.env'), DISABLE_EVENTSUB: '1', ...env },
      config: {
        clientId: 'cid', clientSecret: 'secret', accessToken: 'tok', refreshToken: 'ref',
        channels: ['caster'], broadcasterName: 'caster', scopes
      },
      http: http as never,
      rawHttp: { get: jest.fn(), patch: jest.fn() } as never,
      tokenManager: {
        cache: {
          bot: { lastCheck: 0, isValid: true, expiresAt: 0, scopes },
          broadcaster: { lastCheck: 0, isValid: false, expiresAt: 0, scopes: [] }
        },
        hasToken: (t: string) => t === 'bot',
        ensureValid: jest.fn(async () => true),
        scheduleProactiveRefresh: jest.fn(),
        onRefreshed: jest.fn(),
        validate: jest.fn(async () => true),
        refresh: jest.fn(async () => null),
        stop: jest.fn()
      } as never,
      apiClient: {
        getTokenInfo: jest.fn(async () => ({ userId: '2002' })),
        getUserByName: jest.fn(async () => ({ id: '1001', login: 'caster', name: 'caster' })),
        getUserById: jest.fn(async () => ({ id: '2002', login: 'excella_bot', name: 'excella_bot' })),
        setAccessToken: jest.fn()
      } as never,
      broadcasterApiClient: null,
      chatClient: chat as never,
      createBroadcasterApiClient: jest.fn() as never,
      createEventSub: jest.fn() as never,
      restartFlagPath: path.join(dir, 'restart.flag'),
      exit: exit as never,
      fs: { existsSync: () => flagPresent, unlinkSync: jest.fn(() => { flagPresent = false; }) }
    };
  }

  async function flush(until: () => boolean = () => false) {
    for (let i = 0; i < 200 && !until(); i++) {
      await jest.advanceTimersByTimeAsync(0);
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'create-bot-'));
    fs.writeFileSync(path.join(dir, '.env'), 'TWITCH_SCOPES=chat:read chat:edit\n');
    process.env.BACKUP_DIR = path.join(dir, 'backups');
    flagPresent = false;
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    if (bot) await bot.stop();
    bot = null;
    jest.clearAllTimers();
    jest.useRealTimers();
    if (savedBackupDir === undefined) delete process.env.BACKUP_DIR;
    else process.env.BACKUP_DIR = savedBackupDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('has no side effects until start(): no timers, no requests, no connection', () => {
    bot = createBot(deps());
    expect(jest.getTimerCount()).toBe(0);
    expect(http.calls).toEqual([]);
    expect(chat.connect).not.toHaveBeenCalled();
    // Handlers are wired so nothing is missed once connected
    expect(chat.onMessage).toHaveBeenCalledTimes(1);
    expect(bot.ctx.state.initComplete).toBe(false);
  });

  it('start() validates tokens, resolves ids, loads commands and connects', async () => {
    const d = deps();
    bot = createBot(d);
    await bot.start();
    expect(d.tokenManager.ensureValid).toHaveBeenCalledWith('bot');
    expect(d.tokenManager.scheduleProactiveRefresh).toHaveBeenCalled();
    expect(bot.ctx.state).toMatchObject({ broadcasterId: '1001', tokenUserId: '2002', initComplete: true });
    expect(bot.ctx.state.customCommands).toEqual([{ name: '!hi', response: 'hello {user}' }]);
    expect(chat.connect).toHaveBeenCalledTimes(1);
  });

  it('routes chat to built-in and custom commands', async () => {
    bot = createBot(deps());
    await bot.start();
    jest.spyOn(Math, 'random').mockReturnValue(0);
    await chat.handlers[0]('caster', 'viewer', '!dice 20', message('viewer'));
    await chat.handlers[0]('caster', 'viewer', '!hi', message('viewer'));
    await chat.handlers[0]('caster', 'viewer', '!title nope', message('viewer'));
    await flush();
    expect(chat.said.map((s) => s.message)).toEqual([
      '@viewer rolled a 20-sided die and got 1.',
      'hello viewer',
      '@viewer Only moderators can use this command.'
    ]);
  });

  it('keeps state per instance', async () => {
    const a = createBot(deps({ HYPE_MIN_MESSAGES: '50' }));
    const chatA = chat;
    const b = createBot(deps());
    expect(a.modules.hype.getHypeConfig().minMessages).toBe(50);
    expect(b.modules.hype.getHypeConfig().minMessages).toBe(15);
    await a.modules.filter.addFilterWord('bad');
    expect(a.modules.filter.getFilterStatus().blacklistWords).toEqual(['bad']);
    expect(b.modules.filter.getFilterStatus().blacklistWords).toEqual([]);
    expect(chatA).not.toBe(chat);
  });

  it('exits with code 1 when the bot token cannot be made valid', async () => {
    const d = deps();
    (d.tokenManager.ensureValid as jest.Mock).mockResolvedValue(false);
    bot = createBot(d);
    await expect(bot.start()).rejects.toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    expect(chat.connect).not.toHaveBeenCalled();
  });

  it('logs in to chat as the bot token\'s login, not the broadcaster name', async () => {
    const d = deps();
    (d.apiClient.getTokenInfo as jest.Mock).mockResolvedValue({ userId: '2002', login: 'excella_bot' });
    (chat as unknown as { username: string }).username = 'caster';
    bot = createBot(d);
    await bot.start();
    expect((chat as unknown as { username: string }).username).toBe('excella_bot');
    expect(chat.connect).toHaveBeenCalledTimes(1);
  });

  it('exits with code 1 when the broadcaster cannot be resolved', async () => {
    const d = deps();
    (d.apiClient.getUserByName as jest.Mock).mockResolvedValue(null);
    bot = createBot(d);
    await expect(bot.start()).rejects.toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith('✗ Failed to initialize broadcaster ID. Check TWITCH_BROADCASTER_NAME and the bot token, then restart the bot.');
    expect(chat.connect).not.toHaveBeenCalled();
  });

  it('watches the injected restart flag every 5s and exits with 0', async () => {
    const d = deps();
    bot = createBot(d);
    await bot.start();
    flagPresent = true;
    expect(() => jest.advanceTimersByTime(5000)).toThrow('exit');
    expect(d.fs.unlinkSync).toHaveBeenCalledWith(path.join(dir, 'restart.flag'));
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('stop() clears its timers and disconnects', async () => {
    const d = deps();
    bot = createBot(d);
    await bot.start();
    expect(jest.getTimerCount()).toBe(2); // restart watcher + custom command refresh
    await bot.stop();
    bot = null;
    expect(jest.getTimerCount()).toBe(0);
    expect(d.tokenManager.stop).toHaveBeenCalled();
    expect(chat.disconnect).toHaveBeenCalled();
  });
});

describe('bot config', () => {
  it('parses --account', () => {
    expect(parseAccountArg(['--account', 'main'])).toBe('main');
    expect(parseAccountArg(['--account'])).toBeNull();
    expect(parseAccountArg([])).toBeNull();
  });

  it('requires every credential', () => {
    const env = {
      TWITCH_CLIENT_ID: 'a', TWITCH_CLIENT_SECRET: 'b', TWITCH_ACCESS_TOKEN: 'c',
      TWITCH_REFRESH_TOKEN: 'd', TWITCH_BROADCASTER_NAME: 'e'
    };
    expect(isCompleteConfig(readBotConfig(env))).toBe(true);
    expect(isCompleteConfig(readBotConfig({ ...env, TWITCH_ACCESS_TOKEN: '' }))).toBe(false);
    expect(readBotConfig(env)).toMatchObject({ channels: [], scopes: ['chat:read', 'chat:edit'] });
    expect(readBotConfig({ ...env, TWITCH_CHANNELS: 'a,,b', TWITCH_SCOPES: 'x  y' })).toMatchObject({
      channels: ['a', 'b'], scopes: ['x', 'y']
    });
  });

  it('reads COMMAND_REFRESH_INTERVAL in seconds with a 60s default and a 5s minimum', () => {
    expect(readCommandRefreshMs({})).toBe(60_000);
    expect(readCommandRefreshMs({ COMMAND_REFRESH_INTERVAL: '10' })).toBe(10_000);
    expect(readCommandRefreshMs({ COMMAND_REFRESH_INTERVAL: '5' })).toBe(5_000);
    for (const bad of ['0', '-1', 'abc', '', 'NaN', 'Infinity']) {
      expect(readCommandRefreshMs({ COMMAND_REFRESH_INTERVAL: bad })).toBe(60_000);
    }
    expect(readCommandRefreshMs({ COMMAND_REFRESH_INTERVAL: '1' })).toBe(5_000);
    expect(readCommandRefreshMs({ COMMAND_REFRESH_INTERVAL: '0.5' })).toBe(5_000);
  });

  it('reads feature settings with the same defaults and clamps as the original bot', () => {
    expect(readHypeSettings({})).toEqual({ enabled: true, minMessages: 15, windowSec: 60, cooldownSec: 120, message: 'Chat is HYPED! 🔥' });
    expect(readHypeSettings({ HYPE_MIN_MESSAGES: '2', HYPE_COOLDOWN_SEC: '5', HYPE_ENABLED: '0' })).toMatchObject({
      enabled: false, minMessages: 5, cooldownSec: 30
    });
    expect(readChatFilterSettings({ CHAT_FILTER_WORDS: ' Foo | |bar', CHAT_FILTER_URLS: '1' })).toMatchObject({
      blacklistWords: new Set(['foo', 'bar']), filterUrls: true, filterAllCaps: false, timeoutDurationSeconds: 60, filterAction: 'warn'
    });
    expect(readFirstChatterSettings({ FIRST_CHATTER_WELCOME_ENABLED: 'OFF' })).toEqual({
      welcomeEnabled: false, welcomeMessage: 'Welcome to the chat, {user}!', alertEnabled: true
    });
  });
});

describe('isTTSReward', () => {
  it('matches "TTS" as a whole word in any case by default', () => {
    for (const title of ['TTS', 'tts', 'TTS Message', 'Send a TTS', 'TTS: speak!', ' Tts ']) {
      expect(isTTSReward(title, undefined)).toBe(true);
    }
    for (const title of ['Pet the Mutts', 'Buttsplosion', 'Text to Speech', 'TTSx', '']) {
      expect(isTTSReward(title, undefined)).toBe(false);
    }
  });

  it('with a configured title, matches only that title (ignoring case and spaces)', () => {
    expect(isTTSReward('Speak, Bot!', 'speak, bot!')).toBe(true);
    expect(isTTSReward('  SPEAK, BOT! ', 'Speak, Bot!')).toBe(true);
    expect(isTTSReward('TTS', 'Speak, Bot!')).toBe(false);
    // a blank setting falls back to the default
    expect(isTTSReward('TTS Message', '  ')).toBe(true);
  });
});

describe('parseBlockTarget', () => {
  it('reads channel ids, @handles, video URLs and keywords', () => {
    expect(parseBlockTarget('https://youtube.com/channel/UCabc')).toEqual({ type: 'channel', value: 'UCabc' });
    expect(parseBlockTarget('https://www.youtube.com/@Rick.Astley')).toEqual({ type: 'channel', value: 'Rick.Astley', handle: 'Rick.Astley' });
    expect(parseBlockTarget('https://youtu.be/dQw4w9WgXcQ')).toEqual({ type: 'video', value: 'dQw4w9WgXcQ' });
    expect(parseBlockTarget('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3')).toEqual({ type: 'video', value: 'dQw4w9WgXcQ' });
    expect(parseBlockTarget('https://youtube.com/feed/trending')).toEqual({ type: 'keyword', value: 'https://youtube.com/feed/trending' });
    expect(parseBlockTarget('baby shark')).toEqual({ type: 'keyword', value: 'baby shark' });
  });
});
