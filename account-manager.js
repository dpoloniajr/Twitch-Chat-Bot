/**
 * Account Manager
 * Handles multi-account storage, encryption, and token management for Twitch OAuth
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { withCrossProcessLock, withCrossProcessLockSync } = require('./lib/file-lock');

const ACCOUNTS_FILE = 'accounts.encrypted.json';
const ENCRYPTION_KEY_FILE = '.encryption-key';

class AccountManager {
  constructor() {
    this.accounts = {};
    this.encryptionKey = this.getOrCreateEncryptionKey();
    this.loadAccounts();
  }

  /**
   * Get or create a persistent encryption key
   */
  getOrCreateEncryptionKey() {
    if (fs.existsSync(ENCRYPTION_KEY_FILE)) {
      return fs.readFileSync(ENCRYPTION_KEY_FILE, 'utf8');
    }

    // Generate a new encryption key (32 bytes for AES-256)
    const key = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(ENCRYPTION_KEY_FILE, key, { mode: 0o600 }); // Read/write for owner only
    console.log(`✓ Encryption key created: ${ENCRYPTION_KEY_FILE}`);
    return key;
  }

  /**
   * Encrypt sensitive data
   */
  encrypt(data) {
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
  decrypt(encrypted) {
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
      console.error('Decryption failed (encryption key mismatch?):', err.message);
      return null;
    }
  }

  /**
   * Load accounts from encrypted storage
   */
  loadAccounts() {
    if (!fs.existsSync(ACCOUNTS_FILE)) {
      this.accounts = {};
      return;
    }

    return withCrossProcessLockSync(ACCOUNTS_FILE, () => {
      try {
        const fileData = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
        this.accounts = {};

        for (const [accountName, encryptedData] of Object.entries(fileData)) {
          const decrypted = this.decrypt(encryptedData);
          if (decrypted) {
            this.accounts[accountName] = decrypted;
          }
        }

        console.log(`✓ Loaded ${Object.keys(this.accounts).length} account(s)`);
      } catch (err) {
        console.error('Failed to load accounts:', err.message);
        this.accounts = {};
      }
    });
  }

  /**
   * Save accounts to encrypted storage
   */
  saveAccounts() {
    return withCrossProcessLockSync(ACCOUNTS_FILE, () => {
      try {
        const fileData = {};

        for (const [accountName, accountData] of Object.entries(this.accounts)) {
          fileData[accountName] = this.encrypt(accountData);
        }

        fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(fileData, null, 2), { mode: 0o600 });
      } catch (err) {
        console.error('Failed to save accounts:', err.message);
        throw err;
      }
    });
  }

  /**
   * Create a new account
   */
  createAccount(accountName, clientId, clientSecret, broadcasterName, channels = []) {
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
  getAccount(accountName) {
    return this.accounts[accountName] || null;
  }

  /**
   * List all accounts (without sensitive data)
   */
  listAccounts() {
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
  getTokenStatus(expiresAt) {
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
  updateTokens(accountName, tokens) {
    const account = this.getAccount(accountName);
    if (!account) {
      throw new Error(`Account "${accountName}" not found`);
    }

    // Bot/user tokens
    if (tokens.accessToken !== undefined) {
      account.accessToken = tokens.accessToken;
      account.refreshToken = tokens.refreshToken;
      account.tokenScopes = tokens.scopes || [];
      account.tokenExpiresAt = new Date(Date.now() + (tokens.expiresIn || 3600) * 1000).toISOString();
    }

    // Broadcaster tokens
    if (tokens.broadcasterAccessToken !== undefined) {
      account.broadcasterAccessToken = tokens.broadcasterAccessToken;
      account.broadcasterRefreshToken = tokens.broadcasterRefreshToken;
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
  async refreshTokens(accountName, refreshTokenFn) {
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
      console.error(`Failed to refresh tokens for ${accountName}:`, err.message);
    }

    return account;
  }

  /**
   * Delete account
   */
  deleteAccount(accountName) {
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
  renameAccount(oldName, newName) {
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
  updateAccountSettings(accountName, updates) {
    const account = this.getAccount(accountName);
    if (!account) {
      throw new Error(`Account "${accountName}" not found`);
    }

    const allowedUpdates = ['broadcasterName', 'channels'];
    for (const key of allowedUpdates) {
      if (key in updates) {
        account[key] = updates[key];
      }
    }

    account.updatedAt = new Date().toISOString();
    this.saveAccounts();
    return account;
  }

  /**
   * Export account as .env format for Excella
   */
  exportToEnv(accountName) {
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
  importFromEnv(accountName, envContent) {
    const lines = envContent.split('\n').filter(line => line && !line.startsWith('#'));
    const envVars = {};

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
  getAsEnvObject(accountName) {
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
      TWITCH_REFRESH_TOKEN: account.refreshToken,
      TWITCH_SCOPES: account.tokenScopes.join(' '),
      TWITCH_BROADCASTER_NAME: account.broadcasterName,
      TWITCH_CHANNELS: account.channels.join(','),
      TWITCH_BROADCASTER_ACCESS_TOKEN: account.broadcasterAccessToken || '',
      TWITCH_BROADCASTER_REFRESH_TOKEN: account.broadcasterRefreshToken || '',
      TWITCH_BROADCASTER_SCOPES: account.broadcasterScopes.join(' ')
    };
  }
}

module.exports = AccountManager;
