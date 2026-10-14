/**
 * The .env settings the dashboard Settings page can show and edit.
 *
 * One typed definition per key drives both GET/PUT /api/config and the browser
 * form, so the two cannot drift. Keys that are not listed here can neither be
 * read nor written through the API. Secret keys are write-only: the API only
 * says whether they are set. Chat filter keys (CHAT_FILTER_*) are not listed
 * because the Chat Filters page owns them and applies them live.
 */

import { ValidationError } from '../../lib/api-utils';
import { isTruthyEnvValue } from '../../lib/feature-scopes';

/** How a setting is edited and validated */
export type SettingType = 'string' | 'integer' | 'boolean' | 'enum' | 'list' | 'secret';

/** What has to restart before a saved value takes effect */
export type SettingApplies = 'live' | 'bot' | 'dashboard' | 'token-generator';

/** A group (one panel on the Settings page) */
export interface SettingGroup {
  id: string;
  title: string;
  description?: string;
}

export interface SettingDefinition {
  /** The .env key */
  key: string;
  group: string;
  label: string;
  description?: string;
  type: SettingType;
  /** Value used when the key is unset (shown as the placeholder); never set for secrets */
  default?: string | number | boolean;
  /** integer: inclusive bounds */
  min?: number;
  max?: number;
  /** string/list: maximum length of the stored value */
  maxLength?: number;
  /** string/list items: pattern each value (or list item) must match */
  pattern?: RegExp;
  /** Message used when `pattern` does not match */
  patternMessage?: string;
  /** enum: the allowed values */
  options?: string[];
  /** list: separator used in .env (default ',') */
  separator?: string;
  /** integer: the UI shows value / scale (e.g. 60000 shows milliseconds as minutes) */
  scale?: number;
  /** Unit shown next to the input (after scaling) */
  unit?: string;
  /** boolean: write "false" by removing the key (for flags read as "set = on") */
  falseUnsets?: boolean;
  /** boolean: how the code reading this key turns a non-empty value into on/off */
  isOn?: (raw: string) => boolean;
  /** Shown but never written through the API */
  readOnly?: boolean;
  /** Why a read-only setting cannot be edited here */
  readOnlyReason?: string;
  applies: SettingApplies;
}

/** The value a setting has after parsing, as GET /api/config reports it */
export type SettingValue = string | number | boolean | string[] | null;

export const SETTING_GROUPS: SettingGroup[] = [
  { id: 'general', title: 'General', description: 'Channels the bot joins and how often it refreshes commands.' },
  { id: 'welcome', title: 'Welcome & Hype', description: 'First-time chatter greetings and the chat hype detector.' },
  { id: 'announcements', title: 'Announcements', description: 'Edit the messages on the Announcements page; this sets how often they rotate.' },
  { id: 'tts', title: 'Text-to-Speech', description: 'Voice provider for !tts and TTS redemptions. Applies immediately.' },
  { id: 'integrations', title: 'Integrations', description: 'API keys for optional features.' },
  { id: 'twitch', title: 'Twitch Account', description: 'Use the token generator (port 3000) to sign in and create tokens.' },
  { id: 'server', title: 'Servers', description: 'Ports and network settings for the dashboard and token generator.' }
];

const TWITCH_LOGIN = /^[A-Za-z0-9_]{1,25}$/;
const TWITCH_LOGIN_MESSAGE = 'must be a Twitch username (letters, digits and underscores, up to 25 characters)';

/** On unless the value is false, 0, no or off (any case), like isFalsyEnvValue in bot/config */
function notFalsyWord(raw: string): boolean {
  return !['false', '0', 'no', 'off'].includes(raw.toLowerCase());
}

export const SETTINGS: SettingDefinition[] = [
  // ---- General ----
  {
    key: 'TWITCH_BROADCASTER_NAME', group: 'general', label: 'Broadcaster name', type: 'string',
    description: 'Your Twitch username. Used for broadcaster-only commands and EventSub.',
    pattern: TWITCH_LOGIN, patternMessage: TWITCH_LOGIN_MESSAGE, applies: 'bot'
  },
  {
    key: 'TWITCH_CHANNELS', group: 'general', label: 'Channels', type: 'list',
    description: 'Channels the bot joins, comma-separated.', separator: ',', maxLength: 1000,
    pattern: TWITCH_LOGIN, patternMessage: TWITCH_LOGIN_MESSAGE, applies: 'bot'
  },
  {
    key: 'COMMAND_REFRESH_INTERVAL', group: 'general', label: 'Command refresh interval', type: 'integer',
    description: 'How often the bot reloads custom commands from the dashboard.',
    default: 60, min: 5, max: 3600, unit: 'seconds', applies: 'bot'
  },
  {
    key: 'DISABLE_EVENTSUB', group: 'general', label: 'Disable EventSub', type: 'boolean', default: false,
    isOn: isTruthyEnvValue,
    description: 'Turn off follow/sub/raid/redemption events (use when the broadcaster token is not set up).',
    applies: 'bot'
  },
  {
    key: 'DEBUG', group: 'general', label: 'Debug logging', type: 'boolean', default: false, falseUnsets: true,
    isOn: () => true,
    description: 'Print extra debug lines in the bot and dashboard logs.', applies: 'bot'
  },

  // ---- Welcome & Hype ----
  {
    key: 'FIRST_CHATTER_WELCOME_ENABLED', group: 'welcome', label: 'Welcome first-time chatters', type: 'boolean',
    default: true, isOn: notFalsyWord, applies: 'bot'
  },
  {
    key: 'FIRST_CHATTER_MESSAGE', group: 'welcome', label: 'Welcome message', type: 'string',
    default: 'Welcome to the chat, {user}!', maxLength: 300, description: '{user} is replaced with the chatter\'s name.',
    applies: 'bot'
  },
  {
    key: 'FIRST_CHATTER_ALERT_ENABLED', group: 'welcome', label: 'First-time chatter overlay alert', type: 'boolean',
    default: true, isOn: notFalsyWord, applies: 'bot'
  },
  {
    key: 'HYPE_ENABLED', group: 'welcome', label: 'Hype detector', type: 'boolean', default: true,
    isOn: raw => raw !== 'false' && raw !== '0', applies: 'bot'
  },
  {
    key: 'HYPE_MIN_MESSAGES', group: 'welcome', label: 'Messages needed for hype', type: 'integer',
    default: 15, min: 5, max: 1000, unit: 'messages', applies: 'bot'
  },
  {
    key: 'HYPE_WINDOW_SEC', group: 'welcome', label: 'Hype window', type: 'integer',
    default: 60, min: 5, max: 3600, unit: 'seconds', applies: 'bot'
  },
  {
    key: 'HYPE_COOLDOWN_SEC', group: 'welcome', label: 'Hype cooldown', type: 'integer',
    default: 120, min: 30, max: 86400, unit: 'seconds', applies: 'bot'
  },
  {
    key: 'HYPE_MESSAGE', group: 'welcome', label: 'Hype message', type: 'string',
    default: 'Chat is HYPED! 🔥', maxLength: 300, applies: 'bot'
  },

  // ---- Announcements ----
  {
    key: 'ANNOUNCEMENT_INTERVAL_MS', group: 'announcements', label: 'Announcement interval', type: 'integer',
    default: 900000, min: 60000, max: 86400000, scale: 60000, unit: 'minutes',
    description: 'Time between rotating announcements (at least 1 minute).', applies: 'bot'
  },

  // ---- TTS ----
  {
    key: 'TTS_PROVIDER', group: 'tts', label: 'Provider', type: 'enum', default: 'browser',
    options: ['browser', 'elevenlabs', 'openai'],
    description: 'Browser voices are free; ElevenLabs and OpenAI need an API key and fall back to the browser on errors.',
    applies: 'live'
  },
  {
    key: 'TTS_REWARD_TITLE', group: 'tts', label: 'Channel points reward title', type: 'string', default: 'TTS',
    maxLength: 100, description: 'Redemptions whose title contains this text are read aloud.', applies: 'bot'
  },
  { key: 'ELEVENLABS_API_KEY', group: 'tts', label: 'ElevenLabs API key', type: 'secret', applies: 'live' },
  {
    key: 'ELEVENLABS_VOICE_ID', group: 'tts', label: 'ElevenLabs voice ID', type: 'string',
    default: 'EXAVITQu4vr4xnSDxMaL', maxLength: 64, pattern: /^[A-Za-z0-9]+$/, patternMessage: 'must contain only letters and digits',
    applies: 'live'
  },
  {
    key: 'ELEVENLABS_MODEL', group: 'tts', label: 'ElevenLabs model', type: 'string', default: 'eleven_monolingual_v1',
    maxLength: 64, pattern: /^[A-Za-z0-9_.-]+$/, patternMessage: 'must contain only letters, digits, _ . and -', applies: 'live'
  },
  { key: 'OPENAI_API_KEY', group: 'tts', label: 'OpenAI API key', type: 'secret', applies: 'live' },
  {
    key: 'OPENAI_TTS_VOICE', group: 'tts', label: 'OpenAI voice', type: 'enum', default: 'alloy',
    options: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'], applies: 'live'
  },
  {
    key: 'OPENAI_TTS_MODEL', group: 'tts', label: 'OpenAI model', type: 'enum', default: 'tts-1',
    options: ['tts-1', 'tts-1-hd'], applies: 'live'
  },
  {
    key: 'TTS_CACHE_MAX_AGE', group: 'tts', label: 'Audio cache lifetime', type: 'integer', default: 86400000,
    min: 3600000, max: 2592000000, scale: 3600000, unit: 'hours', applies: 'live'
  },
  {
    key: 'TTS_CACHE_MAX_SIZE', group: 'tts', label: 'Audio cache size limit', type: 'integer', default: 104857600,
    min: 1048576, max: 10737418240, scale: 1048576, unit: 'MB', applies: 'live'
  },
  {
    key: 'TTS_CACHE_ENABLED', group: 'tts', label: 'Cache generated audio', type: 'boolean', default: true,
    isOn: raw => raw !== 'false',
    applies: 'dashboard'
  },

  // ---- Integrations ----
  {
    key: 'YOUTUBE_API_KEY', group: 'integrations', label: 'YouTube Data API key', type: 'secret',
    description: 'Needed for song requests. Create one in Google Cloud Console (YouTube Data API v3).', applies: 'bot'
  },

  // ---- Twitch account ----
  {
    key: 'TWITCH_CLIENT_ID', group: 'twitch', label: 'Client ID', type: 'string', maxLength: 64,
    pattern: /^[A-Za-z0-9]+$/, patternMessage: 'must contain only letters and digits', applies: 'bot'
  },
  { key: 'TWITCH_CLIENT_SECRET', group: 'twitch', label: 'Client secret', type: 'secret', applies: 'bot' },
  {
    key: 'TWITCH_SCOPES', group: 'twitch', label: 'Bot token scopes', type: 'list', separator: ' ', readOnly: true,
    readOnlyReason: 'Set by the token generator when you authorize.', applies: 'bot'
  },
  {
    key: 'TWITCH_ACCESS_TOKEN', group: 'twitch', label: 'Bot access token', type: 'secret', readOnly: true,
    readOnlyReason: 'Created and refreshed by the token generator.', applies: 'bot'
  },
  {
    key: 'TWITCH_REFRESH_TOKEN', group: 'twitch', label: 'Bot refresh token', type: 'secret', readOnly: true,
    readOnlyReason: 'Created and refreshed by the token generator.', applies: 'bot'
  },
  {
    key: 'TWITCH_BROADCASTER_SCOPES', group: 'twitch', label: 'Broadcaster token scopes', type: 'list', separator: ' ',
    readOnly: true, readOnlyReason: 'Set by the token generator when you authorize.', applies: 'bot'
  },
  {
    key: 'TWITCH_BROADCASTER_ACCESS_TOKEN', group: 'twitch', label: 'Broadcaster access token', type: 'secret',
    readOnly: true, readOnlyReason: 'Created and refreshed by the token generator.', applies: 'bot'
  },
  {
    key: 'TWITCH_BROADCASTER_REFRESH_TOKEN', group: 'twitch', label: 'Broadcaster refresh token', type: 'secret',
    readOnly: true, readOnlyReason: 'Created and refreshed by the token generator.', applies: 'bot'
  },

  // ---- Servers ----
  {
    key: 'DASHBOARD_PORT', group: 'server', label: 'Dashboard port', type: 'integer', default: 3001,
    min: 1, max: 65535, applies: 'dashboard'
  },
  {
    key: 'TOKEN_GENERATOR_PORT', group: 'server', label: 'Token generator port', type: 'integer', default: 3000,
    min: 1, max: 65535, applies: 'token-generator'
  },
  {
    key: 'DASHBOARD_HOST', group: 'server', label: 'Dashboard listen address', type: 'string', default: '127.0.0.1',
    readOnly: true, readOnlyReason: 'Controls who can reach this page, so it can only be changed in .env.',
    applies: 'dashboard'
  },
  {
    key: 'DASHBOARD_INTERNAL_SECRET', group: 'server', label: 'Bot-to-dashboard secret', type: 'secret',
    readOnly: true, readOnlyReason: 'Protects bot-only writes, so it can only be changed in .env.', applies: 'dashboard'
  }
];

const SETTINGS_BY_KEY = new Map(SETTINGS.map(def => [def.key, def]));

/** The definition for `key`, if the Settings page manages it */
export function getSettingDefinition(key: string): SettingDefinition | undefined {
  return SETTINGS_BY_KEY.get(key);
}


/**
 * Parse a stored .env string the way the bot reads it, for display.
 * Secrets are never parsed (callers report only whether they are set).
 */
export function parseSettingValue(def: SettingDefinition, raw: string | undefined): SettingValue {
  if (raw === undefined || raw === '') {
    if (def.type === 'boolean') return (def.default as boolean | undefined) ?? false;
    if (def.type === 'list') return [];
    return null;
  }
  switch (def.type) {
    case 'boolean':
      return (def.isOn ?? notFalsyWord)(raw);
    case 'integer': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    }
    case 'list':
      return splitList(def, raw);
    case 'secret':
      return null;
    default:
      return raw;
  }
}

function splitList(def: SettingDefinition, raw: string): string[] {
  const separator = def.separator ?? ',';
  const parts = separator === ' ' ? raw.split(/\s+/) : raw.split(separator);
  return parts.map(part => part.trim()).filter(Boolean);
}

/**
 * Validate a value sent to PUT /api/config and return the string to store in
 * .env, or null to remove the key (back to its default). Throws ValidationError.
 * `null` (or '' for non-boolean types) always means "remove".
 */
export function serializeSettingValue(def: SettingDefinition, value: unknown): string | null {
  if (def.readOnly) throw new ValidationError(`${def.key} cannot be changed from the dashboard`);
  if (value === null) return null;

  const fail = (message: string): never => {
    throw new ValidationError(`${def.label} (${def.key}) ${message}`);
  };

  switch (def.type) {
    case 'boolean': {
      if (typeof value !== 'boolean') fail('must be true or false');
      if (!value && def.falseUnsets) return null;
      return value ? 'true' : 'false';
    }
    case 'integer': {
      if (value === '') return null;
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isInteger(n)) fail('must be a whole number');
      const num = n as number;
      if (def.min !== undefined && num < def.min) fail(`must be at least ${def.min}`);
      if (def.max !== undefined && num > def.max) fail(`must be at most ${def.max}`);
      return String(num);
    }
    case 'enum': {
      if (value === '') return null;
      if (typeof value !== 'string' || !def.options?.includes(value)) fail(`must be one of: ${def.options?.join(', ')}`);
      return value as string;
    }
    case 'list': {
      const items = Array.isArray(value) ? value : typeof value === 'string' ? splitList(def, value) : fail('must be a list');
      if (!items.every(item => typeof item === 'string')) fail('must be a list of text values');
      const cleaned = [...new Set((items as string[]).map(item => item.trim()).filter(Boolean))];
      if (cleaned.length === 0) return null;
      if (def.pattern && !cleaned.every(item => def.pattern!.test(item))) {
        fail(`entries ${def.patternMessage ?? 'are invalid'}`);
      }
      const joined = cleaned.join(def.separator ?? ',');
      if (def.maxLength !== undefined && joined.length > def.maxLength) fail(`must be at most ${def.maxLength} characters`);
      return joined;
    }
    case 'secret':
    case 'string': {
      if (typeof value !== 'string') fail('must be text');
      const text = (value as string).trim();
      if (text === '') return null;
      if (/[\r\n\0]/.test(text)) fail('cannot contain line breaks');
      if (def.maxLength !== undefined && text.length > def.maxLength) fail(`must be at most ${def.maxLength} characters`);
      if (def.pattern && !def.pattern.test(text)) fail(def.patternMessage ?? 'is invalid');
      return text;
    }
  }
  return fail('has an unknown type');
}

/** One setting as GET /api/config reports it */
export interface SettingState {
  key: string;
  group: string;
  label: string;
  description?: string;
  type: SettingType;
  default?: string | number | boolean;
  min?: number;
  max?: number;
  maxLength?: number;
  options?: string[];
  separator?: string;
  scale?: number;
  unit?: string;
  readOnly: boolean;
  readOnlyReason?: string;
  applies: SettingApplies;
  /** Parsed value (null when unset); always null for secrets */
  value: SettingValue;
  /** Whether the key has a non-empty value */
  isSet: boolean;
  /**
   * Set by the process environment (e.g. Docker), not by .env. dotenv never
   * overrides those, so an edit saved to .env would not take effect.
   */
  fromEnvironment: boolean;
}

/**
 * Whether the process environment holds a value for `key` that .env does not
 * explain (missing from .env, or different there). dotenv never overrides the
 * environment, so such a key ignores .env edits. PUT /api/config keeps
 * process.env in step with .env for every other key, which keeps this exact.
 */
export function isSetByEnvironment(key: string, fileEnv: Record<string, string>, processEnv: NodeJS.ProcessEnv): boolean {
  const envValue = processEnv[key];
  if (envValue === undefined || envValue === '') return false;
  return !Object.prototype.hasOwnProperty.call(fileEnv, key) || fileEnv[key] !== envValue;
}

/**
 * Describe every setting from the .env file values and the process environment.
 * The reported value is the effective one: the environment's when it overrides
 * .env (`setByEnvironment`, default isSetByEnvironment), otherwise .env's.
 * Secrets report only `isSet`.
 */
export function describeSettings(
  fileEnv: Record<string, string>,
  processEnv: NodeJS.ProcessEnv,
  setByEnvironment: (key: string, fileEnv: Record<string, string>) => boolean =
    (key, file) => isSetByEnvironment(key, file, processEnv)
): SettingState[] {
  return SETTINGS.map(def => {
    const fromEnvironment = setByEnvironment(def.key, fileEnv);
    const raw = fromEnvironment ? processEnv[def.key] : fileEnv[def.key];
    const { pattern: _pattern, patternMessage: _message, falseUnsets: _unsets, isOn: _isOn, ...publicDef } = def;
    return {
      ...publicDef,
      readOnly: !!def.readOnly,
      value: def.type === 'secret' ? null : parseSettingValue(def, raw),
      isSet: raw !== undefined && raw !== '',
      fromEnvironment
    };
  });
}
