/**
 * Application constants and default values
 * Centralizes all magic numbers and configuration defaults
 */

// ==================== API Configuration ====================

export const TWITCH_API = {
  BASE_URL: 'https://api.twitch.tv/helix',
  AUTH_URL: 'https://id.twitch.tv/oauth2',
  VALIDATE_URL: 'https://id.twitch.tv/oauth2/validate',
  TOKEN_URL: 'https://id.twitch.tv/oauth2/token',
  TIMEOUT_MS: 5000,
} as const;

// ==================== Cache Configuration ====================

export const CACHE = {
  /** Token validation cache duration (1 hour) */
  TOKEN_VALIDATION_TTL_MS: 3600000,

  /** Filter status cache duration (5 seconds) */
  FILTER_STATUS_TTL_MS: 5000,

  /** Custom commands cache TTL (default 60 seconds, configurable via env) */
  CUSTOM_COMMANDS_DEFAULT_TTL_MS: 60000,

  /** Message history expiry for spam detection (10 minutes) */
  MESSAGE_HISTORY_EXPIRY_MS: 600000,

  /** Message history cleanup interval (60 seconds) */
  MESSAGE_HISTORY_CLEANUP_INTERVAL_MS: 60000,

  /** Spam detection window (5 seconds) */
  SPAM_DETECTION_WINDOW_MS: 5000,
} as const;

// ==================== Cooldown Configuration ====================

export const COOLDOWNS = {
  /** Default clip command cooldown (60 seconds) */
  CLIP_DEFAULT_SECONDS: 60,

  /** Minimum poll duration (15 seconds) */
  POLL_MIN_DURATION_SECONDS: 15,

  /** Maximum poll duration (30 minutes) */
  POLL_MAX_DURATION_SECONDS: 1800,

  /** Default poll duration (5 minutes) */
  POLL_DEFAULT_DURATION_SECONDS: 300,

  /** Minimum prediction duration (1 minute) */
  PREDICTION_MIN_DURATION_SECONDS: 60,

  /** Maximum prediction duration (30 minutes) */
  PREDICTION_MAX_DURATION_SECONDS: 1800,

  /** Default prediction duration (5 minutes) */
  PREDICTION_DEFAULT_DURATION_SECONDS: 300,
} as const;

// ==================== Chat Filter Configuration ====================

export const FILTERS = {
  /** Default timeout duration for filter violations (60 seconds) */
  DEFAULT_TIMEOUT_SECONDS: 60,

  /** Minimum message length for all-caps detection */
  ALL_CAPS_MIN_LENGTH: 5,

  /** Threshold for all-caps detection (50%) */
  ALL_CAPS_THRESHOLD: 0.5,

  /** Minimum consecutive repeated chars for detection */
  REPEAT_CHARS_MIN_COUNT: 3,

  /** Regex pattern for URL detection */
  URL_PATTERN: /https?:\/\/|www\./i,

  /** Regex pattern for repeated characters */
  REPEAT_CHARS_PATTERN: /(.)\1{2,}/,
} as const;

// ==================== Dashboard Configuration ====================

export const DASHBOARD = {
  /** Default dashboard port */
  DEFAULT_PORT: 3001,

  /** Maximum command logs to keep */
  MAX_COMMAND_LOGS: 1000,

  /** WebSocket reconnect delay (3 seconds) */
  WS_RECONNECT_DELAY_MS: 3000,

  /** Default announcement interval (15 minutes) */
  DEFAULT_ANNOUNCEMENT_INTERVAL_MS: 900000,

  /** Minimum announcement interval (1 minute) */
  MIN_ANNOUNCEMENT_INTERVAL_MS: 60000,
} as const;

// ==================== Poll/Prediction Configuration ====================

export const POLLS = {
  MIN_OPTIONS: 2,
  MAX_OPTIONS: 5,
} as const;

export const PREDICTIONS = {
  REQUIRED_OUTCOMES: 2,
} as const;

// ==================== Retry Configuration ====================

export const RETRY = {
  /** Maximum retry attempts */
  MAX_ATTEMPTS: 4,

  /** Base delay for exponential backoff (2 seconds) */
  BASE_DELAY_MS: 2000,

  /** Maximum delay between retries (16 seconds) */
  MAX_DELAY_MS: 16000,
} as const;

// ==================== Shutdown Configuration ====================

export const SHUTDOWN = {
  /** Grace period for shutdown (10 seconds) */
  GRACE_PERIOD_MS: 10000,

  /** Restart flag check interval (5 seconds) */
  RESTART_CHECK_INTERVAL_MS: 5000,
} as const;

// ==================== Logging Configuration ====================

export const LOGGING = {
  /** Default log level */
  DEFAULT_LEVEL: 'info' as const,

  /** Log levels in order of severity */
  LEVELS: ['debug', 'info', 'warn', 'error'] as const,

  /** Maximum log file size before rotation (10MB) */
  MAX_FILE_SIZE_BYTES: 10 * 1024 * 1024,

  /** Number of log files to keep */
  MAX_FILES: 5,
} as const;

// ==================== Required Scopes ====================

export const REQUIRED_SCOPES = {
  CHAT_READ: 'chat:read',
  CHAT_EDIT: 'chat:edit',
  CLIPS_EDIT: 'clips:edit',
  CHANNEL_MANAGE_BROADCAST: 'channel:manage:broadcast',
  CHANNEL_MANAGE_POLLS: 'channel:manage:polls',
  CHANNEL_MANAGE_PREDICTIONS: 'channel:manage:predictions',
  MODERATOR_MANAGE_BANNED_USERS: 'moderator:manage:banned_users',
  MODERATOR_READ_FOLLOWERS: 'moderator:read:followers',
  CHANNEL_READ_REDEMPTIONS: 'channel:read:redemptions',
  CHANNEL_READ_SUBSCRIPTIONS: 'channel:read:subscriptions',
  BITS_READ: 'bits:read',
} as const;

// ==================== Event Types ====================

export const EVENT_TYPES = {
  FOLLOW: 'follow',
  SUBSCRIPTION: 'subscription',
  SUBSCRIPTION_GIFT: 'subscription_gift',
  BITS: 'bits',
  RAID: 'raid',
  REDEMPTION: 'redemption',
  STREAM_ONLINE: 'stream.online',
  STREAM_OFFLINE: 'stream.offline',
} as const;

// ==================== Alert Types ====================

export const ALERT_TYPES = {
  FOLLOW: 'follow',
  SUBSCRIPTION: 'subscription',
  BITS: 'bits',
  RAID: 'raid',
  REDEMPTION: 'redemption',
} as const;
