/**
 * TokenManager - validates and refreshes the bot and broadcaster OAuth tokens.
 *
 * One instance owns both tokens so every caller (startup, the proactive timer,
 * Helix 401 retries) goes through the same code path:
 * - refresh() is single-flight per account: concurrent callers share one request.
 * - New tokens are persisted through the injected `persist` callback; a failed
 *   save is logged but does not throw away tokens Twitch has already issued.
 * - The proactive timer is always rescheduled, after success or failure.
 */

export const TWITCH_VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';
export const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';

export type AccountType = 'bot' | 'broadcaster';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface RefreshedTokens extends TokenPair {
  scopes: string[];
  /** Seconds until expiry as reported by Twitch (0 when unknown) */
  expiresIn: number;
}

export interface TokenCache {
  lastCheck: number;
  isValid: boolean;
  /** Epoch ms; 0 when unknown */
  expiresAt: number;
  scopes: string[];
}

interface HttpResponse {
  data: any;
}

/** The axios subset TokenManager uses. Must not carry dashboard headers. */
export interface TokenHttpClient {
  get(url: string, config?: { headers?: Record<string, string> }): Promise<HttpResponse>;
  post(url: string, body: string, config?: { headers?: Record<string, string> }): Promise<HttpResponse>;
}

export interface TokenLogger {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export type PersistTokens = (accountType: AccountType, tokens: RefreshedTokens) => Promise<void>;
export type RefreshListener = (accountType: AccountType, tokens: TokenPair) => void | Promise<void>;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface TokenManagerOptions {
  clientId: string;
  clientSecret: string;
  tokens?: Partial<Record<AccountType, Partial<TokenPair>>>;
  http: TokenHttpClient;
  persist?: PersistTokens;
  logger?: TokenLogger;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  /** Refresh this long before expiry (ms) */
  leadMs?: number;
  /** Re-validate at least this often (ms) */
  cacheMs?: number;
  /** Retry delay after a failed refresh (ms) */
  retryMs?: number;
  validateUrl?: string;
  tokenUrl?: string;
}

interface HttpError {
  message: string;
  response?: { status?: number; data?: { message?: string } };
}

const ACCOUNT_TYPES: AccountType[] = ['bot', 'broadcaster'];
const DEFAULT_LEAD_MS = 5 * 60 * 1000; // refresh this long before expiry
const DEFAULT_CACHE_MS = 60 * 60 * 1000; // re-validate at least hourly
const DEFAULT_RETRY_MS = 2 * 60 * 1000; // retry delay after a failed refresh
const MAX_TIMER_MS = 2 ** 31 - 1;

function emptyCache(): TokenCache {
  return { lastCheck: 0, isValid: false, expiresAt: 0, scopes: [] };
}

export class TokenManager {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly http: TokenHttpClient;
  readonly persist: PersistTokens;
  readonly logger: TokenLogger;
  readonly now: () => number;
  readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  readonly clearTimer: (handle: TimerHandle) => void;
  readonly leadMs: number;
  readonly cacheMs: number;
  readonly retryMs: number;
  readonly validateUrl: string;
  readonly tokenUrl: string;
  tokens: Record<AccountType, TokenPair>;
  /** Exposed so callers can read live scopes and expiry after validation */
  readonly cache: Record<AccountType, TokenCache>;

  private _inFlight: Record<AccountType, Promise<TokenPair | null> | null>;
  private _listeners: RefreshListener[];
  private _timer: TimerHandle | null;
  private _stopped: boolean;

  constructor(options: TokenManagerOptions) {
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.http = options.http;
    this.persist = options.persist || (async () => {});
    this.logger = options.logger || console;
    this.now = options.now || Date.now;
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;
    this.leadMs = options.leadMs ?? DEFAULT_LEAD_MS;
    this.cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS;
    this.retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
    this.validateUrl = options.validateUrl || TWITCH_VALIDATE_URL;
    this.tokenUrl = options.tokenUrl || TWITCH_TOKEN_URL;

    this.tokens = {
      bot: { accessToken: '', refreshToken: '', ...(options.tokens?.bot || {}) },
      broadcaster: { accessToken: '', refreshToken: '', ...(options.tokens?.broadcaster || {}) }
    };
    this.cache = { bot: emptyCache(), broadcaster: emptyCache() };

    this._inFlight = { bot: null, broadcaster: null };
    this._listeners = [];
    this._timer = null;
    this._stopped = false;
  }

  hasToken(accountType: AccountType): boolean {
    return Boolean(this.tokens[accountType]?.accessToken);
  }

  getAccessToken(accountType: AccountType): string {
    return this.tokens[accountType].accessToken;
  }

  /**
   * Register a listener called after every successful refresh.
   * Listener errors are logged and never fail the refresh.
   */
  onRefreshed(fn: RefreshListener): void {
    this._listeners.push(fn);
  }

  /**
   * Validate a token with Twitch, using the cached result while it is fresh.
   * A token that expires within the lead window counts as invalid.
   */
  async validate(accountType: AccountType, { force = false }: { force?: boolean } = {}): Promise<boolean> {
    const cache = this.cache[accountType];
    const token = this.tokens[accountType].accessToken;
    const now = this.now();

    if (!token) {
      Object.assign(cache, emptyCache(), { lastCheck: now });
      return false;
    }

    if (
      !force &&
      cache.lastCheck > 0 &&
      now - cache.lastCheck < this.cacheMs &&
      cache.expiresAt > now + this.leadMs
    ) {
      return cache.isValid;
    }

    try {
      const response = await this.http.get(this.validateUrl, {
        headers: { Authorization: `OAuth ${token}` }
      });
      const expiresIn = Number(response.data.expires_in) || 0;
      cache.lastCheck = now;
      cache.expiresAt = now + expiresIn * 1000;
      cache.scopes = response.data.scopes || [];
      cache.isValid = expiresIn * 1000 > this.leadMs;
      if (!cache.isValid) {
        this.logger.log(`  ${accountType} token expires in ${Math.floor(expiresIn / 60)} minute(s)`);
      }
      return cache.isValid;
    } catch (err) {
      const error = err as HttpError;
      cache.lastCheck = now;
      cache.isValid = false;
      if (error.response?.status === 401) {
        // Expired or revoked; expiry is unknown from here on
        cache.expiresAt = 0;
        return false;
      }
      this.logger.error(`Error validating ${accountType} token:`, error.message);
      return false;
    }
  }

  /**
   * Exchange the refresh token for a new access token. Concurrent calls for the
   * same account share one request.
   */
  refresh(accountType: AccountType): Promise<TokenPair | null> {
    if (!this._inFlight[accountType]) {
      this._inFlight[accountType] = this._doRefresh(accountType).finally(() => {
        this._inFlight[accountType] = null;
      });
    }
    return this._inFlight[accountType]!;
  }

  private async _doRefresh(accountType: AccountType): Promise<TokenPair | null> {
    const current = this.tokens[accountType];
    if (!current.refreshToken) {
      this.logger.log(`  No refresh token available for ${accountType} account`);
      return null;
    }

    let data: any;
    try {
      const body = new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken
      });
      const response = await this.http.post(this.tokenUrl, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      data = response.data || {};
    } catch (err) {
      const error = err as HttpError;
      const status = error.response?.status;
      const reason = error.response?.data?.message || error.message;
      this.logger.error(`Error refreshing ${accountType} token: ${reason}${status ? ` (HTTP ${status})` : ''}`);
      if (status === 400 || status === 401) {
        this.logger.error(`  The ${accountType} refresh token was rejected by Twitch. Re-authorize the ${accountType} account with the Token Generator.`);
      }
      return null;
    }

    if (!data.access_token) {
      this.logger.error(`Error refreshing ${accountType} token: Twitch response had no access_token`);
      return null;
    }

    const tokens: TokenPair = {
      accessToken: data.access_token,
      // Twitch normally returns a refresh token; keep the old one if it doesn't
      refreshToken: data.refresh_token || current.refreshToken
    };
    this.tokens[accountType] = tokens;

    const expiresIn = Number(data.expires_in) || 0;
    const scopes: string[] = Array.isArray(data.scope) ? data.scope : this.cache[accountType].scopes;
    const now = this.now();
    Object.assign(this.cache[accountType], {
      lastCheck: now,
      isValid: expiresIn === 0 || expiresIn * 1000 > this.leadMs,
      expiresAt: expiresIn ? now + expiresIn * 1000 : 0,
      scopes
    });

    try {
      await this.persist(accountType, { ...tokens, scopes, expiresIn });
    } catch (error) {
      this.logger.error(`Refreshed ${accountType} token but could not save it: ${(error as Error).message}`);
    }

    for (const listener of this._listeners) {
      try {
        await listener(accountType, tokens);
      } catch (error) {
        this.logger.error(`Error applying refreshed ${accountType} token:`, (error as Error).message);
      }
    }

    return tokens;
  }

  /**
   * Validate a token and refresh it if it is invalid or about to expire.
   */
  async ensureValid(accountType: AccountType): Promise<boolean> {
    if (await this.validate(accountType)) {
      return true;
    }
    const refreshed = await this.refresh(accountType);
    if (!refreshed) return false;
    // Re-validate to pick up the live scopes and exact expiry
    await this.validate(accountType, { force: true });
    return true;
  }

  /**
   * Schedule the next proactive refresh just before the soonest known expiry.
   * When no expiry is known (validation failed), retry after `retryMs`.
   */
  scheduleProactiveRefresh(): number | null {
    if (this._timer) {
      this.clearTimer(this._timer);
      this._timer = null;
    }
    if (this._stopped) return null;

    const now = this.now();
    const active = ACCOUNT_TYPES.filter(type => this.hasToken(type));
    if (active.length === 0) return null;

    const expiries = active.map(type => this.cache[type].expiresAt);
    let delay: number;
    if (expiries.some(expiresAt => expiresAt <= now)) {
      delay = this.retryMs;
    } else {
      delay = Math.max(0, Math.min(...expiries) - now - this.leadMs);
    }
    // setTimeout overflows above ~24.8 days
    delay = Math.min(delay, MAX_TIMER_MS);

    this.logger.log(`Token refresh scheduled in ~${Math.round(delay / 60000)} minute(s)`);
    this._timer = this.setTimer(() => {
      this._timer = null;
      this._runProactiveRefresh().catch((error: Error) => {
        this.logger.error('Proactive token refresh failed:', error.message);
      });
    }, delay);
    return delay;
  }

  private async _runProactiveRefresh(): Promise<void> {
    this.logger.log('\nProactively refreshing tokens before expiry...');
    try {
      for (const type of ACCOUNT_TYPES) {
        if (!this.hasToken(type)) continue;
        const cache = this.cache[type];
        // Refresh anything due within the lead window (plus a minute of timer slack)
        const due = cache.expiresAt <= this.now() + this.leadMs + 60 * 1000;
        if (due) {
          const refreshed = await this.refresh(type);
          if (refreshed) {
            await this.validate(type, { force: true });
          } else {
            // Unknown expiry makes the scheduler retry after retryMs
            cache.expiresAt = 0;
          }
        } else {
          await this.validate(type, { force: true });
        }
      }
    } finally {
      this.scheduleProactiveRefresh();
    }
  }

  stop(): void {
    this._stopped = true;
    if (this._timer) {
      this.clearTimer(this._timer);
      this._timer = null;
    }
  }
}

/**
 * Build a `persist` callback that saves refreshed tokens where they were loaded
 * from: the encrypted account store when the bot runs with --account, else .env.
 */
export interface StoredAccount {
  tokenScopes?: string[];
  broadcasterScopes?: string[];
}

/** The account-manager subset the persister uses */
export interface AccountStore {
  getAccount(name: string): StoredAccount | null | undefined;
  updateTokens(name: string, updates: Record<string, unknown>): unknown;
}

export interface EnvWriter {
  updateEnv(updates: Record<string, string>): Promise<unknown>;
}

export interface TokenPersisterOptions {
  /** Account selected with --account, or null to use .env */
  accountName: string | null | undefined;
  /** Absolute path of the .env file */
  envPath: string;
  AccountManager: new () => AccountStore;
  EnvManager: new (envPath: string) => EnvWriter;
  logger?: Pick<TokenLogger, 'log'>;
}

export function createTokenPersister({ accountName, envPath, AccountManager, EnvManager, logger = console }: TokenPersisterOptions): PersistTokens {
  return async function persistTokens(accountType, { accessToken, refreshToken, scopes = [], expiresIn }) {
    if (accountName) {
      const accountManager = new AccountManager();
      const account = accountManager.getAccount(accountName);
      if (!account) {
        throw new Error(`Account "${accountName}" not found`);
      }
      if (accountType === 'bot') {
        accountManager.updateTokens(accountName, {
          accessToken,
          refreshToken,
          // updateTokens replaces scopes, so keep the stored ones if Twitch sent none
          scopes: scopes.length > 0 ? scopes : account.tokenScopes,
          expiresIn
        });
      } else {
        accountManager.updateTokens(accountName, {
          broadcasterAccessToken: accessToken,
          broadcasterRefreshToken: refreshToken,
          broadcasterScopes: scopes.length > 0 ? scopes : account.broadcasterScopes,
          broadcasterExpiresIn: expiresIn
        });
      }
      logger.log(`  Updated ${accountType} tokens for account "${accountName}"`);
      return;
    }

    const prefix = accountType === 'bot' ? 'TWITCH' : 'TWITCH_BROADCASTER';
    await new EnvManager(envPath).updateEnv({
      [`${prefix}_ACCESS_TOKEN`]: accessToken,
      [`${prefix}_REFRESH_TOKEN`]: refreshToken
    });
    logger.log(`  Updated ${accountType} tokens in .env`);
  };
}
