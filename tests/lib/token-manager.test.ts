/**
 * Tests for src/lib/token-manager.ts: validation, refresh, persistence and the
 * proactive refresh timer.
 *
 * Regression: the old proactive refresh in Excella.js left its in-progress
 * flag set after the first successful refresh, so every later refresh was
 * skipped and the bot token expired a few hours into a stream.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TokenManager, createTokenPersister } = require('../../src/lib/token-manager');

const MIN = 60 * 1000;
const LEAD = 5 * MIN;

type HttpMock = { get: jest.Mock; post: jest.Mock };

function silentLogger() {
  return { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function validateResponse(expiresInSec: number, scopes: string[] = ['chat:read']) {
  return { data: { expires_in: expiresInSec, scopes, client_id: 'cid', login: 'bot' } };
}

function tokenResponse(n: number, extra: Record<string, unknown> = {}) {
  return {
    data: {
      access_token: `access-${n}`,
      refresh_token: `refresh-${n}`,
      expires_in: 4 * 60 * 60,
      scope: ['chat:read', 'chat:edit'],
      token_type: 'bearer',
      ...extra
    }
  };
}

function httpError(status: number, message: string) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { status, message } }
  });
}

/** Flush pending promise callbacks (enough rounds for nested awaits). */
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('TokenManager', () => {
  let http: HttpMock;
  let logger: ReturnType<typeof silentLogger>;
  let now: number;

  const make = (opts: Record<string, unknown> = {}) =>
    new TokenManager({
      clientId: 'cid',
      clientSecret: 'secret',
      tokens: {
        bot: { accessToken: 'access-0', refreshToken: 'refresh-0' },
        ...((opts.tokens as object) || {})
      },
      http,
      logger,
      now: () => now,
      ...opts
    });

  beforeEach(() => {
    http = { get: jest.fn(), post: jest.fn() };
    logger = silentLogger();
    now = 1_000_000_000_000;
  });

  describe('validate', () => {
    it('returns true for a token with plenty of time left and stores scopes and expiry', async () => {
      http.get.mockResolvedValueOnce(validateResponse(3600, ['chat:read', 'moderator:manage:announcements']));
      const tm = make();

      await expect(tm.validate('bot')).resolves.toBe(true);
      expect(tm.cache.bot).toMatchObject({
        isValid: true,
        expiresAt: now + 3600 * 1000,
        scopes: ['chat:read', 'moderator:manage:announcements']
      });
      expect(http.get).toHaveBeenCalledWith(
        'https://id.twitch.tv/oauth2/validate',
        { headers: { Authorization: 'OAuth access-0' } }
      );
    });

    it('uses the cached result while it is fresh, and force bypasses it', async () => {
      http.get.mockResolvedValue(validateResponse(3600));
      const tm = make();

      await tm.validate('bot');
      await tm.validate('bot');
      expect(http.get).toHaveBeenCalledTimes(1);

      await tm.validate('bot', { force: true });
      expect(http.get).toHaveBeenCalledTimes(2);
    });

    it('re-validates once the cached expiry is inside the lead window', async () => {
      http.get.mockResolvedValue(validateResponse(10 * 60));
      const tm = make();
      await tm.validate('bot');

      now += 6 * MIN; // 4 minutes left: inside the 5-minute lead
      await tm.validate('bot');
      expect(http.get).toHaveBeenCalledTimes(2);
    });

    it('treats a token expiring within the lead window as invalid', async () => {
      http.get.mockResolvedValueOnce(validateResponse(4 * 60));
      await expect(make().validate('bot')).resolves.toBe(false);
    });

    it('treats a token expiring exactly at the lead boundary as invalid', async () => {
      http.get.mockResolvedValueOnce(validateResponse(LEAD / 1000));
      await expect(make().validate('bot')).resolves.toBe(false);
    });

    it('returns false and clears the expiry on 401', async () => {
      http.get.mockRejectedValueOnce(httpError(401, 'invalid access token'));
      const tm = make();
      tm.cache.bot.expiresAt = now + 3600 * 1000;

      await expect(tm.validate('bot')).resolves.toBe(false);
      expect(tm.cache.bot.expiresAt).toBe(0);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('returns false and logs on a network error', async () => {
      http.get.mockRejectedValueOnce(new Error('ECONNRESET'));
      await expect(make().validate('bot')).resolves.toBe(false);
      expect(logger.error).toHaveBeenCalled();
    });

    it('returns false without calling Twitch when there is no token', async () => {
      const tm = make();
      await expect(tm.validate('broadcaster')).resolves.toBe(false);
      expect(http.get).not.toHaveBeenCalled();
    });
  });

  describe('refresh', () => {
    it('sends a form-encoded refresh request and applies the new tokens', async () => {
      http.post.mockResolvedValueOnce(tokenResponse(1));
      const persist = jest.fn().mockResolvedValue(undefined);
      const listener = jest.fn();
      const tm = make({ persist });
      tm.onRefreshed(listener);

      const result = await tm.refresh('bot');

      expect(result).toEqual({ accessToken: 'access-1', refreshToken: 'refresh-1' });
      const [url, body, config] = http.post.mock.calls[0];
      expect(url).toBe('https://id.twitch.tv/oauth2/token');
      expect(config.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      expect(Object.fromEntries(new URLSearchParams(body))).toEqual({
        client_id: 'cid',
        client_secret: 'secret',
        grant_type: 'refresh_token',
        refresh_token: 'refresh-0'
      });
      expect(tm.getAccessToken('bot')).toBe('access-1');
      expect(tm.cache.bot).toMatchObject({ isValid: true, expiresAt: now + 4 * 60 * 60 * 1000 });
      expect(persist).toHaveBeenCalledWith('bot', {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        scopes: ['chat:read', 'chat:edit'],
        expiresIn: 4 * 60 * 60
      });
      expect(listener).toHaveBeenCalledWith('bot', { accessToken: 'access-1', refreshToken: 'refresh-1' });
    });

    it('URL-encodes refresh tokens with reserved characters', async () => {
      http.post.mockResolvedValueOnce(tokenResponse(1));
      const tm = make({ tokens: { bot: { accessToken: 'a', refreshToken: 'abc+/=&x' } } });

      await tm.refresh('bot');

      const body = http.post.mock.calls[0][1];
      expect(new URLSearchParams(body).get('refresh_token')).toBe('abc+/=&x');
    });

    it('shares one request between concurrent callers', async () => {
      let resolvePost: (v: unknown) => void = () => {};
      http.post.mockReturnValueOnce(new Promise((r) => { resolvePost = r; }));
      const tm = make();

      const a = tm.refresh('bot');
      const b = tm.refresh('bot');
      resolvePost(tokenResponse(1));

      await expect(Promise.all([a, b])).resolves.toEqual([
        { accessToken: 'access-1', refreshToken: 'refresh-1' },
        { accessToken: 'access-1', refreshToken: 'refresh-1' }
      ]);
      expect(http.post).toHaveBeenCalledTimes(1);
    });

    it('refreshes bot and broadcaster tokens independently', async () => {
      http.post
        .mockResolvedValueOnce(tokenResponse(1))
        .mockResolvedValueOnce(tokenResponse(2));
      const tm = make({
        tokens: {
          bot: { accessToken: 'b0', refreshToken: 'br0' },
          broadcaster: { accessToken: 'c0', refreshToken: 'cr0' }
        }
      });

      await Promise.all([tm.refresh('bot'), tm.refresh('broadcaster')]);

      expect(http.post).toHaveBeenCalledTimes(2);
      const sent = http.post.mock.calls.map((c) => new URLSearchParams(c[1]).get('refresh_token'));
      expect(sent.sort()).toEqual(['br0', 'cr0']);
    });

    it('makes a fresh request after a previous one finished', async () => {
      http.post
        .mockRejectedValueOnce(new Error('ETIMEDOUT'))
        .mockResolvedValueOnce(tokenResponse(1));
      const tm = make();

      await expect(tm.refresh('bot')).resolves.toBeNull();
      await expect(tm.refresh('bot')).resolves.toEqual({ accessToken: 'access-1', refreshToken: 'refresh-1' });
      expect(http.post).toHaveBeenCalledTimes(2);
    });

    it('returns null without a request when there is no refresh token', async () => {
      const tm = make({ tokens: { bot: { accessToken: 'a', refreshToken: '' } } });
      await expect(tm.refresh('bot')).resolves.toBeNull();
      expect(http.post).not.toHaveBeenCalled();
    });

    it('returns null and explains how to fix a rejected refresh token', async () => {
      http.post.mockRejectedValueOnce(httpError(400, 'Invalid refresh token'));
      const persist = jest.fn();
      const tm = make({ persist });

      await expect(tm.refresh('bot')).resolves.toBeNull();
      const logged = logger.error.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(logged).toContain('Invalid refresh token (HTTP 400)');
      expect(logged).toContain('Re-authorize the bot account');
      expect(persist).not.toHaveBeenCalled();
      expect(tm.getAccessToken('bot')).toBe('access-0');
    });

    it('returns null when Twitch answers without an access token', async () => {
      http.post.mockResolvedValueOnce({ data: {} });
      await expect(make().refresh('bot')).resolves.toBeNull();
    });

    it('keeps the old refresh token when Twitch does not send a new one', async () => {
      http.post.mockResolvedValueOnce(tokenResponse(1, { refresh_token: undefined }));
      const tm = make();
      await expect(tm.refresh('bot')).resolves.toEqual({ accessToken: 'access-1', refreshToken: 'refresh-0' });
    });

    it('keeps the cached scopes when Twitch does not send any', async () => {
      http.post.mockResolvedValueOnce(tokenResponse(1, { scope: undefined }));
      const persist = jest.fn();
      const tm = make({ persist });
      tm.cache.bot.scopes = ['chat:read'];

      await tm.refresh('bot');
      expect(tm.cache.bot.scopes).toEqual(['chat:read']);
      expect(persist.mock.calls[0][1].scopes).toEqual(['chat:read']);
    });

    it('still returns and applies the tokens when saving them fails', async () => {
      http.post.mockResolvedValueOnce(tokenResponse(1));
      const listener = jest.fn();
      const tm = make({ persist: jest.fn().mockRejectedValue(new Error('EACCES: .env')) });
      tm.onRefreshed(listener);

      await expect(tm.refresh('bot')).resolves.toEqual({ accessToken: 'access-1', refreshToken: 'refresh-1' });
      expect(listener).toHaveBeenCalled();
      expect(logger.error.mock.calls.flat().join(' ')).toContain('could not save it');
    });

    it('still returns the tokens when a listener throws', async () => {
      http.post.mockResolvedValueOnce(tokenResponse(1));
      const second = jest.fn();
      const tm = make();
      tm.onRefreshed(() => { throw new Error('IRC reconnect failed'); });
      tm.onRefreshed(second);

      await expect(tm.refresh('bot')).resolves.toEqual({ accessToken: 'access-1', refreshToken: 'refresh-1' });
      expect(second).toHaveBeenCalled();
    });
  });

  describe('ensureValid', () => {
    it('does not refresh a valid token', async () => {
      http.get.mockResolvedValueOnce(validateResponse(3600));
      await expect(make().ensureValid('bot')).resolves.toBe(true);
      expect(http.post).not.toHaveBeenCalled();
    });

    it('refreshes an expired token and re-validates the new one', async () => {
      http.get
        .mockRejectedValueOnce(httpError(401, 'invalid access token'))
        .mockResolvedValueOnce(validateResponse(4 * 3600, ['chat:read', 'chat:edit', 'clips:edit']));
      http.post.mockResolvedValueOnce(tokenResponse(1));
      const tm = make();

      await expect(tm.ensureValid('bot')).resolves.toBe(true);
      expect(http.get.mock.calls[1][1].headers.Authorization).toBe('OAuth access-1');
      expect(tm.cache.bot.scopes).toEqual(['chat:read', 'chat:edit', 'clips:edit']);
    });

    it('returns false when the refresh fails', async () => {
      http.get.mockRejectedValueOnce(httpError(401, 'invalid access token'));
      http.post.mockRejectedValueOnce(httpError(400, 'Invalid refresh token'));
      await expect(make().ensureValid('bot')).resolves.toBe(false);
    });
  });

  describe('proactive refresh timer', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    const makeTimed = (opts: Record<string, unknown> = {}) =>
      make({ now: () => Date.now(), ...opts });

    /** Twitch mock: validate reports the remaining lifetime of whatever token was sent. */
    function fakeTwitch(lifetimeSec = 4 * 3600) {
      const issuedAt: Record<string, number> = { 'access-0': Date.now() };
      let n = 0;
      http.get.mockImplementation(async (_url: string, cfg: { headers: { Authorization: string } }) => {
        const token = cfg.headers.Authorization.replace('OAuth ', '');
        const left = Math.floor((issuedAt[token] + lifetimeSec * 1000 - Date.now()) / 1000);
        if (!(token in issuedAt) || left <= 0) throw httpError(401, 'invalid access token');
        return validateResponse(left);
      });
      http.post.mockImplementation(async () => {
        n += 1;
        issuedAt[`access-${n}`] = Date.now();
        return tokenResponse(n, { expires_in: lifetimeSec });
      });
    }

    it('keeps refreshing on every cycle, not just the first (regression)', async () => {
      fakeTwitch();
      const tm = makeTimed();
      await tm.ensureValid('bot');
      tm.scheduleProactiveRefresh();

      for (let cycle = 1; cycle <= 3; cycle++) {
        await jest.advanceTimersByTimeAsync(4 * 3600 * 1000 - LEAD);
        await flush();
        expect(http.post).toHaveBeenCalledTimes(cycle);
        expect(tm.getAccessToken('bot')).toBe(`access-${cycle}`);
      }
      tm.stop();
    });

    it('fires the first refresh five minutes before expiry', async () => {
      fakeTwitch();
      const tm = makeTimed();
      await tm.ensureValid('bot');
      tm.scheduleProactiveRefresh();

      await jest.advanceTimersByTimeAsync(4 * 3600 * 1000 - LEAD - 1000);
      expect(http.post).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1000);
      await flush();
      expect(http.post).toHaveBeenCalledTimes(1);
      tm.stop();
    });

    it('refreshes even when the timer fires slightly early', async () => {
      // Validation at fire time still reports just over five minutes left
      fakeTwitch();
      const tm = makeTimed();
      await tm.ensureValid('bot');
      tm.cache.bot.expiresAt += 30 * 1000; // scheduler believes expiry is 30s later than Twitch does
      tm.scheduleProactiveRefresh();

      await jest.advanceTimersByTimeAsync(4 * 3600 * 1000 - LEAD + 30 * 1000);
      await flush();
      expect(http.post).toHaveBeenCalledTimes(1);
      tm.stop();
    });

    it('retries after two minutes when a proactive refresh fails, then recovers', async () => {
      fakeTwitch();
      const tm = makeTimed();
      await tm.ensureValid('bot');
      tm.scheduleProactiveRefresh();
      http.post.mockRejectedValueOnce(new Error('ETIMEDOUT'));

      await jest.advanceTimersByTimeAsync(4 * 3600 * 1000 - LEAD);
      await flush();
      expect(http.post).toHaveBeenCalledTimes(1);
      expect(tm.getAccessToken('bot')).toBe('access-0');

      await jest.advanceTimersByTimeAsync(2 * MIN);
      await flush();
      expect(http.post).toHaveBeenCalledTimes(2);
      expect(tm.getAccessToken('bot')).toBe('access-1');
      tm.stop();
    });

    it('schedules a retry instead of nothing when the expiry is unknown', async () => {
      http.get.mockRejectedValue(new Error('ENOTFOUND id.twitch.tv'));
      const tm = makeTimed();
      await tm.validate('bot');

      expect(tm.scheduleProactiveRefresh()).toBe(2 * MIN);
      tm.stop();
    });

    it('schedules for whichever of bot and broadcaster expires first', async () => {
      const tm = makeTimed({
        tokens: {
          bot: { accessToken: 'b', refreshToken: 'br' },
          broadcaster: { accessToken: 'c', refreshToken: 'cr' }
        }
      });
      tm.cache.bot.expiresAt = Date.now() + 4 * 3600 * 1000;
      tm.cache.broadcaster.expiresAt = Date.now() + 3600 * 1000;

      expect(tm.scheduleProactiveRefresh()).toBe(3600 * 1000 - LEAD);
      tm.stop();
    });

    it('refreshes only the token that is due', async () => {
      http.get.mockResolvedValue(validateResponse(4 * 3600));
      http.post.mockResolvedValue(tokenResponse(1));
      const tm = makeTimed({
        tokens: {
          bot: { accessToken: 'b', refreshToken: 'br' },
          broadcaster: { accessToken: 'c', refreshToken: 'cr' }
        }
      });
      tm.cache.bot.expiresAt = Date.now() + 4 * 3600 * 1000;
      tm.cache.broadcaster.expiresAt = Date.now() + 3600 * 1000;
      tm.scheduleProactiveRefresh();

      await jest.advanceTimersByTimeAsync(3600 * 1000 - LEAD);
      await flush();
      expect(http.post).toHaveBeenCalledTimes(1);
      expect(new URLSearchParams(http.post.mock.calls[0][1]).get('refresh_token')).toBe('cr');
      tm.stop();
    });

    it('caps very long delays so setTimeout does not overflow', () => {
      const tm = makeTimed();
      tm.cache.bot.expiresAt = Date.now() + 60 * 24 * 3600 * 1000;
      expect(tm.scheduleProactiveRefresh()).toBe(2 ** 31 - 1);
      tm.stop();
    });

    it('does not schedule anything without tokens or after stop()', () => {
      const empty = makeTimed({ tokens: { bot: { accessToken: '', refreshToken: '' } } });
      expect(empty.scheduleProactiveRefresh()).toBeNull();

      const tm = makeTimed();
      tm.cache.bot.expiresAt = Date.now() + 3600 * 1000;
      tm.stop();
      expect(tm.scheduleProactiveRefresh()).toBeNull();
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});

describe('createTokenPersister', () => {
  const tokens = { accessToken: 'new-a', refreshToken: 'new-r', scopes: ['chat:read'], expiresIn: 14400 };

  it('writes bot tokens to .env when no account is selected', async () => {
    const updateEnv = jest.fn().mockResolvedValue('');
    const EnvManager = jest.fn().mockImplementation(() => ({ updateEnv }));
    const persist = createTokenPersister({
      accountName: null, envPath: '/app/.env', AccountManager: jest.fn(), EnvManager, logger: silentLogger()
    });

    await persist('bot', tokens);
    expect(EnvManager).toHaveBeenCalledWith('/app/.env');
    expect(updateEnv).toHaveBeenCalledWith({ TWITCH_ACCESS_TOKEN: 'new-a', TWITCH_REFRESH_TOKEN: 'new-r' });
  });

  it('writes broadcaster tokens to the broadcaster keys', async () => {
    const updateEnv = jest.fn().mockResolvedValue('');
    const EnvManager = jest.fn().mockImplementation(() => ({ updateEnv }));
    const persist = createTokenPersister({
      accountName: null, envPath: '/app/.env', AccountManager: jest.fn(), EnvManager, logger: silentLogger()
    });

    await persist('broadcaster', tokens);
    expect(updateEnv).toHaveBeenCalledWith({
      TWITCH_BROADCASTER_ACCESS_TOKEN: 'new-a',
      TWITCH_BROADCASTER_REFRESH_TOKEN: 'new-r'
    });
  });

  it('updates the selected account instead of .env', async () => {
    const updateTokens = jest.fn();
    const AccountManager = jest.fn().mockImplementation(() => ({
      getAccount: () => ({ tokenScopes: ['old'], broadcasterScopes: ['old-b'] }),
      updateTokens
    }));
    const EnvManager = jest.fn();
    const persist = createTokenPersister({
      accountName: 'main', envPath: '/app/.env', AccountManager, EnvManager, logger: silentLogger()
    });

    await persist('bot', tokens);
    await persist('broadcaster', { ...tokens, scopes: [] });

    expect(EnvManager).not.toHaveBeenCalled();
    expect(updateTokens).toHaveBeenNthCalledWith(1, 'main', {
      accessToken: 'new-a', refreshToken: 'new-r', scopes: ['chat:read'], expiresIn: 14400
    });
    // Empty scopes from Twitch must not wipe the stored ones
    expect(updateTokens).toHaveBeenNthCalledWith(2, 'main', {
      broadcasterAccessToken: 'new-a',
      broadcasterRefreshToken: 'new-r',
      broadcasterScopes: ['old-b'],
      broadcasterExpiresIn: 14400
    });
  });

  it('throws when the selected account no longer exists', async () => {
    const AccountManager = jest.fn().mockImplementation(() => ({ getAccount: () => null }));
    const persist = createTokenPersister({
      accountName: 'gone', envPath: '/app/.env', AccountManager, EnvManager: jest.fn(), logger: silentLogger()
    });
    await expect(persist('bot', tokens)).rejects.toThrow('Account "gone" not found');
  });
});
