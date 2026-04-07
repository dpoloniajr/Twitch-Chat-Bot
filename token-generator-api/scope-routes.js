const express = require('express');
const router = express.Router();
const featureScopes = require('../lib/feature-scopes');

const SCOPE_CATEGORIES = {
  'Chat (IRC)': [
    { scope: 'chat:read', description: 'Read chat messages' },
    { scope: 'chat:edit', description: 'Send chat messages' }
  ],
  'Chat (Bot/User)': [
    { scope: 'channel:bot', description: 'Join chat as a bot and perform chat actions' },
    { scope: 'user:bot', description: 'Join chat as a user and appear as a bot' },
    { scope: 'user:write:chat', description: 'Send chat messages as user' },
    { scope: 'user:read:chat', description: 'Receive chatroom messages' },
    { scope: 'moderator:manage:announcements', description: 'Send announcements in chat' }
  ],
  'Clips': [
    { scope: 'clips:edit', description: 'Create and manage clips' },
    { scope: 'channel:manage:clips', description: 'Manage clips for a channel' },
    { scope: 'editor:manage:clips', description: 'Create clips as an editor' }
  ],
  'Moderation': [
    { scope: 'moderation:read', description: 'View channel moderation data' },
    { scope: 'moderator:read:banned_users', description: 'View banned users' },
    { scope: 'moderator:manage:banned_users', description: 'Ban and unban users' },
    { scope: 'moderator:read:followers', description: 'Read followers list' },
    { scope: 'moderator:read:moderators', description: 'Read moderators list' },
    { scope: 'channel:manage:moderators', description: 'Add/remove moderators' },
    { scope: 'moderator:manage:chat_messages', description: 'Delete chat messages' },
    { scope: 'moderator:read:chat_messages', description: 'Read deleted chat messages' },
    { scope: 'moderator:read:automod_settings', description: 'View AutoMod settings' },
    { scope: 'moderator:manage:automod_settings', description: 'Manage AutoMod settings' },
    { scope: 'moderator:manage:automod', description: 'Manage held AutoMod messages' },
    { scope: 'moderator:read:blocked_terms', description: 'View blocked terms' },
    { scope: 'moderator:manage:blocked_terms', description: 'Manage blocked terms' },
    { scope: 'moderator:read:chat_settings', description: 'View chat settings' },
    { scope: 'moderator:manage:chat_settings', description: 'Manage chat settings' },
    { scope: 'moderator:read:chatters', description: 'View chatters in chatroom' },
    { scope: 'moderator:read:shoutouts', description: 'View shoutouts' },
    { scope: 'moderator:manage:shoutouts', description: 'Send shoutouts' }
  ],
  'Channel Management': [
    { scope: 'channel:manage:broadcast', description: 'Manage broadcast settings' },
    { scope: 'channel:read:ads', description: 'Read ads schedule' },
    { scope: 'channel:manage:ads', description: 'Manage ads schedule' },
    { scope: 'channel:edit:commercial', description: 'Run commercials' },
    { scope: 'channel:read:stream_key', description: 'View stream key' },
    { scope: 'channel:manage:schedule', description: 'Manage stream schedule' },
    { scope: 'channel:manage:videos', description: 'Manage videos' },
    { scope: 'channel:read:editors', description: 'View channel editors' }
  ],
  'Followers & Subscriptions': [
    { scope: 'channel:read:subscriptions', description: 'View channel subscriptions' },
    { scope: 'user:read:follows', description: 'View channels you follow' }
  ],
  'VIPs': [
    { scope: 'channel:read:vips', description: 'View VIPs in channel' },
    { scope: 'channel:manage:vips', description: 'Manage VIPs' },
    { scope: 'moderator:read:vips', description: 'View VIPs (moderator view)' }
  ],
  'Channel Points': [
    { scope: 'channel:read:redemptions', description: 'View Channel Points redemptions' },
    { scope: 'channel:manage:redemptions', description: 'Manage Channel Points redemptions' },
    { scope: 'channel:read:predictions', description: 'View predictions' },
    { scope: 'channel:manage:predictions', description: 'Manage predictions' },
    { scope: 'channel:read:polls', description: 'View polls' },
    { scope: 'channel:manage:polls', description: 'Manage polls' }
  ],
  'User Account': [
    { scope: 'user:edit', description: 'Manage user object' },
    { scope: 'user:read:email', description: 'View email address' },
    { scope: 'user:read:emotes', description: 'View emotes available' },
    { scope: 'user:manage:chat_color', description: 'Update chat color' }
  ],
  'Extensions & Analytics': [
    { scope: 'analytics:read:extensions', description: 'View extension analytics' },
    { scope: 'analytics:read:games', description: 'View game analytics' },
    { scope: 'channel:manage:extensions', description: 'Manage extensions' },
    { scope: 'channel:read:extensions', description: 'View extensions (if scope exists)' },
    { scope: 'user:read:broadcast', description: 'View broadcast config' },
    { scope: 'user:edit:broadcast', description: 'Edit broadcast config' }
  ],
  'Bits': [
    { scope: 'bits:read', description: 'View Bits information' }
  ],
  'Guest Star': [
    { scope: 'channel:read:guest_star', description: 'View Guest Star details' },
    { scope: 'channel:manage:guest_star', description: 'Manage Guest Star' },
    { scope: 'moderator:read:guest_star', description: 'View Guest Star (moderator)' },
    { scope: 'moderator:manage:guest_star', description: 'Manage Guest Star (moderator)' }
  ],
  'Other': [
    { scope: 'channel:read:charity', description: 'View charity campaign details' },
    { scope: 'channel:read:goals', description: 'View Creator Goals' },
    { scope: 'channel:read:hype_train', description: 'View Hype Train info' },
    { scope: 'user:read:blocked_users', description: 'View block list' },
    { scope: 'user:manage:blocked_users', description: 'Manage block list' },
    { scope: 'user:read:subscriptions', description: 'View subscriptions' },
    { scope: 'user:read:moderated_channels', description: 'View moderated channels' },
    { scope: 'user:read:whispers', description: 'Receive whispers' },
    { scope: 'user:manage:whispers', description: 'Send whispers' },
    { scope: 'whispers:read', description: 'Receive whispers (PubSub)' },
    { scope: 'moderator:read:suspicious_users', description: 'View suspicious users' },
    { scope: 'moderator:read:unban_requests', description: 'View unban requests' },
    { scope: 'moderator:manage:unban_requests', description: 'Manage unban requests' },
    { scope: 'moderator:read:warnings', description: 'View warnings' },
    { scope: 'moderator:manage:warnings', description: 'Warn users' },
    { scope: 'channel:moderate', description: 'Perform moderation actions' },
    { scope: 'moderator:read:shield_mode', description: 'View Shield Mode' },
    { scope: 'moderator:manage:shield_mode', description: 'Manage Shield Mode' }
  ]
};

const PRESETS = {
    'basic-bot': {
      name: 'Basic Bot',
      description: 'Minimal scopes for chat only',
      scopes: ['chat:read', 'chat:edit']
    },
    'full-moderation': {
      name: 'Full Moderation',
      description: 'All moderation and chat management',
      scopes: [
        'chat:read',
        'chat:edit',
        'moderator:manage:shoutouts',
        'moderator:manage:announcements',
        'moderator:read:followers',
        'channel:moderate'
      ]
    },
    'eventsub-complete': {
      name: 'EventSub Complete',
      description: 'All EventSub-related scopes (follows, subs, bits, redemptions)',
      scopes: [
        'moderator:read:followers',
        'channel:read:redemptions',
        'channel:read:subscriptions',
        'bits:read'
      ]
    },
    'streamer-tools': {
      name: 'Streamer Tools',
      description: 'Polls, predictions, channel points',
      scopes: [
        'channel:manage:polls',
        'channel:manage:predictions',
        'channel:manage:redemptions',
        'channel:read:redemptions'
      ]
    },
    'bot-recommended': {
      name: 'Bot Account (Recommended)',
      description: 'Recommended scopes for bot account based on your features',
      scopes: [
        'chat:read',
        'chat:edit',
        'clips:edit',
        'moderator:manage:shoutouts',
        'channel:manage:polls',
        'channel:manage:predictions',
        'moderator:manage:announcements'
      ]
    },
    'broadcaster-recommended': {
      name: 'Broadcaster Account (Recommended)',
      description: 'Recommended scopes for broadcaster account (EventSub alerts)',
      scopes: [
        'moderator:read:followers',
        'channel:read:redemptions',
        'channel:read:subscriptions',
        'bits:read'
      ]
    }
};

router.get('/categories', (req, res) => res.json(SCOPE_CATEGORIES));
router.get('/presets', (req, res) => res.json(PRESETS));

router.get('/required', (req, res) => {
  const activeFeatures = featureScopes.getActiveFeatures(process.env);
  const botScopes = featureScopes.getRequiredScopes(activeFeatures, 'bot');
  const broadcasterScopes = featureScopes.getRequiredScopes(activeFeatures, 'broadcaster');
  
  res.json({
    featureScopes: featureScopes.FEATURE_SCOPES,
    activeFeatures: activeFeatures.map(f => ({
      id: f,
      name: featureScopes.FEATURE_SCOPES[f]?.name || f,
      description: featureScopes.FEATURE_SCOPES[f]?.description || ''
    })),
    bot: botScopes,
    broadcaster: broadcasterScopes
  });
});

module.exports = router;
