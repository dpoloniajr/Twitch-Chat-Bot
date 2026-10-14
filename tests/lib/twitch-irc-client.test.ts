/**
 * Tests for src/lib/twitch-irc-client.ts: the tmi.js wrapper the bot uses as
 * global.chatClient. tmi.js is replaced by an EventEmitter fake so the tests can
 * drive 'message' / 'connected' / 'disconnected' events directly.
 */

import { EventEmitter } from 'events';
import { TwitchIRCClient, ChatMessage } from '../../src/lib/twitch-irc-client';

interface FakeOptions {
  options: { debug: boolean };
  identity: { username?: string; password: string };
  channels: string[];
}

class FakeTmiClient extends EventEmitter {
  opts: FakeOptions;
  connect = jest.fn(async () => {
    this.emit('connected', 'irc-ws.chat.twitch.tv', 443);
    return ['irc-ws.chat.twitch.tv', 443];
  });
  disconnect = jest.fn(async () => {
    this.emit('disconnected', 'Connection closed.');
    return ['irc-ws.chat.twitch.tv', 443];
  });
  say = jest.fn(async (channel: string) => [channel]);
  action = jest.fn(async (channel: string) => [channel]);
  join = jest.fn(async (channel: string) => [channel]);
  part = jest.fn(async (channel: string) => [channel]);

  constructor(opts: FakeOptions) {
    super();
    this.opts = opts;
    fakeClients.push(this);
  }
}

const fakeClients: FakeTmiClient[] = [];

jest.mock('tmi.js', () => ({
  Client: jest.fn((opts: FakeOptions) => new FakeTmiClient(opts))
}));

function lastFake(): FakeTmiClient {
  return fakeClients[fakeClients.length - 1];
}

function newClient(overrides: Record<string, unknown> = {}) {
  return new TwitchIRCClient({ username: 'excellabot', accessToken: 'tok123', channels: ['#mychannel'], ...overrides });
}

async function connected(overrides: Record<string, unknown> = {}) {
  const client = newClient(overrides);
  await client.connect();
  return { client, fake: lastFake() };
}

/** Emit a chat message and capture what the registered handler receives */
function receive(fake: FakeTmiClient, client: TwitchIRCClient, tags: Record<string, unknown>, text = 'hello', self = false) {
  const handler = jest.fn();
  client.onMessage(handler);
  fake.emit('message', '#mychannel', tags, text, self);
  return handler;
}

const flush = () => new Promise(resolve => setImmediate(resolve));

let errorSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;

beforeEach(() => {
  fakeClients.length = 0;
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});

describe('constructor', () => {
  it('stores options (channels without #) and starts disconnected with no tmi client', () => {
    const client = newClient({ channels: ['#mychannel', 'other'] });
    expect(client.username).toBe('excellabot');
    expect(client.accessToken).toBe('tok123');
    expect(client.channels).toEqual(['mychannel', 'other']);
    expect(client.client).toBeNull();
    expect(client.isConnected()).toBe(false);
    expect(fakeClients).toHaveLength(0);
  });

  it('defaults to no options', () => {
    const client = new TwitchIRCClient();
    expect(client.username).toBeUndefined();
    expect(client.accessToken).toBeUndefined();
    expect(client.channels).toEqual([]);
  });
});

describe('connect / disconnect', () => {
  it('creates the tmi client with oauth password and channels without #', async () => {
    const { client, fake } = await connected({ channels: ['#a', 'b'] });
    expect(fake.opts).toEqual({
      options: { debug: false },
      identity: { username: 'excellabot', password: 'oauth:tok123' },
      channels: ['a', 'b']
    });
    expect(fake.connect).toHaveBeenCalledTimes(1);
    expect(client.isConnected()).toBe(true);
  });

  it('does not double the oauth: prefix', async () => {
    const { fake } = await connected({ accessToken: 'oauth:abc' });
    expect(fake.opts.identity.password).toBe('oauth:abc');
  });

  it('resolves true and reuses an existing tmi client', async () => {
    const client = newClient();
    await expect(client.connect()).resolves.toBe(true);
    await expect(client.connect()).resolves.toBe(true);
    expect(fakeClients).toHaveLength(1);
    expect(lastFake().connect).toHaveBeenCalledTimes(2);
  });

  it('runs connect handlers, isolating handler errors', async () => {
    const client = newClient();
    const bad = jest.fn(() => { throw new Error('boom'); });
    const good = jest.fn();
    client.onConnect(bad);
    client.onConnect(good);
    await client.connect();
    expect(bad).toHaveBeenCalledWith();
    expect(good).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('Error in connect handler:', 'boom');
  });

  it('logs and rethrows when tmi connect fails', async () => {
    const client = newClient();
    client._createClient();
    const fake = lastFake();
    const err = new Error('Login authentication failed');
    fake.connect.mockRejectedValueOnce(err);
    await expect(client.connect()).rejects.toBe(err);
    expect(errorSpy).toHaveBeenCalledWith('Failed to connect to Twitch IRC:', 'Login authentication failed');
    expect(client.isConnected()).toBe(false);
  });

  it('rejects with a clear, logged error when there is no access token', async () => {
    const client = new TwitchIRCClient({ username: 'x' });
    await expect(client.connect()).rejects.toThrow('Cannot create Twitch IRC client: no access token');
    expect(errorSpy).toHaveBeenCalledWith('Failed to connect to Twitch IRC:', 'Cannot create Twitch IRC client: no access token');
    expect(fakeClients).toHaveLength(0);
    expect(client.isConnected()).toBe(false);
  });

  it('rejects for an empty access token too', async () => {
    const client = new TwitchIRCClient({ username: 'x', accessToken: '' });
    await expect(client.connect()).rejects.toThrow('no access token');
    expect(fakeClients).toHaveLength(0);
  });

  it('disconnect calls tmi and clears the connected flag', async () => {
    const { client, fake } = await connected();
    await client.disconnect();
    expect(fake.disconnect).toHaveBeenCalledTimes(1);
    expect(client.isConnected()).toBe(false);
  });

  it('disconnect without a client just clears the flag', async () => {
    const client = newClient();
    await expect(client.disconnect()).resolves.toBeUndefined();
    expect(client.isConnected()).toBe(false);
  });

  it('disconnect on a socket that is not open resolves and clears the flag', async () => {
    const { client, fake } = await connected();
    // tmi.js rejects with a plain string here
    fake.disconnect.mockRejectedValueOnce('Cannot disconnect from server. Socket is not opened or connection is already closing.');
    await expect(client.disconnect()).resolves.toBeUndefined();
    expect(client.isConnected()).toBe(false);
    expect(logSpy).toHaveBeenCalledWith('IRC client already disconnected:',
      'Cannot disconnect from server. Socket is not opened or connection is already closing.');
  });

  it('disconnect of a client that never connected resolves', async () => {
    const client = newClient();
    client._createClient();
    lastFake().disconnect.mockRejectedValueOnce(new Error('Socket is not opened'));
    await expect(client.disconnect()).resolves.toBeUndefined();
    expect(client.isConnected()).toBe(false);
  });

  it('reports manually=true for a disconnect() call and false again after reconnecting', async () => {
    const { client, fake } = await connected();
    const handler = jest.fn();
    client.onDisconnect(handler);
    await client.disconnect();
    expect(handler).toHaveBeenLastCalledWith(true, expect.any(Error));

    await client.connect();
    fake.emit('disconnected', 'Ping timeout');
    expect(handler).toHaveBeenLastCalledWith(false, expect.any(Error));
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('disconnected event calls handlers with (false, Error(reason))', async () => {
    const { client, fake } = await connected();
    const handler = jest.fn();
    client.onDisconnect(handler);
    fake.emit('disconnected', 'Ping timeout');
    expect(client.isConnected()).toBe(false);
    expect(handler).toHaveBeenCalledWith(false, expect.any(Error));
    expect(handler.mock.calls[0][1].message).toBe('Ping timeout');
  });

  it('disconnected event with empty reason passes null, and isolates handler errors', async () => {
    const { client, fake } = await connected();
    const bad = jest.fn(() => { throw new Error('nope'); });
    const good = jest.fn();
    client.onDisconnect(bad);
    client.onDisconnect(good);
    fake.emit('disconnected', '');
    expect(good).toHaveBeenCalledWith(false, null);
    expect(errorSpy).toHaveBeenCalledWith('Error in disconnect handler:', 'nope');
  });

  it('tracks tmi auto-reconnect via connected/disconnected events', async () => {
    const { client, fake } = await connected();
    const onConnect = jest.fn();
    client.onConnect(onConnect);
    fake.emit('disconnected', 'Connection closed.');
    expect(client.isConnected()).toBe(false);
    fake.emit('connected', 'irc-ws.chat.twitch.tv', 443);
    expect(client.isConnected()).toBe(true);
    expect(onConnect).toHaveBeenCalledTimes(1);
  });
});

describe('message translation', () => {
  const fullTags = {
    username: 'viewer1',
    'display-name': 'Viewer1',
    'user-id': '12345',
    mod: true,
    subscriber: true,
    badges: { broadcaster: '1', vip: '1', subscriber: '12' },
    'badge-info': { subscriber: '14' },
    color: '#FF0000',
    id: 'msg-id-1',
    'room-id': '999',
    emotes: { '25': ['6-10'] },
    'first-msg': true,
    'returning-chatter': true
  };

  it('builds the Twurple-compatible msg object Excella.js reads', async () => {
    const { client, fake } = await connected();
    const handler = receive(fake, client, fullTags, 'hello Kappa');
    expect(handler).toHaveBeenCalledTimes(1);
    const [channel, user, text, msg] = handler.mock.calls[0] as [string, string, string, ChatMessage];
    expect(channel).toBe('mychannel');
    expect(user).toBe('viewer1');
    expect(text).toBe('hello Kappa');
    expect(msg).toEqual({
      userInfo: {
        userName: 'viewer1',
        displayName: 'Viewer1',
        userId: '12345',
        isMod: true,
        isBroadcaster: true,
        isSubscriber: true,
        isVip: true,
        color: '#FF0000',
        badges: { broadcaster: '1', vip: '1', subscriber: '12' },
        badgeInfo: { subscriber: '14' }
      },
      id: 'msg-id-1',
      channelId: '999',
      emotes: [{ id: '25', start: 6, end: 10 }],
      isFirst: true,
      isReturningChatter: true
    });
  });

  it('defaults flags and collections for a plain chatter', async () => {
    const { client, fake } = await connected();
    const handler = receive(fake, client, { username: 'lurker' });
    const msg: ChatMessage = handler.mock.calls[0][3];
    expect(msg.userInfo).toEqual({
      userName: 'lurker',
      displayName: 'lurker',
      userId: undefined,
      isMod: false,
      isBroadcaster: false,
      isSubscriber: false,
      isVip: false,
      color: undefined,
      badges: {},
      badgeInfo: {}
    });
    expect(msg.emotes).toEqual([]);
    expect(msg.isFirst).toBe(false);
    expect(msg.isReturningChatter).toBe(false);
  });

  it('treats non-"1" broadcaster/vip badge values as false', async () => {
    const { client, fake } = await connected();
    const handler = receive(fake, client, { username: 'u', badges: { broadcaster: '0', vip: '2' }, mod: false, subscriber: false });
    const msg: ChatMessage = handler.mock.calls[0][3];
    expect(msg.userInfo.isBroadcaster).toBe(false);
    expect(msg.userInfo.isVip).toBe(false);
    expect(msg.userInfo.isMod).toBe(false);
    expect(msg.userInfo.isSubscriber).toBe(false);
  });

  it('passes a raw first-msg tag value through unchanged', async () => {
    const { client, fake } = await connected();
    const handler = receive(fake, client, { username: 'u', 'first-msg': '1' });
    expect(handler.mock.calls[0][3].isFirst).toBe('1');
  });

  it('ignores messages from the bot itself', async () => {
    const { client, fake } = await connected();
    const handler = receive(fake, client, fullTags, 'echo', true);
    expect(handler).not.toHaveBeenCalled();
  });

  it('calls every handler and isolates handler errors', async () => {
    const { client, fake } = await connected();
    const bad = jest.fn(() => { throw new Error('handler broke'); });
    client.onMessage(bad);
    const good = receive(fake, client, { username: 'u' });
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('Error in message handler:', 'handler broke');
  });

  it('keeps channel names that have no # prefix', async () => {
    const { client, fake } = await connected();
    const handler = jest.fn();
    client.onMessage(handler);
    fake.emit('message', 'plainchannel', { username: 'u' }, 'hi', false);
    expect(handler.mock.calls[0][0]).toBe('plainchannel');
  });
});

describe('_parseEmotes', () => {
  const client = new TwitchIRCClient();

  it('returns [] for empty input', () => {
    expect(client._parseEmotes(undefined)).toEqual([]);
    expect(client._parseEmotes(null)).toEqual([]);
    expect(client._parseEmotes('')).toEqual([]);
  });

  it('parses the object format sorted by start', () => {
    expect(client._parseEmotes({ '25': ['12-16', '0-4'], '26': ['5-9'] })).toEqual([
      { id: '25', start: 0, end: 4 },
      { id: '26', start: 5, end: 9 },
      { id: '25', start: 12, end: 16 }
    ]);
  });

  it('parses the raw string format', () => {
    expect(client._parseEmotes('25:0-4,12-16/26:5-9')).toEqual([
      { id: '25', start: 0, end: 4 },
      { id: '26', start: 5, end: 9 },
      { id: '25', start: 12, end: 16 }
    ]);
  });

  it('skips malformed string pairs and positions', () => {
    expect(client._parseEmotes('25:/:1-2/26:abc,3-4/27')).toEqual([{ id: '26', start: 3, end: 4 }]);
    expect(client._parseEmotes({ '25': ['x-y', '7', '1-2'] })).toEqual([{ id: '25', start: 1, end: 2 }]);
  });

  it('ignores non-array positions and non-plain objects', () => {
    expect(client._parseEmotes({ '25': '0-4' })).toEqual([]);
    expect(client._parseEmotes(new Date())).toEqual([]);
    expect(client._parseEmotes(/re/)).toEqual([]);
    expect(client._parseEmotes(42)).toEqual([]);
  });

  it('skips non-string positions instead of throwing', () => {
    expect(client._parseEmotes({ '25': [5, null, { a: 1 }, '1-2'] })).toEqual([{ id: '25', start: 1, end: 2 }]);
  });

  it('still delivers a message whose emote tag has non-string positions', async () => {
    const { client, fake } = await connected();
    const handler = receive(fake, client, { username: 'u', emotes: { '25': [5] } });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][3].emotes).toEqual([]);
  });
});

describe('say / action', () => {
  it('say strips # and sends', async () => {
    const { client, fake } = await connected();
    client.say('#mychannel', 'hi');
    expect(fake.say).toHaveBeenCalledWith('mychannel', 'hi');
  });

  it('say logs and drops when not connected', async () => {
    const client = newClient();
    client.say('#c', 'hi');
    expect(errorSpy).toHaveBeenCalledWith('Cannot send message: not connected');

    await client.connect();
    lastFake().emit('disconnected', 'gone');
    client.say('#c', 'hi');
    expect(lastFake().say).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it('say logs a send failure without throwing', async () => {
    const { client, fake } = await connected();
    fake.say.mockRejectedValueOnce(new Error('No response from Twitch.'));
    expect(() => client.say('c', 'hi')).not.toThrow();
    await flush();
    expect(errorSpy).toHaveBeenCalledWith('Failed to send message to c:', 'No response from Twitch.');
  });

  it('action strips # and sends', async () => {
    const { client, fake } = await connected();
    client.action('#mychannel', 'waves');
    expect(fake.action).toHaveBeenCalledWith('mychannel', 'waves');
  });

  it('action logs and drops when not connected, like say', async () => {
    const client = newClient();
    client.action('#c', 'waves');
    expect(errorSpy).toHaveBeenCalledWith('Cannot send action: not connected');

    await client.connect();
    lastFake().emit('disconnected', 'gone');
    client.action('#c', 'waves');
    expect(lastFake().action).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it('action logs a send failure without throwing', async () => {
    const { client, fake } = await connected();
    fake.action.mockRejectedValueOnce(new Error('rate limited'));
    client.action('#c', 'waves');
    await flush();
    expect(errorSpy).toHaveBeenCalledWith('Failed to send action to c:', 'rate limited');
  });
});

describe('join / part', () => {
  it('are no-ops before a client exists', async () => {
    const client = newClient();
    await client.join('#other');
    await client.part('#mychannel');
    expect(client.channels).toEqual(['mychannel']);
  });

  it('join does not duplicate a channel given to the constructor with #', async () => {
    const { client } = await connected();
    await client.join('mychannel');
    await client.join('#mychannel');
    expect(client.channels).toEqual(['mychannel']);
  });

  it('part removes a channel given to the constructor with #', async () => {
    const { client } = await connected();
    await client.part('mychannel');
    expect(client.channels).toEqual([]);
  });

  it('join adds the channel once and calls tmi', async () => {
    const { client, fake } = await connected({ channels: [] });
    await client.join('#other');
    await client.join('other');
    expect(client.channels).toEqual(['other']);
    expect(fake.join).toHaveBeenCalledWith('other');
    expect(fake.join).toHaveBeenCalledTimes(2);
  });

  it('join logs tmi failures', async () => {
    const { client, fake } = await connected();
    fake.join.mockRejectedValueOnce(new Error('msg_channel_suspended'));
    await expect(client.join('bad')).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith('Failed to join bad:', 'msg_channel_suspended');
  });

  it('part removes the channel and calls tmi', async () => {
    const { client, fake } = await connected({ channels: ['a', 'b'] });
    await client.part('#a');
    expect(client.channels).toEqual(['b']);
    expect(fake.part).toHaveBeenCalledWith('a');
  });

  it('part logs tmi failures', async () => {
    const { client, fake } = await connected();
    fake.part.mockRejectedValueOnce(new Error('timeout'));
    await expect(client.part('x')).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith('Failed to part x:', 'timeout');
  });
});

describe('updateToken', () => {
  it('only stores the token when not connected', async () => {
    const client = newClient();
    await client.updateToken('new');
    expect(client.accessToken).toBe('new');
    expect(fakeClients).toHaveLength(0);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('gives an existing disconnected client the new password for its next (re)connect', async () => {
    const { client, fake } = await connected();
    fake.emit('disconnected', 'Ping timeout');
    await client.updateToken('new');
    // tmi.js is auto-reconnecting this client; it is kept, but now logs in with the new token
    expect(fakeClients).toHaveLength(1);
    expect(fake.opts.identity.password).toBe('oauth:new');
    await client.connect();
    expect(lastFake()).toBe(fake);
    expect(client.isConnected()).toBe(true);
    expect(logSpy).not.toHaveBeenCalledWith('Token updated - reconnecting IRC client...');
  });

  it('gives a manually disconnected client the new password for a later connect()', async () => {
    const { client, fake } = await connected();
    await client.disconnect();
    await client.updateToken('oauth:later');
    expect(fake.opts.identity.password).toBe('oauth:later');
    expect(fake.connect).toHaveBeenCalledTimes(1);
  });

  it('reconnects with a fresh tmi client using the new token', async () => {
    const { client, fake } = await connected();
    const onMessage = jest.fn();
    const onConnect = jest.fn();
    const onDisconnect = jest.fn();
    client.onMessage(onMessage);
    client.onConnect(onConnect);
    client.onDisconnect(onDisconnect);

    await client.updateToken('oauth:fresh');

    expect(fake.disconnect).toHaveBeenCalledTimes(1);
    expect(fakeClients).toHaveLength(2);
    const fresh = lastFake();
    expect(client.client).toBe(fresh);
    expect(fresh.opts.identity.password).toBe('oauth:fresh');
    expect(fresh.connect).toHaveBeenCalledTimes(1);
    expect(client.isConnected()).toBe(true);
    // Closing the replaced client is not reported as a disconnect
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenNthCalledWith(1, 'Token updated - reconnecting IRC client...');
    expect(logSpy).toHaveBeenNthCalledWith(2, 'IRC client reconnected with new token');

    // Handlers registered before the swap receive messages from the new client
    fresh.emit('message', '#mychannel', { username: 'u' }, 'after', false);
    expect(onMessage).toHaveBeenCalledWith('mychannel', 'u', 'after', expect.any(Object));

    // The replaced client is detached: its events no longer reach the handlers
    expect(fake.listenerCount('message')).toBe(0);
    expect(fake.listenerCount('connected')).toBe(0);
    expect(fake.listenerCount('disconnected')).toBe(0);
    fake.emit('message', '#mychannel', { username: 'ghost' }, 'stale', false);
    fake.emit('disconnected', 'late close');
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(client.isConnected()).toBe(true);
  });

  it('logs and rethrows when the reconnect fails', async () => {
    const { client } = await connected();
    const TmiClient = jest.requireMock('tmi.js').Client as jest.Mock;
    TmiClient.mockImplementationOnce((opts: FakeOptions) => {
      const f = new FakeTmiClient(opts);
      f.connect.mockRejectedValueOnce(new Error('Login authentication failed'));
      return f;
    });

    await expect(client.updateToken('bad')).rejects.toThrow('Login authentication failed');
    expect(errorSpy).toHaveBeenCalledWith('Failed to connect to Twitch IRC:', 'Login authentication failed');
    expect(errorSpy).toHaveBeenCalledWith('Failed to reconnect IRC client with new token:', 'Login authentication failed');
    expect(client.isConnected()).toBe(false);
    expect(logSpy).not.toHaveBeenCalledWith('IRC client reconnected with new token');
  });

  it('still reconnects with the new token when closing the old client fails', async () => {
    const { client, fake } = await connected();
    fake.disconnect.mockRejectedValueOnce(new Error('Socket is not opened'));
    await expect(client.updateToken('new')).resolves.toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith('IRC client already disconnected:', 'Socket is not opened');
    expect(fakeClients).toHaveLength(2);
    expect(lastFake().opts.identity.password).toBe('oauth:new');
    expect(client.isConnected()).toBe(true);
  });
});
