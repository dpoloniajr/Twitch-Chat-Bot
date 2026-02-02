// Replaced Twurple with direct Helix API, tmi.js for IRC, and native WebSocket for EventSub
const TwitchHelixAPI = require('./lib/twitch-helix-api');
const TwitchIRCClient = require('./lib/twitch-irc-client');
const TwitchEventSubWS = require('./lib/twitch-eventsub-ws');
const axios = require('axios');
const fs = require('fs');
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

// Global axios instance with consistent timeout
const apiClient_axios = axios.create({ timeout: API_TIMEOUT });

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
  bot: { lastCheck: 0, isValid: false, expiresAt: 0 },
  broadcaster: { lastCheck: 0, isValid: false, expiresAt: 0 }
};
const TOKEN_CACHE_DURATION = 3600000; // 1 hour

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

// Centralized scope validation with caching
function validateScopes(requiredScopes) {
  const scopeSet = new Set(config.scopes);
  return requiredScopes.every(scope => scopeSet.has(scope));
}

// Log command execution to dashboard
function logCommandExecution(username, command, args, result) {
  apiClient_axios.post(`${dashboardBaseUrl}/api/logs`, {
    timestamp: new Date().toISOString(),
    user: username,
    command,
    args: args.join(' '),
    result
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

// Announcement scheduler config
const ANNOUNCEMENT_INTERVAL_MS = Number(process.env.ANNOUNCEMENT_INTERVAL_MS || 900000); // default 15m
const ANNOUNCEMENTS = (process.env.ANNOUNCEMENTS || '').split('|').map(s => s.trim()).filter(Boolean);
let announcementTimer = null;

async function startAnnouncements() {
  if (!ANNOUNCEMENTS.length || ANNOUNCEMENT_INTERVAL_MS < 60000) return;
  if (announcementTimer) clearInterval(announcementTimer);
  let idx = 0;
  announcementTimer = setInterval(async () => {
    try {
      const msg = ANNOUNCEMENTS[idx % ANNOUNCEMENTS.length];
      idx++;
      for (const channel of config.channels) {
        // Use chat announcement if available, else regular say
        try {
          await apiClient.sendAnnouncement(broadcasterId, tokenUserId, msg, 'purple');
        } catch {
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

  // Check broadcaster token scopes
  const broadcasterScopes = (process.env.TWITCH_BROADCASTER_SCOPES || '').split(' ').filter(s => s);
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
          // Basic mapping: echo to chat
          config.channels.forEach(ch => sendChatMessage(ch, `${user} redeemed: ${reward}${input ? ' - ' + input : ''}`));

          // Log event and send alert to OBS overlay
          logEventSubEvent('redemption', { user, reward, message: input });
          sendAlert('redemption', { user, reward, message: input });
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
const CUSTOM_COMMANDS_CACHE_TTL = 60000; // 60 second cache TTL
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
  } catch (error) {
    // Use cached value if available, even if expired
    if (customCommandsCache !== null) {
      customCommands = customCommandsCache;
    } else {
      customCommands = [];
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
      cachedTokenValidation.bot.lastCheck = 0; // Clear cache to revalidate
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
        cachedTokenValidation.broadcaster.lastCheck = 0; // Clear cache to revalidate
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
  
  // Return cached result if still fresh
  if (cache.lastCheck > 0 && now - cache.lastCheck < TOKEN_CACHE_DURATION && cache.expiresAt > now + 1800000) {
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
    
    if (expiresIn < 3600) {
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

    // Also update process.env for broadcaster tokens
    if (accountType === 'broadcaster') {
      process.env.TWITCH_BROADCASTER_REFRESH_TOKEN = newRefreshToken;
    } else {
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
    const [tokenInfo, user] = await Promise.all([
      apiClient.getTokenInfo(),
      apiClient.getUserByName(config.broadcasterName)
    ]);

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
    if (!config.scopes.includes('channel:manage:broadcast')) {
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
        headers: getApiHeaders()
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
    if (!config.scopes.includes('channel:manage:broadcast')) {
      return { success: false, error: 'Missing scope: channel:manage:broadcast. Re-authorize via the token generator.' };
    }
    const name = String(gameName || '').trim();
    if (!name) {
      return { success: false, error: 'Game name cannot be empty.' };
    }

    // Resolve game ID by name via Helix API
    const headers = getApiHeaders();
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
        headers: getApiHeaders()
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
      
      // Check scope
      if (!hasScope(config.scopes, 'channel:manage:polls')) {
        sendChatMessage(channel, `@${username} Missing scope: channel:manage:polls`);
        return;
      }
      
      if (!initComplete || !broadcasterId) {
        sendChatMessage(channel, `@${username} Bot not initialized yet.`);
        return;
      }
      
      // Create poll via Helix API
      const pollRes = await apiClient_axios.post(
        'https://api.twitch.tv/helix/polls',
        {
          broadcaster_id: broadcasterId,
          title,
          choices: options.map(o => ({ title: o })),
          duration,
          channel_points_voting: { is_enabled: false }
        },
        { headers: getApiHeaders() }
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
      
      if (!hasScope(config.scopes, 'channel:manage:polls')) {
        sendChatMessage(channel, `@${username} Missing scope: channel:manage:polls`);
        return;
      }
      
      if (!initComplete || !broadcasterId) {
        sendChatMessage(channel, `@${username} Bot not initialized yet.`);
        return;
      }
      
      // End poll via Helix API
      const endRes = await apiClient_axios.patch(
        `https://api.twitch.tv/helix/polls?broadcaster_id=${broadcasterId}&id=${pollId}`,
        { status: 'TERMINATED' },
        { headers: getApiHeaders() }
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
      
      // Check scope
      if (!hasScope(config.scopes, 'channel:manage:predictions')) {
        sendChatMessage(channel, `@${username} Missing scope: channel:manage:predictions`);
        return;
      }
      
      if (!initComplete || !broadcasterId) {
        sendChatMessage(channel, `@${username} Bot not initialized yet.`);
        return;
      }
      
      // Create prediction via Helix API
      const predRes = await apiClient_axios.post(
        'https://api.twitch.tv/helix/predictions',
        {
          broadcaster_id: broadcasterId,
          title,
          outcomes: outcomes.map(o => ({ title: o })),
          prediction_window: duration
        },
        { headers: getApiHeaders() }
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
      
      if (!hasScope(config.scopes, 'channel:manage:predictions')) {
        sendChatMessage(channel, `@${username} Missing scope: channel:manage:predictions`);
        return;
      }
      
      if (!initComplete || !broadcasterId) {
        sendChatMessage(channel, `@${username} Bot not initialized yet.`);
        return;
      }
      
      // Resolve prediction via Helix API
      const resolveRes = await apiClient_axios.patch(
        `https://api.twitch.tv/helix/predictions?broadcaster_id=${broadcasterId}&id=${predId}`,
        { status: 'RESOLVED', winning_outcome_id: winningId },
        { headers: getApiHeaders() }
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

async function handleCommands(channel) {
  sendChatMessage(channel, 'Commands: !commands | !clip | !followage [user] | !shoutout [user] / !so [user] (mods) | !poll | !prediction | !title (mods) | !game (mods) | !addfilter (mods) | !removefilter (mods) | !filters (mods)');
}

async function handleCustomCommand(channel, username, displayName, command, args) {
  const cmd = customCommands.find(c => c.name.toLowerCase() === command);
  if (!cmd) return;

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
  setInterval(loadCustomCommands, 60000); // Load custom commands every 60s (with 60s cache TTL)

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