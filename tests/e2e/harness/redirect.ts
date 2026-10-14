/**
 * Module mocks that send the bot's Twitch, YouTube and EventSub traffic to the
 * fake server instead of the internet. The fake server's address is read from
 * process.env.E2E_FAKE_TWITCH at request time.
 *
 * Use from a test file:
 *   jest.mock('axios', () => require('./harness/redirect').axiosMock());
 *   jest.mock('ws', () => require('./harness/redirect').wsMock());
 */

const REMOTE_HOSTS = [
  'https://api.twitch.tv',
  'https://id.twitch.tv',
  'https://www.googleapis.com'
];

export function rewriteUrl(url: string): string {
  const base = process.env.E2E_FAKE_TWITCH;
  if (!base) return url;
  for (const host of REMOTE_HOSTS) {
    if (url.startsWith(host)) return base + url.slice(host.length);
  }
  if (url.startsWith('wss://eventsub.wss.twitch.tv')) {
    return base.replace(/^http/, 'ws') + url.slice('wss://eventsub.wss.twitch.tv'.length);
  }
  return url;
}

/**
 * Outbound axios requests that have been sent but not answered yet (any host).
 * Kept on globalThis because jest.isolateModules gives each bot its own copy of this module.
 */
const g = globalThis as { __e2eInflight?: { count: number } };
export const inflight: { count: number } = g.__e2eInflight || (g.__e2eInflight = { count: 0 });

/**
 * Real axios, with every instance rewriting remote URLs to the fake server and
 * counting in-flight requests so the harness can wait for them.
 */
export function axiosMock() {
  const axios = jest.requireActual('axios');
  const rewrite = (config: { url?: string; baseURL?: string }) => {
    if (config.baseURL) config.baseURL = rewriteUrl(config.baseURL);
    if (config.url) config.url = rewriteUrl(config.url);
    inflight.count += 1;
    return config;
  };
  const done = (response: unknown) => {
    inflight.count = Math.max(0, inflight.count - 1);
    return response;
  };
  const failed = (error: unknown) => {
    inflight.count = Math.max(0, inflight.count - 1);
    return Promise.reject(error);
  };
  const track = (instance: any) => {
    instance.interceptors.request.use(rewrite);
    instance.interceptors.response.use(done, failed);
  };
  track(axios);
  const create = axios.create.bind(axios);
  axios.create = (...args: unknown[]) => {
    const instance = create(...args);
    track(instance);
    return instance;
  };
  return axios;
}

/** Real ws, with client connections to EventSub rewritten to the fake server. */
export function wsMock() {
  const ws = jest.requireActual('ws');
  class RedirectedWebSocket extends ws {
    constructor(address: string, ...rest: unknown[]) {
      super(rewriteUrl(String(address)), ...rest);
    }
  }
  return RedirectedWebSocket;
}

/**
 * Fake tmi.js: records what the bot says and lets tests inject chat messages.
 * Instances are collected on `FakeTmiClient.instances`.
 */
export function tmiMock() {
  const { EventEmitter } = require('events');
  class FakeTmiClient extends EventEmitter {
    static instances: FakeTmiClient[] = [];
    opts: any;
    said: Array<{ channel: string; message: string }> = [];
    connected = false;
    connectCount = 0;
    constructor(opts: any) {
      super();
      this.opts = opts;
      FakeTmiClient.instances.push(this);
    }
    async connect() {
      this.connected = true;
      this.connectCount += 1;
      this.emit('connected', 'irc.fake', 6667);
      return ['irc.fake', 6667];
    }
    async disconnect() {
      this.connected = false;
      this.emit('disconnected', 'Connection closed.');
    }
    async say(channel: string, message: string) {
      this.said.push({ channel: channel.replace(/^#/, ''), message });
      return [channel, message];
    }
    async action(channel: string, message: string) {
      this.said.push({ channel: channel.replace(/^#/, ''), message: `/me ${message}` });
    }
    async join() {}
    async part() {}
  }
  return { Client: FakeTmiClient, client: FakeTmiClient };
}
