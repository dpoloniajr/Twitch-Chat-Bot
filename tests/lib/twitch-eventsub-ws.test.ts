/**
 * Tests for lib/twitch-eventsub-ws.js (src/lib/twitch-eventsub-ws.ts): the
 * EventSub WebSocket session lifecycle, Helix subscription creation,
 * notification dispatch, keepalive, reconnects and de-duplication.
 *
 * Regression: the original client never reconnected after a keepalive timeout
 * or an unexpected close, only reconnected to session_reconnect URLs after the
 * old socket had already closed, never re-created subscriptions on a new
 * session, and kept reconnecting after stop().
 *
 * Most tests drive a fake `ws` socket under jest fake timers; the last block
 * runs against real local `ws` servers.
 */

import { EventEmitter } from 'events';
import axios from 'axios';
import {
  EVENTSUB_WS_URL,
  HELIX_BASE_URL,
  TwitchEventSubWS
} from '../../src/lib/twitch-eventsub-ws';

// ---------- fake ws ----------

class FakeWebSocket extends EventEmitter {
  static instances: FakeWebSocket[] = [];
  static throwOnConstruct: Error | null = null;
  url: string;
  close = jest.fn();
  terminate = jest.fn();

  constructor(url: string) {
    super();
    if (FakeWebSocket.throwOnConstruct) throw FakeWebSocket.throwOnConstruct;
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
}

jest.mock('ws', () => ({
  __esModule: true,
  default: function MockWs(this: unknown, url: string) {
    // Delegate to the per-test fake (or a real-ws subclass for integration tests)
    return new (globalThis as unknown as { __WsImpl: new (u: string) => unknown }).__WsImpl(url);
  }
}));

jest.mock('axios', () => {
  const post = jest.fn();
  return { __esModule: true, default: { post }, post };
});

const mockedPost = axios.post as unknown as jest.Mock;

// ---------- helpers ----------

/* eslint-disable @typescript-eslint/no-explicit-any */
const internals = (c: TwitchEventSubWS): any => c as any;
const registered = (c: TwitchEventSubWS): any[] => [...internals(c)._subscriptions];

let msgSeq = 0;
function msg(type: string, payload: Record<string, unknown> = {}, id?: string) {
  return {
    metadata: { message_id: id ?? `m-${++msgSeq}`, message_type: type, message_timestamp: '2026-01-01T00:00:00Z' },
    payload
  };
}
const welcome = (sessionId = 'sess-1', keepaliveSeconds: number | null = 10) =>
  msg('session_welcome', { session: { id: sessionId, status: 'connected', keepalive_timeout_seconds: keepaliveSeconds } });
const keepalive = () => msg('session_keepalive');
const reconnectMsg = (url: string | null) =>
  msg('session_reconnect', { session: { id: 'sess-1', status: 'reconnecting', reconnect_url: url } });
const notification = (type: string, condition: Record<string, string>, event: Record<string, unknown>, id?: string) =>
  msg('notification', { subscription: { id: 'sub', type, status: 'enabled', condition }, event }, id);
const offline = (broadcaster = 'b1', id?: string) =>
  notification('stream.offline', { broadcaster_user_id: broadcaster }, { broadcaster_user_id: broadcaster }, id);

function send(ws: FakeWebSocket, message: unknown) {
  ws.emit('message', Buffer.from(JSON.stringify(message)));
}
function serverClose(ws: FakeWebSocket, code = 1000, reason = '') {
  ws.emit('close', code, Buffer.from(reason));
}

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

let helixSeq = 0;
function helixOk(id = `twitch-sub-${++helixSeq}`) {
  return { data: { data: [{ id, status: 'websocket_connected', type: 'x', version: '1', cost: 0 }], total: 1 } };
}

function httpError(status: number, message?: string) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: message === undefined ? undefined : { status, message } }
  });
}

let logSpy: jest.SpyInstance;
let errSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;
const logged = (spy: jest.SpyInstance) => spy.mock.calls.map(args => args.join(' '));
const sockets = () => FakeWebSocket.instances;
const lastSocket = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
const postedSessions = () => mockedPost.mock.calls.map(c => c[1].transport.session_id);

beforeEach(() => {
  FakeWebSocket.instances = [];
  FakeWebSocket.throwOnConstruct = null;
  (globalThis as any).__WsImpl = FakeWebSocket;
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockedPost.mockReset();
  mockedPost.mockImplementation(async () => helixOk());
  jest.useFakeTimers();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

const make = () => new TwitchEventSubWS({ clientId: 'cid', accessToken: 'tok' });

/** Start a client and complete the welcome handshake. */
async function connected(client = make(), sessionId = 'sess-1') {
  const started = client.start();
  const ws = lastSocket();
  ws.emit('open');
  send(ws, welcome(sessionId));
  await started;
  return { client, ws };
}

/** Let the pending reconnect timer fire and welcome the new socket. */
async function completeReconnect(delayMs: number, sessionId: string) {
  const before = sockets().length;
  jest.advanceTimersByTime(delayMs);
  expect(sockets()).toHaveLength(before + 1);
  const ws = lastSocket();
  expect(ws.url).toBe(EVENTSUB_WS_URL);
  ws.emit('open');
  send(ws, welcome(sessionId));
  await flush();
  return ws;
}

// ---------- tests ----------

describe('TwitchEventSubWS', () => {
  describe('constructor', () => {
    it('stores options and starts disconnected', () => {
      const c = make();
      expect(c.clientId).toBe('cid');
      expect(c.accessToken).toBe('tok');
      expect(c.ws).toBeNull();
      expect(c.sessionId).toBeNull();
      expect(c.reconnectUrl).toBeNull();
      expect(c.keepaliveTimeoutMs).toBe(10000);
      expect(c.isConnected()).toBe(false);
      expect(registered(c)).toEqual([]);
    });

    it('accepts no options', () => {
      const c = new TwitchEventSubWS();
      expect(c.clientId).toBeUndefined();
      expect(c.accessToken).toBeUndefined();
    });
  });

  describe('start() and session_welcome', () => {
    it('connects to the Twitch EventSub URL and resolves on welcome', async () => {
      const c = make();
      const started = c.start();
      const ws = sockets()[0];
      expect(ws.url).toBe(EVENTSUB_WS_URL);
      expect(c.ws).toBe(ws);

      ws.emit('open');
      expect(logged(logSpy)).toContain('[EventSub-WS] WebSocket connected');

      send(ws, welcome('abc', 30));
      await expect(started).resolves.toBeUndefined();
      expect(c.sessionId).toBe('abc');
      expect(c.isConnected()).toBe(true);
      expect(c.keepaliveTimeoutMs).toBe(31000);
      expect(logged(logSpy)).toContain('[EventSub-WS] Session established: abc');
    });

    it('defaults the keepalive to 10s + 1s grace when the welcome has none', async () => {
      const c = make();
      const started = c.start();
      send(sockets()[0], welcome('abc', null));
      await started;
      expect(c.keepaliveTimeoutMs).toBe(11000);
    });

    it('rejects on a socket error before the welcome and does not reconnect', async () => {
      const c = make();
      const started = c.start();
      const ws = sockets()[0];
      const err = new Error('ECONNREFUSED');
      ws.emit('error', err);
      await expect(started).rejects.toBe(err);
      expect(logged(errSpy)).toContain('[EventSub-WS] WebSocket error: ECONNREFUSED');
      serverClose(ws, 1006);
      jest.advanceTimersByTime(10 * 60 * 1000);
      expect(sockets()).toHaveLength(1);
      expect(jest.getTimerCount()).toBe(0);
      expect(c.ws).toBeNull();
    });

    it('rejects when the socket closes before the welcome', async () => {
      const c = make();
      const started = c.start();
      serverClose(sockets()[0], 1006);
      await expect(started).rejects.toThrow('EventSub connection closed before welcome');
      jest.advanceTimersByTime(10 * 60 * 1000);
      expect(sockets()).toHaveLength(1);
    });

    it('rejects when the WebSocket constructor throws', async () => {
      FakeWebSocket.throwOnConstruct = new Error('bad url');
      await expect(make().start()).rejects.toThrow('bad url');
      expect(jest.getTimerCount()).toBe(0);
    });

    it('rejects after 30s without a welcome and closes the socket', async () => {
      const started = make().start();
      const outcome = jest.fn();
      started.catch(outcome);
      jest.advanceTimersByTime(29999);
      await flush();
      expect(outcome).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      await expect(started).rejects.toThrow('EventSub connection timeout');
      expect(sockets()[0].close).toHaveBeenCalled();
    });

    it('rejects when stop() is called before the welcome', async () => {
      const c = make();
      const started = c.start();
      c.stop();
      await expect(started).rejects.toThrow('EventSub stopped');
      expect(sockets()[0].close).toHaveBeenCalled();
    });

    it('clears the connection timeout once welcomed', async () => {
      await connected();
      // Only the keepalive timer remains
      expect(jest.getTimerCount()).toBe(1);
    });

    it('logs malformed JSON and keeps waiting', async () => {
      const c = make();
      const started = c.start();
      const ws = sockets()[0];
      ws.emit('message', Buffer.from('{not json'));
      await flush();
      expect(logged(errSpy).some(l => l.startsWith('[EventSub-WS] Error parsing message:'))).toBe(true);
      send(ws, welcome());
      await expect(started).resolves.toBeUndefined();
    });

    it('logs unknown message types', async () => {
      const { ws } = await connected();
      send(ws, msg('something_new'));
      await flush();
      expect(logged(logSpy)).toContain('[EventSub-WS] Unknown message type: something_new');
    });

    it('resolves only after queued subscriptions are created', async () => {
      const c = make();
      const cb = jest.fn();
      await expect(c.onStreamOnline('b1', cb)).resolves.toBeUndefined(); // queued
      expect(mockedPost).not.toHaveBeenCalled();
      expect(internals(c)._pendingSubscriptions).toHaveLength(1);

      let releasePost!: (v: unknown) => void;
      mockedPost.mockReturnValueOnce(new Promise(r => { releasePost = r; }));
      const started = c.start();
      const done = jest.fn();
      started.then(done);
      send(sockets()[0], welcome('s9'));
      await flush();
      expect(done).not.toHaveBeenCalled();
      expect(mockedPost).toHaveBeenCalledTimes(1);
      expect(mockedPost.mock.calls[0][1].transport).toEqual({ method: 'websocket', session_id: 's9' });

      releasePost(helixOk('q1'));
      await flush();
      expect(done).toHaveBeenCalled();
      expect(internals(c)._pendingSubscriptions).toEqual([]);
      expect(registered(c).map(s => s.twitchId)).toEqual(['q1']);
    });

    it('resolves (and logs) when a queued subscription fails during the welcome; the others are still created', async () => {
      const c = make();
      c.onStreamOnline('b1', jest.fn());
      c.onStreamOffline('b1', jest.fn());
      mockedPost.mockRejectedValueOnce(httpError(403, 'missing scope'));
      const started = c.start();
      send(sockets()[0], welcome());
      await expect(started).resolves.toBeUndefined();
      expect(logged(errSpy)).toContain('[EventSub-WS] Failed to subscribe to stream.online: missing scope');
      expect(registered(c).map(s => s.type)).toEqual(['stream.offline']);
      expect(internals(c)._pendingSubscriptions).toEqual([]);
    });
  });

  describe('subscription creation via Helix', () => {
    it('posts the subscription with session transport and auth headers', async () => {
      const { client } = await connected();
      mockedPost.mockResolvedValueOnce(helixOk('t1'));
      const sub = await client.onStreamOffline('b1', jest.fn());

      expect(sub).toEqual(expect.objectContaining({ id: 't1' }));
      expect(mockedPost).toHaveBeenCalledWith(
        `${HELIX_BASE_URL}/eventsub/subscriptions`,
        {
          type: 'stream.offline',
          version: '1',
          condition: { broadcaster_user_id: 'b1' },
          transport: { method: 'websocket', session_id: 'sess-1' }
        },
        { headers: { 'Client-ID': 'cid', 'Authorization': 'Bearer tok', 'Content-Type': 'application/json' } }
      );
      expect(registered(client)).toEqual([expect.objectContaining({
        type: 'stream.offline', internalId: 'stream.offline:b1', twitchId: 't1'
      })]);
      expect(logged(logSpy)).toContain('[EventSub-WS] Subscribed to stream.offline: t1');
    });

    it('uses version 2 for channel.follow and sends the moderator condition', async () => {
      const { client } = await connected();
      await client.onChannelFollow('b1', 'm1', jest.fn());
      expect(mockedPost.mock.calls[0][1]).toEqual(expect.objectContaining({
        type: 'channel.follow',
        version: '2',
        condition: { broadcaster_user_id: 'b1', moderator_user_id: 'm1' }
      }));
    });

    it('logs the Helix error message and rethrows; nothing is registered', async () => {
      const { client } = await connected();
      const err = httpError(409, 'subscription already exists');
      mockedPost.mockRejectedValueOnce(err);
      await expect(client.onChannelCheer('b1', jest.fn())).rejects.toBe(err);
      expect(logged(errSpy)).toContain('[EventSub-WS] Failed to subscribe to channel.cheer: subscription already exists');
      expect(registered(client)).toEqual([]);
    });

    it('falls back to error.message when Helix sends no message', async () => {
      const { client } = await connected();
      mockedPost.mockRejectedValueOnce(new Error('socket hang up'));
      await expect(client.onChannelCheer('b1', jest.fn())).rejects.toThrow('socket hang up');
      expect(logged(errSpy)).toContain('[EventSub-WS] Failed to subscribe to channel.cheer: socket hang up');
    });

    it('still registers the handler when Helix returns no subscription object', async () => {
      const { client, ws } = await connected();
      mockedPost.mockResolvedValueOnce({ data: { data: [] } });
      const cb = jest.fn();
      await expect(client.onStreamOffline('b1', cb)).resolves.toBeUndefined();
      expect(registered(client)[0].twitchId).toBeUndefined();
      send(ws, offline());
      await flush();
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('uses the latest token after setAccessToken', async () => {
      const { client } = await connected();
      await client.onStreamOnline('b1', jest.fn());
      client.setAccessToken('fresh');
      expect(client.accessToken).toBe('fresh');
      expect(mockedPost).toHaveBeenCalledTimes(1);
      await client.onStreamOffline('b1', jest.fn());
      expect(mockedPost.mock.calls[1][2].headers.Authorization).toBe('Bearer fresh');
    });
  });

  describe('notification dispatch', () => {
    type Case = {
      name: string;
      subscribe: (c: TwitchEventSubWS, cb: jest.Mock) => Promise<unknown>;
      type: string;
      condition: Record<string, string>;
      event: Record<string, unknown>;
      expected: Record<string, unknown>;
    };
    const cases: Case[] = [
      {
        name: 'onStreamOnline',
        subscribe: (c, cb) => c.onStreamOnline('b1', cb),
        type: 'stream.online',
        condition: { broadcaster_user_id: 'b1' },
        event: { broadcaster_user_id: 'b1', broadcaster_user_login: 'bee', broadcaster_user_name: 'Bee', type: 'live', started_at: '2026-01-01T10:00:00Z' },
        expected: { broadcasterUserId: 'b1', broadcasterUserLogin: 'bee', broadcasterUserName: 'Bee', type: 'live', startedAt: new Date('2026-01-01T10:00:00Z') }
      },
      {
        name: 'onStreamOffline',
        subscribe: (c, cb) => c.onStreamOffline('b1', cb),
        type: 'stream.offline',
        condition: { broadcaster_user_id: 'b1' },
        event: { broadcaster_user_id: 'b1', broadcaster_user_login: 'bee', broadcaster_user_name: 'Bee' },
        expected: { broadcasterUserId: 'b1', broadcasterUserLogin: 'bee', broadcasterUserName: 'Bee' }
      },
      {
        name: 'onChannelFollow',
        subscribe: (c, cb) => c.onChannelFollow('b1', 'm1', cb),
        type: 'channel.follow',
        condition: { broadcaster_user_id: 'b1', moderator_user_id: 'm1' },
        event: { user_id: 'u1', user_login: 'ann', user_name: 'Ann', broadcaster_user_id: 'b1', followed_at: '2026-01-02T00:00:00Z' },
        expected: { userId: 'u1', userLogin: 'ann', userName: 'Ann', userDisplayName: 'Ann', broadcasterUserId: 'b1', followedAt: new Date('2026-01-02T00:00:00Z') }
      },
      {
        name: 'onChannelRaidTo',
        subscribe: (c, cb) => c.onChannelRaidTo('b1', cb),
        type: 'channel.raid',
        condition: { to_broadcaster_user_id: 'b1' },
        event: {
          from_broadcaster_user_id: 'r1', from_broadcaster_user_login: 'raider', from_broadcaster_user_name: 'Raider',
          to_broadcaster_user_id: 'b1', to_broadcaster_user_login: 'bee', to_broadcaster_user_name: 'Bee', viewers: 42
        },
        expected: {
          raidingBroadcasterId: 'r1', raidingBroadcasterLogin: 'raider', raidingBroadcasterName: 'Raider',
          raidingBroadcasterDisplayName: 'Raider', raidedBroadcasterId: 'b1', raidedBroadcasterLogin: 'bee',
          raidedBroadcasterName: 'Bee', viewers: 42
        }
      },
      {
        name: 'onChannelRedemptionAdd',
        subscribe: (c, cb) => c.onChannelRedemptionAdd('b1', cb),
        type: 'channel.channel_points_custom_reward_redemption.add',
        condition: { broadcaster_user_id: 'b1' },
        event: {
          id: 'r-1', broadcaster_user_id: 'b1', broadcaster_user_login: 'bee', broadcaster_user_name: 'Bee',
          user_id: 'u1', user_login: 'ann', user_name: 'Ann', user_display_name: 'ANN', user_input: 'hi',
          status: 'unfulfilled', reward: { id: 'rw', title: 'TTS', cost: 100 }, redeemed_at: '2026-01-03T00:00:00Z'
        },
        expected: {
          id: 'r-1', broadcasterUserId: 'b1', broadcasterUserLogin: 'bee', broadcasterUserName: 'Bee',
          userId: 'u1', userLogin: 'ann', userName: 'Ann', userDisplayName: 'ANN', userInput: 'hi',
          status: 'unfulfilled', rewardId: 'rw', rewardTitle: 'TTS', rewardCost: 100, redeemedAt: new Date('2026-01-03T00:00:00Z')
        }
      },
      {
        name: 'onChannelSubscription',
        subscribe: (c, cb) => c.onChannelSubscription('b1', cb),
        type: 'channel.subscribe',
        condition: { broadcaster_user_id: 'b1' },
        event: { user_id: 'u1', user_login: 'ann', user_name: 'Ann', broadcaster_user_id: 'b1', tier: '1000', is_gift: false },
        expected: { userId: 'u1', userLogin: 'ann', userName: 'Ann', userDisplayName: 'Ann', broadcasterUserId: 'b1', tier: '1000', isGift: false }
      },
      {
        name: 'onChannelSubscriptionMessage',
        subscribe: (c, cb) => c.onChannelSubscriptionMessage('b1', cb),
        type: 'channel.subscription.message',
        condition: { broadcaster_user_id: 'b1' },
        event: {
          user_id: 'u1', user_login: 'ann', user_name: 'Ann', broadcaster_user_id: 'b1', tier: '2000',
          message: { text: 'yay' }, cumulative_months: 5, streak_months: null, duration_months: 1
        },
        expected: {
          userId: 'u1', userLogin: 'ann', userName: 'Ann', userDisplayName: 'Ann', broadcasterUserId: 'b1', tier: '2000',
          messageText: 'yay', cumulativeMonths: 5, streakMonths: null, durationMonths: 1
        }
      },
      {
        name: 'onChannelSubscriptionGift',
        subscribe: (c, cb) => c.onChannelSubscriptionGift('b1', cb),
        type: 'channel.subscription.gift',
        condition: { broadcaster_user_id: 'b1' },
        event: {
          user_id: 'u1', user_login: 'ann', user_name: 'Ann', broadcaster_user_id: 'b1', tier: '1000',
          total: 5, cumulative_total: null, is_anonymous: false
        },
        expected: {
          userId: 'u1', userLogin: 'ann', userName: 'Ann', gifterName: 'Ann', gifterDisplayName: 'Ann',
          broadcasterUserId: 'b1', tier: '1000', amount: 5, cumulativeAmount: 5, isAnonymous: false
        }
      },
      {
        name: 'onChannelCheer',
        subscribe: (c, cb) => c.onChannelCheer('b1', cb),
        type: 'channel.cheer',
        condition: { broadcaster_user_id: 'b1' },
        event: { user_id: 'u1', user_login: 'ann', user_name: 'Ann', broadcaster_user_id: 'b1', bits: 100, message: 'Cheer100', is_anonymous: false },
        expected: { userId: 'u1', userLogin: 'ann', userName: 'Ann', userDisplayName: 'Ann', broadcasterUserId: 'b1', bits: 100, message: 'Cheer100', isAnonymous: false }
      }
    ];

    it.each(cases)('$name subscribes to $type and maps the event', async ({ subscribe, type, condition, event, expected }) => {
      const { client, ws } = await connected();
      const cb = jest.fn();
      await subscribe(client, cb);
      expect(mockedPost.mock.calls[0][1]).toEqual(expect.objectContaining({ type, condition }));

      send(ws, notification(type, condition, event));
      await flush();
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(expected);
    });

    it('fills fallbacks for missing optional fields', async () => {
      const { client, ws } = await connected();
      const redemption = jest.fn();
      const resub = jest.fn();
      await client.onChannelRedemptionAdd('b1', redemption);
      await client.onChannelSubscriptionMessage('b1', resub);

      send(ws, notification('channel.channel_points_custom_reward_redemption.add', { broadcaster_user_id: 'b1' }, { user_name: 'Ann' }));
      send(ws, notification('channel.subscription.message', { broadcaster_user_id: 'b1' }, { user_name: 'Ann' }));
      await flush();
      expect(redemption.mock.calls[0][0]).toEqual(expect.objectContaining({
        userDisplayName: 'Ann', rewardId: undefined, rewardTitle: undefined, rewardCost: undefined
      }));
      expect(redemption.mock.calls[0][0].redeemedAt.getTime()).toBeNaN();
      expect(resub.mock.calls[0][0].messageText).toBe('');
    });

    it('dispatches only to handlers whose condition matches', async () => {
      const { client, ws } = await connected();
      const forB1 = jest.fn();
      const forB2 = jest.fn();
      await client.onStreamOffline('b1', forB1);
      await client.onStreamOffline('b2', forB2);

      send(ws, offline('b2'));
      await flush();
      expect(forB1).not.toHaveBeenCalled();
      expect(forB2).toHaveBeenCalledTimes(1);
    });

    it('ignores notifications for types with no handler', async () => {
      const { ws } = await connected();
      send(ws, notification('channel.ban', { broadcaster_user_id: 'b1' }, {}));
      send(ws, msg('notification', {})); // no subscription at all
      await flush();
      expect(errSpy).not.toHaveBeenCalled();
    });

    it('logs a throwing handler and keeps dispatching to the others', async () => {
      const { client, ws } = await connected();
      const bad = jest.fn(() => { throw new Error('boom'); });
      const good = jest.fn();
      await client.onStreamOffline('b1', bad);
      await client.onStreamOffline('b1', good);

      send(ws, offline());
      await flush();
      expect(good).toHaveBeenCalledTimes(1);
      expect(logged(errSpy)).toContain('[EventSub-WS] Error in handler for stream.offline: boom');
    });

    it('logs a rejected async handler instead of leaving an unhandled rejection', async () => {
      const { client, ws } = await connected();
      await client.onStreamOffline('b1', async () => { throw new Error('async boom'); });
      send(ws, offline());
      await flush();
      expect(logged(errSpy)).toContain('[EventSub-WS] Error in handler for stream.offline: async boom');
    });

    it('logs (does not crash) when the notification subscription has no condition', async () => {
      const { client, ws } = await connected();
      const cb = jest.fn();
      await client.onStreamOffline('b1', cb);
      send(ws, msg('notification', { subscription: { type: 'stream.offline' }, event: {} }));
      await flush();
      expect(cb).not.toHaveBeenCalled();
      expect(logged(errSpy).some(l => l.startsWith('[EventSub-WS] Error in handler for stream.offline:'))).toBe(true);
    });
  });

  describe('message de-duplication', () => {
    it('handles a message_id only once', async () => {
      const { client, ws } = await connected();
      const cb = jest.fn();
      await client.onStreamOffline('b1', cb);
      send(ws, offline('b1', 'dup-1'));
      send(ws, offline('b1', 'dup-1'));
      await flush();
      expect(cb).toHaveBeenCalledTimes(1);
      expect(logged(logSpy)).toContain('[EventSub-WS] Duplicate message ignored: dup-1');
    });

    it('de-duplicates across the old and new socket during a session_reconnect', async () => {
      const { client, ws } = await connected();
      const cb = jest.fn();
      await client.onStreamOffline('b1', cb);
      send(ws, reconnectMsg('wss://r1'));
      await flush();
      const ws2 = lastSocket();
      send(ws2, welcome('sess-1'));
      send(ws, offline('b1', 'same'));
      send(ws2, offline('b1', 'same'));
      await flush();
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('forgets ids after 10 minutes', async () => {
      const { client, ws } = await connected();
      const cb = jest.fn();
      await client.onStreamOffline('b1', cb);
      send(ws, offline('b1', 'old'));
      // keep the connection alive through 10+ minutes of fake time
      for (let i = 0; i < 61; i++) {
        jest.advanceTimersByTime(10000);
        send(ws, keepalive());
      }
      await flush();
      expect(client.ws).toBe(ws);
      send(ws, offline('b1', 'old'));
      await flush();
      expect(cb).toHaveBeenCalledTimes(2);
    });

    it('keeps at most 500 ids', async () => {
      const { client, ws } = await connected();
      for (let i = 0; i < 600; i++) send(ws, keepalive());
      await flush();
      expect(internals(client)._seenMessageIds.size).toBe(500);
    });

    it('handles messages without a message_id', async () => {
      const { client, ws } = await connected();
      const cb = jest.fn();
      await client.onStreamOffline('b1', cb);
      const n = offline();
      delete (n.metadata as any).message_id;
      send(ws, n);
      send(ws, n);
      await flush();
      expect(cb).toHaveBeenCalledTimes(2);
    });
  });

  describe('revocation', () => {
    it('logs, stops dispatching and never re-creates the revoked subscription', async () => {
      const { client, ws } = await connected();
      mockedPost.mockResolvedValueOnce(helixOk('t-off')).mockResolvedValueOnce(helixOk('t-on'));
      const off = jest.fn();
      await client.onStreamOffline('b1', off);
      await client.onStreamOnline('b1', jest.fn());

      send(ws, msg('revocation', { subscription: { id: 't-off', type: 'stream.offline', status: 'authorization_revoked', condition: { broadcaster_user_id: 'b1' } } }));
      await flush();
      expect(logged(logSpy)).toContain('[EventSub-WS] Subscription revoked: stream.offline - authorization_revoked');
      expect(logged(logSpy)).toContain('[EventSub-WS] Removed 1 handler(s) for revoked stream.offline; it will not be re-created');
      expect(registered(client).map(s => s.type)).toEqual(['stream.online']);

      send(ws, offline());
      await flush();
      expect(off).not.toHaveBeenCalled();

      // A new session only re-creates stream.online
      serverClose(ws, 1006);
      mockedPost.mockClear();
      await completeReconnect(1000, 'sess-2');
      expect(mockedPost.mock.calls.map(c => c[1].type)).toEqual(['stream.online']);
    });

    it('only removes the subscription with the revoked id', async () => {
      const { client, ws } = await connected();
      mockedPost.mockResolvedValueOnce(helixOk('t-b1')).mockResolvedValueOnce(helixOk('t-b2'));
      await client.onStreamOffline('b1', jest.fn());
      await client.onStreamOffline('b2', jest.fn());
      send(ws, msg('revocation', { subscription: { id: 't-b2', type: 'stream.offline', status: 'user_removed', condition: { broadcaster_user_id: 'b2' } } }));
      await flush();
      expect(registered(client).map(s => s.twitchId)).toEqual(['t-b1']);
    });

    it('falls back to type + condition when the subscription id is unknown', async () => {
      const { client, ws } = await connected();
      mockedPost.mockResolvedValueOnce({ data: { data: [] } });
      await client.onStreamOffline('b1', jest.fn());
      send(ws, msg('revocation', { subscription: { type: 'stream.offline', status: 'version_removed', condition: { broadcaster_user_id: 'b1' } } }));
      await flush();
      expect(registered(client)).toEqual([]);
    });

    it('tolerates a revocation without a subscription', async () => {
      const { ws } = await connected();
      send(ws, msg('revocation', {}));
      await flush();
      expect(logged(logSpy)).toContain('[EventSub-WS] Subscription revoked: undefined - undefined');
    });
  });

  describe('keepalive', () => {
    it('drops the socket after keepalive_timeout + 1s of silence and reconnects', async () => {
      const { client, ws } = await connected(); // 10s -> 11000ms
      jest.advanceTimersByTime(10999);
      expect(ws.terminate).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(ws.terminate).toHaveBeenCalledTimes(1);
      expect(logged(logSpy)).toContain('[EventSub-WS] Keepalive timeout - reconnecting...');
      expect(client.isConnected()).toBe(false);
      expect(logged(logSpy)).toContain('[EventSub-WS] Scheduling reconnect attempt 1 in 1000ms');

      serverClose(ws, 1006); // the terminate's close event is ignored
      await completeReconnect(1000, 'sess-2');
      expect(sockets()).toHaveLength(2);
      expect(client.isConnected()).toBe(true);
    });

    it('session_keepalive resets the timer', async () => {
      const { ws } = await connected();
      jest.advanceTimersByTime(10000);
      send(ws, keepalive());
      await flush();
      jest.advanceTimersByTime(10000);
      expect(ws.terminate).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1000);
      expect(ws.terminate).toHaveBeenCalledTimes(1);
    });

    it('notifications reset the timer too', async () => {
      const { ws } = await connected();
      jest.advanceTimersByTime(10000);
      send(ws, offline());
      await flush();
      jest.advanceTimersByTime(10000);
      expect(ws.terminate).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1000);
      expect(ws.terminate).toHaveBeenCalledTimes(1);
    });

    it('a reconnect socket that never gets a welcome times out and retries', async () => {
      const { ws } = await connected();
      serverClose(ws, 1006);
      jest.advanceTimersByTime(1000);
      const hung = lastSocket();
      jest.advanceTimersByTime(11000);
      expect(hung.terminate).toHaveBeenCalled();
      expect(logged(logSpy)).toContain('[EventSub-WS] Scheduling reconnect attempt 2 in 2000ms');
      await completeReconnect(2000, 'sess-2');
    });
  });

  describe('reconnect after an unexpected close', () => {
    it('reconnects to the default URL and re-creates every subscription on the new session', async () => {
      const { client, ws } = await connected();
      const cb = jest.fn();
      await client.onStreamOffline('b1', cb);
      await client.onChannelFollow('b1', 'm1', jest.fn());

      serverClose(ws, 4002, 'Failed ping pong');
      expect(logged(logSpy)).toContain('[EventSub-WS] WebSocket closed: 4002 - Failed ping pong');
      expect(logged(logSpy)).toContain('[EventSub-WS] Connection lost - reconnecting...');
      expect(client.isConnected()).toBe(false);
      expect(client.sessionId).toBeNull();

      mockedPost.mockClear();
      jest.advanceTimersByTime(999);
      expect(sockets()).toHaveLength(1);
      const ws2 = await completeReconnect(1, 'sess-2');
      expect(logged(logSpy)).toContain(`[EventSub-WS] Reconnect attempt 1: connecting to ${EVENTSUB_WS_URL}`);
      expect(logged(logSpy)).toContain('[EventSub-WS] Re-creating 2 subscription(s) on session sess-2');
      expect(mockedPost.mock.calls.map(c => [c[1].type, c[1].version, c[1].transport.session_id])).toEqual([
        ['stream.offline', '1', 'sess-2'],
        ['channel.follow', '2', 'sess-2']
      ]);

      send(ws2, offline());
      await flush();
      expect(cb).toHaveBeenCalledTimes(1);
      expect(registered(client)).toHaveLength(2);
    });

    it('logs "No reason" for an empty close reason', async () => {
      const { ws } = await connected();
      serverClose(ws, 1006, '');
      expect(logged(logSpy)).toContain('[EventSub-WS] WebSocket closed: 1006 - No reason');
    });

    it('a socket error followed by close reconnects once', async () => {
      const { ws } = await connected();
      ws.emit('error', new Error('ECONNRESET'));
      expect(logged(errSpy)).toContain('[EventSub-WS] WebSocket error: ECONNRESET');
      expect(jest.getTimerCount()).toBe(1); // still only the keepalive
      serverClose(ws, 1006);
      jest.advanceTimersByTime(1000);
      expect(sockets()).toHaveLength(2);
    });

    it('survives any number of successive drops, including drops of reconnected sockets', async () => {
      const { client, ws } = await connected();
      await client.onStreamOffline('b1', jest.fn());
      let current = ws;
      for (let i = 2; i <= 5; i++) {
        serverClose(current, 1006);
        current = await completeReconnect(1000, `sess-${i}`);
        expect(client.isConnected()).toBe(true);
        expect(client.sessionId).toBe(`sess-${i}`);
      }
      expect(postedSessions()).toEqual(['sess-1', 'sess-2', 'sess-3', 'sess-4', 'sess-5']);
      expect(sockets()).toHaveLength(5);
    });

    it('backs off 1/2/4/8/16/32s, caps at 60s and never gives up', async () => {
      const { client, ws } = await connected();
      serverClose(ws, 1006);
      const delays = [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000];
      for (let i = 0; i < delays.length; i++) {
        jest.advanceTimersByTime(delays[i] - 1);
        expect(sockets()).toHaveLength(1 + i);
        jest.advanceTimersByTime(1);
        expect(sockets()).toHaveLength(2 + i);
        expect(logged(logSpy)).toContain(`[EventSub-WS] Scheduling reconnect attempt ${i + 1} in ${delays[i]}ms`);
        const attempt = lastSocket();
        attempt.emit('error', new Error('ECONNREFUSED'));
        serverClose(attempt, 1006);
      }
      expect(logged(errSpy).some(l => l.includes('Giving up'))).toBe(false);

      // Success resets the backoff
      await completeReconnect(60000, 'sess-x');
      expect(client.isConnected()).toBe(true);
      serverClose(lastSocket(), 1006);
      expect(logged(logSpy)).toContain('[EventSub-WS] Scheduling reconnect attempt 1 in 1000ms');
    });

    it('retries when the WebSocket constructor throws', async () => {
      const { ws } = await connected();
      serverClose(ws, 1006);
      FakeWebSocket.throwOnConstruct = new Error('ctor failed');
      jest.advanceTimersByTime(1000);
      expect(logged(errSpy)).toContain('[EventSub-WS] Failed to initiate reconnect: ctor failed');
      expect(logged(logSpy)).toContain('[EventSub-WS] Scheduling reconnect attempt 2 in 2000ms');
      FakeWebSocket.throwOnConstruct = null;
      await completeReconnect(2000, 'sess-2');
    });

    it('keeps a subscription whose re-creation fails and retries it on the next session', async () => {
      const { client, ws } = await connected();
      await client.onStreamOffline('b1', jest.fn());
      await client.onStreamOnline('b1', jest.fn());
      serverClose(ws, 1006);

      mockedPost.mockReset();
      mockedPost
        .mockRejectedValueOnce(httpError(401, 'Invalid OAuth token'))
        .mockResolvedValue(helixOk());
      const ws2 = await completeReconnect(1000, 'sess-2');
      expect(logged(errSpy)).toContain('[EventSub-WS] Failed to subscribe to stream.offline: Invalid OAuth token');
      expect(postedSessions()).toEqual(['sess-2', 'sess-2']);
      expect(registered(client)).toHaveLength(2);
      expect(registered(client)[0].twitchId).toBeUndefined();

      serverClose(ws2, 1006);
      mockedPost.mockClear();
      await completeReconnect(1000, 'sess-3');
      expect(postedSessions()).toEqual(['sess-3', 'sess-3']);
    });

    it('subscriptions requested while reconnecting are created on the new session', async () => {
      const { client, ws } = await connected();
      serverClose(ws, 1006);
      await expect(client.onStreamOffline('b1', jest.fn())).resolves.toBeUndefined();
      expect(mockedPost).not.toHaveBeenCalled();
      await completeReconnect(1000, 'sess-2');
      expect(postedSessions()).toEqual(['sess-2']);
      expect(registered(client)).toHaveLength(1);
    });

    it('stops re-subscribing on a session that was already replaced', async () => {
      const { client, ws } = await connected();
      await client.onStreamOffline('b1', jest.fn());
      await client.onStreamOnline('b1', jest.fn());
      serverClose(ws, 1006);

      let release!: (v: unknown) => void;
      mockedPost.mockClear();
      mockedPost.mockImplementationOnce(() => new Promise(r => { release = r; }));
      const ws2 = await completeReconnect(1000, 'sess-2');
      serverClose(ws2, 1006); // drops while the first POST is in flight
      release(helixOk());
      await flush();
      expect(postedSessions()).toEqual(['sess-2']);
      await completeReconnect(1000, 'sess-3');
      expect(postedSessions()).toEqual(['sess-2', 'sess-3', 'sess-3']);
    });

    it('logs (no unhandled rejection) when a welcome on a reconnected socket hits an error', async () => {
      const { client, ws } = await connected();
      serverClose(ws, 1006);
      jest.advanceTimersByTime(1000);
      const ws2 = lastSocket();
      jest.spyOn(internals(client), '_handleSessionWelcome').mockRejectedValueOnce(new Error('kaput'));
      send(ws2, welcome('sess-2'));
      await flush();
      expect(logged(errSpy)).toContain('[EventSub-WS] Error handling message: kaput');
    });
  });

  describe('session_reconnect', () => {
    const URL2 = 'wss://eventsub.wss.twitch.tv/ws?id=reconnect';

    it('connects to reconnect_url immediately and swaps sockets on its welcome without re-subscribing', async () => {
      const { client, ws } = await connected();
      const cb = jest.fn();
      await client.onStreamOffline('b1', cb);
      mockedPost.mockClear();

      send(ws, reconnectMsg(URL2));
      await flush();
      expect(client.reconnectUrl).toBe(URL2);
      expect(logged(logSpy)).toContain('[EventSub-WS] Received reconnect URL, connecting before the current connection closes');
      expect(sockets()).toHaveLength(2);
      const ws2 = sockets()[1];
      expect(ws2.url).toBe(URL2);
      expect(client.ws).toBe(ws); // old socket still in charge
      expect(ws.close).not.toHaveBeenCalled();

      // Events still flow on the old socket meanwhile
      send(ws, offline());
      await flush();
      expect(cb).toHaveBeenCalledTimes(1);

      ws2.emit('open');
      expect(logged(logSpy)).toContain('[EventSub-WS] Connected to reconnect URL, waiting for welcome');
      send(ws2, welcome('sess-1'));
      await flush();
      expect(client.ws).toBe(ws2);
      expect(ws.close).toHaveBeenCalledTimes(1);
      expect(client.reconnectUrl).toBeNull();
      expect(client.isConnected()).toBe(true);
      expect(logged(logSpy)).toContain('[EventSub-WS] Reconnected to session sess-1');
      expect(mockedPost).not.toHaveBeenCalled();

      // The old socket's close does not trigger anything
      serverClose(ws, 4004);
      jest.advanceTimersByTime(5000); // within the keepalive window
      expect(sockets()).toHaveLength(2);

      send(ws2, offline());
      await flush();
      expect(cb).toHaveBeenCalledTimes(2);
    });

    it('stays on the old socket if the reconnect_url connection fails, then starts a new session when the old one closes', async () => {
      const { client, ws } = await connected();
      await client.onStreamOffline('b1', jest.fn());
      send(ws, reconnectMsg(URL2));
      await flush();
      const ws2 = sockets()[1];
      ws2.emit('error', new Error('refused'));
      expect(logged(errSpy)).toContain('[EventSub-WS] Reconnect error: refused');
      serverClose(ws2, 1006);
      expect(logged(warnSpy).some(l => l.startsWith('[EventSub-WS] Reconnect URL connection closed before welcome'))).toBe(true);
      expect(client.ws).toBe(ws);
      expect(client.isConnected()).toBe(true);

      serverClose(ws, 4004);
      mockedPost.mockClear();
      await completeReconnect(1000, 'sess-2');
      expect(postedSessions()).toEqual(['sess-2']);
    });

    it('continues on the new socket when the old one closes before the welcome arrives', async () => {
      const { client, ws } = await connected();
      await client.onStreamOffline('b1', jest.fn());
      mockedPost.mockClear();
      send(ws, reconnectMsg(URL2));
      await flush();
      const ws2 = sockets()[1];
      serverClose(ws, 4004);
      expect(client.ws).toBe(ws2);
      expect(logged(logSpy)).toContain('[EventSub-WS] Previous connection closed; continuing on reconnect URL connection');
      jest.advanceTimersByTime(5000);
      expect(sockets()).toHaveLength(2); // no new-session reconnect
      send(ws2, welcome('sess-1'));
      await flush();
      expect(client.isConnected()).toBe(true);
      expect(mockedPost).not.toHaveBeenCalled();
    });

    it('a second session_reconnect replaces a pending reconnect socket', async () => {
      const { client, ws } = await connected();
      send(ws, reconnectMsg('wss://r1'));
      await flush();
      const first = sockets()[1];
      send(ws, reconnectMsg('wss://r2'));
      await flush();
      expect(first.close).toHaveBeenCalled();
      const second = sockets()[2];
      expect(second.url).toBe('wss://r2');
      serverClose(first, 1000); // ignored
      expect(client.ws).toBe(ws);
      send(second, welcome('sess-1'));
      await flush();
      expect(client.ws).toBe(second);
    });

    it('works repeatedly, including from sockets that were themselves reconnects', async () => {
      const { client, ws } = await connected();
      await client.onStreamOffline('b1', jest.fn());
      mockedPost.mockClear();

      let current = ws;
      for (let i = 1; i <= 3; i++) {
        send(current, reconnectMsg(`wss://hop-${i}`));
        await flush();
        const next = lastSocket();
        send(next, welcome('sess-1'));
        await flush();
        expect(client.ws).toBe(next);
        expect(current.close).toHaveBeenCalled();
        current = next;
      }
      expect(mockedPost).not.toHaveBeenCalled();

      // ... and a plain drop afterwards still starts a new session
      serverClose(current, 1006);
      await completeReconnect(1000, 'sess-2');
      expect(postedSessions()).toEqual(['sess-2']);
    });

    it('ignores a session_reconnect without a URL', async () => {
      const { ws } = await connected();
      send(ws, reconnectMsg(null));
      await flush();
      expect(logged(warnSpy)).toContain('[EventSub-WS] session_reconnect without reconnect_url; ignoring');
      expect(sockets()).toHaveLength(1);
    });

    it('stays on the old socket when the reconnect socket cannot be created', async () => {
      const { client, ws } = await connected();
      FakeWebSocket.throwOnConstruct = new Error('ctor failed');
      send(ws, reconnectMsg(URL2));
      await flush();
      expect(logged(errSpy)).toContain('[EventSub-WS] Failed to initiate reconnect: ctor failed');
      expect(client.ws).toBe(ws);
      expect(client.isConnected()).toBe(true);
    });
  });

  describe('stop()', () => {
    it('closes the socket, clears the keepalive and session', async () => {
      const { client, ws } = await connected();
      client.stop();
      expect(ws.close).toHaveBeenCalledTimes(1);
      expect(client.ws).toBeNull();
      expect(client.sessionId).toBeNull();
      expect(client.isConnected()).toBe(false);
      expect(client.keepaliveTimeout).toBeNull();
      expect(jest.getTimerCount()).toBe(0);
    });

    it('is safe before start()', () => {
      const c = make();
      expect(() => c.stop()).not.toThrow();
      expect(c.isConnected()).toBe(false);
    });

    it('the close event after stop() does not reconnect', async () => {
      const { client, ws } = await connected();
      client.stop();
      serverClose(ws, 1005);
      jest.advanceTimersByTime(60 * 60 * 1000);
      expect(sockets()).toHaveLength(1);
      expect(logged(logSpy)).not.toContain('[EventSub-WS] Connection lost - reconnecting...');
    });

    it('cancels a pending reconnect during backoff', async () => {
      const { client, ws } = await connected();
      serverClose(ws, 1006);
      expect(jest.getTimerCount()).toBe(1);
      client.stop();
      expect(jest.getTimerCount()).toBe(0);
      jest.advanceTimersByTime(60 * 60 * 1000);
      expect(sockets()).toHaveLength(1);
    });

    it('closes a pending session_reconnect socket too, and its later events are ignored', async () => {
      const { client, ws } = await connected();
      send(ws, reconnectMsg('wss://next'));
      await flush();
      const ws2 = sockets()[1];
      client.stop();
      expect(ws.close).toHaveBeenCalled();
      expect(ws2.close).toHaveBeenCalled();
      send(ws2, welcome('sess-1'));
      serverClose(ws, 4004);
      serverClose(ws2, 1000);
      await flush();
      jest.advanceTimersByTime(60 * 60 * 1000);
      expect(client.ws).toBeNull();
      expect(client.isConnected()).toBe(false);
      expect(sockets()).toHaveLength(2);
    });

    it('subscriptions after stop() are queued and created by the next start()', async () => {
      const { client } = await connected();
      await client.onStreamOnline('b1', jest.fn());
      client.stop();
      await expect(client.onStreamOffline('b1', jest.fn())).resolves.toBeUndefined();
      mockedPost.mockClear();

      const restarted = client.start();
      send(lastSocket(), welcome('sess-9'));
      await restarted;
      expect(mockedPost.mock.calls.map(c => [c[1].type, c[1].transport.session_id])).toEqual([
        ['stream.online', 'sess-9'],
        ['stream.offline', 'sess-9']
      ]);
      expect(registered(client)).toHaveLength(2);
    });
  });
});

// ---------- real ws server ----------

describe('TwitchEventSubWS against a local ws server', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const RealWs = jest.requireActual('ws') as typeof import('ws');
  let servers: import('ws').WebSocketServer[] = [];

  async function listen() {
    const wss = new RealWs.WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>(r => wss.once('listening', () => r()));
    servers.push(wss);
    const { port } = wss.address() as { port: number };
    const nextSocket = () => new Promise<import('ws').WebSocket>(r => wss.once('connection', s => r(s)));
    return { wss, url: `ws://127.0.0.1:${port}/ws`, nextSocket };
  }
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

  beforeEach(() => {
    jest.useRealTimers();
  });

  afterEach(async () => {
    await Promise.all(servers.map(s => new Promise(r => {
      s.clients.forEach(c => c.terminate());
      s.close(r);
    })));
    servers = [];
  });

  it('welcome, subscribe, notify, session_reconnect, then a drop and a fresh session', async () => {
    const main = await listen();
    const migrate = await listen();
    // Route the hard-coded Twitch URL to the main local server
    (globalThis as any).__WsImpl = class extends RealWs.WebSocket {
      constructor(url: string) {
        super(url === EVENTSUB_WS_URL ? main.url : url);
      }
    };

    const client = make();
    const conn1 = main.nextSocket();
    const started = client.start();
    const s1 = await conn1;
    s1.send(JSON.stringify(welcome('real-1', 10)));
    await started;
    expect(client.isConnected()).toBe(true);

    const events: unknown[] = [];
    await client.onStreamOnline('b1', ev => { events.push(ev); });
    const online = (id: string) => JSON.stringify(notification('stream.online', { broadcaster_user_id: 'b1' }, {
      broadcaster_user_id: 'b1', broadcaster_user_login: 'bee', broadcaster_user_name: 'Bee', type: 'live', started_at: '2026-01-01T00:00:00Z'
    }, id));
    s1.send(online('n1'));
    await wait(50);
    expect(events).toHaveLength(1);

    // session_reconnect: the client connects immediately, old socket closed after the welcome
    const conn2 = migrate.nextSocket();
    s1.send(JSON.stringify(reconnectMsg(migrate.url)));
    const s2 = await conn2;
    const s1Closed = new Promise(r => s1.once('close', r));
    s2.send(JSON.stringify(welcome('real-1', 10)));
    await s1Closed;
    expect(mockedPost).toHaveBeenCalledTimes(1);
    s2.send(online('n2'));
    s2.send(online('n2')); // duplicate
    await wait(50);
    expect(events).toHaveLength(2);

    // Drop: a fresh session on the default URL re-creates the subscription
    const conn3 = main.nextSocket();
    s2.terminate();
    const s3 = await conn3; // after the 1s backoff
    s3.send(JSON.stringify(welcome('real-2', 10)));
    await wait(100);
    expect(client.sessionId).toBe('real-2');
    expect(postedSessions()).toEqual(['real-1', 'real-2']);
    s3.send(online('n3'));
    await wait(50);
    expect(events).toHaveLength(3);

    const closed = new Promise(r => s3.once('close', r));
    const clientWs = client.ws as unknown as EventEmitter;
    const clientClosed = new Promise(r => clientWs.once('close', r));
    client.stop();
    await Promise.all([closed, clientClosed]);
    await wait(1200);
    expect(main.wss.clients.size).toBe(0);
    expect(client.isConnected()).toBe(false);
  }, 10000);
});
