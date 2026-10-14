/**
 * E2E characterization: chat filters (CHAT_FILTER_* env, !addfilter/!removefilter/!filters)
 * and chat hype (HYPE_* env, !hype) in the Excella.js message pipeline.
 */
jest.mock('axios', () => require('./harness/redirect').axiosMock());
jest.mock('ws', () => require('./harness/redirect').wsMock());
jest.mock('tmi.js', () => require('./harness/redirect').tmiMock());
jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('../../src/lib/console-timestamp', () => ({}));

import * as fs from 'fs';
import { BotHarness, BotOptions } from './harness/bot';
import { ALL_SCOPES } from './harness/fake-twitch';
import { silenceConsole, startReadyBot, talk } from './harness/loyalty-helpers';

const BAD_GUY = { id: '3003', login: 'badguy', display_name: 'BadGuy' };
const WARN = (u: string) => `@${u} Your message violated chat rules. Please be respectful.`;
const TIMED_OUT = (u: string) => `@${u} Your message violated chat rules and you have been timed out.`;

const DEFAULT_FILTERS = {
  blacklistWords: [] as string[],
  filterUrls: false,
  filterAllCaps: false,
  filterRepeatChars: false,
  filterSpam: false,
  timeoutDurationSeconds: 60,
  filterAction: 'warn'
};

describe('bot chat filters and hype', () => {
  let bot: BotHarness | null = null;

  async function start(options: BotOptions = {}): Promise<BotHarness> {
    bot = await startReadyBot({ users: [BAD_GUY], ...options });
    return bot;
  }
  const chatLogged = (b: BotHarness, message: string) =>
    b.dashboardCalls().some((c) => c.route === 'POST /api/chat' && c.body.message === message);
  const bans = (b: BotHarness) => b.twitch.calls('POST /helix/moderation/bans');

  beforeEach(() => {
    silenceConsole();
  });
  afterEach(async () => {
    if (bot) await bot.stop();
    bot = null;
  });

  describe('filters', () => {
    it('with no filters configured nothing is flagged', async () => {
      const b = await start();
      expect(await talk(b, 'viewer1', 'HELLO WWW.EXAMPLE.COM soooo')).toEqual([]);
    });

    it('blacklist words match whole words, case-insensitively, ignoring punctuation (default action: warn)', async () => {
      const b = await start({ env: { CHAT_FILTER_WORDS: ' BadWord | other ' } });
      expect(await talk(b, 'viewer1', 'you are a BADWORD!')).toEqual([WARN('viewer1')]);
      expect(await talk(b, 'viewer1', 'and other things')).toEqual([WARN('viewer1')]);
      expect(await talk(b, 'viewer1', 'badwords is not a match')).toEqual([]);
      // Non-word characters are stripped from each word before matching, so "bad-word:" matches "badword"
      expect(await talk(b, 'viewer1', 'bad-word: punctuation inside is stripped too')).toEqual([WARN('viewer1')]);
      expect(await talk(b, 'viewer1', 'bad word split by a space is fine')).toEqual([]);
    });

    it('warn: the message is still logged, awarded and executed as a command', async () => {
      const b = await start({ env: { CHAT_FILTER_WORDS: 'badword' } });
      jest.spyOn(Math, 'random').mockReturnValue(0.1);
      expect(await talk(b, 'viewer1', '!coinflip badword')).toEqual([WARN('viewer1'), '@viewer1 flipped a coin and got Heads.']);
      expect(chatLogged(b, '!coinflip badword')).toBe(true);
      expect(bans(b)).toHaveLength(0);
    });

    it('timeout: bans via Helix for CHAT_FILTER_TIMEOUT_SEC and drops the message (no log, no award, no command)', async () => {
      const b = await start({ env: { CHAT_FILTER_WORDS: 'badword', CHAT_FILTER_ACTION: 'timeout', CHAT_FILTER_TIMEOUT_SEC: '120' } });
      jest.spyOn(Math, 'random').mockReturnValue(0.1);
      const before = b.dashboardCalls().length;
      expect(await talk(b, 'badguy', '!coinflip badword')).toEqual([TIMED_OUT('badguy')]);
      expect(bans(b)).toHaveLength(1);
      expect(bans(b)[0].query).toEqual({ broadcaster_id: '1001', moderator_id: '2002' });
      // Helix Ban User takes the fields wrapped in { data: {...} }
      expect(bans(b)[0].body).toEqual({ data: { user_id: '3003', duration: 120, reason: '' } });
      expect(b.dashboardCalls().slice(before)).toEqual([]);
      expect(chatLogged(b, '!coinflip badword')).toBe(false);
    });

    it('timeout defaults to 60 seconds', async () => {
      const b = await start({ env: { CHAT_FILTER_WORDS: 'badword', CHAT_FILTER_ACTION: 'timeout' } });
      await talk(b, 'badguy', 'badword');
      expect((bans(b)[0].body as { data: { duration: number } }).data.duration).toBe(60);
    });

    it('timeout falls back to a warning when the user is unknown or the ban call fails', async () => {
      const b = await start({ env: { CHAT_FILTER_WORDS: 'badword', CHAT_FILTER_ACTION: 'timeout' } });
      expect(await talk(b, 'ghost', 'badword')).toEqual([WARN('ghost')]);
      expect(bans(b)).toHaveLength(0);
      b.twitch.state.failures.set('POST /helix/moderation/bans', { status: 403, message: 'not a moderator' });
      expect(await talk(b, 'badguy', 'badword')).toEqual([WARN('badguy')]);
      expect(bans(b)).toHaveLength(1);
      // The offending message is still not processed
      expect(chatLogged(b, 'badword')).toBe(false);
    });

    it('timeout is not attempted when the bot token lacks the moderation scopes', async () => {
      const b = await start({
        env: { CHAT_FILTER_WORDS: 'badword', CHAT_FILTER_ACTION: 'timeout' },
        botScopes: ALL_SCOPES.filter((s) => s !== 'moderator:manage:banned_users')
      });
      expect(await talk(b, 'badguy', 'badword')).toEqual([WARN('badguy')]);
      expect(bans(b)).toHaveLength(0);
    });

    it('delete: deletes the message on Twitch, says nothing and drops it (no log, no award, no command)', async () => {
      const b = await start({ env: { CHAT_FILTER_WORDS: 'badword', CHAT_FILTER_ACTION: 'delete' } });
      const before = b.dashboardCalls().length;
      expect(await talk(b, 'viewer1', '!coinflip badword')).toEqual([]);
      expect(b.dashboardCalls().slice(before)).toEqual([]);
      const deletes = b.twitch.calls('DELETE /helix/moderation/chat');
      expect(deletes).toHaveLength(1);
      expect(deletes[0].query).toEqual({ broadcaster_id: '1001', moderator_id: '2002', message_id: expect.stringMatching(/^msg-/) });
      expect(deletes[0].token).toMatch(/^access-excella_bot-/);
    });

    it('delete: a failed delete still drops the message silently', async () => {
      const b = await start({ env: { CHAT_FILTER_WORDS: 'badword', CHAT_FILTER_ACTION: 'delete' } });
      b.twitch.state.failures.set('DELETE /helix/moderation/chat', { status: 403, message: 'not a moderator' });
      expect(await talk(b, 'viewer1', '!coinflip badword')).toEqual([]);
      expect(chatLogged(b, '!coinflip badword')).toBe(false);
      expect(b.twitch.calls('DELETE /helix/moderation/chat')).toHaveLength(1);
    });

    it('an unknown CHAT_FILTER_ACTION flags silently and processes the message', async () => {
      const b = await start({ env: { CHAT_FILTER_WORDS: 'badword', CHAT_FILTER_ACTION: 'ban' } });
      expect(await talk(b, 'viewer1', 'badword')).toEqual([]);
      expect(chatLogged(b, 'badword')).toBe(true);
    });

    it('moderators and the broadcaster are exempt', async () => {
      const b = await start({ env: { CHAT_FILTER_WORDS: 'badword', CHAT_FILTER_ACTION: 'timeout' } });
      expect(await talk(b, 'mod1', 'badword', { mod: true })).toEqual([]);
      expect(await talk(b, 'caster', 'badword', { broadcaster: true })).toEqual([]);
      expect(bans(b)).toHaveLength(0);
    });

    it('subscribers and VIPs are not exempt', async () => {
      const b = await start({ env: { CHAT_FILTER_WORDS: 'badword' } });
      expect(await talk(b, 'vip1', 'badword', { vip: true, subscriber: true })).toEqual([WARN('vip1')]);
    });

    it('CHAT_FILTER_URLS flags http(s):// and www. links', async () => {
      const b = await start({ env: { CHAT_FILTER_URLS: 'true' } });
      expect(await talk(b, 'viewer1', 'see https://example.com')).toEqual([WARN('viewer1')]);
      expect(await talk(b, 'viewer1', 'see WWW.example.com')).toEqual([WARN('viewer1')]);
      expect(await talk(b, 'viewer1', 'see example.com')).toEqual([]);
    });

    it('CHAT_FILTER_ALLCAPS flags messages of 5+ chars that are at least half capitals', async () => {
      const b = await start({ env: { CHAT_FILTER_ALLCAPS: '1' } });
      expect(await talk(b, 'viewer1', 'HELLO')).toEqual([WARN('viewer1')]);
      expect(await talk(b, 'viewer1', 'HEY')).toEqual([]);
      expect(await talk(b, 'viewer1', 'ABcd')).toEqual([]);
      expect(await talk(b, 'viewer1', 'ABCde')).toEqual([WARN('viewer1')]);
      expect(await talk(b, 'viewer1', 'ABcd ')).toEqual([]);
      // Spaces and punctuation count toward the length: 3 caps of 7 chars is below half
      expect(await talk(b, 'viewer1', 'ABC ...')).toEqual([]);
    });

    it('CHAT_FILTER_REPEAT flags 3+ identical characters in a row', async () => {
      const b = await start({ env: { CHAT_FILTER_REPEAT: 'true' } });
      expect(await talk(b, 'viewer1', 'sooo good')).toEqual([WARN('viewer1')]);
      expect(await talk(b, 'viewer1', 'soo good')).toEqual([]);
      expect(await talk(b, 'viewer1', '!!!')).toEqual([WARN('viewer1')]);
    });

    it('CHAT_FILTER_SPAM flags the same message from the same user within 5s', async () => {
      const b = await start({ env: { CHAT_FILTER_SPAM: 'true' } });
      expect(await talk(b, 'viewer1', 'Same Thing')).toEqual([]);
      expect(await talk(b, 'viewer1', '  same thing ')).toEqual([WARN('viewer1')]);
      expect(await talk(b, 'viewer2', 'same thing')).toEqual([]);
      await b.advance(4999);
      expect(await talk(b, 'viewer1', 'same thing')).toEqual([WARN('viewer1')]);
      await b.advance(5000);
      expect(await talk(b, 'viewer1', 'same thing')).toEqual([]);
    });

    it('several violations still produce one warning', async () => {
      const b = await start({ env: { CHAT_FILTER_URLS: 'true', CHAT_FILTER_ALLCAPS: 'true', CHAT_FILTER_REPEAT: 'true' } });
      expect(await talk(b, 'viewer1', 'WWW.AAAA.COM')).toEqual([WARN('viewer1')]);
    });
  });

  describe('!addfilter / !removefilter / !filters', () => {
    it('!filters shows the current configuration as JSON', async () => {
      const b = await start();
      expect(await talk(b, 'mod1', '!filters', { mod: true })).toEqual([`Filters: ${JSON.stringify(DEFAULT_FILTERS)}`]);
    });

    it('!filters reflects env configuration', async () => {
      const b = await start({ env: {
        CHAT_FILTER_WORDS: 'a|b', CHAT_FILTER_URLS: '1', CHAT_FILTER_ALLCAPS: 'yes', CHAT_FILTER_SPAM: 'true',
        CHAT_FILTER_TIMEOUT_SEC: '30', CHAT_FILTER_ACTION: 'delete'
      } });
      expect(await talk(b, 'mod1', '!filters', { mod: true })).toEqual([`Filters: ${JSON.stringify({
        ...DEFAULT_FILTERS, blacklistWords: ['a', 'b'], filterUrls: true, filterSpam: true,
        timeoutDurationSeconds: 30, filterAction: 'delete'
      })}`]);
    });

    it('!addfilter adds a lowercased word that is enforced immediately', async () => {
      const b = await start();
      expect(await talk(b, 'mod1', '!addfilter Spoiler extra', { mod: true })).toEqual(['Word "Spoiler" added to blacklist.']);
      expect(await talk(b, 'viewer1', 'big spoiler ahead')).toEqual([WARN('viewer1')]);
      expect(await talk(b, 'mod1', '!filters', { mod: true })).toEqual([`Filters: ${JSON.stringify({ ...DEFAULT_FILTERS, blacklistWords: ['spoiler'] })}`]);
    });

    it('!removefilter removes a word and saves the change; a word that was not listed is reported', async () => {
      const b = await start();
      await talk(b, 'mod1', '!addfilter spoiler', { mod: true });
      await talk(b, 'mod1', '!addfilter keep', { mod: true });
      expect(fs.readFileSync(b.envPath, 'utf8')).toMatch(/^CHAT_FILTER_WORDS=spoiler\|keep$/m);
      expect(await talk(b, 'caster', '!removefilter SPOILER', { broadcaster: true })).toEqual(['Word "SPOILER" removed from blacklist.']);
      expect(await talk(b, 'viewer1', 'spoiler')).toEqual([]);
      expect(b.dashboardCalls().filter((c) => c.route.startsWith('DELETE /api/filters/words/')).map((c) => c.route)).toEqual([
        'DELETE /api/filters/words/spoiler'
      ]);
      expect(fs.readFileSync(b.envPath, 'utf8')).toMatch(/^CHAT_FILTER_WORDS=keep$/m);
      expect(await talk(b, 'caster', '!removefilter nothere', { broadcaster: true })).toEqual(['Word "nothere" is not in the blacklist.']);
      expect(b.dashboardCalls().filter((c) => c.route.startsWith('DELETE /api/filters/words/'))).toHaveLength(1);
    });

    it('usage errors without a word', async () => {
      const b = await start();
      expect(await talk(b, 'mod1', '!addfilter', { mod: true })).toEqual(['@mod1 Usage: !addfilter <word>']);
      expect(await talk(b, 'mod1', '!removefilter   ', { mod: true })).toEqual(['@mod1 Usage: !removefilter <word>']);
    });

    it('viewers are rejected and nothing changes', async () => {
      const b = await start();
      expect(await talk(b, 'viewer1', '!addfilter hello')).toEqual(['@viewer1 Only moderators can use this command.']);
      expect(await talk(b, 'viewer1', '!removefilter hello')).toEqual(['@viewer1 Only moderators can use this command.']);
      expect(await talk(b, 'viewer1', '!filters')).toEqual(['@viewer1 Only moderators can use this command.']);
      expect(await talk(b, 'viewer2', 'hello')).toEqual([]);
    });

    it('saving a chat-added word keeps the words already in .env', async () => {
      const b = await start({ env: { CHAT_FILTER_WORDS: 'old' } });
      expect(await talk(b, 'mod1', '!addfilter new', { mod: true })).toEqual(['Word "new" added to blacklist.']);
      expect(fs.readFileSync(b.envPath, 'utf8')).toMatch(/^CHAT_FILTER_WORDS=old\|new$/m);
      expect(await talk(b, 'mod1', '!removefilter old', { mod: true })).toEqual(['Word "old" removed from blacklist.']);
      expect(fs.readFileSync(b.envPath, 'utf8')).toMatch(/^CHAT_FILTER_WORDS=new$/m);
    });

    it('chat-added words are saved through the dashboard filter API (and so to .env)', async () => {
      const b = await start();
      await talk(b, 'mod1', '!addfilter Spoiler', { mod: true });
      expect(b.dashboardCalls().filter((c) => c.route === 'POST /api/filters/words').map((c) => c.body)).toEqual([{ word: 'spoiler' }]);
      expect(fs.readFileSync(b.envPath, 'utf8')).toMatch(/^CHAT_FILTER_WORDS=spoiler$/m);
      const dashboardFilters = await (await fetch(`${b.dashboardUrl}/api/filters`)).json();
      expect(dashboardFilters.blacklistWords).toEqual(['spoiler']);
    });
  });

  describe('hype', () => {
    const status = (u: string, count: number, threshold = 15, cooldown = 120) =>
      `@${u} Chat energy: ${count} messages in the last 60s. Hype triggers at ${threshold}. (Cooldown: ${cooldown}s)`;

    it('!hype shows the message count (including itself) and the defaults', async () => {
      const b = await start();
      await talk(b, 'viewer1', 'one');
      await talk(b, 'viewer2', 'two');
      expect(await talk(b, 'viewer3', '!hype')).toEqual([status('viewer3', 3)]);
    });

    it('only counts messages inside the 60s window', async () => {
      const b = await start({ dashboardData: { 'builtinCommands.json': [{ name: '!hype', cooldownSeconds: 0 }] } });
      await talk(b, 'viewer1', 'one');
      await b.advance(30_000);
      await talk(b, 'viewer1', 'two');
      await b.advance(30_001);
      expect(await talk(b, 'viewer1', '!hype')).toEqual([status('viewer1', 2)]);
    });

    it('viewers share a 15s cooldown; mods bypass it and do not start it', async () => {
      const b = await start();
      expect(await talk(b, 'mod1', '!hype', { mod: true })).toEqual([status('mod1', 1)]);
      expect(await talk(b, 'viewer1', '!hype')).toEqual([status('viewer1', 2)]);
      expect(await talk(b, 'viewer2', '!hype')).toEqual(['@viewer2 !hype is on cooldown. Try again in 15s.']);
      expect(await talk(b, 'mod1', '!hype', { mod: true })).toEqual([status('mod1', 4)]);
      await b.advance(15_000);
      expect(await talk(b, 'viewer2', '!hype')).toEqual([status('viewer2', 5)]);
    });

    it('!hype set <5-200> (mods) changes the threshold, with bounds', async () => {
      const b = await start();
      expect(await talk(b, 'mod1', '!hype set 4', { mod: true })).toEqual(['@mod1 Usage: !hype set <5-200>. Threshold must be between 5 and 200 messages.']);
      expect(await talk(b, 'mod1', '!hype set 201', { mod: true })).toEqual(['@mod1 Usage: !hype set <5-200>. Threshold must be between 5 and 200 messages.']);
      expect(await talk(b, 'mod1', '!hype set abc', { mod: true })).toEqual(['@mod1 Usage: !hype set <5-200>. Threshold must be between 5 and 200 messages.']);
      expect(await talk(b, 'mod1', '!hype set 200', { mod: true })).toEqual(['@mod1 Hype now triggers at 200 messages in 60s.']);
      expect(await talk(b, 'mod1', '!HYPE SET 5', { mod: true })).toEqual(['@mod1 Hype now triggers at 5 messages in 60s.']);
      // The new threshold is already met by the 6 messages in the window, so this message triggers hype too
      expect(await talk(b, 'mod1', '!hype', { mod: true })).toEqual(['Chat is HYPED! 🔥', status('mod1', 6, 5)]);
    });

    it('!hype set without a number shows the status', async () => {
      const b = await start();
      expect(await talk(b, 'mod1', '!hype set', { mod: true })).toEqual([status('mod1', 1)]);
    });

    it('!hype cooldown <30-600> (mods), with bounds', async () => {
      const b = await start();
      expect(await talk(b, 'mod1', '!hype cooldown 29', { mod: true })).toEqual(['@mod1 Cooldown must be between 30 and 600 seconds.']);
      expect(await talk(b, 'mod1', '!hype cooldown 601', { mod: true })).toEqual(['@mod1 Cooldown must be between 30 and 600 seconds.']);
      expect(await talk(b, 'mod1', '!hype cooldown 30', { mod: true })).toEqual(['@mod1 Hype cooldown set to 30s.']);
      expect(await talk(b, 'mod1', '!hype cooldown 600', { mod: true })).toEqual(['@mod1 Hype cooldown set to 600s.']);
      expect(await talk(b, 'mod1', '!hype', { mod: true })).toEqual([status('mod1', 5, 15, 600)]);
    });

    it('!hype toggle (mods) switches hype off and on', async () => {
      const b = await start();
      expect(await talk(b, 'caster', '!hype toggle', { broadcaster: true })).toEqual(['@caster Hype is now OFF.']);
      expect(await talk(b, 'caster', '!hype', { broadcaster: true })).toEqual(['@caster Chat energy: Hype is currently disabled.']);
      expect(await talk(b, 'caster', '!hype toggle', { broadcaster: true })).toEqual(['@caster Hype is now ON.']);
    });

    it('viewers cannot change settings: their sub-commands are refused and start no cooldown', async () => {
      const b = await start();
      const refused = '@viewer1 Only moderators can change hype settings.';
      expect(await talk(b, 'viewer1', '!hype set 5')).toEqual([refused]);
      expect(await talk(b, 'viewer1', '!hype toggle')).toEqual([refused]);
      expect(await talk(b, 'viewer1', '!hype cooldown 30')).toEqual([refused]);
      expect(await talk(b, 'viewer1', '!hype set')).toEqual([refused]);
      // Nothing changed, and the refusals did not start the 15s cooldown
      expect(await talk(b, 'viewer1', '!hype')).toEqual([status('viewer1', 5)]);
      expect(await talk(b, 'viewer2', '!hype')).toEqual(['@viewer2 !hype is on cooldown. Try again in 15s.']);
    });

    it('auto-triggers at the threshold, posts to the dashboard, then respects the hype cooldown', async () => {
      const b = await start({ env: { HYPE_MIN_MESSAGES: '5', HYPE_COOLDOWN_SEC: '30' } });
      for (let i = 1; i <= 4; i++) expect(await talk(b, `v${i}`, `msg ${i}`)).toEqual([]);
      expect(await talk(b, 'v5', 'msg 5')).toEqual(['Chat is HYPED! 🔥']);
      const trigger = b.dashboardCalls().filter((c) => c.route === 'POST /api/hype/trigger');
      // The dashboard has no /api/hype/trigger route (404); the bot ignores the error
      expect(trigger.map((c) => c.body)).toEqual([{ channel: 'caster', count: 5, threshold: 5, windowSec: 60 }]);
      expect(await talk(b, 'v6', 'msg 6')).toEqual([]);
      await b.advance(29_000);
      expect(await talk(b, 'v7', 'msg 7')).toEqual([]);
      await b.advance(1000);
      // Still 5+ messages inside the 60s window and the 30s cooldown has passed
      expect(await talk(b, 'v8', 'msg 8')).toEqual(['Chat is HYPED! 🔥']);
    });

    it('the triggering message can also be a command; hype is said first', async () => {
      const b = await start({ env: { HYPE_MIN_MESSAGES: '5', HYPE_MESSAGE: '  LET\'S GO  ' } });
      for (let i = 1; i <= 4; i++) await talk(b, `v${i}`, 'x');
      expect(await talk(b, 'v5', '!hype')).toEqual(['LET\'S GO', status('v5', 5, 5)]);
    });

    it('clamps HYPE_MIN_MESSAGES to at least 5 and HYPE_COOLDOWN_SEC to at least 30', async () => {
      const b = await start({ env: { HYPE_MIN_MESSAGES: '2', HYPE_COOLDOWN_SEC: '1' } });
      expect(await talk(b, 'viewer1', '!hype')).toEqual([status('viewer1', 1, 5, 30)]);
    });

    it('HYPE_WINDOW_SEC changes the counting window', async () => {
      const b = await start({ env: { HYPE_WINDOW_SEC: '10' }, dashboardData: { 'builtinCommands.json': [{ name: '!hype', cooldownSeconds: 0 }] } });
      await talk(b, 'viewer1', 'old');
      await b.advance(10_001);
      expect(await talk(b, 'viewer1', '!hype')).toEqual(['@viewer1 Chat energy: 1 messages in the last 10s. Hype triggers at 15. (Cooldown: 120s)']);
    });

    it('HYPE_ENABLED=false never triggers', async () => {
      const b = await start({ env: { HYPE_ENABLED: 'false', HYPE_MIN_MESSAGES: '5' } });
      for (let i = 1; i <= 6; i++) expect(await talk(b, `v${i}`, 'x')).toEqual([]);
      expect(await talk(b, 'viewer1', '!hype')).toEqual(['@viewer1 Chat energy: Hype is currently disabled.']);
    });

    it('messages dropped by the "delete" filter do not count toward hype', async () => {
      const b = await start({ env: { CHAT_FILTER_WORDS: 'badword', CHAT_FILTER_ACTION: 'delete' } });
      await talk(b, 'viewer1', 'badword');
      expect(await talk(b, 'viewer2', '!hype')).toEqual([status('viewer2', 1)]);
    });
  });
});
