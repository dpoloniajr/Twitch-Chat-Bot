require('./lib/console-timestamp');
// Replaced Twurple with direct Helix API, tmi.js for IRC, and native WebSocket for EventSub
const TwitchHelixAPI = require('./lib/twitch-helix-api');
const TwitchIRCClient = require('./lib/twitch-irc-client');
const TwitchEventSubWS = require('./lib/twitch-eventsub-ws');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { withCrossProcessLock } = require('./lib/file-lock');
require('dotenv').config();

// ==================== ACCOUNT MANAGER SUPPORT ====================
// Load account from account manager if --account flag is provided
const AccountManager = require('./account-manager');
let selectedAccountName = null;

// Parse CLI arguments
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--account' && args[i + 1]) {
    selectedAccountName = args[i + 1];
    break;
  }
}

// Load selected account if provided
if (selectedAccountName) {
  const accountManager = new AccountManager();
  const account = accountManager.getAccount(selectedAccountName);
  
  if (!account) {
    console.error(`❌ Account "${selectedAccountName}" not found. Available accounts:`, 
      accountManager.listAccounts().map(a => a.name).join(', '));
    process.exit(1);
  }

  if (!account.accessToken) {
    console.error(`❌ Account "${selectedAccountName}" has not been authorized. Run token-generator to authorize.`);
    process.exit(1);
  }

  console.log(`✓ Loaded account: ${selectedAccountName}`);

  // Load account credentials into process.env
  const envObj = accountManager.getAsEnvObject(selectedAccountName);
  Object.assign(process.env, envObj);
}

// ==================== CONFIGURATION ====================

// Constants for Twitch API
const TWITCH_API_BASE = 'https://id.twitch.tv/oauth2';
const TWITCH_VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';
const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const API_TIMEOUT = 5000;

// Global axios instance with consistent timeout and internal bot secret
const apiClient_axios = axios.create({
  timeout: API_TIMEOUT,
  headers: process.env.DASHBOARD_INTERNAL_SECRET
    ? { 'x-bot-secret': process.env.DASHBOARD_INTERNAL_SECRET }
    : {}
});

// Configuration
const config = {
  clientId: process.env.TWITCH_CLIENT_ID,
  clientSecret: process.env.TWITCH_CLIENT_SECRET,
  accessToken: process.env.TWITCH_ACCESS_TOKEN,
  refreshToken: process.env.TWITCH_REFRESH_TOKEN,
  channels: (process.env.TWITCH_CHANNELS || '').split(',').filter(c => c),
  broadcasterName: process.env.TWITCH_BROADCASTER_NAME,
  scopes: (process.env.TWITCH_SCOPES || 'chat:read chat:edit').split(' ').filter(s => s)
};

// Validate config on startup
if (!config.clientId || !config.clientSecret || !config.accessToken || !config.refreshToken || !config.broadcasterName) {
  console.error('Missing required environment variables. Please set: TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TWITCH_ACCESS_TOKEN, TWITCH_REFRESH_TOKEN, TWITCH_BROADCASTER_NAME');
  process.exit(1);
}

const tokenData = {
  accessToken: config.accessToken,
  refreshToken: config.refreshToken,
  expiresIn: 0,
  obtainmentTimestamp: 0
};

// Setup API client using direct Helix API
global.apiClient = new TwitchHelixAPI({
  clientId: config.clientId,
  accessToken: config.accessToken
});

// Register token-refresh callback so the API client can auto-recover from 401s
global.apiClient.setOnTokenRefresh(async () => {
  const refreshed = await refreshToken(config.accessToken, config.refreshToken, 'bot');
  if (refreshed) {
    config.accessToken = refreshed.accessToken;
    config.refreshToken = refreshed.refreshToken;
    await chatClient.updateToken(config.accessToken);
  }
  return refreshed;
});

// Create Chat client using tmi.js wrapper
// Note: username will be set during init() after token validation
global.chatClient = new TwitchIRCClient({
  username: config.broadcasterName, // Will be updated after token validation
  accessToken: config.accessToken,
  channels: config.channels
});

let broadcasterId = null;
let broadcasterUserId = null;
let tokenUserId = null;
let botStartTime = Date.now();
let initComplete = false;
const dashboardBaseUrl = `http://localhost:${process.env.DASHBOARD_PORT || 3001}`;
let customCommands = [];
let builtinCommands = [];
let eventSub = null;
let broadcasterEventSub = null;

// Token validation caching (avoid repeated HTTP calls)
let cachedTokenValidation = {
  bot: { lastCheck: 0, isValid: false, expiresAt: 0, scopes: [] },
  broadcaster: { lastCheck: 0, isValid: false, expiresAt: 0, scopes: [] }
};
const TOKEN_CACHE_DURATION = 3600000; // 1 hour
// How far ahead of expiry to treat a token as needing refresh (must match scheduleProactiveTokenRefresh)
const TOKEN_EXPIRY_LEAD_MS = 5 * 60 * 1000; // 5 minutes

// Scope validation caching
let cachedScopeValidation = {};

// Message history cleanup tracking
let lastMessageHistoryCleanup = Date.now();

// Expose clients for easy access
const apiClient = global.apiClient;
const chatClient = global.chatClient;

// Setup broadcaster API client if broadcaster token is available
let broadcasterApiClient = null;

if (process.env.TWITCH_BROADCASTER_ACCESS_TOKEN) {
  broadcasterApiClient = new TwitchHelixAPI({
    clientId: config.clientId,
    accessToken: process.env.TWITCH_BROADCASTER_ACCESS_TOKEN
  });
}

// Chat filtering system
const chatFilters = {
  blacklistWords: new Set((process.env.CHAT_FILTER_WORDS || '').split('|').map(w => w.trim().toLowerCase()).filter(Boolean)),
  filterUrls: process.env.CHAT_FILTER_URLS === 'true' || process.env.CHAT_FILTER_URLS === '1',
  filterAllCaps: process.env.CHAT_FILTER_ALLCAPS === 'true' || process.env.CHAT_FILTER_ALLCAPS === '1',
  filterRepeatChars: process.env.CHAT_FILTER_REPEAT === 'true' || process.env.CHAT_FILTER_REPEAT === '1',
  filterSpam: process.env.CHAT_FILTER_SPAM === 'true' || process.env.CHAT_FILTER_SPAM === '1',
  timeoutDurationSeconds: Number(process.env.CHAT_FILTER_TIMEOUT_SEC || 60),
  filterAction: process.env.CHAT_FILTER_ACTION || 'warn' // 'warn', 'timeout', 'delete'
};

// Filter status cache for performance optimization
let filterStatusCache = null;
let filterCacheTimestamp = 0;
const FILTER_CACHE_TTL = 5000; // 5 second cache TTL

const messageHistory = new Map(); // Track user messages for spam detection

// Helper to check if env var is a common falsy value
function isFalsyEnvValue(envVar) {
  return ['false', '0', 'no', 'off'].includes(
    String(envVar || '').toLowerCase()
  );
}

// First-time chatter welcome (uses IRC tag first-msg)
const firstChatterConfig = {
  // Enabled by default; allow several common falsy values to disable
  welcomeEnabled: !isFalsyEnvValue(process.env.FIRST_CHATTER_WELCOME_ENABLED),
  welcomeMessage: (process.env.FIRST_CHATTER_MESSAGE || 'Welcome to the chat, {user}!').trim(),
  alertEnabled: !isFalsyEnvValue(process.env.FIRST_CHATTER_ALERT_ENABLED)
};

// ==================== HELPER FUNCTIONS ====================

// Check if user has moderator or broadcaster permissions
function checkModPermission(msg, channel, username) {
  const isMod = msg.userInfo.isMod;
  const isBroadcaster = msg.userInfo.isBroadcaster;
  return isMod || isBroadcaster;
}

// Send chat message with consistent formatting
function sendChatMessage(channel, message) {
  try {
    const msgStr = String(message || '').trim();
    if (!msgStr) return;
    chatClient.say(channel, msgStr);
  } catch (error) {
    console.error(`Failed to send message to ${channel}:`, error.message);
  }
}

// Get API headers for Helix calls
function getApiHeaders() {
  return {
    'Client-ID': config.clientId,
    'Authorization': `Bearer ${config.accessToken}`,
    'Content-Type': 'application/json'
  };
}

// Get API headers using the broadcaster token (required for broadcaster-scoped endpoints
// like /helix/polls and /helix/predictions). Falls back to the bot token if no
// broadcaster token is configured (single-account setup).
function getBroadcasterApiHeaders() {
  const token = process.env.TWITCH_BROADCASTER_ACCESS_TOKEN || config.accessToken;
  return {
    'Client-ID': config.clientId,
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };
}

// Return the scope list that corresponds to the token used by getBroadcasterApiHeaders().
// When a separate broadcaster token is configured, validate against its scopes; otherwise
// fall back to the bot's scopes (single-account setup).
function getBroadcasterScopes() {
  if (process.env.TWITCH_BROADCASTER_ACCESS_TOKEN) {
    const scopes = (process.env.TWITCH_BROADCASTER_SCOPES || '').split(' ').filter(s => s);
    // If broadcaster scopes are not configured, fall back to bot scopes to allow fallback behavior
    return scopes.length > 0 ? scopes : config.scopes;
  }
  return config.scopes;
}

// Centralized scope validation with caching
function validateScopes(requiredScopes) {
  const scopeSet = new Set(config.scopes);
  return requiredScopes.every(scope => scopeSet.has(scope));
}

// Log command execution to dashboard
function logCommandExecution(username, command, args, success) {
  apiClient_axios.post(`${dashboardBaseUrl}/api/logs`, {
    timestamp: new Date().toISOString(),
    user: username,
    command,
    args: Array.isArray(args) ? args.join(' ') : '',
    success: success === true || success === 'success'
  }).catch((err) => {
    console.error('[Logging] Failed to post command log:', err.message);
  });
}

// Send alert to OBS overlays via dashboard WebSocket
function sendAlert(alertType, alertData) {
  apiClient_axios.post(`${dashboardBaseUrl}/api/test-alert`, {
    alertType,
    ...alertData
  }).catch(err => {
    console.error('[Alert] Failed to send alert:', err.message);
  });
}

// ==================== CHAT HYPE (ORIGINAL FEATURE) ====================
// Tracks chat activity and triggers a "hype" moment when message rate crosses a threshold.

const HYPE_WINDOW_MS = (Number(process.env.HYPE_WINDOW_SEC) || 60) * 1000;
const hypeActivityByChannel = new Map(); // channel -> { timestamps: number[] }
const lastHypeTriggerByChannel = new Map(); // channel -> timestamp (ms)

const hypeConfig = {
  enabled: process.env.HYPE_ENABLED !== 'false' && process.env.HYPE_ENABLED !== '0',
  minMessages: Math.max(5, parseInt(process.env.HYPE_MIN_MESSAGES, 10) || 15),
  windowSec: Number(process.env.HYPE_WINDOW_SEC) || 60,
  cooldownSec: Math.max(30, parseInt(process.env.HYPE_COOLDOWN_SEC, 10) || 120),
  message: (process.env.HYPE_MESSAGE || 'Chat is HYPED! 🔥').trim()
};

function getHypeConfig() {
  return { ...hypeConfig };
}

function recordChatForHype(channel) {
  const key = channel.toLowerCase();
  const now = Date.now();
  const cutoff = now - HYPE_WINDOW_MS;

  if (!hypeActivityByChannel.has(key)) {
    hypeActivityByChannel.set(key, { timestamps: [] });
  }
  const entry = hypeActivityByChannel.get(key);
  entry.timestamps.push(now);
  while (entry.timestamps.length > 0 && entry.timestamps[0] < cutoff) {
    entry.timestamps.shift();
  }
  return entry.timestamps.length;
}

function getHypeCount(channel) {
  const key = channel.toLowerCase();
  const entry = hypeActivityByChannel.get(key);
  if (!entry) return 0;
  const cutoff = Date.now() - HYPE_WINDOW_MS;
  const valid = entry.timestamps.filter(t => t >= cutoff);
  return valid.length;
}

function tryTriggerHype(channel) {
  if (!hypeConfig.enabled) return;
  const count = getHypeCount(channel);
  if (count < hypeConfig.minMessages) return;

  const key = channel.toLowerCase();
  const last = lastHypeTriggerByChannel.get(key) || 0;
  const cooldownMs = hypeConfig.cooldownSec * 1000;
  if (Date.now() - last < cooldownMs) return;

  lastHypeTriggerByChannel.set(key, Date.now());
  sendChatMessage(channel, hypeConfig.message);
  apiClient_axios.post(`${dashboardBaseUrl}/api/hype/trigger`, {
    channel,
    count,
    threshold: hypeConfig.minMessages,
    windowSec: hypeConfig.windowSec
  }).catch(err => {
    console.error('[Hype] Failed to broadcast hype:', err.message);
  });
}

// Log EventSub event to dashboard
function logEventSubEvent(eventType, eventData) {
  apiClient_axios.post(`${dashboardBaseUrl}/api/eventsub-events`, {
    type: eventType,
    ...eventData
  }).catch(err => {
    console.error('[EventSub] Failed to log event:', err.message);
  });
}

// ==================== CHAT FILTER FUNCTIONS ====================

function checkChatFilters(message, username) {
  const text = message.toLowerCase().trim();
  const violations = [];

  // Check blacklist words
  if (chatFilters.blacklistWords.size > 0) {
    const words = text.split(/\s+/);
    for (const word of words) {
      const cleaned = word.replace(/[^\w]/g, '');
      if (chatFilters.blacklistWords.has(cleaned)) {
        violations.push('blacklist_word');
        break;
      }
    }
  }

  // Check for URLs
  if (chatFilters.filterUrls && /https?:\/\/|www\./i.test(message)) {
    violations.push('url');
  }

  // Check all caps (if more than 50% caps and at least 5 chars)
  if (chatFilters.filterAllCaps && message.length >= 5) {
    const capsCount = (message.match(/[A-Z]/g) || []).length;
    if (capsCount / message.length >= 0.5) {
      violations.push('all_caps');
    }
  }

  // Check repeated characters (3+ same char in a row)
  if (chatFilters.filterRepeatChars && /(.)\1{2,}/.test(message)) {
    violations.push('repeat_chars');
  }

  // Check spam (same message within 5 seconds from same user)
  if (chatFilters.filterSpam) {
    const now = Date.now();
    if (messageHistory.has(username)) {
      const lastMsg = messageHistory.get(username);
      if (lastMsg.text === text && now - lastMsg.time < 5000) {
        violations.push('spam');
      }
    }
    messageHistory.set(username, { text, time: now });

    // Periodic cleanup: remove messages older than 10 minutes (run every 60 seconds)
    if (now - lastMessageHistoryCleanup > 60000) {
      const tenMinutesAgo = now - 600000;
      for (const [user, msg] of messageHistory.entries()) {
        if (msg.time < tenMinutesAgo) {
          messageHistory.delete(user);
        }
      }
      lastMessageHistoryCleanup = now;
    }
  }

  return violations;
}

// Check chat filters without side effects (for TTS validation)
// This version doesn't update messageHistory to avoid affecting spam detection
function checkChatFiltersWithoutSideEffects(message) {
  const text = message.toLowerCase().trim();
  const violations = [];

  // Check blacklist words
  if (chatFilters.blacklistWords.size > 0) {
    const words = text.split(/\s+/);
    for (const word of words) {
      const cleaned = word.replace(/[^\w]/g, '');
      if (chatFilters.blacklistWords.has(cleaned)) {
        violations.push('blacklist_word');
        break;
      }
    }
  }

  // Check for URLs
  if (chatFilters.filterUrls && /https?:\/\/|www\./i.test(message)) {
    violations.push('url');
  }

  // Check all caps (if more than 50% caps and at least 5 chars)
  if (chatFilters.filterAllCaps && message.length >= 5) {
    const capsCount = (message.match(/[A-Z]/g) || []).length;
    if (capsCount / message.length >= 0.5) {
      violations.push('all_caps');
    }
  }

  // Check repeated characters (3+ same char in a row)
  if (chatFilters.filterRepeatChars && /(.)\1{2,}/.test(message)) {
    violations.push('repeat_chars');
  }

  // Note: Spam detection is intentionally skipped in this version
  // as it requires message history tracking which would be a side effect

  return violations;
}

// Announcement scheduler config
const ANNOUNCEMENT_INTERVAL_MS = Number(process.env.ANNOUNCEMENT_INTERVAL_MS || 900000); // default 15m
const ANNOUNCEMENTS = (process.env.ANNOUNCEMENTS || '').split('|').map(s => s.trim()).filter(Boolean);
let announcementTimer = null;
let tokenRefreshTimer = null;
let tokenRefreshInProgress = false;

async function startAnnouncements() {
  if (!ANNOUNCEMENTS.length || ANNOUNCEMENT_INTERVAL_MS < 60000) return;
  if (announcementTimer) clearInterval(announcementTimer);
  let idx = 0;
  announcementTimer = setInterval(async () => {
    try {
      const msg = ANNOUNCEMENTS[idx % ANNOUNCEMENTS.length];
      idx++;
      for (const channel of config.channels) {
        // Use live scopes from last token validation (falls back to config if not yet populated)
        const liveScopes = cachedTokenValidation.bot.scopes.length > 0
          ? cachedTokenValidation.bot.scopes
          : config.scopes;
        if (hasScope(liveScopes, 'moderator:manage:announcements')) {
          let result = await apiClient.sendAnnouncement(broadcasterId, tokenUserId, msg, 'purple');

          // If the call fails with a token error, attempt a refresh and retry once
          if (!result.success && result.status === 401 && !tokenRefreshInProgress) {
            console.log('Announcement failed with 401 — refreshing token and retrying...');
            tokenRefreshInProgress = true;
            cachedTokenValidation.bot.lastCheck = 0;
            const refreshed = await refreshToken(config.accessToken, config.refreshToken, 'bot');
            if (refreshed) {
              config.accessToken = refreshed.accessToken;
              config.refreshToken = refreshed.refreshToken;
              process.env.TWITCH_ACCESS_TOKEN = refreshed.accessToken;
              process.env.TWITCH_REFRESH_TOKEN = refreshed.refreshToken;
              // Re-validate immediately to populate fresh expiresAt and scopes before scheduling
              await validateTokenCached(config.accessToken, 'bot');
              await recreateAuthProvider();
              scheduleProactiveTokenRefresh();
              result = await apiClient.sendAnnouncement(broadcasterId, tokenUserId, msg, 'purple');
            }
            tokenRefreshInProgress = false;
          }

          if (!result.success) {
            sendChatMessage(channel, msg);
          }
        } else {
          sendChatMessage(channel, msg);
        }
      }
    } catch (e) {
      // ignore announcement errors
    }
  }, ANNOUNCEMENT_INTERVAL_MS);
}

async function setupEventSub() {
  if (eventSub) return;
  // Allow disabling EventSub via env if token auth is problematic
  if (process.env.DISABLE_EVENTSUB === '1') {
    console.log('EventSub disabled via DISABLE_EVENTSUB=1');
    return;
  }
  // Guard: valid broadcaster ID required
  if (!broadcasterId || !/^\d+$/.test(String(broadcasterId))) {
    console.warn('EventSub disabled: broadcasterId invalid or non-numeric', broadcasterId);
    return;
  }
  if (!tokenUserId) {
    console.warn('EventSub disabled: no user token context');
    return;
  }
  // Guard: token scopes must include moderator or user permissions, not just channel:bot
  const hasUserScopes = config.scopes.some(s =>
    s.startsWith('user:') || s.startsWith('moderator:') || s.startsWith('channel:manage') || s.startsWith('channel:read')
  );
  if (!hasUserScopes) {
    console.warn('EventSub disabled: token scopes lack user permissions. Re-authorize with proper scopes.');
    return;
  }
  try {
    eventSub = new TwitchEventSubWS({
      clientId: config.clientId,
      accessToken: config.accessToken
    });
    await eventSub.start();

    // Stream online/offline
    const subId = String(broadcasterId);
    console.log('[EventSub-Bot] Subscribing with broadcasterId:', subId, 'isNumeric:', /^\d+$/.test(subId), 'tokenUserId:', tokenUserId);

    // These subscriptions work with bot token
    try {
      await eventSub.onStreamOnline(subId, ev => {
        console.log('EventSub: Stream online');
        config.channels.forEach(ch => sendChatMessage(ch, 'Stream is now live!'));
      });
    } catch (err) {
      console.warn('[EventSub-Bot] Stream online subscription failed:', err.message);
    }

    try {
      await eventSub.onStreamOffline(subId, ev => {
        console.log('EventSub: Stream offline');
      });
    } catch (err) {
      console.warn('[EventSub-Bot] Stream offline subscription failed:', err.message);
    }

    console.log('✓ Bot EventSub listener initialized successfully');
  } catch (err) {
    console.error('Bot EventSub setup failed:', err?.message || err);
  }
}

// Setup separate EventSub listener for broadcaster account (for follows, raids, etc.)
async function setupBroadcasterEventSub() {
  if (broadcasterEventSub) return;

  // Guard: broadcaster API client required
  if (!broadcasterApiClient) {
    console.log('[EventSub-Broadcaster] Broadcaster token not available. Skipping broadcaster EventSub setup.');
    return;
  }

  if (process.env.DISABLE_EVENTSUB === '1') {
    console.log('[EventSub-Broadcaster] EventSub disabled via DISABLE_EVENTSUB=1');
    return;
  }

  if (!broadcasterId || !/^\d+$/.test(String(broadcasterId))) {
    console.warn('[EventSub-Broadcaster] broadcasterId invalid or non-numeric', broadcasterId);
    return;
  }

  // Validate broadcaster token and use actual scopes from Twitch (not just env var)
  await validateTokenCached(process.env.TWITCH_BROADCASTER_ACCESS_TOKEN, 'broadcaster');
  const broadcasterScopes = cachedTokenValidation.broadcaster.scopes.length > 0
    ? cachedTokenValidation.broadcaster.scopes
    : (process.env.TWITCH_BROADCASTER_SCOPES || '').split(' ').filter(s => s);
  const hasFollowersScope = hasScope(broadcasterScopes, 'moderator:read:followers');
  const hasRedemptionsScope = hasScope(broadcasterScopes, 'channel:read:redemptions');
  const hasSubscriptionsScope = hasScope(broadcasterScopes, 'channel:read:subscriptions');
  const hasBitsScope = hasScope(broadcasterScopes, 'bits:read');

  if (!hasFollowersScope && !hasRedemptionsScope && !hasSubscriptionsScope && !hasBitsScope) {
    console.warn('[EventSub-Broadcaster] Broadcaster token missing required scopes:');
    console.warn('[EventSub-Broadcaster]   - moderator:read:followers (for follow events)');
    console.warn('[EventSub-Broadcaster]   - channel:read:redemptions (for redemption events)');
    console.warn('[EventSub-Broadcaster]   - channel:read:subscriptions (for subscription events)');
    console.warn('[EventSub-Broadcaster]   - bits:read (for bits/cheer events)');
    console.warn('[EventSub-Broadcaster] Visit http://localhost:3000 to regenerate broadcaster token with proper scopes.');
    return;
  }

  try {
    broadcasterEventSub = new TwitchEventSubWS({
      clientId: config.clientId,
      accessToken: process.env.TWITCH_BROADCASTER_ACCESS_TOKEN
    });
    await broadcasterEventSub.start();

    const subId = String(broadcasterId);
    console.log('[EventSub-Broadcaster] Subscribing with broadcasterId:', subId);

    // Follows (requires broadcaster auth with moderator:read:followers scope)
    if (hasFollowersScope) {
      try {
        // onChannelFollow requires (broadcasterId, moderatorUserId, handler)
        // Use broadcasterUserId since the broadcaster token is authorized to the broadcaster account
        await broadcasterEventSub.onChannelFollow(subId, broadcasterUserId, ev => {
          const name = ev.userDisplayName || ev.userName || 'someone';
          config.channels.forEach(ch => sendChatMessage(ch, `Thanks for the follow, ${name}!`));

          // Log event and send alert to OBS overlay
          logEventSubEvent('follow', { user: name });
          sendAlert('follow', { user: name });
        });
        console.log('[EventSub-Broadcaster] Follow subscription active');
      } catch (err) {
        console.warn('[EventSub-Broadcaster] Follow subscription failed:', err.message);
      }
    } else {
      console.warn('[EventSub-Broadcaster] Skipping follow subscription: missing moderator:read:followers scope');
    }

    // Raids
    try {
      await broadcasterEventSub.onChannelRaidTo(subId, ev => {
        const from = ev.raidingBroadcasterDisplayName || ev.raidingBroadcasterName;
        const viewers = ev.viewers ?? 0;
        config.channels.forEach(ch => sendChatMessage(ch, `Incoming raid from ${from} with ${viewers} viewers! Welcome!`));

        // Log event and send alert to OBS overlay
        logEventSubEvent('raid', { user: from, viewers: Number(viewers) });
        sendAlert('raid', { user: from, viewers: Number(viewers) });
      });
      console.log('[EventSub-Broadcaster] Raid subscription active');
    } catch (err) {
      console.warn('[EventSub-Broadcaster] Raid subscription failed:', err.message);
    }

    // Channel Points redemptions (requires broadcaster auth with channel:read:redemptions scope)
    if (hasRedemptionsScope) {
      try {
        await broadcasterEventSub.onChannelRedemptionAdd(subId, async ev => {
          const reward = ev.rewardTitle || 'Reward';
          const user = ev.userDisplayName || ev.userName;
          const input = ev.userInput || '';
          console.log('[EventSub-Broadcaster] Redemption:', reward, 'by', user, 'input:', input);
          // Log to dashboard
          apiClient_axios.post(`${dashboardBaseUrl}/api/redemptions`, {
            user, reward, input
          }).catch(() => {});

          // Check if this is a TTS redemption (using configured reward title)
          const rewardLower = reward.toLowerCase();
          const isTTSRedemption = rewardLower.includes(TTS_CONFIG.CHANNEL_POINTS_REWARD_TITLE.toLowerCase());

          if (isTTSRedemption && input) {
            // Process as TTS (bypasses per-user cooldown but respects global cooldown)
            const channel = ev.broadcasterUserLogin
              ? `#${ev.broadcasterUserLogin}`
              : config.channels[0];
            const args = input.split(' ');
            await handleTTS(channel, user, args, null, true);
          } else {
            // Basic mapping: echo to chat for non-TTS redemptions
            config.channels.forEach(ch => sendChatMessage(ch, `${user} redeemed: ${reward}${input ? ' - ' + input : ''}`));

            // Log event and send alert to OBS overlay
            logEventSubEvent('redemption', { user, reward, message: input });
            sendAlert('redemption', { user, reward, message: input });
          }
        });
        console.log('[EventSub-Broadcaster] Channel Points redemption subscription active');
      } catch (err) {
        console.warn('[EventSub-Broadcaster] Redemption subscription failed:', err.message);
      }
    } else {
      console.warn('[EventSub-Broadcaster] Skipping redemption subscription: missing channel:read:redemptions scope');
    }

    // Subscriptions (requires broadcaster auth with channel:read:subscriptions scope)
    if (hasSubscriptionsScope) {
      try {
        // Regular subscription
        await broadcasterEventSub.onChannelSubscription(subId, ev => {
          const user = ev.userDisplayName || ev.userName || 'someone';
          const tier = ev.tier || '1000'; // '1000' = Tier 1, '2000' = Tier 2, '3000' = Tier 3
          const tierName = tier === '3000' ? 'Tier 3' : tier === '2000' ? 'Tier 2' : 'Tier 1';
          const isGift = ev.isGift || false;

          console.log('[EventSub-Broadcaster] Subscription:', user, tierName, isGift ? '(gifted)' : '');

          if (!isGift) {
            config.channels.forEach(ch => sendChatMessage(ch, `Thank you ${user} for the ${tierName} sub!`));
          }

          // Log event and send alert to OBS overlay
          logEventSubEvent('subscription', { user, tier: tierName, isGift });
          if (!isGift) {
            sendAlert('subscription', { user, tier: tierName });
          }
        });
        console.log('[EventSub-Broadcaster] Subscription event active');
      } catch (err) {
        console.warn('[EventSub-Broadcaster] Subscription event failed:', err.message);
      }

      try {
        // Subscription message (resubs with message)
        await broadcasterEventSub.onChannelSubscriptionMessage(subId, ev => {
          const user = ev.userDisplayName || ev.userName || 'someone';
          const tier = ev.tier || '1000';
          const tierName = tier === '3000' ? 'Tier 3' : tier === '2000' ? 'Tier 2' : 'Tier 1';
          const months = ev.cumulativeMonths || 1;
          const message = ev.messageText || '';

          console.log('[EventSub-Broadcaster] Resub:', user, tierName, months, 'months');

          config.channels.forEach(ch => {
            const msgPart = message ? ` and says: "${message}"` : '';
            sendChatMessage(ch, `Thank you ${user} for ${months} months at ${tierName}!${msgPart}`);
          });

          // Log event and send alert to OBS overlay
          logEventSubEvent('subscription', { user, tier: tierName, months, message });
          sendAlert('subscription', { user, tier: tierName, message: `${months} months${message ? ' - ' + message : ''}` });
        });
        console.log('[EventSub-Broadcaster] Subscription message event active');
      } catch (err) {
        console.warn('[EventSub-Broadcaster] Subscription message event failed:', err.message);
      }

      try {
        // Gift subscription
        await broadcasterEventSub.onChannelSubscriptionGift(subId, ev => {
          const gifter = ev.gifterDisplayName || ev.gifterName || 'Anonymous';
          const tier = ev.tier || '1000';
          const tierName = tier === '3000' ? 'Tier 3' : tier === '2000' ? 'Tier 2' : 'Tier 1';
          const amount = ev.amount || 1;
          const isAnonymous = ev.isAnonymous || false;
          const total = ev.cumulativeAmount || amount;

          console.log('[EventSub-Broadcaster] Gift Sub:', gifter, 'gifted', amount, tierName, 'subs');

          const gifterName = isAnonymous ? 'An anonymous gifter' : gifter;
          config.channels.forEach(ch => {
            sendChatMessage(ch, `${gifterName} gifted ${amount} ${tierName} sub${amount > 1 ? 's' : ''}! (${total} total)`);
          });

          // Log event and send alert to OBS overlay
          logEventSubEvent('subscription_gift', { user: gifterName, tier: tierName, amount, total, isAnonymous });
          sendAlert('subscription', {
            user: gifterName,
            tier: tierName,
            message: `Gifted ${amount} sub${amount > 1 ? 's' : ''}!`
          });
        });
        console.log('[EventSub-Broadcaster] Gift subscription event active');
      } catch (err) {
        console.warn('[EventSub-Broadcaster] Gift subscription event failed:', err.message);
      }
    } else {
      console.warn('[EventSub-Broadcaster] Skipping subscription events: missing channel:read:subscriptions scope');
    }

    // Bits/Cheers (requires broadcaster auth with bits:read scope)
    if (hasBitsScope) {
      try {
        await broadcasterEventSub.onChannelCheer(subId, ev => {
          const user = ev.userDisplayName || ev.userName || 'Anonymous';
          const bits = ev.bits || 0;
          const message = ev.message || '';
          const isAnonymous = ev.isAnonymous || false;

          console.log('[EventSub-Broadcaster] Cheer:', user, 'cheered', bits, 'bits');

          const cheererName = isAnonymous ? 'Anonymous' : user;
          config.channels.forEach(ch => {
            const msgPart = message ? ` "${message}"` : '';
            sendChatMessage(ch, `${cheererName} cheered ${bits} bits!${msgPart}`);
          });

          // Log event and send alert to OBS overlay
          logEventSubEvent('bits', { user: cheererName, amount: bits, message, isAnonymous });
          sendAlert('bits', { user: cheererName, amount: bits, message });
        });
        console.log('[EventSub-Broadcaster] Bits/Cheer event active');
      } catch (err) {
        console.warn('[EventSub-Broadcaster] Bits/Cheer event failed:', err.message);
      }
    } else {
      console.warn('[EventSub-Broadcaster] Skipping bits/cheer events: missing bits:read scope');
    }

    console.log('Broadcaster EventSub listener initialized successfully');
  } catch (err) {
    console.error('Broadcaster EventSub setup failed:', err?.message || err);
  }
}
const commandCooldowns = new Map();
const ttsUserCooldowns = new Map(); // Per-user TTS cooldowns
let lastGlobalTTSTime = 0; // Global TTS cooldown

// Load built-in command configuration
async function loadBuiltinCommands() {
  try {
    const response = await apiClient_axios.get(`${dashboardBaseUrl}/api/builtin-commands`);
    builtinCommands = response.data || [];
    console.log(`✓ Loaded ${builtinCommands.length} built-in command configurations`);
  } catch (err) {
    console.error('Failed to load built-in commands config:', err.message);
    builtinCommands = [];
  }
}

// Get cooldown for a command
function getCommandCooldown(commandName) {
  const cmd = builtinCommands.find(c => c.name === commandName);
  return cmd ? (cmd.cooldownSeconds || 0) : 0;
}

function formatResponse(template, ctx) {
  return template
    .replace(/\{user\}/gi, ctx.user || '')
    .replace(/\{displayname\}/gi, ctx.displayName || ctx.user || '')
    .replace(/\{channel\}/gi, ctx.channel || '')
    .replace(/\{target\}/gi, ctx.target || '')
    .replace(/\{data\}/gi, ctx.data || '')
    .trim();
}

// Update dashboard with bot state
async function updateDashboard() {
  try {
    await apiClient_axios.post(`${dashboardBaseUrl}/api/update-state`, {
      isConnected: true,
      channels: config.channels,
      broadcasterName: config.broadcasterName,
      uptime: Date.now() - botStartTime,
      scopes: config.scopes,
      commands: [
        { name: '!clip', description: 'Create a clip of the stream' },
        { name: '!followage [username]', description: 'Check how long someone has been following' },
        { name: '!8ball <question>', description: 'Ask the magic 8ball a yes/no question' },
        { name: '!dice [sides]', description: 'Roll a die (default 6, e.g. !dice 20 for d20)' },
        { name: '!coinflip', description: 'Flip a coin — heads or tails' },
        { name: '!shoutout [username] / !so [username]', description: 'Shout out another streamer (mods only)' },
        { name: '!poll', description: 'Manage channel polls' },
        { name: '!prediction', description: 'Manage channel predictions' },
        { name: '!title "new title"', description: 'Update stream title (mods/broadcaster)' },
        { name: '!game <name>', description: 'Update stream game/category (mods/broadcaster)' },
        { name: '!commands', description: 'Show available commands' }
      ]
    });
  } catch (error) {
    // Dashboard may not be running, silently fail
  }
}



// Custom command caching with debouncing
let customCommandsCache = null;
let customCommandsCacheTime = 0;
let customCommandsLoadPending = false;
let CUSTOM_COMMANDS_CACHE_TTL = Number(process.env.COMMAND_REFRESH_INTERVAL || 60) * 1000;
let customCommandsDebounceTimer = null;

// Load custom commands from dashboard with caching and debouncing
async function loadCustomCommands() {
  // Clear any pending debounce
  if (customCommandsDebounceTimer) {
    clearTimeout(customCommandsDebounceTimer);
  }
  
  // Return cache if still valid
  if (customCommandsCache !== null && (Date.now() - customCommandsCacheTime) < CUSTOM_COMMANDS_CACHE_TTL) {
    return;
  }
  
  // Prevent duplicate simultaneous requests
  if (customCommandsLoadPending) {
    return;
  }
  
  customCommandsLoadPending = true;
  
  try {
    const res = await apiClient_axios.get(`${dashboardBaseUrl}/api/custom-commands`, { timeout: 5000 });
    customCommands = res.data || [];
    customCommandsCache = customCommands;
    customCommandsCacheTime = Date.now();
    console.log(`✓ Loaded ${customCommands.length} custom command(s)${customCommands.length > 0 ? ': ' + customCommands.map(c => c.name).join(', ') : ''}`);
  } catch (error) {
    // Use cached value if available, even if expired
    if (customCommandsCache !== null) {
      customCommands = customCommandsCache;
      console.warn(`⚠️  Dashboard unreachable, using cached commands (${customCommands.length})`);
    } else {
      customCommands = [];
      console.error(`✗ Failed to load custom commands: ${error.message}`);
      console.error(`   Make sure dashboard is running: npm run dashboard`);
    }
  } finally {
    customCommandsLoadPending = false;
  }
}

function isOnCooldown(cmdName, cooldownSeconds) {
  if (!cooldownSeconds || cooldownSeconds <= 0) return false;
  const last = commandCooldowns.get(cmdName) || 0;
  return Date.now() - last < cooldownSeconds * 1000;
}

function setCooldown(cmdName) {
  commandCooldowns.set(cmdName, Date.now());
}

async function renderCustomCommand(cmd, context) {
  let data = '';

  if (cmd.fetchEnabled && cmd.fetchUrl) {
    try {
      // Validate URL to prevent SSRF attacks
      const url = new URL(cmd.fetchUrl);

      // Block requests to internal IP addresses and reserved hostnames
      const hostname = url.hostname.toLowerCase();

      // Exact matches for localhost variants
      if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
        return { success: false, error: 'Internal URLs are not allowed' };
      }

      // Block private IP ranges (RFC 1918, RFC 5733)
      const privateRanges = [/^10\./, /^172\.(1[6-9]|2[0-9]|3[01])\./, /^192\.168\./, /^169\.254\./];
      for (const range of privateRanges) {
        if (range.test(hostname)) {
          return { success: false, error: 'Internal URLs are not allowed' };
        }
      }

      const resp = await axios.get(cmd.fetchUrl, { timeout: 5000 });
      data = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
    } catch (err) {
      if (err instanceof Error && err.message.includes('Internal URLs')) {
        return { success: false, error: err.message };
      }
      return { success: false, error: `Failed to fetch URL: ${err.message}` };
    }
  }

  const template = (cmd.response && cmd.response.trim().length > 0) ? cmd.response : '{data}';
  const rendered = formatResponse(template, { ...context, data });
  return { rendered };
}

// Validate and refresh tokens if needed
async function validateAndRefreshTokens() {
  console.log('\n🔍 Validating tokens...');
  
  let tokensUpdated = false;
  
  // Parallelize token validation for bot and broadcaster
  const validationTasks = [
    validateTokenCached(config.accessToken, 'bot')
  ];
  
  if (process.env.TWITCH_BROADCASTER_ACCESS_TOKEN) {
    validationTasks.push(
      validateTokenCached(process.env.TWITCH_BROADCASTER_ACCESS_TOKEN, 'broadcaster')
    );
  }
  
  const results = await Promise.all(validationTasks);
  const botTokenValid = results[0];
  const broadcasterTokenValid = results[1];
  
  // Handle bot token
  console.log('Checking bot account token...');
  if (!botTokenValid) {
    console.log('⚠️  Bot token is invalid or expired. Attempting to refresh...');
    const refreshedBot = await refreshToken(config.accessToken, config.refreshToken, 'bot');
    if (refreshedBot) {
      config.accessToken = refreshedBot.accessToken;
      config.refreshToken = refreshedBot.refreshToken;
      process.env.TWITCH_ACCESS_TOKEN = refreshedBot.accessToken;
      process.env.TWITCH_REFRESH_TOKEN = refreshedBot.refreshToken;
      // Re-validate immediately to populate fresh expiresAt and scopes in cache
      await validateTokenCached(config.accessToken, 'bot');
      console.log('✓ Bot token refreshed successfully');
      tokensUpdated = true;
    } else {
      console.error('✗ Failed to refresh bot token. Please visit http://localhost:3000 to generate new tokens.');
      process.exit(1);
    }
  } else {
    console.log('✓ Bot token is valid');
  }
  
  // Handle broadcaster token if it exists
  if (process.env.TWITCH_BROADCASTER_ACCESS_TOKEN) {
    console.log('Checking broadcaster account token...');
    if (!broadcasterTokenValid) {
      console.log('⚠️  Broadcaster token is invalid or expired. Attempting to refresh...');
      const refreshedBroadcaster = await refreshToken(
        process.env.TWITCH_BROADCASTER_ACCESS_TOKEN,
        process.env.TWITCH_BROADCASTER_REFRESH_TOKEN,
        'broadcaster'
      );
      if (refreshedBroadcaster) {
        process.env.TWITCH_BROADCASTER_ACCESS_TOKEN = refreshedBroadcaster.accessToken;
        process.env.TWITCH_BROADCASTER_REFRESH_TOKEN = refreshedBroadcaster.refreshToken;
        // Re-validate immediately to populate fresh expiresAt and scopes in cache
        await validateTokenCached(process.env.TWITCH_BROADCASTER_ACCESS_TOKEN, 'broadcaster');
        console.log('✓ Broadcaster token refreshed successfully');
        tokensUpdated = true;
      } else {
        console.warn('⚠️  Failed to refresh broadcaster token. EventSub features will be disabled.');
        console.warn('Visit http://localhost:3000 to generate new broadcaster tokens.');
      }
    } else {
      console.log('✓ Broadcaster token is valid');
    }
  }
  
  // If tokens were updated, recreate auth provider and clients
  if (tokensUpdated) {
    console.log('Recreating auth provider with refreshed tokens...');
    await recreateAuthProvider();
  }

  // Schedule next proactive refresh based on known expiry time
  scheduleProactiveTokenRefresh();

  console.log('');
}

// Recreate API clients with updated tokens
async function recreateAuthProvider() {
  // Update API client token
  global.apiClient.setAccessToken(config.accessToken);

  // Update chat client token (will reconnect if needed)
  try {
    await global.chatClient.updateToken(config.accessToken);
  } catch (error) {
    console.error('Failed to update chat client token:', error.message);
    throw error;
  }

  // Update bot EventSub client token if it exists
  if (eventSub) {
    try {
      eventSub.setAccessToken(config.accessToken);
      console.log('Bot EventSub client token updated');
    } catch (error) {
      console.error('Failed to update bot EventSub token:', error.message);
    }
  }

  // Update broadcaster API client if broadcaster token exists
  if (process.env.TWITCH_BROADCASTER_ACCESS_TOKEN) {
    if (broadcasterApiClient) {
      broadcasterApiClient.setAccessToken(process.env.TWITCH_BROADCASTER_ACCESS_TOKEN);
    } else {
      broadcasterApiClient = new TwitchHelixAPI({
        clientId: config.clientId,
        accessToken: process.env.TWITCH_BROADCASTER_ACCESS_TOKEN
      });
    }
    console.log('Broadcaster API client recreated with new tokens');

    // Update broadcaster EventSub client token if it exists
    if (broadcasterEventSub) {
      try {
        broadcasterEventSub.setAccessToken(process.env.TWITCH_BROADCASTER_ACCESS_TOKEN);
        console.log('Broadcaster EventSub client token updated');
      } catch (error) {
        console.error('Failed to update broadcaster EventSub token:', error.message);
      }
    }
  }

  console.log('API clients recreated with new tokens');
}

// Schedule a proactive token refresh before the token(s) expire.
// Covers both bot and broadcaster tokens; fires at whichever expires soonest.
function scheduleProactiveTokenRefresh() {
  // Clear any existing scheduled refresh
  if (tokenRefreshTimer) {
    clearTimeout(tokenRefreshTimer);
    tokenRefreshTimer = null;
  }

  const now = Date.now();
  const botExpiresAt = cachedTokenValidation.bot.expiresAt;
  const broadcasterExpiresAt = cachedTokenValidation.broadcaster.expiresAt;

  // Pick the soonest non-zero expiry across both tokens
  const candidates = [botExpiresAt, broadcasterExpiresAt].filter(t => t > now);
  if (candidates.length === 0) {
    return;
  }
  const nextExpiresAt = Math.min(...candidates);

  // Fire TOKEN_EXPIRY_LEAD_MS before the soonest expiry
  const msUntilRefresh = Math.max(0, nextExpiresAt - now - TOKEN_EXPIRY_LEAD_MS);
  const minutesUntilRefresh = Math.round(msUntilRefresh / 60000);

  console.log(`Token refresh scheduled in ~${minutesUntilRefresh} minute(s)`);

  tokenRefreshTimer = setTimeout(async () => {
    tokenRefreshTimer = null;
    if (tokenRefreshInProgress) return;
    tokenRefreshInProgress = true;
    console.log('\nProactively refreshing tokens before expiry...');
    try {
      // Force revalidation by clearing the cache
      cachedTokenValidation.bot.lastCheck = 0;
      if (process.env.TWITCH_BROADCASTER_ACCESS_TOKEN) {
        cachedTokenValidation.broadcaster.lastCheck = 0;
      }
      await validateAndRefreshTokens();
    } catch (err) {
      console.error('Proactive token refresh failed:', err.message);
      // Retry in 2 minutes so we still get a fresh token before full expiry
      console.log('Scheduling retry in 2 minutes...');
      if (tokenRefreshTimer) {
        clearTimeout(tokenRefreshTimer);
        tokenRefreshTimer = null;
      }
      tokenRefreshTimer = setTimeout(async () => {
        tokenRefreshTimer = null;
        try {
          cachedTokenValidation.bot.lastCheck = 0;
          if (process.env.TWITCH_BROADCASTER_ACCESS_TOKEN) {
            cachedTokenValidation.broadcaster.lastCheck = 0;
          }
          await validateAndRefreshTokens();
        } catch (retryErr) {
          console.error('Proactive token refresh retry also failed:', retryErr.message);
        } finally {
          tokenRefreshInProgress = false;
        }
      }, 2 * 60 * 1000);
      return;
    } finally {
      if (!tokenRefreshTimer) tokenRefreshInProgress = false;
    }
  }, msUntilRefresh);
}


// Validate a token with Twitch
// Check if a scope exists in the given scope list (cached)
function hasScope(scopeList, targetScope) {
  const scopes = scopeList || [];
  return scopes.includes(targetScope);
}

// Check multiple scopes at once (cached)
function hasScopeList(scopeList, targetScopes) {
  const scopes = new Set(scopeList || []);
  return targetScopes.every(s => scopes.has(s));
}

// Validate token with caching (avoid repeated HTTP calls)
async function validateTokenCached(token, accountType = 'bot') {
  const now = Date.now();
  const cache = cachedTokenValidation[accountType];

  // Return cached result if still fresh and token won't expire within the lead window
  if (cache.lastCheck > 0 && now - cache.lastCheck < TOKEN_CACHE_DURATION && cache.expiresAt > now + TOKEN_EXPIRY_LEAD_MS) {
    return cache.isValid;
  }

  try {
    const response = await apiClient_axios.get(TWITCH_VALIDATE_URL, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    const tokenInfo = response.data;
    const expiresIn = tokenInfo.expires_in;

    cache.lastCheck = now;
    cache.expiresAt = now + (expiresIn * 1000);
    // Store the live scopes returned by Twitch so runtime checks reflect actual permissions
    cache.scopes = tokenInfo.scopes || [];

    if (expiresIn * 1000 < TOKEN_EXPIRY_LEAD_MS) {
      console.log(`  Token expires in ${Math.floor(expiresIn / 60)} minutes`);
      cache.isValid = false;
      return false;
    }

    cache.isValid = true;
    return true;
  } catch (error) {
    cache.lastCheck = now;
    cache.isValid = false;

    if (error.response?.status === 401) {
      return false;
    }
    console.error('Error validating token:', error.message);
    return false;
  }
}

// Keep old function for backwards compatibility
async function validateToken(token) {
  return validateTokenCached(token, 'bot');
}

// Refresh a token
async function refreshToken(accessToken, refreshToken, accountType) {
  try {
    if (!refreshToken) {
      console.log(`  No refresh token available for ${accountType} account`);
      return null;
    }

    const response = await apiClient_axios.post(TWITCH_TOKEN_URL, null, {
      params: {
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      }
    });

    const newAccessToken = response.data.access_token;
    const newRefreshToken = response.data.refresh_token;

    // Update .env file with new tokens using a file write lock to prevent race conditions
    await withCrossProcessLock('.env', async () => {
      try {
        let envContent = fs.readFileSync('.env', 'utf8');

        if (accountType === 'bot') {
          envContent = envContent.replace(
            /TWITCH_ACCESS_TOKEN=.*/,
            `TWITCH_ACCESS_TOKEN=${newAccessToken}`
          );
          envContent = envContent.replace(
            /TWITCH_REFRESH_TOKEN=.*/,
            `TWITCH_REFRESH_TOKEN=${newRefreshToken}`
          );
        } else {
          envContent = envContent.replace(
            /TWITCH_BROADCASTER_ACCESS_TOKEN=.*/,
            `TWITCH_BROADCASTER_ACCESS_TOKEN=${newAccessToken}`
          );
          envContent = envContent.replace(
            /TWITCH_BROADCASTER_REFRESH_TOKEN=.*/,
            `TWITCH_BROADCASTER_REFRESH_TOKEN=${newRefreshToken}`
          );
        }

        fs.writeFileSync('.env', envContent);
        console.log(`  Updated ${accountType} tokens in .env`);
      } catch (err) {
        console.error(`Failed to update .env file for ${accountType} token:`, err.message);
        throw err;
      }
    });

    // Update process.env for both account types
    if (accountType === 'broadcaster') {
      process.env.TWITCH_BROADCASTER_ACCESS_TOKEN = newAccessToken;
      process.env.TWITCH_BROADCASTER_REFRESH_TOKEN = newRefreshToken;
    } else {
      process.env.TWITCH_ACCESS_TOKEN = newAccessToken;
      process.env.TWITCH_REFRESH_TOKEN = newRefreshToken;
    }

    return { accessToken: newAccessToken, refreshToken: newRefreshToken };
  } catch (error) {
    console.error(`Error refreshing ${accountType} token:`, error.message);
    return null;
  }
}

// Get broadcaster ID
async function init() {
  try {
    console.log(`Initializing... (broadcaster: ${config.broadcasterName})`);

    // Parallelize API calls for faster initialization
    let [tokenInfo, user] = await Promise.all([
      apiClient.getTokenInfo(),
      apiClient.getUserByName(config.broadcasterName)
    ]);

    // Token may be expired at startup — try refreshing once before giving up
    if (!tokenInfo) {
      console.log('⚠️  Bot token appears expired at startup. Attempting to refresh...');
      const refreshed = await refreshToken(config.accessToken, config.refreshToken, 'bot');
      if (refreshed) {
        config.accessToken = refreshed.accessToken;
        config.refreshToken = refreshed.refreshToken;
        apiClient.setAccessToken(config.accessToken);
        await chatClient.updateToken(config.accessToken);
        tokenInfo = await apiClient.getTokenInfo();
        console.log('✓ Bot token refreshed successfully at startup');
      }
    }

    tokenUserId = tokenInfo?.userId || null;
    if (!tokenUserId) {
      throw new Error('OAuth token missing userId; ensure the token is tied to a user account.');
    }

    if (!user) {
      throw new Error(`Broadcaster "${config.broadcasterName}" not found. Check your .env TWITCH_BROADCASTER_NAME`);
    }

    const tokenUser = await apiClient.getUserById(tokenUserId);

    broadcasterId = String(user.id);
    broadcasterUserId = String(user.id);
    if (!/^\d+$/.test(broadcasterId)) {
      throw new Error(`Resolved broadcasterId is non-numeric: ${broadcasterId}`);
    }
    console.log(`Got broadcaster ID: ${broadcasterId}`);
    console.log(`Token user ID: ${tokenUserId} (${tokenUser?.name || tokenUser?.login || 'unknown'})`);
    console.log(`Ensure ${tokenUser?.name || tokenUser?.login || tokenUserId} is a moderator in the channel!`);

    // Load built-in command configuration
    await loadBuiltinCommands();

    // Update dashboard
    updateDashboard();
    initComplete = true;
    await setupEventSub();
    await setupBroadcasterEventSub();
    startAnnouncements();
  } catch (error) {
    console.error('Failed to initialize bot:', error.message);
    broadcasterId = null;
    initComplete = true;
  }
}

// Create a clip
async function createClip() {
  try {
    if (!initComplete) {
      return { success: false, error: 'Bot is still initializing. Please try again in a moment.' };
    }

    if (!broadcasterId) {
      return { success: false, error: 'Bot not initialized. Broadcaster ID is missing. Restart the bot.' };
    }

    // Check if required scope is present (cached)
    if (!hasScope(config.scopes, 'clips:edit')) {
      console.error('Missing required scope: clips:edit');
      return { success: false, error: 'Missing clips:edit scope. Please re-authorize with the token generator.' };
    }

    // Ensure broadcasterId is a string
    const channelId = String(broadcasterId);
    console.log('[DEBUG] Calling create clip via Helix API. channelId:', channelId, 'scopes:', config.scopes);

    // Call Twitch Helix API directly to avoid extractUserId issues in Twurple clips API
    const response = await apiClient_axios.post(
      'https://api.twitch.tv/helix/clips',
      { broadcaster_id: channelId },
      {
        headers: getApiHeaders()
      }
    );

    const clipId = response.data?.data?.[0]?.id;
    if (!clipId) {
      console.error('[DEBUG] Clip API returned no clip ID. Response:', response.data);
      return { success: false, error: 'Clip API returned no clip ID' };
    }

    const clipUrl = `https://clips.twitch.tv/${clipId}`;
    console.log('[DEBUG] Clip created successfully. ID:', clipId, 'URL:', clipUrl);
    return { success: true, url: clipUrl };
  } catch (error) {
    console.error('Failed to create clip:', error?.response?.data || error);
    const errorMsg = (error?.response?.data?.message) || error.message || error.toString();
    return { success: false, error: errorMsg };
  }
}

// Get follow age
async function getFollowAge(username) {
  try {
    const user = await apiClient.getUserByName(username);
    if (!user) return { success: false, error: 'User not found' };

    // getChannelFollowers returns a paginated result with a 'data' property
    const followsResult = await apiClient.getChannelFollowers(broadcasterId, user.id);
    const follows = followsResult?.data || [];

    if (!follows || follows.length === 0) {
      return { success: false, message: 'Not following' };
    }

    // Debug log to check the follower data structure
    console.log('[DEBUG] Follower data:', follows[0]);

    const followedAt = new Date(follows[0].followDate || follows[0].followedAt);
    if (isNaN(followedAt.getTime())) {
      console.error('[DEBUG] Invalid followedAt date:', follows[0]);
      return { success: false, error: 'Invalid follow date' };
    }

    const now = new Date();
    const diff = now - followedAt;

    const years = Math.floor(diff / (1000 * 60 * 60 * 24 * 365.25));
    const months = Math.floor((diff % (1000 * 60 * 60 * 24 * 365.25)) / (1000 * 60 * 60 * 24 * 30.44));
    const days = Math.floor((diff % (1000 * 60 * 60 * 24 * 30.44)) / (1000 * 60 * 60 * 24));

    let ageStr = '';
    if (years > 0) ageStr += `${years} year${years > 1 ? 's' : ''} `;
    if (months > 0) ageStr += `${months} month${months > 1 ? 's' : ''} `;
    if (days > 0 || ageStr === '') ageStr += `${days} day${days !== 1 ? 's' : ''}`;

    return { success: true, message: `Following for ${ageStr.trim()}` };
  } catch (error) {
    console.error('Failed to get follow age:', error.message);
    return { success: false, error: error.message };
  }
}

// Send shoutout
async function sendShoutout(targetUsername) {
  try {
    const user = await apiClient.getUserByName(targetUsername);
    if (!user) return { success: false, error: 'User not found' };

    if (!tokenUserId) {
      return { success: false, error: 'Bot token missing user context; restart after re-auth.' };
    }

    // Get the user's channel information to find last played game
    const channelInfo = await apiClient.getChannelInfo(user.id);
    const gameName = channelInfo?.gameName || 'something awesome';

    // Check if the target user is live
    const streamInfo = await apiClient.getStreamByUserId(user.id);
    const isLive = streamInfo !== null;

    if (isLive) {
      // Send the shoutout via API if they're live
      const shoutoutResult = await apiClient.sendShoutout(broadcasterId, user.id, tokenUserId);
      if (!shoutoutResult.success) {
        console.warn('Shoutout API failed:', shoutoutResult.error);
        // Continue anyway - we'll still send the chat message
      }
    }

    return {
      success: true,
      message: `Shoutout to ${user.displayName}! Check out their channel: https://twitch.tv/${user.name || user.login} - They're playing ${gameName}${isLive ? ' - go follow them!' : ''}`,
      username: user.displayName,
      gameName: gameName,
      isLive: isLive,
      channelUrl: `https://twitch.tv/${user.name || user.login}`
    };
  } catch (error) {
    console.error('Failed to send shoutout:', error.message);
    return { success: false, error: error.message };
  }
}

// Update stream title (mods/broadcaster only)
async function updateStreamTitle(newTitle) {
  try {
    if (!initComplete || !broadcasterId) {
      return { success: false, error: 'Bot not initialized yet. Try again shortly.' };
    }
    if (!hasScope(getBroadcasterScopes(), 'channel:manage:broadcast')) {
      return { success: false, error: 'Missing scope: channel:manage:broadcast. Re-authorize via the token generator.' };
    }
    const title = String(newTitle || '').trim();
    if (!title) {
      return { success: false, error: 'Title cannot be empty.' };
    }
    await axios.patch(
      `https://api.twitch.tv/helix/channels?broadcaster_id=${broadcasterId}`,
      { title },
      {
        headers: getBroadcasterApiHeaders()
      }
    );
    return { success: true, title };
  } catch (error) {
    const msg = (error?.response?.data?.message) || error.message || 'Unknown error';
    return { success: false, error: msg };
  }
}

// Update stream game/category (mods/broadcaster only)
async function updateStreamGame(gameName) {
  try {
    if (!initComplete || !broadcasterId) {
      return { success: false, error: 'Bot not initialized yet. Try again shortly.' };
    }
    if (!hasScope(getBroadcasterScopes(), 'channel:manage:broadcast')) {
      return { success: false, error: 'Missing scope: channel:manage:broadcast. Re-authorize via the token generator.' };
    }
    const name = String(gameName || '').trim();
    if (!name) {
      return { success: false, error: 'Game name cannot be empty.' };
    }

    // Resolve game ID by name via Helix API
    const headers = getBroadcasterApiHeaders();
    let gameId = null;
    let resolvedName = name;
    try {
      const resp = await axios.get('https://api.twitch.tv/helix/games', { params: { name }, headers });
      const game = resp.data?.data?.[0] || null;
      if (game) {
        gameId = game.id;
        resolvedName = game.name || name;
      }
    } catch {}

    // Fallback to search categories
    if (!gameId) {
      try {
        const resp = await axios.get('https://api.twitch.tv/helix/search/categories', { params: { query: name }, headers });
        const cat = resp.data?.data?.[0] || null;
        if (cat) {
          gameId = cat.id;
          resolvedName = cat.name || name;
        }
      } catch {}
    }

    if (!gameId) {
      return { success: false, error: `Could not find a game/category named "${name}".` };
    }

    await axios.patch(
      `https://api.twitch.tv/helix/channels?broadcaster_id=${broadcasterId}`,
      { game_id: gameId },
      {
        headers: getBroadcasterApiHeaders()
      }
    );
    return { success: true, gameId, gameName: resolvedName };
  } catch (error) {
    const msg = (error?.response?.data?.message) || error.message || 'Unknown error';
    return { success: false, error: msg };
  }
}

// Timeout a user for violating chat filters
async function timeoutUser(channel, username, durationSeconds) {
  try {
    if (!tokenUserId || !broadcasterId) return;
    if (!config.scopes.includes('moderator:manage:banned_users')) return;

    // Get user ID first
    const user = await apiClient.getUserByName(username);
    if (!user) return;

    // Use Helix API to timeout the user
    await apiClient.timeoutUser(broadcasterId, tokenUserId, user.id, durationSeconds);
  } catch (error) {
    console.error(`Failed to timeout ${username}:`, error.message);
  }
}

// Add word to blacklist filter
async function addFilterWord(word) {
  if (!word || word.trim().length === 0) return false;
  chatFilters.blacklistWords.add(word.trim().toLowerCase());
  invalidateFilterStatusCache();
  return true;
}

// Remove word from blacklist filter
async function removeFilterWord(word) {
  if (!word || word.trim().length === 0) return false;
  chatFilters.blacklistWords.delete(word.trim().toLowerCase());
  invalidateFilterStatusCache();
  return true;
}

// Get filter status with caching
function getFilterStatus() {
  const now = Date.now();
  
  // Return cached result if still valid
  if (filterStatusCache && (now - filterCacheTimestamp) < FILTER_CACHE_TTL) {
    return filterStatusCache;
  }
  
  // Regenerate cache
  filterStatusCache = {
    blacklistWords: Array.from(chatFilters.blacklistWords),
    filterUrls: chatFilters.filterUrls,
    filterAllCaps: chatFilters.filterAllCaps,
    filterRepeatChars: chatFilters.filterRepeatChars,
    filterSpam: chatFilters.filterSpam,
    timeoutDurationSeconds: chatFilters.timeoutDurationSeconds,
    filterAction: chatFilters.filterAction
  };
  filterCacheTimestamp = now;
  
  return filterStatusCache;
}

// Invalidate filter status cache
function invalidateFilterStatusCache() {
  filterStatusCache = null;
  filterCacheTimestamp = 0;
}

// ==================== COMMAND HANDLERS ====================

async function handleClip(channel, username) {
  if (!initComplete) {
    sendChatMessage(channel, '@' + username + ' Bot is still initializing. Please try again in a moment.');
    return;
  }
  // Use configurable cooldown from dashboard
  const cooldownSeconds = getCommandCooldown('!clip');
  if (isOnCooldown('clip', cooldownSeconds)) {
    const remainingMs = cooldownSeconds * 1000 - (Date.now() - (commandCooldowns.get('clip') || 0));
    const remainingSec = Math.max(1, Math.ceil(remainingMs / 1000));
    sendChatMessage(channel, `@${username} !clip is on cooldown. Try again in ${remainingSec}s.`);
    return;
  }
  const result = await createClip();
  if (!result.success) {
    sendChatMessage(channel, `@${username} Error: ${result.error || result.message}`);
    logCommandExecution(username, '!clip', [], 'failed');
  } else {
    sendChatMessage(channel, `@${username} Clip created! ${result.url}`);
    logCommandExecution(username, '!clip', [], 'success');
    setCooldown('clip');
  }
}

async function handleFollowage(channel, username, targetUser) {
  if (!targetUser) {
    sendChatMessage(channel, `@${username} Usage: !followage [username]`);
    return;
  }
  const result = await getFollowAge(targetUser);
  if (!result.success) {
    sendChatMessage(channel, `@${username} Error: ${result.error || result.message}`);
    logCommandExecution(username, '!followage', [targetUser], 'failed');
  } else {
    sendChatMessage(channel, `@${username} ${result.message}`);
    logCommandExecution(username, '!followage', [targetUser], 'success');
  }
}

async function handleShoutout(channel, username, targetUser) {
  if (!targetUser) {
    sendChatMessage(channel, `@${username} Usage: !shoutout [username]`);
    return;
  }
  const result = await sendShoutout(targetUser);
  if (!result.success) {
    sendChatMessage(channel, `@${username} Error: ${result.error || result.message}`);
    logCommandExecution(username, '!shoutout', [targetUser], 'failed');
  } else {
    sendChatMessage(channel, result.message);
    logCommandExecution(username, '!shoutout', [targetUser], 'success');
  }
}

async function handlePoll(channel, username, args) {
  try {
    if (!args[0]) {
      sendChatMessage(channel, `@${username} Usage: !poll start "Title" option1;option2;... [duration]`);
      return;
    }
    
    const action = args[0].toLowerCase();
    
    if (action === 'start') {
      // Parse: !poll start "Title" opt1;opt2;opt3 [duration]
      const rawMessage = args.slice(1).join(' ');
      const titleMatch = rawMessage.match(/^"([^"]+)"/);
      if (!titleMatch) {
        sendChatMessage(channel, `@${username} Poll title must be quoted: "Your Title"`);
        return;
      }
      
      const title = titleMatch[1];
      const rest = rawMessage.substring(titleMatch[0].length).trim();
      const parts = rest.split(/\s+/);
      const optionsStr = parts[0];
      const durationStr = parts[1];
      
      if (!optionsStr) {
        sendChatMessage(channel, `@${username} Provide options: option1;option2;...`);
        return;
      }
      
      const options = optionsStr.split(';').map(o => o.trim()).filter(Boolean);
      if (options.length < 2 || options.length > 5) {
        sendChatMessage(channel, `@${username} Polls require 2-5 options.`);
        return;
      }

      const parsedDuration = parseInt(durationStr, 10);
      const duration = Math.max(15, Math.min(1800,
        Number.isFinite(parsedDuration) ? parsedDuration : 300
      )); // 15s-30m, default 5m
      
      // Check scope against the broadcaster token's scopes (the token used for this call)
      if (!hasScope(getBroadcasterScopes(), 'channel:manage:polls')) {
        sendChatMessage(channel, `@${username} Missing scope: channel:manage:polls`);
        return;
      }

      if (!initComplete || !broadcasterId) {
        sendChatMessage(channel, `@${username} Bot not initialized yet.`);
        return;
      }

      // Create poll via Helix API (requires broadcaster token)
      const pollRes = await apiClient_axios.post(
        'https://api.twitch.tv/helix/polls',
        {
          broadcaster_id: broadcasterId,
          title,
          choices: options.map(o => ({ title: o })),
          duration,
          channel_points_voting: { is_enabled: false }
        },
        { headers: getBroadcasterApiHeaders() }
      );
      
      const poll = pollRes.data?.data?.[0];
      if (!poll) {
        sendChatMessage(channel, `@${username} Failed to create poll.`);
        logCommandExecution(username, '!poll start', [title], 'failed');
        return;
      }
      
      sendChatMessage(channel, `✓ Poll started: "${title}" (${duration}s) - Vote with reactions!`);
      logCommandExecution(username, '!poll start', [title, ...options], 'success');
    } else if (action === 'end') {
      // Parse: !poll end <pollId>
      const pollId = args[1];
      if (!pollId) {
        sendChatMessage(channel, `@${username} Usage: !poll end <poll_id>`);
        return;
      }
      
      if (!hasScope(getBroadcasterScopes(), 'channel:manage:polls')) {
        sendChatMessage(channel, `@${username} Missing scope: channel:manage:polls`);
        return;
      }

      if (!initComplete || !broadcasterId) {
        sendChatMessage(channel, `@${username} Bot not initialized yet.`);
        return;
      }

      // End poll via Helix API (requires broadcaster token)
      const endRes = await apiClient_axios.patch(
        `https://api.twitch.tv/helix/polls?broadcaster_id=${broadcasterId}&id=${pollId}`,
        { status: 'TERMINATED' },
        { headers: getBroadcasterApiHeaders() }
      );
      
      sendChatMessage(channel, `✓ Poll ended.`);
      logCommandExecution(username, '!poll end', [pollId], 'success');
    } else {
      sendChatMessage(channel, `@${username} Usage: !poll start "Title" options [duration] or !poll end <id>`);
    }
  } catch (error) {
    console.error('Poll command error:', error.message);
    sendChatMessage(channel, `@${username} Poll error: ${error?.response?.data?.message || error.message}`);
    logCommandExecution(username, '!poll', args, 'failed');
  }
}

async function handlePrediction(channel, username, args) {
  try {
    if (!args[0]) {
      sendChatMessage(channel, `@${username} Usage: !prediction start "Title" outcome1;outcome2 [duration]`);
      return;
    }
    
    const action = args[0].toLowerCase();
    
    if (action === 'start') {
      // Parse: !prediction start "Title" outcome1;outcome2 [duration]
      const rawMessage = args.slice(1).join(' ');
      const titleMatch = rawMessage.match(/^"([^"]+)"/);
      if (!titleMatch) {
        sendChatMessage(channel, `@${username} Prediction title must be quoted: "Your Title"`);
        return;
      }
      
      const title = titleMatch[1];
      const rest = rawMessage.substring(titleMatch[0].length).trim();
      const parts = rest.split(/\s+/);
      const outcomesStr = parts[0];
      const durationStr = parts[1];
      
      if (!outcomesStr) {
        sendChatMessage(channel, `@${username} Provide outcomes: outcome1;outcome2`);
        return;
      }
      
      const outcomes = outcomesStr.split(';').map(o => o.trim()).filter(Boolean);
      if (outcomes.length !== 2) {
        sendChatMessage(channel, `@${username} Predictions require exactly 2 outcomes.`);
        return;
      }

      const parsedDuration = parseInt(durationStr, 10);
      const duration = Math.max(60, Math.min(1800,
        Number.isFinite(parsedDuration) ? parsedDuration : 300
      )); // 1m-30m, default 5m
      
      // Check scope against the broadcaster token's scopes (the token used for this call)
      if (!hasScope(getBroadcasterScopes(), 'channel:manage:predictions')) {
        sendChatMessage(channel, `@${username} Missing scope: channel:manage:predictions`);
        return;
      }

      if (!initComplete || !broadcasterId) {
        sendChatMessage(channel, `@${username} Bot not initialized yet.`);
        return;
      }

      // Create prediction via Helix API (requires broadcaster token)
      const predRes = await apiClient_axios.post(
        'https://api.twitch.tv/helix/predictions',
        {
          broadcaster_id: broadcasterId,
          title,
          outcomes: outcomes.map(o => ({ title: o })),
          prediction_window: duration
        },
        { headers: getBroadcasterApiHeaders() }
      );
      
      const pred = predRes.data?.data?.[0];
      if (!pred) {
        sendChatMessage(channel, `@${username} Failed to create prediction.`);
        logCommandExecution(username, '!prediction start', [title], 'failed');
        return;
      }
      
      sendChatMessage(channel, `✓ Prediction started: "${title}" (${duration}s) - Viewers can place points!`);
      logCommandExecution(username, '!prediction start', [title, ...outcomes], 'success');
    } else if (action === 'resolve') {
      // Parse: !prediction resolve <predId> <winning_outcome_id>
      const predId = args[1];
      const winningId = args[2];
      
      if (!predId || !winningId) {
        sendChatMessage(channel, `@${username} Usage: !prediction resolve <id> <outcome_id>`);
        return;
      }
      
      if (!hasScope(getBroadcasterScopes(), 'channel:manage:predictions')) {
        sendChatMessage(channel, `@${username} Missing scope: channel:manage:predictions`);
        return;
      }

      if (!initComplete || !broadcasterId) {
        sendChatMessage(channel, `@${username} Bot not initialized yet.`);
        return;
      }

      // Resolve prediction via Helix API (requires broadcaster token)
      const resolveRes = await apiClient_axios.patch(
        `https://api.twitch.tv/helix/predictions?broadcaster_id=${broadcasterId}&id=${predId}`,
        { status: 'RESOLVED', winning_outcome_id: winningId },
        { headers: getBroadcasterApiHeaders() }
      );
      
      sendChatMessage(channel, `✓ Prediction resolved.`);
      logCommandExecution(username, '!prediction resolve', [predId, winningId], 'success');
    } else {
      sendChatMessage(channel, `@${username} Usage: !prediction start "Title" outcome1;outcome2 [duration] or !prediction resolve <id> <outcome_id>`);
    }
  } catch (error) {
    console.error('Prediction command error:', error.message);
    sendChatMessage(channel, `@${username} Prediction error: ${error?.response?.data?.message || error.message}`);
    logCommandExecution(username, '!prediction', args, 'failed');
  }
}

async function handleTitle(channel, username, newTitle) {
  if (!newTitle) {
    sendChatMessage(channel, 'Usage: !title "new title"');
    return;
  }
  const result = await updateStreamTitle(newTitle);
  if (!result.success) {
    sendChatMessage(channel, `Error: ${result.error || result.message}`);
    logCommandExecution(username, '!title', [newTitle], 'failed');
  } else {
    sendChatMessage(channel, `✓ Stream title updated to: "${newTitle}"`);
    logCommandExecution(username, '!title', [newTitle], 'success');
  }
}

async function handleGame(channel, username, gameQuery) {
  if (!gameQuery) {
    sendChatMessage(channel, 'Usage: !game <game name>');
    return;
  }
  const result = await updateStreamGame(gameQuery);
  if (!result.success) {
    sendChatMessage(channel, `Error: ${result.error || result.message}`);
    logCommandExecution(username, '!game', [gameQuery], 'failed');
  } else {
    sendChatMessage(channel, `✓ Game updated to: ${result.gameName}`);
    logCommandExecution(username, '!game', [gameQuery], 'success');
  }
}

// Cache for loyalty config (TTL: 5 minutes)
let loyaltyConfigCache = null;
let loyaltyConfigCacheTime = 0;
const LOYALTY_CONFIG_CACHE_TTL = 5 * 60 * 1000;

async function getLoyaltyConfig() {
  const now = Date.now();
  if (loyaltyConfigCache && (now - loyaltyConfigCacheTime) < LOYALTY_CONFIG_CACHE_TTL) {
    return loyaltyConfigCache;
  }
  try {
    const response = await apiClient_axios.get(`${dashboardBaseUrl}/api/loyalty/config`, { timeout: 3000 });
    loyaltyConfigCache = response.data;
    loyaltyConfigCacheTime = now;
    return loyaltyConfigCache;
  } catch {
    return { currencyNamePlural: 'points' };
  }
}

async function handleBalance(channel, username, args) {
  // Sanitize input: strip @ symbols, trim whitespace
  let targetUser = (args[0] || username).replace(/^@+/, '').trim();
  if (!targetUser) {
    sendChatMessage(channel, `@${username} Invalid username.`);
    return false; // Don't apply cooldown on invalid input
  }
  try {
    const encodedUser = encodeURIComponent(targetUser.toLowerCase());
    const response = await apiClient_axios.get(`${dashboardBaseUrl}/api/loyalty/user/${encodedUser}`, { timeout: 3000 });
    const userData = response.data;
    const config = await getLoyaltyConfig();
    const currencyName = config.currencyNamePlural || 'points';
    sendChatMessage(channel, `@${username} ${targetUser} has ${userData.points || 0} ${currencyName}${userData.rank ? ` (Rank: #${userData.rank})` : ''}`);
    logCommandExecution(username, '!balance', args, true);
    return true;
  } catch (error) {
    if (error.response?.status === 404) {
      sendChatMessage(channel, `@${username} User "${targetUser}" has no loyalty data yet.`);
    } else {
      sendChatMessage(channel, `@${username} Error: Could not fetch balance.`);
    }
    logCommandExecution(username, '!balance', args, false);
    return true; // Apply cooldown on API errors
  }
}

async function handleLeaderboard(channel, username) {
  try {
    const response = await apiClient_axios.get(`${dashboardBaseUrl}/api/loyalty/leaderboard?limit=5`, { timeout: 3000 });
    const leaderboard = response.data;
    if (leaderboard.length === 0) {
      sendChatMessage(channel, `No loyalty data available yet.`);
      logCommandExecution(username, '!leaderboard', [], false); // Log empty results as unsuccessful
      return;
    }
    const message = 'Top Loyalists: ' + leaderboard.map(u => `${u.rank}. ${u.username} (${u.points}pts)`).join(' | ');
    sendChatMessage(channel, message);
    logCommandExecution(username, '!leaderboard', [], true);
  } catch (error) {
    sendChatMessage(channel, `Error: Could not fetch leaderboard.`);
    logCommandExecution(username, '!leaderboard', [], false);
  }
}

async function handleQuote(channel, username) {
  try {
    const response = await apiClient_axios.get(`${dashboardBaseUrl}/api/quotes/random`, { timeout: 3000 });
    const quote = response.data;
    sendChatMessage(channel, `"${quote.text}" — ${quote.addedBy || 'Unknown'}${quote.game ? ` (${quote.game})` : ''}`);
    logCommandExecution(username, '!quote', [], true);
  } catch (error) {
    if (error.response?.status === 404) {
      sendChatMessage(channel, `No quotes available yet.`);
    } else {
      sendChatMessage(channel, `Error: Could not fetch quote.`);
    }
    logCommandExecution(username, '!quote', [], false);
  }
}

async function handleCounter(channel, username, args) {
  if (!args[0]) {
    sendChatMessage(channel, `@${username} Usage: !counter <name>`);
    return false; // Don't apply cooldown on invalid input
  }
  // Sanitize input: join all args (supports multi-word names), trim, and URL encode
  const counterName = args.join(' ').trim();
  if (!counterName) {
    sendChatMessage(channel, `@${username} Invalid counter name.`);
    return false; // Don't apply cooldown on invalid input
  }
  try {
    const encodedName = encodeURIComponent(counterName);
    const response = await apiClient_axios.get(`${dashboardBaseUrl}/api/counters/${encodedName}`, { timeout: 3000 });
    const counter = response.data;
    sendChatMessage(channel, `${counter.name}: ${counter.value}`);
    logCommandExecution(username, '!counter', args, true);
    return true;
  } catch (error) {
    if (error.response?.status === 404) {
      sendChatMessage(channel, `@${username} Counter "${counterName}" not found.`);
    } else {
      sendChatMessage(channel, `@${username} Error: Could not fetch counter.`);
    }
    logCommandExecution(username, '!counter', args, false);
    return true; // Apply cooldown on API errors
  }
}

// Fun commands: 8ball, dice, coinflip
const EIGHTBALL_ANSWERS = [
  'It is certain.', 'It is decidedly so.', 'Without a doubt.', 'Yes — definitely.', 'You may rely on it.',
  'As I see it, yes.', 'Most likely.', 'Outlook good.', 'Yes.', 'Signs point to yes.',
  'Reply hazy, try again.', 'Ask again later.', 'Better not tell you now.', 'Cannot predict now.', 'Concentrate and ask again.',
  "Don't count on it.", 'My reply is no.', 'My sources say no.', 'Outlook not so good.', 'Very doubtful.'
];

async function handle8ball(channel, username, args) {
  const question = args.join(' ').trim();
  const answer = EIGHTBALL_ANSWERS[Math.floor(Math.random() * EIGHTBALL_ANSWERS.length)];
  if (question) {
    sendChatMessage(channel, `@${username} ${answer}`);
  } else {
    sendChatMessage(channel, `@${username} Ask a question! Usage: !8ball <question>`);
  }
}

async function handleDice(channel, username, args) {
  let sides = 6;
  if (args[0]) {
    const n = parseInt(args[0], 10);
    if (Number.isNaN(n) || n < 2 || n > 1000) {
      sendChatMessage(channel, `@${username} Please choose a number of sides between 2 and 1000 (e.g. !dice 20).`);
      return;
    }
    sides = n;
  }
  const roll = Math.floor(Math.random() * sides) + 1;
  sendChatMessage(channel, `@${username} rolled a ${sides}-sided die and got ${roll}.`);
}

async function handleCoinflip(channel, username) {
  const result = Math.random() < 0.5 ? 'Heads' : 'Tails';
  sendChatMessage(channel, `@${username} flipped a coin and got ${result}.`);
}

async function handleGamba(channel, username, args) {
  const raw = (args[0] || '').toString().trim().toLowerCase();

  // Require explicit amount
  if (!raw) {
    sendChatMessage(channel, `@${username} Usage: !gamba <amount> or !gamba all — bet points (50% win = 2x, 50% lose).`);
    return false;
  }

  const amount = raw === 'all' ? 'all' : parseInt(raw, 10);

  // Validate numeric amounts
  if (raw !== 'all' && (Number.isNaN(amount) || amount < 1)) {
    sendChatMessage(channel, `@${username} Usage: !gamba <amount> or !gamba all — bet points (50% win = 2x, 50% lose).`);
    return false;
  }

  try {
    const response = await apiClient_axios.post(`${dashboardBaseUrl}/api/loyalty/gamba`, {
      username: username.toLowerCase(),
      amount: raw === 'all' ? 'all' : amount
    }, { timeout: 5000 });
    const data = response.data;
    const config = await getLoyaltyConfig();
    const currency = config.currencyNamePlural || 'points';
    if (data.won) {
      sendChatMessage(channel, `@${username} won ${data.winnings} ${currency}! New balance: ${data.newBalance}.`);
    } else {
      sendChatMessage(channel, `@${username} lost ${data.amountBet} ${currency}. New balance: ${data.newBalance}. Better luck next time!`);
    }
    logCommandExecution(username, '!gamba', args, true);
    return true;
  } catch (error) {
    const errMsg = error.response?.data?.error || error.message;
    sendChatMessage(channel, `@${username} ${errMsg}`);
    logCommandExecution(username, '!gamba', args, false);
    return true;
  }
}

async function handleDuel(channel, username, args) {
  const opponentRaw = (args[0] || '').replace(/^@+/, '').trim();
  const stakeRaw = args[1];
  if (!opponentRaw) {
    sendChatMessage(channel, `@${username} Usage: !duel @<user> [stake] — challenge someone (default stake 50 points).`);
    return false;
  }
  const challenger = username.toLowerCase();
  const opponent = opponentRaw.toLowerCase();
  if (challenger === opponent) {
    sendChatMessage(channel, `@${username} You cannot duel yourself.`);
    return false;
  }
  const stake = stakeRaw ? parseInt(stakeRaw, 10) : 50;
  const amount = Number.isFinite(stake) && stake >= 1 ? stake : 50;
  try {
    const response = await apiClient_axios.post(`${dashboardBaseUrl}/api/loyalty/duel`, {
      challenger,
      opponent,
      stake: amount
    }, { timeout: 5000 });
    const data = response.data;
    const config = await getLoyaltyConfig();
    const currency = config.currencyNamePlural || 'points';
    sendChatMessage(channel, `@${username} Duel! ${data.winner} wins ${amount * 2} ${currency}! ${challenger}: ${data.challengerBalance} | ${opponent}: ${data.opponentBalance}.`);
    logCommandExecution(username, '!duel', args, true);
    return true;
  } catch (error) {
    const errMsg = error.response?.data?.error || error.message;
    sendChatMessage(channel, `@${username} ${errMsg}`);
    logCommandExecution(username, '!duel', args, false);
    return true;
  }
}

// TTS configuration
const TTS_CONFIG = {
  MAX_LENGTH: 200,
  PER_USER_COOLDOWN_SEC: 30,
  GLOBAL_COOLDOWN_SEC: 10,
  CHANNEL_POINTS_REWARD_TITLE: 'TTS' // Default reward title to look for
};

async function handleTTS(channel, username, args, msg, isRedemption = false) {
  const text = args.join(' ').trim();

  // Normalize username to lowercase for consistent cooldown tracking
  const normalizedUsername = username.toLowerCase();

  // Validate text length
  if (!text) {
    if (!isRedemption) {
      sendChatMessage(channel, `@${username} Usage: !tts <message> (max ${TTS_CONFIG.MAX_LENGTH} characters)`);
    }
    return false; // Don't apply cooldown
  }

  if (text.length > TTS_CONFIG.MAX_LENGTH) {
    sendChatMessage(channel, `@${username} TTS message too long! Max ${TTS_CONFIG.MAX_LENGTH} characters (you used ${text.length}).`);
    return false; // Don't apply cooldown
  }

  // Apply content filtering (exempt mods and broadcaster, skip side effects)
  const isMod = msg?.userInfo?.isMod || false;
  const isBroadcaster = msg?.userInfo?.isBroadcaster || false;

  if (!isMod && !isBroadcaster) {
    // Check filters without updating message history (avoid spam detection side effects)
    const violations = checkChatFiltersWithoutSideEffects(text);
    if (violations.length > 0) {
      sendChatMessage(channel, `@${username} TTS message blocked: contains filtered content (${violations.join(', ')}).`);
      logCommandExecution(username, '!tts', args, false);
      return false; // Don't apply cooldown
    }
  }

  // Check global cooldown
  const now = Date.now();
  const timeSinceLastGlobalTTS = now - lastGlobalTTSTime;
  if (timeSinceLastGlobalTTS < TTS_CONFIG.GLOBAL_COOLDOWN_SEC * 1000) {
    const remainingSec = Math.max(1, Math.ceil((TTS_CONFIG.GLOBAL_COOLDOWN_SEC * 1000 - timeSinceLastGlobalTTS) / 1000));
    sendChatMessage(channel, `@${username} TTS is on global cooldown. Try again in ${remainingSec}s.`);
    return false; // Don't apply user cooldown
  }

  // Check per-user cooldown (unless it's a redemption)
  if (!isRedemption) {
    const lastUserTTS = ttsUserCooldowns.get(normalizedUsername) || 0;
    const timeSinceLastUserTTS = now - lastUserTTS;
    if (timeSinceLastUserTTS < TTS_CONFIG.PER_USER_COOLDOWN_SEC * 1000) {
      const remainingSec = Math.max(1, Math.ceil((TTS_CONFIG.PER_USER_COOLDOWN_SEC * 1000 - timeSinceLastUserTTS) / 1000));
      sendChatMessage(channel, `@${username} You're on TTS cooldown. Try again in ${remainingSec}s.`);
      return false;
    }
  }

  // Generate TTS audio via dashboard API (only if API provider is configured, not browser)
  let audioUrl = null;
  let useBrowserTTS = true;

  // Check TTS provider config - skip API call if using browser TTS
  const ttsProvider = process.env.TTS_PROVIDER || 'browser';
  const shouldUseAPI = ttsProvider !== 'browser';

  if (shouldUseAPI) {
    try {
      const ttsResponse = await apiClient_axios.post(`${dashboardBaseUrl}/api/tts/generate`, {
        text,
        voice: null, // Use default voice
        provider: null // Use configured provider
      }, { timeout: 30000 });

      if (ttsResponse.data.success && !ttsResponse.data.useBrowserTTS) {
        // API TTS generated successfully
        audioUrl = ttsResponse.data.audioUrl;
        useBrowserTTS = false;
      }
    } catch (err) {
      console.error('[TTS] Failed to generate API TTS:', err.message);
      // Fall back to browser TTS
    }
  }

  // Send TTS alert to OBS overlay
  sendAlert('tts', {
    user: username,
    message: text,
    timestamp: new Date().toISOString(),
    audioUrl, // URL to generated audio file (or null for browser TTS)
    useBrowserTTS, // Flag to indicate whether to use browser TTS
    config: {
      ttsEnabled: true,
      ttsTemplate: text,
      duration: 5000 + (text.length * 50) // Base 5s + 50ms per character
    }
  });

  // Log successful TTS
  logCommandExecution(username, '!tts', args, true);

  // Update cooldowns (use normalized username for consistency)
  lastGlobalTTSTime = now;
  ttsUserCooldowns.set(normalizedUsername, now);

  // Cleanup old user cooldowns (every 100 TTS calls)
  if (ttsUserCooldowns.size > 100) {
    const cutoffTime = now - (TTS_CONFIG.PER_USER_COOLDOWN_SEC * 1000 * 2);
    for (const [user, timestamp] of ttsUserCooldowns.entries()) {
      if (timestamp < cutoffTime) {
        ttsUserCooldowns.delete(user);
      }
    }
  }

  return true; // Successfully processed
}

// ==================== YOUTUBE API INTEGRATION ====================

// YouTube API configuration
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
const YOUTUBE_VIDEO_ENDPOINT = `${YOUTUBE_API_BASE}/videos`;
const YOUTUBE_SEARCH_ENDPOINT = `${YOUTUBE_API_BASE}/search`;

// YouTube metadata cache (TTL: 1 hour)
const youtubeMetadataCache = new Map();
const YOUTUBE_CACHE_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Extract video ID from YouTube URL or return the input if it's already an ID
 * @param {string} input - YouTube URL or video ID
 * @returns {string|null} - Video ID or null if invalid
 */
function extractVideoId(input) {
  if (!input) return null;

  // Already a video ID (11 characters, alphanumeric with - and _)
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) {
    return input;
  }

  // Standard URL: youtube.com/watch?v=VIDEO_ID
  const standardMatch = input.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (standardMatch) return standardMatch[1];

  // Short URL: youtu.be/VIDEO_ID
  const shortMatch = input.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (shortMatch) return shortMatch[1];

  // Embed URL: youtube.com/embed/VIDEO_ID
  const embedMatch = input.match(/youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/);
  if (embedMatch) return embedMatch[1];

  return null;
}

/**
 * Check if input is a YouTube URL
 * @param {string} input - URL to check
 * @returns {boolean}
 */
function isYouTubeUrl(input) {
  if (!input) return false;
  return /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//.test(input);
}

/**
 * Parse ISO 8601 duration to seconds
 * @param {string} duration - ISO 8601 duration (e.g., PT4M13S)
 * @returns {number} - Duration in seconds
 */
function parseIsoDuration(duration) {
  if (!duration) return 0;

  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;

  const hours = parseInt(match[1] || 0, 10);
  const minutes = parseInt(match[2] || 0, 10);
  const seconds = parseInt(match[3] || 0, 10);

  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Format seconds to HH:MM:SS or MM:SS
 * @param {number} seconds - Duration in seconds
 * @returns {string} - Formatted duration
 */
function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

/**
 * Fetch YouTube video metadata from API with caching
 * @param {string} videoId - YouTube video ID
 * @returns {Promise<Object|null>} - Video metadata or null if error
 */
async function getYouTubeMetadata(videoId) {
  if (!videoId) return null;
  if (!YOUTUBE_API_KEY) {
    console.error('YouTube API key not configured');
    return null;
  }

  // Check cache first
  const cached = youtubeMetadataCache.get(videoId);
  if (cached && Date.now() - cached.timestamp < YOUTUBE_CACHE_TTL) {
    return cached.data;
  }

  try {
    const response = await apiClient_axios.get(YOUTUBE_VIDEO_ENDPOINT, {
      params: {
        part: 'snippet,contentDetails',
        id: videoId,
        key: YOUTUBE_API_KEY
      }
    });

    if (!response.data.items || response.data.items.length === 0) {
      return null;
    }

    const video = response.data.items[0];
    const durationSeconds = parseIsoDuration(video.contentDetails.duration);
    const metadata = {
      videoId: video.id,
      title: video.snippet.title,
      channelTitle: video.snippet.channelTitle,
      channelId: video.snippet.channelId,
      durationSeconds,
      durationFormatted: formatDuration(durationSeconds),
      thumbnail: video.snippet.thumbnails.default.url
    };

    // Cache the result
    youtubeMetadataCache.set(videoId, {
      data: metadata,
      timestamp: Date.now()
    });

    return metadata;
  } catch (error) {
    console.error('Error fetching YouTube metadata:', error.message);
    if (error.response?.data?.error) {
      console.error('YouTube API error:', error.response.data.error.message);
    }
    return null;
  }
}

/**
 * Search YouTube for videos by query
 * @param {string} query - Search query
 * @param {number} maxResults - Maximum results to return (default: 1)
 * @returns {Promise<Array|null>} - Array of video IDs or null if error
 */
async function searchYouTube(query, maxResults = 1) {
  if (!query) return null;
  if (!YOUTUBE_API_KEY) {
    console.error('YouTube API key not configured');
    return null;
  }

  try {
    const response = await apiClient_axios.get(YOUTUBE_SEARCH_ENDPOINT, {
      params: {
        part: 'id',
        q: query,
        type: 'video',
        maxResults,
        key: YOUTUBE_API_KEY
      }
    });

    if (!response.data.items || response.data.items.length === 0) {
      return null;
    }

    return response.data.items.map(item => item.id.videoId);
  } catch (error) {
    console.error('Error searching YouTube:', error.message);
    if (error.response?.data?.error) {
      console.error('YouTube API error:', error.response.data.error.message);
    }
    return null;
  }
}

/**
 * Get song queue configuration from dashboard API
 * @returns {Promise<Object|null>} - Configuration object or null if error
 */
async function getSongQueueConfig() {
  try {
    const response = await apiClient_axios.get(`${dashboardBaseUrl}/api/song-queue/config`);
    return response.data;
  } catch (error) {
    console.error('Error fetching song queue config:', error.message);
    return null;
  }
}

/**
 * Add song to queue via dashboard API
 * @param {Object} songData - Song data to add
 * @returns {Promise<Object>} - Response with success status and message
 */
async function addSongToQueue(songData) {
  try {
    const response = await apiClient_axios.post(`${dashboardBaseUrl}/api/song-queue/add`, songData);
    return { success: true, ...response.data };
  } catch (error) {
    if (error.response?.data) {
      return { success: false, error: error.response.data.error || 'Failed to add song to queue' };
    }
    return { success: false, error: error.message };
  }
}

/**
 * Get current song queue from dashboard API
 * @returns {Promise<Object|null>} - Queue data or null on error
 */
async function getSongQueue() {
  try {
    const response = await apiClient_axios.get(`${dashboardBaseUrl}/api/song-queue`);
    return response.data;
  } catch (error) {
    console.error('Error fetching song queue:', error.message);
    return null;
  }
}

/**
 * Handle song request command (!sr / !songrequest)
 * @param {string} channel - Channel name
 * @param {string} username - Username of requester
 * @param {Object} msg - Full message object with userInfo
 * @param {Array} args - Command arguments
 * @returns {Promise<void>}
 */
async function handleSongRequest(channel, username, msg, args) {
  // Check if we have YouTube API key configured
  if (!YOUTUBE_API_KEY) {
    sendChatMessage(channel, `@${username} Song requests are not configured (missing YouTube API key).`);
    return;
  }

  // Check cooldown (30 seconds per user)
  const cooldownKey = `sr_${username.toLowerCase()}`;
  const cooldownSeconds = 30;
  if (isOnCooldown(cooldownKey, cooldownSeconds)) {
    const remainingMs = cooldownSeconds * 1000 - (Date.now() - (commandCooldowns.get(cooldownKey) || 0));
    const remainingSec = Math.max(1, Math.ceil(remainingMs / 1000));
    sendChatMessage(channel, `@${username} Song requests are on cooldown. Try again in ${remainingSec}s.`);
    return;
  }

  // Get the input (everything after the command)
  const input = args.join(' ').trim();
  if (!input) {
    sendChatMessage(channel, `@${username} Usage: !sr <YouTube URL or search query>`);
    return;
  }

  // Check if song requests are enabled before calling YouTube API (saves quota)
  const srConfig = await getSongQueueConfig();
  if (srConfig && srConfig.enabled === false) {
    sendChatMessage(channel, `@${username} Song requests are currently disabled.`);
    return;
  }

  let videoId = null;
  let metadata = null;

  // Check if input is a YouTube URL or search query
  if (isYouTubeUrl(input)) {
    // Extract video ID from URL
    videoId = extractVideoId(input);
    if (!videoId) {
      sendChatMessage(channel, `@${username} Invalid YouTube URL.`);
      return;
    }

    // Fetch metadata
    metadata = await getYouTubeMetadata(videoId);
    if (!metadata) {
      sendChatMessage(channel, `@${username} Could not fetch video information. Please try again.`);
      return;
    }
  } else {
    // Search YouTube for the query
    const searchResults = await searchYouTube(input, 1);
    if (!searchResults || searchResults.length === 0) {
      sendChatMessage(channel, `@${username} No results found for: "${input}"`);
      return;
    }

    videoId = searchResults[0];

    // Fetch metadata for the first result
    metadata = await getYouTubeMetadata(videoId);
    if (!metadata) {
      sendChatMessage(channel, `@${username} Could not fetch video information. Please try again.`);
      return;
    }
  }

  // Prepare song data
  const songData = {
    videoId: metadata.videoId,
    title: metadata.title,
    channelTitle: metadata.channelTitle,
    channelId: metadata.channelId,
    durationSeconds: metadata.durationSeconds,
    durationFormatted: metadata.durationFormatted,
    thumbnail: metadata.thumbnail,
    requester: username,
    requesterDisplayName: msg.userInfo.displayName || username,
    requesterIsSub: msg.userInfo.isSubscriber || false,
    requesterIsVip: msg.userInfo.isVip || false,
    requesterIsMod: msg.userInfo.isMod || false,
    requesterIsBroadcaster: msg.userInfo.isBroadcaster || false
  };

  // Add song to queue via dashboard API
  const result = await addSongToQueue(songData);

  if (!result.success) {
    sendChatMessage(channel, `@${username} ${result.error}`);
    logCommandExecution(username, '!sr', [input], 'failed');
    return;
  }

  // Success! Set cooldown and notify user
  setCooldown(cooldownKey);
  const position = result.position || '?';
  sendChatMessage(channel, `@${username} Added to queue (position ${position}): "${metadata.title}" [${metadata.durationFormatted}]`);
  logCommandExecution(username, '!sr', [input], 'success');
}

/**
 * Handle current song command (!song / !currentsong)
 * Shows the currently playing song (first in queue) and what's up next
 * @param {string} channel - Channel name
 * @param {string} username - Username who issued the command
 * @returns {Promise<void>}
 */
async function handleCurrentSong(channel, username) {
  // Check if we have YouTube API key configured
  if (!YOUTUBE_API_KEY) {
    sendChatMessage(channel, `@${username} Song requests are not configured.`);
    return;
  }

  const queueData = await getSongQueue();
  if (!queueData || !queueData.active) {
    sendChatMessage(channel, `@${username} Error fetching song queue.`);
    logCommandExecution(username, '!song', [], 'failed');
    return;
  }

  if (queueData.active.length === 0) {
    sendChatMessage(channel, `@${username} No songs in the queue.`);
    logCommandExecution(username, '!song', [], 'success');
    return;
  }

  const current = queueData.active[0];
  const currentMsg = `Now playing: "${current.title}" by ${current.channelTitle} [${current.durationFormatted}] (requested by @${current.requester})`;

  if (queueData.active.length > 1) {
    const next = queueData.active[1];
    sendChatMessage(channel, `${currentMsg} | Next up: "${next.title}" [${next.durationFormatted}]`);
  } else {
    sendChatMessage(channel, currentMsg);
  }

  logCommandExecution(username, '!song', [], 'success');
}

/**
 * Handle queue info command (!queue)
 * Shows queue statistics and next few songs
 * @param {string} channel - Channel name
 * @param {string} username - Username who issued the command
 * @returns {Promise<void>}
 */
async function handleQueueInfo(channel, username) {
  // Check if we have YouTube API key configured
  if (!YOUTUBE_API_KEY) {
    sendChatMessage(channel, `@${username} Song requests are not configured.`);
    return;
  }

  const queueData = await getSongQueue();
  if (!queueData || !queueData.active) {
    sendChatMessage(channel, `@${username} Error fetching song queue.`);
    logCommandExecution(username, '!queue', [], 'failed');
    return;
  }

  if (queueData.active.length === 0) {
    sendChatMessage(channel, `@${username} The queue is empty. Use !sr <URL or search query> to add a song!`);
    logCommandExecution(username, '!queue', [], 'success');
    return;
  }

  // Calculate total duration
  const totalSeconds = queueData.active.reduce((sum, song) => sum + (song.durationSeconds || 0), 0);
  const totalFormatted = formatDuration(totalSeconds);

  // Build message with queue stats
  const count = queueData.active.length;
  let message = `Queue: ${count} song${count !== 1 ? 's' : ''} (${totalFormatted} total)`;

  // Show next 3 songs (starting from position 2, after the current song)
  if (queueData.active.length > 1) {
    const nextSongs = queueData.active.slice(1, 4); // Get songs at positions 2, 3, 4
    message += ' | Up next: ';
    const songList = nextSongs.map((song, idx) =>
      `${idx + 2}. "${song.title}" [${song.durationFormatted}]`
    ).join(', ');
    message += songList;
  }

  sendChatMessage(channel, message);
  logCommandExecution(username, '!queue', [], 'success');
}

/**
 * Handle skip song command (!skip / !skipsong) - Moderator only
 * Removes the currently playing song (first in queue)
 * @param {string} channel - Channel name
 * @param {string} username - Username who issued the command
 * @param {Object} msg - Message object with user info
 * @returns {Promise<void>}
 */
async function handleSkipSong(channel, username, msg) {
  // Check if we have YouTube API key configured
  if (!YOUTUBE_API_KEY) {
    sendChatMessage(channel, `@${username} Song requests are not configured.`);
    return;
  }

  // Check mod permission
  if (!checkModPermission(msg, channel, username)) {
    sendChatMessage(channel, `@${username} Only moderators can skip songs.`);
    logCommandExecution(username, '!skip', [], 'failed');
    return;
  }

  try {
    // Call dashboard API to skip the current song
    const response = await apiClient_axios.post(
      `${dashboardBaseUrl}/api/song-queue/skip`,
      {},
      { timeout: 5000 }
    );

    if (response.data && response.data.success) {
      const skippedSong = response.data.skippedSong;
      if (skippedSong) {
        sendChatMessage(channel, `⏭️ Skipped: "${skippedSong.title}" by ${skippedSong.channelTitle}`);
      } else {
        sendChatMessage(channel, `@${username} No song to skip.`);
      }
      logCommandExecution(username, '!skip', [], 'success');
    } else {
      sendChatMessage(channel, `@${username} ${response.data?.error || 'Failed to skip song.'}`);
      logCommandExecution(username, '!skip', [], 'failed');
    }
  } catch (error) {
    console.error('Skip song error:', error.message);
    sendChatMessage(channel, `@${username} Error skipping song: ${error.message}`);
    logCommandExecution(username, '!skip', [], 'failed');
  }
}

/**
 * Handle remove song command (!removesong) - Moderator only
 * Removes a song by position (number) or by keyword (searches title/channel)
 * @param {string} channel - Channel name
 * @param {string} username - Username who issued the command
 * @param {Array<string>} args - Command arguments (position number or keyword)
 * @param {Object} msg - Message object with user info
 * @returns {Promise<void>}
 */
async function handleRemoveSong(channel, username, args, msg) {
  // Check if we have YouTube API key configured
  if (!YOUTUBE_API_KEY) {
    sendChatMessage(channel, `@${username} Song requests are not configured.`);
    return;
  }

  // Check mod permission
  if (!checkModPermission(msg, channel, username)) {
    sendChatMessage(channel, `@${username} Only moderators can remove songs.`);
    logCommandExecution(username, '!removesong', args, 'failed');
    return;
  }

  if (!args || args.length === 0) {
    sendChatMessage(channel, `@${username} Usage: !removesong <position or keyword>`);
    logCommandExecution(username, '!removesong', [], 'failed');
    return;
  }

  const target = args.join(' ');

  try {
    // Call dashboard API to remove the song
    const response = await apiClient_axios.delete(
      `${dashboardBaseUrl}/api/song-queue/${encodeURIComponent(target)}`,
      { timeout: 5000 }
    );

    if (response.data && response.data.success) {
      const removedSong = response.data.removedSong;
      if (removedSong) {
        sendChatMessage(channel, `🗑️ Removed: "${removedSong.title}" by ${removedSong.channelTitle} (requested by @${removedSong.requester})`);
      } else {
        sendChatMessage(channel, `@${username} No song found matching "${target}".`);
      }
      logCommandExecution(username, '!removesong', [target], 'success');
    } else {
      sendChatMessage(channel, `@${username} ${response.data?.error || 'Failed to remove song.'}`);
      logCommandExecution(username, '!removesong', [target], 'failed');
    }
  } catch (error) {
    console.error('Remove song error:', error.message);
    sendChatMessage(channel, `@${username} Error removing song: ${error.message}`);
    logCommandExecution(username, '!removesong', [target], 'failed');
  }
}

/**
 * Handle clear queue command (!clearqueue) - Moderator only
 * Clears all songs from the active queue
 * @param {string} channel - Channel name
 * @param {string} username - Username who issued the command
 * @param {Object} msg - Message object with user info
 * @returns {Promise<void>}
 */
async function handleClearQueue(channel, username, msg) {
  // Check if we have YouTube API key configured
  if (!YOUTUBE_API_KEY) {
    sendChatMessage(channel, `@${username} Song requests are not configured.`);
    return;
  }

  // Check mod permission
  if (!checkModPermission(msg, channel, username)) {
    sendChatMessage(channel, `@${username} Only moderators can clear the queue.`);
    logCommandExecution(username, '!clearqueue', [], 'failed');
    return;
  }

  try {
    // Call dashboard API to clear the queue
    const response = await apiClient_axios.post(
      `${dashboardBaseUrl}/api/song-queue/clear`,
      {},
      { timeout: 5000 }
    );

    if (response.data && response.data.success) {
      const count = response.data.clearedCount || 0;
      if (count > 0) {
        sendChatMessage(channel, `🗑️ Cleared ${count} song${count !== 1 ? 's' : ''} from the queue.`);
      } else {
        sendChatMessage(channel, `@${username} Queue is already empty.`);
      }
      logCommandExecution(username, '!clearqueue', [], 'success');
    } else {
      sendChatMessage(channel, `@${username} ${response.data?.error || 'Failed to clear queue.'}`);
      logCommandExecution(username, '!clearqueue', [], 'failed');
    }
  } catch (error) {
    console.error('Clear queue error:', error.message);
    sendChatMessage(channel, `@${username} Error clearing queue: ${error.message}`);
    logCommandExecution(username, '!clearqueue', [], 'failed');
  }
}

/**
 * Handle block song command (!blocksong) - Moderator only
 * Blocks a video, channel, or keyword from being requested
 * @param {string} channel - Channel name
 * @param {string} username - Username who issued the command
 * @param {Array<string>} args - Command arguments (URL, channel name, or keyword)
 * @returns {Promise<void>}
 */
async function handleBlockSong(channel, username, args) {
  // Check if we have YouTube API key configured
  if (!YOUTUBE_API_KEY) {
    sendChatMessage(channel, `@${username} Song requests are not configured.`);
    return;
  }

  if (!args || args.length === 0) {
    sendChatMessage(channel, `@${username} Usage: !blocksong <url|channel|keyword>`);
    logCommandExecution(username, '!blocksong', [], 'failed');
    return;
  }

  const input = args.join(' ');

  try {
    // Determine if input is a URL
    let blockType = 'keyword';
    let blockValue = input;

    if (isYouTubeUrl(input)) {
      // Check for channel URL first (youtube.com/channel/UC... or youtube.com/@handle)
      const channelMatch = input.match(/youtube\.com\/(?:channel\/(UC[\w-]+)|@([\w.-]+))/i);
      if (channelMatch) {
        blockType = 'channel';
        blockValue = channelMatch[1] || channelMatch[2]; // UC... ID or @handle
      } else {
        // Fall back to video ID extraction
        const videoId = extractVideoId(input);
        if (videoId) {
          blockType = 'video';
          blockValue = videoId;
        }
      }
    }

    // Call dashboard API to add to blocklist
    const response = await apiClient_axios.post(
      `${dashboardBaseUrl}/api/song-queue/block`,
      {
        type: blockType,
        value: blockValue
      },
      { timeout: 5000 }
    );

    if (response.data && response.data.success) {
      const { type, value, removedCount } = response.data;
      let message = '';

      if (type === 'video') {
        message = `🚫 Blocked video: ${value}`;
      } else if (type === 'channel') {
        message = `🚫 Blocked channel: ${value}`;
      } else {
        message = `🚫 Blocked keyword: "${value}"`;
      }

      if (removedCount > 0) {
        message += ` (removed ${removedCount} song${removedCount !== 1 ? 's' : ''} from queue)`;
      }

      sendChatMessage(channel, message);
      logCommandExecution(username, '!blocksong', [input], 'success');
    } else {
      sendChatMessage(channel, `@${username} ${response.data?.error || 'Failed to block.'}`);
      logCommandExecution(username, '!blocksong', [input], 'failed');
    }
  } catch (error) {
    console.error('Block song error:', error.message);
    sendChatMessage(channel, `@${username} Error blocking: ${error.message}`);
    logCommandExecution(username, '!blocksong', [input], 'failed');
  }
}

/**
 * Handle unblock song command (!unblocksong) - Moderator only
 * Removes a video, channel, or keyword from the blocklist
 * @param {string} channel - Channel name
 * @param {string} username - Username who issued the command
 * @param {Array<string>} args - Command arguments (video ID, channel ID, or keyword)
 * @returns {Promise<void>}
 */
async function handleUnblockSong(channel, username, args) {
  // Check if we have YouTube API key configured
  if (!YOUTUBE_API_KEY) {
    sendChatMessage(channel, `@${username} Song requests are not configured.`);
    return;
  }

  if (!args || args.length === 0) {
    sendChatMessage(channel, `@${username} Usage: !unblocksong <id|keyword>`);
    logCommandExecution(username, '!unblocksong', [], 'failed');
    return;
  }

  const identifier = args.join(' ');

  try {
    // Call dashboard API to remove from blocklist
    const response = await apiClient_axios.delete(
      `${dashboardBaseUrl}/api/song-queue/block/${encodeURIComponent(identifier)}`,
      { timeout: 5000 }
    );

    if (response.data && response.data.success) {
      const { type, value } = response.data;
      let message = '';

      if (type === 'video') {
        message = `✅ Unblocked video: ${value}`;
      } else if (type === 'channel') {
        message = `✅ Unblocked channel: ${value}`;
      } else {
        message = `✅ Unblocked keyword: "${value}"`;
      }

      sendChatMessage(channel, message);
      logCommandExecution(username, '!unblocksong', [identifier], 'success');
    } else {
      sendChatMessage(channel, `@${username} ${response.data?.error || 'Failed to unblock.'}`);
      logCommandExecution(username, '!unblocksong', [identifier], 'failed');
    }
  } catch (error) {
    console.error('Unblock song error:', error.message);
    sendChatMessage(channel, `@${username} Error unblocking: ${error.message}`);
    logCommandExecution(username, '!unblocksong', [identifier], 'failed');
  }
}

async function handleSongRequestConfig(channel, username, msg, args) {
  // Check if we have YouTube API key configured
  if (!YOUTUBE_API_KEY) {
    sendChatMessage(channel, `@${username} Song requests are not configured.`);
    return;
  }

  // Check mod permission
  if (!checkModPermission(msg, channel, username)) {
    sendChatMessage(channel, `@${username} Only moderators can configure song requests.`);
    logCommandExecution(username, '!sr config', args, 'failed');
    return;
  }

  // Parse: !sr config <setting> <value>
  if (args.length < 2) {
    sendChatMessage(channel, `@${username} Usage: !sr config <setting> <value> | Settings: enabled, cost, maxduration, maxperuser, duplicates, priority`);
    return;
  }

  const setting = args[0].toLowerCase();
  const valueStr = args.slice(1).join(' ');

  // Validate setting name and convert value
  const validSettings = {
    enabled: (val) => {
      const lower = val.toLowerCase();
      if (lower === 'on' || lower === 'true' || lower === 'yes' || lower === '1') return true;
      if (lower === 'off' || lower === 'false' || lower === 'no' || lower === '0') return false;
      throw new Error('Value must be on/off, true/false, yes/no, or 1/0');
    },
    cost: (val) => {
      if (!/^\d+$/.test(val)) throw new Error('Value must be a non-negative integer');
      const num = parseInt(val, 10);
      if (num < 0) throw new Error('Value must be a non-negative number');
      return num;
    },
    maxduration: (val) => {
      if (!/^\d+$/.test(val)) throw new Error('Value must be a positive integer (minutes)');
      const num = parseInt(val, 10);
      if (num < 1) throw new Error('Value must be a positive number (minutes)');
      return num * 60; // Convert minutes to seconds
    },
    maxperuser: (val) => {
      if (!/^\d+$/.test(val)) throw new Error('Value must be a positive integer');
      const num = parseInt(val, 10);
      if (num < 1) throw new Error('Value must be a positive number');
      return num;
    },
    duplicates: (val) => {
      const lower = val.toLowerCase();
      if (lower === 'on' || lower === 'true' || lower === 'yes' || lower === '1') return true;
      if (lower === 'off' || lower === 'false' || lower === 'no' || lower === '0') return false;
      throw new Error('Value must be on/off, true/false, yes/no, or 1/0');
    },
    priority: (val) => {
      const lower = val.toLowerCase();
      if (!['everyone', 'subs', 'vips'].includes(lower)) {
        throw new Error('Value must be everyone, subs, or vips');
      }
      return lower;
    }
  };

  if (!validSettings[setting]) {
    sendChatMessage(channel, `@${username} Invalid setting. Valid settings: enabled, cost, maxduration, maxperuser, duplicates, priority`);
    return;
  }

  try {
    // Convert and validate value
    const convertedValue = validSettings[setting](valueStr);

    // Build config update object
    const configUpdate = { [setting]: convertedValue };

    // Special handling for duplicates -> allowDuplicates
    if (setting === 'duplicates') {
      delete configUpdate.duplicates;
      configUpdate.allowDuplicates = convertedValue;
    }

    // Special handling for maxduration -> maxDuration
    if (setting === 'maxduration') {
      delete configUpdate.maxduration;
      configUpdate.maxDuration = convertedValue;
    }

    // Special handling for maxperuser -> maxPerUser
    if (setting === 'maxperuser') {
      delete configUpdate.maxperuser;
      configUpdate.maxPerUser = convertedValue;
    }

    // Call dashboard API to update config
    const response = await apiClient_axios.put(
      `${dashboardBaseUrl}/api/song-queue/config`,
      configUpdate,
      { timeout: 5000 }
    );

    if (response.data && response.data.success) {
      // Format user-friendly response
      let displayValue = convertedValue;
      if (setting === 'maxduration') {
        displayValue = `${Math.floor(convertedValue / 60)} minutes`;
      } else if (typeof convertedValue === 'boolean') {
        displayValue = convertedValue ? 'on' : 'off';
      }

      sendChatMessage(channel, `✓ Song request ${setting} set to: ${displayValue}`);
      logCommandExecution(username, '!sr config', args, 'success');
    } else {
      sendChatMessage(channel, `@${username} ${response.data?.error || 'Failed to update config.'}`);
      logCommandExecution(username, '!sr config', args, 'failed');
    }
  } catch (error) {
    console.error('Song request config error:', error.message);
    if (error.message.includes('must be')) {
      sendChatMessage(channel, `@${username} ${error.message}`);
    } else {
      sendChatMessage(channel, `@${username} Error updating config: ${error.message}`);
    }
    logCommandExecution(username, '!sr config', args, 'failed');
  }
}

async function handleCommands(channel) {
  sendChatMessage(channel, 'Commands: !commands | !clip | !followage [user] | !tts <message> | !sr <URL or query> | !song | !queue | !8ball | !dice [sides] | !coinflip | !balance [user] | !leaderboard | !gamba <amount|all> | !duel @user [stake] | !quote | !counter <name> | !hype | !shoutout [user] / !so [user] (mods) | !poll | !prediction | !title (mods) | !game (mods) | !addfilter (mods) | !removefilter (mods) | !filters (mods)');
}

function handleHype(channel, username, args, isMod) {
  const sub = (args[0] || '').toLowerCase();
  const cfg = getHypeConfig();

  if (sub === 'set' && args[1] != null && isMod) {
    const n = parseInt(args[1], 10);
    if (isNaN(n) || n < 5 || n > 200) {
      sendChatMessage(channel, `@${username} Usage: !hype set <5-200>. Threshold must be between 5 and 200 messages.`);
      return;
    }
    hypeConfig.minMessages = n;
    sendChatMessage(channel, `@${username} Hype now triggers at ${n} messages in ${cfg.windowSec}s.`);
    return;
  }
  if (sub === 'cooldown' && args[1] != null && isMod) {
    const n = parseInt(args[1], 10);
    if (isNaN(n) || n < 30 || n > 600) {
      sendChatMessage(channel, `@${username} Cooldown must be between 30 and 600 seconds.`);
      return;
    }
    hypeConfig.cooldownSec = n;
    sendChatMessage(channel, `@${username} Hype cooldown set to ${n}s.`);
    return;
  }
  if (sub === 'toggle' && isMod) {
    hypeConfig.enabled = !hypeConfig.enabled;
    sendChatMessage(channel, `@${username} Hype is now ${hypeConfig.enabled ? 'ON' : 'OFF'}.`);
    return;
  }

  const count = getHypeCount(channel);
  const threshold = cfg.minMessages;
  const status = hypeConfig.enabled ? `${count} messages in the last ${cfg.windowSec}s. Hype triggers at ${threshold}. (Cooldown: ${cfg.cooldownSec}s)` : 'Hype is currently disabled.';
  sendChatMessage(channel, `@${username} Chat energy: ${status}`);
}

async function handleCustomCommand(channel, username, displayName, command, args) {
  const cmd = customCommands.find(c => c.name.toLowerCase() === command);
  if (!cmd) {
    console.log(`Custom command not found: ${command} (${customCommands.length} command(s) available: ${customCommands.map(c => c.name).join(', ') || 'none'})`);
    return;
  }

  const { rendered, error } = await renderCustomCommand(cmd, {
    user: username,
    displayName: displayName || username,
    channel,
    target: args[0] || ''
  });
  
  if (error) {
    sendChatMessage(channel, `@${username} Error: ${error}`);
  } else if (rendered) {
    sendChatMessage(channel, rendered);
  }
}

// ==================== MESSAGE HANDLER ====================

// Command registry for cleaner routing and centralized permissions
const commandRegistry = new Map([
  ['!clip', { perm: 'everyone', handler: async ({ channel, username }) => {
    await handleClip(channel, username);
  }}],
  ['!followage', { perm: 'everyone', handler: async ({ channel, username, args }) => {
    const cooldownSeconds = getCommandCooldown('!followage');
    if (isOnCooldown('followage', cooldownSeconds)) {
      const remainingMs = cooldownSeconds * 1000 - (Date.now() - (commandCooldowns.get('followage') || 0));
      const remainingSec = Math.max(1, Math.ceil(remainingMs / 1000));
      sendChatMessage(channel, `@${username} !followage is on cooldown. Try again in ${remainingSec}s.`);
      return;
    }
    await handleFollowage(channel, username, args[0]);
    if (cooldownSeconds > 0) setCooldown('followage');
  }}],
  ['!8ball', { perm: 'everyone', handler: async ({ channel, username, args }) => {
    const cooldownSeconds = getCommandCooldown('!8ball');
    if (isOnCooldown('8ball', cooldownSeconds)) {
      const remainingMs = cooldownSeconds * 1000 - (Date.now() - (commandCooldowns.get('8ball') || 0));
      const remainingSec = Math.max(1, Math.ceil(remainingMs / 1000));
      sendChatMessage(channel, `@${username} !8ball is on cooldown. Try again in ${remainingSec}s.`);
      return;
    }
    await handle8ball(channel, username, args);
    if (cooldownSeconds > 0) setCooldown('8ball');
  }}],
  ['!dice', { perm: 'everyone', handler: async ({ channel, username, args }) => {
    const cooldownSeconds = getCommandCooldown('!dice');
    if (isOnCooldown('dice', cooldownSeconds)) {
      const remainingMs = cooldownSeconds * 1000 - (Date.now() - (commandCooldowns.get('dice') || 0));
      const remainingSec = Math.max(1, Math.ceil(remainingMs / 1000));
      sendChatMessage(channel, `@${username} !dice is on cooldown. Try again in ${remainingSec}s.`);
      return;
    }
    await handleDice(channel, username, args);
    if (cooldownSeconds > 0) setCooldown('dice');
  }}],
  ['!coinflip', { perm: 'everyone', handler: async ({ channel, username }) => {
    const cooldownSeconds = getCommandCooldown('!coinflip');
    if (isOnCooldown('coinflip', cooldownSeconds)) {
      const remainingMs = cooldownSeconds * 1000 - (Date.now() - (commandCooldowns.get('coinflip') || 0));
      const remainingSec = Math.max(1, Math.ceil(remainingMs / 1000));
      sendChatMessage(channel, `@${username} !coinflip is on cooldown. Try again in ${remainingSec}s.`);
      return;
    }
    await handleCoinflip(channel, username);
    if (cooldownSeconds > 0) setCooldown('coinflip');
  }}],
  ['!shoutout', { perm: 'mod', handler: async ({ channel, username, args }) => {
    const cooldownSeconds = getCommandCooldown('!shoutout');
    if (isOnCooldown('shoutout', cooldownSeconds)) {
      const remainingMs = cooldownSeconds * 1000 - (Date.now() - (commandCooldowns.get('shoutout') || 0));
      const remainingSec = Math.max(1, Math.ceil(remainingMs / 1000));
      sendChatMessage(channel, `@${username} !shoutout is on cooldown. Try again in ${remainingSec}s.`);
      return;
    }
    await handleShoutout(channel, username, args[0]);
    if (cooldownSeconds > 0) setCooldown('shoutout');
  }}],
  ['!so', { perm: 'mod', handler: async ({ channel, username, args }) => {
    const cooldownSeconds = getCommandCooldown('!shoutout');
    if (isOnCooldown('shoutout', cooldownSeconds)) {
      const remainingMs = cooldownSeconds * 1000 - (Date.now() - (commandCooldowns.get('shoutout') || 0));
      const remainingSec = Math.max(1, Math.ceil(remainingMs / 1000));
      sendChatMessage(channel, `@${username} !so is on cooldown. Try again in ${remainingSec}s.`);
      return;
    }
    await handleShoutout(channel, username, args[0]);
    if (cooldownSeconds > 0) setCooldown('shoutout');
  }}],
  ['!poll', { perm: 'mod', handler: async ({ channel, username, args }) => {
    const cooldownSeconds = getCommandCooldown('!poll');
    if (isOnCooldown('poll', cooldownSeconds)) {
      const remainingMs = cooldownSeconds * 1000 - (Date.now() - (commandCooldowns.get('poll') || 0));
      const remainingSec = Math.max(1, Math.ceil(remainingMs / 1000));
      sendChatMessage(channel, `@${username} !poll is on cooldown. Try again in ${remainingSec}s.`);
      return;
    }
    await handlePoll(channel, username, args);
    if (cooldownSeconds > 0) setCooldown('poll');
  }}],
  ['!prediction', { perm: 'mod', handler: async ({ channel, username, args }) => {
    const cooldownSeconds = getCommandCooldown('!prediction');
    if (isOnCooldown('prediction', cooldownSeconds)) {
      const remainingMs = cooldownSeconds * 1000 - (Date.now() - (commandCooldowns.get('prediction') || 0));
      const remainingSec = Math.max(1, Math.ceil(remainingMs / 1000));
      sendChatMessage(channel, `@${username} !prediction is on cooldown. Try again in ${remainingSec}s.`);
      return;
    }
    await handlePrediction(channel, username, args);
    if (cooldownSeconds > 0) setCooldown('prediction');
  }}],
  ['!title', { perm: 'mod', handler: async ({ channel, username, args }) => {
    const cooldownSeconds = getCommandCooldown('!title');
    if (isOnCooldown('title', cooldownSeconds)) {
      const remainingMs = cooldownSeconds * 1000 - (Date.now() - (commandCooldowns.get('title') || 0));
      const remainingSec = Math.max(1, Math.ceil(remainingMs / 1000));
      sendChatMessage(channel, `@${username} !title is on cooldown. Try again in ${remainingSec}s.`);
      return;
    }
    await handleTitle(channel, username, args.join(' '));
    if (cooldownSeconds > 0) setCooldown('title');
  }}],
  ['!game', { perm: 'mod', handler: async ({ channel, username, args }) => {
    const cooldownSeconds = getCommandCooldown('!game');
    if (isOnCooldown('game', cooldownSeconds)) {
      const remainingMs = cooldownSeconds * 1000 - (Date.now() - (commandCooldowns.get('game') || 0));
      const remainingSec = Math.max(1, Math.ceil(remainingMs / 1000));
      sendChatMessage(channel, `@${username} !game is on cooldown. Try again in ${remainingSec}s.`);
      return;
    }
    await handleGame(channel, username, args.join(' '));
    if (cooldownSeconds > 0) setCooldown('game');
  }}],
  ['!commands', { perm: 'everyone', handler: async ({ channel }) => {
    const cooldownSeconds = getCommandCooldown('!commands');
    if (isOnCooldown('commands', cooldownSeconds)) {
      return; // Silently fail on cooldown for !commands
    }
    await handleCommands(channel);
    if (cooldownSeconds > 0) setCooldown('commands');
  }}],
  ['!addfilter', { perm: 'mod', handler: async ({ channel, username, args }) => {
    if (!args[0]) {
      sendChatMessage(channel, `@${username} Usage: !addfilter <word>`);
      return;
    }
    await addFilterWord(args[0]);
    sendChatMessage(channel, `Word "${args[0]}" added to blacklist.`);
  }}],
  ['!removefilter', { perm: 'mod', handler: async ({ channel, username, args }) => {
    if (!args[0]) {
      sendChatMessage(channel, `@${username} Usage: !removefilter <word>`);
      return;
    }
    await removeFilterWord(args[0]);
    sendChatMessage(channel, `Word "${args[0]}" removed from blacklist.`);
  }}],
  ['!filters', { perm: 'mod', handler: async ({ channel }) => {
    sendChatMessage(channel, `Filters: ${JSON.stringify(getFilterStatus())}`);
  }}],
  ['!balance', { perm: 'everyone', handler: async ({ channel, username, args }) => {
    const cooldownSeconds = getCommandCooldown('!balance');
    if (isOnCooldown('balance', cooldownSeconds)) {
      const remainingMs = cooldownSeconds * 1000 - (Date.now() - (commandCooldowns.get('balance') || 0));
      const remainingSec = Math.max(1, Math.ceil(remainingMs / 1000));
      sendChatMessage(channel, `@${username} !balance is on cooldown. Try again in ${remainingSec}s.`);
      return;
    }
    const shouldCooldown = await handleBalance(channel, username, args);
    if (shouldCooldown && cooldownSeconds > 0) setCooldown('balance');
  }}],
  ['!leaderboard', { perm: 'everyone', handler: async ({ channel, username }) => {
    const cooldownSeconds = getCommandCooldown('!leaderboard');
    if (isOnCooldown('leaderboard', cooldownSeconds)) {
      const remainingMs = cooldownSeconds * 1000 - (Date.now() - (commandCooldowns.get('leaderboard') || 0));
      const remainingSec = Math.max(1, Math.ceil(remainingMs / 1000));
      sendChatMessage(channel, `@${username} !leaderboard is on cooldown. Try again in ${remainingSec}s.`);
      return;
    }
    await handleLeaderboard(channel, username);
    if (cooldownSeconds > 0) setCooldown('leaderboard');
  }}],
  ['!gamba', { perm: 'everyone', handler: async ({ channel, username, args }) => {
    const cooldownSeconds = getCommandCooldown('!gamba');
    if (isOnCooldown('gamba', cooldownSeconds)) {
      const remainingMs = cooldownSeconds * 1000 - (Date.now() - (commandCooldowns.get('gamba') || 0));
      const remainingSec = Math.max(1, Math.ceil(remainingMs / 1000));
      sendChatMessage(channel, `@${username} !gamba is on cooldown. Try again in ${remainingSec}s.`);
      return;
    }
    const shouldCooldown = await handleGamba(channel, username, args);
    if (shouldCooldown && cooldownSeconds > 0) setCooldown('gamba');
  }}],
  ['!duel', { perm: 'everyone', handler: async ({ channel, username, args, msg }) => {
    const cooldownSeconds = getCommandCooldown('!duel');
    if (isOnCooldown('duel', cooldownSeconds)) {
      const remainingMs = cooldownSeconds * 1000 - (Date.now() - (commandCooldowns.get('duel') || 0));
      const remainingSec = Math.max(1, Math.ceil(remainingMs / 1000));
      sendChatMessage(channel, `@${username} !duel is on cooldown. Try again in ${remainingSec}s.`);
      return;
    }
    const shouldCooldown = await handleDuel(channel, username, args);
    if (shouldCooldown && cooldownSeconds > 0) setCooldown('duel');
  }}],
  ['!quote', { perm: 'everyone', handler: async ({ channel, username }) => {
    const cooldownSeconds = getCommandCooldown('!quote');
    if (isOnCooldown('quote', cooldownSeconds)) {
      const remainingMs = cooldownSeconds * 1000 - (Date.now() - (commandCooldowns.get('quote') || 0));
      const remainingSec = Math.max(1, Math.ceil(remainingMs / 1000));
      sendChatMessage(channel, `@${username} !quote is on cooldown. Try again in ${remainingSec}s.`);
      return;
    }
    await handleQuote(channel, username);
    if (cooldownSeconds > 0) setCooldown('quote');
  }}],
  ['!counter', { perm: 'everyone', handler: async ({ channel, username, args }) => {
    const cooldownSeconds = getCommandCooldown('!counter');
    if (isOnCooldown('counter', cooldownSeconds)) {
      const remainingMs = cooldownSeconds * 1000 - (Date.now() - (commandCooldowns.get('counter') || 0));
      const remainingSec = Math.max(1, Math.ceil(remainingMs / 1000));
      sendChatMessage(channel, `@${username} !counter is on cooldown. Try again in ${remainingSec}s.`);
      return;
    }
    const shouldCooldown = await handleCounter(channel, username, args);
    if (shouldCooldown && cooldownSeconds > 0) setCooldown('counter');
  }}],
  ['!hype', { perm: 'everyone', handler: async ({ channel, username, args, msg }) => {
    const cooldownSeconds = getCommandCooldown('!hype');
    if (cooldownSeconds > 0 && !checkModPermission(msg, channel, username)) {
      if (isOnCooldown('hype', cooldownSeconds)) {
        const remainingMs = cooldownSeconds * 1000 - (Date.now() - (commandCooldowns.get('hype') || 0));
        const remainingSec = Math.max(1, Math.ceil(remainingMs / 1000));
        sendChatMessage(channel, `@${username} !hype is on cooldown. Try again in ${remainingSec}s.`);
        return;
      }
      setCooldown('hype');
    }
    handleHype(channel, username, args, checkModPermission(msg, channel, username));
  }}],
  ['!tts', { perm: 'everyone', handler: async ({ channel, username, args, msg }) => {
    await handleTTS(channel, username, args, msg, false);
  }}],
  ['!sr', { perm: 'everyone', handler: async ({ channel, username, args, msg }) => {
    // Check if this is a config command: !sr config <setting> <value>
    if (args.length > 0 && args[0].toLowerCase() === 'config') {
      await handleSongRequestConfig(channel, username, msg, args.slice(1));
    } else {
      await handleSongRequest(channel, username, msg, args);
    }
  }}],
  ['!songrequest', { perm: 'everyone', handler: async ({ channel, username, args, msg }) => {
    // Check if this is a config command: !songrequest config <setting> <value>
    if (args.length > 0 && args[0].toLowerCase() === 'config') {
      await handleSongRequestConfig(channel, username, msg, args.slice(1));
    } else {
      await handleSongRequest(channel, username, msg, args);
    }
  }}],
  ['!song', { perm: 'everyone', handler: async ({ channel, username }) => {
    const cooldownSeconds = getCommandCooldown('!song');
    if (isOnCooldown('song', cooldownSeconds)) {
      const remainingMs = cooldownSeconds * 1000 - (Date.now() - (commandCooldowns.get('song') || 0));
      const remainingSec = Math.max(1, Math.ceil(remainingMs / 1000));
      sendChatMessage(channel, `@${username} !song is on cooldown. Try again in ${remainingSec}s.`);
      return;
    }
    await handleCurrentSong(channel, username);
    if (cooldownSeconds > 0) setCooldown('song');
  }}],
  ['!currentsong', { perm: 'everyone', handler: async ({ channel, username }) => {
    const cooldownSeconds = getCommandCooldown('!currentsong');
    if (isOnCooldown('song', cooldownSeconds)) {
      const remainingMs = cooldownSeconds * 1000 - (Date.now() - (commandCooldowns.get('song') || 0));
      const remainingSec = Math.max(1, Math.ceil(remainingMs / 1000));
      sendChatMessage(channel, `@${username} !currentsong is on cooldown. Try again in ${remainingSec}s.`);
      return;
    }
    await handleCurrentSong(channel, username);
    if (cooldownSeconds > 0) setCooldown('song');
  }}],
  ['!queue', { perm: 'everyone', handler: async ({ channel, username }) => {
    const cooldownSeconds = getCommandCooldown('!queue');
    if (isOnCooldown('queue', cooldownSeconds)) {
      const remainingMs = cooldownSeconds * 1000 - (Date.now() - (commandCooldowns.get('queue') || 0));
      const remainingSec = Math.max(1, Math.ceil(remainingMs / 1000));
      sendChatMessage(channel, `@${username} !queue is on cooldown. Try again in ${remainingSec}s.`);
      return;
    }
    await handleQueueInfo(channel, username);
    if (cooldownSeconds > 0) setCooldown('queue');
  }}],
  ['!skip', { perm: 'mod', handler: async ({ channel, username, msg }) => {
    await handleSkipSong(channel, username, msg);
  }}],
  ['!skipsong', { perm: 'mod', handler: async ({ channel, username, msg }) => {
    await handleSkipSong(channel, username, msg);
  }}],
  ['!removesong', { perm: 'mod', handler: async ({ channel, username, args, msg }) => {
    await handleRemoveSong(channel, username, args, msg);
  }}],
  ['!clearqueue', { perm: 'mod', handler: async ({ channel, username, msg }) => {
    await handleClearQueue(channel, username, msg);
  }}],
  ['!blocksong', { perm: 'mod', handler: async ({ channel, username, args }) => {
    await handleBlockSong(channel, username, args);
  }}],
  ['!unblocksong', { perm: 'mod', handler: async ({ channel, username, args }) => {
    await handleUnblockSong(channel, username, args);
  }}],
  ['!reloadcommands', { perm: 'mod', handler: async ({ channel, username }) => {
    const prevCount = customCommands.length;
    customCommandsCache = null;  // Force fresh load
    customCommandsCacheTime = 0;
    await loadCustomCommands();
    sendChatMessage(channel, `@${username} Reloaded custom commands (${prevCount} → ${customCommands.length})`);
  }}]
]);

// Handle built-in and custom commands
async function handleChatCommand(channel, user, message, msg) {
  const username = msg.userInfo?.userName || msg.userInfo?.displayName || user || 'unknown';
  const text = message.trim().toLowerCase();
  const raw = message.trim();
  const parts = raw.split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);

  // Check permissions for restricted commands
  const isMod = msg.userInfo.isMod;
  const isBroadcaster = msg.userInfo.isBroadcaster;

  try {
    // Registry-based routing
    const displayName = msg.userInfo?.displayName || username;
    const entry = commandRegistry.get(command);
    if (entry) {
      if (entry.perm === 'mod' && !checkModPermission(msg, channel, username)) {
        sendChatMessage(channel, `@${username} Only moderators can use this command.`);
        return;
      }
      await entry.handler({ channel, username, displayName, raw, args, msg });
    } else {
      // Fallback to custom commands
      await handleCustomCommand(channel, username, displayName, command, args);
    }
  } catch (error) {
    console.error(`Error handling command ${command}:`, error.message);
  }
}

// Message handler - simplified with command dispatcher
chatClient.onMessage(async (channel, user, message, msg) => {
  try {
    const username = msg.userInfo?.userName || msg.userInfo?.displayName || user || 'unknown';
    const raw = message.trim();
    const isMod = msg.userInfo.isMod;
    const isBroadcaster = msg.userInfo.isBroadcaster;

    // Check chat filters (skip for moderators and broadcaster)
    if (!isMod && !isBroadcaster) {
      const violations = checkChatFilters(raw, username);
      if (violations.length > 0) {
        console.log(`Chat filter violation from ${username}: ${violations.join(', ')}`);
        if (chatFilters.filterAction === 'timeout') {
          await timeoutUser(channel, username, chatFilters.timeoutDurationSeconds);
          sendChatMessage(channel, `@${username} Your message violated chat rules and you have been timed out.`);
        } else if (chatFilters.filterAction === 'warn') {
          sendChatMessage(channel, `@${username} Your message violated chat rules. Please be respectful.`);
        } else if (chatFilters.filterAction === 'delete') {
          return; // Don't process message further
        }
      }
    }

    // Log chat to dashboard
    apiClient_axios.post(`${dashboardBaseUrl}/api/chat`, { channel, user: username, message }).catch(() => {});

    // Loyalty: award points for chat message (cooldown and config applied by dashboard)
    apiClient_axios.post(`${dashboardBaseUrl}/api/loyalty/award-message`, {
      username,
      isSubscriber: msg.userInfo?.isSubscriber ?? false,
      isVip: msg.userInfo?.isVip ?? false
    }, { timeout: 3000 }).catch(() => {});

    // Chat Hype: record message and trigger hype if threshold reached
    recordChatForHype(channel);
    tryTriggerHype(channel);

    // First-time chatter welcome (Twitch IRC tag first-msg; isFirst is on msg, not msg.userInfo)
    const isFirstChatter = msg.isFirst === true;
    if (isFirstChatter && (firstChatterConfig.welcomeEnabled || firstChatterConfig.alertEnabled)) {
      const displayName = msg.userInfo?.displayName || username;
      if (firstChatterConfig.welcomeEnabled && firstChatterConfig.welcomeMessage) {
        const welcomeText = firstChatterConfig.welcomeMessage.replace(/\{user\}/gi, displayName);
        sendChatMessage(channel, welcomeText);
      }
      if (firstChatterConfig.alertEnabled) {
        sendAlert('first_chatter', { user: displayName });
      }
    }

    // Check if message starts with a command or matches a custom command
    const firstWord = raw.split(/\s+/)[0].toLowerCase();
    const isBuiltin = firstWord.startsWith('!');
    const isCustom = customCommands.some(c => c.name.toLowerCase() === firstWord);

    if (isBuiltin || isCustom) {
      await handleChatCommand(channel, user, message, msg);
    }
  } catch (error) {
    console.error('Error in message handler:', error.message);
  }
});

// Restart watcher
const restartFlagPath = path.join(__dirname, 'dashboard', 'logs', 'restart.flag');

function watchForRestart() {
  if (fs.existsSync(restartFlagPath)) {
    console.log('🔄 Restart flag detected. Restarting bot...');
    try {
      fs.unlinkSync(restartFlagPath);
    } catch (e) {
      console.error('Failed to remove restart flag:', e.message);
    }
    process.exit(0);
  }
}
setInterval(watchForRestart, 5000);

// Start the bot
async function start() {
  console.log('Starting Twitch bot...');
  
  // Validate and refresh tokens before initializing
  await validateAndRefreshTokens();

  if (!broadcasterId) {
    await init();
    if (!broadcasterId) {
      throw new Error('Failed to initialize broadcaster ID');
    }
  }

  await loadCustomCommands();
  
  // Periodic refresh logic
  const refreshCommands = async () => {
    try {
      // Re-read interval from env (in case it was updated via dashboard)
      CUSTOM_COMMANDS_CACHE_TTL = Number(process.env.COMMAND_REFRESH_INTERVAL || 60) * 1000;
      await loadCustomCommands();
    } catch (err) {
      console.error('Failed to refresh custom commands:', err.message);
    } finally {
      setTimeout(refreshCommands, CUSTOM_COMMANDS_CACHE_TTL);
    }
  };
  setTimeout(refreshCommands, CUSTOM_COMMANDS_CACHE_TTL);

  await chatClient.connect();

  console.log('✓ Connected to Twitch chat');
  console.log(`✓ Joined channels: ${config.channels.join(', ')}`);
  console.log('Bot is ready!');
}

chatClient.onConnect(() => {
  console.log('Chat client connected!');
});

chatClient.onDisconnect((manually, reason) => {
  console.log(`Disconnected: ${reason ? reason.message : 'Unknown reason'}`);
});

// Handle errors
process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
});

start().catch(console.error);