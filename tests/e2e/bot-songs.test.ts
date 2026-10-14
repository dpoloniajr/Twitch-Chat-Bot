/**
 * Characterization tests: song requests (!sr / !songrequest and config),
 * !song / !currentsong / !queue, and the mod song-queue commands
 * (!skip, !removesong, !clearqueue, !blocksong, !unblocksong).
 *
 * The bot talks to YouTube (fake) and to the real dashboard song-queue routes
 * (src/dashboard/routes/song-queue.ts), which persist song-queue.json and
 * song-blocklist.json in the dashboard logs dir.
 */
jest.mock('axios', () => require('./harness/redirect').axiosMock());
jest.mock('ws', () => require('./harness/redirect').wsMock());
jest.mock('tmi.js', () => require('./harness/redirect').tmiMock());
jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('../../src/lib/console-timestamp', () => ({}));

import * as fs from 'fs';
import * as path from 'path';
import { startBot, BotHarness, BotOptions, ChatTags } from './harness/bot';
import type { YouTubeVideo } from './harness/fake-twitch';

const YT_KEY = 'yt-test-key';
const MOD = { mod: true };

const RICK: YouTubeVideo = { id: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up', channelTitle: 'Rick Astley', channelId: 'UCuAXFkgsw1L7xaCfnd5JJOw', duration: 'PT3M33S' };
const SANDSTORM: YouTubeVideo = { id: 'y6120QOlsfU', title: 'Darude - Sandstorm', channelTitle: 'Darude', channelId: 'UCdarude0000000000000000', duration: 'PT3M53S' };
const LONG: YouTubeVideo = { id: 'L0ngV1de0aa', title: 'Ten Hours of Rain', channelTitle: 'Rain Channel', channelId: 'UCrain00000000000000000', duration: 'PT10H' };
const HOUR: YouTubeVideo = { id: 'H0urV1de0bb', title: 'Mix', channelTitle: 'DJ', channelId: 'UCdj', duration: 'PT4M5S' };
const EXACT: YouTubeVideo = { id: 'Ten0Minutes', title: 'Exactly ten', channelTitle: 'Clock', channelId: 'UCclock', duration: 'PT10M' };
const ELEVEN: YouTubeVideo = { id: 'E1evenMin00', title: 'Eleven minutes', channelTitle: 'Slow', channelId: 'UCslow', duration: 'PT10M1S' };

interface QueueSong {
  id: string;
  videoId: string;
  title: string;
  channelTitle: string;
  channelId: string;
  durationSeconds: number;
  durationFormatted: string;
  thumbnail: string;
  requester: string;
  requesterDisplayName: string;
  addedAt: string;
  position: number;
  pointsCost: number;
  action?: string;
}
interface QueueFile {
  active: QueueSong[];
  history: QueueSong[];
  config: { enabled: boolean; cost: number; maxDuration: number; maxPerUser: number; allowDuplicates: boolean; priority: string };
  savedAt: string;
}
interface BlocklistFile { videos: string[]; channels: string[]; keywords: string[]; savedAt: string }

const DEFAULT_CONFIG: QueueFile['config'] = {
  enabled: true, cost: 0, maxDuration: 600, maxPerUser: 3, allowDuplicates: false, priority: 'everyone'
};

function song(n: number, over: Partial<QueueSong> = {}): QueueSong {
  return {
    id: `song${n}`, videoId: `vid${String(n).padStart(8, '0')}`, title: `Song ${n}`, channelTitle: `Artist ${n}`,
    channelId: `UCartist${n}`, durationSeconds: 60 * n, durationFormatted: `${n}:00`, thumbnail: '',
    requester: `viewer${n}`, requesterDisplayName: `Viewer${n}`, addedAt: '2026-01-01T00:00:00.000Z',
    position: n, pointsCost: 0, ...over
  };
}

function queueData(active: QueueSong[], config: Partial<QueueFile['config']> = {}) {
  return { active, history: [], config: { ...DEFAULT_CONFIG, ...config }, savedAt: '2026-01-01T00:00:00.000Z' };
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

async function start(opts: { env?: Record<string, string>; data?: Record<string, unknown>; noKey?: boolean } = {}): Promise<BotHarness> {
  const options: BotOptions = {
    env: { ...(opts.noKey ? {} : { YOUTUBE_API_KEY: YT_KEY }), HYPE_ENABLED: 'false', ...(opts.env || {}) },
    dashboardData: opts.data,
    seed: (twitch) => {
      twitch.state.videos.push(RICK, SANDSTORM, LONG, HOUR, EXACT, ELEVEN);
      twitch.state.searches.set('never gonna give you up', [RICK.id, SANDSTORM.id]);
      twitch.state.searches.set('sandstorm', [SANDSTORM.id]);
      twitch.state.searches.set('ghost result', ['Gh0stVide0x']);
    }
  };
  return ready(await startBot(options));
}

const logs = (bot: BotHarness) => bot.dashboardCalls().filter((c) => c.route === 'POST /api/logs').map((c) => c.body);
const queue = (bot: BotHarness) => bot.readData<QueueFile>('song-queue.json');
const blocklist = (bot: BotHarness) => bot.readData<BlocklistFile>('song-blocklist.json');
/**
 * Requests to the dashboard's mounted routers are logged by the harness with the mount
 * path stripped (Express rewrites req.url before the body 'end' event), e.g.
 * "DELETE /THE%20band" for DELETE /api/song-queue/THE%20band. Match on the tail.
 */
const calledRoute = (bot: BotHarness, method: string, tail: string) =>
  bot.dashboardCalls().some((c) => c.route.startsWith(`${method} `) && c.route.endsWith(tail));
/** Loyalty file with chat-message awards switched off, so balances only move by the song queue */
const loyaltyFile = (users: Record<string, unknown>) => ({ config: { enabled: false }, users, transactions: [] });
/**
 * Chat, then let fake time run a little: loyalty writes take a cross-process file lock whose
 * retry delay is a (fake) setTimeout, so a contended lock only resolves once time advances.
 */
async function chatFlush(bot: BotHarness, user: string, text: string, tags: ChatTags = {}): Promise<string[]> {
  const out = await chat(bot, user, text, tags);
  await bot.advance(1_000);
  return [...out, ...bot.take()];
}
const ytCalls = (bot: BotHarness) => bot.twitch.requests.filter((r) => r.path.startsWith('/youtube/'));

describe('song requests', () => {
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

  describe('without YOUTUBE_API_KEY', () => {
    it('every song command answers "not configured" and never calls YouTube or the queue', async () => {
      bot = await start({ noKey: true });
      expect(await chat(bot, 'viewer1', `!sr https://youtu.be/${RICK.id}`)).toEqual(['@viewer1 Song requests are not configured (missing YouTube API key).']);
      expect(await chat(bot, 'viewer1', '!songrequest anything')).toEqual(['@viewer1 Song requests are not configured (missing YouTube API key).']);
      expect(await chat(bot, 'mod1', '!sr config enabled off', MOD)).toEqual(['@mod1 Song requests are not configured.']);
      expect(await chat(bot, 'viewer1', '!song')).toEqual(['@viewer1 Song requests are not configured.']);
      expect(await chat(bot, 'viewer2', '!queue')).toEqual(['@viewer2 Song requests are not configured.']);
      expect(await chat(bot, 'mod1', '!skip', MOD)).toEqual(['@mod1 Song requests are not configured.']);
      expect(await chat(bot, 'mod1', '!removesong 1', MOD)).toEqual(['@mod1 Song requests are not configured.']);
      expect(await chat(bot, 'mod1', '!clearqueue', MOD)).toEqual(['@mod1 Song requests are not configured.']);
      expect(await chat(bot, 'mod1', '!blocksong foo', MOD)).toEqual(['@mod1 Song requests are not configured.']);
      expect(await chat(bot, 'mod1', '!unblocksong foo', MOD)).toEqual(['@mod1 Song requests are not configured.']);
      expect(ytCalls(bot)).toHaveLength(0);
      expect(bot.dashboardCalls().filter((c) => c.route.startsWith('GET /api/song-queue') || c.route.startsWith('POST /api/song-queue'))).toHaveLength(0);
    });

    it('a viewer still gets the generic mod-only reply for mod commands (registry check runs first)', async () => {
      bot = await start({ noKey: true });
      expect(await chat(bot, 'viewer1', '!skip')).toEqual(['@viewer1 Only moderators can use this command.']);
    });

    it('!song and !queue without a key do not start their cooldowns (nothing was shown)', async () => {
      bot = await start({ noKey: true });
      await chat(bot, 'viewer1', '!song');
      expect(await chat(bot, 'viewer2', '!song')).toEqual(['@viewer2 Song requests are not configured.']);
      expect(await chat(bot, 'viewer2', '!currentsong')).toEqual(['@viewer2 Song requests are not configured.']);
      await chat(bot, 'viewer1', '!queue');
      expect(await chat(bot, 'viewer2', '!queue')).toEqual(['@viewer2 Song requests are not configured.']);
    });
  });

  describe('!sr / !songrequest', () => {
    it('adds a video by watch URL, persists it, and logs success', async () => {
      bot = await start();
      const url = `https://www.youtube.com/watch?v=${RICK.id}&t=10s`;
      const out = await chat(bot, 'viewer1', `!sr ${url}`, { subscriber: true, displayName: 'Viewer1' });
      expect(out).toEqual(['@viewer1 Added to queue (position 1): "Never Gonna Give You Up" [3:33]']);

      const videos = bot.twitch.calls('GET /youtube/v3/videos');
      expect(videos).toHaveLength(1);
      expect(videos[0].query).toEqual({ part: 'snippet,contentDetails', id: RICK.id, key: YT_KEY });
      expect(bot.twitch.calls('GET /youtube/v3/search')).toHaveLength(0);

      const add = bot.dashboardCalls().find((c) => c.route === 'POST /api/song-queue/add');
      expect(add?.body).toEqual({
        videoId: RICK.id, title: RICK.title, channelTitle: RICK.channelTitle, channelId: RICK.channelId,
        durationSeconds: 213, durationFormatted: '3:33', thumbnail: `https://i.ytimg.com/vi/${RICK.id}/default.jpg`,
        requester: 'viewer1', requesterDisplayName: 'Viewer1', requesterIsSub: true, requesterIsVip: false,
        requesterIsMod: false, requesterIsBroadcaster: false
      });

      const q = queue(bot);
      expect(q.active).toHaveLength(1);
      expect(q.active[0]).toMatchObject({
        videoId: RICK.id, title: RICK.title, channelTitle: 'Rick Astley', channelId: RICK.channelId,
        durationSeconds: 213, durationFormatted: '3:33', requester: 'viewer1', requesterDisplayName: 'Viewer1',
        position: 1, pointsCost: 0
      });
      expect(q.active[0].id).toMatch(/^[0-9a-f]{16}$/);
      expect(q.config).toEqual(DEFAULT_CONFIG);
      expect(logs(bot)).toContainEqual(expect.objectContaining({ user: 'viewer1', command: '!sr', args: url, success: true }));
    });

    it('accepts youtu.be and embed URLs, and positions increase', async () => {
      bot = await start();
      expect(await chat(bot, 'viewer1', `!sr youtu.be/${RICK.id}`)).toEqual(['@viewer1 Added to queue (position 1): "Never Gonna Give You Up" [3:33]']);
      expect(await chat(bot, 'viewer2', `!songrequest https://youtube.com/embed/${HOUR.id}`)).toEqual(['@viewer2 Added to queue (position 2): "Mix" [4:05]']);
      expect(queue(bot).active.map((s) => [s.videoId, s.position])).toEqual([[RICK.id, 1], [HOUR.id, 2]]);
    });

    it('a search query uses the first search result', async () => {
      bot = await start();
      const out = await chat(bot, 'viewer1', '!songrequest Never Gonna Give You Up');
      expect(out).toEqual(['@viewer1 Added to queue (position 1): "Never Gonna Give You Up" [3:33]']);
      const search = bot.twitch.calls('GET /youtube/v3/search');
      expect(search).toHaveLength(1);
      expect(search[0].query).toEqual({ part: 'id', q: 'Never Gonna Give You Up', type: 'video', maxResults: '1', key: YT_KEY });
      expect(bot.twitch.calls('GET /youtube/v3/videos')[0].query.id).toBe(RICK.id);
    });

    it('a bare 11-character video ID is looked up directly, without a search', async () => {
      bot = await start();
      const out = await chat(bot, 'viewer1', `!sr ${RICK.id}`);
      expect(out).toEqual(['@viewer1 Added to queue (position 1): "Never Gonna Give You Up" [3:33]']);
      expect(bot.twitch.calls('GET /youtube/v3/videos').map((r) => r.query.id)).toEqual([RICK.id]);
      expect(bot.twitch.calls('GET /youtube/v3/search')).toHaveLength(0);
      expect(queue(bot).active.map((s) => s.videoId)).toEqual([RICK.id]);
    });

    it('an 11-character word that is not a video id falls back to search', async () => {
      bot = await start({ env: {} });
      bot.twitch.state.searches.set('sandstorm11', [SANDSTORM.id]);
      const out = await chat(bot, 'viewer1', '!sr sandstorm11');
      expect(out).toEqual(['@viewer1 Added to queue (position 1): "Darude - Sandstorm" [3:53]']);
      expect(bot.twitch.calls('GET /youtube/v3/videos').map((r) => r.query.id)).toEqual(['sandstorm11', SANDSTORM.id]);
      expect(bot.twitch.calls('GET /youtube/v3/search').map((r) => r.query.q)).toEqual(['sandstorm11']);
    });

    it('a 10- or 12-character input is a search, not an id lookup', async () => {
      bot = await start();
      expect(await chat(bot, 'viewer1', '!sr dQw4w9WgXc')).toEqual(['@viewer1 No results found for: "dQw4w9WgXc"']);
      expect(await chat(bot, 'viewer1', '!sr dQw4w9WgXcQQ')).toEqual(['@viewer1 No results found for: "dQw4w9WgXcQQ"']);
      expect(bot.twitch.calls('GET /youtube/v3/videos')).toHaveLength(0);
    });

    it('caches video metadata for an hour', async () => {
      bot = await start();
      await chat(bot, 'viewer1', `!sr https://youtu.be/${RICK.id}`);
      await chat(bot, 'viewer2', `!sr https://youtu.be/${RICK.id}`);
      expect(bot.twitch.calls('GET /youtube/v3/videos')).toHaveLength(1);
      await bot.advance(60 * 60 * 1000);
      await chat(bot, 'viewer3', `!sr https://youtu.be/${RICK.id}`);
      expect(bot.twitch.calls('GET /youtube/v3/videos')).toHaveLength(2);
    });

    it('usage message when there is no input', async () => {
      bot = await start();
      expect(await chat(bot, 'viewer1', '!sr')).toEqual(['@viewer1 Usage: !sr <YouTube URL or search query>']);
      expect(await chat(bot, 'viewer1', '!songrequest    ')).toEqual(['@viewer1 Usage: !sr <YouTube URL or search query>']);
      expect(ytCalls(bot)).toHaveLength(0);
    });

    it('rejects a YouTube URL without a valid video id', async () => {
      bot = await start();
      expect(await chat(bot, 'viewer1', '!sr https://www.youtube.com/watch?v=short')).toEqual(['@viewer1 Invalid YouTube URL.']);
      expect(await chat(bot, 'viewer1', '!sr https://youtube.com/@RickAstley')).toEqual(['@viewer1 Invalid YouTube URL.']);
      expect(ytCalls(bot)).toHaveLength(0);
    });

    it('a non-YouTube URL is searched for as text', async () => {
      bot = await start();
      expect(await chat(bot, 'viewer1', '!sr https://vimeo.com/123')).toEqual(['@viewer1 No results found for: "https://vimeo.com/123"']);
      expect(bot.twitch.calls('GET /youtube/v3/search')).toHaveLength(1);
    });

    it('unknown video id: could not fetch video information', async () => {
      bot = await start();
      expect(await chat(bot, 'viewer1', '!sr https://youtu.be/AAAAAAAAAAA')).toEqual(['@viewer1 Could not fetch video information. Please try again.']);
      // A search hit whose metadata is missing gives the same reply
      expect(await chat(bot, 'viewer1', '!sr ghost result')).toEqual(['@viewer1 Could not fetch video information. Please try again.']);
    });

    it('no search results', async () => {
      bot = await start();
      expect(await chat(bot, 'viewer1', '!sr nothing matches this')).toEqual(['@viewer1 No results found for: "nothing matches this"']);
      expect(fs.existsSync(path.join(bot.logsDir, 'song-queue.json'))).toBe(true);
      expect(queue(bot).active).toEqual([]);
    });

    it('YouTube videos API failure', async () => {
      bot = await start();
      bot.twitch.state.failures.set('GET /youtube/v3/videos', { status: 403, message: 'quotaExceeded' });
      expect(await chat(bot, 'viewer1', `!sr https://youtu.be/${RICK.id}`)).toEqual(['@viewer1 Could not fetch video information. Please try again.']);
      expect(queue(bot).active).toEqual([]);
    });

    it('YouTube search API failure is reported as a failure, not as "no results", and starts no cooldown', async () => {
      bot = await start();
      bot.twitch.state.failures.set('GET /youtube/v3/search', { status: 500, message: 'backendError', times: 1 });
      expect(await chat(bot, 'viewer1', '!sr sandstorm')).toEqual(['@viewer1 Could not search YouTube right now. Please try again.']);
      expect(queue(bot).active).toEqual([]);
      expect(await chat(bot, 'viewer1', '!sr sandstorm')).toEqual(['@viewer1 Added to queue (position 1): "Darude - Sandstorm" [3:53]']);
    });

    it('a search with no matches says "No results"', async () => {
      bot = await start();
      expect(await chat(bot, 'viewer1', '!sr nothing matches this')).toEqual(['@viewer1 No results found for: "nothing matches this"']);
    });

    it('failed metadata fetch is not cached: the next request retries', async () => {
      bot = await start();
      bot.twitch.state.failures.set('GET /youtube/v3/videos', { status: 503, message: 'down', times: 1 });
      await chat(bot, 'viewer1', `!sr https://youtu.be/${RICK.id}`);
      expect(await chat(bot, 'viewer1', `!sr https://youtu.be/${RICK.id}`)).toEqual(['@viewer1 Added to queue (position 1): "Never Gonna Give You Up" [3:33]']);
    });

    it('per-user 30s cooldown after a successful request only', async () => {
      bot = await start();
      bot.twitch.state.failures.set('GET /youtube/v3/videos', { status: 500, message: 'x', times: 1 });
      await chat(bot, 'viewer1', `!sr https://youtu.be/${RICK.id}`);
      // the failed request did not start the cooldown
      expect(await chat(bot, 'viewer1', `!sr https://youtu.be/${RICK.id}`)).toEqual(['@viewer1 Added to queue (position 1): "Never Gonna Give You Up" [3:33]']);
      expect(await chat(bot, 'viewer1', '!sr sandstorm')).toEqual(['@viewer1 Song requests are on cooldown. Try again in 30s.']);
      // cooldown check happens before the usage check
      expect(await chat(bot, 'viewer1', '!sr')).toEqual(['@viewer1 Song requests are on cooldown. Try again in 30s.']);
      // another user is not affected; !songrequest shares the key
      expect(await chat(bot, 'viewer2', '!sr sandstorm')).toEqual(['@viewer2 Added to queue (position 2): "Darude - Sandstorm" [3:53]']);
      await bot.advance(12_500);
      expect(await chat(bot, 'viewer1', '!songrequest sandstorm')).toEqual(['@viewer1 Song requests are on cooldown. Try again in 18s.']);
      await bot.advance(17_500);
      expect(await chat(bot, 'viewer1', `!sr https://youtu.be/${HOUR.id}`)).toEqual(['@viewer1 Added to queue (position 3): "Mix" [4:05]']);
    });

    it('mods are not exempt from the request cooldown', async () => {
      bot = await start();
      await chat(bot, 'mod1', `!sr https://youtu.be/${RICK.id}`, MOD);
      expect(await chat(bot, 'mod1', '!sr sandstorm', MOD)).toEqual(['@mod1 Song requests are on cooldown. Try again in 30s.']);
    });

    it('disabled queue: rejects before calling YouTube', async () => {
      bot = await start({ data: { 'song-queue.json': queueData([], { enabled: false }) } });
      expect(await chat(bot, 'viewer1', '!sr sandstorm')).toEqual(['@viewer1 Song requests are currently disabled.']);
      expect(ytCalls(bot)).toHaveLength(0);
      expect(logs(bot).filter((l) => l.command === '!sr')).toHaveLength(0);
    });

    it('duplicate video is rejected and logged as failed', async () => {
      bot = await start();
      await chat(bot, 'viewer1', `!sr https://youtu.be/${RICK.id}`);
      expect(await chat(bot, 'viewer2', '!sr never gonna give you up')).toEqual(['@viewer2 This song is already in the queue.']);
      expect(logs(bot)).toContainEqual(expect.objectContaining({ user: 'viewer2', command: '!sr', args: 'never gonna give you up', success: false }));
      expect(queue(bot).active).toHaveLength(1);
      // a rejected request does not start the cooldown
      expect(await chat(bot, 'viewer2', '!sr sandstorm')).toEqual(['@viewer2 Added to queue (position 2): "Darude - Sandstorm" [3:53]']);
    });

    it('duplicates allowed when allowDuplicates is on', async () => {
      bot = await start({ data: { 'song-queue.json': queueData([], { allowDuplicates: true }) } });
      await chat(bot, 'viewer1', '!sr sandstorm');
      expect(await chat(bot, 'viewer2', '!sr sandstorm')).toEqual(['@viewer2 Added to queue (position 2): "Darude - Sandstorm" [3:53]']);
    });

    it('per-user limit applies to viewers, counted case-insensitively; mods and broadcaster are exempt', async () => {
      bot = await start({
        data: { 'song-queue.json': queueData([song(1, { requester: 'Viewer1' }), song(2, { requester: 'mod1' }), song(3, { requester: 'caster' })], { maxPerUser: 1 }) }
      });
      expect(await chat(bot, 'viewer1', '!sr sandstorm')).toEqual(['@viewer1 You already have 1 song(s) in the queue. Maximum per user is 1.']);
      expect(await chat(bot, 'mod1', '!sr sandstorm', MOD)).toEqual(['@mod1 Added to queue (position 4): "Darude - Sandstorm" [3:53]']);
      expect(await chat(bot, 'caster', `!sr https://youtu.be/${RICK.id}`, { broadcaster: true })).toEqual(['@caster Added to queue (position 5): "Never Gonna Give You Up" [3:33]']);
    });

    it('default per-user limit is 3', async () => {
      bot = await start({ data: { 'song-queue.json': queueData([song(1, { requester: 'viewer9' }), song(2, { requester: 'viewer9' }), song(3, { requester: 'viewer9' })]) } });
      expect(await chat(bot, 'viewer9', '!sr sandstorm')).toEqual(['@viewer9 You already have 3 song(s) in the queue. Maximum per user is 3.']);
    });

    it('there is no total queue size limit', async () => {
      const many = Array.from({ length: 60 }, (_, i) => song(i + 1));
      bot = await start({ data: { 'song-queue.json': queueData(many) } });
      expect(await chat(bot, 'viewer100', '!sr sandstorm')).toEqual(['@viewer100 Added to queue (position 61): "Darude - Sandstorm" [3:53]']);
    });

    it('max duration: default 10 minutes, boundary is inclusive', async () => {
      bot = await start();
      expect(await chat(bot, 'viewer1', `!sr https://youtu.be/${ELEVEN.id}`)).toEqual(['@viewer1 Song is too long. Maximum duration is 10 minutes.']);
      expect(await chat(bot, 'viewer2', `!sr https://youtu.be/${LONG.id}`)).toEqual(['@viewer2 Song is too long. Maximum duration is 10 minutes.']);
      expect(await chat(bot, 'viewer3', `!sr https://youtu.be/${EXACT.id}`)).toEqual(['@viewer3 Added to queue (position 1): "Exactly ten" [10:00]']);
    });

    it('max duration applies to mods too', async () => {
      bot = await start({ data: { 'song-queue.json': queueData([], { maxDuration: 90 }) } });
      expect(await chat(bot, 'mod1', '!sr sandstorm', MOD)).toEqual(['@mod1 Song is too long. Maximum duration is 1 minutes.']);
    });

    it('blocked video, channel and keyword', async () => {
      bot = await start({
        data: { 'song-blocklist.json': { videos: [RICK.id], channels: [SANDSTORM.channelId], keywords: ['MIX'], savedAt: 'x' } }
      });
      expect(await chat(bot, 'viewer1', `!sr https://youtu.be/${RICK.id}`)).toEqual(['@viewer1 This video is blocked.']);
      expect(await chat(bot, 'viewer2', '!sr sandstorm')).toEqual(['@viewer2 Videos from this channel are blocked.']);
      expect(await chat(bot, 'viewer3', `!sr https://youtu.be/${HOUR.id}`)).toEqual(['@viewer3 Song contains blocked keyword: MIX']);
      expect(queue(bot).active).toEqual([]);
    });

    it('blocklist applies to mods as well', async () => {
      bot = await start({ data: { 'song-blocklist.json': { videos: [RICK.id], channels: [], keywords: [], savedAt: 'x' } } });
      expect(await chat(bot, 'mod1', `!sr https://youtu.be/${RICK.id}`, MOD)).toEqual(['@mod1 This video is blocked.']);
    });

    it('priority subs / vips', async () => {
      bot = await start({ data: { 'song-queue.json': queueData([], { priority: 'subs' }) } });
      expect(await chat(bot, 'viewer1', '!sr sandstorm')).toEqual(['@viewer1 Song requests are restricted to subscribers only.']);
      expect(await chat(bot, 'vip1', '!sr sandstorm', { vip: true })).toEqual(['@vip1 Song requests are restricted to subscribers only.']);
      expect(await chat(bot, 'sub1', '!sr sandstorm', { subscriber: true })).toEqual(['@sub1 Added to queue (position 1): "Darude - Sandstorm" [3:53]']);
      expect(await chat(bot, 'mod1', `!sr https://youtu.be/${RICK.id}`, MOD)).toEqual(['@mod1 Added to queue (position 2): "Never Gonna Give You Up" [3:33]']);

      bot.writeData('song-queue.json', queueData([], { priority: 'vips' }));
      expect(await chat(bot, 'sub2', '!sr sandstorm', { subscriber: true })).toEqual(['@sub2 Song requests are restricted to VIPs only.']);
      expect(await chat(bot, 'vip1', '!sr sandstorm', { vip: true })).toEqual(['@vip1 Added to queue (position 1): "Darude - Sandstorm" [3:53]']);
    });

    it('point cost: deducted from loyalty.json, insufficient / unknown users are rejected', async () => {
      bot = await start({
        data: {
          'song-queue.json': queueData([], { cost: 50 }),
          'loyalty.json': loyaltyFile({ rich: { points: 120, totalSpent: 0 }, poor: { points: 10 } })
        }
      });
      expect(await chatFlush(bot, 'poor', '!sr sandstorm')).toEqual(['@poor Insufficient points. This request costs 50 points. You have 10.']);
      expect(await chatFlush(bot, 'nobody', '!sr sandstorm')).toEqual(['@nobody You have no loyalty points yet. This request costs 50 points.']);
      expect(await chatFlush(bot, 'rich', '!sr sandstorm')).toEqual(['@rich Added to queue (position 1): "Darude - Sandstorm" [3:53]']);
      const loyalty = bot.readData('loyalty.json');
      expect(loyalty.users.rich).toMatchObject({ points: 70, totalSpent: 50 });
      expect(loyalty.transactions).toEqual([expect.objectContaining({ username: 'rich', amount: -50, type: 'spend', reason: 'Song request: Darude - Sandstorm', balance: 70 })]);
      expect(queue(bot).active[0].pointsCost).toBe(50);
      // mods pay nothing, and their song records no cost, so removing it refunds nothing
      expect(await chatFlush(bot, 'mod1', `!sr https://youtu.be/${RICK.id}`, MOD)).toEqual(['@mod1 Added to queue (position 2): "Never Gonna Give You Up" [3:33]']);
      expect(queue(bot).active[1].pointsCost).toBe(0);
    });

    it('on a fresh install the first chat message creates loyalty.json, so the point cost applies', async () => {
      bot = await start({ data: { 'song-queue.json': queueData([], { cost: 50 }) } });
      // the !sr message itself earns the default 5 points before the request is checked
      expect(await chatFlush(bot, 'viewer1', '!sr sandstorm')).toEqual(['@viewer1 Insufficient points. This request costs 50 points. You have 5.']);
      expect(fs.existsSync(path.join(bot.logsDir, 'loyalty.json'))).toBe(true);
      expect(queue(bot).active).toEqual([]);
    });
  });

  describe('!sr config', () => {
    it('viewers cannot configure (handler message, not the registry one)', async () => {
      bot = await start();
      expect(await chat(bot, 'viewer1', '!sr config enabled off')).toEqual(['@viewer1 Only moderators can configure song requests.']);
      expect(logs(bot)).toContainEqual(expect.objectContaining({ user: 'viewer1', command: '!sr config', args: 'enabled off', success: false }));
      expect(bot.dashboardCalls().filter((c) => c.route === 'PUT /api/song-queue/config')).toHaveLength(0);
    });

    it('usage with fewer than two args', async () => {
      bot = await start();
      const usage = '@mod1 Usage: !sr config <setting> <value> | Settings: enabled, cost, maxduration, maxperuser, duplicates, priority';
      expect(await chat(bot, 'mod1', '!sr config', MOD)).toEqual([usage]);
      expect(await chat(bot, 'mod1', '!sr CONFIG enabled', MOD)).toEqual([usage]);
    });

    it('unknown setting', async () => {
      bot = await start();
      expect(await chat(bot, 'mod1', '!sr config volume 5', MOD)).toEqual(['@mod1 Invalid setting. Valid settings: enabled, cost, maxduration, maxperuser, duplicates, priority']);
    });

    it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])('object prototype name "%s" is an unknown setting', async (name) => {
      bot = await start();
      expect(await chat(bot, 'mod1', `!sr config ${name} x`, MOD)).toEqual(['@mod1 Invalid setting. Valid settings: enabled, cost, maxduration, maxperuser, duplicates, priority']);
      expect(bot.dashboardCalls().filter((c) => c.route === 'PUT /api/song-queue/config')).toHaveLength(0);
    });

    it('sets each setting and persists it to song-queue.json', async () => {
      bot = await start();
      expect(await chat(bot, 'mod1', '!sr config enabled off', MOD)).toEqual(['✓ Song request enabled set to: off']);
      expect(await chat(bot, 'mod1', '!sr config Enabled YES', MOD)).toEqual(['✓ Song request enabled set to: on']);
      expect(await chat(bot, 'mod1', '!sr config cost 0', MOD)).toEqual(['✓ Song request cost set to: 0']);
      expect(await chat(bot, 'mod1', '!sr config cost 250', MOD)).toEqual(['✓ Song request cost set to: 250']);
      expect(await chat(bot, 'mod1', '!sr config maxduration 5', MOD)).toEqual(['✓ Song request maxduration set to: 5 minutes']);
      expect(await chat(bot, 'mod1', '!sr config maxperuser 2', MOD)).toEqual(['✓ Song request maxperuser set to: 2']);
      expect(await chat(bot, 'mod1', '!sr config duplicates 1', MOD)).toEqual(['✓ Song request duplicates set to: on']);
      expect(await chat(bot, 'caster', '!songrequest config priority VIPs', { broadcaster: true })).toEqual(['✓ Song request priority set to: vips']);

      const puts = bot.dashboardCalls().filter((c) => c.route === 'PUT /api/song-queue/config').map((c) => c.body);
      expect(puts).toEqual([
        { enabled: false }, { enabled: true }, { cost: 0 }, { cost: 250 }, { maxDuration: 300 },
        { maxPerUser: 2 }, { allowDuplicates: true }, { priority: 'vips' }
      ]);
      expect(queue(bot).config).toEqual({ enabled: true, cost: 250, maxDuration: 300, maxPerUser: 2, allowDuplicates: true, priority: 'vips' });
      expect(logs(bot)).toContainEqual(expect.objectContaining({ user: 'caster', command: '!sr config', args: 'priority VIPs', success: true }));
    });

    it('a multi-word value is joined before validation', async () => {
      bot = await start();
      expect(await chat(bot, 'mod1', '!sr config cost 1 0', MOD)).toEqual(['@mod1 Value must be a non-negative integer']);
    });

    it.each([
      ['enabled maybe', 'Value must be on/off, true/false, yes/no, or 1/0'],
      ['duplicates 2', 'Value must be on/off, true/false, yes/no, or 1/0'],
      ['cost -5', 'Value must be a non-negative integer'],
      ['cost 1.5', 'Value must be a non-negative integer'],
      ['maxduration 0', 'Value must be a positive number (minutes)'],
      ['maxduration ten', 'Value must be a positive integer (minutes)'],
      ['maxperuser 0', 'Value must be a positive number'],
      ['maxperuser abc', 'Value must be a positive integer'],
      ['priority mods', 'Value must be everyone, subs, or vips']
    ])('invalid value: %s', async (args, error) => {
      bot = await start();
      expect(await chat(bot, 'mod1', `!sr config ${args}`, MOD)).toEqual([`@mod1 ${error}`]);
      expect(bot.dashboardCalls().filter((c) => c.route === 'PUT /api/song-queue/config')).toHaveLength(0);
      expect(logs(bot)).toContainEqual(expect.objectContaining({ command: '!sr config', args, success: false }));
    });

    it('config changes take effect on the next request', async () => {
      bot = await start();
      await chat(bot, 'mod1', '!sr config maxduration 3', MOD);
      expect(await chat(bot, 'viewer1', '!sr sandstorm')).toEqual(['@viewer1 Song is too long. Maximum duration is 3 minutes.']);
    });
  });

  describe('!song / !currentsong', () => {
    it('empty queue', async () => {
      bot = await start();
      expect(await chat(bot, 'viewer1', '!song')).toEqual(['@viewer1 No songs in the queue.']);
      expect(logs(bot)).toContainEqual(expect.objectContaining({ user: 'viewer1', command: '!song', success: true }));
    });

    it('one song, then now playing + next up', async () => {
      bot = await start({ data: { 'song-queue.json': queueData([song(1)]) } });
      expect(await chat(bot, 'viewer1', '!song')).toEqual(['Now playing: "Song 1" by Artist 1 [1:00] (requested by @viewer1)']);
      bot.writeData('song-queue.json', queueData([song(1), song(2), song(3)]));
      await bot.advance(10_000);
      expect(await chat(bot, 'viewer1', '!currentsong')).toEqual(['Now playing: "Song 1" by Artist 1 [1:00] (requested by @viewer1) | Next up: "Song 2" [2:00]']);
      // !currentsong also logs as !song
      expect(logs(bot).filter((l) => l.command === '!song')).toHaveLength(2);
    });

    it('!song and !currentsong share the 10s cooldown key', async () => {
      bot = await start();
      await chat(bot, 'viewer1', '!song');
      expect(await chat(bot, 'viewer2', '!currentsong')).toEqual(['@viewer2 !currentsong is on cooldown. Try again in 10s.']);
      await bot.advance(9_001);
      expect(await chat(bot, 'viewer2', '!song')).toEqual(['@viewer2 !song is on cooldown. Try again in 1s.']);
      await bot.advance(999);
      expect(await chat(bot, 'viewer2', '!currentsong')).toEqual(['@viewer2 No songs in the queue.']);
    });

    it('cooldown follows builtinCommands.json; 0 disables it', async () => {
      bot = await start({
        data: { 'builtinCommands.json': [{ name: '!song', cooldownSeconds: 0 }, { name: '!currentsong', cooldownSeconds: 25 }] }
      });
      await chat(bot, 'viewer1', '!song');
      expect(await chat(bot, 'viewer1', '!song')).toEqual(['@viewer1 No songs in the queue.']);
      await chat(bot, 'viewer1', '!currentsong');
      expect(await chat(bot, 'viewer1', '!currentsong')).toEqual(['@viewer1 !currentsong is on cooldown. Try again in 25s.']);
      // !song (cooldown 0) ignores the shared key that !currentsong set
      expect(await chat(bot, 'viewer1', '!song')).toEqual(['@viewer1 No songs in the queue.']);
    });

    it('unreadable queue file: error message, and no cooldown starts', async () => {
      bot = await start();
      fs.writeFileSync(path.join(bot.logsDir, 'song-queue.json'), '{not json');
      expect(await chat(bot, 'viewer1', '!song')).toEqual(['@viewer1 Error fetching song queue.']);
      expect(logs(bot)).toContainEqual(expect.objectContaining({ command: '!song', success: false }));
      expect(await chat(bot, 'viewer1', '!queue')).toEqual(['@viewer1 Error fetching song queue.']);
      expect(await chat(bot, 'viewer2', '!song')).toEqual(['@viewer2 Error fetching song queue.']);
      expect(await chat(bot, 'viewer2', '!queue')).toEqual(['@viewer2 Error fetching song queue.']);
      // once the queue is readable again the next !song shows it and starts the cooldown
      bot.writeData('song-queue.json', queueData([]));
      expect(await chat(bot, 'viewer2', '!song')).toEqual(['@viewer2 No songs in the queue.']);
      expect(await chat(bot, 'viewer3', '!song')).toEqual(['@viewer3 !song is on cooldown. Try again in 10s.']);
    });
  });

  describe('!queue', () => {
    it('empty queue', async () => {
      bot = await start();
      expect(await chat(bot, 'viewer1', '!queue')).toEqual(['@viewer1 The queue is empty. Use !sr <URL or search query> to add a song!']);
    });

    it('one song: singular, no up-next list', async () => {
      bot = await start({ data: { 'song-queue.json': queueData([song(1)]) } });
      expect(await chat(bot, 'viewer1', '!queue')).toEqual(['Queue: 1 song (1:00 total)']);
    });

    it('lists positions 2-4 and the total duration', async () => {
      bot = await start({ data: { 'song-queue.json': queueData([song(1), song(2), song(3), song(4), song(60)]) } });
      expect(await chat(bot, 'viewer1', '!queue')).toEqual([
        'Queue: 5 songs (1:10:00 total) | Up next: 2. "Song 2" [2:00], 3. "Song 3" [3:00], 4. "Song 4" [4:00]'
      ]);
      expect(logs(bot)).toContainEqual(expect.objectContaining({ command: '!queue', success: true }));
    });

    it('has its own 10s cooldown, separate from !song', async () => {
      bot = await start();
      await chat(bot, 'viewer1', '!queue');
      expect(await chat(bot, 'viewer2', '!queue')).toEqual(['@viewer2 !queue is on cooldown. Try again in 10s.']);
      expect(await chat(bot, 'viewer2', '!song')).toEqual(['@viewer2 No songs in the queue.']);
    });
  });

  describe('!skip / !skipsong', () => {
    it('viewers get the registry mod-only reply', async () => {
      bot = await start({ data: { 'song-queue.json': queueData([song(1)]) } });
      expect(await chat(bot, 'viewer1', '!skip')).toEqual(['@viewer1 Only moderators can use this command.']);
      expect(await chat(bot, 'vip1', '!skipsong', { vip: true })).toEqual(['@vip1 Only moderators can use this command.']);
      expect(queue(bot).active).toHaveLength(1);
    });

    it('empty queue', async () => {
      bot = await start();
      expect(await chat(bot, 'mod1', '!skip', MOD)).toEqual(['@mod1 No song to skip. Queue is empty.']);
      expect(logs(bot)).toContainEqual(expect.objectContaining({ command: '!skip', success: false }));
    });

    it('skips the first song, renumbers and records history', async () => {
      bot = await start({ data: { 'song-queue.json': queueData([song(1), song(2), song(3)]) } });
      expect(await chat(bot, 'mod1', '!skip', MOD)).toEqual(['⏭️ Skipped: "Song 1" by Artist 1']);
      expect(await chat(bot, 'caster', '!skipsong', { broadcaster: true })).toEqual(['⏭️ Skipped: "Song 2" by Artist 2']);
      const q = queue(bot);
      expect(q.active.map((s) => [s.id, s.position])).toEqual([['song3', 1]]);
      expect(q.history.map((s) => [s.id, s.action])).toEqual([['song2', 'skipped'], ['song1', 'skipped']]);
      expect(bot.dashboardCalls().filter((c) => c.route === 'POST /api/song-queue/skip').map((c) => c.body)).toEqual([{}, {}]);
      expect(logs(bot).filter((l) => l.command === '!skip').map((l) => l.success)).toEqual([true, true]);
    });

    it('skipping does not refund points', async () => {
      bot = await start({
        data: {
          'song-queue.json': queueData([song(1, { pointsCost: 40 })]),
          'loyalty.json': loyaltyFile({ viewer1: { points: 0, totalSpent: 40 } })
        }
      });
      await chatFlush(bot, 'mod1', '!skip', MOD);
      expect(bot.readData('loyalty.json').users.viewer1.points).toBe(0);
    });
  });

  describe('!removesong', () => {
    it('viewers get the registry mod-only reply', async () => {
      bot = await start();
      expect(await chat(bot, 'viewer1', '!removesong 1')).toEqual(['@viewer1 Only moderators can use this command.']);
    });

    it('usage without args', async () => {
      bot = await start();
      expect(await chat(bot, 'mod1', '!removesong', MOD)).toEqual(['@mod1 Usage: !removesong <position or keyword>']);
    });

    it('empty queue', async () => {
      bot = await start();
      expect(await chat(bot, 'mod1', '!removesong 1', MOD)).toEqual(['@mod1 Queue is empty.']);
    });

    it('by position, with refund of the paid points', async () => {
      bot = await start({
        data: {
          'song-queue.json': queueData([song(1), song(2, { pointsCost: 30 }), song(3)]),
          'loyalty.json': loyaltyFile({ viewer2: { points: 5, totalSpent: 30 } })
        }
      });
      expect(await chatFlush(bot, 'mod1', '!removesong 2', MOD)).toEqual(['🗑️ Removed: "Song 2" by Artist 2 (requested by @viewer2)']);
      const q = queue(bot);
      expect(q.active.map((s) => [s.id, s.position])).toEqual([['song1', 1], ['song3', 2]]);
      expect(q.history[0]).toMatchObject({ id: 'song2', action: 'removed' });
      const loyalty = bot.readData('loyalty.json');
      expect(loyalty.users.viewer2).toMatchObject({ points: 35, totalSpent: 0 });
      expect(loyalty.transactions).toEqual([expect.objectContaining({ username: 'viewer2', amount: 30, type: 'refund', reason: 'Song request removed: Song 2' })]);
      expect(calledRoute(bot, 'DELETE', '/2')).toBe(true);
      expect(logs(bot)).toContainEqual(expect.objectContaining({ command: '!removesong', args: '2', success: true }));
    });

    it('by keyword in title or channel (first match, case-insensitive, multi-word)', async () => {
      bot = await start({ data: { 'song-queue.json': queueData([song(1), song(2, { title: 'Big Hit', channelTitle: 'The Band' }), song(3)]) } });
      expect(await chatFlush(bot, 'mod1', '!removesong THE band', MOD)).toEqual(['🗑️ Removed: "Big Hit" by The Band (requested by @viewer2)']);
      expect(await chat(bot, 'mod1', '!removesong song', MOD)).toEqual(['🗑️ Removed: "Song 1" by Artist 1 (requested by @viewer1)']);
      expect(calledRoute(bot, 'DELETE', '/THE%20band')).toBe(true);
    });

    it('out-of-range position falls back to a keyword search', async () => {
      bot = await start({ data: { 'song-queue.json': queueData([song(1), song(2), song(10, { title: 'Track 99 remix' })]) } });
      expect(await chat(bot, 'mod1', '!removesong 99', MOD)).toEqual(['🗑️ Removed: "Track 99 remix" by Artist 10 (requested by @viewer10)']);
      expect(await chat(bot, 'mod1', '!removesong 0', MOD)).toEqual(['@mod1 No song found matching "0".']);
      expect(logs(bot)).toContainEqual(expect.objectContaining({ command: '!removesong', args: '0', success: false }));
    });

    it('cannot remove by requester name', async () => {
      bot = await start({ data: { 'song-queue.json': queueData([song(1), song(2)]) } });
      expect(await chat(bot, 'mod1', '!removesong viewer2', MOD)).toEqual(['@mod1 No song found matching "viewer2".']);
      expect(await chat(bot, 'mod1', '!removesong @viewer2', MOD)).toEqual(['@mod1 No song found matching "@viewer2".']);
      expect(queue(bot).active).toHaveLength(2);
    });
  });

  describe('!clearqueue', () => {
    it('viewers get the registry mod-only reply', async () => {
      bot = await start({ data: { 'song-queue.json': queueData([song(1)]) } });
      expect(await chat(bot, 'viewer1', '!clearqueue')).toEqual(['@viewer1 Only moderators can use this command.']);
      expect(queue(bot).active).toHaveLength(1);
    });

    it('already empty', async () => {
      bot = await start();
      expect(await chat(bot, 'mod1', '!clearqueue', MOD)).toEqual(['@mod1 Queue is already empty.']);
      expect(logs(bot)).toContainEqual(expect.objectContaining({ command: '!clearqueue', success: true }));
    });

    it('clears one / many songs, moves them to history and refunds', async () => {
      bot = await start({
        data: {
          'song-queue.json': queueData([song(1, { pointsCost: 10 }), song(2, { pointsCost: 0 })]),
          'loyalty.json': loyaltyFile({ viewer1: { points: 0, totalSpent: 10 } })
        }
      });
      expect(await chatFlush(bot, 'mod1', '!clearqueue', MOD)).toEqual(['🗑️ Cleared 2 songs from the queue.']);
      const q = queue(bot);
      expect(q.active).toEqual([]);
      expect(q.history.map((s) => [s.id, s.action])).toEqual([['song1', 'cleared'], ['song2', 'cleared']]);
      expect(bot.readData('loyalty.json').users.viewer1.points).toBe(10);

      bot.writeData('song-queue.json', queueData([song(3)]));
      expect(await chatFlush(bot, 'mod1', '!clearqueue', MOD)).toEqual(['🗑️ Cleared 1 song from the queue.']);
    });
  });

  describe('!blocksong / !unblocksong', () => {
    it('viewers get the registry mod-only reply', async () => {
      bot = await start();
      expect(await chat(bot, 'viewer1', '!blocksong rick')).toEqual(['@viewer1 Only moderators can use this command.']);
      expect(await chat(bot, 'viewer1', '!unblocksong rick')).toEqual(['@viewer1 Only moderators can use this command.']);
    });

    it('usage without args', async () => {
      bot = await start();
      expect(await chat(bot, 'mod1', '!blocksong', MOD)).toEqual(['@mod1 Usage: !blocksong <url|channel|keyword>']);
      expect(await chat(bot, 'mod1', '!unblocksong', MOD)).toEqual(['@mod1 Usage: !unblocksong <id|keyword>']);
    });

    it('blocks a video by URL and removes it from the queue', async () => {
      bot = await start({ data: { 'song-queue.json': queueData([song(1, { videoId: RICK.id }), song(2)]) } });
      expect(await chat(bot, 'mod1', `!blocksong https://www.youtube.com/watch?v=${RICK.id}`, MOD)).toEqual([`🚫 Blocked video: ${RICK.id} (removed 1 song from queue)`]);
      expect(blocklist(bot)).toMatchObject({ videos: [RICK.id], channels: [], keywords: [] });
      const q = queue(bot);
      expect(q.active.map((s) => [s.id, s.position])).toEqual([['song2', 1]]);
      expect(q.history[0]).toMatchObject({ id: 'song1', action: 'blocked', blockType: 'video', blockValue: RICK.id });
      expect(bot.dashboardCalls().find((c) => c.route === 'POST /api/song-queue/block')?.body).toEqual({ type: 'video', value: RICK.id });
      // and it now blocks requests
      expect(await chat(bot, 'viewer1', `!sr https://youtu.be/${RICK.id}`)).toEqual(['@viewer1 This video is blocked.']);
    });

    it('blocks a channel by /channel/ URL', async () => {
      bot = await start({ data: { 'song-queue.json': queueData([song(1, { channelId: 'UCabc' }), song(2, { channelId: 'UCabc' })]) } });
      expect(await chat(bot, 'mod1', '!blocksong https://youtube.com/channel/UCabc', MOD)).toEqual(['🚫 Blocked channel: UCabc (removed 2 songs from queue)']);
      expect(blocklist(bot).channels).toEqual(['UCabc']);
    });

    it('a @handle URL is resolved to its channel id, so the block matches that channel\'s songs', async () => {
      bot = await start();
      bot.twitch.state.handles.set('rickastleyyt', RICK.channelId);
      expect(await chat(bot, 'mod1', '!blocksong https://www.youtube.com/@RickAstleyYT', MOD)).toEqual([`🚫 Blocked channel: ${RICK.channelId}`]);
      expect(bot.twitch.calls('GET /youtube/v3/channels').map((r) => r.query)).toEqual([{ part: 'id', forHandle: '@RickAstleyYT', key: YT_KEY }]);
      expect(blocklist(bot).channels).toEqual([RICK.channelId]);
      const out = await chat(bot, 'viewer1', `!sr https://youtu.be/${RICK.id}`);
      expect(out).toHaveLength(1);
      expect(out[0]).not.toContain('Added to queue');
      expect(queue(bot).active).toEqual([]);

      // !unblocksong resolves the same handle
      expect(await chat(bot, 'mod1', '!unblocksong https://www.youtube.com/@RickAstleyYT', MOD)).toEqual([`✅ Unblocked channel: ${RICK.channelId}`]);
      expect(blocklist(bot).channels).toEqual([]);
    });

    it('an unknown @handle is not blocked', async () => {
      bot = await start();
      expect(await chat(bot, 'mod1', '!blocksong https://www.youtube.com/@nobody', MOD)).toEqual(['@mod1 Could not find that YouTube channel.']);
      expect(logs(bot)).toContainEqual(expect.objectContaining({ command: '!blocksong', success: false }));
      expect(bot.dashboardCalls().filter((c) => c.route.endsWith(' /block'))).toEqual([]);
    });

    it('keyword block (multi-word), matching queued songs case-insensitively', async () => {
      bot = await start({ data: { 'song-queue.json': queueData([song(1, { title: 'Baby Shark Remix' }), song(2)]) } });
      expect(await chat(bot, 'mod1', '!blocksong baby SHARK', MOD)).toEqual(['🚫 Blocked keyword: "baby SHARK" (removed 1 song from queue)']);
      expect(blocklist(bot).keywords).toEqual(['baby SHARK']);
    });

    it('a YouTube URL without a video id is blocked as a keyword', async () => {
      bot = await start();
      expect(await chat(bot, 'mod1', '!blocksong https://youtube.com/feed/trending', MOD)).toEqual(['🚫 Blocked keyword: "https://youtube.com/feed/trending"']);
    });

    it('blocking twice: the dashboard\'s 400 reason is shown, not the raw HTTP error', async () => {
      bot = await start();
      await chat(bot, 'mod1', '!blocksong rickroll', MOD);
      expect(await chat(bot, 'mod1', '!blocksong RickRoll', MOD)).toEqual(['@mod1 Error blocking: Keyword is already blocked.']);
      expect(logs(bot)).toContainEqual(expect.objectContaining({ command: '!blocksong', args: 'RickRoll', success: false }));
    });

    it('unblocks a video, a channel and a keyword (case-insensitive, returns stored casing)', async () => {
      bot = await start({ data: { 'song-blocklist.json': { videos: [RICK.id], channels: ['UCabc'], keywords: ['Baby Shark'], savedAt: 'x' } } });
      expect(await chat(bot, 'mod1', `!unblocksong ${RICK.id}`, MOD)).toEqual([`✅ Unblocked video: ${RICK.id}`]);
      expect(await chat(bot, 'mod1', '!unblocksong UCabc', MOD)).toEqual(['✅ Unblocked channel: UCabc']);
      expect(await chat(bot, 'mod1', '!unblocksong baby shark', MOD)).toEqual(['✅ Unblocked keyword: "Baby Shark"']);
      expect(blocklist(bot)).toMatchObject({ videos: [], channels: [], keywords: [] });
      expect(calledRoute(bot, 'DELETE', '/block/baby%20shark')).toBe(true);
    });

    it('unblocks by the same URLs !blocksong accepts (video and channel URLs)', async () => {
      bot = await start({ data: { 'song-blocklist.json': { videos: [RICK.id], channels: ['UCabc'], keywords: [], savedAt: 'x' } } });
      const url = `https://youtu.be/${RICK.id}`;
      expect(await chat(bot, 'mod1', `!unblocksong ${url}`, MOD)).toEqual([`✅ Unblocked video: ${RICK.id}`]);
      expect(await chat(bot, 'mod1', '!unblocksong https://www.youtube.com/channel/UCabc', MOD)).toEqual(['✅ Unblocked channel: UCabc']);
      expect(blocklist(bot)).toMatchObject({ videos: [], channels: [] });
      expect(logs(bot)).toContainEqual(expect.objectContaining({ command: '!unblocksong', args: url, success: true }));
    });

    it('block then unblock round-trips through a watch URL', async () => {
      bot = await start();
      const url = `https://www.youtube.com/watch?v=${RICK.id}`;
      expect(await chat(bot, 'mod1', `!blocksong ${url}`, MOD)).toEqual([`🚫 Blocked video: ${RICK.id}`]);
      expect(await chat(bot, 'mod1', `!unblocksong ${url}`, MOD)).toEqual([`✅ Unblocked video: ${RICK.id}`]);
      expect(blocklist(bot).videos).toEqual([]);
    });

    it('a "%" in the identifier is unblocked like any other keyword', async () => {
      bot = await start({ data: { 'song-blocklist.json': { videos: [], channels: [], keywords: ['100%'], savedAt: 'x' } } });
      expect(await chat(bot, 'mod1', '!unblocksong 100%', MOD)).toEqual(['✅ Unblocked keyword: "100%"']);
      expect(blocklist(bot).keywords).toEqual([]);
    });
  });
});
