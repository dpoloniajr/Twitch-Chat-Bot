/**
 * Regression tests for TwitchHelixAPI.sendAnnouncement
 * Covers the 401 token-expiry bug (issue #6889)
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const TwitchHelixAPI = require('../../lib/twitch-helix-api');

describe('TwitchHelixAPI.sendAnnouncement', () => {
  let api: any;
  let mockPost: jest.Mock;

  beforeEach(() => {
    api = new TwitchHelixAPI({ clientId: 'test-client', accessToken: 'initial-token' });
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
