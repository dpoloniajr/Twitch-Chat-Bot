/**
 * Auth and tokens: --account loading, the token manager, Helix headers and
 * scopes, startup token validation, applying refreshed tokens, and the
 * feature scope check.
 */

import * as path from 'path';
import { TokenManager, createTokenPersister, type TokenHttpClient } from '../lib/token-manager';
import { EnvManager } from '../lib/env-manager';
import { AccountManager } from '../lib/account-manager';
import * as featureScopes from '../lib/feature-scopes';
import type { BotConfig, Env } from './config';
import type { BotContext } from './context';

// ==================== ACCOUNT MANAGER SUPPORT ====================

/** The account-manager subset used to load an account selected with --account */
export interface AccountSource {
  getAccount(name: string): { accessToken?: string | null } | null;
  listAccounts(): Array<{ name: string }>;
  getAsEnvObject(name: string): Record<string, string>;
}

/**
 * Load account from account manager if --account flag is provided: copies its
 * credentials into `env`. Exits with code 1 if the account is unknown or unauthorized.
 */
export function loadSelectedAccount(
  selectedAccountName: string,
  env: Env,
  accountManager: AccountSource,
  exit: (code: number) => never
): void {
  const account = accountManager.getAccount(selectedAccountName);

  if (!account) {
    console.error(`❌ Account "${selectedAccountName}" not found. Available accounts:`,
      accountManager.listAccounts().map(a => a.name).join(', '));
    exit(1);
  }

  if (!account.accessToken) {
    console.error(`❌ Account "${selectedAccountName}" has not been authorized. Run token-generator to authorize.`);
    exit(1);
  }

  console.log(`✓ Loaded account: ${selectedAccountName}`);

  // Load account credentials into process.env
  const envObj = accountManager.getAsEnvObject(selectedAccountName);
  Object.assign(env, envObj);
}

// ==================== TOKEN MANAGER ====================

/**
 * Owns validation and refresh of the bot and broadcaster tokens.
 * Twitch auth calls use their own axios instance so the dashboard secret header never reaches Twitch.
 */
export function createBotTokenManager(
  config: BotConfig,
  env: Env,
  http: TokenHttpClient,
  selectedAccountName: string | null
): TokenManager {
  return new TokenManager({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    tokens: {
      bot: { accessToken: config.accessToken, refreshToken: config.refreshToken },
      broadcaster: {
        accessToken: env.TWITCH_BROADCASTER_ACCESS_TOKEN,
        refreshToken: env.TWITCH_BROADCASTER_REFRESH_TOKEN
      }
    },
    http,
    persist: createTokenPersister({
      accountName: selectedAccountName,
      envPath: path.resolve(env.ENV_PATH || '.env'),
      AccountManager,
      EnvManager
    })
  });
}

// ==================== HEADERS AND SCOPES ====================

export interface ApiHeaders {
  'Client-ID': string;
  Authorization: string;
  'Content-Type': string;
  [header: string]: string;
}

// Get API headers for Helix calls
export function getApiHeaders(ctx: BotContext): ApiHeaders {
  return {
    'Client-ID': ctx.config.clientId,
    'Authorization': `Bearer ${ctx.config.accessToken}`,
    'Content-Type': 'application/json'
  };
}

// Get API headers using the broadcaster token (required for broadcaster-scoped endpoints
// like /helix/polls and /helix/predictions). Falls back to the bot token if no
// broadcaster token is configured (single-account setup).
export function getBroadcasterApiHeaders(ctx: BotContext): ApiHeaders {
  const token = ctx.env.TWITCH_BROADCASTER_ACCESS_TOKEN || ctx.config.accessToken;
  return {
    'Client-ID': ctx.config.clientId,
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };
}

// Return the scope list that corresponds to the token used by getBroadcasterApiHeaders().
// When a separate broadcaster token is configured, validate against its scopes; otherwise
// fall back to the bot's scopes (single-account setup).
export function getBroadcasterScopes(ctx: BotContext): string[] {
  if (ctx.env.TWITCH_BROADCASTER_ACCESS_TOKEN) {
    const scopes = (ctx.env.TWITCH_BROADCASTER_SCOPES || '').split(' ').filter(s => s);
    // If broadcaster scopes are not configured, fall back to bot scopes to allow fallback behavior
    return scopes.length > 0 ? scopes : ctx.config.scopes;
  }
  return ctx.config.scopes;
}

/**
 * Automatically check for missing scopes based on enabled features.
 * Logs warnings and instructions if scopes are missing.
 */
export async function checkRequiredScopes(ctx: BotContext): Promise<boolean> {
  const { env, config, cachedTokenValidation } = ctx;
  // Record the scopes Twitch granted each token in .env (never the required ones,
  // which the tokens may not have)
  const grantedBot = cachedTokenValidation.bot.scopes;
  const grantedBroadcaster = env.TWITCH_BROADCASTER_ACCESS_TOKEN ? cachedTokenValidation.broadcaster.scopes : [];
  try {
    const syncResult = await featureScopes.syncGrantedScopes(env.ENV_PATH || '.env', {
      bot: grantedBot,
      broadcaster: grantedBroadcaster
    });
    if (syncResult.updated) {
      console.log('✓ Updated .env with the scopes Twitch reports for your tokens.');
      logScopeChanges('bot', syncResult.botAdded, syncResult.botRemoved);
      logScopeChanges('broadcaster', syncResult.broadcasterAdded, syncResult.broadcasterRemoved);
    }
  } catch (err) {
    console.error('Failed to sync token scopes to .env:', (err as Error).message);
  }
  // Keep the live config/env in line with the validated scopes
  if (grantedBot.length > 0) {
    config.scopes = Array.from(new Set(grantedBot)).sort();
    env.TWITCH_SCOPES = config.scopes.join(' ');
  }
  if (grantedBroadcaster.length > 0) {
    env.TWITCH_BROADCASTER_SCOPES = Array.from(new Set(grantedBroadcaster)).sort().join(' ');
  }

  const activeFeatures = featureScopes.getActiveFeatures(env);
  const botRequired = featureScopes.getRequiredScopes(activeFeatures, 'bot');
  const broadcasterRequired = featureScopes.getRequiredScopes(activeFeatures, 'broadcaster');

  const botScopes = cachedTokenValidation.bot.scopes.length > 0
    ? cachedTokenValidation.bot.scopes
    : config.scopes;

  const broadcasterScopes = cachedTokenValidation.broadcaster.scopes.length > 0
    ? cachedTokenValidation.broadcaster.scopes
    : getBroadcasterScopes(ctx);

  const botValidation = featureScopes.validateScopes(botScopes, botRequired);
  const broadcasterValidation = featureScopes.validateScopes(broadcasterScopes, broadcasterRequired);

  if (!botValidation.hasAll || !broadcasterValidation.hasAll) {
    const isSingleAccount = !env.TWITCH_BROADCASTER_ACCESS_TOKEN;

    console.warn('\n⚠️  MISSING REQUIRED SCOPES DETECTED');
    if (isSingleAccount && !broadcasterValidation.hasAll) {
      console.warn('NOTE: You are using a single account setup. Your bot token needs broadcaster-level scopes.');
    }
    console.warn('The following features may not work correctly:');

    activeFeatures.forEach(featKey => {
      const feat = featureScopes.FEATURE_SCOPES[featKey];
      const missingBot = (feat.bot || []).filter(s => botValidation.missing.includes(s));
      const missingBroadcaster = (feat.broadcaster || []).filter(s => broadcasterValidation.missing.includes(s));

      if (missingBot.length > 0 || missingBroadcaster.length > 0) {
        console.warn(`- ${feat.name}: Missing ${[...missingBot, ...missingBroadcaster].join(', ')}`);
      }
    });

    console.warn('\nTo fix this, please re-authorize your accounts using the Token Generator:');
    const tokenGenUrl = `http://localhost:${env.TOKEN_GENERATOR_PORT || 3000}`;
    console.warn(`👉 ${tokenGenUrl}\n`);

    return false;
  }

  console.log('✓ All required scopes for enabled features are present.');
  return true;
}

function logScopeChanges(account: string, added: string[], removed: string[]): void {
  if (added.length > 0) console.log(`  - Added to ${account}: ${added.join(', ')}`);
  if (removed.length > 0) console.log(`  - Removed from ${account} (not granted): ${removed.join(', ')}`);
}

// ==================== TOKEN LIFECYCLE ====================

// Validate tokens at startup, refresh any that are expired, and schedule proactive refreshes
export async function validateAndRefreshTokens(ctx: BotContext): Promise<void> {
  const { tokenManager } = ctx;
  console.log('\n🔍 Validating tokens...');

  const hasBroadcasterToken = tokenManager.hasToken('broadcaster');
  const [botTokenOk, broadcasterTokenOk] = await Promise.all([
    tokenManager.ensureValid('bot'),
    hasBroadcasterToken ? tokenManager.ensureValid('broadcaster') : Promise.resolve(false)
  ]);

  if (!botTokenOk) {
    console.error('✗ Failed to refresh bot token. Please visit http://localhost:3000 to generate new tokens.');
    ctx.exit(1);
  }
  console.log('✓ Bot token is valid');

  if (hasBroadcasterToken) {
    if (broadcasterTokenOk) {
      console.log('✓ Broadcaster token is valid');
    } else {
      console.warn('⚠️  Failed to refresh broadcaster token. EventSub features will be disabled.');
      console.warn('Visit http://localhost:3000 to generate new broadcaster tokens.');
    }
  }

  tokenManager.scheduleProactiveRefresh();
  console.log('');
}

// Push refreshed tokens into config, process.env and every client that holds a copy
export function applyRefreshedTokens(ctx: BotContext): void {
  const { tokenManager, config, env, state } = ctx;
  tokenManager.onRefreshed(async (accountType, { accessToken, refreshToken }) => {
    if (accountType === 'bot') {
      config.accessToken = accessToken;
      config.refreshToken = refreshToken;
      env.TWITCH_ACCESS_TOKEN = accessToken;
      env.TWITCH_REFRESH_TOKEN = refreshToken;
      ctx.apiClient.setAccessToken(accessToken);
      if (state.eventSub) state.eventSub.setAccessToken(accessToken);
      // Reconnects IRC if connected, so a later auto-reconnect doesn't log in with the old token
      await ctx.chatClient.updateToken(accessToken);
      console.log('✓ Bot token refreshed and applied');
      return;
    }

    env.TWITCH_BROADCASTER_ACCESS_TOKEN = accessToken;
    env.TWITCH_BROADCASTER_REFRESH_TOKEN = refreshToken;
    if (state.broadcasterApiClient) {
      state.broadcasterApiClient.setAccessToken(accessToken);
    } else {
      state.broadcasterApiClient = ctx.createBroadcasterApiClient(accessToken);
    }
    if (state.broadcasterEventSub) state.broadcasterEventSub.setAccessToken(accessToken);
    console.log('✓ Broadcaster token refreshed and applied');
  });
}
