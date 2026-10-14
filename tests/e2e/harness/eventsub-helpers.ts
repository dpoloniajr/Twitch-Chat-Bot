/**
 * Helpers for the startup and EventSub suites.
 *
 * The shared fake Twitch does not expose its EventSub WebSocket sockets, so
 * `trackEventSubSockets()` records them as they are created by spying on
 * EventEmitter#on (restored by jest's restoreMocks). Server-side sockets let a
 * test send arbitrary EventSub frames (session_reconnect, keepalive, revocation,
 * duplicate notifications) and close a session the way Twitch would.
 *
 * Call it in beforeEach BEFORE startBot().
 */

import { EventEmitter } from 'events';
import { setTimeout as realSleep } from 'timers/promises';

export interface WsSocket {
  _isServer: boolean;
  readyState: number;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  terminate: () => void;
}

export interface SocketTracker {
  /** Server-side sockets of the fake EventSub server, in connection order */
  server: () => WsSocket[];
  /** Bot-side (client) EventSub sockets, in creation order */
  client: () => WsSocket[];
  /** Server sockets that are still open (readyState OPEN) */
  openServer: () => WsSocket[];
}

export function trackEventSubSockets(): SocketTracker {
  const server: WsSocket[] = [];
  const client: WsSocket[] = [];
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = EventEmitter.prototype.on;
  jest.spyOn(EventEmitter.prototype, 'on').mockImplementation(function (
    this: EventEmitter,
    event: string | symbol,
    listener: (...args: unknown[]) => void
  ) {
    const self = this as unknown as Partial<WsSocket>;
    if (self && typeof self.send === 'function' && typeof self._isServer === 'boolean') {
      const sock = self as WsSocket;
      if (sock._isServer && event === 'close' && !server.includes(sock)) server.push(sock);
      if (!sock._isServer && event === 'message' && !client.includes(sock)) client.push(sock);
    }
    return original.call(this, event, listener);
  });
  return {
    server: () => server.slice(),
    client: () => client.slice(),
    openServer: () => server.filter((s) => s.readyState === 1)
  };
}

let seq = 0;

/** Send a raw EventSub frame on a server-side socket */
export function sendFrame(socket: WsSocket, messageType: string, payload: Record<string, unknown>, messageId?: string, subscriptionType?: string): string {
  seq += 1;
  const id = messageId || `frame-${seq}`;
  socket.send(JSON.stringify({
    metadata: {
      message_id: id,
      message_type: messageType,
      message_timestamp: new Date().toISOString(),
      ...(subscriptionType ? { subscription_type: subscriptionType, subscription_version: '1' } : {})
    },
    payload
  }));
  return id;
}

/** Send a notification frame for `type` with the given condition and event */
export function sendNotification(
  socket: WsSocket,
  type: string,
  condition: Record<string, string>,
  event: Record<string, unknown>,
  messageId?: string
): string {
  return sendFrame(socket, 'notification', {
    subscription: { id: `manual-${type}`, type, version: type === 'channel.follow' ? '2' : '1', condition, status: 'enabled' },
    event
  }, messageId, type);
}

/**
 * Let concurrent dashboard writes finish. The dashboard's cross-process file lock retries with
 * setTimeout(100ms), which runs on the fake clock, so plain settle() stalls (up to ~5s) when two
 * writes to the same file overlap. Interleave real waits with small fake-clock steps instead.
 */
export async function pumpClock(bot: { settle: () => Promise<void> }, steps = 20, stepMs = 100): Promise<void> {
  for (let i = 0; i < steps; i++) {
    await realSleep(5);
    await jest.advanceTimersByTimeAsync(stepMs);
  }
  await bot.settle();
}

/**
 * Wait (in real time, without moving the fake clock) until `cond` holds. WebSocket closes and
 * frames are real network I/O that settle() does not track, so it can return before they land
 * when the machine is busy.
 */
export async function waitFor(cond: () => boolean, what = 'condition', timeoutMs = 5000): Promise<void> {
  for (let waited = 0; waited < timeoutMs; waited += 5) {
    if (cond()) return;
    await jest.advanceTimersByTimeAsync(0);
    await realSleep(5);
  }
  if (!cond()) throw new Error(`waitFor: timed out waiting for ${what}`);
}
