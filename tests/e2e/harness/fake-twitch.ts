/**
 * Fake Twitch (OAuth + Helix) and YouTube Data API on a local HTTP server.
 *
 * Tests seed `state`, drive the bot, then assert on `state` and `requests`.
 * Helix calls require a live token, so expiry and refresh behave as on Twitch.
 */

import * as http from 'http';
import type { AddressInfo } from 'net';
/* eslint-disable @typescript-eslint/no-require-imports */
const express = require('express');
// The real ws server, even when a test file mocks the ws module
const { WebSocketServer } = jest.requireActual('ws');
/* eslint-enable @typescript-eslint/no-require-imports */

export interface FakeUser {
  id: string;
  login: string;
  display_name: string;
}

export interface FakeToken {
  userId: string;
  login: string;
  scopes: string[];
  expiresAt: number;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, unknown>;
  body: unknown;
  token: string;
}

export interface FakeFailure {
  status: number;
  message: string;
  /** Fail this many times, then succeed (default: forever) */
  times?: number;
}

export interface YouTubeVideo {
  id: string;
  title: string;
  channelTitle: string;
  channelId: string;
  duration: string; // ISO 8601, e.g. PT3M30S
}

export interface FakeTwitchState {
  users: FakeUser[];
  tokens: Map<string, FakeToken>;
  refreshTokens: Map<string, { userId: string; login: string; scopes: string[] }>;
  /** user id -> followed_at ISO string, for the broadcaster's channel */
  followers: Map<string, string>;
  /** user ids currently live */
  live: Set<string>;
  /** broadcaster id -> channel info */
  channels: Map<string, { title: string; game_id: string; game_name: string }>;
  games: Array<{ id: string; name: string }>;
  categories: Array<{ id: string; name: string }>;
  videos: YouTubeVideo[];
  /** search query (lowercase) -> video ids */
  searches: Map<string, string[]>;
  /** YouTube channel handle (lowercase, no @) -> channel id (UC...) */
  handles: Map<string, string>;
  /** Channel point redemption status updates: PATCH /helix/channel_points/custom_rewards/redemptions */
  redemptionUpdates: Array<{ broadcasterId: string; rewardId: string; id: string; status: string; token: string }>;
  /** "METHOD /path" -> failure to inject */
  failures: Map<string, FakeFailure>;
  issued: number;
  /** EventSub subscriptions created over Helix */
  subscriptions: Array<{ id: string; type: string; version: string; condition: Record<string, string>; sessionId: string; token: string }>;
}

export interface FakeTwitch {
  base: string;
  state: FakeTwitchState;
  requests: RecordedRequest[];
  /** Requests matching "METHOD /path" */
  calls: (route: string) => RecordedRequest[];
  /** Number of open EventSub WebSocket sessions */
  eventSubSessions: () => number;
  /** URL to send in a session_reconnect frame; connecting to it resumes `sessionId` */
  reconnectUrl: (sessionId: string) => string;
  /** Deliver an EventSub notification to every session subscribed to `type` */
  emitEvent: (type: string, event: Record<string, unknown>) => number;
  issueToken: (login: string, opts?: { scopes?: string[]; ttlSec?: number; access?: string; refresh?: string }) => { access: string; refresh: string };
  close: () => Promise<void>;
}

export const ALL_SCOPES = [
  'analytics:read:extensions', 'bits:read', 'channel:bot', 'channel:edit:commercial',
  'channel:manage:broadcast', 'channel:manage:polls', 'channel:manage:predictions',
  'channel:manage:redemptions', 'channel:read:polls', 'channel:read:predictions',
  'channel:read:redemptions', 'channel:read:subscriptions', 'chat:edit', 'chat:read',
  'clips:edit', 'moderator:manage:announcements', 'moderator:manage:banned_users',
  'moderator:manage:chat_messages', 'moderator:manage:shoutouts', 'moderator:read:chatters',
  'moderator:read:followers', 'user:bot', 'user:read:chat', 'user:write:chat'
];

export async function startFakeTwitch(): Promise<FakeTwitch> {
  const state: FakeTwitchState = {
    users: [],
    tokens: new Map(),
    refreshTokens: new Map(),
    followers: new Map(),
    live: new Set(),
    channels: new Map(),
    games: [],
    categories: [],
    videos: [],
    searches: new Map(),
    handles: new Map(),
    redemptionUpdates: [],
    failures: new Map(),
    issued: 0,
    subscriptions: []
  };
  const requests: RecordedRequest[] = [];
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  const bearer = (req: { headers: Record<string, unknown> }) =>
    String(req.headers.authorization || '').replace(/^(OAuth|Bearer) /, '');
  const liveToken = (token: string) => {
    const t = state.tokens.get(token);
    return t && t.expiresAt > Date.now() ? t : null;
  };
  const userBy = (key: 'id' | 'login', value: string) =>
    state.users.find((u) => u[key].toLowerCase() === String(value).toLowerCase());

  // Record every request and apply injected failures
  app.use((req: any, res: any, next: () => void) => {
    requests.push({ method: req.method, path: req.path, query: { ...req.query }, body: req.body, token: bearer(req) });
    const failure = state.failures.get(`${req.method} ${req.path}`);
    if (failure) {
      if (failure.times !== undefined) {
        failure.times -= 1;
        if (failure.times <= 0) state.failures.delete(`${req.method} ${req.path}`);
      }
      return res.status(failure.status).json({ status: failure.status, message: failure.message, error: { message: failure.message } });
    }
    next();
  });

  // ---------- OAuth ----------
  app.get('/oauth2/validate', (req: any, res: any) => {
    const token = liveToken(bearer(req));
    if (!token) return res.status(401).json({ status: 401, message: 'invalid access token' });
    res.json({
      client_id: 'test-client-id', login: token.login, user_id: token.userId, scopes: token.scopes,
      expires_in: Math.floor((token.expiresAt - Date.now()) / 1000)
    });
  });

  app.post('/oauth2/token', (req: any, res: any) => {
    const grant = state.refreshTokens.get(req.body.refresh_token);
    if (req.body.grant_type !== 'refresh_token' || !grant) {
      return res.status(400).json({ status: 400, message: 'Invalid refresh token' });
    }
    state.issued += 1;
    const access = `refreshed-access-${state.issued}`;
    state.tokens.set(access, { ...grant, expiresAt: Date.now() + 4 * 3600 * 1000 });
    res.json({ access_token: access, refresh_token: req.body.refresh_token, expires_in: 4 * 3600, scope: grant.scopes, token_type: 'bearer' });
  });

  // ---------- Helix ----------
  const helix = express.Router();
  helix.use((req: any, res: any, next: () => void) => {
    if (!liveToken(bearer(req))) return res.status(401).json({ status: 401, message: 'Invalid OAuth token' });
    next();
  });
  const list = (v: unknown) => (v === undefined ? [] : Array.isArray(v) ? v : [v]).map(String);
  const helixUser = (u: FakeUser) => ({
    id: u.id, login: u.login, display_name: u.display_name, type: '', broadcaster_type: 'affiliate',
    description: '', profile_image_url: '', created_at: '2020-01-01T00:00:00Z'
  });

  helix.get('/users', (req: any, res: any) => {
    const found = [
      ...list(req.query.login).map((l) => userBy('login', l)),
      ...list(req.query.id).map((i) => userBy('id', i))
    ].filter(Boolean) as FakeUser[];
    res.json({ data: found.map(helixUser) });
  });

  helix.get('/channels', (req: any, res: any) => {
    const id = String(req.query.broadcaster_id);
    const user = userBy('id', id);
    const channel = state.channels.get(id);
    if (!user) return res.json({ data: [] });
    res.json({
      data: [{
        broadcaster_id: id, broadcaster_login: user.login, broadcaster_name: user.display_name,
        broadcaster_language: 'en', game_id: channel?.game_id || '', game_name: channel?.game_name || '',
        title: channel?.title || '', tags: []
      }]
    });
  });

  helix.patch('/channels', (req: any, res: any) => {
    const id = String(req.query.broadcaster_id);
    const current = state.channels.get(id) || { title: '', game_id: '', game_name: '' };
    if (req.body.title !== undefined) current.title = req.body.title;
    if (req.body.game_id !== undefined) {
      current.game_id = req.body.game_id;
      current.game_name = [...state.games, ...state.categories].find((g) => g.id === req.body.game_id)?.name || '';
    }
    state.channels.set(id, current);
    res.status(204).end();
  });

  helix.get('/channels/followers', (req: any, res: any) => {
    const userId = req.query.user_id ? String(req.query.user_id) : null;
    const entries = [...state.followers.entries()].filter(([id]) => !userId || id === userId);
    res.json({
      total: entries.length,
      data: entries.map(([id, followedAt]) => {
        const u = userBy('id', id);
        return { user_id: id, user_login: u?.login, user_name: u?.display_name, followed_at: followedAt };
      }),
      pagination: {}
    });
  });

  helix.get('/streams', (req: any, res: any) => {
    const ids = list(req.query.user_id).filter((id) => state.live.has(id));
    res.json({
      data: ids.map((id) => {
        const u = userBy('id', id)!;
        return {
          id: `stream-${id}`, user_id: id, user_login: u.login, user_name: u.display_name,
          game_id: '1', game_name: state.channels.get(id)?.game_name || '', type: 'live',
          title: state.channels.get(id)?.title || '', viewer_count: 42, started_at: new Date().toISOString(),
          language: 'en', thumbnail_url: '', is_mature: false
        };
      })
    });
  });

  helix.post('/chat/announcements', (_req: any, res: any) => res.status(204).end());
  helix.post('/chat/shoutouts', (_req: any, res: any) => res.status(204).end());
  helix.post('/clips', (req: any, res: any) => {
    const id = `Clip${requests.filter((r) => r.path === '/helix/clips').length}`;
    res.status(202).json({ data: [{ id, edit_url: `https://clips.twitch.tv/${id}/edit` }] });
  });
  helix.post('/moderation/bans', (req: any, res: any) => {
    res.json({ data: [{ broadcaster_id: req.query.broadcaster_id, user_id: req.body?.data?.user_id || req.body?.user_id }] });
  });
  helix.delete('/moderation/chat', (_req: any, res: any) => res.status(204).end());
  helix.get('/games', (req: any, res: any) => {
    const names = list(req.query.name).map((n) => n.toLowerCase());
    res.json({ data: state.games.filter((g) => names.includes(g.name.toLowerCase())) });
  });
  helix.get('/search/categories', (req: any, res: any) => {
    const q = String(req.query.query || '').toLowerCase();
    res.json({ data: state.categories.filter((c) => c.name.toLowerCase().includes(q)) });
  });
  helix.post('/polls', (req: any, res: any) => {
    res.json({ data: [{ id: 'poll-1', title: req.body.title, choices: req.body.choices, duration: req.body.duration, status: 'ACTIVE' }] });
  });
  helix.patch('/polls', (req: any, res: any) => res.json({ data: [{ id: req.query.id, status: req.body.status }] }));
  helix.post('/predictions', (req: any, res: any) => {
    res.json({ data: [{ id: 'pred-1', title: req.body.title, outcomes: req.body.outcomes, prediction_window: req.body.prediction_window, status: 'ACTIVE' }] });
  });
  helix.patch('/predictions', (req: any, res: any) => res.json({ data: [{ id: req.query.id, status: req.body.status }] }));
  helix.post('/eventsub/subscriptions', (req: any, res: any) => {
    const sub = {
      id: `sub-${state.subscriptions.length + 1}`, type: req.body.type, version: req.body.version,
      condition: req.body.condition, sessionId: req.body.transport?.session_id, token: bearer(req)
    };
    state.subscriptions.push(sub);
    res.status(202).json({ data: [{ id: sub.id, status: 'enabled', type: sub.type, version: sub.version, condition: sub.condition }] });
  });
  helix.patch('/channel_points/custom_rewards/redemptions', (req: any, res: any) => {
    const update = {
      broadcasterId: String(req.query.broadcaster_id), rewardId: String(req.query.reward_id),
      id: String(req.query.id), status: req.body?.status, token: bearer(req)
    };
    state.redemptionUpdates.push(update);
    res.json({ data: [{ id: update.id, status: update.status, reward: { id: update.rewardId } }] });
  });
  app.use('/helix', helix);

  // ---------- YouTube Data API ----------
  app.get('/youtube/v3/videos', (req: any, res: any) => {
    const ids = String(req.query.id || '').split(',');
    const items = state.videos.filter((v) => ids.includes(v.id)).map((v) => ({
      id: v.id,
      snippet: { title: v.title, channelTitle: v.channelTitle, channelId: v.channelId, thumbnails: { default: { url: `https://i.ytimg.com/vi/${v.id}/default.jpg` } } },
      contentDetails: { duration: v.duration }
    }));
    res.json({ items });
  });
  app.get('/youtube/v3/channels', (req: any, res: any) => {
    const handle = String(req.query.forHandle || '').replace(/^@/, '').toLowerCase();
    const id = state.handles.get(handle);
    res.json(id ? { items: [{ kind: 'youtube#channel', id }] } : {});
  });
  app.get('/youtube/v3/search', (req: any, res: any) => {
    const ids = state.searches.get(String(req.query.q || '').toLowerCase()) || [];
    res.json({ items: ids.slice(0, Number(req.query.maxResults) || 5).map((videoId) => ({ id: { kind: 'youtube#video', videoId } })) });
  });

  // Anything else (e.g. a custom command's fetch URL)
  app.get('/external/:name', (req: any, res: any) => res.type('text/plain').send(`external ${req.params.name}`));

  const server = http.createServer(app);

  // ---------- EventSub WebSocket ----------
  const wss = new WebSocketServer({ server, path: '/ws' });
  const sockets = new Map<string, any>();
  let sessionCount = 0;
  let welcomeSeq = 0;
  wss.on('connection', (socket: any, req: http.IncomingMessage) => {
    // A reconnect URL (see reconnectUrl()) continues an existing session, like Twitch:
    // same session id, its subscriptions are delivered on the new socket from now on.
    const resumed = new URL(req.url || '/', 'http://localhost').searchParams.get('reconnect');
    let sessionId: string;
    if (resumed) {
      sessionId = resumed;
    } else {
      sessionCount += 1;
      sessionId = `session-${sessionCount}`;
    }
    sockets.set(sessionId, socket);
    socket.on('close', () => {
      if (sockets.get(sessionId) === socket) sockets.delete(sessionId);
    });
    socket.send(JSON.stringify({
      // Unique per connection: a resumed session gets a second welcome
      metadata: { message_id: `m-${sessionId}-${++welcomeSeq}`, message_type: 'session_welcome', message_timestamp: new Date().toISOString() },
      payload: { session: { id: sessionId, status: 'connected', keepalive_timeout_seconds: 600, reconnect_url: null } }
    }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  let notificationSeq = 0;
  return {
    base,
    state,
    requests,
    calls: (route: string) => {
      const [method, path] = route.split(' ');
      return requests.filter((r) => r.method === method && r.path === path);
    },
    eventSubSessions: () => sockets.size,
    reconnectUrl: (sessionId: string) => `${base.replace(/^http/, 'ws')}/ws?reconnect=${encodeURIComponent(sessionId)}`,
    emitEvent(type, event) {
      let delivered = 0;
      for (const sub of state.subscriptions.filter((s) => s.type === type)) {
        const socket = sockets.get(sub.sessionId);
        if (!socket) continue;
        socket.send(JSON.stringify({
          // Unique per delivery: the bot drops redelivered message ids
          metadata: { message_id: `n-${++notificationSeq}`, message_type: 'notification', message_timestamp: new Date().toISOString(), subscription_type: type },
          payload: { subscription: { id: sub.id, type, version: sub.version, condition: sub.condition, status: 'enabled' }, event }
        }));
        delivered += 1;
      }
      return delivered;
    },
    issueToken(login, opts = {}) {
      const user = userBy('login', login);
      if (!user) throw new Error(`issueToken: unknown user ${login}`);
      state.issued += 1;
      const access = opts.access || `access-${login}-${state.issued}`;
      const refresh = opts.refresh || `refresh-${login}-${state.issued}`;
      const grant = { userId: user.id, login: user.login, scopes: opts.scopes || ALL_SCOPES };
      state.tokens.set(access, { ...grant, expiresAt: Date.now() + (opts.ttlSec ?? 4 * 3600) * 1000 });
      state.refreshTokens.set(refresh, grant);
      return { access, refresh };
    },
    close: async () => {
      // Every connection, including sockets superseded by a reconnect URL (wss.close waits for them)
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
