/**
 * Tests for src/lib/account-manager.ts (also loaded through the account-manager.js shim)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AccountManager, ACCOUNTS_FILE, ENCRYPTION_KEY_FILE } from '../../src/lib/account-manager';

describe('AccountManager', () => {
  let dir: string;
  let accountsFile: string;
  let keyFile: string;
  const make = () => new AccountManager({ accountsFile, keyFile });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-'));
    accountsFile = path.join(dir, 'accounts.encrypted.json');
    keyFile = path.join(dir, '.encryption-key');
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('defaults to files in the working folder', () => {
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const am = new AccountManager();
      expect(am.accountsFile).toBe(ACCOUNTS_FILE);
      expect(am.keyFile).toBe(ENCRYPTION_KEY_FILE);
      expect(fs.existsSync(path.join(dir, '.encryption-key'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'accounts.encrypted.json'))).toBe(false);
    } finally {
      process.chdir(cwd);
    }
  });

  describe('encryption key', () => {
    it('creates a 64-hex-char key readable only by the owner, and reuses it', () => {
      const am = make();
      expect(am.encryptionKey).toMatch(/^[0-9a-f]{64}$/);
      if (process.platform !== 'win32') {
        expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
      }
      expect(make().encryptionKey).toBe(am.encryptionKey);
    });

    it('round-trips data and uses a fresh IV each time', () => {
      const am = make();
      const a = am.encrypt({ x: 1 });
      const b = am.encrypt({ x: 1 });
      expect(a.iv).not.toBe(b.iv);
      expect(am.decrypt(a)).toEqual({ x: 1 });
    });

    it('returns null and logs when decryption fails', () => {
      const am = make();
      const enc = am.encrypt({ x: 1 });
      fs.writeFileSync(keyFile, 'ab'.repeat(32));
      expect(make().decrypt(enc)).toBeNull();
      expect(console.error).toHaveBeenCalledWith('Decryption failed (encryption key mismatch?):', expect.any(String));
    });
  });

  describe('storage', () => {
    it('saves accounts encrypted and loads them back', () => {
      make().createAccount('main', 'cid', 'secret', 'caster', ['caster']);
      const raw = fs.readFileSync(accountsFile, 'utf8');
      expect(raw).not.toContain('secret');
      expect(Object.keys(JSON.parse(raw))).toEqual(['main']);
      if (process.platform !== 'win32') {
        expect(fs.statSync(accountsFile).mode & 0o777).toBe(0o600);
      }
      expect(make().getAccount('main')).toMatchObject({ clientId: 'cid', clientSecret: 'secret', channels: ['caster'] });
      expect(console.log).toHaveBeenCalledWith('✓ Loaded 1 account(s)');
    });

    it('drops accounts that cannot be decrypted with the current key', () => {
      const am = make();
      am.createAccount('a', 'cid', 's', 'b');
      const data = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
      data.broken = { iv: '00'.repeat(16), data: 'deadbeef' };
      fs.writeFileSync(accountsFile, JSON.stringify(data));
      expect(Object.keys(make().accounts)).toEqual(['a']);
    });

    it('starts empty when the file is corrupt', () => {
      fs.writeFileSync(accountsFile, '{not json');
      expect(make().accounts).toEqual({});
      expect(console.error).toHaveBeenCalledWith('Failed to load accounts:', expect.any(String));
      expect(fs.existsSync(`${accountsFile}.lock`)).toBe(false);
    });

    it('logs and rethrows when saving fails', () => {
      const am = make();
      fs.mkdirSync(accountsFile);
      expect(() => am.createAccount('a', 'c', 's', 'b')).toThrow();
      expect(console.error).toHaveBeenCalledWith('Failed to save accounts:', expect.any(String));
    });
  });

  describe('accounts', () => {
    it('creates an account with empty token fields', () => {
      const acc = make().createAccount('a', 'cid', 'sec', 'caster');
      expect(acc).toMatchObject({
        name: 'a', clientId: 'cid', clientSecret: 'sec', broadcasterName: 'caster', channels: [],
        accessToken: null, refreshToken: null, tokenScopes: [],
        broadcasterAccessToken: null, broadcasterRefreshToken: null, broadcasterScopes: [],
        tokenExpiresAt: null, broadcasterTokenExpiresAt: null
      });
      expect(Date.parse(acc.createdAt)).not.toBeNaN();
    });

    it('refuses duplicates and unknown names', () => {
      const am = make();
      am.createAccount('a', 'c', 's', 'b');
      expect(() => am.createAccount('a', 'c', 's', 'b')).toThrow('Account "a" already exists');
      expect(am.getAccount('zzz')).toBeNull();
      expect(() => am.updateTokens('zzz', {})).toThrow('Account "zzz" not found');
      expect(() => am.deleteAccount('zzz')).toThrow('Account "zzz" not found');
      expect(() => am.renameAccount('zzz', 'y')).toThrow('Account "zzz" not found');
      expect(() => am.updateAccountSettings('zzz', {})).toThrow('Account "zzz" not found');
      expect(() => am.exportToEnv('zzz')).toThrow('Account "zzz" not found');
      expect(() => am.getAsEnvObject('zzz')).toThrow('Account "zzz" not found');
    });

    it('deletes and renames, persisting each change', () => {
      const am = make();
      am.createAccount('a', 'c', 's', 'b');
      am.createAccount('b', 'c', 's', 'b');
      expect(() => am.renameAccount('a', 'b')).toThrow('Account "b" already exists');
      expect(am.renameAccount('a', 'c').name).toBe('c');
      am.deleteAccount('b');
      expect(Object.keys(make().accounts)).toEqual(['c']);
    });

    it('updates only broadcasterName and channels', () => {
      const am = make();
      am.createAccount('a', 'c', 's', 'b');
      const acc = am.updateAccountSettings('a', { channels: ['x'], clientSecret: 'hack' } as never);
      expect(acc.channels).toEqual(['x']);
      expect(acc.clientSecret).toBe('s');
    });

    it('lists accounts without secrets', () => {
      const am = make();
      am.createAccount('a', 'c', 's', 'b', ['b']);
      am.updateTokens('a', { accessToken: 'at', refreshToken: 'rt', scopes: ['x'], expiresIn: 7200 });
      const [summary] = am.listAccounts();
      expect(summary).toMatchObject({
        name: 'a', broadcasterName: 'b', channels: ['b'], hasAccessToken: true, hasBroadcasterToken: false,
        tokenScopes: ['x'], tokenStatus: 'valid', broadcasterTokenStatus: 'not_authorized'
      });
      expect(JSON.stringify(summary)).not.toMatch(/"at"|"rt"|"s"/);
    });
  });

  describe('tokens', () => {
    beforeEach(() => {
      jest.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
    });
    afterEach(() => jest.useRealTimers());

    it('reports token status by time left', () => {
      const am = make();
      const now = Date.now();
      expect(am.getTokenStatus(null)).toBe('not_authorized');
      expect(am.getTokenStatus(new Date(now - 1).toISOString())).toBe('expired');
      expect(am.getTokenStatus(new Date(now + 59 * 60000).toISOString())).toBe('expiring');
      expect(am.getTokenStatus(new Date(now + 60 * 60000).toISOString())).toBe('valid');
      expect(am.getTokenStatus(now + 61 * 60000)).toBe('valid');
    });

    it('updates bot and broadcaster tokens independently, defaulting expiry to an hour', () => {
      const am = make();
      am.createAccount('a', 'c', 's', 'b');
      am.updateTokens('a', { accessToken: 'at', refreshToken: 'rt' });
      let acc = am.getAccount('a')!;
      expect(acc).toMatchObject({ accessToken: 'at', refreshToken: 'rt', tokenScopes: [], tokenExpiresAt: '2026-01-01T01:00:00.000Z' });
      expect(acc.broadcasterAccessToken).toBeNull();

      am.updateTokens('a', { broadcasterAccessToken: 'bat', broadcasterRefreshToken: 'brt', broadcasterScopes: ['s'], broadcasterExpiresIn: 60 });
      acc = make().getAccount('a')!;
      expect(acc).toMatchObject({ accessToken: 'at', broadcasterAccessToken: 'bat', broadcasterScopes: ['s'], broadcasterTokenExpiresAt: '2026-01-01T00:01:00.000Z' });
    });

    it('refreshTokens applies the result, or keeps the account when the refresher fails', async () => {
      const am = make();
      am.createAccount('a', 'c', 's', 'b');
      await expect(am.refreshTokens('zzz', async () => null)).rejects.toThrow('Account "zzz" not found');
      expect((await am.refreshTokens('a', async () => ({ accessToken: 'n', refreshToken: 'r' }))).accessToken).toBe('n');
      expect((await am.refreshTokens('a', async () => null)).accessToken).toBe('n');
      expect((await am.refreshTokens('a', async () => { throw new Error('nope'); })).accessToken).toBe('n');
      expect(console.error).toHaveBeenCalledWith('Failed to refresh tokens for a:', 'nope');
    });
  });

  describe('.env import and export', () => {
    it('refuses to export an account that has no token', () => {
      const am = make();
      am.createAccount('a', 'c', 's', 'b');
      expect(() => am.exportToEnv('a')).toThrow('Account "a" has not been authorized yet');
      expect(() => am.getAsEnvObject('a')).toThrow('Account "a" has not been authorized yet');
    });

    it('imports an .env and exports it back', () => {
      const am = make();
      const env = [
        '# comment',
        'TWITCH_CLIENT_ID=cid',
        'TWITCH_CLIENT_SECRET=se=cret',
        'TWITCH_ACCESS_TOKEN=at',
        'TWITCH_REFRESH_TOKEN=rt',
        'TWITCH_SCOPES=chat:read chat:edit',
        'TWITCH_BROADCASTER_NAME=caster',
        'TWITCH_CHANNELS=caster,other',
        'TWITCH_BROADCASTER_ACCESS_TOKEN=bat',
        'TWITCH_BROADCASTER_REFRESH_TOKEN=brt',
        'TWITCH_BROADCASTER_SCOPES=bits:read'
      ].join('\r\n');
      am.importFromEnv('a', env);

      const obj = am.getAsEnvObject('a');
      expect(obj).toEqual({
        TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: 'se=cret', TWITCH_ACCESS_TOKEN: 'at', TWITCH_REFRESH_TOKEN: 'rt',
        TWITCH_SCOPES: 'chat:read chat:edit', TWITCH_BROADCASTER_NAME: 'caster', TWITCH_CHANNELS: 'caster,other',
        TWITCH_BROADCASTER_ACCESS_TOKEN: 'bat', TWITCH_BROADCASTER_REFRESH_TOKEN: 'brt', TWITCH_BROADCASTER_SCOPES: 'bits:read'
      });
      const out = am.exportToEnv('a').split('\n');
      expect(out[0]).toBe('# Account: a');
      expect(out).toContain('TWITCH_CHANNELS=caster,other');
      expect(out).toContain('TWITCH_BROADCASTER_SCOPES=bits:read');
    });

    it('leaves broadcaster lines out when there is no broadcaster token', () => {
      const am = make();
      am.importFromEnv('a', 'TWITCH_CLIENT_ID=c\nTWITCH_ACCESS_TOKEN=at\nTWITCH_BROADCASTER_NAME=b');
      expect(am.exportToEnv('a')).not.toContain('BROADCASTER_ACCESS_TOKEN');
      expect(am.getAsEnvObject('a')).toMatchObject({ TWITCH_CHANNELS: '', TWITCH_SCOPES: '', TWITCH_BROADCASTER_ACCESS_TOKEN: '' });
    });

    it('fails an import for a name that already exists', () => {
      const am = make();
      am.createAccount('a', 'c', 's', 'b');
      expect(() => am.importFromEnv('a', 'TWITCH_ACCESS_TOKEN=x')).toThrow('Account "a" already exists');
    });
  });
});
