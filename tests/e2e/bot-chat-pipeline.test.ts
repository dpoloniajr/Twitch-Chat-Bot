/**
 * E2E characterization: the chatClient.onMessage pipeline in Excella.js
 * (chat logging, loyalty award, first-time chatter, command routing) and custom commands.
 * Chat filters and hype live in bot-chat-filters.test.ts.
 */
jest.mock('axios', () => require('./harness/redirect').axiosMock());
jest.mock('ws', () => require('./harness/redirect').wsMock());
jest.mock('tmi.js', () => require('./harness/redirect').tmiMock());
jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('../../src/lib/console-timestamp', () => ({}));

import * as fs from 'fs';
import * as path from 'path';
import { BotHarness, BotOptions } from './harness/bot';
import { loyaltyFile, silenceConsole, startReadyBot, talk } from './harness/loyalty-helpers';

interface LoyaltyUser {
  points: number;
  totalEarned?: number;
  isSubscriber?: boolean;
  isVip?: boolean;
  lastMessagePointsAt?: number | null;
}
interface LoyaltyData {
  users: Record<string, LoyaltyUser>;
  transactions: Array<{ username: string; amount: number; type: string; reason: string }>;
}
interface CustomCommand {
  name: string;
  response: string;
  level?: string;
  fetchEnabled?: boolean;
  fetchUrl?: string;
  cooldownSeconds?: number;
}

const COMMANDS_LIST = 'Commands: !commands | !clip | !followage [user] | !tts <message> | !sr <URL or query> | !song | !queue | !8ball | !dice [sides] | !coinflip | !balance [user] | !leaderboard | !gamba <amount|all> | !duel @user [stake] | !quote | !counter <name> | !hype | !shoutout [user] / !so [user] (mods) | !poll | !prediction | !title (mods) | !game (mods) | !addfilter (mods) | !removefilter (mods) | !filters (mods)';

describe('bot chat pipeline', () => {
  let bot: BotHarness | null = null;

  async function start(options: BotOptions = {}): Promise<BotHarness> {
    bot = await startReadyBot(options);
    return bot;
  }
  const routesSince = (b: BotHarness, from: number) => b.dashboardCalls().slice(from).map((c) => c.route);
  const custom = (cmds: CustomCommand[]): BotOptions => ({ dashboardData: { 'customCommands.json': cmds } });

  beforeEach(() => {
    silenceConsole();
  });
  afterEach(async () => {
    if (bot) await bot.stop();
    bot = null;
  });

  describe('chat logging and loyalty award', () => {
    it('posts every message to /api/chat and /api/loyalty/award-message, in that order', async () => {
      const b = await start();
      const before = b.dashboardCalls().length;
      expect(await talk(b, 'Viewer1', '  hello there  ')).toEqual([]);
      const calls = b.dashboardCalls().slice(before);
      expect(calls.map((c) => c.route)).toEqual(['POST /api/chat', 'POST /api/loyalty/award-message']);
      // The raw (untrimmed) message and the lowercased login are sent
      expect(calls[0].body).toEqual({ channel: 'caster', user: 'viewer1', message: '  hello there  ' });
      expect(calls[1].body).toEqual({ username: 'viewer1', isSubscriber: false, isVip: false });
    });

    it('passes subscriber and VIP flags from the IRC tags', async () => {
      const b = await start();
      await talk(b, 'subby', 'hi', { subscriber: true });
      await talk(b, 'vippy', 'hi', { vip: true });
      const awards = b.dashboardCalls().filter((c) => c.route === 'POST /api/loyalty/award-message').map((c) => c.body);
      expect(awards).toEqual([
        { username: 'subby', isSubscriber: true, isVip: false },
        { username: 'vippy', isSubscriber: false, isVip: true }
      ]);
    });

    it('awards points per message with sub/VIP multipliers and a per-user cooldown', async () => {
      const b = await start({ dashboardData: { 'loyalty.json': loyaltyFile({}, { pointsPerMessage: 5, messageCooldownSeconds: 30 }) } });
      await talk(b, 'plain', 'hi');
      await talk(b, 'subby', 'hi', { subscriber: true });
      await talk(b, 'vippy', 'hi', { vip: true });
      await talk(b, 'both', 'hi', { subscriber: true, vip: true });
      let data = b.readData<LoyaltyData>('loyalty.json');
      expect(data.users.plain).toEqual(expect.objectContaining({ points: 5, totalEarned: 5, isSubscriber: false, isVip: false }));
      expect(data.users.subby.points).toBe(10);
      expect(data.users.vippy.points).toBe(7); // floor(5 * 1.5)
      expect(data.users.both.points).toBe(10); // subscriber multiplier wins
      expect(data.transactions.map((t) => [t.username, t.amount, t.type, t.reason])).toEqual([
        ['plain', 5, 'earn', 'Chat message'], ['subby', 10, 'earn', 'Chat message'],
        ['vippy', 7, 'earn', 'Chat message'], ['both', 10, 'earn', 'Chat message']
      ]);

      await b.advance(29_000);
      await talk(b, 'plain', 'again');
      expect(b.readData<LoyaltyData>('loyalty.json').users.plain.points).toBe(5);
      await b.advance(1000);
      await talk(b, 'plain', 'again');
      data = b.readData<LoyaltyData>('loyalty.json');
      expect(data.users.plain.points).toBe(10);
    });

    it('caps message points at maxPointsPerMessage', async () => {
      const b = await start({ dashboardData: { 'loyalty.json': loyaltyFile({}, { pointsPerMessage: 40, maxPointsPerMessage: 50 }) } });
      await talk(b, 'subby', 'hi', { subscriber: true });
      expect(b.readData<LoyaltyData>('loyalty.json').users.subby.points).toBe(50);
    });

    it('awards nothing when loyalty is disabled', async () => {
      const b = await start({ dashboardData: { 'loyalty.json': loyaltyFile({}, { pointsPerMessage: 5, enabled: false }) } });
      await talk(b, 'plain', 'hi');
      expect(b.readData<LoyaltyData>('loyalty.json').users).toEqual({});
    });

    it('on a fresh install the first message creates loyalty.json and earns the default 5 points', async () => {
      const b = await start();
      expect(fs.existsSync(path.join(b.logsDir, 'loyalty.json'))).toBe(false);
      await talk(b, 'plain', 'hi');
      expect(b.readData<LoyaltyData>('loyalty.json').users.plain.points).toBe(5);
    });

    it('commands are logged to chat and awarded like any message', async () => {
      const b = await start();
      const before = b.dashboardCalls().length;
      await talk(b, 'viewer1', '!coinflip');
      expect(routesSince(b, before).slice(0, 2)).toEqual(['POST /api/chat', 'POST /api/loyalty/award-message']);
    });
  });

  describe('first-time chatter', () => {
    it('welcomes with the display name and sends a first_chatter alert', async () => {
      const b = await start();
      const before = b.dashboardCalls().length;
      expect(await talk(b, 'newbie', 'hi all', { firstMsg: true, displayName: 'NewBie' })).toEqual(['Welcome to the chat, NewBie!']);
      const alert = b.dashboardCalls().slice(before).find((c) => c.route === 'POST /api/test-alert');
      expect(alert?.body).toEqual({ alertType: 'first_chatter', user: 'NewBie' });
    });

    it('does nothing special for a normal message', async () => {
      const b = await start();
      const before = b.dashboardCalls().length;
      expect(await talk(b, 'regular', 'hi all')).toEqual([]);
      expect(routesSince(b, before)).not.toContain('POST /api/test-alert');
    });

    it('uses FIRST_CHATTER_MESSAGE with a case-insensitive {user} placeholder', async () => {
      const b = await start({ env: { FIRST_CHATTER_MESSAGE: '  Hey {USER}, meet {user}!  ' } });
      expect(await talk(b, 'newbie', 'hi', { firstMsg: true })).toEqual(['Hey newbie, meet newbie!']);
    });

    it.each(['false', '0', 'no', 'OFF'])('FIRST_CHATTER_WELCOME_ENABLED=%s keeps only the alert', async (value) => {
      const b = await start({ env: { FIRST_CHATTER_WELCOME_ENABLED: value } });
      const before = b.dashboardCalls().length;
      expect(await talk(b, 'newbie', 'hi', { firstMsg: true })).toEqual([]);
      expect(routesSince(b, before)).toContain('POST /api/test-alert');
    });

    it('FIRST_CHATTER_ALERT_ENABLED=false keeps only the welcome', async () => {
      const b = await start({ env: { FIRST_CHATTER_ALERT_ENABLED: 'false' } });
      const before = b.dashboardCalls().length;
      expect(await talk(b, 'newbie', 'hi', { firstMsg: true })).toEqual(['Welcome to the chat, newbie!']);
      expect(routesSince(b, before)).not.toContain('POST /api/test-alert');
    });

    it('an empty FIRST_CHATTER_MESSAGE falls back to the default text', async () => {
      // `(process.env.FIRST_CHATTER_MESSAGE || default)`: an empty string means "use the default"
      const b = await start({ env: { FIRST_CHATTER_MESSAGE: '' } });
      expect(await talk(b, 'newbie', 'hi', { firstMsg: true })).toEqual(['Welcome to the chat, newbie!']);
    });

    it('welcomes before running a command in the same first message', async () => {
      const b = await start();
      jest.spyOn(Math, 'random').mockReturnValue(0.1);
      expect(await talk(b, 'newbie', '!coinflip', { firstMsg: true })).toEqual([
        'Welcome to the chat, newbie!', '@newbie flipped a coin and got Heads.'
      ]);
    });
  });

  describe('command routing', () => {
    it('ignores ordinary messages and unknown !commands', async () => {
      const b = await start();
      expect(await talk(b, 'viewer1', 'just chatting')).toEqual([]);
      expect(await talk(b, 'viewer1', '!doesnotexist arg')).toEqual([]);
    });

    it('matches built-in commands case-insensitively and after leading whitespace', async () => {
      const b = await start({ dashboardData: { 'builtinCommands.json': [{ name: '!coinflip', cooldownSeconds: 0 }] } });
      expect(await talk(b, 'viewer1', '   !CoinFlip')).toEqual([expect.stringMatching(/^@viewer1 flipped a coin and got (Heads|Tails)\.$/)]);
    });

    it('rejects mod-only commands from viewers', async () => {
      const b = await start();
      for (const cmd of ['!title x', '!game x', '!addfilter x', '!removefilter x', '!filters', '!reloadcommands', '!so x', '!poll']) {
        expect(await talk(b, 'viewer1', cmd)).toEqual(['@viewer1 Only moderators can use this command.']);
      }
    });

    it('treats subscribers and VIPs as viewers for mod-only commands', async () => {
      const b = await start();
      expect(await talk(b, 'vip1', '!filters', { vip: true, subscriber: true })).toEqual(['@vip1 Only moderators can use this command.']);
    });

    it('lets the broadcaster (badge) and mods use mod-only commands', async () => {
      const b = await start();
      expect(await talk(b, 'caster', '!filters', { broadcaster: true })).toEqual([expect.stringMatching(/^Filters: /)]);
      expect(await talk(b, 'mod1', '!filters', { mod: true })).toEqual([expect.stringMatching(/^Filters: /)]);
    });
  });

  describe('!commands', () => {
    it('lists the built-in commands, repeatedly with the default 0s cooldown', async () => {
      const b = await start();
      expect(await talk(b, 'viewer1', '!commands')).toEqual([COMMANDS_LIST]);
      expect(await talk(b, 'viewer2', '!commands extra args')).toEqual([COMMANDS_LIST]);
    });

    it('is silent while on cooldown', async () => {
      const b = await start({ dashboardData: { 'builtinCommands.json': [{ name: '!commands', cooldownSeconds: 30 }] } });
      expect(await talk(b, 'viewer1', '!commands')).toEqual([COMMANDS_LIST]);
      expect(await talk(b, 'viewer2', '!commands')).toEqual([]);
      await b.advance(29_999);
      expect(await talk(b, 'viewer2', '!commands')).toEqual([]);
      await b.advance(1);
      expect(await talk(b, 'viewer2', '!commands')).toEqual([COMMANDS_LIST]);
    });

    it('picks up cooldown edits in builtinCommands.json on the next command refresh', async () => {
      const b = await start();
      const cmds = b.readData<Array<{ name: string; cooldownSeconds: number }>>('builtinCommands.json');
      b.writeData('builtinCommands.json', cmds.map((c) => (c.name === '!commands' ? { ...c, cooldownSeconds: 60 } : c)));
      expect(await talk(b, 'viewer1', '!commands')).toEqual([COMMANDS_LIST]);
      expect(await talk(b, 'viewer1', '!commands')).toEqual([COMMANDS_LIST]);
      await b.advance(60_000);
      expect(await talk(b, 'viewer1', '!commands')).toEqual([COMMANDS_LIST]);
      expect(await talk(b, 'viewer1', '!commands')).toEqual([]);
    });
  });

  describe('custom commands', () => {
    it('loads custom commands from the dashboard (logs/customCommands.json) at startup', async () => {
      const b = await start(custom([{ name: '!hello', response: 'Hello {user} aka {displayname} in {channel} -> {target}!' }]));
      expect(b.dashboardCalls().map((c) => c.route)).toContain('GET /api/custom-commands');
      expect(await talk(b, 'viewer1', '!hello @friend extra', { displayName: 'ViewerOne' })).toEqual([
        'Hello viewer1 aka ViewerOne in caster -> @friend!'
      ]);
    });

    it('matches names case-insensitively, including stored uppercase names', async () => {
      const b = await start(custom([{ name: '!Upper', response: 'up' }, { name: '!lower', response: 'low' }]));
      expect(await talk(b, 'viewer1', '!UPPER')).toEqual(['up']);
      expect(await talk(b, 'viewer1', '!LoWeR')).toEqual(['low']);
    });

    it('supports names without "!" (matched against the first word of any message)', async () => {
      const b = await start(custom([{ name: 'hi', response: 'Hi {user}!' }]));
      expect(await talk(b, 'viewer1', 'HI everyone')).toEqual(['Hi viewer1!']);
      expect(await talk(b, 'viewer1', 'well hi')).toEqual([]);
    });

    it('empty placeholders render as empty strings and the result is trimmed', async () => {
      const b = await start(custom([{ name: '!t', response: '  target={target}.  ' }]));
      expect(await talk(b, 'viewer1', '!t')).toEqual(['target=.']);
    });

    it('an empty response with no fetch says nothing', async () => {
      const b = await start(custom([{ name: '!empty', response: '   ' }]));
      expect(await talk(b, 'viewer1', '!empty')).toEqual([]);
    });

    it('built-in commands shadow custom commands with the same name', async () => {
      const b = await start(custom([{ name: '!coinflip', response: 'custom flip' }]));
      expect(await talk(b, 'viewer1', '!coinflip')).toEqual([expect.stringMatching(/^@viewer1 flipped a coin/)]);
    });

    it('enforces the "mod" level: viewers are refused, mods and the broadcaster may run it', async () => {
      const b = await start(custom([{ name: '!secret', response: 'mods only', level: 'mod' }]));
      expect(await talk(b, 'viewer1', '!secret')).toEqual(['@viewer1 Only moderators can use this command.']);
      expect(await talk(b, 'vip1', '!secret', { vip: true, subscriber: true })).toEqual(['@vip1 Only moderators can use this command.']);
      expect(await talk(b, 'mod1', '!secret', { mod: true })).toEqual(['mods only']);
      expect(await talk(b, 'caster', '!secret', { broadcaster: true })).toEqual(['mods only']);
    });

    it('enforces the "broadcaster" level: only the broadcaster may run it', async () => {
      const b = await start(custom([{ name: '!owner', response: 'owner only', level: 'broadcaster' }]));
      expect(await talk(b, 'mod1', '!owner', { mod: true })).toEqual(['@mod1 Only the broadcaster can use this command.']);
      expect(await talk(b, 'caster', '!owner', { broadcaster: true })).toEqual(['owner only']);
    });

    it('treats "everyone", a missing level and unknown levels as open to all', async () => {
      const b = await start(custom([
        { name: '!a', response: 'a', level: 'everyone' }, { name: '!b', response: 'b' }, { name: '!c', response: 'c', level: 'weird' }
      ]));
      expect(await talk(b, 'viewer1', '!a')).toEqual(['a']);
      expect(await talk(b, 'viewer1', '!b')).toEqual(['b']);
      expect(await talk(b, 'viewer1', '!c')).toEqual(['c']);
    });

    it('enforces cooldownSeconds channel-wide, silently, and per command', async () => {
      const b = await start(custom([{ name: '!lurk', response: 'lurking', cooldownSeconds: 15 }, { name: '!other', response: 'other', cooldownSeconds: 15 }]));
      expect(await talk(b, 'viewer1', '!lurk')).toEqual(['lurking']);
      expect(await talk(b, 'viewer2', '!LURK')).toEqual([]);
      expect(await talk(b, 'mod1', '!lurk', { mod: true })).toEqual([]);
      expect(await talk(b, 'viewer2', '!other')).toEqual(['other']);
      await b.advance(14_999);
      expect(await talk(b, 'viewer2', '!lurk')).toEqual([]);
      await b.advance(1);
      expect(await talk(b, 'viewer2', '!lurk')).toEqual(['lurking']);
    });

    it('a refused or failed run does not start the cooldown', async () => {
      const b = await start(custom([
        { name: '!m', response: 'm', level: 'mod', cooldownSeconds: 30 },
        { name: '!f', response: '{data}', fetchEnabled: true, fetchUrl: 'https://api.twitch.tv/external/f', cooldownSeconds: 30 }
      ]));
      expect(await talk(b, 'viewer1', '!m')).toEqual(['@viewer1 Only moderators can use this command.']);
      expect(await talk(b, 'mod1', '!m', { mod: true })).toEqual(['m']);
      b.twitch.state.failures.set('GET /external/f', { status: 500, message: 'boom', times: 1 });
      expect(await talk(b, 'viewer1', '!f')).toEqual(['@viewer1 Error: Failed to fetch URL: Request failed with status code 500']);
      expect(await talk(b, 'viewer1', '!f')).toEqual(['external f']);
      expect(await talk(b, 'viewer1', '!f')).toEqual([]);
    });

    it('fetches {data} from fetchUrl when fetchEnabled', async () => {
      const b = await start(custom([{ name: '!joke', response: 'Joke: {data}', fetchEnabled: true, fetchUrl: 'https://api.twitch.tv/external/joke' }]));
      expect(await talk(b, 'viewer1', '!joke')).toEqual(['Joke: external joke']);
      expect(b.twitch.calls('GET /external/joke')).toHaveLength(1);
    });

    it('an empty response with fetch defaults to "{data}"', async () => {
      const b = await start(custom([{ name: '!raw', response: '', fetchEnabled: true, fetchUrl: 'https://api.twitch.tv/external/raw' }]));
      expect(await talk(b, 'viewer1', '!raw')).toEqual(['external raw']);
    });

    it('JSON responses are stringified into {data}', async () => {
      const b = await start({
        ...custom([{ name: '!yt', response: 'YT {data}', fetchEnabled: true, fetchUrl: 'https://www.googleapis.com/youtube/v3/search?q=nothing' }]),
        env: { YOUTUBE_API_KEY: 'k' }
      });
      const [line] = await talk(b, 'viewer1', '!yt');
      expect(line.startsWith('YT {')).toBe(true);
      expect(() => JSON.parse(line.slice(3))).not.toThrow();
    });

    it('does not fetch when fetchEnabled is false', async () => {
      const b = await start(custom([{ name: '!nofetch', response: 'data={data}', fetchEnabled: false, fetchUrl: 'https://api.twitch.tv/external/x' }]));
      expect(await talk(b, 'viewer1', '!nofetch')).toEqual(['data=']);
      expect(b.twitch.calls('GET /external/x')).toHaveLength(0);
    });

    it.each([
      ['http://localhost:1234/x'],
      ['http://127.0.0.1/x'],
      ['http://10.0.0.5/x'],
      ['http://172.16.0.1/x'],
      ['http://192.168.1.1/x'],
      ['http://169.254.169.254/latest'],
      ['http://0.0.0.0/x'],
      ['http://2130706433/x'],
      ['http://[::1]/x'],
      ['http://[::]/x'],
      ['http://[::ffff:127.0.0.1]/x'],
      ['http://[fd12:3456::1]/x'],
      ['http://[fe80::1]/x'],
      ['http://LOCALHOST./x'],
      ['http://foo.localhost/x']
    ])('blocks internal URL %s', async (url) => {
      const b = await start(custom([{ name: '!ssrf', response: '{data}', fetchEnabled: true, fetchUrl: url }]));
      expect(await talk(b, 'viewer1', '!ssrf')).toEqual(['@viewer1 Error: Internal URLs are not allowed']);
    });

    it('reports fetch failures and invalid URLs', async () => {
      const b = await start(custom([
        { name: '!down', response: '{data}', fetchEnabled: true, fetchUrl: 'https://api.twitch.tv/external/down' },
        { name: '!bad', response: '{data}', fetchEnabled: true, fetchUrl: 'not a url' }
      ]));
      b.twitch.state.failures.set('GET /external/down', { status: 500, message: 'boom' });
      expect(await talk(b, 'viewer1', '!down')).toEqual(['@viewer1 Error: Failed to fetch URL: Request failed with status code 500']);
      expect(await talk(b, 'viewer1', '!bad')).toEqual(['@viewer1 Error: Failed to fetch URL: Invalid URL']);
    });

    it.each([['10.0.0.7', 4], ['127.0.0.1', 4], ['fd00::5', 6], ['::ffff:a9fe:a9fe', 6]])(
      'blocks a hostname that resolves to the internal address %s (checked when connecting)', async (address, family) => {
        const b = await start(custom([{ name: '!dns', response: '{data}', fetchEnabled: true, fetchUrl: 'http://innocent.example.test/x' }]));
        // The CommonJS exports object, so the spy is seen through every import of 'dns'
        const lookup = jest.spyOn(require('dns') as typeof import('dns'), 'lookup').mockImplementation(((_host: string, _opts: unknown, cb: (...a: unknown[]) => void) => {
          cb(null, [{ address: '93.184.216.34', family: 4 }, { address, family }]);
        }) as never);
        expect(await talk(b, 'viewer1', '!dns')).toEqual(['@viewer1 Error: Internal URLs are not allowed']);
        expect(lookup).toHaveBeenCalledWith('innocent.example.test', expect.objectContaining({ all: true }), expect.any(Function));
      });

    it('refuses non-http(s) fetch URLs', async () => {
      const b = await start(custom([{ name: '!ftp', response: '{data}', fetchEnabled: true, fetchUrl: 'file:///etc/passwd' }]));
      expect(await talk(b, 'viewer1', '!ftp')).toEqual(['@viewer1 Error: Only http(s) URLs are allowed']);
    });

    it('picks up file changes only after the 60s refresh interval', async () => {
      const b = await start(custom([{ name: '!one', response: 'one' }]));
      b.writeData('customCommands.json', [{ name: '!one', response: 'one' }, { name: '!two', response: 'two' }]);
      expect(await talk(b, 'viewer1', '!two')).toEqual([]);
      await b.advance(60_000);
      expect(await talk(b, 'viewer1', '!two')).toEqual(['two']);
    });

    it('honours COMMAND_REFRESH_INTERVAL (seconds)', async () => {
      const b = await start({ ...custom([]), env: { COMMAND_REFRESH_INTERVAL: '10' } });
      b.writeData('customCommands.json', [{ name: '!two', response: 'two' }]);
      await b.advance(10_000);
      expect(await talk(b, 'viewer1', '!two')).toEqual(['two']);
    });

    it('!reloadcommands (mod) reloads immediately and reports the counts', async () => {
      const b = await start(custom([{ name: '!one', response: 'one' }]));
      b.writeData('customCommands.json', [{ name: '!one', response: 'one' }, { name: '!two', response: 'two' }]);
      expect(await talk(b, 'mod1', '!reloadcommands', { mod: true })).toEqual(['@mod1 Reloaded custom commands (1 → 2)']);
      expect(await talk(b, 'viewer1', '!two')).toEqual(['two']);
    });

    it('!reloadcommands with an unreadable file keeps the loaded commands and says so', async () => {
      const b = await start(custom([{ name: '!one', response: 'one' }]));
      fs.writeFileSync(path.join(b.logsDir, 'customCommands.json'), '{ broken');
      expect(await talk(b, 'mod1', '!reloadcommands', { mod: true })).toEqual([
        '@mod1 Could not reload custom commands from the dashboard; keeping the 1 loaded.'
      ]);
      expect(await talk(b, 'viewer1', '!one')).toEqual(['one']);
      // A later successful reload still works
      b.writeData('customCommands.json', [{ name: '!two', response: 'two' }]);
      expect(await talk(b, 'mod1', '!reloadcommands', { mod: true })).toEqual(['@mod1 Reloaded custom commands (1 → 1)']);
      expect(await talk(b, 'viewer1', '!two')).toEqual(['two']);
    });

    it('a failed periodic refresh keeps the cached commands', async () => {
      const b = await start(custom([{ name: '!one', response: 'one' }]));
      fs.writeFileSync(path.join(b.logsDir, 'customCommands.json'), '{ broken');
      await b.advance(60_000);
      expect(await talk(b, 'viewer1', '!one')).toEqual(['one']);
    });
  });
});
