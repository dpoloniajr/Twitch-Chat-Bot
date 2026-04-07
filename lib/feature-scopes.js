/**
 * Centralized mapping of bot features to their required Twitch API scopes.
 * This allows for automatic scope determination based on enabled features.
 */

const FEATURE_SCOPES = {
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
    broadcaster: []
  },
  polls: {
    name: 'Polls',
    description: 'Manage channel polls',
    bot: ['channel:manage:polls'],
    broadcaster: []
  },
  predictions: {
    name: 'Predictions',
    description: 'Manage channel predictions',
    bot: ['channel:manage:predictions'],
    broadcaster: []
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
 * @param {Object} env - Environment variables (e.g. process.env)
 * @returns {string[]} - Array of active feature keys
 */
function getActiveFeatures(env = process.env) {
  const active = ['chat']; // Chat is foundational
  
  // Feature detection based on env vars
  if (env.YOUTUBE_API_KEY) {
    active.push('song_requests'); // Song requests
    if (!active.includes('redemptions')) active.push('redemptions');
  }
  
  if (env.DISABLE_EVENTSUB !== 'true' && env.DISABLE_EVENTSUB !== '1') {
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
      if (env[disableVar] !== 'true' && env[disableVar] !== '1') {
        active.push(feature);
      }
    } else {
      // For all other features, require explicit enablement
      if (env[enableVar] === 'true' || env[enableVar] === '1') {
        active.push(feature);
      }
    }
  });
  
  return active;
}

/**
 * Check if the provided scopes cover the requirements for a specific feature.
 * 
 * @param {string} feature - Feature key
 * @param {string[]} currentScopes - Scopes currently held
 * @param {string} accountType - 'bot' or 'broadcaster'
 * @returns {boolean} - True if all required scopes are present
 */
function hasRequiredScopes(feature, currentScopes, accountType = 'bot') {
  const featureData = FEATURE_SCOPES[feature];
  if (!featureData) return true; // Unknown feature, assume no scopes needed
  
  const required = featureData[accountType] || [];
  if (required.length === 0) return true;
  
  const current = new Set(currentScopes || []);
  return required.every(s => current.has(s));
}

/**
 * Get all required scopes for a set of active features.
 * 
 * @param {string[]} activeFeatures - Array of active feature keys
 * @param {string} accountType - 'bot' or 'broadcaster'
 * @returns {string[]} - Sorted array of unique scopes
 */
function getRequiredScopes(activeFeatures, accountType) {
  const scopes = new Set();
  
  activeFeatures.forEach(feature => {
    const featureData = FEATURE_SCOPES[feature];
    if (featureData && featureData[accountType]) {
      featureData[accountType].forEach(s => scopes.add(s));
    }
  });
  
  return Array.from(scopes).sort();
}

/**
 * Check if the current scopes cover the required scopes for active features.
 * 
 * @param {string[]} currentScopes - Array of scopes currently held by the token
 * @param {string[]} requiredScopes - Array of scopes required for active features
 * @returns {Object} - { hasAll: boolean, missing: string[] }
 */
function validateScopes(currentScopes, requiredScopes) {
  const current = new Set(currentScopes || []);
  const missing = requiredScopes.filter(s => !current.has(s));
  
  return {
    hasAll: missing.length === 0,
    missing
  };
}

const EnvManager = require('./env-manager');

/**
 * Sync the required scopes to the .env file based on currently active features.
 * This ensures the user doesn't have to manually manage TWITCH_SCOPES and TWITCH_BROADCASTER_SCOPES.
 * 
 * @param {string} envPath - Path to the .env file
 * @returns {Promise<Object>} - { updated: boolean, botAdded: string[], broadcasterAdded: string[] }
 */
async function syncRequiredScopes(envPath = '.env') {
  const envManager = new EnvManager(envPath);
  const currentEnv = await envManager.getEnv();
  
  const activeFeatures = getActiveFeatures(currentEnv);
  const botRequired = getRequiredScopes(activeFeatures, 'bot');
  const broadcasterRequired = getRequiredScopes(activeFeatures, 'broadcaster');
  
  const botCurrent = (currentEnv.TWITCH_SCOPES || '').split(' ').filter(s => s);
  const broadcasterCurrent = (currentEnv.TWITCH_BROADCASTER_SCOPES || '').split(' ').filter(s => s);
  
  const botMissing = botRequired.filter(s => !botCurrent.includes(s));
  const broadcasterMissing = broadcasterRequired.filter(s => !broadcasterCurrent.includes(s));
  
  if (botMissing.length > 0 || broadcasterMissing.length > 0) {
    const updates = {};
    
    if (botMissing.length > 0) {
      // We want to add missing scopes while preserving existing ones
      const newBotScopes = Array.from(new Set([...botCurrent, ...botRequired])).sort().join(' ');
      updates.TWITCH_SCOPES = newBotScopes;
    }
    
    if (broadcasterMissing.length > 0) {
      const newBroadcasterScopes = Array.from(new Set([...broadcasterCurrent, ...broadcasterRequired])).sort().join(' ');
      updates.TWITCH_BROADCASTER_SCOPES = newBroadcasterScopes;
    }
    
    await envManager.updateEnv(updates);
    return {
      updated: true,
      botAdded: botMissing,
      broadcasterAdded: broadcasterMissing
    };
  }
  
  return {
    updated: false,
    botAdded: [],
    broadcasterAdded: []
  };
}

module.exports = {
  FEATURE_SCOPES,
  getActiveFeatures,
  getRequiredScopes,
  validateScopes,
  syncRequiredScopes,
  hasRequiredScopes
};
