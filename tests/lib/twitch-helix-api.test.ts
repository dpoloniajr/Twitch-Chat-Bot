/**
 * Regression tests for TwitchHelixAPI.sendAnnouncement
 * Covers the 401 token-expiry bug (issue #6889)
 */

import axios from 'axios';
import { TwitchHelixAPI as TsTwitchHelixAPI } from '../../src/lib/twitch-helix-api';

describe('TwitchHelixAPI.sendAnnouncement', () => {
  let api: any;
  let mockPost: jest.Mock;

  beforeEach(() => {
    api = new TsTwitchHelixAPI({ clientId: 'test-client', accessToken: 'initial-token' });
    mockPost = jest.fn();
    api.http = { post: mockPost };
  });

  it('returns success:true on a successful announcement', async () => {
    mockPost.mockResolvedValueOnce({ status: 204 });

    const result = await api.sendAnnouncement('broadcaster1', 'mod1', 'Hello!', 'purple');

    expect(result).toEqual({ success: true });
  });

  it('returns success:false with error message on API failure', async () => {
    const axiosError = Object.assign(new Error('Bad Request'), {
      response: { status: 400, data: { message: 'invalid color' } }
    });
    mockPost.mockRejectedValueOnce(axiosError);

    const result = await api.sendAnnouncement('broadcaster1', 'mod1', 'Hello!', 'purple');

    expect(result.success).toBe(false);
    expect(result.error).toBe('invalid color');
  });

  it('includes status code in the failure result (regression: issue #6889)', async () => {
    const axiosError = Object.assign(new Error('Unauthorized'), {
      response: { status: 401, data: { message: 'Invalid OAuth token' } }
    });
    mockPost.mockRejectedValueOnce(axiosError);

    const result = await api.sendAnnouncement('broadcaster1', 'mod1', 'Hello!', 'purple');

    expect(result.success).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toBe('Invalid OAuth token');
  });

  it('returns status:undefined when the error has no HTTP response', async () => {
    const networkError = new Error('ECONNRESET');
    mockPost.mockRejectedValueOnce(networkError);

    const result = await api.sendAnnouncement('broadcaster1', 'mod1', 'Hello!', 'purple');

    expect(result.success).toBe(false);
    expect(result.status).toBeUndefined();
  });

  it('setAccessToken updates the token used in subsequent requests', async () => {
    mockPost.mockResolvedValue({ status: 204 });

    api.setAccessToken('new-token');

    await api.sendAnnouncement('broadcaster1', 'mod1', 'Hello!', 'purple');

    const callHeaders = mockPost.mock.calls[0][2].headers;
    expect(callHeaders['Authorization']).toBe('Bearer new-token');
  });
});

describe('TwitchHelixAPI 401 refresh-and-retry', () => {
  let api: any;
  let seen: string[];
  let valid: Set<string>;

  beforeEach(() => {
    api = new TsTwitchHelixAPI({ clientId: 'test-client', accessToken: 'old-token' });
    seen = [];
    valid = new Set(['new-token']);
    // Fake transport: 401 unless the bearer token is currently valid
    api.http.defaults.adapter = async (config: any) => {
      const token = String(config.headers.Authorization || '').replace('Bearer ', '');
      seen.push(token);
      const response = { data: { data: [] }, status: 200, statusText: 'OK', headers: {}, config };
      if (valid.has(token)) return response;
      const error: any = new Error('Request failed with status code 401');
      error.config = config;
      error.response = { ...response, status: 401, data: { message: 'Invalid OAuth token' } };
      throw error;
    };
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('refreshes and retries once with the new token', async () => {
    const refresh = jest.fn().mockResolvedValue({ accessToken: 'new-token', refreshToken: 'r' });
    api.setOnTokenRefresh(refresh);

    const res = await api.http.get('/users', { headers: api.getHeaders() });

    expect(res.status).toBe(200);
    expect(seen).toEqual(['old-token', 'new-token']);
    expect(api.accessToken).toBe('new-token');
  });

  it('does not loop when the retried request is rejected too', async () => {
    valid.clear();
    const refresh = jest.fn().mockResolvedValue({ accessToken: 'still-bad', refreshToken: 'r' });
    api.setOnTokenRefresh(refresh);

    await expect(api.http.get('/users', { headers: api.getHeaders() })).rejects.toMatchObject({
      response: { status: 401 }
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['old-token', 'still-bad']);
  });

  it('retries with the current token, without refreshing, when the request used a replaced token', async () => {
    const refresh = jest.fn();
    api.setOnTokenRefresh(refresh);
    const staleHeaders = api.getHeaders();
    api.setAccessToken('new-token'); // refreshed elsewhere while the request was in flight

    const res = await api.http.get('/users', { headers: staleHeaders });

    expect(res.status).toBe(200);
    expect(refresh).not.toHaveBeenCalled();
    expect(seen).toEqual(['old-token', 'new-token']);
  });

  it('rejects with the original 401 when the refresh callback fails or throws', async () => {
    api.setOnTokenRefresh(jest.fn().mockResolvedValue(null));
    await expect(api.http.get('/users', { headers: api.getHeaders() })).rejects.toMatchObject({
      response: { status: 401 }
    });

    api.setOnTokenRefresh(jest.fn().mockRejectedValue(new Error('network down')));
    await expect(api.http.get('/users', { headers: api.getHeaders() })).rejects.toMatchObject({
      response: { status: 401 }
    });
    expect(api.accessToken).toBe('old-token');
  });

  it('passes non-401 errors and requests without a refresh callback straight through', async () => {
    await expect(api.http.get('/users', { headers: api.getHeaders() })).rejects.toMatchObject({
      response: { status: 401 }
    });
    expect(seen).toEqual(['old-token']);
  });
});

// ==================== TypeScript module coverage ====================


interface Captured {
  method?: string;
  url?: string;
  params?: any;
  data?: any;
  headers: Record<string, unknown>;
}

type Reply = { status: number; data?: unknown } | Error;

/** Real axios instance with a fake adapter: records each request and answers from a queue */
function fakeTransport(api: TsTwitchHelixAPI) {
  const requests: Captured[] = [];
  const replies: Reply[] = [];
  api.http.defaults.adapter = async (config: any) => {
    requests.push({
      method: config.method,
      url: config.url,
      params: config.params,
      data: typeof config.data === 'string' ? JSON.parse(config.data) : config.data,
      headers: { ...config.headers }
    });
    const reply = replies.shift() ?? { status: 200, data: { data: [] } };
    if (reply instanceof Error) throw reply;
    const response = { data: reply.data, status: reply.status, statusText: '', headers: {}, config };
    if (reply.status >= 400) {
      const error: any = new Error(`Request failed with status code ${reply.status}`);
      error.config = config;
      error.response = response;
      throw error;
    }
    return response;
  };
  return { requests, replies };
}

describe('TwitchHelixAPI (TypeScript module)', () => {
  let api: TsTwitchHelixAPI;
  let requests: Captured[];
  let replies: Reply[];
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    api = new TsTwitchHelixAPI({ clientId: 'cid', accessToken: 'tok' });
    ({ requests, replies } = fakeTransport(api));
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('construction and headers', () => {
    it('defaults to the Helix base URL and a 5s timeout', () => {
      const fresh = new TsTwitchHelixAPI();
      expect(fresh.http.defaults.baseURL).toBe('https://api.twitch.tv/helix');
      expect(fresh.timeout).toBe(5000);
      expect(fresh.http.defaults.timeout).toBe(5000);
      expect(fresh.clientId).toBeUndefined();
      expect(fresh.accessToken).toBeUndefined();
    });

    it('honours a custom timeout', () => {
      const fresh = new TsTwitchHelixAPI({ timeout: 1234 });
      expect(fresh.timeout).toBe(1234);
      expect(fresh.http.defaults.timeout).toBe(1234);
    });

    it('getHeaders builds Client-ID, bearer token and JSON content type', () => {
      expect(api.getHeaders()).toEqual({
        'Client-ID': 'cid',
        'Authorization': 'Bearer tok',
        'Content-Type': 'application/json'
      });
      api.setAccessToken('other');
      expect(api.getHeaders().Authorization).toBe('Bearer other');
    });
  });

  describe('getTokenInfo', () => {
    it('maps the validate response', async () => {
      const get = jest.spyOn(axios, 'get').mockResolvedValue({
        data: { user_id: '1', login: 'bot', scopes: ['a'], expires_in: 99, client_id: 'cid' }
      });

      await expect(api.getTokenInfo()).resolves.toEqual({
        userId: '1', login: 'bot', scopes: ['a'], expiresIn: 99, clientId: 'cid'
      });
      expect(get).toHaveBeenCalledWith('https://id.twitch.tv/oauth2/validate', {
        headers: { 'Authorization': 'Bearer tok' },
        timeout: 5000
      });
    });

    it('defaults missing scopes to an empty array', async () => {
      jest.spyOn(axios, 'get').mockResolvedValue({ data: { user_id: '1' } });
      await expect(api.getTokenInfo()).resolves.toMatchObject({ scopes: [] });
    });

    it('returns null on 401 and rethrows other errors', async () => {
      const get = jest.spyOn(axios, 'get');
      get.mockRejectedValueOnce(Object.assign(new Error('401'), { response: { status: 401 } }));
      await expect(api.getTokenInfo()).resolves.toBeNull();

      const boom = Object.assign(new Error('500'), { response: { status: 500 } });
      get.mockRejectedValueOnce(boom);
      await expect(api.getTokenInfo()).rejects.toBe(boom);

      const network = new Error('ECONNREFUSED');
      get.mockRejectedValueOnce(network);
      await expect(api.getTokenInfo()).rejects.toBe(network);
    });
  });

  describe('users', () => {
    const raw = {
      id: '7', login: 'foo', display_name: 'Foo', profile_image_url: 'p.png',
      description: 'd', broadcaster_type: 'affiliate', created_at: '2020-01-02T03:04:05Z'
    };
    const mapped = {
      id: '7', login: 'foo', name: 'foo', displayName: 'Foo', profileImageUrl: 'p.png',
      description: 'd', broadcasterType: 'affiliate', createdAt: new Date('2020-01-02T03:04:05Z')
    };

    it('getUserByName sanitizes the login and maps the user', async () => {
      replies.push({ status: 200, data: { data: [raw] } });

      await expect(api.getUserByName('@@ FooBar.!? ')).resolves.toEqual(mapped);
      expect(requests[0]).toMatchObject({
        method: 'get', url: '/users', params: { login: 'foobar' }
      });
      expect(requests[0].headers).toMatchObject({ 'Client-ID': 'cid', Authorization: 'Bearer tok' });
    });

    it('getUserByName rejects non-strings and empty logins without a request', async () => {
      await expect(api.getUserByName(42 as unknown as string)).resolves.toBeNull();
      expect(errorSpy).toHaveBeenCalledWith('getUserByName: login must be a string, received:', 'number');
      await expect(api.getUserByName('@ ...')).resolves.toBeNull();
      await expect(api.getUserByName('')).resolves.toBeNull();
      expect(requests).toHaveLength(0);
    });

    it('getUserByName returns null when not found or on error', async () => {
      replies.push({ status: 200, data: { data: [] } }, { status: 200, data: {} }, { status: 500 });
      await expect(api.getUserByName('foo')).resolves.toBeNull();
      await expect(api.getUserByName('foo')).resolves.toBeNull();
      await expect(api.getUserByName('foo')).resolves.toBeNull();
      expect(errorSpy).toHaveBeenCalledWith('Error getting user by name:', 'Request failed with status code 500');
    });

    it('getUserById maps the user, or returns null when missing / on error', async () => {
      replies.push({ status: 200, data: { data: [raw] } }, { status: 200, data: { data: [] } }, new Error('down'));
      await expect(api.getUserById('7')).resolves.toEqual(mapped);
      expect(requests[0].params).toEqual({ id: '7' });
      await expect(api.getUserById('8')).resolves.toBeNull();
      await expect(api.getUserById('9')).resolves.toBeNull();
      expect(errorSpy).toHaveBeenCalledWith('Error getting user by ID:', 'down');
    });

    it('getUsersByIds sends at most 100 repeated id params', async () => {
      replies.push({ status: 200, data: { data: [raw, raw] } });
      const ids = Array.from({ length: 150 }, (_, i) => String(i));

      await expect(api.getUsersByIds(ids)).resolves.toEqual([mapped, mapped]);
      const params = requests[0].params as URLSearchParams;
      expect(params).toBeInstanceOf(URLSearchParams);
      expect(params.getAll('id')).toEqual(ids.slice(0, 100));
    });

    it('getUsersByIds returns [] for empty data and on error', async () => {
      replies.push({ status: 200, data: {} }, { status: 400 });
      await expect(api.getUsersByIds(['1'])).resolves.toEqual([]);
      await expect(api.getUsersByIds(['1'])).resolves.toEqual([]);
      // Malformed input is caught too
      await expect(api.getUsersByIds(null as unknown as string[])).resolves.toEqual([]);
      expect(errorSpy).toHaveBeenCalledWith('Error getting users by IDs:', expect.any(String));
    });
  });

  describe('channels', () => {
    it('getChannelInfo maps the channel and defaults tags', async () => {
      replies.push({ status: 200, data: { data: [{
        broadcaster_id: '1', broadcaster_login: 'b', broadcaster_name: 'B', game_name: 'G',
        game_id: '9', title: 'T', broadcaster_language: 'en'
      }] } });

      await expect(api.getChannelInfo('1')).resolves.toEqual({
        id: '1', broadcasterLogin: 'b', broadcasterName: 'B', gameName: 'G',
        gameId: '9', title: 'T', language: 'en', tags: []
      });
      expect(requests[0]).toMatchObject({ url: '/channels', params: { broadcaster_id: '1' } });
    });

    it('getChannelInfo returns null when missing or on error', async () => {
      replies.push({ status: 200, data: { data: [] } }, { status: 404 });
      await expect(api.getChannelInfo('1')).resolves.toBeNull();
      await expect(api.getChannelInfo('1')).resolves.toBeNull();
      expect(errorSpy).toHaveBeenCalledWith('Error getting channel info:', 'Request failed with status code 404');
    });

    it('getChannelFollowers maps followers, total and cursor', async () => {
      replies.push({ status: 200, data: {
        data: [{ user_id: '2', user_login: 'f', user_name: 'F', followed_at: '2021-01-01T00:00:00Z' }],
        total: 10,
        pagination: { cursor: 'abc' }
      } });

      const res = await api.getChannelFollowers('1');
      expect(res).toEqual({
        data: [{
          userId: '2', userLogin: 'f', userName: 'F',
          followDate: new Date('2021-01-01T00:00:00Z'), followedAt: new Date('2021-01-01T00:00:00Z')
        }],
        total: 10,
        cursor: 'abc'
      });
      expect(requests[0].params).toEqual({ broadcaster_id: '1' });
    });

    it('getChannelFollowers passes user_id and falls back to the list length for total', async () => {
      replies.push({ status: 200, data: { data: [{ user_id: '2' }] } });
      const res = await api.getChannelFollowers('1', '2');
      expect(requests[0].params).toEqual({ broadcaster_id: '1', user_id: '2' });
      expect(res.total).toBe(1);
      expect(res.cursor).toBeUndefined();
    });

    it('getChannelFollowers returns an empty result on error', async () => {
      replies.push(new Error('timeout'));
      await expect(api.getChannelFollowers('1')).resolves.toEqual({ data: [], total: 0 });
    });

    it('updateChannel patches and reports Twitch error messages', async () => {
      replies.push({ status: 204 }, { status: 400, data: { message: 'bad title' } }, new Error('net'));

      await expect(api.updateChannel('1', { title: 'New' })).resolves.toEqual({ success: true });
      expect(requests[0]).toMatchObject({
        method: 'patch', url: '/channels', params: { broadcaster_id: '1' }, data: { title: 'New' }
      });
      await expect(api.updateChannel('1', { title: '' })).resolves.toEqual({ success: false, error: 'bad title' });
      await expect(api.updateChannel('1', {})).resolves.toEqual({ success: false, error: 'net' });
      expect(errorSpy).toHaveBeenCalledWith('Error updating channel:', 'bad title');
    });
  });

  describe('streams', () => {
    const rawStream = {
      id: 's', user_id: 'u', user_login: 'l', user_name: 'N', game_id: 'g', game_name: 'G',
      type: 'live', title: 'T', viewer_count: 5, started_at: '2022-02-02T00:00:00Z',
      thumbnail_url: 't.jpg', language: 'en', is_mature: false
    };

    it('getStreamByUserId maps the stream', async () => {
      replies.push({ status: 200, data: { data: [rawStream] } });
      await expect(api.getStreamByUserId('u')).resolves.toEqual({
        id: 's', userId: 'u', userLogin: 'l', userName: 'N', gameId: 'g', gameName: 'G',
        type: 'live', title: 'T', viewerCount: 5, startedAt: new Date('2022-02-02T00:00:00Z'),
        thumbnailUrl: 't.jpg', language: 'en', isMature: false
      });
      expect(requests[0].params).toEqual({ user_id: 'u' });
    });

    it('getStreamByUserId returns null when offline or on error', async () => {
      replies.push({ status: 200, data: { data: [] } }, { status: 503 });
      await expect(api.getStreamByUserId('u')).resolves.toBeNull();
      await expect(api.getStreamByUserId('u')).resolves.toBeNull();
      expect(errorSpy).toHaveBeenCalledWith('Error getting stream:', 'Request failed with status code 503');
    });

    it('getStreamsByUserIds caps at 100 ids and maps the summary fields', async () => {
      replies.push({ status: 200, data: { data: [rawStream] } });
      const ids = Array.from({ length: 101 }, (_, i) => `u${i}`);

      await expect(api.getStreamsByUserIds(ids)).resolves.toEqual([{
        id: 's', userId: 'u', userLogin: 'l', userName: 'N', gameId: 'g', gameName: 'G',
        title: 'T', viewerCount: 5, startedAt: new Date('2022-02-02T00:00:00Z')
      }]);
      expect((requests[0].params as URLSearchParams).getAll('user_id')).toHaveLength(100);
    });

    it('getStreamsByUserIds returns [] on error', async () => {
      replies.push(new Error('x'));
      await expect(api.getStreamsByUserIds(['u'])).resolves.toEqual([]);
    });
  });

  describe('chat and clips', () => {
    it('sendAnnouncement defaults the colour to primary', async () => {
      await expect(api.sendAnnouncement('b', 'm', 'hi')).resolves.toEqual({ success: true });
      expect(requests[0]).toMatchObject({
        method: 'post', url: '/chat/announcements',
        params: { broadcaster_id: 'b', moderator_id: 'm' }, data: { message: 'hi', color: 'primary' }
      });
    });

    it('sendShoutout posts the three ids', async () => {
      replies.push({ status: 204 }, { status: 429, data: { message: 'cooldown' } });
      await expect(api.sendShoutout('a', 'b', 'm')).resolves.toEqual({ success: true });
      expect(requests[0]).toMatchObject({
        url: '/chat/shoutouts',
        params: { from_broadcaster_id: 'a', to_broadcaster_id: 'b', moderator_id: 'm' }
      });
      await expect(api.sendShoutout('a', 'b', 'm')).resolves.toEqual({ success: false, error: 'cooldown' });
    });

    it('createClip returns the clip id and edit url', async () => {
      replies.push({ status: 202, data: { data: [{ id: 'c1', edit_url: 'https://e' }] } });
      await expect(api.createClip('b')).resolves.toEqual({ success: true, clipId: 'c1', editUrl: 'https://e' });
      expect(requests[0]).toMatchObject({ method: 'post', url: '/clips', params: { broadcaster_id: 'b' } });
      // No request body: broadcaster_id goes in the query string
      expect(requests[0].data).toBeUndefined();
    });

    it('createClip reports missing data and errors', async () => {
      replies.push({ status: 202, data: {} }, { status: 404, data: { message: 'offline' } });
      await expect(api.createClip('b')).resolves.toEqual({ success: false, error: 'No clip data returned' });
      await expect(api.createClip('b')).resolves.toEqual({ success: false, error: 'offline' });
      expect(errorSpy).toHaveBeenCalledWith('Error creating clip:', 'offline');
    });
  });

  describe('moderation', () => {
    it('timeoutUser sends duration and reason wrapped in data, as Helix Ban User expects', async () => {
      await expect(api.timeoutUser('b', 'm', 'u', 60, 'spam')).resolves.toEqual({ success: true });
      expect(requests[0]).toMatchObject({
        url: '/moderation/bans', params: { broadcaster_id: 'b', moderator_id: 'm' },
        data: { data: { user_id: 'u', duration: 60, reason: 'spam' } }
      });
    });

    it('timeoutUser defaults the reason and reports errors', async () => {
      replies.push({ status: 200 }, { status: 400, data: { message: 'already banned' } });
      await api.timeoutUser('b', 'm', 'u', 10);
      expect(requests[0].data).toEqual({ data: { user_id: 'u', duration: 10, reason: '' } });
      await expect(api.timeoutUser('b', 'm', 'u', 10)).resolves.toEqual({ success: false, error: 'already banned' });
    });

    it('banUser sends no duration', async () => {
      replies.push({ status: 200 }, new Error('net'));
      await expect(api.banUser('b', 'm', 'u')).resolves.toEqual({ success: true });
      expect(requests[0].data).toEqual({ data: { user_id: 'u', reason: '' } });
      await expect(api.banUser('b', 'm', 'u', 'r')).resolves.toEqual({ success: false, error: 'net' });
      expect(errorSpy).toHaveBeenCalledWith('Error banning user:', 'net');
    });
  });

  describe('deleteChatMessage', () => {
    it('sends DELETE /moderation/chat with the three ids', async () => {
      replies.push({ status: 204 }, { status: 403, data: { message: 'not a moderator' } });
      await expect(api.deleteChatMessage('b', 'm', 'msg-1')).resolves.toEqual({ success: true });
      expect(requests[0]).toMatchObject({
        method: 'delete', url: '/moderation/chat',
        params: { broadcaster_id: 'b', moderator_id: 'm', message_id: 'msg-1' }
      });
      expect(requests[0].headers).toMatchObject({ Authorization: 'Bearer tok' });
      await expect(api.deleteChatMessage('b', 'm', 'msg-2')).resolves.toEqual({ success: false, error: 'not a moderator' });
      expect(errorSpy).toHaveBeenCalledWith('Error deleting chat message:', 'not a moderator');
    });
  });

  describe('throwOnError lookups', () => {
    it('getUserByName rethrows API errors but still returns null for an unknown user', async () => {
      replies.push({ status: 200, data: { data: [] } }, { status: 500, data: { message: 'boom' } });
      await expect(api.getUserByName('foo', { throwOnError: true })).resolves.toBeNull();
      await expect(api.getUserByName('foo', { throwOnError: true })).rejects.toMatchObject({ response: { status: 500 } });
    });

    it('getChannelFollowers rethrows API errors', async () => {
      replies.push({ status: 403, data: { message: 'Missing scope' } });
      await expect(api.getChannelFollowers('b', 'u', { throwOnError: true })).rejects.toMatchObject({ response: { status: 403 } });
      expect(requests[0].params).toEqual({ broadcaster_id: 'b', user_id: 'u' });
    });

    it('getStreamByUserId rethrows API errors but returns null when offline', async () => {
      replies.push({ status: 200, data: { data: [] } }, new Error('down'));
      await expect(api.getStreamByUserId('7', { throwOnError: true })).resolves.toBeNull();
      await expect(api.getStreamByUserId('7', { throwOnError: true })).rejects.toThrow('down');
    });
  });

  describe('games', () => {
    it('getGameByName maps the game or returns null', async () => {
      replies.push(
        { status: 200, data: { data: [{ id: '1', name: 'Chess', box_art_url: 'a' }] } },
        { status: 200, data: { data: [] } },
        new Error('x')
      );
      await expect(api.getGameByName('Chess')).resolves.toEqual({ id: '1', name: 'Chess', boxArtUrl: 'a' });
      expect(requests[0]).toMatchObject({ url: '/games', params: { name: 'Chess' } });
      await expect(api.getGameByName('None')).resolves.toBeNull();
      await expect(api.getGameByName('Err')).resolves.toBeNull();
    });

    it('searchCategories maps results and returns [] on error', async () => {
      replies.push({ status: 200, data: { data: [{ id: '1', name: 'Chess', box_art_url: 'a' }] } }, { status: 200, data: {} }, new Error('x'));
      await expect(api.searchCategories('ch')).resolves.toEqual([{ id: '1', name: 'Chess', boxArtUrl: 'a' }]);
      expect(requests[0]).toMatchObject({ url: '/search/categories', params: { query: 'ch' } });
      await expect(api.searchCategories('ch')).resolves.toEqual([]);
      await expect(api.searchCategories('ch')).resolves.toEqual([]);
      expect(errorSpy).toHaveBeenCalledWith('Error searching categories:', 'x');
    });
  });

  describe('polls and predictions', () => {
    it('createPoll posts the options and returns the raw poll', async () => {
      const options = { broadcaster_id: 'b', title: 'Q', choices: [{ title: 'A' }], duration: 60 };
      replies.push({ status: 200, data: { data: [{ id: 'p' }] } }, { status: 400, data: { message: 'bad' } });

      await expect(api.createPoll(options)).resolves.toEqual({ success: true, poll: { id: 'p' } });
      expect(requests[0]).toMatchObject({ method: 'post', url: '/polls', data: options });
      await expect(api.createPoll(options)).resolves.toEqual({ success: false, error: 'bad' });
    });

    it('endPoll defaults to TERMINATED', async () => {
      replies.push({ status: 200, data: { data: [{ id: 'p' }] } }, { status: 200, data: {} }, new Error('net'));
      await expect(api.endPoll('b', 'p')).resolves.toEqual({ success: true, poll: { id: 'p' } });
      expect(requests[0]).toMatchObject({ method: 'patch', url: '/polls', data: { broadcaster_id: 'b', id: 'p', status: 'TERMINATED' } });
      await expect(api.endPoll('b', 'p', 'ARCHIVED')).resolves.toEqual({ success: true, poll: undefined });
      expect(requests[1].data.status).toBe('ARCHIVED');
      await expect(api.endPoll('b', 'p')).resolves.toEqual({ success: false, error: 'net' });
    });

    it('createPrediction posts the options and returns the raw prediction', async () => {
      replies.push({ status: 200, data: { data: [{ id: 'pr' }] } }, new Error('net'));
      await expect(api.createPrediction({ title: 'Q' })).resolves.toEqual({ success: true, prediction: { id: 'pr' } });
      expect(requests[0]).toMatchObject({ url: '/predictions', data: { title: 'Q' } });
      await expect(api.createPrediction({})).resolves.toEqual({ success: false, error: 'net' });
      expect(errorSpy).toHaveBeenCalledWith('Error creating prediction:', 'net');
    });

    it('resolvePrediction only sends winning_outcome_id when given', async () => {
      replies.push({ status: 200, data: { data: [{ id: 'pr' }] } }, { status: 200, data: {} }, { status: 400, data: { message: 'no' } });

      await expect(api.resolvePrediction('b', 'pr', 'RESOLVED', 'o1')).resolves.toEqual({ success: true, prediction: { id: 'pr' } });
      expect(requests[0]).toMatchObject({
        method: 'patch', url: '/predictions',
        data: { broadcaster_id: 'b', id: 'pr', status: 'RESOLVED', winning_outcome_id: 'o1' }
      });
      await api.resolvePrediction('b', 'pr', 'CANCELED');
      expect(requests[1].data).toEqual({ broadcaster_id: 'b', id: 'pr', status: 'CANCELED' });
      await expect(api.resolvePrediction('b', 'pr', 'LOCKED')).resolves.toEqual({ success: false, error: 'no' });
    });
  });

  describe('401 interceptor', () => {
    it('shares one refresh between concurrent 401s and retries each with the new token', async () => {
      let resolveRefresh!: (v: { accessToken: string; refreshToken: string }) => void;
      const refresh = jest.fn(() => new Promise<{ accessToken: string; refreshToken: string }>(r => { resolveRefresh = r; }));
      api.setOnTokenRefresh(refresh);
      replies.push({ status: 401 }, { status: 401 }, { status: 200, data: { data: [] } }, { status: 200, data: { data: [] } });

      const both = Promise.all([api.getUserById('1'), api.getUserById('2')]);
      await new Promise(r => setImmediate(r));
      resolveRefresh({ accessToken: 'fresh', refreshToken: 'r' });
      await both;

      expect(refresh).toHaveBeenCalledTimes(1);
      expect(requests.map(r => r.headers.Authorization)).toEqual(['Bearer tok', 'Bearer tok', 'Bearer fresh', 'Bearer fresh']);
      expect(api.accessToken).toBe('fresh');
    });

    it('starts a new refresh for a later 401 once the previous one settled', async () => {
      const refresh = jest.fn()
        .mockResolvedValueOnce({ accessToken: 't2', refreshToken: 'r' })
        .mockResolvedValueOnce({ accessToken: 't3', refreshToken: 'r' });
      api.setOnTokenRefresh(refresh);
      replies.push({ status: 401 }, { status: 200, data: {} }, { status: 401 }, { status: 200, data: {} });

      await api.getUserById('1');
      await api.getUserById('1');

      expect(refresh).toHaveBeenCalledTimes(2);
      expect(api.accessToken).toBe('t3');
    });

    // Fixed in the migration: a synchronous throw used to leave a settled refresh
    // promise behind, so no later 401 ever refreshed again
    it('refreshes again after a callback that threw synchronously', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      const refresh = jest.fn()
        .mockImplementationOnce(() => { throw new Error('sync boom'); })
        .mockResolvedValueOnce({ accessToken: 't2', refreshToken: 'r' });
      api.setOnTokenRefresh(refresh);
      replies.push({ status: 401 }, { status: 401 }, { status: 200, data: { data: [] } });

      await api.getUserById('1');
      await api.getUserById('1');

      expect(refresh).toHaveBeenCalledTimes(2);
      expect(api.accessToken).toBe('t2');
      expect(console.error).toHaveBeenCalledWith('Token refresh after 401 failed:', 'sync boom');
    });

    // Fixed in the migration: a rejection with no error object used to surface as a TypeError
    it('fails with the original 401 when the callback rejects with nothing', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      const refresh = jest.fn().mockRejectedValue(undefined);
      api.setOnTokenRefresh(refresh);
      replies.push({ status: 401 });

      await expect(api.http.get('/users', { headers: { Authorization: 'Bearer tok' } })).rejects.toMatchObject({ response: { status: 401 } });
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalledWith('Token refresh after 401 failed:', undefined);
    });

    it('fails with the original 401 (not a TypeError) when the callback rejects with null', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      api.setOnTokenRefresh(jest.fn().mockRejectedValue(null));
      replies.push({ status: 401 });

      await expect(api.http.get('/users', { headers: { Authorization: 'Bearer tok' } })).rejects.toMatchObject({ response: { status: 401 } });
      expect(console.error).toHaveBeenCalledWith('Token refresh after 401 failed:', null);
    });

    it('treats a refresh result without an access token as failure', async () => {
      api.setOnTokenRefresh(jest.fn().mockResolvedValue({ accessToken: '', refreshToken: 'r' }));
      replies.push({ status: 401 });

      await expect(api.http.get('/users', { headers: api.getHeaders() })).rejects.toMatchObject({ response: { status: 401 } });
      expect(api.accessToken).toBe('tok');
      expect(requests).toHaveLength(1);
    });

    it('logs the refresh error message when the callback rejects', async () => {
      api.setOnTokenRefresh(jest.fn().mockRejectedValue(new Error('refresh exploded')));
      replies.push({ status: 401 });

      await expect(api.getUserById('1')).resolves.toBeNull();
      expect(errorSpy).toHaveBeenCalledWith('Token refresh after 401 failed:', 'refresh exploded');
    });

    it('passes non-401 errors through even with a refresh callback', async () => {
      const refresh = jest.fn();
      api.setOnTokenRefresh(refresh);
      replies.push({ status: 403 }, new Error('ECONNRESET'));

      await expect(api.http.get('/users')).rejects.toMatchObject({ response: { status: 403 } });
      await expect(api.http.get('/users')).rejects.toThrow('ECONNRESET');
      expect(refresh).not.toHaveBeenCalled();
    });

    it('does not retry a request that was already retried', async () => {
      const refresh = jest.fn();
      api.setOnTokenRefresh(refresh);
      replies.push({ status: 401 });

      await expect(api.http.get('/users', { _retried: true } as any)).rejects.toMatchObject({ response: { status: 401 } });
      expect(refresh).not.toHaveBeenCalled();
      expect(requests).toHaveLength(1);
    });

    it('setOnTokenRefresh(null) disables the retry', async () => {
      api.setOnTokenRefresh(jest.fn());
      api.setOnTokenRefresh(null);
      replies.push({ status: 401 });
      await expect(api.http.get('/users', { headers: api.getHeaders() })).rejects.toMatchObject({ response: { status: 401 } });
      expect(requests).toHaveLength(1);
    });
  });
});
