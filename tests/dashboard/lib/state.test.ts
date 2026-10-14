/**
 * Tests for src/dashboard/lib/state.ts, plus the small constants and middleware modules.
 */

import WebSocket from 'ws';
import type { Request, Response, NextFunction } from 'express';

type StateModule = typeof import('../../../src/dashboard/lib/state');

/** Load a fresh copy of the state singleton */
function loadState(): StateModule {
  let mod!: StateModule;
  jest.isolateModules(() => {
    mod = require('../../../src/dashboard/lib/state');
  });
  return mod;
}

function fakeClient(readyState: number) {
  return { readyState, send: jest.fn() };
}

function fakeServer(clients: Array<ReturnType<typeof fakeClient>>): WebSocket.Server {
  return { clients: new Set(clients) } as unknown as WebSocket.Server;
}

describe('dashboard state', () => {
  it('starts with the default bot state and chat filters', () => {
    const state = loadState();
    expect(state.getBotState()).toEqual({
      isConnected: false,
      channels: [],
      broadcasterName: '',
      uptime: 0,
      commandsExecuted: 0,
      lastCommand: null,
      commands: [
        { name: '!clip', description: 'Create a clip of the stream' },
        { name: '!followage [username]', description: 'Check how long someone has been following' },
        { name: '!shoutout [username]', description: 'Shout out another streamer (mods only)' },
        { name: '!commands', description: 'Show available commands' }
      ]
    });
    expect(state.getChatFilters()).toEqual({
      blacklistWords: [],
      filterUrls: false,
      filterAllCaps: false,
      filterRepeatChars: false,
      filterSpam: false,
      timeoutDurationSeconds: 60,
      filterAction: 'warn'
    });
  });

  it('broadcastState is a no-op before init', () => {
    const state = loadState();
    expect(() => state.broadcastState({ type: 'x', data: 1 })).not.toThrow();
  });

  it('broadcastState sends JSON only to open clients', () => {
    const state = loadState();
    const open = fakeClient(WebSocket.OPEN);
    const connecting = fakeClient(WebSocket.CONNECTING);
    const closed = fakeClient(WebSocket.CLOSED);
    state.init(fakeServer([open, connecting, closed]));
    state.broadcastState({ type: 'log', data: { a: 1 } });
    expect(open.send).toHaveBeenCalledWith('{"type":"log","data":{"a":1}}');
    expect(connecting.send).not.toHaveBeenCalled();
    expect(closed.send).not.toHaveBeenCalled();
  });

  it('updateBotState merges into a new object, broadcasts and returns it', () => {
    const state = loadState();
    const client = fakeClient(WebSocket.OPEN);
    state.init(fakeServer([client]));
    const before = state.getBotState();
    const after = state.updateBotState({ isConnected: true, channels: ['#chan'], extra: 'kept' });
    expect(after).not.toBe(before);
    expect(after).toBe(state.getBotState());
    expect(after).toMatchObject({ isConnected: true, channels: ['#chan'], extra: 'kept', uptime: 0 });
    expect(before.isConnected).toBe(false);
    expect(JSON.parse(client.send.mock.calls[0][0])).toEqual({ type: 'state', data: after });
  });

  it('updateChatFilters merges, broadcasts and returns the filters', () => {
    const state = loadState();
    const client = fakeClient(WebSocket.OPEN);
    state.init(fakeServer([client]));
    const result = state.updateChatFilters({ blacklistWords: ['bad'], filterAction: 'timeout' });
    expect(result).toBe(state.getChatFilters());
    expect(result).toMatchObject({ blacklistWords: ['bad'], filterAction: 'timeout', filterUrls: false });
    expect(JSON.parse(client.send.mock.calls[0][0])).toEqual({ type: 'filters', data: result });
  });
});

describe('dashboard constants', () => {
  it('exports the alert config, upload limits and MIME signatures', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const constants = require('../../../src/dashboard/lib/constants');
    expect(Object.keys(constants).filter(k => k !== '__esModule').sort()).toEqual([
      'ANIMATIONS',
      'DEFAULT_ALERT_CONFIG',
      'DEFAULT_BUILTIN_COMMANDS',
      'MIME_SIGNATURES',
      'SUPPORTED_AUDIO_TYPES',
      'SUPPORTED_IMAGE_TYPES',
      'SUPPORTED_VIDEO_TYPES',
      'TTS_VOICES',
      'UPLOAD_LIMIT_COUNT',
      'UPLOAD_LIMIT_WINDOW'
    ]);
    expect(constants.UPLOAD_LIMIT_COUNT).toBe(10);
    expect(constants.UPLOAD_LIMIT_WINDOW).toBe(60000);
    expect(Object.keys(constants.DEFAULT_ALERT_CONFIG.alertTypes)).toEqual([
      'follow', 'subscription', 'bits', 'raid', 'redemption', 'first_chatter'
    ]);
    // Default built-in commands: unique names, every one with a cooldown, description and permission
    const names = constants.DEFAULT_BUILTIN_COMMANDS.map((c: { name: string }) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(['!clip', '!followage', '!8ball', '!hype', '!shoutout', '!unblocksong']));
    for (const c of constants.DEFAULT_BUILTIN_COMMANDS) {
      expect(c).toEqual({ name: expect.stringMatching(/^!/), cooldownSeconds: expect.any(Number), description: expect.any(String), permission: expect.any(String) });
    }
    // Every supported upload type has a signature
    for (const ext of [...constants.SUPPORTED_IMAGE_TYPES, ...constants.SUPPORTED_VIDEO_TYPES, ...constants.SUPPORTED_AUDIO_TYPES]) {
      expect(constants.MIME_SIGNATURES[ext]).toEqual(expect.any(Array));
    }
  });
});

describe('dashboard errorHandler', () => {
  function run(err: Error & { statusCode?: number }) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { errorHandler } = require('../../../src/dashboard/lib/middleware');
    const json = jest.fn();
    const res = { status: jest.fn(() => ({ json })) } as unknown as Response;
    errorHandler(err, {} as Request, res, jest.fn() as unknown as NextFunction);
    return { status: (res.status as jest.Mock).mock.calls[0][0], body: json.mock.calls[0][0] };
  }

  it('sends 500 and logs the stack for errors without a status', () => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    const err = new Error('kaboom');
    expect(run(err)).toEqual({ status: 500, body: { success: false, error: 'kaboom' } });
    expect(log).toHaveBeenCalledWith('API Error:', err.stack);
  });

  it('logs explicit 500s and defaults an empty message', () => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    const err = Object.assign(new Error(''), { statusCode: 500 });
    expect(run(err)).toEqual({ status: 500, body: { success: false, error: 'Internal Server Error' } });
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('uses statusCode without logging for client errors', () => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    const err = Object.assign(new Error('bad input'), { statusCode: 429 });
    expect(run(err)).toEqual({ status: 429, body: { success: false, error: 'bad input' } });
    expect(log).not.toHaveBeenCalled();
  });
});

describe('dashboard request guards', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { sameOriginGuard, requireBotSecret, ensureBody } = require('../../../src/dashboard/lib/middleware');

  function call(mw: (req: Request, res: Response, next: NextFunction) => void, req: Partial<Request>) {
    const json = jest.fn();
    const res = { status: jest.fn(() => ({ json })) } as unknown as Response;
    const next = jest.fn();
    mw({ headers: {}, ...req } as Request, res, next as unknown as NextFunction);
    const status = (res.status as jest.Mock).mock.calls[0]?.[0];
    return { passed: next.mock.calls.length === 1, status, body: json.mock.calls[0]?.[0] };
  }

  describe('sameOriginGuard', () => {
    it.each(['GET', 'HEAD', 'OPTIONS'])('lets %s through whatever the Origin', (method) => {
      expect(call(sameOriginGuard, { method, headers: { origin: 'https://evil.example', host: 'localhost:3001' } }).passed).toBe(true);
    });

    it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('lets a %s without Origin through (bot, CLI)', (method) => {
      expect(call(sameOriginGuard, { method, headers: { host: 'localhost:3001' } }).passed).toBe(true);
    });

    it('lets a write through when the Origin host:port matches Host (case-insensitive)', () => {
      expect(call(sameOriginGuard, { method: 'POST', headers: { origin: 'http://LOCALHOST:3001', host: 'localhost:3001' } }).passed).toBe(true);
      expect(call(sameOriginGuard, { method: 'DELETE', headers: { origin: 'https://dash.example', host: 'dash.example' } }).passed).toBe(true);
    });

    it.each([
      ['another site', 'https://evil.example'],
      ['another port', 'http://localhost:8080'],
      ['the opaque null origin', 'null'],
      ['garbage', 'not a url']
    ])('rejects a write from %s with 403', (_label, origin) => {
      const r = call(sameOriginGuard, { method: 'POST', headers: { origin, host: 'localhost:3001' } });
      expect(r).toEqual({ passed: false, status: 403, body: { error: 'Forbidden: cross-site request' } });
    });

    it('rejects a write with an Origin but no Host', () => {
      expect(call(sameOriginGuard, { method: 'POST', headers: { origin: 'http://localhost:3001' } }).status).toBe(403);
    });
  });

  describe('requireBotSecret', () => {
    it('passes everything when no secret is configured', () => {
      expect(call(requireBotSecret(undefined), { method: 'POST' }).passed).toBe(true);
      expect(call(requireBotSecret(''), { method: 'DELETE' }).passed).toBe(true);
    });

    it('passes reads without the header', () => {
      expect(call(requireBotSecret('s3cret'), { method: 'GET' }).passed).toBe(true);
    });

    it('requires the exact x-bot-secret on writes', () => {
      const guard = requireBotSecret('s3cret');
      expect(call(guard, { method: 'POST', headers: { 'x-bot-secret': 's3cret' } }).passed).toBe(true);
      for (const headers of [{}, { 'x-bot-secret': 'wrong!' }, { 'x-bot-secret': 's3cre' }, { 'x-bot-secret': 's3cret ' }]) {
        expect(call(guard, { method: 'PUT', headers })).toEqual({ passed: false, status: 403, body: { error: 'Forbidden' } });
      }
    });
  });

  it('ensureBody gives body-less requests an empty object and keeps real bodies', () => {
    const empty = { headers: {} } as Request;
    const next = jest.fn();
    ensureBody(empty, {} as Response, next);
    expect(empty.body).toEqual({});
    const withBody = { headers: {}, body: { a: 1 } } as unknown as Request;
    ensureBody(withBody, {} as Response, next);
    expect(withBody.body).toEqual({ a: 1 });
    expect(next).toHaveBeenCalledTimes(2);
  });
});
