/**
 * Bot entry point: `node dist/bot/main.js` (`npm run bot` builds first).
 *
 * The only bot file that reads process.env and .env, builds the real Twitch
 * clients, installs process handlers and starts the bot. Everything else lives
 * in src/bot/* behind createBot().
 */

// Timestamps on console output (patches the global console when loaded)
import '../lib/console-timestamp';

import * as fs from 'fs';
import axios from 'axios';
import * as dotenv from 'dotenv';
// Replaced Twurple with direct Helix API, tmi.js for IRC, and native WebSocket for EventSub
import { TwitchHelixAPI } from '../lib/twitch-helix-api';
import { TwitchIRCClient } from '../lib/twitch-irc-client';
import { TwitchEventSubWS } from '../lib/twitch-eventsub-ws';
import { AccountManager } from '../lib/account-manager';
import { projectPath } from '../utils/project-root';
import { createBotTokenManager, loadSelectedAccount } from './auth';
import { API_TIMEOUT, MISSING_CONFIG_MESSAGE, isCompleteConfig, parseAccountArg, readBotConfig } from './config';
import { createBot } from './create-bot';

declare global {
  // Exposed for easy access (and for tests), as Excella.js did
  // eslint-disable-next-line no-var
  var apiClient: TwitchHelixAPI | undefined;
  // eslint-disable-next-line no-var
  var chatClient: TwitchIRCClient | undefined;
}

dotenv.config();

const env = process.env;
// Set once anything asks to exit, so a startup failure that already exited is not reported twice
let exitRequested = false;
const exit: (code: number) => never = (code) => {
  exitRequested = true;
  return process.exit(code);
};

// ==================== ACCOUNT MANAGER SUPPORT ====================
// Load account from account manager if --account flag is provided
const selectedAccountName = parseAccountArg(process.argv.slice(2));
if (selectedAccountName) {
  loadSelectedAccount(selectedAccountName, env, new AccountManager(), exit);
}

// ==================== CONFIGURATION ====================

// Global axios instance with consistent timeout and internal bot secret
const http = axios.create({
  timeout: API_TIMEOUT,
  headers: env.DASHBOARD_INTERNAL_SECRET
    ? { 'x-bot-secret': env.DASHBOARD_INTERNAL_SECRET }
    : {}
});

// Validate config on startup
const rawConfig = readBotConfig(env);
if (!isCompleteConfig(rawConfig)) {
  console.error(MISSING_CONFIG_MESSAGE);
  exit(1);
}
const config = rawConfig;

// Owns validation and refresh of the bot and broadcaster tokens.
// Twitch auth calls use their own axios instance so the dashboard secret header never reaches Twitch.
const tokenManager = createBotTokenManager(config, env, axios.create({ timeout: API_TIMEOUT }), selectedAccountName);

// Setup API client using direct Helix API
const apiClient = new TwitchHelixAPI({
  clientId: config.clientId,
  accessToken: config.accessToken
});
global.apiClient = apiClient;

// Register token-refresh callback so the API client can auto-recover from 401s
apiClient.setOnTokenRefresh(() => tokenManager.refresh('bot'));

// Create Chat client using tmi.js wrapper
// Note: init() replaces the username with the bot token's login after token validation
const chatClient = new TwitchIRCClient({
  username: config.broadcasterName,
  accessToken: config.accessToken,
  channels: config.channels
});
global.chatClient = chatClient;

function createBroadcasterApiClient(accessToken: string): TwitchHelixAPI {
  const client = new TwitchHelixAPI({ clientId: config.clientId, accessToken });
  client.setOnTokenRefresh(() => tokenManager.refresh('broadcaster'));
  return client;
}

// Setup broadcaster API client if broadcaster token is available
const broadcasterApiClient = env.TWITCH_BROADCASTER_ACCESS_TOKEN
  ? createBroadcasterApiClient(env.TWITCH_BROADCASTER_ACCESS_TOKEN)
  : null;

export const bot = createBot({
  env,
  config,
  http,
  rawHttp: axios,
  tokenManager,
  apiClient,
  broadcasterApiClient,
  chatClient,
  createBroadcasterApiClient,
  createEventSub: (options) => new TwitchEventSubWS(options),
  restartFlagPath: projectPath('dashboard', 'logs', 'restart.flag'),
  exit,
  // Looked up on each call so the fs module can be stubbed after start
  fs: {
    existsSync: (p) => fs.existsSync(p),
    unlinkSync: (p) => fs.unlinkSync(p)
  }
});

// Handle errors
process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
});

// A bot that failed to start (e.g. unknown broadcaster) has no chat or EventSub:
// exit non-zero instead of idling, so a process manager can report or restart it
bot.start().catch((error: unknown) => {
  if (exitRequested) return;
  console.error('✗ Bot failed to start:', error instanceof Error ? error.message : error);
  exit(1);
});
