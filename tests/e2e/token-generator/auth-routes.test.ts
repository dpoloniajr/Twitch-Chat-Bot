/**
 * Characterization: OAuth helper routes (generate-auth-url, validate-token,
 * test-connection) with the Twitch HTTP calls mocked.
 */

jest.mock('axios', () => {
  const mock = { get: jest.fn(), post: jest.fn() };
  return { __esModule: true, default: mock, ...mock };
});

import axios from 'axios';
import { AxiosMock, Harness, httpError, postJson, quietOutput, startHarness } from './harness';

const mockAxios = axios as unknown as AxiosMock;

describe('auth routes', () => {
  quietOutput();
  let h: Harness;

  beforeEach(() => {
    mockAxios.get.mockReset();
    mockAxios.post.mockReset();
  });

  afterEach(async () => {
    if (h) await h.close();
  });

  describe('POST /api/generate-auth-url', () => {
    it('builds the Twitch authorize URL', async () => {
      h = await startHarness({ env: 'TWITCH_CLIENT_ID=my-client\n', port: 3456 });
      const res = await postJson(`${h.base}/api/generate-auth-url`, { scopes: ['chat:read', 'chat:edit'] });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        authUrl: 'https://id.twitch.tv/oauth2/authorize?client_id=my-client&' +
          'redirect_uri=http%3A%2F%2Flocalhost%3A3456%2Fcallback&response_type=code&' +
          'scope=chat%3Aread%20chat%3Aedit&state=bot'
      });
    });

    it('passes accountType through as the URL-encoded state', async () => {
      h = await startHarness({ env: 'TWITCH_CLIENT_ID=c\n' });
      const body = await (await postJson(`${h.base}/api/generate-auth-url`, { scopes: ['a'], accountType: 'my acct&x=1#_broadcaster' })).json();
      expect(body.authUrl).toMatch(/&state=my%20acct%26x%3D1%23_broadcaster$/);
      expect(new URL(body.authUrl).searchParams.get('state')).toBe('my acct&x=1#_broadcaster');
    });

    it('sends 400 (not 500) when the request has no JSON body', async () => {
      h = await startHarness({ env: 'TWITCH_CLIENT_ID=c\n' });
      const res = await fetch(`${h.base}/api/generate-auth-url`, { method: 'POST' });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'No scopes provided' });
    });

    it('requires TWITCH_CLIENT_ID before checking scopes', async () => {
      h = await startHarness({ env: 'OTHER=1\n' });
      const res = await postJson(`${h.base}/api/generate-auth-url`, {});
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'TWITCH_CLIENT_ID not found in .env' });
    });

    it('requires a non-empty scopes array', async () => {
      h = await startHarness({ env: 'TWITCH_CLIENT_ID=c\n' });
      for (const body of [{}, { scopes: 'chat:read' }, { scopes: [] }]) {
        const res = await postJson(`${h.base}/api/generate-auth-url`, body);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'No scopes provided' });
      }
    });

    it('fails with a 500 JSON error when .env cannot be read', async () => {
      h = await startHarness();
      require('fs').mkdirSync(h.envPath);
      const res = await postJson(`${h.base}/api/generate-auth-url`, { scopes: ['a'] });
      expect(res.status).toBe(500);
      expect((await res.json()).success).toBe(false);
    });

    it('only answers POST', async () => {
      h = await startHarness({ env: 'TWITCH_CLIENT_ID=c\n' });
      expect((await fetch(`${h.base}/api/generate-auth-url`)).status).toBe(404);
    });
  });

  describe('GET /api/validate-token', () => {
    it('requires a token', async () => {
      h = await startHarness({ env: 'TWITCH_CLIENT_ID=c\n' });
      const res = await fetch(`${h.base}/api/validate-token`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'No token provided' });
      expect(mockAxios.get).not.toHaveBeenCalled();
    });

    it('rejects a repeated token parameter with 400', async () => {
      h = await startHarness({ env: 'TWITCH_CLIENT_ID=c\n' });
      const res = await fetch(`${h.base}/api/validate-token?token=a&token=b`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'No token provided' });
      expect(mockAxios.get).not.toHaveBeenCalled();
    });

    it('validates the token and looks up the user', async () => {
      h = await startHarness({ env: 'TWITCH_CLIENT_ID=cid\n' });
      mockAxios.get
        .mockResolvedValueOnce({ data: { scopes: ['chat:read'], expires_in: 1234 } })
        .mockResolvedValueOnce({ data: { data: [{ display_name: 'Bot', id: '42' }] } });

      const res = await fetch(`${h.base}/api/validate-token?token=abc`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        success: true, valid: true, username: 'Bot', userId: '42', scopes: ['chat:read'], expiresIn: 1234
      });
      expect(mockAxios.get).toHaveBeenNthCalledWith(1, 'https://id.twitch.tv/oauth2/validate', {
        headers: { Authorization: 'Bearer abc' }
      });
      expect(mockAxios.get).toHaveBeenNthCalledWith(2, 'https://api.twitch.tv/helix/users', {
        headers: { Authorization: 'Bearer abc', 'Client-ID': 'cid' }
      });
    });

    it('defaults scopes to []', async () => {
      h = await startHarness({ env: 'TWITCH_CLIENT_ID=cid\n' });
      mockAxios.get
        .mockResolvedValueOnce({ data: {} })
        .mockResolvedValueOnce({ data: { data: [{ display_name: 'Bot', id: '42' }] } });
      const body = await (await fetch(`${h.base}/api/validate-token?token=abc`)).json();
      expect(body.scopes).toEqual([]);
      expect(body).not.toHaveProperty('expiresIn');
    });

    it('sends 401 with the Twitch message on failure', async () => {
      h = await startHarness({ env: 'TWITCH_CLIENT_ID=cid\n' });
      mockAxios.get.mockRejectedValueOnce(httpError('Request failed', { message: 'invalid access token' }));
      const res = await fetch(`${h.base}/api/validate-token?token=bad`);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ success: false, valid: false, error: 'invalid access token' });
    });

    it('sends 401 with the error message when Twitch sent no message', async () => {
      h = await startHarness({ env: 'TWITCH_CLIENT_ID=cid\n' });
      mockAxios.get.mockRejectedValueOnce(new Error('socket hang up'));
      const res = await fetch(`${h.base}/api/validate-token?token=bad`);
      expect(await res.json()).toEqual({ success: false, valid: false, error: 'socket hang up' });
    });

    it('sends 401 when the user lookup returns no user', async () => {
      h = await startHarness({ env: 'TWITCH_CLIENT_ID=cid\n' });
      mockAxios.get
        .mockResolvedValueOnce({ data: { scopes: [] } })
        .mockResolvedValueOnce({ data: { data: [] } });
      const res = await fetch(`${h.base}/api/validate-token?token=abc`);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ success: false, valid: false, error: 'No Twitch user found for this token' });
    });

    it('sends 401 when the user lookup has no data list', async () => {
      h = await startHarness({ env: 'TWITCH_CLIENT_ID=cid\n' });
      mockAxios.get
        .mockResolvedValueOnce({ data: { scopes: [] } })
        .mockResolvedValueOnce({ data: {} });
      const res = await fetch(`${h.base}/api/validate-token?token=abc`);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ success: false, valid: false, error: 'No Twitch user found for this token' });
    });
  });

  describe('POST /api/test-connection', () => {
    it('requires a token', async () => {
      h = await startHarness({ env: 'TWITCH_CLIENT_ID=cid\n' });
      const res = await postJson(`${h.base}/api/test-connection`, { type: 'bot' });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ success: false, error: 'No token provided' });
    });

    it('sends 400 (not 500) when the request has no JSON body', async () => {
      h = await startHarness({ env: 'TWITCH_CLIENT_ID=cid\n' });
      const res = await fetch(`${h.base}/api/test-connection`, { method: 'POST' });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ success: false, error: 'No token provided' });
    });

    it('looks up the user with the token', async () => {
      h = await startHarness({ env: 'TWITCH_CLIENT_ID=cid\n' });
      mockAxios.get.mockResolvedValueOnce({ data: { data: [{ id: '1', login: 'bot' }] } });
      const res = await postJson(`${h.base}/api/test-connection`, { token: 't', type: 'broadcaster' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        success: true, message: 'Connection test successful for broadcaster', data: { id: '1', login: 'bot' }
      });
      expect(mockAxios.get).toHaveBeenCalledWith('https://api.twitch.tv/helix/users', {
        headers: { Authorization: 'Bearer t', 'Client-ID': 'cid' }
      });
    });

    it('omits data when Twitch returns no user', async () => {
      h = await startHarness({ env: 'TWITCH_CLIENT_ID=cid\n' });
      mockAxios.get.mockResolvedValueOnce({ data: { data: [] } });
      const body = await (await postJson(`${h.base}/api/test-connection`, { token: 't' })).json();
      expect(body).toEqual({ success: true, message: 'Connection test successful for undefined' });
    });

    it('sends 500 on failure', async () => {
      h = await startHarness({ env: 'TWITCH_CLIENT_ID=cid\n' });
      mockAxios.get.mockRejectedValueOnce(httpError('Request failed', { message: 'Unauthorized' }));
      const res = await postJson(`${h.base}/api/test-connection`, { token: 't', type: 'bot' });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' });
    });
  });
});
