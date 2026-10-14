/**
 * Token generator: the local web app that walks through Twitch OAuth and saves
 * the resulting tokens to .env or to an account in the encrypted account store.
 * createTokenGenerator() builds it without starting it; main.ts starts it.
 */

import express, { Express, Request, Response } from 'express';
import type { Server } from 'http';
import axios from 'axios';
import { asyncHandler } from '../lib/api-utils';
import { Logger } from '../lib/logger';
import { EnvManager } from '../lib/env-manager';
import { AccountManager, AccountManagerOptions, TokenUpdate } from '../lib/account-manager';
import { projectPath } from '../utils/project-root';
import { errorHandler } from '../dashboard/lib/middleware';
import { createEnvRoutes } from './routes/env-routes';
import { createAccountRoutes } from './routes/account-routes';
import { createAuthRoutes } from './routes/auth-routes';
import { createScopeRoutes } from './routes/scope-routes';

export interface TokenGeneratorOptions {
  /** Port for start() and the OAuth redirect URI (default TOKEN_GENERATOR_PORT or 3000) */
  port?: number | string;
  /** .env file to read and update (default ENV_PATH or .env) */
  envPath?: string;
  /** .env backup folder (default BACKUP_DIR or backups) */
  backupDir?: string;
  /** Encrypted accounts file (AccountManager default) */
  accountsFile?: string;
  /** Accounts encryption key file (AccountManager default) */
  keyFile?: string;
  /** Folder for token-generator.log (Logger default) */
  logDir?: string;
}

export interface TokenGenerator {
  app: Express;
  logger: Logger;
  envManager: EnvManager;
  /** The instance /callback saves account tokens through */
  accountManager: AccountManager;
  port: number | string;
  redirectUri: string;
  /** Listen on `port` and log the URL */
  start(): Server;
}

/** Body of https://id.twitch.tv/oauth2/token (fields used here) */
interface TwitchTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string[] | string;
}

/** Query string Twitch sends back to /callback (a repeated parameter arrives as an array) */
const CALLBACK_PARAMS = ['code', 'error', 'error_description', 'state'] as const;
type CallbackQuery = Partial<Record<typeof CALLBACK_PARAMS[number], string | string[]>>;

/** Which token an OAuth state asks for and where to save it */
export interface CallbackTarget {
  /** Account to save to; null saves to .env */
  accountName: string | null;
  accountType: 'bot' | 'broadcaster';
}

/** axios error shape */
interface HttpError {
  message: string;
  response?: { data?: unknown };
}

/** Escape text for insertion into HTML */
function escapeHtml(text: unknown): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Parse the OAuth state sent through Twitch. "bot" / "broadcaster" (or none)
 * save to .env; "<account>_bot" / "<account>_broadcaster" save that token to the
 * account; any other value is an account name and saves bot tokens to it.
 */
export function parseCallbackState(state: string | undefined): CallbackTarget {
  if (!state || state === 'bot') return { accountName: null, accountType: 'bot' };
  if (state === 'broadcaster') return { accountName: null, accountType: 'broadcaster' };
  const match = /^(.+)_(bot|broadcaster)$/.exec(state);
  if (match) return { accountName: match[1], accountType: match[2] as CallbackTarget['accountType'] };
  return { accountName: state, accountType: 'bot' };
}

/**
 * Build the token generator Express app without starting it. Every option
 * defaults to what `node dist/token-generator/main.js` uses; tests pass temp files.
 */
export function createTokenGenerator(options: TokenGeneratorOptions = {}): TokenGenerator {
  const logger = new Logger('TokenGenerator', options.logDir);
  const envManager = new EnvManager(options.envPath || process.env.ENV_PATH || '.env', options.backupDir || process.env.BACKUP_DIR || 'backups');
  const accountFiles: AccountManagerOptions = { accountsFile: options.accountsFile, keyFile: options.keyFile };
  const accountManager = new AccountManager(accountFiles);

  const app = express();
  const PORT = options.port !== undefined ? options.port : (process.env.TOKEN_GENERATOR_PORT || 3000);
  const REDIRECT_URI = `http://localhost:${PORT}/callback`;

  app.use(express.json());
  // Without a JSON body Express leaves req.body undefined; give routes {} so a
  // missing body fails their validation (400) instead of throwing (500)
  app.use((req, _res, next) => {
    if (req.body === undefined) req.body = {};
    next();
  });

  // Serve static files from the new public directory
  app.use(express.static(projectPath('public', 'token-generator')));

  // API Routes
  app.use('/api/env', createEnvRoutes(envManager));
  // One AccountManager for the routes and /callback, so each sees the other's changes
  app.use('/api/accounts', createAccountRoutes(accountManager));
  app.use('/api/scope-presets', (req, res) => res.redirect('/api/scopes/presets'));
  app.use('/api/scopes', createScopeRoutes(envManager));
  app.use('/', createAuthRoutes(envManager, REDIRECT_URI));

  // Custom endpoints for frontend compatibility
  app.get('/api/current-tokens', asyncHandler(async (req, res) => {
    const env = await envManager.getEnv();
    res.json({
      botToken: env.TWITCH_ACCESS_TOKEN || null,
      botScopes: (env.TWITCH_SCOPES || '').split(' ').filter(Boolean),
      broadcasterToken: env.TWITCH_BROADCASTER_ACCESS_TOKEN || null,
      broadcasterScopes: (env.TWITCH_BROADCASTER_SCOPES || '').split(' ').filter(Boolean)
    });
  }));

  // Callback handler (Integrated for simplicity of redirect logic)
  app.get('/callback', async (req: Request, res: Response) => {
    const query = req.query as CallbackQuery;
    if (CALLBACK_PARAMS.some((key) => Array.isArray(query[key]))) {
      res.status(400).send('<h1>Error: Repeated callback parameters</h1>');
      return;
    }
    const { code, error, error_description, state } = query as Partial<Record<keyof CallbackQuery, string>>;
    const { accountName, accountType } = parseCallbackState(state);

    if (error) {
      logger.error(`Auth error: ${error}`, { error_description });
      res.status(400).send(`<h1>Auth Error</h1><p>${escapeHtml(error_description ?? '')}</p><a href="/">Back</a>`);
      return;
    }

    if (!code) {
      res.status(400).send('<h1>Error: No code received</h1>');
      return;
    }

    try {
      const env = await envManager.getEnv();
      const clientId = env.TWITCH_CLIENT_ID;
      const clientSecret = env.TWITCH_CLIENT_SECRET;

      const response = await axios.post<TwitchTokenResponse>('https://id.twitch.tv/oauth2/token', null, {
        params: {
          client_id: clientId,
          client_secret: clientSecret,
          code: code,
          grant_type: 'authorization_code',
          redirect_uri: REDIRECT_URI
        }
      });

      const { access_token, refresh_token, expires_in, scope } = response.data;
      const scopeArray = Array.isArray(scope) ? scope : (scope ? scope.split(' ') : []);
      const scopeString = scopeArray.join(' ');

      logger.info(`Token exchange successful for ${accountType}`, { accountName });

      // Auto-backup before updating credentials
      try {
        const backupName = await envManager.createBackup();
        logger.info(`Automatic backup created before token update: ${backupName}`);
      } catch (backupErr) {
        logger.warn(`Failed to create automatic backup: ${(backupErr as Error).message}`);
      }

      if (accountName) {
        // Save to Account Manager
        const updates: TokenUpdate = accountType === 'broadcaster' ? {
          broadcasterAccessToken: access_token,
          broadcasterRefreshToken: refresh_token,
          broadcasterScopes: scopeArray,
          broadcasterExpiresIn: expires_in
        } : {
          accessToken: access_token,
          refreshToken: refresh_token,
          scopes: scopeArray,
          expiresIn: expires_in
        };
        accountManager.updateTokens(accountName, updates);
        logger.info(`Tokens saved to account: ${accountName}`);
      } else {
        // Save directly to .env
        const updates: Record<string, string> = accountType === 'broadcaster' ? {
          TWITCH_BROADCASTER_ACCESS_TOKEN: access_token,
          TWITCH_BROADCASTER_REFRESH_TOKEN: refresh_token,
          TWITCH_BROADCASTER_SCOPES: scopeString
        } : {
          TWITCH_ACCESS_TOKEN: access_token,
          TWITCH_REFRESH_TOKEN: refresh_token,
          TWITCH_SCOPES: scopeString
        };
        await envManager.updateEnv(updates);
        logger.info(`Tokens saved to .env`);
      }

      // The page text (indentation included) is sent as written
      res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Success!</title>
                <style>
                    body { font-family: sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
                    .card { background: white; padding: 30px; border-radius: 8px; display: inline-block; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                    .success { color: #4caf50; font-size: 24px; margin-bottom: 20px; }
                </style>
            </head>
            <body>
                <div class="card">
                    <div class="success">Success! 🎉</div>
                    <p>Tokens for <strong>${accountType}</strong> have been saved.</p>
                    <p>Account: ${accountName ? escapeHtml(accountName) : '.env file'}</p>
                    <p><a href="/">Back to Dashboard</a></p>
                    <script>setTimeout(() => window.close(), 5000);</script>
                </div>
            </body>
            </html>
        `);
    } catch (err) {
      const httpErr = err as HttpError;
      logger.error('Token exchange failed', { error: httpErr.response?.data || httpErr.message });
      res.status(500).send(`<h1>Exchange Failed</h1><pre>${escapeHtml(httpErr.message)}</pre>`);
    }
  });

  app.use(errorHandler);

  // Listen on PORT and log the URL; returns the http.Server
  function start(): Server {
    return app.listen(PORT, () => {
      logger.info(`Token Generator Server running at http://localhost:${PORT}`);
    });
  }

  return { app, logger, envManager, accountManager, port: PORT, redirectUri: REDIRECT_URI, start };
}
