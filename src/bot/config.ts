/**
 * Bot configuration: Twitch credentials and the feature settings Excella.js read
 * from the environment at load time.
 *
 * Nothing here touches process.env directly; callers pass the environment in
 * (src/bot/main.ts passes process.env).
 */

export type Env = NodeJS.ProcessEnv;

// Constants for Twitch API
export const API_TIMEOUT = 5000;

export interface BotConfig {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  channels: string[];
  broadcasterName: string;
  scopes: string[];
}

/** The config as read from the environment, before validation */
export type RawBotConfig = { [K in keyof BotConfig]: BotConfig[K] | undefined } & {
  channels: string[];
  scopes: string[];
};

/** Parse CLI arguments: the value after --account, or null */
export function parseAccountArg(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--account' && args[i + 1]) {
      return args[i + 1];
    }
  }
  return null;
}

export function readBotConfig(env: Env): RawBotConfig {
  return {
    clientId: env.TWITCH_CLIENT_ID,
    clientSecret: env.TWITCH_CLIENT_SECRET,
    accessToken: env.TWITCH_ACCESS_TOKEN,
    refreshToken: env.TWITCH_REFRESH_TOKEN,
    channels: (env.TWITCH_CHANNELS || '').split(',').filter(c => c),
    broadcasterName: env.TWITCH_BROADCASTER_NAME,
    scopes: (env.TWITCH_SCOPES || 'chat:read chat:edit').split(' ').filter(s => s)
  };
}

/** True when every required credential is present (empty strings count as missing) */
export function isCompleteConfig(config: RawBotConfig): config is BotConfig {
  return Boolean(config.clientId && config.clientSecret && config.accessToken && config.refreshToken && config.broadcasterName);
}

export const MISSING_CONFIG_MESSAGE =
  'Missing required environment variables. Please set: TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TWITCH_ACCESS_TOKEN, TWITCH_REFRESH_TOKEN, TWITCH_BROADCASTER_NAME';

// Helper to check if env var is a common falsy value
export function isFalsyEnvValue(envVar: string | undefined): boolean {
  return ['false', '0', 'no', 'off'].includes(
    String(envVar || '').toLowerCase()
  );
}

// ==================== CHAT FILTERS ====================

export type FilterAction = 'warn' | 'timeout' | 'delete' | string;

export interface ChatFilterSettings {
  blacklistWords: Set<string>;
  filterUrls: boolean;
  filterAllCaps: boolean;
  filterRepeatChars: boolean;
  filterSpam: boolean;
  timeoutDurationSeconds: number;
  filterAction: FilterAction;
}

export function readChatFilterSettings(env: Env): ChatFilterSettings {
  return {
    blacklistWords: new Set((env.CHAT_FILTER_WORDS || '').split('|').map(w => w.trim().toLowerCase()).filter(Boolean)),
    filterUrls: env.CHAT_FILTER_URLS === 'true' || env.CHAT_FILTER_URLS === '1',
    filterAllCaps: env.CHAT_FILTER_ALLCAPS === 'true' || env.CHAT_FILTER_ALLCAPS === '1',
    filterRepeatChars: env.CHAT_FILTER_REPEAT === 'true' || env.CHAT_FILTER_REPEAT === '1',
    filterSpam: env.CHAT_FILTER_SPAM === 'true' || env.CHAT_FILTER_SPAM === '1',
    timeoutDurationSeconds: Number(env.CHAT_FILTER_TIMEOUT_SEC || 60),
    filterAction: env.CHAT_FILTER_ACTION || 'warn' // 'warn', 'timeout', 'delete'
  };
}

// ==================== FIRST-TIME CHATTER ====================

export interface FirstChatterSettings {
  welcomeEnabled: boolean;
  welcomeMessage: string;
  alertEnabled: boolean;
}

// First-time chatter welcome (uses IRC tag first-msg)
export function readFirstChatterSettings(env: Env): FirstChatterSettings {
  return {
    // Enabled by default; allow several common falsy values to disable
    welcomeEnabled: !isFalsyEnvValue(env.FIRST_CHATTER_WELCOME_ENABLED),
    welcomeMessage: (env.FIRST_CHATTER_MESSAGE || 'Welcome to the chat, {user}!').trim(),
    alertEnabled: !isFalsyEnvValue(env.FIRST_CHATTER_ALERT_ENABLED)
  };
}

// ==================== CHAT HYPE ====================

export interface HypeSettings {
  enabled: boolean;
  minMessages: number;
  windowSec: number;
  cooldownSec: number;
  message: string;
}

export function readHypeWindowMs(env: Env): number {
  return (Number(env.HYPE_WINDOW_SEC) || 60) * 1000;
}

export function readHypeSettings(env: Env): HypeSettings {
  return {
    enabled: env.HYPE_ENABLED !== 'false' && env.HYPE_ENABLED !== '0',
    // parseInt(undefined) is NaN, which falls back to the default like the JS did
    minMessages: Math.max(5, parseInt(env.HYPE_MIN_MESSAGES as string, 10) || 15),
    windowSec: Number(env.HYPE_WINDOW_SEC) || 60,
    cooldownSec: Math.max(30, parseInt(env.HYPE_COOLDOWN_SEC as string, 10) || 120),
    message: (env.HYPE_MESSAGE || 'Chat is HYPED! 🔥').trim()
  };
}

// ==================== ANNOUNCEMENTS ====================

export interface AnnouncementSettings {
  intervalMs: number;
  messages: string[];
}

// Announcement scheduler config
export function readAnnouncementSettings(env: Env): AnnouncementSettings {
  return {
    intervalMs: Number(env.ANNOUNCEMENT_INTERVAL_MS || 900000), // default 15m
    messages: (env.ANNOUNCEMENTS || '').split('|').map(s => s.trim()).filter(Boolean)
  };
}

// ==================== TTS ====================

// TTS configuration
export const TTS_CONFIG = {
  MAX_LENGTH: 200,
  PER_USER_COOLDOWN_SEC: 30,
  GLOBAL_COOLDOWN_SEC: 10,
  REDEMPTION_QUEUE_MAX_SIZE: 100,
  CHANNEL_POINTS_REWARD_TITLE: 'TTS' // Default reward title to look for
} as const;

// ==================== CUSTOM COMMANDS ====================

export const DEFAULT_COMMAND_REFRESH_SEC = 60;
/** Shortest allowed refresh period, so a tiny value cannot turn the timer into a busy poll */
export const MIN_COMMAND_REFRESH_SEC = 5;

/**
 * Custom command refresh period (and cache TTL) in ms, from COMMAND_REFRESH_INTERVAL
 * in seconds. Missing, zero, negative or non-numeric values use the 60s default;
 * values below the 5s minimum are raised to it.
 */
export function readCommandRefreshMs(env: Env): number {
  const seconds = Number(env.COMMAND_REFRESH_INTERVAL);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_COMMAND_REFRESH_SEC * 1000;
  return Math.max(MIN_COMMAND_REFRESH_SEC, seconds) * 1000;
}

// ==================== DASHBOARD ====================

export function readDashboardBaseUrl(env: Env): string {
  return `http://localhost:${env.DASHBOARD_PORT || 3001}`;
}
