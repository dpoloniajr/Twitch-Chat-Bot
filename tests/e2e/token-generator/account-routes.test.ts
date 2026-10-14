/**
 * Characterization: /api/accounts routes (list, get, create, delete, import).
 */

import * as fs from 'fs';
import { Harness, createTokenGenerator, postJson, quietOutput, startHarness } from './harness';

const validAccount = {
  accountName: 'main',
  clientId: 'cid',
  clientSecret: 'shh',
  broadcasterName: 'caster'
};

describe('/api/accounts', () => {
  quietOutput();
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  it('lists no accounts at first', async () => {
    const res = await fetch(`${h.base}/api/accounts`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, accounts: [] });
  });

  describe('POST /', () => {
    it('creates an account and returns its public info, without the client secret or tokens', async () => {
      const res = await postJson(`${h.base}/api/accounts`, { ...validAccount, channels: ['a', 'b'] });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        success: true,
        message: 'Account "main" created',
        account: {
          name: 'main',
          clientId: 'cid',
          broadcasterName: 'caster',
          channels: ['a', 'b'],
          tokenScopes: [],
          broadcasterScopes: [],
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
          hasAccessToken: false,
          hasBroadcasterToken: false,
          tokenStatus: 'not_authorized',
          broadcasterTokenStatus: 'not_authorized'
        }
      });
      expect(fs.existsSync(h.accountsFile)).toBe(true);
      // the secret is still stored, just never sent back
      expect((h.accounts().getAccount('main') as unknown as { clientSecret: string }).clientSecret).toBe('shh');
    });

    it('defaults channels to []', async () => {
      const body = await (await postJson(`${h.base}/api/accounts`, validAccount)).json();
      expect(body.account.channels).toEqual([]);
    });

    it('validates required fields in schema order', async () => {
      let res = await postJson(`${h.base}/api/accounts`, {});
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ success: false, error: 'accountName is required' });

      res = await postJson(`${h.base}/api/accounts`, { ...validAccount, clientSecret: '' });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ success: false, error: 'clientSecret is required' });

      res = await postJson(`${h.base}/api/accounts`, { ...validAccount, clientId: 5 });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ success: false, error: 'clientId must be a string' });
    });

    it('fails with 500 for a duplicate name', async () => {
      await postJson(`${h.base}/api/accounts`, validAccount);
      const res = await postJson(`${h.base}/api/accounts`, validAccount);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ success: false, error: 'Account "main" already exists' });
    });

    it('sends 400 when the request has no JSON body', async () => {
      const res = await fetch(`${h.base}/api/accounts`, { method: 'POST' });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ success: false, error: 'accountName is required' });
    });
  });

  describe('GET /:name', () => {
    it('returns public info without secrets or tokens', async () => {
      await postJson(`${h.base}/api/accounts`, { ...validAccount, channels: ['c'] });
      const res = await fetch(`${h.base}/api/accounts/main`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        success: true,
        account: {
          name: 'main',
          clientId: 'cid',
          broadcasterName: 'caster',
          channels: ['c'],
          tokenScopes: [],
          broadcasterScopes: [],
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
          hasAccessToken: false,
          hasBroadcasterToken: false,
          tokenStatus: 'not_authorized',
          broadcasterTokenStatus: 'not_authorized'
        }
      });
    });

    it('sends 404 for an unknown account', async () => {
      const res = await fetch(`${h.base}/api/accounts/ghost`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ success: false, error: 'Account not found' });
    });

    it('has no export route', async () => {
      await postJson(`${h.base}/api/accounts`, validAccount);
      const res = await fetch(`${h.base}/api/accounts/main/export`);
      expect(res.status).toBe(404);
      expect(await res.text()).toContain('Cannot GET /api/accounts/main/export');
    });
  });

  it('lists created accounts as summaries', async () => {
    await postJson(`${h.base}/api/accounts`, validAccount);
    const body = await (await fetch(`${h.base}/api/accounts`)).json();
    expect(body.accounts).toEqual([{
      name: 'main',
      broadcasterName: 'caster',
      channels: [],
      hasAccessToken: false,
      hasBroadcasterToken: false,
      tokenScopes: [],
      broadcasterScopes: [],
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      tokenStatus: 'not_authorized',
      broadcasterTokenStatus: 'not_authorized'
    }]);
  });

  describe('DELETE /:name', () => {
    it('deletes an account', async () => {
      await postJson(`${h.base}/api/accounts`, validAccount);
      const res = await fetch(`${h.base}/api/accounts/main`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, message: 'Account "main" deleted' });
      expect((await (await fetch(`${h.base}/api/accounts`)).json()).accounts).toEqual([]);
      expect(h.accounts().getAccount('main')).toBeNull();
    });

    it('fails with 500 for an unknown account', async () => {
      const res = await fetch(`${h.base}/api/accounts/ghost`, { method: 'DELETE' });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ success: false, error: 'Account "ghost" not found' });
    });
  });

  describe('POST /import', () => {
    const envContent = [
      '# exported',
      'TWITCH_CLIENT_ID=cid',
      'TWITCH_CLIENT_SECRET=sec=ret',
      'TWITCH_ACCESS_TOKEN=at',
      'TWITCH_REFRESH_TOKEN=rt',
      'TWITCH_SCOPES=chat:read chat:edit',
      'TWITCH_BROADCASTER_NAME=caster',
      'TWITCH_CHANNELS=one,two',
      'TWITCH_BROADCASTER_ACCESS_TOKEN=bat',
      'TWITCH_BROADCASTER_REFRESH_TOKEN=brt',
      'TWITCH_BROADCASTER_SCOPES=bits:read'
    ].join('\n');

    it('requires accountName and envContent', async () => {
      for (const body of [{}, { accountName: 'x' }, { envContent: 'A=1' }]) {
        const res = await postJson(`${h.base}/api/accounts/import`, body);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ success: false, error: 'accountName and envContent are required' });
      }
    });

    it('imports an account with tokens', async () => {
      const res = await postJson(`${h.base}/api/accounts/import`, { accountName: 'imp', envContent });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, message: 'Account imported successfully', name: 'imp' });

      const info = (await (await fetch(`${h.base}/api/accounts/imp`)).json()).account;
      expect(info).toMatchObject({
        name: 'imp',
        clientId: 'cid',
        broadcasterName: 'caster',
        channels: ['one', 'two'],
        tokenScopes: ['chat:read', 'chat:edit'],
        broadcasterScopes: ['bits:read'],
        hasAccessToken: true,
        hasBroadcasterToken: true,
        // imported tokens are given one hour, which is inside the "expiring" window
        tokenStatus: 'expiring',
        broadcasterTokenStatus: 'expiring'
      });
      const stored = h.accounts().getAccount('imp') as unknown as Record<string, unknown>;
      expect(stored.clientSecret).toBe('sec=ret');
      expect(stored.refreshToken).toBe('rt');
      expect(stored.broadcasterRefreshToken).toBe('brt');
    });

    it('sends 400 for a duplicate name', async () => {
      await postJson(`${h.base}/api/accounts/import`, { accountName: 'imp', envContent });
      const res = await postJson(`${h.base}/api/accounts/import`, { accountName: 'imp', envContent });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ success: false, error: 'Account "imp" already exists' });
    });

    it('sends 400 when the request has no JSON body', async () => {
      const res = await fetch(`${h.base}/api/accounts/import`, { method: 'POST' });
      expect(res.status).toBe(400);
      expect((await res.json()).success).toBe(false);
    });
  });

  it('keeps accounts across restarts', async () => {
    await postJson(`${h.base}/api/accounts`, validAccount);
    const again = createTokenGenerator({
      envPath: h.envPath, backupDir: h.backupDir, accountsFile: h.accountsFile, keyFile: h.keyFile, logDir: h.logDir
    });
    const server = await new Promise<import('http').Server>((resolve) => {
      const s = again.app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const port = (server.address() as import('net').AddressInfo).port;
      const body = await (await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();
      expect(body.accounts.map((a: { name: string }) => a.name)).toEqual(['main']);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
