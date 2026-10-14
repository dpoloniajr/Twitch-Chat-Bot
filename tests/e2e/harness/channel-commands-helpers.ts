/**
 * Helpers for the channel/fun command suites.
 *
 * FakeTwitch.requests records the bearer token but not the raw headers, so
 * `captureHttpHeaders()` spies on http.Server#emit to record the headers of
 * every incoming request, keyed by the local port that received it. Filter
 * with `twitchPort(bot.twitch.base)` to see what actually reached fake Twitch.
 *
 * Call it in beforeEach (jest restoreMocks undoes the spy after each test).
 */

import * as http from 'http';
import type { IncomingMessage } from 'http';
import type { Socket } from 'net';

export interface CapturedRequest {
  port: number;
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
}

export interface HeaderCapture {
  all: () => CapturedRequest[];
  /** Requests received on `port` whose method/path match `route` ("METHOD /path") */
  calls: (port: number, route: string) => CapturedRequest[];
}

export function captureHttpHeaders(): HeaderCapture {
  const captured: CapturedRequest[] = [];
  const original = http.Server.prototype.emit;
  jest.spyOn(http.Server.prototype, 'emit').mockImplementation(function (this: http.Server, event: string | symbol, ...rest: unknown[]) {
    if (event === 'request') {
      const req = rest[0] as IncomingMessage;
      captured.push({
        port: (req.socket as Socket).localPort || 0,
        method: req.method || '',
        path: (req.url || '').split('?')[0],
        query: Object.fromEntries(new URL(req.url || '/', 'http://x').searchParams),
        headers: { ...req.headers }
      });
    }
    return original.call(this, event, ...rest);
  });
  return {
    all: () => captured.slice(),
    calls: (port, route) => {
      const [method, path] = route.split(' ');
      return captured.filter((c) => c.port === port && c.method === method && c.path === path);
    }
  };
}

export function twitchPort(base: string): number {
  return Number(new URL(base).port);
}

/** Dashboard builtinCommands.json overriding cooldowns (seconds) for some commands */
export function builtinCooldowns(cooldowns: Record<string, number>): Array<{ name: string; cooldownSeconds: number; description: string; permission: string }> {
  return Object.entries(cooldowns).map(([name, cooldownSeconds]) => ({
    name, cooldownSeconds, description: name, permission: 'Everyone'
  }));
}
