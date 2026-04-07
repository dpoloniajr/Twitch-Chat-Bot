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
 * This can be expanded as more explicit feature toggles are added.
 * 
 * @param {Object} env - Environment variables (e.g. process.env)
 * @returns {string[]} - Array of active feature keys
 */
function getActiveFeatures(env = process.env) {
  const active = ['chat']; // Chat is foundational
  
  // Feature detection based on env vars
  if (env.YOUTUBE_API_KEY) {
    active.push('redemptions'); // Song requests
  }
  
  if (env.DISABLE_EVENTSUB !== 'true') {
    active.push('eventsub');
    // EventSub usually implies we want to track these
    if (!active.includes('subscriptions')) active.push('subscriptions');
    if (!active.includes('bits')) active.push('bits');
  }

  // Commands that are always present in commandRegistry unless explicitly disabled
  // These are enabled by default for now
  const defaultFeatures = [
    'clips', 
    'announcements', 
    'shoutouts', 
    'followage', 
    'polls', 
    'predictions', 
    'channel_updates', 
    'moderation',
    'automod'
  ];
  
  defaultFeatures.forEach(feature => {
    const envVar = `DISABLE_${feature.toUpperCase()}`;
    if (env[envVar] !== 'true') {
      active.push(feature);
    }
  });
  
  return active;
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

module.exports = {
  FEATURE_SCOPES,
  getActiveFeatures,
  getRequiredScopes,
  validateScopes
};
