/**
 * Centralized mapping of bot features to their required Twitch API scopes.
 * This allows for automatic scope determination based on enabled features.
 */

import { EnvManager } from './env-manager';

export type AccountType = 'bot' | 'broadcaster';

export interface FeatureScopeInfo {
  name: string;
  description: string;
  bot: string[];
  broadcaster: string[];
}

/** Environment-like key/value map (process.env or a parsed .env file) */
export type EnvLike = Record<string, string | undefined>;

export interface ScopeValidation {
  hasAll: boolean;
  missing: string[];
}

export interface ScopeSyncResult {
  updated: boolean;
  /** Scopes the token has that .env did not list */
  botAdded: string[];
  /** Scopes .env listed that the token does not have */
  botRemoved: string[];
  broadcasterAdded: string[];
  broadcasterRemoved: string[];
}

/** Scopes Twitch reported for each token; an empty or missing list means unknown */
export interface GrantedScopes {
  bot?: string[];
  broadcaster?: string[];
}

/**
 * True for the values that switch an ENABLE_X / DISABLE_X flag on:
 * 'true', '1' or 'yes' (any case, surrounding spaces ignored).
 */
export function isTruthyEnvValue(value: string | undefined): boolean {
  return ['true', '1', 'yes'].includes(String(value ?? '').trim().toLowerCase());
}

export const FEATURE_SCOPES: Record<string, FeatureScopeInfo> = {
  chat: {
    name: 'Chat (Read/Write)',
    description: 'Basic chat functionality for the bot',
    bot: ['chat:read', 'chat:edit', 'channel:bot', 'user:bot', 'user:read:chat', 'user:write:chat'],
    broadcaster: []
  },
  clips: {
    name: 'Clips',
    description: 'Create and manage clips',
    bot: ['clips:edit'],
    broadcaster: []
  },
  announcements: {
    name: 'Announcements',
    description: 'Send chat announcements',
    bot: ['moderator:manage:announcements'],
    broadcaster: []
  },
  shoutouts: {
    name: 'Shoutouts',
    description: 'Send shoutouts to other streamers',
    bot: ['moderator:manage:shoutouts'],
    broadcaster: []
  },
  followage: {
    name: 'Followage',
    description: 'Check how long a user has been following',
    bot: ['moderator:read:followers'],
    broadcaster: ['moderator:read:followers']
  },
  polls: {
    name: 'Polls',
    description: 'Manage channel polls',
    bot: ['channel:manage:polls'],
    broadcaster: ['channel:manage:polls']
  },
  predictions: {
    name: 'Predictions',
    description: 'Manage channel predictions',
    bot: ['channel:manage:predictions'],
    broadcaster: ['channel:manage:predictions']
  },
  redemptions: {
    name: 'Channel Point Redemptions',
    description: 'Monitor and handle channel point redemptions',
    bot: [],
    broadcaster: ['channel:read:redemptions']
  },
  channel_updates: {
    name: 'Channel Updates',
    description: 'Update stream title and category',
    bot: ['channel:manage:broadcast'],
    broadcaster: ['channel:manage:broadcast']
  },
  song_requests: {
    name: 'Song Requests',
    description: 'YouTube-backed song request system',
    bot: ['chat:read', 'chat:edit'],
    broadcaster: ['channel:read:redemptions']
  },
  moderation: {
    name: 'Moderation Management',
    description: 'Ban, timeout, and delete messages',
    bot: ['moderator:manage:banned_users', 'moderator:manage:chat_messages'],
    broadcaster: []
  },
  automod: {
    name: 'AutoMod Management',
    description: 'Manage AutoMod settings and held messages',
    bot: ['moderator:manage:automod', 'moderator:manage:automod_settings'],
    broadcaster: []
  },
  delete_messages: {
    name: 'Delete Messages',
    description: 'Allow bot to delete chat messages',
    bot: ['moderator:manage:chat_messages'],
    broadcaster: []
  },
  shield_mode: {
    name: 'Shield Mode',
    description: 'Manage channel Shield Mode',
    bot: ['moderator:manage:shield_mode'],
    broadcaster: []
  },
  warnings: {
    name: 'User Warnings',
    description: 'Warn users for rule violations',
    bot: ['moderator:manage:warnings'],
    broadcaster: []
  },
  unban_requests: {
    name: 'Unban Requests',
    description: 'Manage channel unban requests',
    bot: ['moderator:manage:unban_requests'],
    broadcaster: []
  },
  moderator_management: {
    name: 'Moderator Management',
    description: 'Add or remove channel moderators',
    bot: ['moderation:read', 'channel:manage:moderators'],
    broadcaster: []
  },
  schedule_management: {
    name: 'Schedule Management',
    description: 'Manage stream schedule',
    bot: ['channel:manage:schedule'],
    broadcaster: []
  },
  ads_management: {
    name: 'Ads Management',
    description: 'Manage channel advertisements',
    bot: ['channel:manage:ads'],
    broadcaster: []
  },
  guest_star: {
    name: 'Guest Star',
    description: 'Manage Twitch Guest Star',
    bot: ['channel:manage:guest_star'],
    broadcaster: []
  },
  user_email: {
    name: 'User Email',
    description: 'Access user email address',
    bot: ['user:read:email'],
    broadcaster: []
  },
  extensions: {
    name: 'Extensions',
    description: 'Manage channel extensions',
    bot: ['channel:manage:extensions'],
    broadcaster: []
  },
  hype_trains: {
    name: 'Hype Trains',
    description: 'Monitor Hype Train events',
    bot: [],
    broadcaster: ['channel:read:hype_train']
  },
  follows_read: {
    name: 'Read Followers',
    description: 'View the list of followers',
    bot: [],
    broadcaster: ['user:read:follows']
  },
  analytics: {
    name: 'Analytics',
    description: 'Access channel and game analytics',
    bot: [],
    broadcaster: ['analytics:read:games']
  },
  charity: {
    name: 'Charity',
    description: 'Monitor charity campaigns',
    bot: [],
    broadcaster: ['channel:read:charity']
  },
  goals: {
    name: 'Creator Goals',
    description: 'Monitor creator goals',
    bot: [],
    broadcaster: ['channel:read:goals']
  },
  whispers: {
    name: 'Whispers',
    description: 'Send and receive whispers',
    bot: ['user:manage:whispers', 'whispers:read'],
    broadcaster: []
  },
  vip_management: {
    name: 'VIP Management',
    description: 'Add and remove VIPs',
    bot: ['channel:manage:vips'],
    broadcaster: []
  },
  bits: {
    name: 'Bits Tracking',
    description: 'Monitor bit cheers',
    bot: [],
    broadcaster: ['bits:read']
  },
  subscriptions: {
    name: 'Subscription Tracking',
    description: 'Monitor new and renewed subscriptions',
    bot: [],
    broadcaster: ['channel:read:subscriptions']
  },
  eventsub: {
    name: 'EventSub Alerts',
    description: 'Real-time alerts for follows, subs, bits, etc.',
    bot: [],
    broadcaster: [
      'moderator:read:followers',
      'channel:read:subscriptions',
      'bits:read',
      'channel:read:redemptions'
    ]
  }
};

/**
 * Determine which features are active based on environment configuration.
 *
 * @param env - Environment variables (e.g. process.env)
 * @returns - Array of active feature keys
 */
export function getActiveFeatures(env: EnvLike = process.env): string[] {
  const active = ['chat']; // Chat is foundational

  // Feature detection based on env vars
  if (env.YOUTUBE_API_KEY) {
    active.push('song_requests'); // Song requests
    if (!active.includes('redemptions')) active.push('redemptions');
  }

  if (!isTruthyEnvValue(env.DISABLE_EVENTSUB)) {
    active.push('eventsub');
    // EventSub usually implies we want to track these
    if (!active.includes('subscriptions')) active.push('subscriptions');
    if (!active.includes('bits')) active.push('bits');
  }

  // OPT-IN MODEL: Features are disabled by default unless ENABLE_FEATURE_X=true
  // Standard bot features that are commonly expected to be on
  const standardFeatures = [
    'clips', 'shoutouts', 'followage', 'polls', 'predictions',
    'announcements', 'moderation', 'delete_messages'
  ];

  const allFeatureKeys = Object.keys(FEATURE_SCOPES);
  const skipAutoDetect = ['chat', 'song_requests', 'redemptions', 'eventsub', 'subscriptions', 'bits'];

  allFeatureKeys.forEach(feature => {
    if (skipAutoDetect.includes(feature)) return;

    const enableVar = `ENABLE_${feature.toUpperCase()}`;
    const disableVar = `DISABLE_${feature.toUpperCase()}`;

    // If it's a standard feature, enable it unless explicitly disabled
    if (standardFeatures.includes(feature)) {
      if (!isTruthyEnvValue(env[disableVar])) {
        active.push(feature);
      }
    } else {
      // For all other features, require explicit enablement
      if (isTruthyEnvValue(env[enableVar])) {
        active.push(feature);
      }
    }
  });

  return active;
}

/**
 * Check if the provided scopes cover the requirements for a specific feature.
 *
 * @param feature - Feature key
 * @param currentScopes - Scopes currently held
 * @param accountType - 'bot' or 'broadcaster'
 * @returns - True if all required scopes are present
 */
export function hasRequiredScopes(
  feature: string,
  currentScopes: string[] | null | undefined,
  accountType: AccountType = 'bot'
): boolean {
  const featureData = FEATURE_SCOPES[feature] as FeatureScopeInfo | undefined;
  if (!featureData) return true; // Unknown feature, assume no scopes needed

  const required = featureData[accountType] || [];
  if (required.length === 0) return true;

  const current = new Set(currentScopes || []);
  return required.every(s => current.has(s));
}

/**
 * Get all required scopes for a set of active features.
 *
 * @param activeFeatures - Array of active feature keys
 * @param accountType - 'bot' or 'broadcaster'
 * @returns - Sorted array of unique scopes
 */
export function getRequiredScopes(activeFeatures: string[], accountType: AccountType): string[] {
  const scopes = new Set<string>();

  activeFeatures.forEach(feature => {
    const featureData = FEATURE_SCOPES[feature] as FeatureScopeInfo | undefined;
    if (featureData && featureData[accountType]) {
      featureData[accountType].forEach(s => scopes.add(s));
    }
  });

  return Array.from(scopes).sort();
}

/**
 * Check if the current scopes cover the required scopes for active features.
 *
 * @param currentScopes - Array of scopes currently held by the token
 * @param requiredScopes - Array of scopes required for active features
 * @returns - { hasAll: boolean, missing: string[] }
 */
export function validateScopes(currentScopes: string[] | null | undefined, requiredScopes: string[]): ScopeValidation {
  const current = new Set(currentScopes || []);
  const missing = requiredScopes.filter(s => !current.has(s));

  return {
    hasAll: missing.length === 0,
    missing
  };
}

/**
 * Record the scopes Twitch actually granted each token in the .env file
 * (TWITCH_SCOPES and TWITCH_BROADCASTER_SCOPES), so the file never claims
 * scopes a token does not have. An account whose granted list is empty
 * (token missing, invalid or not validated) is left untouched.
 *
 * @param envPath - Path to the .env file
 * @param granted - Scopes from Twitch token validation, per account
 * @returns - What was added to and removed from each line
 */
export async function syncGrantedScopes(envPath: string, granted: GrantedScopes): Promise<ScopeSyncResult> {
  const envManager = new EnvManager(envPath);
  const currentEnv = await envManager.getEnv();
  const result: ScopeSyncResult = {
    updated: false, botAdded: [], botRemoved: [], broadcasterAdded: [], broadcasterRemoved: []
  };
  const updates: Record<string, string> = {};

  const sync = (key: string, scopes: string[] | undefined): { added: string[]; removed: string[] } => {
    if (!scopes || scopes.length === 0) return { added: [], removed: [] };
    const recorded = (currentEnv[key] || '').split(' ').filter(s => s);
    const added = scopes.filter(s => !recorded.includes(s));
    const removed = recorded.filter(s => !scopes.includes(s));
    if (added.length > 0 || removed.length > 0) {
      updates[key] = Array.from(new Set(scopes)).sort().join(' ');
    }
    return { added, removed };
  };

  const bot = sync('TWITCH_SCOPES', granted.bot);
  const broadcaster = sync('TWITCH_BROADCASTER_SCOPES', granted.broadcaster);
  result.botAdded = bot.added;
  result.botRemoved = bot.removed;
  result.broadcasterAdded = broadcaster.added;
  result.broadcasterRemoved = broadcaster.removed;

  if (Object.keys(updates).length > 0) {
    await envManager.updateEnv(updates);
    result.updated = true;
  }
  return result;
}
