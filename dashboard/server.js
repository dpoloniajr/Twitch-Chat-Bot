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

// Paths for logs
const logsDir = path.join(__dirname, 'logs');
const commandLogsFile = path.join(logsDir, 'commands.json');
const userStatsFile = path.join(logsDir, 'stats.json');
const customCommandsFile = path.join(logsDir, 'customCommands.json');
const announcementsFile = path.join(logsDir, 'announcements.json');
const redemptionsFile = path.join(logsDir, 'redemptions.json');
const eventSubEventsFile = path.join(logsDir, 'eventsub-events.json');

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
