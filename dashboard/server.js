const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs').promises;
require('dotenv').config(path.join(__dirname, '..', '.env'));

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve OBS overlay files from the obs/ directory at root level
app.use('/obs', express.static(path.join(__dirname, '..', 'obs')));

// Paths for logs
const logsDir = path.join(__dirname, 'logs');
const commandLogsFile = path.join(logsDir, 'commands.json');
const userStatsFile = path.join(logsDir, 'stats.json');
const customCommandsFile = path.join(logsDir, 'customCommands.json');
const builtinCommandsFile = path.join(logsDir, 'builtinCommands.json');
const announcementsFile = path.join(logsDir, 'announcements.json');
const redemptionsFile = path.join(logsDir, 'redemptions.json');
const eventSubEventsFile = path.join(logsDir, 'eventsub-events.json');
const obsConfigFile = path.join(logsDir, 'obs-config.json');
const envPath = path.join(__dirname, '..', '.env');

// Helper to upsert a key in the .env file
async function upsertEnvValue(key, value) {
  const line = `${key}=${value}`;
  try {
    let envContent = '';
    try {
      envContent = await fs.readFile(envPath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    if (envContent) {
      const regex = new RegExp(`^${key}=.*$`, 'm');
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, line);
      } else {
        envContent = envContent.trimEnd();
        envContent += (envContent.endsWith('\n') ? '' : '\n') + line + '\n';
      }
    } else {
      envContent = line + '\n';
    }

    await fs.writeFile(envPath, envContent);
  } catch (error) {
    console.error(`Failed to update ${key} in .env:`, error);
    throw error;
  }
}

// Initialize logs directory
async function initLogs() {
  try {
    await fs.mkdir(logsDir, { recursive: true });

    // Initialize command logs
    try {
      await fs.access(commandLogsFile);
    } catch {
      await fs.writeFile(commandLogsFile, JSON.stringify([], null, 2));
    }

    // Initialize user stats
    try {
      await fs.access(userStatsFile);
    } catch {
      await fs.writeFile(userStatsFile, JSON.stringify({}, null, 2));
    }

    // Initialize custom commands
    try {
      await fs.access(customCommandsFile);
    } catch {
      await fs.writeFile(customCommandsFile, JSON.stringify([], null, 2));
    }

    // Initialize announcements
    try {
      await fs.access(announcementsFile);
    } catch {
      await fs.writeFile(announcementsFile, JSON.stringify([], null, 2));
    }

    // Initialize redemptions log
    try {
      await fs.access(redemptionsFile);
    } catch {
      await fs.writeFile(redemptionsFile, JSON.stringify([], null, 2));
    }

    // Initialize EventSub events log
    try {
      await fs.access(eventSubEventsFile);
    } catch {
      await fs.writeFile(eventSubEventsFile, JSON.stringify([], null, 2));
    }

    // Initialize OBS configuration
    try {
      await fs.access(obsConfigFile);
    } catch {
      await fs.writeFile(obsConfigFile, JSON.stringify({
        overlays: {
          alerts: { enabled: true, volume: 0.8, duration: 5 },
          recentEvents: { enabled: true, limit: 10, showTime: true },
          chatBox: { enabled: true, messageTimeout: 8, hideBot: false },
          goalBar: { enabled: true, type: 'follow', goal: 1000 }
        }
      }, null, 2));
    }

    // Initialize built-in commands configuration
    try {
      await fs.access(builtinCommandsFile);
    } catch {
      // Already created
    }
  } catch (error) {
    console.error('Failed to initialize logs:', error.message);
  }
}

// Bot state - will be updated by parent process
let botState = {
  isConnected: false,
  channels: [],
  broadcasterName: '',
  uptime: 0,
  commandsExecuted: 0,
  lastCommand: null,
  commands: [
    { name: '!clip', description: 'Create a clip of the stream' },
    { name: '!followage [username]', description: 'Check how long someone has been following' },
    { name: '!shoutout [username]', description: 'Shout out another streamer (mods only)' },
    { name: '!commands', description: 'Show available commands' }
  ]
};

// Chat filter state - will be synced with bot
let chatFilters = {
  blacklistWords: (process.env.CHAT_FILTER_WORDS || '').split('|').map(w => w.trim()).filter(Boolean),
  filterUrls: process.env.CHAT_FILTER_URLS === 'true' || process.env.CHAT_FILTER_URLS === '1',
  filterAllCaps: process.env.CHAT_FILTER_ALLCAPS === 'true' || process.env.CHAT_FILTER_ALLCAPS === '1',
  filterRepeatChars: process.env.CHAT_FILTER_REPEAT === 'true' || process.env.CHAT_FILTER_REPEAT === '1',
  filterSpam: process.env.CHAT_FILTER_SPAM === 'true' || process.env.CHAT_FILTER_SPAM === '1',
  timeoutDurationSeconds: Number(process.env.CHAT_FILTER_TIMEOUT_SEC || 60),
  filterAction: process.env.CHAT_FILTER_ACTION || 'warn'
};

// Broadcast state to all connected WebSocket clients
function broadcastState(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// REST API Endpoints

// Get bot status
app.get('/api/status', (req, res) => {
  res.json(botState);
});

// Get command logs
app.get('/api/logs', async (req, res) => {
  try {
    const data = await fs.readFile(commandLogsFile, 'utf8');
    res.json(JSON.parse(data));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add command log
app.post('/api/logs', async (req, res) => {
  try {
    const logs = JSON.parse(await fs.readFile(commandLogsFile, 'utf8'));
    const newLog = {
      timestamp: new Date().toISOString(),
      user: req.body.user,
      command: req.body.command,
      channel: req.body.channel,
      success: req.body.success !== false
    };
    logs.push(newLog);

    // Keep only last 1000 logs
    if (logs.length > 1000) {
      logs.shift();
    }

    await fs.writeFile(commandLogsFile, JSON.stringify(logs, null, 2));

    botState.commandsExecuted++;
    botState.lastCommand = newLog;
    broadcastState({ type: 'log', data: newLog });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get user stats
app.get('/api/stats', async (req, res) => {
  try {
    const data = await fs.readFile(userStatsFile, 'utf8');
    res.json(JSON.parse(data));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Custom commands CRUD
app.get('/api/custom-commands', async (req, res) => {
  try {
    const data = await fs.readFile(customCommandsFile, 'utf8');
    res.json(JSON.parse(data));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Built-in commands configuration
app.get('/api/builtin-commands', async (req, res) => {
  try {
    const data = await fs.readFile(builtinCommandsFile, 'utf8');
    res.json(JSON.parse(data));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/builtin-commands/:name', async (req, res) => {
  try {
    const { cooldownSeconds } = req.body;
    const targetName = req.params.name.trim().toLowerCase();

    if (!targetName.startsWith('!')) {
      return res.status(400).json({ error: 'Command name must start with !' });
    }

    const commands = JSON.parse(await fs.readFile(builtinCommandsFile, 'utf8'));
    const command = commands.find(cmd => cmd.name === targetName);

    if (!command) {
      return res.status(404).json({ error: 'Command not found' });
    }

    // Update cooldown
    command.cooldownSeconds = Number.isFinite(Number(cooldownSeconds)) && Number(cooldownSeconds) >= 0 ? Number(cooldownSeconds) : 0;

    await fs.writeFile(builtinCommandsFile, JSON.stringify(commands, null, 2));
    broadcastState({ type: 'builtinCommands', data: commands });
    res.json({ success: true, command });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/custom-commands', async (req, res) => {
  try {
    const { name, response, level, fetchUrl, fetchEnabled, cooldownSeconds } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const normalizedName = name.trim().toLowerCase();
    const allowedLevels = ['everyone', 'mod', 'broadcaster'];
    const finalLevel = allowedLevels.includes(level) ? level : 'everyone';
    const finalCooldown = Number.isFinite(Number(cooldownSeconds)) && Number(cooldownSeconds) > 0 ? Number(cooldownSeconds) : 0;

    const commands = JSON.parse(await fs.readFile(customCommandsFile, 'utf8'));
    const filtered = commands.filter(cmd => cmd.name !== normalizedName);
    filtered.push({
      name: normalizedName,
      response: (response || '').trim(),
      level: finalLevel,
      fetchEnabled: !!fetchEnabled,
      fetchUrl: (fetchUrl || '').trim(),
      cooldownSeconds: finalCooldown
    });

    await fs.writeFile(customCommandsFile, JSON.stringify(filtered, null, 2));
    broadcastState({ type: 'customCommands', data: filtered });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/custom-commands/:name', async (req, res) => {
  try {
    const target = req.params.name.trim().toLowerCase();
    const commands = JSON.parse(await fs.readFile(customCommandsFile, 'utf8'));
    const filtered = commands.filter(cmd => cmd.name !== target && cmd.name !== `!${target}`);
    await fs.writeFile(customCommandsFile, JSON.stringify(filtered, null, 2));
    broadcastState({ type: 'customCommands', data: filtered });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Broadcast chat message
app.post('/api/chat', (req, res) => {
  const chat = {
    timestamp: new Date().toISOString(),
    channel: req.body.channel,
    user: req.body.user,
    message: req.body.message
  };
  broadcastState({ type: 'chat', data: chat });
  res.json({ success: true });
});

// Update user stats
app.post('/api/stats/:username', async (req, res) => {
  try {
    const stats = JSON.parse(await fs.readFile(userStatsFile, 'utf8'));
    const username = req.params.username.toLowerCase();

    if (!stats[username]) {
      stats[username] = { commands: 0, firstSeen: new Date().toISOString(), lastCommand: null };
    }

    stats[username].commands++;
    stats[username].lastCommand = new Date().toISOString();

    await fs.writeFile(userStatsFile, JSON.stringify(stats, null, 2));
    broadcastState({ type: 'stats', data: stats });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Clear logs
app.delete('/api/logs', async (req, res) => {
  try {
    await fs.writeFile(commandLogsFile, JSON.stringify([], null, 2));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update bot state (called by parent process)
app.post('/api/update-state', (req, res) => {
  botState = { ...botState, ...req.body };
  broadcastState({ type: 'state', data: botState });
  res.json({ success: true });
});

// Get announcements
app.get('/api/announcements', async (req, res) => {
  try {
    const data = JSON.parse(await fs.readFile(announcementsFile, 'utf8'));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Save announcements
app.post('/api/announcements', async (req, res) => {
  try {
    const { announcements } = req.body;
    await fs.writeFile(announcementsFile, JSON.stringify(announcements, null, 2));
    await upsertEnvValue('ANNOUNCEMENTS', (announcements || []).join('|'));
    broadcastState({ type: 'announcements', data: announcements });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Log redemption (from bot)
app.post('/api/redemptions', async (req, res) => {
  try {
    const redemptions = JSON.parse(await fs.readFile(redemptionsFile, 'utf8'));
    redemptions.push({
      ...req.body,
      timestamp: new Date().toISOString()
    });
    // Keep last 100 redemptions
    if (redemptions.length > 100) redemptions.shift();
    await fs.writeFile(redemptionsFile, JSON.stringify(redemptions, null, 2));
    broadcastState({ type: 'redemption', data: req.body });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get redemptions log
app.get('/api/redemptions', async (req, res) => {
  try {
    const data = JSON.parse(await fs.readFile(redemptionsFile, 'utf8'));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Log EventSub event
app.post('/api/eventsub-events', async (req, res) => {
  try {
    const events = JSON.parse(await fs.readFile(eventSubEventsFile, 'utf8'));
    events.push({
      ...req.body,
      timestamp: new Date().toISOString()
    });
    // Keep last 100 events
    if (events.length > 100) events.shift();
    await fs.writeFile(eventSubEventsFile, JSON.stringify(events, null, 2));
    broadcastState({ type: 'eventsub-event', data: req.body });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get EventSub events log
app.get('/api/eventsub-events', async (req, res) => {
  try {
    const data = JSON.parse(await fs.readFile(eventSubEventsFile, 'utf8'));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Test alert endpoint for OBS overlay testing
app.post('/api/test-alert', (req, res) => {
  const { alertType = 'follow', user = 'TestUser', message, tier, amount, viewers, reward } = req.body;

  const validTypes = ['follow', 'subscription', 'bits', 'raid', 'redemption'];
  if (!validTypes.includes(alertType)) {
    return res.status(400).json({ error: `Invalid alertType. Must be one of: ${validTypes.join(', ')}` });
  }

  const alertData = {
    alertType,
    user,
    timestamp: new Date().toISOString()
  };

  // Add type-specific fields
  if (message) alertData.message = message;
  if (alertType === 'subscription' && tier) alertData.tier = tier;
  if (alertType === 'bits' && amount) alertData.amount = Number(amount);
  if (alertType === 'raid' && viewers) alertData.viewers = Number(viewers);
  if (alertType === 'redemption' && reward) alertData.reward = reward;

  // Broadcast to all connected clients (including OBS overlays)
  broadcastState({ type: 'alert', data: alertData });

  console.log('[TestAlert] Sent:', alertData);
  res.json({ success: true, alert: alertData });
});

// OBS Recent Events API
// Get recent events by type for the recent-events overlay
// Helper function to handle the recent events response
const handleRecentEventsRequest = async (req, res, eventType) => {
  try {
    const finalEventType = eventType ?? req.params.type?.toLowerCase() ?? 'all';
    const events = JSON.parse(await fs.readFile(eventSubEventsFile, 'utf8'));

    // Map event types to match alertType naming
    const typeMap = {
      follow: 'follow',
      subscriber: 'subscription',
      subscription: 'subscription',
      bits: 'bits',
      cheer: 'bits',
      raid: 'raid',
      redemption: 'redemption'
    };

    let filtered = events;

    // Filter by type if not 'all'
    if (finalEventType !== 'all') {
      const targetType = typeMap[finalEventType];
      if (!targetType) {
        return res.status(400).json({
          error: `Invalid event type. Must be one of: follow, subscriber, bits, raid, redemption, all`
        });
      }

      filtered = events.filter(e => {
        const eType = e.event || e.alertType;
        // Handle both 'subscription' and 'subscriber' names
        if (targetType === 'subscription') {
          return eType === 'subscription' || eType === 'subscriber';
        }
        return eType === targetType;
      });
    }

    // Reverse to get most recent first, limit to 50
    filtered = filtered.reverse().slice(0, 50);

    // Transform to overlay format
    const recentEvents = filtered.map(e => ({
      type: e.event || e.alertType,
      user: e.user || e.userName || e.username,
      timestamp: e.timestamp,
      tier: e.tier,
      amount: e.amount,
      viewers: e.viewers,
      reward: e.reward,
      message: e.message,
      ...e
    }));

    res.json({
      type: finalEventType,
      count: recentEvents.length,
      events: recentEvents
    });
  } catch (error) {
    console.error('[ObsRecentEvents] Error:', error);
    res.status(500).json({ error: error.message });
  }
};

// Route: Get all recent events (no type specified)
app.get('/obs/recent', async (req, res) => {
  await handleRecentEventsRequest(req, res, 'all');
});

// Route: Get recent events by specific type
app.get('/obs/recent/:type', async (req, res) => {
  await handleRecentEventsRequest(req, res);
});

// Chat Filters API

// Get current filter configuration
app.get('/api/filters', (req, res) => {
  res.json(chatFilters);
});

// Update filter settings
app.post('/api/filters', async (req, res) => {
  try {
    const { filterUrls, filterAllCaps, filterRepeatChars, filterSpam, filterAction, timeoutDurationSeconds } = req.body;

    // Update in-memory state
    if (filterUrls !== undefined) {
      chatFilters.filterUrls = !!filterUrls;
      await upsertEnvValue('CHAT_FILTER_URLS', chatFilters.filterUrls ? 'true' : 'false');
    }
    if (filterAllCaps !== undefined) {
      chatFilters.filterAllCaps = !!filterAllCaps;
      await upsertEnvValue('CHAT_FILTER_ALLCAPS', chatFilters.filterAllCaps ? 'true' : 'false');
    }
    if (filterRepeatChars !== undefined) {
      chatFilters.filterRepeatChars = !!filterRepeatChars;
      await upsertEnvValue('CHAT_FILTER_REPEAT', chatFilters.filterRepeatChars ? 'true' : 'false');
    }
    if (filterSpam !== undefined) {
      chatFilters.filterSpam = !!filterSpam;
      await upsertEnvValue('CHAT_FILTER_SPAM', chatFilters.filterSpam ? 'true' : 'false');
    }
    if (filterAction !== undefined && ['warn', 'timeout', 'delete'].includes(filterAction)) {
      chatFilters.filterAction = filterAction;
      await upsertEnvValue('CHAT_FILTER_ACTION', filterAction);
    }
    if (timeoutDurationSeconds !== undefined) {
      const seconds = Math.max(10, Math.min(3600, Number(timeoutDurationSeconds)));
      chatFilters.timeoutDurationSeconds = seconds;
      await upsertEnvValue('CHAT_FILTER_TIMEOUT_SEC', String(seconds));
    }

    broadcastState({ type: 'filters', data: chatFilters });
    res.json({ success: true, filters: chatFilters });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add word to filter blacklist
app.post('/api/filters/words', async (req, res) => {
  try {
    const { word } = req.body;
    if (!word || typeof word !== 'string' || word.trim().length === 0) {
      return res.status(400).json({ error: 'Word must be a non-empty string' });
    }

    const normalized = word.trim().toLowerCase();
    if (!chatFilters.blacklistWords.includes(normalized)) {
      chatFilters.blacklistWords.push(normalized);
      const wordsStr = chatFilters.blacklistWords.join('|');
      await upsertEnvValue('CHAT_FILTER_WORDS', wordsStr);
    }

    broadcastState({ type: 'filters', data: chatFilters });
    res.json({ success: true, words: chatFilters.blacklistWords });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Remove word from filter blacklist
app.delete('/api/filters/words/:word', async (req, res) => {
  try {
    const wordToRemove = decodeURIComponent(req.params.word).toLowerCase();
    chatFilters.blacklistWords = chatFilters.blacklistWords.filter(w => w !== wordToRemove);
    const wordsStr = chatFilters.blacklistWords.join('|');
    await upsertEnvValue('CHAT_FILTER_WORDS', wordsStr);

    broadcastState({ type: 'filters', data: chatFilters });
    res.json({ success: true, words: chatFilters.blacklistWords });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// OBS Configuration API

// Get OBS configuration
app.get('/obs/config', async (req, res) => {
  try {
    const data = JSON.parse(await fs.readFile(obsConfigFile, 'utf8'));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update OBS configuration
app.post('/obs/config', async (req, res) => {
  try {
    const config = req.body;

    // Validate configuration structure
    if (!config.overlays || typeof config.overlays !== 'object') {
      return res.status(400).json({ error: 'Configuration must contain overlays object' });
    }

    // Validate and sanitize overlay settings
    const validOverlays = ['alerts', 'recentEvents', 'chatBox', 'goalBar'];
    for (const overlay of validOverlays) {
      if (config.overlays[overlay]) {
        const settings = config.overlays[overlay];

        // Validate numeric values
        if (settings.volume !== undefined) {
          const vol = Number(settings.volume);
          if (isNaN(vol) || vol < 0 || vol > 1) {
            return res.status(400).json({ error: `${overlay}.volume must be a number between 0 and 1` });
          }
          settings.volume = vol;
        }

        if (settings.duration !== undefined) {
          const dur = Number(settings.duration);
          if (isNaN(dur) || dur < 1) {
            return res.status(400).json({ error: `${overlay}.duration must be a positive number` });
          }
          settings.duration = dur;
        }

        if (settings.limit !== undefined) {
          const limit = Number(settings.limit);
          if (isNaN(limit) || limit < 1) {
            return res.status(400).json({ error: `${overlay}.limit must be a positive number` });
          }
          settings.limit = limit;
        }

        if (settings.messageTimeout !== undefined) {
          const timeout = Number(settings.messageTimeout);
          if (isNaN(timeout) || timeout < 1) {
            return res.status(400).json({ error: `${overlay}.messageTimeout must be a positive number` });
          }
          settings.messageTimeout = timeout;
        }

        if (settings.goal !== undefined) {
          const goal = Number(settings.goal);
          if (isNaN(goal) || goal < 1) {
            return res.status(400).json({ error: `${overlay}.goal must be a positive number` });
          }
          settings.goal = goal;
        }

        // Validate boolean values
        if (settings.enabled !== undefined && typeof settings.enabled !== 'boolean') {
          settings.enabled = !!settings.enabled;
        }

        if (settings.showTime !== undefined && typeof settings.showTime !== 'boolean') {
          settings.showTime = !!settings.showTime;
        }

        if (settings.hideBot !== undefined && typeof settings.hideBot !== 'boolean') {
          settings.hideBot = !!settings.hideBot;
        }
      }
    }

    await fs.writeFile(obsConfigFile, JSON.stringify(config, null, 2));
    broadcastState({ type: 'obsConfig', data: config });
    res.json({ success: true, config });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update specific overlay configuration
app.post('/obs/config/:overlay', async (req, res) => {
  try {
    const config = JSON.parse(await fs.readFile(obsConfigFile, 'utf8'));
    const overlay = req.params.overlay.toLowerCase();
    const validOverlays = ['alerts', 'recentEvents', 'chatBox', 'goalBar'];

    if (!validOverlays.includes(overlay)) {
      return res.status(400).json({ error: `Invalid overlay. Must be one of: ${validOverlays.join(', ')}` });
    }

    if (!config.overlays[overlay]) {
      return res.status(404).json({ error: `Overlay '${overlay}' not found in configuration` });
    }

    const updates = req.body;

    // Validate numeric values based on overlay type
    if (overlay === 'alerts') {
      if (updates.volume !== undefined) {
        const vol = Number(updates.volume);
        if (isNaN(vol) || vol < 0 || vol > 1) {
          return res.status(400).json({ error: 'volume must be a number between 0 and 1' });
        }
        updates.volume = vol;
      }
      if (updates.duration !== undefined) {
        const dur = Number(updates.duration);
        if (isNaN(dur) || dur < 1) {
          return res.status(400).json({ error: 'duration must be a positive number' });
        }
        updates.duration = dur;
      }
    }

    if (overlay === 'recentEvents') {
      if (updates.limit !== undefined) {
        const limit = Number(updates.limit);
        if (isNaN(limit) || limit < 1) {
          return res.status(400).json({ error: 'limit must be a positive number' });
        }
        updates.limit = limit;
      }
      if (updates.showTime !== undefined && typeof updates.showTime !== 'boolean') {
        updates.showTime = !!updates.showTime;
      }
    }

    if (overlay === 'chatBox') {
      if (updates.messageTimeout !== undefined) {
        const timeout = Number(updates.messageTimeout);
        if (isNaN(timeout) || timeout < 1) {
          return res.status(400).json({ error: 'messageTimeout must be a positive number' });
        }
        updates.messageTimeout = timeout;
      }
      if (updates.hideBot !== undefined && typeof updates.hideBot !== 'boolean') {
        updates.hideBot = !!updates.hideBot;
      }
    }

    if (overlay === 'goalBar') {
      if (updates.goal !== undefined) {
        const goal = Number(updates.goal);
        if (isNaN(goal) || goal < 1) {
          return res.status(400).json({ error: 'goal must be a positive number' });
        }
        updates.goal = goal;
      }
      if (updates.type !== undefined && !['follow', 'subscriber'].includes(updates.type)) {
        return res.status(400).json({ error: "type must be 'follow' or 'subscriber'" });
      }
    }

    // Validate enabled flag for all overlays
    if (updates.enabled !== undefined && typeof updates.enabled !== 'boolean') {
      updates.enabled = !!updates.enabled;
    }

    config.overlays[overlay] = { ...config.overlays[overlay], ...updates };
    await fs.writeFile(obsConfigFile, JSON.stringify(config, null, 2));
    broadcastState({ type: 'obsConfig', data: config });

    res.json({ success: true, config: config.overlays[overlay] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// WebSocket connection handler
wss.on('connection', (ws) => {
  console.log('Dashboard client connected');

  // Send initial state
  ws.send(JSON.stringify({ type: 'state', data: botState }));

  ws.on('close', () => {
    console.log('Dashboard client disconnected');
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.DASHBOARD_PORT || 3001;

async function start() {
  await initLogs();

  server.listen(PORT, () => {
    console.log(`Dashboard server running at http://localhost:${PORT}`);
  });
}

start().catch(console.error);

// Export for parent process integration
module.exports = { app, server, wss, botState, broadcastState };
