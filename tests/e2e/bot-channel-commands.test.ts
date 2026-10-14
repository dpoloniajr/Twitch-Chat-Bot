/**
 * Characterization tests: chat commands that call the Twitch Helix API
 * (!clip, !followage, !shoutout / !so, !title, !game, !poll, !prediction).
 */
jest.mock('axios', () => require('./harness/redirect').axiosMock());
jest.mock('ws', () => require('./harness/redirect').wsMock());
jest.mock('tmi.js', () => require('./harness/redirect').tmiMock());
jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('../../src/lib/console-timestamp', () => ({}));

import { startBot, BotHarness, BotOptions, BROADCASTER, BOT_USER } from './harness/bot';
import { ALL_SCOPES } from './harness/fake-twitch';
import { captureHttpHeaders, HeaderCapture, twitchPort, builtinCooldowns } from './harness/channel-commands-helpers';

const STREAMER = { id: '3003', login: 'streamer2', display_name: 'Streamer2' };
const VIEWER = { id: '4004', login: 'viewer1', display_name: 'Viewer1' };
const MOD = { mod: true } as const;

const BOT_TOKEN = /^access-excella_bot-\d+$/;
const CASTER_TOKEN = /^access-caster-\d+$/;
const DAY = 24 * 60 * 60 * 1000;

const without = (...scopes: string[]) => ALL_SCOPES.filter((s) => !scopes.includes(s));

describe('channel commands', () => {
  let bot: BotHarness | undefined;
  let headers: HeaderCapture;

  const start = async (options: BotOptions = {}) => {
    bot = await startBot({ users: [STREAMER, VIEWER], ...options });
    return bot;
  };
  const logs = (b: BotHarness) => b.dashboardCalls().filter((c) => c.route === 'POST /api/logs').map((c) => c.body);

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    headers = captureHttpHeaders();
  });
  afterEach(async () => {
    await bot?.stop();
    bot = undefined;
  });

  // ---------------------------------------------------------------- !clip
  describe('!clip', () => {
    it('creates a clip while live and replies with the clip URL', async () => {
      const b = await start();
      b.twitch.state.live.add(BROADCASTER.id);
      expect(await b.chat('viewer1', '!clip')).toEqual(['@viewer1 Clip created! https://clips.twitch.tv/Clip1']);
      const calls = b.twitch.calls('POST /helix/clips');
      expect(calls).toHaveLength(1);
      // Helix Create Clip takes broadcaster_id in the query string
      expect(calls[0].query).toEqual({ broadcaster_id: BROADCASTER.id });
      expect(calls[0].token).toMatch(BOT_TOKEN);
      expect(logs(b)).toEqual([expect.objectContaining({ user: 'viewer1', command: '!clip', args: '', success: true })]);
    });

    it('does not check whether the stream is live; it calls the API and trusts the result', async () => {
      const b = await start();
      // Fake Twitch happily clips an offline channel; the bot does no live check of its own
      expect(b.twitch.state.live.size).toBe(0);
      expect(await b.chat('viewer1', '!clip')).toEqual(['@viewer1 Clip created! https://clips.twitch.tv/Clip1']);
      expect(b.twitch.calls('GET /helix/streams')).toHaveLength(0);
    });

    it('reports the Twitch error message when clipping an offline channel fails', async () => {
      const b = await start();
      b.twitch.state.failures.set('POST /helix/clips', { status: 404, message: 'Clipping is not possible for an offline channel.' });
      expect(await b.chat('viewer1', '!clip')).toEqual(['@viewer1 Error: Clipping is not possible for an offline channel.']);
      expect(logs(b)).toEqual([expect.objectContaining({ command: '!clip', success: false })]);
    });

    it('a failed clip does not start the cooldown', async () => {
      const b = await start();
      b.twitch.state.failures.set('POST /helix/clips', { status: 500, message: 'Internal Server Error', times: 1 });
      expect(await b.chat('viewer1', '!clip')).toEqual(['@viewer1 Error: Internal Server Error']);
      expect(await b.chat('viewer1', '!clip')).toEqual(['@viewer1 Clip created! https://clips.twitch.tv/Clip2']);
    });

    it('has a 60s global cooldown by default (dashboard builtinCommands.json)', async () => {
      const b = await start();
      expect(await b.chat('viewer1', '!clip')).toEqual(['@viewer1 Clip created! https://clips.twitch.tv/Clip1']);
      expect(await b.chat('streamer2', '!clip')).toEqual(['@streamer2 !clip is on cooldown. Try again in 60s.']);
      expect(await b.chat('caster', '!clip', { broadcaster: true })).toEqual(['@caster !clip is on cooldown. Try again in 60s.']);
      await b.advance(59_001);
      expect(await b.chat('viewer1', '!clip')).toEqual(['@viewer1 !clip is on cooldown. Try again in 1s.']);
      await b.advance(999);
      expect(await b.chat('viewer1', '!clip')).toEqual(['@viewer1 Clip created! https://clips.twitch.tv/Clip2']);
      expect(b.twitch.calls('POST /helix/clips')).toHaveLength(2);
    });

    it('refuses without clips:edit when the clips feature is disabled (so the scope is not auto-added)', async () => {
      const b = await start({ botScopes: without('clips:edit'), env: { DISABLE_CLIPS: 'true' } });
      expect(await b.chat('viewer1', '!clip')).toEqual([
        '@viewer1 Error: Missing clips:edit scope. Please re-authorize with the token generator.'
      ]);
      expect(b.twitch.calls('POST /helix/clips')).toHaveLength(0);
    });

    it('refuses when the token lacks clips:edit, even with the clips feature enabled', async () => {
      // The guard checks the scopes Twitch reported for the token, not the configured list
      const b = await start({ botScopes: without('clips:edit') });
      expect(await b.chat('viewer1', '!clip')).toEqual([
        '@viewer1 Error: Missing clips:edit scope. Please re-authorize with the token generator.'
      ]);
      expect(b.twitch.calls('POST /helix/clips')).toHaveLength(0);
    });

    it('never sends the dashboard secret header (x-bot-secret) to Twitch', async () => {
      const b = await start({ env: { DASHBOARD_INTERNAL_SECRET: 'top-secret' } });
      await b.chat('viewer1', '!clip');
      const sent = headers.calls(twitchPort(b.twitch.base), 'POST /helix/clips');
      expect(sent).toHaveLength(1);
      expect(sent[0].headers['x-bot-secret']).toBeUndefined();
      expect(sent[0].headers['client-id']).toBe('test-client-id');
    });

    it('does not send x-bot-secret when DASHBOARD_INTERNAL_SECRET is unset', async () => {
      const b = await start();
      await b.chat('viewer1', '!clip');
      const sent = headers.calls(twitchPort(b.twitch.base), 'POST /helix/clips');
      expect(sent).toHaveLength(1);
      expect(sent[0].headers['x-bot-secret']).toBeUndefined();
    });

    it('uses the bot token even when a broadcaster token is configured', async () => {
      const b = await start({ broadcasterToken: true });
      await b.chat('viewer1', '!clip');
      expect(b.twitch.calls('POST /helix/clips')[0].token).toMatch(BOT_TOKEN);
    });
  });

  // ---------------------------------------------------------------- !followage
  describe('!followage', () => {
    it('shows usage when no user is given (does not default to the caller)', async () => {
      const b = await start();
      const before = b.twitch.requests.length;
      expect(await b.chat('viewer1', '!followage')).toEqual(['@viewer1 Usage: !followage [username]']);
      expect(b.twitch.requests.slice(before)).toEqual([]);
    });

    it('reports years, months and days for a follower', async () => {
      const b = await start();
      b.twitch.state.followers.set(STREAMER.id, new Date(Date.now() - 400 * DAY).toISOString());
      expect(await b.chat('viewer1', '!followage streamer2')).toEqual(['@viewer1 Following for 1 year 1 month 4 days']);
      const call = b.twitch.calls('GET /helix/channels/followers').pop();
      expect(call?.query).toEqual({ broadcaster_id: BROADCASTER.id, user_id: STREAMER.id });
      expect(call?.token).toMatch(BOT_TOKEN);
      expect(logs(b)).toEqual([expect.objectContaining({ user: 'viewer1', command: '!followage', args: 'streamer2', success: true })]);
    });

    it.each([
      [0, 'Following for 0 days'],
      [1, 'Following for 1 day'],
      [2, 'Following for 2 days'],
      [31, 'Following for 1 month'],
      [32, 'Following for 1 month 1 day'],
      [366, 'Following for 1 year'],
      [3 * 365.25 + 61, 'Following for 3 years 2 months']
    ])('formats a follow %d days ago as "%s"', async (days, text) => {
      const b = await start();
      b.twitch.state.followers.set(STREAMER.id, new Date(Date.now() - days * DAY).toISOString());
      expect(await b.chat('viewer1', '!followage streamer2')).toEqual([`@viewer1 ${text}`]);
    });

    it('strips @ and trailing punctuation and lowercases the name', async () => {
      const b = await start();
      b.twitch.state.followers.set(STREAMER.id, new Date(Date.now() - 2 * DAY).toISOString());
      expect(await b.chat('viewer1', '!followage @StreaMer2?')).toEqual(['@viewer1 Following for 2 days']);
      expect(b.twitch.calls('GET /helix/users').pop()?.query).toEqual({ login: 'streamer2' });
    });

    it('works for the caller themself when named explicitly', async () => {
      const b = await start();
      b.twitch.state.followers.set(VIEWER.id, new Date(Date.now() - 10 * DAY).toISOString());
      expect(await b.chat('viewer1', '!followage viewer1')).toEqual(['@viewer1 Following for 10 days']);
    });

    it('says "Not following" for a user who does not follow', async () => {
      const b = await start();
      expect(await b.chat('viewer1', '!followage streamer2')).toEqual(['@viewer1 Error: Not following']);
      expect(logs(b)).toEqual([expect.objectContaining({ command: '!followage', success: false })]);
    });

    it('says "Not following" for the broadcaster', async () => {
      const b = await start();
      expect(await b.chat('viewer1', '!followage caster')).toEqual(['@viewer1 Error: Not following']);
    });

    it('reports an unknown user', async () => {
      const b = await start();
      expect(await b.chat('viewer1', '!followage nobody_here')).toEqual(['@viewer1 Error: User not found']);
      expect(b.twitch.calls('GET /helix/channels/followers')).toHaveLength(0);
    });

    it('reports an API error (not "User not found") when the users lookup fails', async () => {
      const b = await start();
      b.twitch.state.failures.set('GET /helix/users', { status: 500, message: 'boom' });
      expect(await b.chat('viewer1', '!followage streamer2')).toEqual([
        '@viewer1 Error: Twitch API error while looking up the user: boom'
      ]);
      expect(logs(b)).toEqual([expect.objectContaining({ command: '!followage', success: false })]);
    });

    it('reports an API error (not "Not following") when the followers API fails', async () => {
      const b = await start();
      b.twitch.state.followers.set(STREAMER.id, new Date(Date.now() - 5 * DAY).toISOString());
      b.twitch.state.failures.set('GET /helix/channels/followers', { status: 403, message: 'Missing scope: moderator:read:followers' });
      expect(await b.chat('viewer1', '!followage streamer2')).toEqual([
        '@viewer1 Error: Twitch API error while checking the follow: Missing scope: moderator:read:followers'
      ]);
    });

    it('has no cooldown by default, and honours a configured one that only successes start', async () => {
      const b = await start({ dashboardData: { 'builtinCommands.json': builtinCooldowns({ '!followage': 20 }) } });
      // Neither a failed lookup nor the usage message starts the cooldown
      expect(await b.chat('viewer1', '!followage streamer2')).toEqual(['@viewer1 Error: Not following']);
      expect(await b.chat('viewer1', '!followage')).toEqual(['@viewer1 Usage: !followage [username]']);
      b.twitch.state.followers.set(STREAMER.id, new Date(Date.now() - 2 * DAY).toISOString());
      expect(await b.chat('viewer1', '!followage streamer2')).toEqual(['@viewer1 Following for 2 days']);
      expect(await b.chat('viewer2', '!followage streamer2')).toEqual(['@viewer2 !followage is on cooldown. Try again in 20s.']);
      await b.advance(20_000);
      expect(await b.chat('viewer2', '!followage streamer2')).toEqual(['@viewer2 Following for 2 days']);
    });
  });

  // ---------------------------------------------------------------- !shoutout / !so
  describe('!shoutout and !so', () => {
    it.each([['!shoutout'], ['!so']])('%s is mod-only', async (cmd) => {
      const b = await start();
      expect(await b.chat('viewer1', `${cmd} streamer2`)).toEqual(['@viewer1 Only moderators can use this command.']);
      expect(await b.chat('viewer1', `${cmd} streamer2`, { vip: true, subscriber: true })).toEqual(['@viewer1 Only moderators can use this command.']);
      expect(b.twitch.calls('GET /helix/users').filter((r) => r.query.login === 'streamer2')).toHaveLength(0);
    });

    it.each([['!shoutout'], ['!so']])('%s without a name shows the !shoutout usage', async (cmd) => {
      const b = await start();
      expect(await b.chat('modguy', cmd, MOD)).toEqual(['@modguy Usage: !shoutout [username]']);
    });

    it('reports an unknown user', async () => {
      const b = await start();
      expect(await b.chat('modguy', '!so ghost', MOD)).toEqual(['@modguy Error: User not found']);
      expect(logs(b)).toEqual([expect.objectContaining({ user: 'modguy', command: '!shoutout', args: 'ghost', success: false })]);
    });

    it('shouts out an offline streamer in chat only (no shoutout API call)', async () => {
      const b = await start();
      b.twitch.state.channels.set(STREAMER.id, { title: 'chill', game_id: '509658', game_name: 'Just Chatting' });
      expect(await b.chat('modguy', '!shoutout @streamer2', MOD)).toEqual([
        "Shoutout to Streamer2! Check out their channel: https://twitch.tv/streamer2 - They're playing Just Chatting"
      ]);
      expect(headers.calls(twitchPort(b.twitch.base), 'POST /helix/chat/shoutouts')).toHaveLength(0);
      expect(b.twitch.calls('POST /helix/chat/announcements')).toHaveLength(0);
      expect(logs(b)).toEqual([expect.objectContaining({ command: '!shoutout', args: '@streamer2', success: true })]);
    });

    it('falls back to "something awesome" when the channel has no game', async () => {
      const b = await start();
      expect(await b.chat('caster', '!so streamer2', { broadcaster: true })).toEqual([
        "Shoutout to Streamer2! Check out their channel: https://twitch.tv/streamer2 - They're playing something awesome"
      ]);
    });

    it('sends a Twitch shoutout (but no announcement) for a live streamer', async () => {
      const b = await start();
      b.twitch.state.channels.set(STREAMER.id, { title: 'speedrun', game_id: '27471', game_name: 'Minecraft' });
      b.twitch.state.live.add(STREAMER.id);
      expect(await b.chat('modguy', '!so streamer2', MOD)).toEqual([
        "Shoutout to Streamer2! Check out their channel: https://twitch.tv/streamer2 - They're playing Minecraft - go follow them!"
      ]);
      // The shoutout request is sent, but fake Twitch's strict express.json() rejects its literal "null" body
      // with a 400 before recording it, so it is only visible in the raw request capture (harness limitation).
      const so = headers.calls(twitchPort(b.twitch.base), 'POST /helix/chat/shoutouts');
      expect(so).toHaveLength(1);
      expect(so[0].query).toEqual({ from_broadcaster_id: BROADCASTER.id, to_broadcaster_id: STREAMER.id, moderator_id: BOT_USER.id });
      expect(so[0].headers.authorization).toMatch(/^Bearer access-excella_bot-\d+$/);
      expect(so[0].headers['content-length']).toBe('4'); // body is the JSON literal null
      // The shoutout is a chat message, not a /chat/announcements call
      expect(b.twitch.calls('POST /helix/chat/announcements')).toHaveLength(0);
    });

    it('still posts the chat shoutout when the shoutout API fails', async () => {
      const b = await start();
      b.twitch.state.live.add(STREAMER.id);
      b.twitch.state.failures.set('POST /helix/chat/shoutouts', { status: 429, message: 'Too Many Requests' });
      expect(await b.chat('modguy', '!so streamer2', MOD)).toEqual([
        "Shoutout to Streamer2! Check out their channel: https://twitch.tv/streamer2 - They're playing something awesome - go follow them!"
      ]);
      expect(logs(b)).toEqual([expect.objectContaining({ command: '!shoutout', success: true })]);
    });

    it('reports an API error (not "offline") when the streams lookup fails', async () => {
      const b = await start();
      b.twitch.state.live.add(STREAMER.id);
      b.twitch.state.failures.set('GET /helix/streams', { status: 500, message: 'boom' });
      expect(await b.chat('modguy', '!so streamer2', MOD)).toEqual([
        '@modguy Error: Twitch API error while checking whether they are live: boom'
      ]);
      expect(headers.calls(twitchPort(b.twitch.base), 'POST /helix/chat/shoutouts')).toHaveLength(0);
      expect(logs(b)).toEqual([expect.objectContaining({ command: '!shoutout', success: false })]);
    });

    it('reports an API error (not "User not found") when the users lookup fails', async () => {
      const b = await start();
      b.twitch.state.failures.set('GET /helix/users', { status: 503, message: 'unavailable' });
      expect(await b.chat('modguy', '!so streamer2', MOD)).toEqual([
        '@modguy Error: Twitch API error while looking up the user: unavailable'
      ]);
    });

    it('uses the bot token for the shoutout even with a broadcaster token', async () => {
      const b = await start({ broadcasterToken: true });
      b.twitch.state.live.add(STREAMER.id);
      await b.chat('modguy', '!so streamer2', MOD);
      const so = headers.calls(twitchPort(b.twitch.base), 'POST /helix/chat/shoutouts');
      expect(so.map((r) => r.headers.authorization)).toEqual([expect.stringMatching(/^Bearer access-excella_bot-\d+$/)]);
    });

    it('!shoutout uses its own cooldown entry; !so is not limited by it', async () => {
      const b = await start({ dashboardData: { 'builtinCommands.json': builtinCooldowns({ '!shoutout': 30, '!so': 0 }) } });
      expect(await b.chat('modguy', '!shoutout streamer2', MOD)).toHaveLength(1);
      expect(await b.chat('caster', '!shoutout streamer2', { broadcaster: true })).toEqual(['@caster !shoutout is on cooldown. Try again in 30s.']);
      expect(await b.chat('modguy', '!so streamer2', MOD)).toEqual([
        "Shoutout to Streamer2! Check out their channel: https://twitch.tv/streamer2 - They're playing something awesome"
      ]);
      await b.advance(30_000);
      expect(await b.chat('modguy', '!shoutout streamer2', MOD)).toHaveLength(1);
    });

    it('!so honours its own entry in the cooldown config', async () => {
      const b = await start({ dashboardData: { 'builtinCommands.json': builtinCooldowns({ '!so': 30 }) } });
      expect(await b.chat('modguy', '!so streamer2', MOD)).toHaveLength(1);
      expect(await b.chat('modguy', '!so streamer2', MOD)).toEqual(['@modguy !so is on cooldown. Try again in 30s.']);
      expect(await b.chat('modguy', '!shoutout streamer2', MOD)).toHaveLength(1);
    });

    it('a failed shoutout (unknown user) does not start the cooldown', async () => {
      const b = await start({ dashboardData: { 'builtinCommands.json': builtinCooldowns({ '!so': 30 }) } });
      expect(await b.chat('modguy', '!so ghost', MOD)).toEqual(['@modguy Error: User not found']);
      expect(await b.chat('modguy', '!so', MOD)).toEqual(['@modguy Usage: !shoutout [username]']);
      expect(await b.chat('modguy', '!so streamer2', MOD)).toHaveLength(1);
      expect(await b.chat('modguy', '!so streamer2', MOD)).toEqual(['@modguy !so is on cooldown. Try again in 30s.']);
    });
  });

  // ---------------------------------------------------------------- !title
  describe('!title', () => {
    it('is mod-only', async () => {
      const b = await start();
      expect(await b.chat('viewer1', '!title hacked')).toEqual(['@viewer1 Only moderators can use this command.']);
      expect(b.twitch.calls('PATCH /helix/channels')).toHaveLength(0);
    });

    it('with no argument shows usage (it does not show the current title)', async () => {
      const b = await start();
      b.twitch.state.channels.set(BROADCASTER.id, { title: 'Current title', game_id: '', game_name: '' });
      expect(await b.chat('modguy', '!title', MOD)).toEqual(['Usage: !title "new title"']);
      expect(b.twitch.calls('PATCH /helix/channels')).toHaveLength(0);
    });

    it('sets the title via PATCH /helix/channels', async () => {
      const b = await start();
      expect(await b.chat('modguy', '!title Speedrunning   all  day', MOD)).toEqual(['✓ Stream title updated to: "Speedrunning all day"']);
      const patch = b.twitch.calls('PATCH /helix/channels');
      expect(patch).toHaveLength(1);
      expect(patch[0].query).toEqual({ broadcaster_id: BROADCASTER.id });
      expect(patch[0].body).toEqual({ title: 'Speedrunning all day' });
      expect(patch[0].token).toMatch(BOT_TOKEN);
      expect(b.twitch.state.channels.get(BROADCASTER.id)?.title).toBe('Speedrunning all day');
      expect(logs(b)).toEqual([expect.objectContaining({ user: 'modguy', command: '!title', args: 'Speedrunning all day', success: true })]);
    });

    it('strips the quotes that the usage text asks for', async () => {
      const b = await start();
      expect(await b.chat('caster', '!title "Hello world"', { broadcaster: true })).toEqual(['✓ Stream title updated to: "Hello world"']);
      expect(b.twitch.state.channels.get(BROADCASTER.id)?.title).toBe('Hello world');
      expect(logs(b)).toEqual([expect.objectContaining({ command: '!title', args: 'Hello world', success: true })]);
    });

    it.each([
      ['“Curly quotes”', 'Curly quotes'],
      ['"only leading', '"only leading'],
      ['say "hi" now', 'say "hi" now']
    ])('quotes: %s -> %s', async (text, title) => {
      const b = await start();
      await b.chat('modguy', `!title ${text}`, MOD);
      expect(b.twitch.state.channels.get(BROADCASTER.id)?.title).toBe(title);
    });

    it('treats a title of just quotes as missing', async () => {
      const b = await start();
      expect(await b.chat('modguy', '!title ""', MOD)).toEqual(['Usage: !title "new title"']);
      expect(b.twitch.calls('PATCH /helix/channels')).toHaveLength(0);
    });

    it('uses the broadcaster token when one is configured, without the dashboard secret', async () => {
      const b = await start({ broadcasterToken: true, env: { DASHBOARD_INTERNAL_SECRET: 'top-secret' } });
      await b.chat('modguy', '!title New', MOD);
      expect(b.twitch.calls('PATCH /helix/channels')[0].token).toMatch(CASTER_TOKEN);
      const sent = headers.calls(twitchPort(b.twitch.base), 'PATCH /helix/channels');
      expect(sent).toHaveLength(1);
      expect(sent[0].headers['x-bot-secret']).toBeUndefined();
    });

    it('reports the Twitch error message on failure', async () => {
      const b = await start();
      b.twitch.state.failures.set('PATCH /helix/channels', { status: 403, message: 'Missing scope: channel:manage:broadcast' });
      expect(await b.chat('modguy', '!title New', MOD)).toEqual(['Error: Missing scope: channel:manage:broadcast']);
      expect(logs(b)).toEqual([expect.objectContaining({ command: '!title', success: false })]);
    });

    it('refuses when the bot token lacks channel:manage:broadcast (single account)', async () => {
      const b = await start({ botScopes: without('channel:manage:broadcast') });
      expect(await b.chat('modguy', '!title New', MOD)).toEqual([
        'Error: Missing scope: channel:manage:broadcast. Re-authorize via the token generator.'
      ]);
      expect(b.twitch.calls('PATCH /helix/channels')).toHaveLength(0);
    });

    it('checks the broadcaster scopes, not the bot scopes, when a broadcaster token is configured', async () => {
      const b = await start({
        botScopes: without('channel:manage:broadcast'),
        // The broadcaster token itself lacks the scope (startup records the granted scopes in TWITCH_BROADCASTER_SCOPES)
        broadcasterToken: { scopes: ['chat:read'] },
        env: { TWITCH_BROADCASTER_SCOPES: 'chat:read' }
      });
      expect(await b.chat('modguy', '!title New', MOD)).toEqual([
        'Error: Missing scope: channel:manage:broadcast. Re-authorize via the token generator.'
      ]);
    });
  });

  // ---------------------------------------------------------------- !game
  describe('!game', () => {
    const seedGames = (b: BotHarness) => {
      b.twitch.state.games.push({ id: '27471', name: 'Minecraft' });
      b.twitch.state.categories.push({ id: '509658', name: 'Just Chatting' }, { id: '27471', name: 'Minecraft' });
    };

    it('is mod-only', async () => {
      const b = await start();
      expect(await b.chat('viewer1', '!game Minecraft')).toEqual(['@viewer1 Only moderators can use this command.']);
    });

    it('with no argument shows usage (it does not show the current game)', async () => {
      const b = await start();
      expect(await b.chat('modguy', '!game', MOD)).toEqual(['Usage: !game <game name>']);
      expect(b.twitch.calls('GET /helix/games')).toHaveLength(0);
    });

    it('resolves an exact game name and PATCHes the game_id', async () => {
      const b = await start();
      seedGames(b);
      expect(await b.chat('modguy', '!game minecraft', MOD)).toEqual(['✓ Game updated to: Minecraft']);
      expect(b.twitch.calls('GET /helix/games')[0].query).toEqual({ name: 'minecraft' });
      expect(b.twitch.calls('GET /helix/search/categories')).toHaveLength(0);
      const patch = b.twitch.calls('PATCH /helix/channels');
      expect(patch).toHaveLength(1);
      expect(patch[0].query).toEqual({ broadcaster_id: BROADCASTER.id });
      expect(patch[0].body).toEqual({ game_id: '27471' });
      expect(b.twitch.state.channels.get(BROADCASTER.id)?.game_name).toBe('Minecraft');
      expect(logs(b)).toEqual([expect.objectContaining({ command: '!game', args: 'minecraft', success: true })]);
    });

    it('falls back to a category search when there is no exact game match', async () => {
      const b = await start();
      seedGames(b);
      expect(await b.chat('modguy', '!game just chat', MOD)).toEqual(['✓ Game updated to: Just Chatting']);
      expect(b.twitch.calls('GET /helix/search/categories')[0].query).toEqual({ query: 'just chat' });
      expect(b.twitch.calls('PATCH /helix/channels')[0].body).toEqual({ game_id: '509658' });
    });

    it('falls back to the category search when the games lookup errors', async () => {
      const b = await start();
      seedGames(b);
      b.twitch.state.failures.set('GET /helix/games', { status: 500, message: 'boom' });
      expect(await b.chat('modguy', '!game Minecraft', MOD)).toEqual(['✓ Game updated to: Minecraft']);
    });

    it('reports when nothing matches and does not PATCH', async () => {
      const b = await start();
      seedGames(b);
      expect(await b.chat('modguy', '!game zzz unknown', MOD)).toEqual(['Error: Could not find a game/category named "zzz unknown".']);
      expect(b.twitch.calls('PATCH /helix/channels')).toHaveLength(0);
      expect(logs(b)).toEqual([expect.objectContaining({ command: '!game', success: false })]);
    });

    it('reports an API error (not "not found") when both lookups fail', async () => {
      const b = await start();
      seedGames(b);
      b.twitch.state.failures.set('GET /helix/games', { status: 500, message: 'boom' });
      b.twitch.state.failures.set('GET /helix/search/categories', { status: 500, message: 'search down' });
      expect(await b.chat('modguy', '!game Minecraft', MOD)).toEqual(['Error: Twitch API error while looking up "Minecraft": search down']);
      expect(b.twitch.calls('PATCH /helix/channels')).toHaveLength(0);
    });

    it('reports an API error when the games lookup fails and the category search finds nothing', async () => {
      const b = await start();
      b.twitch.state.failures.set('GET /helix/games', { status: 500, message: 'boom' });
      expect(await b.chat('modguy', '!game Minecraft', MOD)).toEqual(['Error: Twitch API error while looking up "Minecraft": boom']);
    });

    it('reports a PATCH failure', async () => {
      const b = await start();
      seedGames(b);
      b.twitch.state.failures.set('PATCH /helix/channels', { status: 400, message: 'bad game' });
      expect(await b.chat('modguy', '!game Minecraft', MOD)).toEqual(['Error: bad game']);
    });

    it('uses the broadcaster token for lookups and the PATCH when configured', async () => {
      const b = await start({ broadcasterToken: true });
      seedGames(b);
      await b.chat('modguy', '!game Minecraft', MOD);
      expect(b.twitch.calls('GET /helix/games')[0].token).toMatch(CASTER_TOKEN);
      expect(b.twitch.calls('PATCH /helix/channels')[0].token).toMatch(CASTER_TOKEN);
    });
  });

  // ---------------------------------------------------------------- !poll
  describe('!poll', () => {
    it('is mod-only', async () => {
      const b = await start();
      expect(await b.chat('viewer1', '!poll start "Q" a;b')).toEqual(['@viewer1 Only moderators can use this command.']);
    });

    it.each([
      ['!poll', '@modguy Usage: !poll start "Title" option1;option2;... [duration]'],
      ['!poll start', '@modguy Poll title must be quoted: "Your Title"'],
      ['!poll start Best game? a;b', '@modguy Poll title must be quoted: "Your Title"'],
      ['!poll start "Best game?"', '@modguy Provide options: option1;option2;...'],
      ['!poll start "Best game?" a', '@modguy Polls require 2-5 options.'],
      ['!poll start "Best game?" a;b;c;d;e;f', '@modguy Polls require 2-5 options.'],
      ['!poll start "Best game?" ;;a;;', '@modguy Polls require 2-5 options.'],
      ['!poll end', '@modguy Usage: !poll end <poll_id>'],
      ['!poll stop poll-1', '@modguy Usage: !poll start "Title" options [duration] or !poll end <id>']
    ])('%s -> usage/validation message', async (text, reply) => {
      const b = await start();
      expect(await b.chat('modguy', text, MOD)).toEqual([reply]);
      expect(b.twitch.calls('POST /helix/polls')).toHaveLength(0);
      expect(b.twitch.calls('PATCH /helix/polls')).toHaveLength(0);
    });

    it('starts a poll with the default 300s duration', async () => {
      const b = await start();
      expect(await b.chat('modguy', '!poll START "Best game ever?" Minecraft;Celeste; Tetris', MOD)).toEqual([
        '✓ Poll started: "Best game ever?" (300s) - Vote with reactions!'
      ]);
      const post = b.twitch.calls('POST /helix/polls');
      expect(post).toHaveLength(1);
      // Options are split on whitespace first, so " Tetris" (after a space) becomes the duration argument
      expect(post[0].body).toEqual({
        broadcaster_id: BROADCASTER.id,
        title: 'Best game ever?',
        choices: [{ title: 'Minecraft' }, { title: 'Celeste' }],
        duration: 300,
        channel_points_voting: { is_enabled: false }
      });
      expect(post[0].token).toMatch(BOT_TOKEN);
      expect(logs(b)).toEqual([
        expect.objectContaining({ user: 'modguy', command: '!poll start', args: 'Best game ever? Minecraft Celeste', success: true })
      ]);
    });

    it('allows 5 options and filters empty ones', async () => {
      const b = await start();
      await b.chat('modguy', '!poll start "Q" a;;b;c;d;e;', MOD);
      expect((b.twitch.calls('POST /helix/polls')[0].body as { choices: unknown[] }).choices).toEqual(
        ['a', 'b', 'c', 'd', 'e'].map((title) => ({ title }))
      );
    });

    it.each([
      ['5', 15],
      ['15', 15],
      ['60', 60],
      ['1800', 1800],
      ['99999', 1800],
      ['-30', 15],
      ['abc', 300],
      ['90s', 90]
    ])('clamps duration %s to %d', async (dur, expected) => {
      const b = await start();
      expect(await b.chat('modguy', `!poll start "Q" a;b ${dur}`, MOD)).toEqual([`✓ Poll started: "Q" (${expected}s) - Vote with reactions!`]);
      expect((b.twitch.calls('POST /helix/polls')[0].body as { duration: number }).duration).toBe(expected);
    });

    it('collapses repeated spaces inside the quoted title', async () => {
      const b = await start();
      expect(await b.chat('modguy', '!poll start "A   B" x;y', MOD)).toEqual(['✓ Poll started: "A B" (300s) - Vote with reactions!']);
    });

    it('ends a poll by id', async () => {
      const b = await start();
      expect(await b.chat('modguy', '!poll end poll-123', MOD)).toEqual(['✓ Poll ended.']);
      const patch = b.twitch.calls('PATCH /helix/polls');
      expect(patch).toHaveLength(1);
      // Helix End Poll takes its fields in the body
      expect(patch[0].body).toEqual({ broadcaster_id: BROADCASTER.id, id: 'poll-123', status: 'TERMINATED' });
      expect(logs(b)).toEqual([expect.objectContaining({ command: '!poll end', args: 'poll-123', success: true })]);
    });

    it('reports API errors on start', async () => {
      const b = await start();
      b.twitch.state.failures.set('POST /helix/polls', { status: 403, message: 'The broadcaster must be a partner or affiliate.' });
      expect(await b.chat('modguy', '!poll start "Q" a;b', MOD)).toEqual([
        '@modguy Poll error: The broadcaster must be a partner or affiliate.'
      ]);
      expect(logs(b)).toEqual([expect.objectContaining({ command: '!poll', args: 'start "Q" a;b', success: false })]);
    });

    it('reports API errors on end', async () => {
      const b = await start();
      b.twitch.state.failures.set('PATCH /helix/polls', { status: 404, message: 'poll not found' });
      expect(await b.chat('modguy', '!poll end nope', MOD)).toEqual(['@modguy Poll error: poll not found']);
    });

    it('refuses without channel:manage:polls when the polls feature is disabled', async () => {
      const b = await start({ botScopes: without('channel:manage:polls'), env: { DISABLE_POLLS: 'true' } });
      expect(await b.chat('modguy', '!poll start "Q" a;b', MOD)).toEqual(['@modguy Missing scope: channel:manage:polls']);
      expect(await b.chat('modguy', '!poll end p1', MOD)).toEqual(['@modguy Missing scope: channel:manage:polls']);
      expect(b.twitch.calls('POST /helix/polls')).toHaveLength(0);
    });

    it('uses the broadcaster token when one is configured', async () => {
      const b = await start({ broadcasterToken: true });
      await b.chat('modguy', '!poll start "Q" a;b', MOD);
      await b.chat('modguy', '!poll end poll-1', MOD);
      expect(b.twitch.calls('POST /helix/polls')[0].token).toMatch(CASTER_TOKEN);
      expect(b.twitch.calls('PATCH /helix/polls')[0].token).toMatch(CASTER_TOKEN);
    });

    it('never sends the dashboard secret header (x-bot-secret) to Twitch', async () => {
      const b = await start({ broadcasterToken: true, env: { DASHBOARD_INTERNAL_SECRET: 'top-secret' } });
      await b.chat('modguy', '!poll start "Q" a;b', MOD);
      await b.chat('modguy', '!poll end poll-1', MOD);
      const port = twitchPort(b.twitch.base);
      expect(headers.calls(port, 'POST /helix/polls').map((r) => r.headers['x-bot-secret'])).toEqual([undefined]);
      expect(headers.calls(port, 'PATCH /helix/polls').map((r) => r.headers['x-bot-secret'])).toEqual([undefined]);
    });

    it('a failed start does not start the cooldown', async () => {
      const b = await start({ dashboardData: { 'builtinCommands.json': builtinCooldowns({ '!poll': 30 }) } });
      b.twitch.state.failures.set('POST /helix/polls', { status: 500, message: 'boom', times: 1 });
      expect(await b.chat('modguy', '!poll start "Q" a;b', MOD)).toEqual(['@modguy Poll error: boom']);
      expect(await b.chat('modguy', '!poll start "Q" a;b', MOD)).toEqual(['✓ Poll started: "Q" (300s) - Vote with reactions!']);
      expect(await b.chat('modguy', '!poll end poll-1', MOD)).toEqual(['@modguy !poll is on cooldown. Try again in 30s.']);
    });
  });

  // ---------------------------------------------------------------- !prediction
  describe('!prediction', () => {
    it('is mod-only', async () => {
      const b = await start();
      expect(await b.chat('viewer1', '!prediction start "Q" a;b')).toEqual(['@viewer1 Only moderators can use this command.']);
    });

    it.each([
      ['!prediction', '@modguy Usage: !prediction start "Title" outcome1;outcome2 [duration]'],
      ['!prediction start', '@modguy Prediction title must be quoted: "Your Title"'],
      ['!prediction start Win? yes;no', '@modguy Prediction title must be quoted: "Your Title"'],
      ['!prediction start "Win?"', '@modguy Provide outcomes: outcome1;outcome2'],
      ['!prediction start "Win?" yes', '@modguy Predictions require exactly 2 outcomes.'],
      ['!prediction start "Win?" a;b;c', '@modguy Predictions require exactly 2 outcomes.'],
      ['!prediction resolve', '@modguy Usage: !prediction resolve <id> <outcome_id>'],
      ['!prediction resolve pred-1', '@modguy Usage: !prediction resolve <id> <outcome_id>'],
      ['!prediction end pred-1', '@modguy Usage: !prediction start "Title" outcome1;outcome2 [duration] or !prediction resolve <id> <outcome_id>'],
      ['!prediction cancel pred-1', '@modguy Usage: !prediction start "Title" outcome1;outcome2 [duration] or !prediction resolve <id> <outcome_id>']
    ])('%s -> usage/validation message', async (text, reply) => {
      const b = await start();
      expect(await b.chat('modguy', text, MOD)).toEqual([reply]);
      expect(b.twitch.calls('POST /helix/predictions')).toHaveLength(0);
      expect(b.twitch.calls('PATCH /helix/predictions')).toHaveLength(0);
    });

    it('starts a prediction with the default 300s window', async () => {
      const b = await start();
      expect(await b.chat('modguy', '!prediction start "Will we win?" yes;no', MOD)).toEqual([
        '✓ Prediction started: "Will we win?" (300s) - Viewers can place points!'
      ]);
      const post = b.twitch.calls('POST /helix/predictions');
      expect(post).toHaveLength(1);
      expect(post[0].body).toEqual({
        broadcaster_id: BROADCASTER.id,
        title: 'Will we win?',
        outcomes: [{ title: 'yes' }, { title: 'no' }],
        prediction_window: 300
      });
      expect(post[0].token).toMatch(BOT_TOKEN);
      expect(logs(b)).toEqual([expect.objectContaining({ command: '!prediction start', args: 'Will we win? yes no', success: true })]);
    });

    it.each([
      ['30', 60],
      ['60', 60],
      ['600', 600],
      ['1801', 1800],
      ['nope', 300]
    ])('clamps window %s to %d', async (dur, expected) => {
      const b = await start();
      expect(await b.chat('modguy', `!prediction start "Q" a;b ${dur}`, MOD)).toEqual([
        `✓ Prediction started: "Q" (${expected}s) - Viewers can place points!`
      ]);
    });

    it('resolves a prediction', async () => {
      const b = await start();
      expect(await b.chat('modguy', '!prediction resolve pred-9 outcome-2', MOD)).toEqual(['✓ Prediction resolved.']);
      const patch = b.twitch.calls('PATCH /helix/predictions');
      expect(patch).toHaveLength(1);
      // Helix End Prediction takes its fields in the body
      expect(patch[0].body).toEqual({ broadcaster_id: BROADCASTER.id, id: 'pred-9', status: 'RESOLVED', winning_outcome_id: 'outcome-2' });
      expect(logs(b)).toEqual([expect.objectContaining({ command: '!prediction resolve', args: 'pred-9 outcome-2', success: true })]);
    });

    it('reports API errors', async () => {
      const b = await start();
      b.twitch.state.failures.set('POST /helix/predictions', { status: 400, message: 'already active' });
      b.twitch.state.failures.set('PATCH /helix/predictions', { status: 404, message: 'prediction not found' });
      expect(await b.chat('modguy', '!prediction start "Q" a;b', MOD)).toEqual(['@modguy Prediction error: already active']);
      expect(await b.chat('modguy', '!prediction resolve x y', MOD)).toEqual(['@modguy Prediction error: prediction not found']);
      expect(logs(b)).toEqual([
        expect.objectContaining({ command: '!prediction', args: 'start "Q" a;b', success: false }),
        expect.objectContaining({ command: '!prediction', args: 'resolve x y', success: false })
      ]);
    });

    it('refuses without channel:manage:predictions when the predictions feature is disabled', async () => {
      const b = await start({ botScopes: without('channel:manage:predictions'), env: { DISABLE_PREDICTIONS: 'true' } });
      expect(await b.chat('modguy', '!prediction start "Q" a;b', MOD)).toEqual(['@modguy Missing scope: channel:manage:predictions']);
      expect(await b.chat('modguy', '!prediction resolve x y', MOD)).toEqual(['@modguy Missing scope: channel:manage:predictions']);
    });

    it('uses the broadcaster token when configured, without the dashboard secret', async () => {
      const b = await start({ broadcasterToken: true, env: { DASHBOARD_INTERNAL_SECRET: 'top-secret' } });
      await b.chat('modguy', '!prediction start "Q" a;b', MOD);
      await b.chat('modguy', '!prediction resolve pred-1 o1', MOD);
      expect(b.twitch.calls('POST /helix/predictions')[0].token).toMatch(CASTER_TOKEN);
      expect(b.twitch.calls('PATCH /helix/predictions')[0].token).toMatch(CASTER_TOKEN);
      const port = twitchPort(b.twitch.base);
      expect(headers.calls(port, 'POST /helix/predictions').map((r) => r.headers['x-bot-secret'])).toEqual([undefined]);
      expect(headers.calls(port, 'PATCH /helix/predictions').map((r) => r.headers['x-bot-secret'])).toEqual([undefined]);
    });

    it('honours a configured cooldown for !prediction', async () => {
      const b = await start({ dashboardData: { 'builtinCommands.json': builtinCooldowns({ '!prediction': 15 }) } });
      expect(await b.chat('modguy', '!prediction', MOD)).toEqual(['@modguy Usage: !prediction start "Title" outcome1;outcome2 [duration]']);
      // A usage message does not start the cooldown; a successful start does
      expect(await b.chat('modguy', '!prediction start "Q" a;b', MOD)).toEqual(['✓ Prediction started: "Q" (300s) - Viewers can place points!']);
      expect(await b.chat('modguy', '!prediction resolve pred-1 o1', MOD)).toEqual(['@modguy !prediction is on cooldown. Try again in 15s.']);
    });
  });

  describe('dashboard secret header on Helix client traffic', () => {
    it('Helix API client calls (users, followers, streams, shoutouts) never carry x-bot-secret', async () => {
      const b = await start({ env: { DASHBOARD_INTERNAL_SECRET: 'top-secret' } });
      b.twitch.state.live.add(STREAMER.id);
      await b.chat('viewer1', '!followage streamer2');
      await b.chat('modguy', '!so streamer2', MOD);
      const port = twitchPort(b.twitch.base);
      const fromLib = headers.all().filter((r) => r.port === port && /^\/helix\/(users|channels|streams|chat\/shoutouts)/.test(r.path));
      expect(fromLib.length).toBeGreaterThan(0);
      expect(fromLib.filter((r) => r.headers['x-bot-secret'] !== undefined)).toEqual([]);
    });
  });
});
