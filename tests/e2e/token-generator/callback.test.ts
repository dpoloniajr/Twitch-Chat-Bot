/**
 * Characterization: the OAuth /callback handler (state parsing, token exchange
 * with Twitch mocked, saving to .env or to an account, error pages).
 */

jest.mock('axios', () => {
  const mock = { get: jest.fn(), post: jest.fn() };
  return { __esModule: true, default: mock, ...mock };
});

import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { AxiosMock, Harness, httpError, postJson, quietOutput, startHarness } from './harness';

const mockAxios = axios as unknown as AxiosMock;

const tokenResponse = (scope: unknown = ['chat:read', 'chat:edit']) => ({
  data: { access_token: 'new-at', refresh_token: 'new-rt', expires_in: 14000, scope }
});

describe('GET /callback', () => {
  quietOutput();
  let h: Harness;

  beforeEach(() => {
    mockAxios.get.mockReset();
    mockAxios.post.mockReset();
  });

  afterEach(async () => {
    if (h) await h.close();
  });

  it('shows the Twitch error with its description HTML-escaped, with 400', async () => {
    h = await startHarness({ env: 'A=1\n' });
    const res = await fetch(`${h.base}/callback?error=access_denied&error_description=${encodeURIComponent('<b>no</b>')}`);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('<h1>Auth Error</h1><p>&lt;b&gt;no&lt;/b&gt;</p><a href="/">Back</a>');
    expect(mockAxios.post).not.toHaveBeenCalled();
    const log = fs.readFileSync(path.join(h.logDir, 'token-generator.log'), 'utf8');
    expect(log).toContain('[ERROR] [TokenGenerator] Auth error: access_denied {"error_description":"<b>no</b>"}');
  });

  it('escapes quotes and script tags in the error description', async () => {
    h = await startHarness({ env: 'A=1\n' });
    const payload = `<script>alert("x")</script>'&`;
    const res = await fetch(`${h.base}/callback?error=e&error_description=${encodeURIComponent(payload)}`);
    expect(await res.text()).toBe(
      '<h1>Auth Error</h1><p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&#39;&amp;</p><a href="/">Back</a>');
  });

  it('shows an empty description when Twitch sends only the error', async () => {
    h = await startHarness({ env: 'A=1\n' });
    const res = await fetch(`${h.base}/callback?error=access_denied`);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('<h1>Auth Error</h1><p></p><a href="/">Back</a>');
  });

  it('rejects repeated state, code or error parameters with 400 and saves nothing', async () => {
    h = await startHarness({ env: 'TWITCH_CLIENT_ID=cid\n', accounts: [{ name: 'acct' }] });
    for (const query of ['code=c&state=acct_bot&state=bot', 'code=a&code=b', 'error=x&error=y']) {
      const res = await fetch(`${h.base}/callback?${query}`);
      expect([query, res.status]).toEqual([query, 400]);
      expect(await res.text()).toBe('<h1>Error: Repeated callback parameters</h1>');
    }
    expect(mockAxios.post).not.toHaveBeenCalled();
    expect(h.readEnv()).toBe('TWITCH_CLIENT_ID=cid\n');
  });

  it('sends 400 when there is no code', async () => {
    h = await startHarness({ env: 'A=1\n' });
    const res = await fetch(`${h.base}/callback?state=bot`);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('<h1>Error: No code received</h1>');
  });

  it('exchanges the code and saves bot tokens to .env, backing it up first', async () => {
    h = await startHarness({ env: 'TWITCH_CLIENT_ID=cid\nTWITCH_CLIENT_SECRET=sec\nTWITCH_ACCESS_TOKEN=old\n', port: 3210 });
    mockAxios.post.mockResolvedValueOnce(tokenResponse());

    const res = await fetch(`${h.base}/callback?code=the-code`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<title>Success!</title>');
    expect(html).toContain('<p>Tokens for <strong>bot</strong> have been saved.</p>');
    expect(html).toContain('<p>Account: .env file</p>');

    expect(mockAxios.post).toHaveBeenCalledWith('https://id.twitch.tv/oauth2/token', null, {
      params: {
        client_id: 'cid',
        client_secret: 'sec',
        code: 'the-code',
        grant_type: 'authorization_code',
        redirect_uri: 'http://localhost:3210/callback'
      }
    });
    expect(h.readEnv()).toBe(
      // new keys are appended after the trailing empty line
      'TWITCH_CLIENT_ID=cid\nTWITCH_CLIENT_SECRET=sec\nTWITCH_ACCESS_TOKEN=new-at\n\n' +
      'TWITCH_REFRESH_TOKEN=new-rt\nTWITCH_SCOPES=chat:read chat:edit'
    );
    const backups = h.backups();
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(h.backupDir, backups[0]), 'utf8')).toContain('TWITCH_ACCESS_TOKEN=old');

    const log = fs.readFileSync(path.join(h.logDir, 'token-generator.log'), 'utf8');
    expect(log).toContain('[INFO] [TokenGenerator] Token exchange successful for bot {"accountName":null}');
    expect(log).toContain(`[INFO] [TokenGenerator] Automatic backup created before token update: ${backups[0]}`);
    expect(log).toContain('[INFO] [TokenGenerator] Tokens saved to .env');
  });

  it('saves broadcaster tokens to .env for state=broadcaster, splitting a scope string', async () => {
    h = await startHarness({ env: 'TWITCH_CLIENT_ID=cid\n' });
    mockAxios.post.mockResolvedValueOnce(tokenResponse('bits:read channel:read:redemptions'));
    const res = await fetch(`${h.base}/callback?code=c&state=broadcaster`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Tokens for <strong>broadcaster</strong>');
    expect(h.readEnv()).toBe(
      'TWITCH_CLIENT_ID=cid\n\nTWITCH_BROADCASTER_ACCESS_TOKEN=new-at\nTWITCH_BROADCASTER_REFRESH_TOKEN=new-rt\n' +
      'TWITCH_BROADCASTER_SCOPES=bits:read channel:read:redemptions'
    );
  });

  it('writes an empty scope list when Twitch returns none', async () => {
    h = await startHarness({ env: 'TWITCH_CLIENT_ID=cid' });
    mockAxios.post.mockResolvedValueOnce(tokenResponse(null));
    await fetch(`${h.base}/callback?code=c&state=bot`);
    expect(h.readEnv()).toContain('TWITCH_SCOPES=');
    expect(h.readEnv()).toBe('TWITCH_CLIENT_ID=cid\nTWITCH_ACCESS_TOKEN=new-at\nTWITCH_REFRESH_TOKEN=new-rt\nTWITCH_SCOPES=');
  });

  it('creates .env when it is missing (backup fails with a warning)', async () => {
    h = await startHarness();
    mockAxios.post.mockResolvedValueOnce(tokenResponse());
    const res = await fetch(`${h.base}/callback?code=c`);
    expect(res.status).toBe(200);
    expect(mockAxios.post.mock.calls[0][2].params.client_id).toBeUndefined();
    expect(h.readEnv()).toBe('\nTWITCH_ACCESS_TOKEN=new-at\nTWITCH_REFRESH_TOKEN=new-rt\nTWITCH_SCOPES=chat:read chat:edit');
    expect(h.backups()).toEqual([]);
    const log = fs.readFileSync(path.join(h.logDir, 'token-generator.log'), 'utf8');
    expect(log).toContain('[WARN] [TokenGenerator] Failed to create automatic backup: .env file does not exist');
  });

  it('saves to an account that existed at startup (state name_type)', async () => {
    h = await startHarness({ env: 'TWITCH_CLIENT_ID=cid\n', accounts: [{ name: 'my_acct' }] });
    mockAxios.post.mockResolvedValueOnce(tokenResponse());

    const res = await fetch(`${h.base}/callback?code=c&state=my_acct_bot`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Tokens for <strong>bot</strong>');
    expect(html).toContain('<p>Account: my_acct</p>');

    const stored = h.accounts().getAccount('my_acct');
    expect(stored).toMatchObject({ accessToken: 'new-at', refreshToken: 'new-rt', tokenScopes: ['chat:read', 'chat:edit'] });
    const expiresIn = new Date(stored?.tokenExpiresAt as string).getTime() - Date.now();
    expect(expiresIn).toBeGreaterThan(13900 * 1000);
    expect(expiresIn).toBeLessThanOrEqual(14000 * 1000);
    // .env is still backed up but not changed
    expect(h.readEnv()).toBe('TWITCH_CLIENT_ID=cid\n');
    expect(h.backups()).toHaveLength(1);
    const log = fs.readFileSync(path.join(h.logDir, 'token-generator.log'), 'utf8');
    expect(log).toContain('Token exchange successful for bot {"accountName":"my_acct"}');
    expect(log).toContain('[INFO] [TokenGenerator] Tokens saved to account: my_acct');
  });

  it('saves broadcaster tokens to an account', async () => {
    h = await startHarness({ env: 'TWITCH_CLIENT_ID=cid\n', accounts: [{ name: 'acct' }] });
    mockAxios.post.mockResolvedValueOnce(tokenResponse(['bits:read']));
    await fetch(`${h.base}/callback?code=c&state=acct_broadcaster`);
    expect(h.accounts().getAccount('acct')).toMatchObject({
      accessToken: null,
      broadcasterAccessToken: 'new-at',
      broadcasterRefreshToken: 'new-rt',
      broadcasterScopes: ['bits:read']
    });
  });

  it('treats a state without "_" other than bot/broadcaster as a bot account name', async () => {
    h = await startHarness({ env: 'TWITCH_CLIENT_ID=cid\n', accounts: [{ name: 'acct' }] });
    mockAxios.post.mockResolvedValueOnce(tokenResponse());
    const html = await (await fetch(`${h.base}/callback?code=c&state=acct`)).text();
    expect(html).toContain('Tokens for <strong>bot</strong>');
    expect(h.accounts().getAccount('acct')?.accessToken).toBe('new-at');
  });

  it('treats a state with an unknown "_" suffix as the whole account name (bot tokens)', async () => {
    h = await startHarness({ env: 'TWITCH_CLIENT_ID=cid\n', accounts: [{ name: 'acct' }, { name: 'my_acct' }] });
    mockAxios.post.mockResolvedValueOnce(tokenResponse());
    const html = await (await fetch(`${h.base}/callback?code=c&state=my_acct`)).text();
    expect(html).toContain('Tokens for <strong>bot</strong>');
    expect(html).toContain('<p>Account: my_acct</p>');
    expect(h.accounts().getAccount('my_acct')?.accessToken).toBe('new-at');
    // not saved to an account named by the part before the "_"
    expect(h.accounts().getAccount('acct')?.accessToken).toBeNull();
  });

  it('keeps "_" inside account names that end in a type suffix', async () => {
    h = await startHarness({ env: 'TWITCH_CLIENT_ID=cid\n', accounts: [{ name: 'my_bot_acct' }] });
    mockAxios.post.mockResolvedValueOnce(tokenResponse(['bits:read']));
    const html = await (await fetch(`${h.base}/callback?code=c&state=${encodeURIComponent('my_bot_acct_broadcaster')}`)).text();
    expect(html).toContain('Tokens for <strong>broadcaster</strong>');
    expect(h.accounts().getAccount('my_bot_acct')?.broadcasterAccessToken).toBe('new-at');
  });

  it('decodes an encoded state and escapes the account name on the success page', async () => {
    const name = '<i>a b</i>';
    h = await startHarness({ env: 'TWITCH_CLIENT_ID=cid\n', accounts: [{ name }] });
    mockAxios.post.mockResolvedValueOnce(tokenResponse());
    const html = await (await fetch(`${h.base}/callback?code=c&state=${encodeURIComponent(name + '_bot')}`)).text();
    expect(html).toContain('<p>Account: &lt;i&gt;a b&lt;/i&gt;</p>');
    expect(h.accounts().getAccount(name)?.accessToken).toBe('new-at');
  });

  it('shows an escaped Exchange Failed page for an unknown account', async () => {
    h = await startHarness({ env: 'TWITCH_CLIENT_ID=cid\n' });
    mockAxios.post.mockResolvedValueOnce(tokenResponse());
    const res = await fetch(`${h.base}/callback?code=c&state=${encodeURIComponent('<b>x</b>_bot')}`);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('<h1>Exchange Failed</h1><pre>Account &quot;&lt;b&gt;x&lt;/b&gt;&quot; not found</pre>');
  });

  it('saves to an account created through the API after startup (one shared AccountManager)', async () => {
    h = await startHarness({ env: 'TWITCH_CLIENT_ID=cid\n' });
    await postJson(`${h.base}/api/accounts`, { accountName: 'late', clientId: 'c', clientSecret: 's', broadcasterName: 'b' });
    mockAxios.post.mockResolvedValueOnce(tokenResponse());
    const res = await fetch(`${h.base}/callback?code=c&state=late_bot`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<p>Account: late</p>');
    expect(h.accounts().getAccount('late')).toMatchObject({ name: 'late', accessToken: 'new-at' });
  });

  it('shows tokens saved by the callback in the account routes right away', async () => {
    h = await startHarness({ env: 'TWITCH_CLIENT_ID=cid\n', accounts: [{ name: 'acct' }] });
    mockAxios.post.mockResolvedValueOnce(tokenResponse());
    await fetch(`${h.base}/callback?code=c&state=acct_bot`);
    expect(h.accounts().getAccount('acct')?.accessToken).toBe('new-at');
    const info = (await (await fetch(`${h.base}/api/accounts/acct`)).json()).account;
    expect(info.hasAccessToken).toBe(true);
    expect(info.tokenScopes).toEqual(['chat:read', 'chat:edit']);
  });

  it('does not undo an account created through the API when a callback saves tokens', async () => {
    // with two AccountManager instances, the callback's save overwrote the file without the new account
    h = await startHarness({ env: 'TWITCH_CLIENT_ID=cid\n', accounts: [{ name: 'old' }] });
    await postJson(`${h.base}/api/accounts`, { accountName: 'new', clientId: 'c', clientSecret: 's', broadcasterName: 'b' });
    mockAxios.post.mockResolvedValueOnce(tokenResponse());
    await fetch(`${h.base}/callback?code=c&state=old_bot`);
    const onDisk = h.accounts();
    expect(onDisk.getAccount('new')).not.toBeNull();
    expect(onDisk.getAccount('old')?.accessToken).toBe('new-at');
  });

  it('shows Exchange Failed with 500 when Twitch rejects the code', async () => {
    h = await startHarness({ env: 'TWITCH_CLIENT_ID=cid\n' });
    mockAxios.post.mockRejectedValueOnce(httpError('Request failed with status code 400', { message: 'Invalid authorization code' }));
    const res = await fetch(`${h.base}/callback?code=bad`);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('<h1>Exchange Failed</h1><pre>Request failed with status code 400</pre>');
    const log = fs.readFileSync(path.join(h.logDir, 'token-generator.log'), 'utf8');
    expect(log).toContain('[ERROR] [TokenGenerator] Token exchange failed {"error":{"message":"Invalid authorization code"}}');
    expect(h.readEnv()).toBe('TWITCH_CLIENT_ID=cid\n');
  });
});
