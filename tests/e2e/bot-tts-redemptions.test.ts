/**
 * Characterization tests: !tts and channel point redemptions (EventSub on the
 * broadcaster token), including the TTS redemption queue (src/lib/tts-redemption-queue.ts).
 *
 * TTS output goes to the dashboard as POST /api/test-alert {alertType:'tts', ...};
 * with TTS_PROVIDER other than 'browser' the bot first asks the dashboard's
 * POST /api/tts/generate (src/lib/tts-service.ts). The dashboard is started with initTts:false,
 * so tts-service never runs initialize(): its provider comes straight from
 * process.env.TTS_PROVIDER at load time with no "missing API key -> browser" fallback.
 * Only providers that need no network are exercised here (see report: api.openai.com /
 * api.elevenlabs.io are not redirected by the harness).
 */
jest.mock('axios', () => require('./harness/redirect').axiosMock());
jest.mock('ws', () => require('./harness/redirect').wsMock());
jest.mock('tmi.js', () => require('./harness/redirect').tmiMock());
jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('../../src/lib/console-timestamp', () => ({}));

import { startBot, BotHarness, BotOptions, ChatTags, BROADCASTER } from './harness/bot';
import { ALL_SCOPES } from './harness/fake-twitch';

const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add';

interface TtsAlert {
  alertType: string;
  user: string;
  message: string;
  timestamp: string;
  audioUrl: string | null;
  useBrowserTTS: boolean;
  config: { ttsEnabled: boolean; ttsTemplate: string; duration: number };
}

/**
 * Robustness wrappers around the harness. Under CPU load bot.settle() can declare the bot idle
 * while a reply is still in flight (only dashboard requests are tracked as pending), and
 * startBot() can return before the bot has connected its chat client. These helpers settle a
 * few more times until something is observed.
 */
async function waitFor(bot: BotHarness, cond: () => boolean, tries = 50): Promise<void> {
  for (let i = 0; i < tries && !cond(); i++) await bot.settle();
}
async function chat(bot: BotHarness, user: string, text: string, tags: ChatTags = {}): Promise<string[]> {
  const out = await bot.chat(user, text, tags);
  await waitFor(bot, () => { out.push(...bot.take()); return out.length > 0; }, 3);
  return out;
}
async function ready(bot: BotHarness): Promise<BotHarness> {
  await waitFor(bot, () => bot.dashboardCalls().some((c) => c.route.endsWith('/custom-commands')));
  await bot.settle();
  return bot;
}
async function event(bot: BotHarness, type: string, ev: Record<string, unknown>): Promise<string[]> {
  const out = await bot.event(type, ev);
  await waitFor(bot, () => { out.push(...bot.take()); return out.length > 0; }, 3);
  return out;
}

async function start(opts: { env?: Record<string, string>; broadcaster?: BotOptions['broadcasterToken'] } = {}): Promise<BotHarness> {
  return ready(await startBot({
    env: { HYPE_ENABLED: 'false', ...(opts.env || {}) },
    broadcasterToken: opts.broadcaster
  }));
}

const alerts = (bot: BotHarness) => bot.dashboardCalls().filter((c) => c.route === 'POST /api/test-alert').map((c) => c.body);
const ttsAlerts = (bot: BotHarness): TtsAlert[] => alerts(bot).filter((a) => a.alertType === 'tts');
const logs = (bot: BotHarness) => bot.dashboardCalls().filter((c) => c.route === 'POST /api/logs').map((c) => c.body);
const generateCalls = (bot: BotHarness) => bot.dashboardCalls().filter((c) => c.route.endsWith(' /tts/generate') || c.route === 'POST /api/tts/generate');

let redemptionCount = 0;
function redemption(over: { title?: string; input?: string; user?: string; display?: string | null; reward?: unknown } = {}) {
  redemptionCount += 1;
  const login = (over.user || 'viewer1').toLowerCase();
  return {
    id: `redemption-${redemptionCount}`,
    broadcaster_user_id: BROADCASTER.id,
    broadcaster_user_login: BROADCASTER.login,
    broadcaster_user_name: BROADCASTER.display_name,
    user_id: `77${redemptionCount}`,
    user_login: login,
    user_name: over.user || 'Viewer1',
    ...(over.display === null ? {} : { user_display_name: over.display || over.user || 'Viewer1' }),
    user_input: over.input ?? '',
    status: 'unfulfilled',
    reward: over.reward !== undefined ? over.reward : { id: 'reward-1', title: over.title ?? 'Hydrate', cost: 100, prompt: '' },
    redeemed_at: new Date().toISOString()
  };
}

describe('TTS and channel point redemptions', () => {
  let bot: BotHarness | undefined;
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => {
    await bot?.stop();
    bot = undefined;
  });

  describe('!tts', () => {
    it('empty message: usage, no alert', async () => {
      bot = await start();
      expect(await chat(bot, 'viewer1', '!tts')).toEqual(['@viewer1 Usage: !tts <message> (max 200 characters)']);
      expect(await chat(bot, 'viewer1', '!tts     ')).toEqual(['@viewer1 Usage: !tts <message> (max 200 characters)']);
      expect(ttsAlerts(bot)).toEqual([]);
      expect(logs(bot).filter((l) => l.command === '!tts')).toEqual([]);
    });

    it('sends a browser-TTS alert to the overlay, says nothing in chat, logs success', async () => {
      bot = await start();
      expect(await chat(bot, 'viewer1', '!TTS  hello   there  world')).toEqual([]);
      const [alert] = ttsAlerts(bot);
      // args are split on whitespace and re-joined with single spaces
      expect(alert).toEqual({
        alertType: 'tts', user: 'viewer1', message: 'hello there world', timestamp: expect.any(String),
        audioUrl: null, useBrowserTTS: true,
        config: { ttsEnabled: true, ttsTemplate: 'hello there world', duration: 5000 + 17 * 50 }
      });
      expect(generateCalls(bot)).toEqual([]);
      expect(logs(bot)).toContainEqual(expect.objectContaining({ user: 'viewer1', command: '!tts', args: 'hello there world', success: true }));
    });

    it('length boundary: 200 ok, 201 too long (and no cooldown is started)', async () => {
      bot = await start();
      expect(await chat(bot, 'viewer1', `!tts ${'a'.repeat(201)}`)).toEqual(['@viewer1 TTS message too long! Max 200 characters (you used 201).']);
      expect(ttsAlerts(bot)).toEqual([]);
      expect(await chat(bot, 'viewer1', `!tts ${'a'.repeat(200)}`)).toEqual([]);
      expect(ttsAlerts(bot)).toHaveLength(1);
      expect(ttsAlerts(bot)[0].config.duration).toBe(5000 + 200 * 50);
    });

    it('length counts the re-joined text, not the raw message', async () => {
      bot = await start();
      // 100 words "a" separated by 3 spaces: raw is 397 chars, re-joined is 199
      expect(await chat(bot, 'viewer1', `!tts ${Array(100).fill('a').join('   ')}`)).toEqual([]);
      expect(ttsAlerts(bot)).toHaveLength(1);
    });

    it('global 10s cooldown is checked first and does not start the user cooldown', async () => {
      bot = await start();
      await chat(bot, 'viewer1', '!tts first');
      expect(await chat(bot, 'viewer2', '!tts second')).toEqual(['@viewer2 TTS is on global cooldown. Try again in 10s.']);
      await bot.advance(4_200);
      expect(await chat(bot, 'viewer2', '!tts second')).toEqual(['@viewer2 TTS is on global cooldown. Try again in 6s.']);
      // the original requester sees the global message too, not the per-user one
      expect(await chat(bot, 'viewer1', '!tts again')).toEqual(['@viewer1 TTS is on global cooldown. Try again in 6s.']);
      await bot.advance(5_800);
      expect(await chat(bot, 'viewer2', '!tts second')).toEqual([]);
      expect(ttsAlerts(bot).map((a) => a.message)).toEqual(['first', 'second']);
    });

    it('per-user 30s cooldown', async () => {
      bot = await start();
      await chat(bot, 'viewer1', '!tts one');
      await bot.advance(10_000);
      expect(await chat(bot, 'viewer1', '!tts two')).toEqual(["@viewer1 You're on TTS cooldown. Try again in 20s."]);
      await bot.advance(19_500);
      expect(await chat(bot, 'viewer1', '!tts two')).toEqual(["@viewer1 You're on TTS cooldown. Try again in 1s."]);
      await bot.advance(500);
      expect(await chat(bot, 'viewer1', '!tts two')).toEqual([]);
      expect(ttsAlerts(bot).map((a) => a.message)).toEqual(['one', 'two']);
    });

    it('mods and the broadcaster are subject to the same cooldowns', async () => {
      bot = await start();
      await chat(bot, 'mod1', '!tts hi', { mod: true });
      expect(await chat(bot, 'caster', '!tts hi', { broadcaster: true })).toEqual(['@caster TTS is on global cooldown. Try again in 10s.']);
      await bot.advance(10_000);
      expect(await chat(bot, 'mod1', '!tts hi', { mod: true })).toEqual(["@mod1 You're on TTS cooldown. Try again in 20s."]);
    });

    it('ignores the !tts cooldown in builtinCommands.json (hard-coded TTS_CONFIG instead)', async () => {
      bot = await start();
      bot.writeData('builtinCommands.json', [{ name: '!tts', cooldownSeconds: 0 }]);
      await chat(bot, 'viewer1', '!tts one');
      expect(await chat(bot, 'viewer2', '!tts two')).toEqual(['@viewer2 TTS is on global cooldown. Try again in 10s.']);
    });

    describe('chat filters', () => {
      const env = { CHAT_FILTER_WORDS: 'badword|worse', CHAT_FILTER_URLS: 'true' };

      it('viewer: chat-filter warning, then the TTS is blocked without starting a cooldown', async () => {
        bot = await start({ env });
        expect(await chat(bot, 'viewer1', '!tts you BADWORD!')).toEqual([
          '@viewer1 Your message violated chat rules. Please be respectful.',
          '@viewer1 TTS message blocked: contains filtered content (blacklist_word).'
        ]);
        expect(logs(bot)).toContainEqual(expect.objectContaining({ command: '!tts', args: 'you BADWORD!', success: false }));
        expect(await chat(bot, 'viewer1', '!tts see www.example.com worse')).toEqual([
          '@viewer1 Your message violated chat rules. Please be respectful.',
          '@viewer1 TTS message blocked: contains filtered content (blacklist_word, url).'
        ]);
        expect(ttsAlerts(bot)).toEqual([]);
        expect(await chat(bot, 'viewer1', '!tts nice words')).toEqual([]);
        expect(ttsAlerts(bot)).toHaveLength(1);
      });

      it('mods and the broadcaster bypass the filters', async () => {
        bot = await start({ env });
        expect(await chat(bot, 'mod1', '!tts badword', { mod: true })).toEqual([]);
        await bot.advance(10_000);
        expect(await chat(bot, 'caster', '!tts https://x.y', { broadcaster: true })).toEqual([]);
        expect(ttsAlerts(bot).map((a) => a.message)).toEqual(['badword', 'https://x.y']);
      });

      it('with CHAT_FILTER_ACTION=delete a filtered !tts is dropped before the command runs', async () => {
        bot = await start({ env: { ...env, CHAT_FILTER_ACTION: 'delete' } });
        expect(await chat(bot, 'viewer1', '!tts badword')).toEqual([]);
        expect(ttsAlerts(bot)).toEqual([]);
        expect(logs(bot)).toEqual([]);
      });
    });

    describe('TTS_PROVIDER', () => {
      it('explicit "browser": no generate call', async () => {
        bot = await start({ env: { TTS_PROVIDER: 'browser' } });
        await chat(bot, 'viewer1', '!tts hi');
        expect(generateCalls(bot)).toEqual([]);
        expect(ttsAlerts(bot)[0]).toMatchObject({ audioUrl: null, useBrowserTTS: true });
      });

      it('any other provider asks the dashboard first; a browser answer keeps browser TTS', async () => {
        // An unknown provider name makes tts-service answer {success:true, useBrowserTTS:true} without network
        bot = await start({ env: { TTS_PROVIDER: 'polly' } });
        expect(await chat(bot, 'viewer1', '!tts hello world')).toEqual([]);
        const calls = generateCalls(bot);
        expect(calls).toHaveLength(1);
        expect(calls[0].body).toEqual({ text: 'hello world', voice: null, provider: null });
        expect(ttsAlerts(bot)[0]).toMatchObject({ message: 'hello world', audioUrl: null, useBrowserTTS: true });
        expect(logs(bot)).toContainEqual(expect.objectContaining({ command: '!tts', success: true }));
      });

      it('the provider is read per call from process.env', async () => {
        bot = await start();
        await chat(bot, 'viewer1', '!tts one');
        expect(generateCalls(bot)).toHaveLength(0);
        process.env.TTS_PROVIDER = 'polly';
        await bot.advance(10_000);
        await chat(bot, 'viewer2', '!tts two');
        expect(generateCalls(bot)).toHaveLength(1);
      });
    });
  });

  describe('channel point redemptions', () => {
    it('without a broadcaster token there is no redemption subscription', async () => {
      bot = await start();
      expect(bot.twitch.state.subscriptions.filter((s) => s.type === REDEMPTION)).toEqual([]);
      expect(bot.twitch.emitEvent(REDEMPTION, redemption())).toBe(0);
    });

    it('without channel:read:redemptions on the broadcaster token there is no subscription', async () => {
      bot = await start({ broadcaster: { scopes: ALL_SCOPES.filter((s) => s !== 'channel:read:redemptions') } });
      expect(bot.twitch.state.subscriptions.filter((s) => s.type === REDEMPTION)).toEqual([]);
    });

    it('subscribes with the broadcaster token on its own EventSub session', async () => {
      bot = await start({ broadcaster: true });
      const subs = bot.twitch.state.subscriptions.filter((s) => s.type === REDEMPTION);
      expect(subs).toHaveLength(1);
      expect(subs[0]).toMatchObject({ version: '1', condition: { broadcaster_user_id: BROADCASTER.id } });
      expect(bot.twitch.state.tokens.get(subs[0].token)?.login).toBe(BROADCASTER.login);
    });

    it('a non-TTS reward is echoed to chat, logged and alerted; nothing is refunded or fulfilled', async () => {
      bot = await start({ broadcaster: true });
      expect(await event(bot, REDEMPTION, redemption({ title: 'Hydrate', user: 'Viewer1' }))).toEqual(['Viewer1 redeemed: Hydrate']);
      expect(await event(bot, REDEMPTION, redemption({ title: 'Pick a game', input: 'Tetris 99', user: 'Viewer2' }))).toEqual(['Viewer2 redeemed: Pick a game - Tetris 99']);

      const posted = bot.dashboardCalls();
      expect(posted.filter((c) => c.route === 'POST /api/redemptions').map((c) => c.body)).toEqual([
        { user: 'Viewer1', reward: 'Hydrate', input: '' },
        { user: 'Viewer2', reward: 'Pick a game', input: 'Tetris 99' }
      ]);
      expect(posted.filter((c) => c.route === 'POST /api/eventsub-events').map((c) => c.body)).toEqual([
        { type: 'redemption', user: 'Viewer1', reward: 'Hydrate', message: '' },
        { type: 'redemption', user: 'Viewer2', reward: 'Pick a game', message: 'Tetris 99' }
      ]);
      expect(alerts(bot)).toEqual([
        { alertType: 'redemption', user: 'Viewer1', reward: 'Hydrate', message: '' },
        { alertType: 'redemption', user: 'Viewer2', reward: 'Pick a game', message: 'Tetris 99' }
      ]);
      expect(bot.readData('redemptions.json')).toEqual([
        { user: 'Viewer1', reward: 'Hydrate', input: '', timestamp: expect.any(String) },
        { user: 'Viewer2', reward: 'Pick a game', input: 'Tetris 99', timestamp: expect.any(String) }
      ]);
      expect(bot.readData('eventsub-events.json')).toHaveLength(2);
      // no Helix redemption status updates (fulfil / cancel)
      expect(bot.twitch.requests.filter((r) => r.path.includes('channel_points'))).toEqual([]);
    });

    it('falls back to user_name and to "Reward" when fields are missing', async () => {
      bot = await start({ broadcaster: true });
      expect(await event(bot, REDEMPTION, redemption({ user: 'Plain', display: null, reward: null }))).toEqual(['Plain redeemed: Reward']);
    });

    it('a song-request reward is not wired to the song queue: it is only echoed', async () => {
      bot = await start({ broadcaster: true, env: { YOUTUBE_API_KEY: 'k' } });
      const url = 'https://youtu.be/dQw4w9WgXcQ';
      expect(await event(bot, REDEMPTION, redemption({ title: 'Song Request', input: url }))).toEqual([`Viewer1 redeemed: Song Request - ${url}`]);
      expect(bot.dashboardCalls().filter((c) => c.route.includes('song-queue') || c.route.endsWith(' /add'))).toEqual([]);
      expect(bot.twitch.requests.filter((r) => r.path.startsWith('/youtube/'))).toEqual([]);
    });

    describe('TTS rewards', () => {
      it('a reward whose title contains the word "TTS" (any case) speaks the input; no chat echo', async () => {
        bot = await start({ broadcaster: true });
        expect(await event(bot, REDEMPTION, redemption({ title: 'Send a TTS message', input: 'hello from points', user: 'Viewer1' }))).toEqual([]);
        expect(ttsAlerts(bot)).toEqual([expect.objectContaining({ user: 'Viewer1', message: 'hello from points', useBrowserTTS: true })]);
        expect(bot.dashboardCalls().filter((c) => c.route === 'POST /api/redemptions').map((c) => c.body)).toEqual([
          { user: 'Viewer1', reward: 'Send a TTS message', input: 'hello from points' }
        ]);
        // not logged as an EventSub event / redemption alert
        expect(bot.dashboardCalls().filter((c) => c.route === 'POST /api/eventsub-events')).toEqual([]);
        expect(alerts(bot).filter((a) => a.alertType === 'redemption')).toEqual([]);
        // logged as a !tts command by the display name
        expect(logs(bot)).toContainEqual(expect.objectContaining({ user: 'Viewer1', command: '!tts', args: 'hello from points', success: true }));
      });

      it('titles that only contain the letters "tts" inside another word are normal rewards', async () => {
        bot = await start({ broadcaster: true });
        expect(await event(bot, REDEMPTION, redemption({ title: 'Pet the Mutts', input: 'good dogs' }))).toEqual(['Viewer1 redeemed: Pet the Mutts - good dogs']);
        expect(await event(bot, REDEMPTION, redemption({ title: 'Buttsplosion', input: 'boom' }))).toEqual(['Viewer1 redeemed: Buttsplosion - boom']);
        expect(ttsAlerts(bot)).toEqual([]);
      });

      it('matches "TTS" as a word anywhere in the title', async () => {
        bot = await start({ broadcaster: true });
        await event(bot, REDEMPTION, redemption({ title: 'tts', input: 'one' }));
        await bot.advance(10_000);
        await event(bot, REDEMPTION, redemption({ title: 'TTS: say it!', input: 'two' }));
        expect(ttsAlerts(bot).map((a) => a.message)).toEqual(['one', 'two']);
      });

      it('with TTS_REWARD_TITLE set, only that exact title (ignoring case) is TTS', async () => {
        bot = await start({ broadcaster: true, env: { TTS_REWARD_TITLE: 'Speak, Bot!' } });
        expect(await event(bot, REDEMPTION, redemption({ title: 'TTS Message', input: 'not me' }))).toEqual(['Viewer1 redeemed: TTS Message - not me']);
        expect(await event(bot, REDEMPTION, redemption({ title: 'speak, bot!', input: 'me' }))).toEqual([]);
        expect(ttsAlerts(bot).map((a) => a.message)).toEqual(['me']);
      });

      it('a TTS reward with no input is echoed like any other reward', async () => {
        bot = await start({ broadcaster: true });
        expect(await event(bot, REDEMPTION, redemption({ title: 'TTS' }))).toEqual(['Viewer1 redeemed: TTS']);
        expect(ttsAlerts(bot)).toEqual([]);
      });

      it('input is split on single spaces only: extra spaces are kept', async () => {
        bot = await start({ broadcaster: true });
        await event(bot, REDEMPTION, redemption({ title: 'TTS', input: '  spaced   out  ' }));
        // args = input.split(' ') then join(' ').trim(): inner runs of spaces survive (unlike !tts)
        expect(ttsAlerts(bot)[0].message).toBe('spaced   out');
      });

      it('too long input is rejected in chat and the redemption is refunded (cancelled on Twitch)', async () => {
        bot = await start({ broadcaster: true });
        const ev = redemption({ title: 'TTS', input: 'x'.repeat(201), user: 'Viewer1' });
        expect(await event(bot, REDEMPTION, ev)).toEqual([
          '@Viewer1 TTS message too long! Max 200 characters (you used 201).'
        ]);
        await waitFor(bot, () => bot!.twitch.state.redemptionUpdates.length > 0);
        expect(bot.twitch.state.redemptionUpdates).toEqual([
          { broadcasterId: BROADCASTER.id, rewardId: 'reward-1', id: ev.id, status: 'CANCELED', token: process.env.TWITCH_BROADCASTER_ACCESS_TOKEN }
        ]);
        expect(ttsAlerts(bot)).toEqual([]);
      });

      it('a refund that Twitch refuses is only logged', async () => {
        bot = await start({ broadcaster: true });
        bot.twitch.state.failures.set('PATCH /helix/channel_points/custom_rewards/redemptions', { status: 403, message: 'The ID in header must match the client ID of the reward' });
        expect(await event(bot, REDEMPTION, redemption({ title: 'TTS', input: 'x'.repeat(201), user: 'Viewer1' }))).toHaveLength(1);
        await waitFor(bot, () => (console.warn as jest.Mock).mock.calls.some((c) => String(c[0]).includes('Could not refund')));
        expect(console.warn).toHaveBeenCalledWith("[EventSub-Broadcaster] Could not refund Viewer1's redemption:", 'The ID in header must match the client ID of the reward');
      });

      it('no refund is attempted without channel:manage:redemptions', async () => {
        bot = await start({ broadcaster: { scopes: ALL_SCOPES.filter((s) => s !== 'channel:manage:redemptions') } });
        await event(bot, REDEMPTION, redemption({ title: 'TTS', input: 'x'.repeat(201), user: 'Viewer1' }));
        expect(console.warn).toHaveBeenCalledWith("[EventSub-Broadcaster] Cannot refund Viewer1's redemption: broadcaster token lacks channel:manage:redemptions");
        expect(bot.twitch.requests.filter((r) => r.path.includes('channel_points'))).toEqual([]);
      });

      it('a successful or queued TTS redemption is not refunded', async () => {
        bot = await start({ broadcaster: true });
        await event(bot, REDEMPTION, redemption({ title: 'TTS', input: 'spoken' }));
        await event(bot, REDEMPTION, redemption({ title: 'TTS', input: 'queued' }));
        await bot.advance(10_000);
        await waitFor(bot, () => ttsAlerts(bot!).length >= 2);
        expect(bot.twitch.state.redemptionUpdates).toEqual([]);
      });

      it('filtered input is blocked (and refunded) even for the broadcaster (no mod context on redemptions)', async () => {
        bot = await start({ broadcaster: true, env: { CHAT_FILTER_WORDS: 'badword' } });
        expect(await event(bot, REDEMPTION, redemption({ title: 'TTS', input: 'badword', user: 'Caster' }))).toEqual([
          '@Caster TTS message blocked: contains filtered content (blacklist_word).'
        ]);
        expect(ttsAlerts(bot)).toEqual([]);
        await waitFor(bot, () => bot!.twitch.state.redemptionUpdates.length > 0);
        expect(bot.twitch.state.redemptionUpdates.map((u) => u.status)).toEqual(['CANCELED']);
      });

      it('bypasses the per-user cooldown but not the global one', async () => {
        bot = await start({ broadcaster: true });
        await chat(bot, 'viewer1', '!tts from chat');
        await bot.advance(10_000);
        expect(await event(bot, REDEMPTION, redemption({ title: 'TTS', input: 'from points', user: 'viewer1' }))).toEqual([]);
        expect(ttsAlerts(bot).map((a) => a.message)).toEqual(['from chat', 'from points']);
        // the redemption started the per-user and global cooldowns for chat
        await bot.advance(10_000);
        expect(await chat(bot, 'viewer1', '!tts again')).toEqual(["@viewer1 You're on TTS cooldown. Try again in 20s."]);
      });

      it('during the global cooldown redemptions queue silently and play 10s apart in order', async () => {
        bot = await start({ broadcaster: true });
        await chat(bot, 'viewer9', '!tts chat first');
        expect(await event(bot, REDEMPTION, redemption({ title: 'TTS', input: 'one', user: 'A' }))).toEqual([]);
        expect(await event(bot, REDEMPTION, redemption({ title: 'TTS', input: 'two', user: 'B' }))).toEqual([]);
        expect(await event(bot, REDEMPTION, redemption({ title: 'TTS', input: 'three', user: 'A' }))).toEqual([]);
        expect(ttsAlerts(bot).map((a) => a.message)).toEqual(['chat first']);
        // logged to the dashboard immediately even though not spoken yet
        expect(bot.dashboardCalls().filter((c) => c.route === 'POST /api/redemptions')).toHaveLength(3);

        await bot.advance(9_999);
        expect(ttsAlerts(bot)).toHaveLength(1);
        await bot.advance(1);
        await waitFor(bot, () => ttsAlerts(bot!).length >= 2);
        expect(ttsAlerts(bot).map((a) => a.message)).toEqual(['chat first', 'one']);
        await bot.advance(10_000);
        await waitFor(bot, () => ttsAlerts(bot!).length >= 3);
        expect(ttsAlerts(bot).map((a) => a.message)).toEqual(['chat first', 'one', 'two']);
        // same user A again: redemptions ignore the per-user cooldown
        await bot.advance(10_000);
        await waitFor(bot, () => ttsAlerts(bot!).length >= 4);
        expect(ttsAlerts(bot).map((a) => [a.user, a.message])).toEqual([['viewer9', 'chat first'], ['A', 'one'], ['B', 'two'], ['A', 'three']]);
        expect(bot.said()).toEqual([]);
      });

      it('queued redemptions hold the global cooldown against chat !tts', async () => {
        bot = await start({ broadcaster: true });
        await chat(bot, 'viewer9', '!tts first');
        await event(bot, REDEMPTION, redemption({ title: 'TTS', input: 'queued', user: 'A' }));
        await bot.advance(10_000);
        await waitFor(bot, () => ttsAlerts(bot!).length >= 2);
        expect(ttsAlerts(bot).map((a) => a.message)).toEqual(['first', 'queued']);
        expect(await chat(bot, 'viewer8', '!tts me')).toEqual(['@viewer8 TTS is on global cooldown. Try again in 10s.']);
      });

      it('filtered input during the cooldown is rejected immediately, not queued', async () => {
        bot = await start({ broadcaster: true, env: { CHAT_FILTER_WORDS: 'badword' } });
        await chat(bot, 'viewer9', '!tts first');
        expect(await event(bot, REDEMPTION, redemption({ title: 'TTS', input: 'badword', user: 'A' }))).toEqual([
          // filters are checked before the cooldown, so this one is rejected immediately
          '@A TTS message blocked: contains filtered content (blacklist_word).'
        ]);
        await bot.advance(10_000);
        expect(ttsAlerts(bot).map((a) => a.message)).toEqual(['first']);
      });

      it('the queue holds 100 items; further redemptions are dropped with a warning and refunded', async () => {
        bot = await start({ broadcaster: true });
        const warn = console.warn as jest.Mock;
        await chat(bot, 'viewer9', '!tts first');
        for (let i = 1; i <= 101; i++) {
          bot.twitch.emitEvent(REDEMPTION, redemption({ title: 'TTS', input: `msg ${i}`, user: `U${i}` }));
        }
        await waitFor(bot, () => warn.mock.calls.some((c) => String(c[0]).includes('@U101')));
        expect(warn).toHaveBeenCalledWith('[TTS] Dropping redemption for @U101: queue is full (100/100)');
        expect(warn.mock.calls.filter((c) => String(c[0]).startsWith('[TTS] Dropping'))).toHaveLength(1);
        expect(bot.said()).toEqual([]);
        // only the dropped one is refunded
        await waitFor(bot, () => bot!.twitch.state.redemptionUpdates.length > 0);
        expect(bot.twitch.state.redemptionUpdates.map((u) => u.id)).toEqual([`redemption-${redemptionCount}`]);
        // every redemption is logged: posts are sent one at a time so the dashboard file lock is never overrun
        await waitFor(bot, () => bot!.dashboardCalls().filter((c) => c.route === 'POST /api/redemptions').length >= 101, 400);
        expect(bot.readData('redemptions.json')).toHaveLength(100);
        expect(bot.readData('redemptions.json').map((r: { user: string }) => r.user)).toEqual(
          Array.from({ length: 100 }, (_, i) => `U${i + 2}`));
        await bot.advance(10_000);
        await waitFor(bot, () => ttsAlerts(bot!).length >= 2);
        expect(ttsAlerts(bot).map((a) => a.message)).toEqual(['first', 'msg 1']);
      }, 30_000);

      it('with a non-browser provider the redemption also goes through /api/tts/generate', async () => {
        bot = await start({ broadcaster: true, env: { TTS_PROVIDER: 'polly' } });
        await event(bot, REDEMPTION, redemption({ title: 'TTS', input: 'generated' }));
        expect(generateCalls(bot).map((c) => c.body)).toEqual([{ text: 'generated', voice: null, provider: null }]);
        expect(ttsAlerts(bot)[0]).toMatchObject({ message: 'generated', useBrowserTTS: true, audioUrl: null });
      });
    });
  });
});
