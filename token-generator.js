const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { withCrossProcessLock } = require('./lib/file-lock');
const { asyncHandler, validateRequest, ValidationError } = require('./lib/api-utils');
const { errorHandler } = require('./dashboard/lib/middleware');
require('dotenv').config();

const AccountManager = require('./account-manager');
const accountManager = new AccountManager();

const app = express();
const PORT = 3000;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

// Middleware to parse JSON
app.use(express.json());

// Your Twitch app credentials
const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;

// All available Twitch OAuth scopes grouped by category
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
    { scope: 'moderator:manage:moderators', description: 'Add/remove moderators' },
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

// Flatten all scopes
const ALL_SCOPES = Object.values(SCOPE_CATEGORIES).flatMap(cat => cat.map(s => s.scope));

// Recommended default scopes for this bot
const DEFAULT_SCOPES = [
  'chat:read',
  'chat:edit',
  'clips:edit',
  'channel:read:redemptions',
  'channel:manage:redemptions',
  'channel:manage:polls',
  'channel:manage:predictions',
  'moderator:manage:announcements',
  'channel:moderate'
];

// ==================== API ENDPOINTS ====================

// Token validation endpoint
app.get('/api/validate-token', asyncHandler(async (req, res) => {
  const { token } = req.query;
  
  if (!token) {
    throw new ValidationError('No token provided');
  }

  // Validate token with Twitch
  const tokenInfoResponse = await axios.get('https://id.twitch.tv/oauth2/validate', {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  const tokenInfo = tokenInfoResponse.data;
  
  // Get user info
  const userResponse = await axios.get('https://api.twitch.tv/helix/users', {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Client-ID': CLIENT_ID
    }
  });

  const user = userResponse.data.data[0];

  res.json({
    success: true,
    valid: true,
    username: user.display_name,
    userId: user.id,
    scopes: tokenInfo.scopes || [],
    expiresIn: tokenInfo.expires_in,
    clientId: tokenInfo.client_id
  });
}));

// Get current tokens from .env
app.get('/api/current-tokens', (req, res) => {
  const envPath = path.join(__dirname, '.env');
  let envContent = '';
  
  try {
    envContent = fs.readFileSync(envPath, 'utf-8');
  } catch (error) {
    return res.json({
      botToken: null,
      botScopes: [],
      broadcasterToken: null,
      broadcasterScopes: []
    });
  }

  const lines = envContent.split('\n');
  const tokens = {
    botToken: null,
    botScopes: [],
    broadcasterToken: null,
    broadcasterScopes: []
  };

  lines.forEach(line => {
    if (line.startsWith('TWITCH_ACCESS_TOKEN=')) {
      tokens.botToken = line.split('=')[1]?.trim();
    }
    if (line.startsWith('TWITCH_SCOPES=')) {
      tokens.botScopes = line.split('=')[1]?.trim().split(' ').filter(Boolean);
    }
    if (line.startsWith('TWITCH_BROADCASTER_ACCESS_TOKEN=')) {
      tokens.broadcasterToken = line.split('=')[1]?.trim();
    }
    if (line.startsWith('TWITCH_BROADCASTER_SCOPES=')) {
      tokens.broadcasterScopes = line.split('=')[1]?.trim().split(' ').filter(Boolean);
    }
  });

  res.json(tokens);
});

// Scope presets endpoint
app.get('/api/scope-presets', (req, res) => {
  const presets = {
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

  res.json(presets);
});

// ==================== ACCOUNT MANAGEMENT API ====================

// List all accounts
app.get('/api/accounts', asyncHandler(async (req, res) => {
  const accounts = accountManager.listAccounts();
  res.json({ success: true, accounts });
}));

// Get single account
app.get('/api/accounts/:name', asyncHandler(async (req, res) => {
  const account = accountManager.getAccount(req.params.name);
  if (!account) {
    throw new ValidationError('Account not found', 404);
  }
  // Return account info without clientSecret
  const publicInfo = {
    name: account.name,
    clientId: account.clientId,
    broadcasterName: account.broadcasterName,
    channels: account.channels,
    accessToken: null,
    refreshToken: null,
    tokenScopes: account.tokenScopes,
    broadcasterAccessToken: null,
    broadcasterRefreshToken: null,
    broadcasterScopes: account.broadcasterScopes,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    hasAccessToken: !!account.accessToken,
    hasBroadcasterToken: !!account.broadcasterAccessToken,
    tokenStatus: accountManager.getTokenStatus(account.tokenExpiresAt),
    broadcasterTokenStatus: accountManager.getTokenStatus(account.broadcasterTokenExpiresAt)
  };
  res.json({ success: true, account: publicInfo });
}));

const accountSchema = {
  accountName: { required: true, type: 'string' },
  clientId: { required: true, type: 'string' },
  clientSecret: { required: true, type: 'string' },
  broadcasterName: { required: true, type: 'string' }
};

// Create new account
app.post('/api/accounts', validateRequest(accountSchema), asyncHandler(async (req, res) => {
  const { accountName, clientId, clientSecret, broadcasterName, channels = [] } = req.body;

  const account = accountManager.createAccount(
    accountName,
    clientId,
    clientSecret,
    broadcasterName,
    channels
  );

  res.json({ success: true, message: `Account "${accountName}" created`, account });
}));

// Update account settings
app.patch('/api/accounts/:name', asyncHandler(async (req, res) => {
  const { broadcasterName, channels } = req.body;
  const updates = {};
  if (broadcasterName) updates.broadcasterName = broadcasterName;
  if (channels) updates.channels = channels;

  const account = accountManager.updateAccountSettings(req.params.name, updates);
  const publicInfo = accountManager.listAccounts().find(a => a.name === req.params.name);

  res.json({ success: true, message: 'Account updated', account: publicInfo });
}));

// Rename account
app.post('/api/accounts/:name/rename', validateRequest({ newName: { required: true, type: 'string' } }), asyncHandler(async (req, res) => {
  const { newName } = req.body;
  const account = accountManager.renameAccount(req.params.name, newName);
  const publicInfo = accountManager.listAccounts().find(a => a.name === newName);

  res.json({ success: true, message: `Account renamed to "${newName}"`, account: publicInfo });
}));

// Delete account
app.delete('/api/accounts/:name', asyncHandler(async (req, res) => {
  accountManager.deleteAccount(req.params.name);
  res.json({ success: true, message: `Account "${req.params.name}" deleted` });
}));

// Export account as .env
app.get('/api/accounts/:name/export', (req, res) => {
  try {
    const envContent = accountManager.exportToEnv(req.params.name);
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}.env"`);
    res.send(envContent);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Import account from .env content
app.post('/api/accounts/import', (req, res) => {
  try {
    const { accountName, envContent } = req.body;
    if (!accountName || !envContent) {
      return res.status(400).json({ success: false, error: 'accountName and envContent are required' });
    }
    const account = accountManager.importFromEnv(accountName, envContent);
    
    // Return full account info including scopes
    const publicInfo = {
      name: account.name,
      broadcasterName: account.broadcasterName,
      channels: account.channels,
      hasAccessToken: !!account.accessToken,
      hasBroadcasterToken: !!account.broadcasterAccessToken,
      tokenScopes: account.tokenScopes,
      broadcasterScopes: account.broadcasterScopes,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
      tokenStatus: accountManager.getTokenStatus(account.tokenExpiresAt),
      broadcasterTokenStatus: accountManager.getTokenStatus(account.broadcasterTokenExpiresAt)
    };
    
    res.json({ success: true, message: 'Account imported successfully', account: publicInfo });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ==================== HOME PAGE ====================

app.get('/', (req, res) => {
  res.send(generateHTML());
});

function generateHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Twitch Bot Token Generator</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background: linear-gradient(135deg, #9146ff 0%, #772ce8 100%);
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      background: white;
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      overflow: hidden;
    }
    .header {
      background: linear-gradient(135deg, #9146ff 0%, #772ce8 100%);
      color: white;
      padding: 30px;
      text-align: center;
    }
    .header h1 { margin-bottom: 10px; font-size: 28px; }
    .header p { opacity: 0.9; }
    .tabs {
      display: flex;
      background: #f5f5f5;
      border-bottom: 2px solid #ddd;
    }
    .tab {
      flex: 1;
      padding: 15px;
      text-align: center;
      cursor: pointer;
      background: #f5f5f5;
      border: none;
      font-size: 16px;
      transition: all 0.3s;
      font-weight: 500;
    }
    .tab:hover { background: #e0e0e0; }
    .tab.active {
      background: white;
      border-bottom: 3px solid #9146ff;
      color: #9146ff;
    }
    .tab-content {
      display: none;
      padding: 30px;
      animation: fadeIn 0.3s;
    }
    .tab-content.active { display: block; }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    .section {
      margin-bottom: 30px;
      padding: 20px;
      background: #f9f9f9;
      border-radius: 8px;
      border-left: 4px solid #9146ff;
    }
    .section h3 { margin-bottom: 15px; color: #333; }
    .section p { color: #666; line-height: 1.6; margin-bottom: 15px; }
    .wizard-steps {
      display: flex;
      justify-content: space-between;
      margin-bottom: 30px;
      position: relative;
    }
    .wizard-steps::before {
      content: '';
      position: absolute;
      top: 20px;
      left: 0;
      right: 0;
      height: 2px;
      background: #ddd;
      z-index: 0;
    }
    .wizard-step {
      flex: 1;
      text-align: center;
      position: relative;
      z-index: 1;
    }
    .wizard-step-circle {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: #ddd;
      color: #999;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 10px;
      font-weight: bold;
      transition: all 0.3s;
    }
    .wizard-step.active .wizard-step-circle {
      background: #9146ff;
      color: white;
      transform: scale(1.1);
    }
    .wizard-step.completed .wizard-step-circle {
      background: #4caf50;
      color: white;
    }
    .wizard-step-label { font-size: 14px; color: #666; }
    .wizard-step.active .wizard-step-label { color: #9146ff; font-weight: bold; }
    .wizard-content {
      display: none;
    }
    .wizard-content.active { display: block; }
    .feature-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 15px;
      margin: 20px 0;
    }
    .feature-box {
      padding: 15px;
      background: white;
      border: 2px solid #ddd;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.3s;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .feature-box:hover {
      border-color: #9146ff;
      background: #f3e5ff;
    }
    .feature-box.selected {
      border-color: #9146ff;
      background: #9146ff;
      color: white;
    }
    .feature-box input[type="checkbox"] {
      margin: 0;
      width: 18px;
      height: 18px;
      cursor: pointer;
    }
    .scope-presets {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 15px;
      margin: 20px 0;
    }
    .preset-card {
      padding: 15px;
      background: white;
      border: 2px solid #ddd;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.3s;
    }
    .preset-card:hover {
      border-color: #9146ff;
      box-shadow: 0 4px 12px rgba(145,70,255,0.2);
    }
    .preset-card.active {
      border-color: #9146ff;
      background: #f3e5ff;
    }
    .preset-card h4 { color: #9146ff; margin-bottom: 5px; }
    .preset-card p { font-size: 14px; color: #666; margin-bottom: 10px; }
    .preset-card .scope-count { font-size: 12px; color: #999; }
    .token-status {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
      margin: 20px 0;
    }
    .token-card {
      padding: 20px;
      background: white;
      border-radius: 8px;
      border: 2px solid #ddd;
    }
    .token-card.valid { border-color: #4caf50; background: #f1f8f4; }
    .token-card.invalid { border-color: #f44336; background: #fef1f0; }
    .token-card.loading { border-color: #ff9800; background: #fff8f0; }
    .token-card h4 {
      margin-bottom: 10px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .status-badge {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: bold;
    }
    .status-badge.valid { background: #4caf50; color: white; }
    .status-badge.invalid { background: #f44336; color: white; }
    .status-badge.loading { background: #ff9800; color: white; }
    .token-info {
      font-size: 14px;
      color: #666;
      margin-top: 10px;
    }
    .token-info div {
      margin: 5px 0;
      padding: 5px;
      background: rgba(0,0,0,0.05);
      border-radius: 4px;
    }
    .account-selector {
      margin-bottom: 20px;
      padding: 15px;
      background: #e8f4fd;
      border-radius: 8px;
      border: 2px solid #2196f3;
    }
    .account-selector label {
      display: block;
      font-weight: bold;
      margin-bottom: 10px;
      color: #1976d2;
    }
    .account-selector select {
      width: 100%;
      padding: 10px;
      font-size: 16px;
      border: 2px solid #2196f3;
      border-radius: 5px;
    }
    .btn {
      padding: 12px 30px;
      font-size: 16px;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.3s;
      font-weight: bold;
    }
    .btn-primary {
      background: #9146ff;
      color: white;
    }
    .btn-primary:hover {
      background: #772ce8;
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(145,70,255,0.3);
    }
    .btn-secondary {
      background: #666;
      color: white;
    }
    .btn-secondary:hover { background: #555; }
    .btn-success {
      background: #4caf50;
      color: white;
    }
    .btn-success:hover { background: #45a049; }
    .btn-group {
      display: flex;
      gap: 10px;
      margin-top: 20px;
      justify-content: center;
    }
    .scope-category {
      margin-bottom: 15px;
      border: 1px solid #ddd;
      border-radius: 8px;
      overflow: hidden;
    }
    .scope-category-header {
      background: #9146ff;
      color: white;
      padding: 12px 15px;
      font-weight: bold;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
      transition: all 0.3s;
    }
    .scope-category-header:hover { background: #772ce8; }
    .scope-category-content {
      padding: 15px;
      background: white;
    }
    .scope-category-content.collapsed { display: none; }
    .scope-item {
      padding: 10px;
      margin: 5px 0;
      background: #f9f9f9;
      border-radius: 4px;
      display: flex;
      align-items: flex-start;
      gap: 10px;
    }
    .scope-item input[type="checkbox"] {
      margin-top: 4px;
      width: 18px;
      height: 18px;
      cursor: pointer;
      flex-shrink: 0;
    }
    .scope-item label {
      cursor: pointer;
      flex: 1;
    }
    .scope-item strong {
      color: #9146ff;
      font-family: 'Courier New', monospace;
      font-size: 13px;
    }
    .selected-count {
      display: inline-block;
      background: #4caf50;
      color: white;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 13px;
    }
    .auth-buttons {
      display: flex;
      flex-direction: column;
      gap: 15px;
      margin: 20px 0;
    }
    .auth-button {
      padding: 15px;
      background: white;
      border: 2px solid #ddd;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      text-decoration: none;
      color: inherit;
      transition: all 0.3s;
    }
    .auth-button:hover {
      border-color: #9146ff;
      box-shadow: 0 4px 12px rgba(145,70,255,0.2);
    }
    .auth-button-text h4 {
      margin-bottom: 5px;
      color: #333;
    }
    .auth-button-text p {
      font-size: 13px;
      color: #666;
    }
    .auth-button-arrow {
      font-size: 24px;
      color: #9146ff;
    }
    input[type="text"], input[type="password"], select {
      padding: 10px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 14px;
    }
    .form-group {
      margin-bottom: 15px;
    }
    .form-group label {
      display: block;
      margin-bottom: 5px;
      font-weight: bold;
      color: #333;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🎮 Twitch Bot Token Generator</h1>
      <p>Advanced token management with dual-account support and scope validation</p>
    </div>

    <div class="tabs">
      <button class="tab active" onclick="switchTab(event, 'wizard')">🧙 Setup Wizard</button>
      <button class="tab" onclick="switchTab(event, 'manual')">⚙️ Manual Setup</button>
      <button class="tab" onclick="switchTab(event, 'validate')">✅ Token Validator</button>
      <button class="tab" onclick="switchTab(event, 'accounts')">👤 Account Manager</button>
    </div>

    <!-- WIZARD TAB -->
    <div id="wizard-tab" class="tab-content active">
      <div class="wizard-steps">
        <div class="wizard-step active" id="step1">
          <div class="wizard-step-circle">1</div>
          <div class="wizard-step-label">Choose Features</div>
        </div>
        <div class="wizard-step" id="step2">
          <div class="wizard-step-circle">2</div>
          <div class="wizard-step-label">Review Scopes</div>
        </div>
        <div class="wizard-step" id="step3">
          <div class="wizard-step-circle">3</div>
          <div class="wizard-step-label">Authorize</div>
        </div>
      </div>

      <!-- Step 1: Features -->
      <div class="wizard-content active" id="wizard-step-1">
        <div class="section">
          <h3>Which features does your bot need?</h3>
          <p>Select the features and we'll automatically configure the required scopes.</p>
          <div class="feature-grid">
            <div class="feature-box selected" onclick="toggleFeature('chat', this)">
              <input type="checkbox" id="feat-chat" checked disabled>
              <label for="feat-chat">💬 Chat</label>
            </div>
            <div class="feature-box selected" onclick="toggleFeature('clips', this)">
              <input type="checkbox" id="feat-clips" checked>
              <label for="feat-clips">🎬 Clips</label>
            </div>
            <div class="feature-box selected" onclick="toggleFeature('shoutouts', this)">
              <input type="checkbox" id="feat-shoutouts" checked>
              <label for="feat-shoutouts">📢 Shoutouts</label>
            </div>
            <div class="feature-box selected" onclick="toggleFeature('followage', this)">
              <input type="checkbox" id="feat-followage" checked>
              <label for="feat-followage">👥 Followage</label>
            </div>
            <div class="feature-box selected" onclick="toggleFeature('polls', this)">
              <input type="checkbox" id="feat-polls" checked>
              <label for="feat-polls">📊 Polls</label>
            </div>
            <div class="feature-box selected" onclick="toggleFeature('predictions', this)">
              <input type="checkbox" id="feat-predictions" checked>
              <label for="feat-predictions">🎲 Predictions</label>
            </div>
            <div class="feature-box selected" onclick="toggleFeature('announcements', this)">
              <input type="checkbox" id="feat-announcements" checked>
              <label for="feat-announcements">📣 Announcements</label>
            </div>
            <div class="feature-box selected" onclick="toggleFeature('eventsub', this)">
              <input type="checkbox" id="feat-eventsub" checked>
              <label for="feat-eventsub">🔔 EventSub</label>
            </div>
            <div class="feature-box selected" onclick="toggleFeature('redemptions', this)">
              <input type="checkbox" id="feat-redemptions" checked>
              <label for="feat-redemptions">⭐ Channel Points</label>
            </div>
            <!-- Moderation -->
            <div class="feature-box" onclick="toggleFeature('ban_timeout', this)">
              <input type="checkbox" id="feat-ban_timeout">
              <label for="feat-ban_timeout">🚫 Ban/Timeout Users</label>
            </div>
            <div class="feature-box" onclick="toggleFeature('delete_messages', this)">
              <input type="checkbox" id="feat-delete_messages">
              <label for="feat-delete_messages">🗑️ Delete Messages</label>
            </div>
            <div class="feature-box" onclick="toggleFeature('automod', this)">
              <input type="checkbox" id="feat-automod">
              <label for="feat-automod">⚙️ AutoMod Control</label>
            </div>
            <div class="feature-box" onclick="toggleFeature('shield_mode', this)">
              <input type="checkbox" id="feat-shield_mode">
              <label for="feat-shield_mode">🛡️ Shield Mode</label>
            </div>
            <div class="feature-box" onclick="toggleFeature('warnings', this)">
              <input type="checkbox" id="feat-warnings">
              <label for="feat-warnings">⚠️ User Warnings</label>
            </div>
            <!-- VIP/Moderator Management -->
            <div class="feature-box" onclick="toggleFeature('vip_management', this)">
              <input type="checkbox" id="feat-vip_management">
              <label for="feat-vip_management">👑 VIP Management</label>
            </div>
            <div class="feature-box" onclick="toggleFeature('moderator_management', this)">
              <input type="checkbox" id="feat-moderator_management">
              <label for="feat-moderator_management">🔧 Moderator Mgmt</label>
            </div>
            <!-- Channel Management -->
            <div class="feature-box" onclick="toggleFeature('channel_updates', this)">
              <input type="checkbox" id="feat-channel_updates">
              <label for="feat-channel_updates">📝 Update Title/Game</label>
            </div>
            <div class="feature-box" onclick="toggleFeature('schedule_management', this)">
              <input type="checkbox" id="feat-schedule_management">
              <label for="feat-schedule_management">📅 Stream Schedule</label>
            </div>
            <div class="feature-box" onclick="toggleFeature('ads_management', this)">
              <input type="checkbox" id="feat-ads_management">
              <label for="feat-ads_management">📺 Ads Management</label>
            </div>
            <!-- Analytics & Info -->
            <div class="feature-box" onclick="toggleFeature('hype_trains', this)">
              <input type="checkbox" id="feat-hype_trains">
              <label for="feat-hype_trains">🚂 Hype Trains</label>
            </div>
            <div class="feature-box" onclick="toggleFeature('bits', this)">
              <input type="checkbox" id="feat-bits">
              <label for="feat-bits">💎 Bits Info</label>
            </div>
            <div class="feature-box" onclick="toggleFeature('subscriptions', this)">
              <input type="checkbox" id="feat-subscriptions">
              <label for="feat-subscriptions">📬 Subscriptions</label>
            </div>
            <div class="feature-box" onclick="toggleFeature('follows_read', this)">
              <input type="checkbox" id="feat-follows_read">
              <label for="feat-follows_read">👀 Read Followers</label>
            </div>
            <!-- Advanced Features -->
            <div class="feature-box" onclick="toggleFeature('guest_star', this)">
              <input type="checkbox" id="feat-guest_star">
              <label for="feat-guest_star">⭐ Guest Star</label>
            </div>
            <div class="feature-box" onclick="toggleFeature('unban_requests', this)">
              <input type="checkbox" id="feat-unban_requests">
              <label for="feat-unban_requests">✋ Unban Requests</label>
            </div>
            <div class="feature-box" onclick="toggleFeature('whispers', this)">
              <input type="checkbox" id="feat-whispers">
              <label for="feat-whispers">💬 Whispers</label>
            </div>
            <div class="feature-box" onclick="toggleFeature('user_email', this)">
              <input type="checkbox" id="feat-user_email">
              <label for="feat-user_email">📧 User Email</label>
            </div>
            <div class="feature-box" onclick="toggleFeature('extensions', this)">
              <input type="checkbox" id="feat-extensions">
              <label for="feat-extensions">🧩 Extensions</label>
            </div>
            <div class="feature-box" onclick="toggleFeature('analytics', this)">
              <input type="checkbox" id="feat-analytics">
              <label for="feat-analytics">📊 Analytics</label>
            </div>
            <div class="feature-box" onclick="toggleFeature('charity', this)">
              <input type="checkbox" id="feat-charity">
              <label for="feat-charity">❤️ Charity</label>
            </div>
            <div class="feature-box" onclick="toggleFeature('goals', this)">
              <input type="checkbox" id="feat-goals">
              <label for="feat-goals">🏅 Creator Goals</label>
            </div>
          </div>
        </div>
        <div class="btn-group">
          <button class="btn btn-primary" onclick="wizardNext(1)">Next: Review Scopes →</button>
        </div>
      </div>

      <!-- Step 2: Review Scopes -->
      <div class="wizard-content" id="wizard-step-2">
        <div class="section">
          <h3>Review Required Scopes</h3>
          <p>Based on your selected features, here are the required scopes:</p>
          <div id="wizard-scope-summary" style="margin-top: 20px;"></div>
        </div>
        <div class="btn-group">
          <button class="btn btn-secondary" onclick="wizardPrev(2)">← Back</button>
          <button class="btn btn-primary" onclick="wizardNext(2)">Next: Authorize →</button>
        </div>
      </div>

      <!-- Step 3: Authorize -->
      <div class="wizard-content" id="wizard-step-3">
        <div class="section">
          <h3>Authorize Your Accounts</h3>
          <p>Click the buttons below to authorize each account. You'll need to log in as the respective account:</p>
          <div class="auth-buttons" id="wizard-auth-buttons"></div>
        </div>
        <div class="btn-group">
          <button class="btn btn-secondary" onclick="wizardPrev(3)">← Back</button>
          <button class="btn btn-success" onclick="wizardComplete()">Complete Setup ✓</button>
        </div>
      </div>
    </div>

    <!-- MANUAL TAB -->
    <div id="manual-tab" class="tab-content">
      <div class="section">
        <h3>Quick Presets</h3>
        <p>Select a preset to quickly configure common scope combinations:</p>
        <div class="scope-presets" id="scope-presets"></div>
      </div>

      <div class="account-selector">
        <label>Which account are you setting up?</label>
        <select id="accountType" onchange="updateAccountContext()">
          <option value="bot">🤖 Bot Account (mistressexcella) - Chat commands & actions</option>
          <option value="broadcaster">📺 Broadcaster Account (ronin_style) - EventSub subscriptions</option>
        </select>
        <p id="account-context" style="margin-top: 10px; font-size: 14px;"></p>
      </div>

      <div class="section">
        <h3>Select Scopes</h3>
        <p>Choose which permissions your bot needs. <span class="selected-count" id="scope-counter">0 selected</span></p>
        <div style="margin-top: 20px; display: flex; gap: 10px;">
          <button class="btn btn-primary" onclick="selectAll()">✓ Select All</button>
          <button class="btn btn-secondary" onclick="clearAll()">✗ Clear All</button>
        </div>
        <div id="scope-categories" style="margin-top: 20px;"></div>
      </div>

      <div style="text-align: center; margin-top: 30px;">
        <button class="btn btn-primary" onclick="generateTokens()" style="font-size: 18px; padding: 15px 40px;">
          Generate Tokens 🚀
        </button>
      </div>
    </div>

    <!-- VALIDATOR TAB -->
    <div id="validate-tab" class="tab-content">
      <div class="section">
        <h3>Token Status</h3>
        <p>Check the status and validity of your current tokens:</p>
        <button class="btn btn-primary" onclick="validateTokens()" style="margin: 20px 0;">
          🔍 Check Token Status
        </button>
        <div class="token-status" id="token-validation">
          <div class="token-card loading">
            <h4>Bot Account <span class="status-badge loading">checking...</span></h4>
            <p>Click "Check Token Status" to validate</p>
          </div>
          <div class="token-card loading">
            <h4>Broadcaster Account <span class="status-badge loading">checking...</span></h4>
            <p>Click "Check Token Status" to validate</p>
          </div>
        </div>
      </div>

      <div class="section">
        <h3>Scope Comparison</h3>
        <p>Compare your current scopes against requirements:</p>
        <div id="scope-comparison" style="margin-top: 20px;">
          <p style="color: #999;">Run token validation above to see details</p>
        </div>
      </div>
    </div>

    <!-- Account Manager Tab -->
    <div id="accounts-tab" class="tab-content">
      <div class="section">
        <h3>📋 My Accounts</h3>
        <p>View and manage your saved Twitch bot accounts</p>
        
        <button class="btn btn-primary" onclick="loadAccounts()" style="margin-bottom: 20px;">
          🔄 Refresh Accounts
        </button>

        <div id="accounts-list">
          <p style="color: #999; text-align: center; padding: 20px;">Loading accounts...</p>
        </div>
      </div>

      <div class="section">
        <h3>➕ Create New Account</h3>
        <p>Register a Twitch application with bot and broadcaster tokens</p>
        
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
          <div>
            <label>Account Name</label>
            <input type="text" id="new-account-name" placeholder="e.g., mybot" style="width: 100%; padding: 10px; border: 2px solid #ddd; border-radius: 5px;">
          </div>
          <div>
            <label>Broadcaster Name</label>
            <input type="text" id="new-broadcaster-name" placeholder="e.g., ronin_style" style="width: 100%; padding: 10px; border: 2px solid #ddd; border-radius: 5px;">
          </div>
          <div>
            <label>Client ID</label>
            <input type="text" id="new-client-id" placeholder="From Twitch Console" style="width: 100%; padding: 10px; border: 2px solid #ddd; border-radius: 5px;">
          </div>
          <div>
            <label>Client Secret</label>
            <input type="password" id="new-client-secret" placeholder="From Twitch Console" style="width: 100%; padding: 10px; border: 2px solid #ddd; border-radius: 5px;">
          </div>
          <div style="grid-column: 1 / -1;">
            <label>Channels (comma-separated)</label>
            <input type="text" id="new-channels" placeholder="e.g., ronin_style,other_channel" style="width: 100%; padding: 10px; border: 2px solid #ddd; border-radius: 5px;">
          </div>
        </div>

        <button class="btn btn-primary" onclick="createNewAccount()" style="margin-top: 15px; width: 100%;">
          ✓ Create Account
        </button>
      </div>

      <div class="section">
        <h3>� Import from .env File</h3>
        <p>Convert your existing .env credentials to Account Manager</p>
        
        <div style="margin-bottom: 15px;">
          <label style="display: block; margin-bottom: 10px; font-weight: bold;">Account Name:</label>
          <input type="text" id="import-account-name" placeholder="e.g., my_bot" style="width: 100%; padding: 10px; border: 2px solid #ddd; border-radius: 5px;">
        </div>

        <div style="margin-bottom: 15px;">
          <label style="display: block; margin-bottom: 10px; font-weight: bold;">Required .env Keys:</label>
          <div style="background: #e3f2fd; border-left: 4px solid #2196f3; padding: 12px; border-radius: 4px; font-size: 12px; margin-bottom: 15px; font-family: monospace;">
            <div style="margin-bottom: 8px;"><strong>Bot Credentials:</strong></div>
            <div>✓ TWITCH_CLIENT_ID</div>
            <div>✓ TWITCH_CLIENT_SECRET</div>
            <div>✓ TWITCH_ACCESS_TOKEN</div>
            <div>✓ TWITCH_REFRESH_TOKEN</div>
            <div style="margin-top: 8px; margin-bottom: 8px;"><strong>Broadcaster Credentials:</strong></div>
            <div>✓ TWITCH_BROADCASTER_ACCESS_TOKEN</div>
            <div>✓ TWITCH_BROADCASTER_REFRESH_TOKEN</div>
            <div style="margin-top: 8px;"><strong>Settings:</strong></div>
            <div>✓ TWITCH_BROADCASTER_NAME</div>
            <div>✓ TWITCH_CHANNELS</div>
          </div>
        </div>

        <div style="margin-bottom: 15px;">
          <label style="display: block; margin-bottom: 10px; font-weight: bold;">Paste entire .env file:</label>
          <textarea id="import-env-content" placeholder="TWITCH_CLIENT_ID=abc123...&#10;TWITCH_CLIENT_SECRET=def456...&#10;TWITCH_ACCESS_TOKEN=xyz789...&#10;TWITCH_REFRESH_TOKEN=...&#10;TWITCH_BROADCASTER_ACCESS_TOKEN=...&#10;TWITCH_BROADCASTER_REFRESH_TOKEN=...&#10;TWITCH_BROADCASTER_NAME=ronin_style&#10;TWITCH_CHANNELS=ronin_style" style="width: 100%; height: 200px; padding: 10px; border: 2px solid #ddd; border-radius: 5px; font-family: monospace; font-size: 12px;"></textarea>
        </div>

        <button class="btn btn-primary" onclick="importFromEnv()" style="width: 100%;">
          ✓ Import Account
        </button>

        <div id="import-result" style="margin-top: 15px;"></div>
      </div>

      <div class="section">
        <h3>�🔐 Authorize Account</h3>
        <p>Authorize your bot and broadcaster account with Twitch OAuth</p>
        
        <div style="margin-bottom: 20px;">
          <label style="display: block; margin-bottom: 10px; font-weight: bold;">Select Account:</label>
          <select id="auth-account-select" onchange="updateAuthButtons()" style="width: 100%; padding: 10px; font-size: 16px; border: 2px solid #2196f3; border-radius: 5px;">
            <option value="">-- Choose an account --</option>
          </select>
        </div>

        <div id="auth-account-info" style="display: none; margin-bottom: 20px; padding: 15px; background: #f0f0f0; border-radius: 8px;">
          <div id="auth-info-content"></div>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
          <button class="btn btn-primary" id="auth-bot-btn" onclick="authorizeAccount('bot')" style="display: none;">
            🤖 Authorize Bot
          </button>
          <button class="btn btn-primary" id="auth-broadcaster-btn" onclick="authorizeAccount('broadcaster')" style="display: none; background: #2196f3;">
            📺 Authorize Broadcaster
          </button>
        </div>

        <p style="font-size: 12px; color: #666; margin-top: 15px;">
          💡 Both accounts use the same Client ID/Secret from your Twitch application. Authorize both to enable all bot features.
        </p>
      </div>

      <div class="section">
        <h3>⚙️ Account Actions</h3>
        
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 20px;">
          <div>
            <label>Select Account:</label>
            <select id="action-account-select" onchange="updateAccountActions()" style="width: 100%; padding: 10px; border: 2px solid #ddd; border-radius: 5px;">
              <option value="">-- Choose an account --</option>
            </select>
          </div>
          <div style="display: flex; align-items: flex-end; gap: 10px;">
            <button class="btn btn-secondary" id="rename-btn" onclick="renameAccount()" style="flex: 1; display: none;">
              ✏️ Rename
            </button>
            <button class="btn btn-secondary" id="export-btn" onclick="exportAccount()" style="flex: 1; display: none;">
              📥 Export
            </button>
            <button class="btn btn-secondary" id="delete-btn" onclick="deleteAccount()" style="flex: 1; display: none; background: #f44336;">
              🗑️ Delete
            </button>
          </div>
        </div>

        <div id="action-result"></div>
      </div>
    </div>
  </div>

  <script>
    const CLIENT_ID = '${CLIENT_ID}';
    const REDIRECT_URI = '${REDIRECT_URI}';
    let currentWizardStep = 1;
    let selectedFeatures = {
      // Core
      chat: true,
      // Content
      clips: true, announcements: true, whispers: false,
      // Engagement
      shoutouts: true, followage: true, polls: true, predictions: true,
      eventsub: true, redemptions: true,
      // Moderation
      ban_timeout: false, delete_messages: false, automod: false, shield_mode: false, warnings: false,
      // VIP/Moderator Management
      vip_management: false, moderator_management: false,
      // Channel Management
      channel_updates: false, schedule_management: false, ads_management: false,
      // User Analytics
      hype_trains: false, bits: false, subscriptions: false, follows_read: false,
      // Advanced
      user_email: false, extensions: false, analytics: false, charity: false, goals: false,
      // Guest Star
      guest_star: false,
      // Unban/Warnings
      unban_requests: false
    };

    // Load current scopes from .env and pre-select them
    async function loadCurrentScopes() {
      try {
        const response = await fetch('/api/current-tokens');
        const tokens = await response.json();
        
        // Clear all checkboxes first
        document.querySelectorAll('input[type="checkbox"][id^="scope-"]').forEach(cb => cb.checked = false);
        
        // Get scopes based on current account type
        const accountType = document.getElementById('accountType').value;
        const scopes = accountType === 'bot' ? tokens.botScopes : tokens.broadcasterScopes;
        
        // Pre-select checkboxes for current scopes
        if (scopes && Array.isArray(scopes)) {
          scopes.forEach(scope => {
            const checkboxId = 'scope-' + scope.replace(/:/g, '-');
            const checkbox = document.getElementById(checkboxId);
            if (checkbox) {
              checkbox.checked = true;
            }
          });
        }
        
        updateScopeCounter();
      } catch (error) {
        console.error('Failed to load current scopes:', error);
      }
    }

    // Load presets and scope categories
    async function initPage() {
      await loadPresets();
      await loadScopeCategories();
      updateAccountContext();
      // Load and pre-select current scopes from .env
      setTimeout(loadCurrentScopes, 100); // Wait for checkboxes to be created
    }

    async function loadPresets() {
      try {
        const response = await fetch('/api/scope-presets');
        const presets = await response.json();
        const container = document.getElementById('scope-presets');
        container.innerHTML = Object.entries(presets).map(([key, preset]) => \`
          <div class="preset-card" onclick="applyPreset('\${key}')">
            <h4>\${preset.name}</h4>
            <p>\${preset.description}</p>
            <div class="scope-count">\${preset.scopes.length} scopes</div>
          </div>
        \`).join('');
      } catch (error) {
        console.error('Failed to load presets:', error);
      }
    }

    async function loadScopeCategories() {
      const container = document.getElementById('scope-categories');
      const categories = ${JSON.stringify(SCOPE_CATEGORIES)};
      
      container.innerHTML = Object.entries(categories).map(([category, scopes]) => \`
        <div class="scope-category">
          <div class="scope-category-header" onclick="toggleCategory(this)">
            \${category}
            <span class="selected-count" id="\${category.replace(/\\s+/g, '-')}-count">0</span>
          </div>
          <div class="scope-category-content">
            \${scopes.map(s => \`
              <div class="scope-item">
                <input type="checkbox" id="scope-\${s.scope.replace(/:/g, '-')}" class="scope-checkbox" onchange="updateScopeCounter()">
                <label for="scope-\${s.scope.replace(/:/g, '-')}">
                  <strong>\${s.scope}</strong><br>
                  <span style="font-size: 12px; color: #999;">\${s.description}</span>
                </label>
              </div>
            \`).join('')}
          </div>
        </div>
      \`).join('');
    }

    function switchTab(e, tabName) {
      document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
      
      e.target.classList.add('active');
      document.getElementById(tabName + '-tab').classList.add('active');
    }

    function toggleFeature(feature, element) {
      const checkbox = document.getElementById('feat-' + feature);
      if (feature === 'chat') return; // Chat is always required
      
      checkbox.checked = !checkbox.checked;
      selectedFeatures[feature] = checkbox.checked;
      element.classList.toggle('selected', checkbox.checked);
    }

    function toggleCategory(header) {
      const content = header.nextElementSibling;
      content.classList.toggle('collapsed');
    }

    function wizardNext(step) {
      document.getElementById('wizard-step-' + step).classList.remove('active');
      document.getElementById('step' + step).classList.add('completed');
      document.getElementById('step' + step).classList.remove('active');
      
      currentWizardStep = step + 1;
      
      document.getElementById('wizard-step-' + currentWizardStep).classList.add('active');
      document.getElementById('step' + currentWizardStep).classList.add('active');
      
      if (currentWizardStep === 2) updateWizardScopeSummary();
      if (currentWizardStep === 3) updateWizardAuthButtons();
    }

    function wizardPrev(step) {
      document.getElementById('wizard-step-' + step).classList.remove('active');
      document.getElementById('step' + step).classList.remove('active', 'completed');
      
      currentWizardStep = step - 1;
      
      document.getElementById('wizard-step-' + currentWizardStep).classList.add('active');
      document.getElementById('step' + currentWizardStep).classList.add('active');
    }

    function updateWizardScopeSummary() {
      const botScopes = [];
      const broadcasterScopes = [];
      
      // Core - always included
      if (selectedFeatures.chat) { botScopes.push('chat:read', 'chat:edit'); }
      
      // Content
      if (selectedFeatures.clips) { botScopes.push('clips:edit'); }
      if (selectedFeatures.announcements) { botScopes.push('moderator:manage:announcements'); }
      if (selectedFeatures.whispers) { botScopes.push('user:manage:whispers', 'whispers:read', 'whispers:edit'); }
      
      // Engagement
      if (selectedFeatures.shoutouts) { botScopes.push('moderator:manage:shoutouts'); }
      if (selectedFeatures.followage) { botScopes.push('moderator:read:followers'); }
      if (selectedFeatures.polls) { botScopes.push('channel:manage:polls'); }
      if (selectedFeatures.predictions) { botScopes.push('channel:manage:predictions'); }
      if (selectedFeatures.redemptions) { broadcasterScopes.push('channel:read:redemptions'); }
      
      // Moderation
      if (selectedFeatures.ban_timeout) { botScopes.push('moderator:manage:banned_users'); }
      if (selectedFeatures.delete_messages) { botScopes.push('moderator:manage:chat_messages'); }
      if (selectedFeatures.automod) { botScopes.push('moderator:manage:automod', 'moderator:manage:automod_settings'); }
      if (selectedFeatures.shield_mode) { botScopes.push('moderator:manage:shield_mode'); }
      if (selectedFeatures.warnings) { botScopes.push('moderator:manage:warnings'); }
      if (selectedFeatures.unban_requests) { botScopes.push('moderator:manage:unban_requests'); }
      
      // VIP/Moderator Management
      if (selectedFeatures.vip_management) { botScopes.push('channel:manage:vips'); }
      if (selectedFeatures.moderator_management) { botScopes.push('moderation:read', 'moderator:manage:moderators'); }
      
      // Channel Management
      if (selectedFeatures.channel_updates) { botScopes.push('channel:manage:broadcast'); }
      if (selectedFeatures.schedule_management) { botScopes.push('channel:manage:schedule'); }
      if (selectedFeatures.ads_management) { botScopes.push('channel:manage:ads'); }
      if (selectedFeatures.guest_star) { botScopes.push('channel:manage:guest_star'); }
      
      // User/Account
      if (selectedFeatures.user_email) { botScopes.push('user:read:email'); }
      if (selectedFeatures.extensions) { botScopes.push('channel:manage:extensions'); }
      
      // Analytics & Info - Broadcaster
      if (selectedFeatures.hype_trains) { broadcasterScopes.push('channel:read:hype_train'); }
      if (selectedFeatures.bits) { broadcasterScopes.push('bits:read'); }
      if (selectedFeatures.subscriptions) { broadcasterScopes.push('channel:read:subscriptions'); }
      if (selectedFeatures.follows_read) { broadcasterScopes.push('user:read:follows'); }
      if (selectedFeatures.analytics) { broadcasterScopes.push('analytics:read:games'); }
      if (selectedFeatures.charity) { broadcasterScopes.push('channel:read:charity'); }
      if (selectedFeatures.goals) { broadcasterScopes.push('channel:read:goals'); }
      
      // EventSub requires broadcaster context (follows, subs, bits, redemptions for alerts)
      if (selectedFeatures.eventsub) {
        broadcasterScopes.push('moderator:read:followers');
        // Add subscription and bits scopes for OBS overlay alerts
        if (!broadcasterScopes.includes('channel:read:subscriptions')) broadcasterScopes.push('channel:read:subscriptions');
        if (!broadcasterScopes.includes('bits:read')) broadcasterScopes.push('bits:read');
        if (!broadcasterScopes.includes('channel:read:redemptions')) broadcasterScopes.push('channel:read:redemptions');
      }

      const html = \`
        <div style="display: grid; grid-template-columns: 1fr \${broadcasterScopes.length > 0 ? '1fr' : ''}; gap: 20px;">
          <div>
            <h4>Bot Account (\${botScopes.length} scopes)</h4>
            <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px;">
              \${botScopes.map(s => \`<span style="background: #9146ff; color: white; padding: 6px 12px; border-radius: 4px; font-size: 13px;">\${s}</span>\`).join('')}
            </div>
          </div>
          \${broadcasterScopes.length > 0 ? \`
            <div>
              <h4>Broadcaster Account (\${broadcasterScopes.length} scopes)</h4>
              <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px;">
                \${broadcasterScopes.map(s => \`<span style="background: #2196f3; color: white; padding: 6px 12px; border-radius: 4px; font-size: 13px;">\${s}</span>\`).join('')}
              </div>
            </div>
          \` : ''}
        </div>
      \`;
      document.getElementById('wizard-scope-summary').innerHTML = html;
    }

    function updateWizardAuthButtons() {
      const botScopes = [];
      const broadcasterScopes = [];
      
      // Core - always included
      if (selectedFeatures.chat) { botScopes.push('chat:read', 'chat:edit'); }
      
      // Content
      if (selectedFeatures.clips) { botScopes.push('clips:edit'); }
      if (selectedFeatures.announcements) { botScopes.push('moderator:manage:announcements'); }
      if (selectedFeatures.whispers) { botScopes.push('user:manage:whispers', 'whispers:read', 'whispers:edit'); }
      
      // Engagement
      if (selectedFeatures.shoutouts) { botScopes.push('moderator:manage:shoutouts'); }
      if (selectedFeatures.followage) { botScopes.push('moderator:read:followers'); }
      if (selectedFeatures.polls) { botScopes.push('channel:manage:polls'); }
      if (selectedFeatures.predictions) { botScopes.push('channel:manage:predictions'); }
      if (selectedFeatures.redemptions) { broadcasterScopes.push('channel:read:redemptions'); }
      
      // Moderation
      if (selectedFeatures.ban_timeout) { botScopes.push('moderator:manage:banned_users'); }
      if (selectedFeatures.delete_messages) { botScopes.push('moderator:manage:chat_messages'); }
      if (selectedFeatures.automod) { botScopes.push('moderator:manage:automod', 'moderator:manage:automod_settings'); }
      if (selectedFeatures.shield_mode) { botScopes.push('moderator:manage:shield_mode'); }
      if (selectedFeatures.warnings) { botScopes.push('moderator:manage:warnings'); }
      if (selectedFeatures.unban_requests) { botScopes.push('moderator:manage:unban_requests'); }
      
      // VIP/Moderator Management
      if (selectedFeatures.vip_management) { botScopes.push('channel:manage:vips'); }
      if (selectedFeatures.moderator_management) { botScopes.push('moderation:read', 'moderator:manage:moderators'); }
      
      // Channel Management
      if (selectedFeatures.channel_updates) { botScopes.push('channel:manage:broadcast'); }
      if (selectedFeatures.schedule_management) { botScopes.push('channel:manage:schedule'); }
      if (selectedFeatures.ads_management) { botScopes.push('channel:manage:ads'); }
      if (selectedFeatures.guest_star) { botScopes.push('channel:manage:guest_star'); }
      
      // User/Account
      if (selectedFeatures.user_email) { botScopes.push('user:read:email'); }
      if (selectedFeatures.extensions) { botScopes.push('channel:manage:extensions'); }
      
      // Analytics & Info - Broadcaster
      if (selectedFeatures.hype_trains) { broadcasterScopes.push('channel:read:hype_train'); }
      if (selectedFeatures.bits) { broadcasterScopes.push('bits:read'); }
      if (selectedFeatures.subscriptions) { broadcasterScopes.push('channel:read:subscriptions'); }
      if (selectedFeatures.follows_read) { broadcasterScopes.push('user:read:follows'); }
      if (selectedFeatures.analytics) { broadcasterScopes.push('analytics:read:games'); }
      if (selectedFeatures.charity) { broadcasterScopes.push('channel:read:charity'); }
      if (selectedFeatures.goals) { broadcasterScopes.push('channel:read:goals'); }
      
      // EventSub requires broadcaster context (follows, subs, bits, redemptions for alerts)
      if (selectedFeatures.eventsub) {
        broadcasterScopes.push('moderator:read:followers');
        // Add subscription and bits scopes for OBS overlay alerts
        if (!broadcasterScopes.includes('channel:read:subscriptions')) broadcasterScopes.push('channel:read:subscriptions');
        if (!broadcasterScopes.includes('bits:read')) broadcasterScopes.push('bits:read');
        if (!broadcasterScopes.includes('channel:read:redemptions')) broadcasterScopes.push('channel:read:redemptions');
      }

      const botAuthUrl = \`https://id.twitch.tv/oauth2/authorize?client_id=\${CLIENT_ID}&redirect_uri=\${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=\${botScopes.join('+')}&state=bot\`;
      const broadcasterAuthUrl = broadcasterScopes.length > 0 ? 
        \`https://id.twitch.tv/oauth2/authorize?client_id=\${CLIENT_ID}&redirect_uri=\${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=\${broadcasterScopes.join('+')}&state=broadcaster\` : null;
      
      let html = \`
        <a href="\${botAuthUrl}" class="auth-button">
          <div class="auth-button-text">
            <h4>🤖 Bot Account</h4>
            <p>Log in as mistressexcella</p>
          </div>
          <div class="auth-button-arrow">→</div>
        </a>
      \`;
      
      if (broadcasterAuthUrl) {
        html += \`
          <a href="\${broadcasterAuthUrl}" class="auth-button">
            <div class="auth-button-text">
              <h4>📺 Broadcaster Account</h4>
              <p>Log in as ronin_style</p>
            </div>
            <div class="auth-button-arrow">→</div>
          </a>
        \`;
      }
      
      document.getElementById('wizard-auth-buttons').innerHTML = html;
    }

    function wizardComplete() {
      alert('Setup complete! Your tokens have been saved. Restart the bot to apply changes.');
      switchTab({ target: document.querySelectorAll('.tab')[2] }, 'validate');
      validateTokens();
    }

    async function applyPreset(presetKey) {
      try {
        const response = await fetch('/api/scope-presets');
        const presets = await response.json();
        const preset = presets[presetKey];
        
        document.querySelectorAll('input[type="checkbox"][id^="scope-"]').forEach(cb => cb.checked = false);
        
        preset.scopes.forEach(scope => {
          const checkbox = document.getElementById('scope-' + scope.replace(/:/g, '-'));
          if (checkbox) checkbox.checked = true;
        });
        
        updateScopeCounter();
        
        document.querySelectorAll('.preset-card').forEach(card => card.classList.remove('active'));
        event.target.closest('.preset-card').classList.add('active');
      } catch (error) {
        console.error('Failed to apply preset:', error);
      }
    }

    function updateAccountContext() {
      const accountType = document.getElementById('accountType').value;
      const contextEl = document.getElementById('account-context');
      
      if (accountType === 'bot') {
        contextEl.innerHTML = '🤖 <strong>Bot Account:</strong> Used for chat commands, clips, shoutouts, polls, predictions, announcements. Log in as <strong>mistressexcella</strong>.';
      } else {
        contextEl.innerHTML = '📺 <strong>Broadcaster Account:</strong> Used for EventSub subscriptions (follows, raids, channel points). Log in as <strong>ronin_style</strong>.';
      }
      // Reload scopes when account type changes
      loadCurrentScopes();
    }

    function updateScopeCounter() {
      const checked = document.querySelectorAll('input[type="checkbox"][id^="scope-"]:checked').length;
      document.getElementById('scope-counter').textContent = checked + ' selected';
    }

    function selectAll() {
      document.querySelectorAll('input[type="checkbox"][id^="scope-"]').forEach(cb => cb.checked = true);
      updateScopeCounter();
    }

    function clearAll() {
      document.querySelectorAll('input[type="checkbox"][id^="scope-"]').forEach(cb => cb.checked = false);
      updateScopeCounter();
    }

    function generateTokens() {
      const accountType = document.getElementById('accountType').value;
      const scopes = [];
      
      document.querySelectorAll('input[type="checkbox"][id^="scope-"]:checked').forEach(cb => {
        const scopeName = cb.id.replace('scope-', '').replace(/-/g, ':');
        scopes.push(scopeName);
      });
      
      if (scopes.length === 0) {
        alert('Please select at least one scope!');
        return;
      }
      
      const authUrl = \`https://id.twitch.tv/oauth2/authorize?client_id=\${CLIENT_ID}&redirect_uri=\${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=\${scopes.join('+')}&state=\${accountType}\`;
      window.location.href = authUrl;
    }

    async function validateTokens() {
      const container = document.getElementById('token-validation');
      container.innerHTML = \`
        <div class="token-card loading"><h4>Bot Account <span class="status-badge loading">validating...</span></h4></div>
        <div class="token-card loading"><h4>Broadcaster Account <span class="status-badge loading">validating...</span></h4></div>
      \`;

      try {
        const tokensResponse = await fetch('/api/current-tokens');
        const tokens = await tokensResponse.json();
        
        let botHtml = '';
        if (tokens.botToken) {
          const validation = await fetch(\`/api/validate-token?token=\${tokens.botToken}\`);
          const data = await validation.json();
          
          if (data.valid) {
            const expiresHours = Math.floor(data.expiresIn / 3600);
            botHtml = \`
              <div class="token-card valid">
                <h4>Bot Account <span class="status-badge valid">✓ Valid</span></h4>
                <div class="token-info">
                  <div><strong>Username:</strong> \${data.username}</div>
                  <div><strong>User ID:</strong> \${data.userId}</div>
                  <div><strong>Expires In:</strong> \${expiresHours} hours</div>
                  <div><strong>Scopes:</strong> \${data.scopes.length}</div>
                </div>
              </div>
            \`;
          } else {
            botHtml = \`
              <div class="token-card invalid">
                <h4>Bot Account <span class="status-badge invalid">✗ Invalid</span></h4>
                <p style="color: #f44336; margin-top: 10px;">\${data.error}</p>
              </div>
            \`;
          }
        } else {
          botHtml = \`
            <div class="token-card invalid">
              <h4>Bot Account <span class="status-badge invalid">Not Found</span></h4>
              <p>No token configured</p>
            </div>
          \`;
        }

        let broadcasterHtml = '';
        if (tokens.broadcasterToken) {
          const validation = await fetch(\`/api/validate-token?token=\${tokens.broadcasterToken}\`);
          const data = await validation.json();
          
          if (data.valid) {
            const expiresHours = Math.floor(data.expiresIn / 3600);
            broadcasterHtml = \`
              <div class="token-card valid">
                <h4>Broadcaster Account <span class="status-badge valid">✓ Valid</span></h4>
                <div class="token-info">
                  <div><strong>Username:</strong> \${data.username}</div>
                  <div><strong>User ID:</strong> \${data.userId}</div>
                  <div><strong>Expires In:</strong> \${expiresHours} hours</div>
                  <div><strong>Scopes:</strong> \${data.scopes.length}</div>
                </div>
              </div>
            \`;
          } else {
            broadcasterHtml = \`
              <div class="token-card invalid">
                <h4>Broadcaster Account <span class="status-badge invalid">✗ Invalid</span></h4>
                <p style="color: #f44336; margin-top: 10px;">\${data.error}</p>
              </div>
            \`;
          }
        } else {
          broadcasterHtml = \`
            <div class="token-card invalid">
              <h4>Broadcaster Account <span class="status-badge invalid">Not Found</span></h4>
              <p>EventSub features will be disabled</p>
            </div>
          \`;
        }

        container.innerHTML = botHtml + broadcasterHtml;
      } catch (error) {
        container.innerHTML = \`
          <div class="token-card invalid">
            <h4>Error</h4>
            <p style="color: #f44336;">\${error.message}</p>
          </div>
        \`;
      }
    }

    // ==================== ACCOUNT MANAGER FUNCTIONS ====================

    async function loadAccounts() {
      try {
        const response = await fetch('/api/accounts');
        const data = await response.json();
        const accounts = data.accounts || [];
        
        let html = '';
        if (accounts.length === 0) {
          html = '<p style="color: #999; text-align: center; padding: 20px;">No accounts yet. Create one below!</p>';
        } else {
          html = '<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 15px;">';
          for (const account of accounts) {
            const tokenColor = getStatusColor(account.tokenStatus);
            const broadcasterColor = getStatusColor(account.broadcasterTokenStatus);
            const card = '<div style="border: 2px solid #ddd; border-radius: 8px; padding: 15px; background: #f9f9f9;"><h4 style="margin-top: 0; color: #9146ff;">' + account.name + '</h4><div style="font-size: 13px; color: #666; line-height: 1.6;"><div><strong>Channel:</strong> ' + account.broadcasterName + '</div><div><strong>Bot Token:</strong> <span style="display: inline-block; padding: 2px 8px; border-radius: 3px; font-size: 11px; font-weight: bold; background: ' + tokenColor + '; color: white;">' + account.tokenStatus.toUpperCase() + '</span></div><div><strong>Bot Scopes:</strong> ' + account.tokenScopes.length + '</div>' + (account.hasBroadcasterToken ? '<div><strong>Broadcaster Token:</strong> <span style="display: inline-block; padding: 2px 8px; border-radius: 3px; font-size: 11px; font-weight: bold; background: ' + broadcasterColor + '; color: white;">' + account.broadcasterTokenStatus.toUpperCase() + '</span></div><div><strong>Broadcaster Scopes:</strong> ' + account.broadcasterScopes.length + '</div>' : '') + '</div></div>';
            html += card;
          }
          html += '</div>';
        }
        
        document.getElementById('accounts-list').innerHTML = html;
        
        const authSelect = document.getElementById('auth-account-select');
        const actionSelect = document.getElementById('action-account-select');
        
        authSelect.innerHTML = '<option value="">-- Choose an account --</option>' + accounts.map(a => '<option value="' + a.name + '">' + a.name + '</option>').join('');
        actionSelect.innerHTML = '<option value="">-- Choose an account --</option>' + accounts.map(a => '<option value="' + a.name + '">' + a.name + '</option>').join('');
      } catch (error) {
        document.getElementById('accounts-list').innerHTML = '<p style="color: #f44336; text-align: center; padding: 20px;">Failed to load accounts: ' + error.message + '</p>';
      }
    }

    function getStatusColor(status) {
      switch (status) { case 'valid': return '#4caf50'; case 'expiring': return '#ff9800'; case 'expired': return '#f44336'; default: return '#999'; }
    }

    async function createNewAccount() {
      const name = document.getElementById('new-account-name').value.trim();
      const clientId = document.getElementById('new-client-id').value.trim();
      const clientSecret = document.getElementById('new-client-secret').value.trim();
      const broadcasterName = document.getElementById('new-broadcaster-name').value.trim();
      const channels = document.getElementById('new-channels').value.trim().split(',').map(c => c.trim()).filter(Boolean);
      if (!name || !clientId || !clientSecret || !broadcasterName) { alert('Please fill in all required fields'); return; }
      try {
        const response = await fetch('/api/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountName: name, clientId, clientSecret, broadcasterName, channels }) });
        const result = await response.json();
        if (result.success) {
          alert('✓ Account "' + name + '" created successfully!');
          document.getElementById('new-account-name').value = '';
          document.getElementById('new-client-id').value = '';
          document.getElementById('new-client-secret').value = '';
          document.getElementById('new-broadcaster-name').value = '';
          document.getElementById('new-channels').value = '';
          loadAccounts();
        } else {
          alert('Error: ' + result.error);
        }
      } catch (error) {
        alert('Failed to create account: ' + error.message);
      }
    }

    function updateAuthButtons() {
      const accountName = document.getElementById('auth-account-select').value;
      const botBtn = document.getElementById('auth-bot-btn');
      const broadcasterBtn = document.getElementById('auth-broadcaster-btn');
      
      if (!accountName) {
        botBtn.style.display = 'none';
        broadcasterBtn.style.display = 'none';
      } else {
        botBtn.style.display = 'block';
        broadcasterBtn.style.display = 'block';
      }
    }

    async function authorizeAccount(type) {
      const accountName = document.getElementById('auth-account-select').value;
      if (!accountName) { alert('Please select an account first'); return; }
      try {
        let scopes = type === 'bot' ? ['chat:read', 'chat:edit', 'clips:edit', 'moderator:manage:shoutouts', 'channel:manage:polls', 'channel:manage:predictions', 'moderator:manage:announcements'] : ['moderator:read:followers', 'channel:read:redemptions', 'channel:read:subscriptions', 'bits:read'];
        const response = await fetch('/api/accounts/' + accountName);
        const data = await response.json();
        const account = data.account;
        if (!account || !account.clientId) { alert('Account is missing Client ID'); return; }
        const authUrl = 'https://id.twitch.tv/oauth2/authorize?client_id=' + account.clientId + '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) + '&response_type=code&scope=' + scopes.join('+') + '&state=' + accountName + '_' + type;
        window.location.href = authUrl;
      } catch (error) {
        alert('Failed to authorize: ' + error.message);
      }
    }

    async function updateAccountActions() {
      const accountName = document.getElementById('action-account-select').value;
      if (!accountName) {
        document.getElementById('rename-btn').style.display = 'none';
        document.getElementById('export-btn').style.display = 'none';
        document.getElementById('delete-btn').style.display = 'none';
        document.getElementById('action-result').innerHTML = '';
        return;
      }
      document.getElementById('rename-btn').style.display = 'block';
      document.getElementById('export-btn').style.display = 'block';
      document.getElementById('delete-btn').style.display = 'block';
    }

    async function renameAccount() {
      const oldName = document.getElementById('action-account-select').value;
      const newName = prompt('Rename "' + oldName + '" to:', oldName);
      if (!newName || newName === oldName) return;
      try {
        const response = await fetch('/api/accounts/' + oldName + '/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ newName }) });
        const result = await response.json();
        if (result.success) { alert('✓ Renamed to "' + newName + '"'); loadAccounts(); } else { alert('Error: ' + result.error); }
      } catch (error) {
        alert('Failed to rename: ' + error.message);
      }
    }

    async function exportAccount() {
      const accountName = document.getElementById('action-account-select').value;
      try {
        const response = await fetch('/api/accounts/' + accountName + '/export');
        const envContent = await response.text();
        const element = document.createElement('a');
        element.setAttribute('href', 'data:text/plain;charset=utf-8,' + encodeURIComponent(envContent));
        element.setAttribute('download', accountName + '.env');
        element.style.display = 'none';
        document.body.appendChild(element);
        element.click();
        document.body.removeChild(element);
        document.getElementById('action-result').innerHTML = '<div style="padding: 15px; background: #4caf50; color: white; border-radius: 5px;">✓ Account exported as ' + accountName + '.env</div>';
      } catch (error) {
        document.getElementById('action-result').innerHTML = '<div style="padding: 15px; background: #f44336; color: white; border-radius: 5px;">✗ Export failed: ' + error.message + '</div>';
      }
    }

    async function deleteAccount() {
      const accountName = document.getElementById('action-account-select').value;
      if (!confirm('⚠️ Are you sure you want to delete "' + accountName + '"? This cannot be undone.')) return;
      try {
        const response = await fetch('/api/accounts/' + accountName, { method: 'DELETE' });
        const result = await response.json();
        if (result.success) { alert('\u2713 Account \"' + accountName + '\" deleted'); document.getElementById('action-account-select').value = ''; updateAccountActions(); loadAccounts(); } else { alert('Error: ' + result.error); }
      } catch (error) {
        alert('Failed to delete: ' + error.message);
      }
    }

    async function importFromEnv() {
      const accountName = document.getElementById('import-account-name').value.trim();
      const envContent = document.getElementById('import-env-content').value.trim();

      if (!accountName || !envContent) {
        alert('Please fill in both fields');
        return;
      }

      try {
        const response = await fetch('/api/accounts/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountName: accountName, envContent: envContent })
        });

        const result = await response.json();
        
        if (result.success) {
          document.getElementById('import-result').innerHTML = '<div style="padding: 15px; background: #4caf50; color: white; border-radius: 5px;">\u2713 Account \"' + accountName + '\" imported successfully!</div>';
          document.getElementById('import-account-name').value = '';
          document.getElementById('import-env-content').value = '';
          loadAccounts();
        } else {
          document.getElementById('import-result').innerHTML = '<div style="padding: 15px; background: #f44336; color: white; border-radius: 5px;">\u2717 Import failed: ' + result.error + '</div>';
        }
      } catch (error) {
        document.getElementById('import-result').innerHTML = '<div style="padding: 15px; background: #f44336; color: white; border-radius: 5px;">\u2717 Error: ' + error.message + '</div>';
      }
    }

    // Initialize page
    initPage();
    loadAccounts();
  </script>
</body>
</html>`;
}

// ==================== AUTHORIZATION & CALLBACK ====================

// Generate authorization URL with selected scopes
app.post('/generate-auth-url', (req, res) => {
  const { scopes, accountType } = req.body;

  if (!scopes || !Array.isArray(scopes) || scopes.length === 0) {
    return res.status(400).json({ error: 'No scopes provided' });
  }

  const scopeString = scopes.join(' ');
  const state = accountType || 'bot';
  const authUrl = `https://id.twitch.tv/oauth2/authorize?` +
    `client_id=${CLIENT_ID}&` +
    `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
    `response_type=code&` +
    `scope=${encodeURIComponent(scopeString)}&` +
    `state=${state}`;

  console.log(`Generated auth URL for ${accountType} account with ${scopes.length} scopes`);

  res.json({ authUrl });
});

// Callback handler
app.get('/callback', async (req, res) => {
  const { code, error, error_description, state } = req.query;
  
  // Parse state to get account name and type (format: "accountName_type")
  let accountName = null;
  let accountType = 'bot';
  
  if (state && state.includes('_')) {
    const parts = state.split('_');
    accountType = parts[parts.length - 1]; // Get the last part (bot or broadcaster)
    accountName = parts.slice(0, -1).join('_'); // Get everything except the last part
  } else if (state) {
    accountName = state;
    accountType = 'bot';
  }

  if (error) {
    console.log('Authorization error:', error, error_description);
    return res.send(`
      <h1>Authorization Error</h1>
      <p><strong>Error:</strong> ${error}</p>
      <p><strong>Description:</strong> ${error_description}</p>
      <a href="/">Try again</a>
    `);
  }

  if (!code) {
    console.log('No code received in callback');
    return res.send('<h1>Error: No authorization code received</h1>');
  }

  console.log(`Received authorization code for ${accountType} account: ${accountName}`);

  try {
    const response = await axios.post('https://id.twitch.tv/oauth2/token', null, {
      params: {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code: code,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI
      }
    });

    const { access_token, refresh_token, expires_in, scope } = response.data;
    console.log('Token exchange successful!');
    
    let grantedScopes = scope ? (typeof scope === 'string' ? scope.split(' ') : scope) : [];
    const scopeArray = Array.isArray(grantedScopes) ? grantedScopes : [];
    grantedScopes = scopeArray.join(', ');

    // Check if this is account manager mode (state has underscore) or manual mode (state is just "bot" or "broadcaster")
    const isAccountManagerMode = state && state.includes('_');
    
    // Save to account manager only if using account manager mode
    if (isAccountManagerMode && accountName) {
      try {
        const account = accountManager.getAccount(accountName);
        if (!account) {
          return res.send(`
            <h1>Account Not Found</h1>
            <p>Account "${accountName}" does not exist in the account manager.</p>
            <a href="/">Go back</a>
          `);
        }

        // Update account with new tokens based on type
        const scopeString = scopeArray.join(' ');
        if (accountType === 'broadcaster') {
          accountManager.updateTokens(accountName, {
            broadcasterAccessToken: access_token,
            broadcasterRefreshToken: refresh_token,
            broadcasterScopes: scopeArray,
            broadcasterExpiresIn: expires_in
          });
        } else if (accountType === 'bot') {
          accountManager.updateTokens(accountName, {
            accessToken: access_token,
            refreshToken: refresh_token,
            scopes: scopeArray,
            expiresIn: expires_in
          });
        }

        console.log(`Tokens saved to account: ${accountName} (${accountType})`);

        res.send(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Success!</title>
            <style>
              body {
                font-family: Arial, sans-serif;
                max-width: 600px;
                margin: 50px auto;
                padding: 20px;
                text-align: center;
                background: #f5f5f5;
              }
              .success {
                color: #4caf50;
                font-size: 2em;
                margin: 20px 0;
              }
              .container {
                background: white;
                padding: 30px;
                border-radius: 8px;
                box-shadow: 0 2px 4px rgba(0,0,0,0.1);
              }
              code {
                background: #f0f0f0;
                padding: 10px;
                border-radius: 4px;
                display: inline-block;
                margin: 10px 0;
              }
            </style>
          </head>
          <body>
            <div class="container">
              <h1 class="success">Success! 🎉</h1>
              <p>Your <strong>${accountType}</strong> account tokens have been saved to the account manager</p>
              <p><strong>Account:</strong> ${accountName}</p>
              <p><strong>Access Token:</strong> ${access_token.substring(0, 20)}...</p>
              <p><strong>Granted Scopes:</strong></p>
              <code>${grantedScopes}</code>
              <p>${accountType === 'broadcaster' 
                ? '✅ Broadcaster tokens configured! You can now use EventSub features.' 
                : '✅ Bot account tokens configured! Start your bot with: node Excella --account=' + accountName}</p>
              <p><a href="/">Back to account manager</a></p>
              <script>setTimeout(() => window.close(), 15000);</script>
            </div>
          </body>
          </html>
        `);
        return;
      } catch (err) {
        console.error('Account manager error:', err.message);
        // Fall back to .env saving
      }
    }

    // Fallback: Save to .env file
    await withCrossProcessLock('.env', async () => {
      let envContent;
      try {
        envContent = fs.readFileSync('.env', 'utf8');
        console.log('Read .env file successfully');
      } catch (readError) {
        console.error('Error reading .env file:', readError.message);
        return res.send(`
          <h1>Error reading .env file</h1>
          <p>${readError.message}</p>
        `);
      }

      // Update .env with new tokens
      const scopeString = scopeArray.join(' ');
      
      let updatedEnv;
      if (accountType === 'broadcaster') {
        console.log('Updating broadcaster tokens');
        updatedEnv = envContent
          .replace(/TWITCH_BROADCASTER_ACCESS_TOKEN=.*/, `TWITCH_BROADCASTER_ACCESS_TOKEN=${access_token}`)
          .replace(/TWITCH_BROADCASTER_REFRESH_TOKEN=.*/, `TWITCH_BROADCASTER_REFRESH_TOKEN=${refresh_token}`)
          .replace(/TWITCH_BROADCASTER_SCOPES=.*/, `TWITCH_BROADCASTER_SCOPES=${scopeString}`);
        
        if (!envContent.includes('TWITCH_BROADCASTER_ACCESS_TOKEN=')) {
          updatedEnv += `\nTWITCH_BROADCASTER_ACCESS_TOKEN=${access_token}`;
        }
        if (!envContent.includes('TWITCH_BROADCASTER_REFRESH_TOKEN=')) {
          updatedEnv += `\nTWITCH_BROADCASTER_REFRESH_TOKEN=${refresh_token}`;
        }
        if (!envContent.includes('TWITCH_BROADCASTER_SCOPES=')) {
          updatedEnv += `\nTWITCH_BROADCASTER_SCOPES=${scopeString}`;
        }
      } else {
        console.log('Updating bot tokens');
        updatedEnv = envContent
          .replace(/TWITCH_ACCESS_TOKEN=.*/, `TWITCH_ACCESS_TOKEN=${access_token}`)
          .replace(/TWITCH_REFRESH_TOKEN=.*/, `TWITCH_REFRESH_TOKEN=${refresh_token}`)
          .replace(/TWITCH_SCOPES=.*/, `TWITCH_SCOPES=${scopeString}`);
      }

      try {
        fs.writeFileSync('.env', updatedEnv);
        console.log('Tokens saved successfully');
      } catch (writeError) {
        console.error('Error writing to .env file:', writeError.message);
        return res.send(`
          <h1>Error saving tokens</h1>
          <p>${writeError.message}</p>
          <p>Please manually add these to your .env file</p>
        `);
      }
    });

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Success!</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            max-width: 600px;
            margin: 50px auto;
            padding: 20px;
            text-align: center;
            background: #f5f5f5;
          }
          .success {
            color: #4caf50;
            font-size: 2em;
            margin: 20px 0;
          }
          .container {
            background: white;
            padding: 30px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          code {
            background: #f0f0f0;
            padding: 10px;
            border-radius: 4px;
            display: inline-block;
            margin: 10px 0;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1 class="success">Success! 🎉</h1>
          <p>Your <strong>${accountType}</strong> account tokens have been saved to .env</p>
          <p><strong>Access Token:</strong> ${access_token.substring(0, 20)}...</p>
          <p><strong>Granted Scopes:</strong></p>
          <code>${grantedScopes}</code>
          <p>${accountType === 'broadcaster' 
            ? '✅ EventSub is ready! Remove DISABLE_EVENTSUB=1 from .env and restart the bot.' 
            : '✅ Bot account configured! Generate broadcaster tokens next for EventSub support.'}</p>
          <p>You can close this window.</p>
          <script>setTimeout(() => window.close(), 10000);</script>
        </div>
      </body>
      </html>
    `);

  } catch (error) {
    console.error('Token exchange failed:', error.response?.data || error.message);
    res.send(`
      <h1>Error exchanging tokens</h1>
      <pre>${JSON.stringify(error.response?.data || error.message, null, 2)}</pre>
      <a href="/">Try again</a>
    `);
  }
});

// Global error handler (API routes only)
app.use((err, req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return errorHandler(err, req, res, next);
  }
  // For non-API routes (HTML), provide a simple HTML error page
  res.status(err.statusCode || 500).send(`
    <h1>Something went wrong</h1>
    <p>${err.message}</p>
    <a href="/">Back to Home</a>
  `);
});

// Start server
app.listen(PORT, () => {
  console.log(`\n🚀 Token Generator Server running at http://localhost:${PORT}`);
  console.log('📱 Open this URL in your browser to generate tokens\n');
});
