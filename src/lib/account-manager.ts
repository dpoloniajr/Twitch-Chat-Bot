/**
 * Account Manager
 * Handles multi-account storage, encryption, and token management for Twitch OAuth
 */

import * as fs from 'fs';
import * as crypto from 'crypto';
import { withCrossProcessLockSync } from './file-lock';

/** Default file names, relative to the working folder */
export const ACCOUNTS_FILE = 'accounts.encrypted.json';
export const ENCRYPTION_KEY_FILE = '.encryption-key';

export interface Account {
  name: string;
  clientId: string;
  clientSecret: string;
  broadcasterName: string;
  channels: string[];
  accessToken: string | null;
  refreshToken: string | null;
  tokenScopes: string[];
  broadcasterAccessToken: string | null;
  broadcasterRefreshToken: string | null;
  broadcasterScopes: string[];
  createdAt: string;
  updatedAt: string;
  tokenExpiresAt: string | null;
  broadcasterTokenExpiresAt: string | null;
}

export type TokenStatus = 'not_authorized' | 'expired' | 'expiring' | 'valid';

export interface AccountSummary {
  name: string;
  broadcasterName: string;
  channels: string[];
  hasAccessToken: boolean;
  hasBroadcasterToken: boolean;
  tokenScopes: string[];
  broadcasterScopes: string[];
  createdAt: string;
  updatedAt: string;
  tokenStatus: TokenStatus;
  broadcasterTokenStatus: TokenStatus;
}

export interface TokenUpdate {
  accessToken?: string | null;
  refreshToken?: string | null;
  scopes?: string[];
  /** Seconds; defaults to 3600 */
  expiresIn?: number;
  broadcasterAccessToken?: string | null;
  broadcasterRefreshToken?: string | null;
  broadcasterScopes?: string[];
  /** Seconds; defaults to 3600 */
  broadcasterExpiresIn?: number;
}

export interface EncryptedValue {
  iv: string;
  data: string;
}

export interface AccountManagerOptions {
  accountsFile?: string;
  keyFile?: string;
}

export class AccountManager {
  accounts: Record<string, Account>;
  readonly encryptionKey: string;
  readonly accountsFile: string;
  readonly keyFile: string;

  constructor({ accountsFile = ACCOUNTS_FILE, keyFile = ENCRYPTION_KEY_FILE }: AccountManagerOptions = {}) {
    this.accounts = {};
    this.accountsFile = accountsFile;
    this.keyFile = keyFile;
    this.encryptionKey = this.getOrCreateEncryptionKey();
    this.loadAccounts();
  }

  /**
   * Get or create a persistent encryption key
   */
  getOrCreateEncryptionKey(): string {
    if (fs.existsSync(this.keyFile)) {
      return fs.readFileSync(this.keyFile, 'utf8');
    }

    // Generate a new encryption key (32 bytes for AES-256)
    const key = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(this.keyFile, key, { mode: 0o600 }); // Read/write for owner only
    console.log(`✓ Encryption key created: ${this.keyFile}`);
    return key;
  }

  /**
   * Encrypt sensitive data
   */
  encrypt(data: unknown): EncryptedValue {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(
      'aes-256-cbc',
      Buffer.from(this.encryptionKey, 'hex'),
      iv
    );

    let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'hex');
    encrypted += cipher.final('hex');

    return {
      iv: iv.toString('hex'),
      data: encrypted
    };
  }

  /**
   * Decrypt sensitive data
   */
  decrypt<T = Account>(encrypted: EncryptedValue): T | null {
    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-cbc',
        Buffer.from(this.encryptionKey, 'hex'),
        Buffer.from(encrypted.iv, 'hex')
      );

      let decrypted = decipher.update(encrypted.data, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return JSON.parse(decrypted);
    } catch (err) {
      console.error('Decryption failed (encryption key mismatch?):', (err as Error).message);
      return null;
    }
  }

  /**
   * Load accounts from encrypted storage
   */
  loadAccounts(): void {
    if (!fs.existsSync(this.accountsFile)) {
      this.accounts = {};
      return;
    }

    return withCrossProcessLockSync(this.accountsFile, () => {
      try {
        const fileData: Record<string, EncryptedValue> = JSON.parse(fs.readFileSync(this.accountsFile, 'utf8'));
        this.accounts = {};

        for (const [accountName, encryptedData] of Object.entries(fileData)) {
          const decrypted = this.decrypt(encryptedData);
          if (decrypted) {
            this.accounts[accountName] = decrypted;
          }
        }

        console.log(`✓ Loaded ${Object.keys(this.accounts).length} account(s)`);
      } catch (err) {
        console.error('Failed to load accounts:', (err as Error).message);
        this.accounts = {};
      }
    });
  }

  /**
   * Save accounts to encrypted storage
   */
  saveAccounts(): void {
    return withCrossProcessLockSync(this.accountsFile, () => {
      try {
        const fileData: Record<string, EncryptedValue> = {};

        for (const [accountName, accountData] of Object.entries(this.accounts)) {
          fileData[accountName] = this.encrypt(accountData);
        }

        fs.writeFileSync(this.accountsFile, JSON.stringify(fileData, null, 2), { mode: 0o600 });
      } catch (err) {
        console.error('Failed to save accounts:', (err as Error).message);
        throw err;
      }
    });
  }

  /**
   * Create a new account
   */
  createAccount(accountName: string, clientId: string, clientSecret: string, broadcasterName: string, channels: string[] = []): Account {
    if (this.accounts[accountName]) {
      throw new Error(`Account "${accountName}" already exists`);
    }

    this.accounts[accountName] = {
      name: accountName,
      clientId,
      clientSecret,
      broadcasterName,
      channels,
      accessToken: null,
      refreshToken: null,
      tokenScopes: [],
      broadcasterAccessToken: null,
      broadcasterRefreshToken: null,
      broadcasterScopes: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tokenExpiresAt: null,
      broadcasterTokenExpiresAt: null
    };

    this.saveAccounts();
    return this.accounts[accountName];
  }

  /**
   * Get account by name
   */
  getAccount(accountName: string): Account | null {
    return this.accounts[accountName] || null;
  }

  /**
   * List all accounts (without sensitive data)
   */
  listAccounts(): AccountSummary[] {
    return Object.entries(this.accounts).map(([name, data]) => ({
      name,
      broadcasterName: data.broadcasterName,
      channels: data.channels,
      hasAccessToken: !!data.accessToken,
      hasBroadcasterToken: !!data.broadcasterAccessToken,
      tokenScopes: data.tokenScopes,
      broadcasterScopes: data.broadcasterScopes,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      tokenStatus: this.getTokenStatus(data.tokenExpiresAt),
      broadcasterTokenStatus: this.getTokenStatus(data.broadcasterTokenExpiresAt)
    }));
  }

  /**
   * Get token status (valid/expired/expiring)
   */
  getTokenStatus(expiresAt: string | number | Date | null | undefined): TokenStatus {
    if (!expiresAt) return 'not_authorized';
    
    const now = Date.now();
    const expiry = new Date(expiresAt).getTime();
    const minutesUntilExpiry = (expiry - now) / (1000 * 60);

    if (minutesUntilExpiry < 0) return 'expired';
    if (minutesUntilExpiry < 60) return 'expiring'; // Less than 1 hour
    return 'valid';
  }

  /**
   * Update account tokens after OAuth authorization
   */
  updateTokens(accountName: string, tokens: TokenUpdate): Account {
    const account = this.getAccount(accountName);
    if (!account) {
      throw new Error(`Account "${accountName}" not found`);
    }

    // Bot/user tokens
    if (tokens.accessToken !== undefined) {
      account.accessToken = tokens.accessToken ?? null;
      account.refreshToken = tokens.refreshToken as string | null;
      account.tokenScopes = tokens.scopes || [];
      account.tokenExpiresAt = new Date(Date.now() + (tokens.expiresIn || 3600) * 1000).toISOString();
    }

    // Broadcaster tokens
    if (tokens.broadcasterAccessToken !== undefined) {
      account.broadcasterAccessToken = tokens.broadcasterAccessToken ?? null;
      account.broadcasterRefreshToken = tokens.broadcasterRefreshToken as string | null;
      account.broadcasterScopes = tokens.broadcasterScopes || [];
      account.broadcasterTokenExpiresAt = new Date(Date.now() + (tokens.broadcasterExpiresIn || 3600) * 1000).toISOString();
    }

    account.updatedAt = new Date().toISOString();
    this.saveAccounts();
    return account;
  }

  /**
   * Refresh tokens using refresh tokens
   */
  async refreshTokens(accountName: string, refreshTokenFn: (account: Account) => Promise<TokenUpdate | null | undefined>): Promise<Account> {
    const account = this.getAccount(accountName);
    if (!account) {
      throw new Error(`Account "${accountName}" not found`);
    }

    try {
      const refreshed = await refreshTokenFn(account);
      if (refreshed) {
        return this.updateTokens(accountName, refreshed);
      }
    } catch (err) {
      console.error(`Failed to refresh tokens for ${accountName}:`, (err as Error).message);
    }

    return account;
  }

  /**
   * Delete account
   */
  deleteAccount(accountName: string): void {
    if (!this.accounts[accountName]) {
      throw new Error(`Account "${accountName}" not found`);
    }

    delete this.accounts[accountName];
    this.saveAccounts();
    console.log(`✓ Deleted account: ${accountName}`);
  }

  /**
   * Rename account
   */
  renameAccount(oldName: string, newName: string): Account {
    if (!this.accounts[oldName]) {
      throw new Error(`Account "${oldName}" not found`);
    }

    if (this.accounts[newName]) {
      throw new Error(`Account "${newName}" already exists`);
    }

    const account = this.accounts[oldName];
    account.name = newName;
    this.accounts[newName] = account;
    delete this.accounts[oldName];
    this.saveAccounts();
    console.log(`✓ Renamed account: ${oldName} → ${newName}`);
    return account;
  }

  /**
   * Update account settings (channels, broadcaster name, etc)
   */
  updateAccountSettings(accountName: string, updates: Partial<Pick<Account, 'broadcasterName' | 'channels'>>): Account {
    const account = this.getAccount(accountName);
    if (!account) {
      throw new Error(`Account "${accountName}" not found`);
    }

    const allowedUpdates = ['broadcasterName', 'channels'] as const;
    for (const key of allowedUpdates) {
      if (key in updates) {
        (account as unknown as Record<string, unknown>)[key] = updates[key];
      }
    }

    account.updatedAt = new Date().toISOString();
    this.saveAccounts();
    return account;
  }

  /**
   * Export account as .env format for Excella
   */
  exportToEnv(accountName: string): string {
    const account = this.getAccount(accountName);
    if (!account) {
      throw new Error(`Account "${accountName}" not found`);
    }

    if (!account.accessToken) {
      throw new Error(`Account "${accountName}" has not been authorized yet`);
    }

    const lines = [
      `# Account: ${account.name}`,
      `# Generated: ${new Date().toISOString()}`,
      ``,
      `TWITCH_CLIENT_ID=${account.clientId}`,
      `TWITCH_CLIENT_SECRET=${account.clientSecret}`,
      `TWITCH_ACCESS_TOKEN=${account.accessToken}`,
      `TWITCH_REFRESH_TOKEN=${account.refreshToken}`,
      `TWITCH_SCOPES=${account.tokenScopes.join(' ')}`,
      `TWITCH_BROADCASTER_NAME=${account.broadcasterName}`,
      `TWITCH_CHANNELS=${account.channels.join(',')}`,
    ];

    if (account.broadcasterAccessToken) {
      lines.push(
        `TWITCH_BROADCASTER_ACCESS_TOKEN=${account.broadcasterAccessToken}`,
        `TWITCH_BROADCASTER_REFRESH_TOKEN=${account.broadcasterRefreshToken}`,
        `TWITCH_BROADCASTER_SCOPES=${account.broadcasterScopes.join(' ')}`
      );
    }

    return lines.join('\n');
  }

  /**
   * Import account from .env file
   */
  importFromEnv(accountName: string, envContent: string): Account {
    const lines = envContent.split('\n').filter(line => line && !line.startsWith('#'));
    const envVars: Record<string, string> = {};

    for (const line of lines) {
      const [key, ...rest] = line.split('=');
      envVars[key.trim()] = rest.join('=').trim();
    }

    const account = this.createAccount(
      accountName,
      envVars.TWITCH_CLIENT_ID,
      envVars.TWITCH_CLIENT_SECRET,
      envVars.TWITCH_BROADCASTER_NAME,
      (envVars.TWITCH_CHANNELS || '').split(',').filter(Boolean)
    );

    this.updateTokens(accountName, {
      accessToken: envVars.TWITCH_ACCESS_TOKEN,
      refreshToken: envVars.TWITCH_REFRESH_TOKEN,
      scopes: (envVars.TWITCH_SCOPES || '').split(' ').filter(Boolean),
      expiresIn: 3600,
      broadcasterAccessToken: envVars.TWITCH_BROADCASTER_ACCESS_TOKEN,
      broadcasterRefreshToken: envVars.TWITCH_BROADCASTER_REFRESH_TOKEN,
      broadcasterScopes: (envVars.TWITCH_BROADCASTER_SCOPES || '').split(' ').filter(Boolean),
      broadcasterExpiresIn: 3600
    });

    return account;
  }

  /**
   * Get account as .env object (for loading into process.env)
   */
  getAsEnvObject(accountName: string): Record<string, string> {
    const account = this.getAccount(accountName);
    if (!account) {
      throw new Error(`Account "${accountName}" not found`);
    }

    if (!account.accessToken) {
      throw new Error(`Account "${accountName}" has not been authorized yet`);
    }

    return {
      TWITCH_CLIENT_ID: account.clientId,
      TWITCH_CLIENT_SECRET: account.clientSecret,
      TWITCH_ACCESS_TOKEN: account.accessToken,
      TWITCH_REFRESH_TOKEN: account.refreshToken as string,
      TWITCH_SCOPES: account.tokenScopes.join(' '),
      TWITCH_BROADCASTER_NAME: account.broadcasterName,
      TWITCH_CHANNELS: account.channels.join(','),
      TWITCH_BROADCASTER_ACCESS_TOKEN: account.broadcasterAccessToken || '',
      TWITCH_BROADCASTER_REFRESH_TOKEN: account.broadcasterRefreshToken || '',
      TWITCH_BROADCASTER_SCOPES: account.broadcasterScopes.join(' ')
    };
  }
}
