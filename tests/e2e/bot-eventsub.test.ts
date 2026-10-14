/**
 * E2E characterization: EventSub events the bot subscribes to and how it reacts
 * (chat lines, dashboard calls), plus the EventSub WebSocket session lifecycle
 * (session_reconnect, close, keepalive, duplicates, revocation).
 *
 * Subscribed types (src/bot/eventsub.ts, src/lib/twitch-eventsub-ws.ts):
 *   bot token:          stream.online, stream.offline
 *   broadcaster token:  channel.follow (v2), channel.raid, channel points redemption add,
 *                       channel.subscribe, channel.subscription.message,
 *                       channel.subscription.gift, channel.cheer
 * Hype train, ad break, polls/predictions progress, etc. are NOT subscribed.
 */
jest.mock('axios', () => require('./harness/redirect').axiosMock());
jest.mock('ws', () => require('./harness/redirect').wsMock());
jest.mock('tmi.js', () => require('./harness/redirect').tmiMock());
jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('../../src/lib/console-timestamp', () => ({}));

import { startBot, BotHarness, BotOptions } from './harness/bot';
import { trackEventSubSockets, SocketTracker, sendFrame, sendNotification, pumpClock, waitFor } from './harness/eventsub-helpers';

interface IrcWrapper {
  client: { said: Array<{ channel: string; message: string }> } | null;
}
const irc = (): IrcWrapper => (global as unknown as { chatClient: IrcWrapper }).chatClient;

const COND = { broadcaster_user_id: '1001' };

let logSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;
let bot: BotHarness | null = null;
let sockets: SocketTracker;

const lines = (spy: jest.SpyInstance): string[] =>
  spy.mock.calls.map((args: unknown[]) => args.map((a) => String(a)).join(' '));

async function start(options: BotOptions = {}): Promise<BotHarness> {
  bot = await startBot({ broadcasterToken: true, ...options });
  return bot;
}

/** Dashboard calls made after `from` (index), excluding periodic/unrelated routes */
function callsSince(b: BotHarness, from: number) {
  return b.dashboardCalls().slice(from).filter((c) => c.route !== 'GET /api/custom-commands');
}

describe('bot EventSub', () => {
  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    sockets = trackEventSubSockets();
  });
  afterEach(async () => {
    if (bot) await bot.stop();
    bot = null;
    // Let the bot's EventSub sockets report their close while console is still silenced
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  describe('stream online / offline (bot token)', () => {
    it('announces stream.online in chat, with no dashboard calls', async () => {
      const b = await start();
      const before = b.dashboardCalls().length;
      const out = await b.event('stream.online', {
        id: 's1', broadcaster_user_id: '1001', broadcaster_user_login: 'caster', broadcaster_user_name: 'Caster',
        type: 'live', started_at: new Date().toISOString()
      });
      expect(out).toEqual(['Stream is now live!']);
      expect(callsSince(b, before)).toEqual([]);
    });

    it('ignores stream.offline apart from a log line', async () => {
      const b = await start();
      const before = b.dashboardCalls().length;
      const out = await b.event('stream.offline', { broadcaster_user_id: '1001', broadcaster_user_login: 'caster', broadcaster_user_name: 'Caster' });
      expect(out).toEqual([]);
      expect(callsSince(b, before)).toEqual([]);
      expect(lines(logSpy)).toContain('EventSub: Stream offline');
    });

    it('works without a broadcaster token (single account)', async () => {
      const b = await start({ broadcasterToken: false });
      expect(await b.event('stream.online', { broadcaster_user_id: '1001', started_at: new Date().toISOString() })).toEqual(['Stream is now live!']);
    });

    it('sends to every configured channel', async () => {
      const b = await start({ env: { TWITCH_CHANNELS: 'caster,other' } });
      await b.event('stream.online', { broadcaster_user_id: '1001', started_at: new Date().toISOString() });
      expect(irc().client!.said).toEqual([
        { channel: 'caster', message: 'Stream is now live!' },
        { channel: 'other', message: 'Stream is now live!' }
      ]);
    });
  });

  describe('channel.follow', () => {
    it('thanks the follower, logs the event and sends a follow alert', async () => {
      const b = await start();
      const before = b.dashboardCalls().length;
      const out = await b.event('channel.follow', {
        user_id: '5', user_login: 'fol', user_name: 'Fol', broadcaster_user_id: '1001', followed_at: new Date().toISOString()
      });
      expect(out).toEqual(['Thanks for the follow, Fol!']);
      expect(callsSince(b, before)).toEqual([
        { route: 'POST /api/eventsub-events', body: { type: 'follow', user: 'Fol' } },
        { route: 'POST /api/test-alert', body: { alertType: 'follow', user: 'Fol' } }
      ]);
      const logged = b.readData<Array<Record<string, unknown>>>('eventsub-events.json');
      expect(logged[logged.length - 1]).toMatchObject({ type: 'follow', user: 'Fol' });
      expect(typeof logged[logged.length - 1].timestamp).toBe('string');
    });

    it('prefers user_display_name, and falls back to "someone"', async () => {
      const b = await start();
      expect(await b.event('channel.follow', { user_name: 'fol', user_display_name: 'FoL_Display' })).toEqual(['Thanks for the follow, FoL_Display!']);
      expect(await b.event('channel.follow', {})).toEqual(['Thanks for the follow, someone!']);
    });

    it('sends to every configured channel but logs/alerts once', async () => {
      const b = await start({ env: { TWITCH_CHANNELS: 'caster,other' } });
      const before = b.dashboardCalls().length;
      await b.event('channel.follow', { user_name: 'Fol' });
      expect(irc().client!.said.map((s) => s.channel)).toEqual(['caster', 'other']);
      expect(callsSince(b, before).map((c) => c.route)).toEqual(['POST /api/eventsub-events', 'POST /api/test-alert']);
    });
  });

  describe('channel.raid', () => {
    it('welcomes the raid with the viewer count', async () => {
      const b = await start();
      const before = b.dashboardCalls().length;
      const out = await b.event('channel.raid', {
        from_broadcaster_user_id: '77', from_broadcaster_user_login: 'raider', from_broadcaster_user_name: 'Raider',
        to_broadcaster_user_id: '1001', to_broadcaster_user_login: 'caster', to_broadcaster_user_name: 'Caster', viewers: 42
      });
      expect(out).toEqual(['Incoming raid from Raider with 42 viewers! Welcome!']);
      expect(callsSince(b, before)).toEqual([
        { route: 'POST /api/eventsub-events', body: { type: 'raid', user: 'Raider', viewers: 42 } },
        { route: 'POST /api/test-alert', body: { alertType: 'raid', user: 'Raider', viewers: 42 } }
      ]);
    });

    it('uses 0 viewers when missing and falls back to the login, then "someone", for the raider name', async () => {
      const b = await start();
      expect(await b.event('channel.raid', { from_broadcaster_user_name: 'R' })).toEqual(['Incoming raid from R with 0 viewers! Welcome!']);
      expect(await b.event('channel.raid', { from_broadcaster_user_login: 'raider', viewers: 1 })).toEqual(['Incoming raid from raider with 1 viewers! Welcome!']);
      expect(await b.event('channel.raid', { viewers: 2 })).toEqual(['Incoming raid from someone with 2 viewers! Welcome!']);
      expect(b.dashboardCalls().filter((c) => c.route === 'POST /api/test-alert').map((c) => c.body.user)).toEqual(['R', 'raider', 'someone']);
    });
  });

  describe('channel points redemption', () => {
    const TYPE = 'channel.channel_points_custom_reward_redemption.add';

    it('echoes a non-TTS redemption and posts it to the dashboard', async () => {
      const b = await start();
      const before = b.dashboardCalls().length;
      const out = await b.event(TYPE, {
        id: 'r1', broadcaster_user_id: '1001', broadcaster_user_login: 'caster', user_name: 'Viewer', user_input: 'pls',
        status: 'unfulfilled', reward: { id: 'rw', title: 'Hydrate', cost: 100 }, redeemed_at: new Date().toISOString()
      });
      expect(out).toEqual(['Viewer redeemed: Hydrate - pls']);
      expect(callsSince(b, before)).toEqual([
        { route: 'POST /api/redemptions', body: { user: 'Viewer', reward: 'Hydrate', input: 'pls' } },
        { route: 'POST /api/eventsub-events', body: { type: 'redemption', user: 'Viewer', reward: 'Hydrate', message: 'pls' } },
        { route: 'POST /api/test-alert', body: { alertType: 'redemption', user: 'Viewer', reward: 'Hydrate', message: 'pls' } }
      ]);
    });

    it('omits the input part when empty and defaults the reward title to "Reward"', async () => {
      const b = await start();
      expect(await b.event(TYPE, { user_name: 'Viewer', reward: { title: 'Hydrate' } })).toEqual(['Viewer redeemed: Hydrate']);
      expect(await b.event(TYPE, { user_name: 'Viewer', user_input: 'x' })).toEqual(['Viewer redeemed: Reward - x']);
    });

    it('routes a TTS reward with input to TTS (alert + command log, no chat)', async () => {
      const b = await start();
      const before = b.dashboardCalls().length;
      const out = await b.event(TYPE, { broadcaster_user_login: 'caster', user_name: 'Viewer', user_input: 'hello world', reward: { title: 'TTS Message' } });
      expect(out).toEqual([]);
      const calls = callsSince(b, before);
      expect(calls.map((c) => c.route)).toEqual(['POST /api/redemptions', 'POST /api/test-alert', 'POST /api/logs']);
      expect(calls[1].body).toMatchObject({
        alertType: 'tts', user: 'Viewer', message: 'hello world', audioUrl: null, useBrowserTTS: true,
        config: { ttsEnabled: true, ttsTemplate: 'hello world', duration: 5000 + 11 * 50 }
      });
      expect(calls[2].body).toMatchObject({ user: 'Viewer', command: '!tts', args: 'hello world', success: true });
    });

    it('queues a second TTS redemption during the 10s global cooldown and plays it afterwards', async () => {
      const b = await start();
      await b.event(TYPE, { user_name: 'A', user_input: 'first', reward: { title: 'tts' } });
      const before = b.dashboardCalls().length;
      await b.event(TYPE, { user_name: 'B', user_input: 'second', reward: { title: 'tts' } });
      expect(callsSince(b, before).map((c) => c.route)).toEqual(['POST /api/redemptions']);
      await b.advance(10_000);
      const alerts = callsSince(b, before).filter((c) => c.route === 'POST /api/test-alert');
      expect(alerts.map((c) => c.body.message)).toEqual(['second']);
    });

    it('treats a TTS reward without input as a normal redemption', async () => {
      const b = await start();
      expect(await b.event(TYPE, { user_name: 'Viewer', reward: { title: 'TTS' } })).toEqual(['Viewer redeemed: TTS']);
    });

    it('does not treat a title that merely contains the letters "tts" as TTS', async () => {
      const b = await start();
      const out = await b.event(TYPE, { user_name: 'Viewer', user_input: 'boom', reward: { title: 'Buttsplosion' } });
      expect(out).toEqual(['Viewer redeemed: Buttsplosion - boom']);
      expect(b.dashboardCalls().some((c) => c.route === 'POST /api/test-alert' && c.body.alertType === 'tts')).toBe(false);
    });
  });

  describe('channel.subscribe', () => {
    it('thanks a new sub with its tier and sends a subscription alert', async () => {
      const b = await start();
      const before = b.dashboardCalls().length;
      const out = await b.event('channel.subscribe', { user_name: 'Subby', tier: '2000', is_gift: false });
      expect(out).toEqual(['Thank you Subby for the Tier 2 sub!']);
      expect(callsSince(b, before)).toEqual([
        { route: 'POST /api/eventsub-events', body: { type: 'subscription', user: 'Subby', tier: 'Tier 2', isGift: false } },
        { route: 'POST /api/test-alert', body: { alertType: 'subscription', user: 'Subby', tier: 'Tier 2' } }
      ]);
    });

    it('maps tiers: 1000/unknown/missing -> Tier 1, 3000 -> Tier 3', async () => {
      const b = await start();
      expect(await b.event('channel.subscribe', { user_name: 'a', tier: '3000' })).toEqual(['Thank you a for the Tier 3 sub!']);
      expect(await b.event('channel.subscribe', { user_name: 'b', tier: '1000' })).toEqual(['Thank you b for the Tier 1 sub!']);
      expect(await b.event('channel.subscribe', { user_name: 'c', tier: '5000' })).toEqual(['Thank you c for the Tier 1 sub!']);
      expect(await b.event('channel.subscribe', {})).toEqual(['Thank you someone for the Tier 1 sub!']);
    });

    it('stays silent for gifted subs but still logs them', async () => {
      const b = await start();
      const before = b.dashboardCalls().length;
      expect(await b.event('channel.subscribe', { user_name: 'Giftee', tier: '1000', is_gift: true })).toEqual([]);
      expect(callsSince(b, before)).toEqual([
        { route: 'POST /api/eventsub-events', body: { type: 'subscription', user: 'Giftee', tier: 'Tier 1', isGift: true } }
      ]);
    });
  });

  describe('channel.subscription.message (resub)', () => {
    it('thanks with months, tier and the message', async () => {
      const b = await start();
      const before = b.dashboardCalls().length;
      const out = await b.event('channel.subscription.message', {
        user_name: 'Resub', tier: '2000', cumulative_months: 12, streak_months: 3, message: { text: 'hi chat' }
      });
      expect(out).toEqual(['Thank you Resub for 12 months at Tier 2! "hi chat"']);
      expect(callsSince(b, before)).toEqual([
        { route: 'POST /api/eventsub-events', body: { type: 'subscription', user: 'Resub', tier: 'Tier 2', months: 12, message: 'hi chat' } },
        { route: 'POST /api/test-alert', body: { alertType: 'subscription', user: 'Resub', tier: 'Tier 2', message: '12 months - hi chat' } }
      ]);
    });

    it('defaults to 1 month and no message', async () => {
      const b = await start();
      const before = b.dashboardCalls().length;
      // singular "month"
      expect(await b.event('channel.subscription.message', { user_name: 'R' })).toEqual(['Thank you R for 1 month at Tier 1!']);
      expect(callsSince(b, before)[1].body).toEqual({ alertType: 'subscription', user: 'R', tier: 'Tier 1', message: '1 month' });
    });
  });

  describe('channel.subscription.gift', () => {
    it('announces a multi-gift with the cumulative total', async () => {
      const b = await start();
      const before = b.dashboardCalls().length;
      const out = await b.event('channel.subscription.gift', { user_name: 'Santa', tier: '1000', total: 5, cumulative_total: 50, is_anonymous: false });
      expect(out).toEqual(['Santa gifted 5 Tier 1 subs! (50 total)']);
      expect(callsSince(b, before)).toEqual([
        { route: 'POST /api/eventsub-events', body: { type: 'subscription_gift', user: 'Santa', tier: 'Tier 1', amount: 5, total: 50, isAnonymous: false } },
        { route: 'POST /api/test-alert', body: { alertType: 'subscription', user: 'Santa', tier: 'Tier 1', message: 'Gifted 5 subs!' } }
      ]);
    });

    it('uses singular "sub", falls back to the gift total when there is no cumulative total', async () => {
      const b = await start();
      expect(await b.event('channel.subscription.gift', { user_name: 'Santa', tier: '3000', total: 1 })).toEqual(['Santa gifted 1 Tier 3 sub! (1 total)']);
      expect(await b.event('channel.subscription.gift', {})).toEqual(['Anonymous gifted 1 Tier 1 sub! (1 total)']);
    });

    it('hides the gifter when anonymous', async () => {
      const b = await start();
      const before = b.dashboardCalls().length;
      const out = await b.event('channel.subscription.gift', { user_name: 'Hidden', total: 3, is_anonymous: true });
      expect(out).toEqual(['An anonymous gifter gifted 3 Tier 1 subs! (3 total)']);
      expect(callsSince(b, before)[0].body).toMatchObject({ user: 'An anonymous gifter', isAnonymous: true });
    });
  });

  describe('channel.cheer', () => {
    it('thanks the cheerer with the bits and message', async () => {
      const b = await start();
      const before = b.dashboardCalls().length;
      const out = await b.event('channel.cheer', { user_name: 'Bitty', bits: 100, message: 'Cheer100 gg', is_anonymous: false });
      expect(out).toEqual(['Bitty cheered 100 bits! "Cheer100 gg"']);
      expect(callsSince(b, before)).toEqual([
        { route: 'POST /api/eventsub-events', body: { type: 'bits', user: 'Bitty', amount: 100, message: 'Cheer100 gg', isAnonymous: false } },
        { route: 'POST /api/test-alert', body: { alertType: 'bits', user: 'Bitty', amount: 100, message: 'Cheer100 gg' } }
      ]);
    });

    it('hides anonymous cheerers and handles missing bits/message', async () => {
      const b = await start();
      expect(await b.event('channel.cheer', { user_name: 'Secret', bits: 5, is_anonymous: true })).toEqual(['Anonymous cheered 5 bits!']);
      expect(await b.event('channel.cheer', {})).toEqual(['Anonymous cheered 0 bits!']);
    });
  });

  describe('unsubscribed event types and config toggles', () => {
    it('has no subscription for hype train, ad break, polls, predictions or channel updates', async () => {
      const b = await start();
      for (const type of [
        'channel.hype_train.begin', 'channel.hype_train.progress', 'channel.hype_train.end', 'channel.ad_break.begin',
        'channel.poll.begin', 'channel.prediction.begin', 'channel.update', 'channel.chat.message'
      ]) {
        expect(b.twitch.emitEvent(type, {})).toBe(0);
      }
    });

    it('ignores a notification for an unsubscribed type sent on the session', async () => {
      const b = await start();
      sendNotification(sockets.server()[1], 'channel.hype_train.begin', COND, { level: 2 });
      sendNotification(sockets.server()[1], 'channel.cheer', COND, { user_name: 'marker', bits: 1 });
      await waitFor(() => b.said().length > 0, 'marker cheer');
      await b.settle();
      expect(b.take()).toEqual(['marker cheered 1 bits!']);
    });

    it('DISABLE_EVENTSUB=1 disables both sessions', async () => {
      const b = await start({ env: { DISABLE_EVENTSUB: '1' } });
      expect(b.twitch.eventSubSessions()).toBe(0);
      expect(b.twitch.state.subscriptions).toEqual([]);
      expect(lines(logSpy)).toEqual(expect.arrayContaining([
        'EventSub disabled via DISABLE_EVENTSUB=1',
        '[EventSub-Broadcaster] EventSub disabled via DISABLE_EVENTSUB=1'
      ]));
    });

    it.each(['true', 'TRUE', 'yes', ' Yes '])('DISABLE_EVENTSUB=%s disables both sessions too, like feature-scopes', async (value) => {
      const b = await start({ env: { DISABLE_EVENTSUB: value } });
      expect(b.twitch.eventSubSessions()).toBe(0);
      expect(b.twitch.state.subscriptions).toEqual([]);
      expect(lines(logSpy)).toEqual(expect.arrayContaining([
        `EventSub disabled via DISABLE_EVENTSUB=${value}`,
        `[EventSub-Broadcaster] EventSub disabled via DISABLE_EVENTSUB=${value}`
      ]));
    });

    it.each(['false', '0', 'no'])('DISABLE_EVENTSUB=%s keeps EventSub on', async (value) => {
      const b = await start({ env: { DISABLE_EVENTSUB: value } });
      expect(b.twitch.eventSubSessions()).toBe(2);
      expect(b.twitch.state.subscriptions).toHaveLength(9);
    });

    it('ignores notifications whose condition does not match the subscribed broadcaster', async () => {
      const b = await start();
      sendNotification(sockets.server()[1], 'channel.cheer', { broadcaster_user_id: '999' }, { user_name: 'x', bits: 1 });
      sendNotification(sockets.server()[1], 'channel.cheer', COND, { user_name: 'y', bits: 1 });
      // Frames on one socket arrive in order, so once the second is handled the first was ignored
      await waitFor(() => b.said().length > 0, 'cheer');
      await b.settle();
      expect(b.take()).toEqual(['y cheered 1 bits!']);
    });
  });

  describe('WebSocket session lifecycle', () => {
    const FOLLOW_COND = { broadcaster_user_id: '1001', moderator_user_id: '1001' };
    const logged = (line: string) => () => lines(logSpy).includes(line);

    it('tracks one server socket per session (bot = first, broadcaster = second)', async () => {
      const b = await start();
      expect(sockets.server()).toHaveLength(2);
      expect(sockets.client()).toHaveLength(2);
      expect(b.twitch.eventSubSessions()).toBe(2);
    });

    const BROADCASTER_TYPES = [
      'channel.follow', 'channel.raid', 'channel.channel_points_custom_reward_redemption.add', 'channel.subscribe',
      'channel.subscription.message', 'channel.subscription.gift', 'channel.cheer'
    ];
    const subsOn = (b: BotHarness, sessionId: string) =>
      b.twitch.state.subscriptions.filter((s) => s.sessionId === sessionId).map((s) => s.type);

    it('drops redelivered message ids (one chat line and alert per id)', async () => {
      const b = await start();
      const socket = sockets.server()[1];
      sendNotification(socket, 'channel.follow', FOLLOW_COND, { user_name: 'Dup' }, 'same-id');
      sendNotification(socket, 'channel.follow', FOLLOW_COND, { user_name: 'Dup' }, 'same-id');
      // Frames on one socket arrive in order: once the marker is handled, the duplicate was too
      sendNotification(socket, 'channel.cheer', COND, { user_name: 'marker', bits: 1 });
      await waitFor(() => b.said().length === 2, 'follow thanks + marker');
      await pumpClock(b);
      expect(b.take()).toEqual(['Thanks for the follow, Dup!', 'marker cheered 1 bits!']);
      expect(b.dashboardCalls().filter((c) => c.route === 'POST /api/test-alert' && c.body.alertType === 'follow')).toHaveLength(1);
      expect(lines(logSpy)).toContain('[EventSub-WS] Duplicate message ignored: same-id');
    });

    it('revocation stops dispatching that subscription and it is not re-created on a new session', async () => {
      const b = await start();
      const cheerSub = b.twitch.state.subscriptions.find((s) => s.type === 'channel.cheer')!;
      sendFrame(sockets.server()[1], 'revocation', {
        subscription: { id: cheerSub.id, type: 'channel.cheer', version: '1', status: 'authorization_revoked', condition: COND }
      });
      await waitFor(logged('[EventSub-WS] Subscription revoked: channel.cheer - authorization_revoked'), 'revocation log');
      expect(lines(logSpy)).toContain('[EventSub-WS] Removed 1 handler(s) for revoked channel.cheer; it will not be re-created');

      // A cheer on the session is no longer handled; other types still are
      sendNotification(sockets.server()[1], 'channel.cheer', COND, { user_name: 'After', bits: 2 });
      sendNotification(sockets.server()[1], 'channel.follow', FOLLOW_COND, { user_name: 'marker' });
      await waitFor(() => b.said().length > 0, 'follow marker');
      await pumpClock(b);
      expect(b.take()).toEqual(['Thanks for the follow, marker!']);

      // New session: everything but the revoked type is re-created
      sockets.server()[1].close(4003, 'connection unused');
      await waitFor(logged('[EventSub-WS] Scheduling reconnect attempt 1 in 1000ms'), 'scheduled reconnect');
      await b.advance(1000);
      await waitFor(() => subsOn(b, 'session-3').length === 6, 'resubscribed on session-3');
      await b.settle();
      expect(subsOn(b, 'session-3')).toEqual(BROADCASTER_TYPES.filter((t) => t !== 'channel.cheer'));
      expect(b.twitch.emitEvent('channel.cheer', { user_name: 'Gone', bits: 1 })).toBe(0);
    });

    it('logs and ignores unknown message types', async () => {
      const b = await start();
      sendFrame(sockets.server()[0], 'mystery', {});
      await waitFor(logged('[EventSub-WS] Unknown message type: mystery'), 'unknown type log');
      await b.settle();
      expect(b.twitch.eventSubSessions()).toBe(2);
    });

    it('session_reconnect: moves to reconnect_url immediately, closes the old socket after the welcome, keeps subscriptions', async () => {
      const b = await start();
      const old = sockets.server()[1];
      sendFrame(old, 'session_reconnect', {
        session: { id: 'session-2', status: 'reconnecting', reconnect_url: b.twitch.reconnectUrl('session-2'), keepalive_timeout_seconds: null }
      });
      // No timer involved: the new connection is made right away
      await waitFor(logged('[EventSub-WS] Reconnected to session session-2'), 'migration welcome');
      await waitFor(() => old.readyState === 3, 'old socket closed by the bot');
      await b.settle();
      expect(lines(logSpy)).toContain('[EventSub-WS] Received reconnect URL, connecting before the current connection closes');
      expect(sockets.server()).toHaveLength(3);
      expect(b.twitch.eventSubSessions()).toBe(2);
      // Subscriptions carry over: nothing re-created
      expect(b.twitch.calls('POST /helix/eventsub/subscriptions')).toHaveLength(9);
      expect(lines(logSpy).some((l) => l.startsWith('[EventSub-WS] Connection lost'))).toBe(false);

      // Events keep flowing, now on the new socket
      expect(await b.event('channel.cheer', { user_name: 'Again', bits: 3 })).toEqual(['Again cheered 3 bits!']);
      // ... and the session survives clock movement without a new-session reconnect
      await b.advance(60_000);
      expect(sockets.server()).toHaveLength(3);
    });

    it('close without reconnect_url: starts a new session after 1s and re-creates its subscriptions', async () => {
      const b = await start();
      sockets.server()[1].close(4003, 'connection unused');
      await waitFor(logged('[EventSub-WS] WebSocket closed: 4003 - connection unused'), 'close log');
      await waitFor(logged('[EventSub-WS] Scheduling reconnect attempt 1 in 1000ms'), 'scheduled reconnect');
      expect(b.twitch.eventSubSessions()).toBe(1);
      expect(await b.event('channel.follow', { user_name: 'Lost' })).toEqual([]);

      await b.advance(999);
      expect(sockets.server()).toHaveLength(2);
      await b.advance(1);
      await waitFor(() => subsOn(b, 'session-3').length === 7, 'resubscribed on session-3');
      await b.settle();
      expect(b.twitch.eventSubSessions()).toBe(2);
      expect(subsOn(b, 'session-3')).toEqual(BROADCASTER_TYPES);
      expect(b.twitch.calls('POST /helix/eventsub/subscriptions')).toHaveLength(16);

      expect(await b.event('channel.follow', { user_name: 'Back' })).toEqual(['Thanks for the follow, Back!']);
      expect(await b.event('stream.online', { broadcaster_user_id: '1001' })).toEqual(['Stream is now live!']);

      // A second drop (of the reconnected socket) recovers the same way
      sockets.server()[2].close(4003, 'again');
      await waitFor(logged('[EventSub-WS] WebSocket closed: 4003 - again'), 'second close');
      await b.advance(1000);
      await waitFor(() => subsOn(b, 'session-4').length === 7, 'resubscribed on session-4');
      await b.settle();
      expect(await b.event('channel.follow', { user_name: 'Twice' })).toEqual(['Thanks for the follow, Twice!']);
    });

    it('keepalive timeout (keepalive_timeout_seconds + 1s) drops the socket and starts a new session', async () => {
      const b = await start();
      // Welcome says 600s, so the client gives up after 601s of silence
      await b.advance(600_000);
      expect(b.twitch.eventSubSessions()).toBe(2);
      // A keepalive on the broadcaster session (at t=600s) moves only its deadline, to t=1201s
      sendFrame(sockets.server()[1], 'session_keepalive', {});
      sendFrame(sockets.server()[1], 'probe-after-keepalive', {});
      await waitFor(logged('[EventSub-WS] Unknown message type: probe-after-keepalive'), 'keepalive handled');

      await b.advance(1_000);
      expect(lines(logSpy)).toContain('[EventSub-WS] Keepalive timeout - reconnecting...');
      await waitFor(() => sockets.server()[0].readyState === 3, 'bot session dropped');
      await b.advance(1_000);
      await waitFor(() => subsOn(b, 'session-3').length === 2, 'bot session resubscribed');
      await b.settle();
      expect(subsOn(b, 'session-3')).toEqual(['stream.online', 'stream.offline']);
      expect(await b.event('stream.online', { broadcaster_user_id: '1001' })).toEqual(['Stream is now live!']);

      // The broadcaster session is still the original one until its own deadline
      expect(sockets.server()[1].readyState).toBe(1);
      await b.advance(598_000); // t=1200s
      expect(sockets.server()[1].readyState).toBe(1);
      await b.advance(1_000); // t=1201s
      await waitFor(() => sockets.server()[1].readyState === 3, 'broadcaster session dropped');
      await b.advance(1_000);
      await waitFor(() => subsOn(b, 'session-4').length === 7, 'broadcaster session resubscribed');
      await b.settle();
      expect(subsOn(b, 'session-4')).toEqual(BROADCASTER_TYPES);
      expect(b.twitch.eventSubSessions()).toBe(2);
      expect(await b.event('channel.follow', { user_name: 'Kept' })).toEqual(['Thanks for the follow, Kept!']);
    });

    it('notifications keep a session alive without keepalive frames', async () => {
      const b = await start();
      for (let i = 0; i < 7; i++) {
        await b.advance(100_000);
        // channel.cheer only reaches the broadcaster session
        expect(await b.event('channel.cheer', { user_name: 'x', bits: 1 })).toEqual(['x cheered 1 bits!']);
      }
      // t=700s: the silent bot session timed out at 601s and was replaced; the busy one was not
      expect(sockets.server()[1].readyState).toBe(1);
      expect(sockets.server()[0].readyState).toBe(3);
      expect(subsOn(b, 'session-2')).toEqual(BROADCASTER_TYPES);
      expect(b.twitch.state.subscriptions.filter((s) => BROADCASTER_TYPES.includes(s.type))).toHaveLength(7);
      expect(subsOn(b, 'session-3')).toEqual(['stream.online', 'stream.offline']);
    });
  });
});
