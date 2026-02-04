const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs').promises;
require('dotenv').config(path.join(__dirname, '..', '.env'));

const state = require('./lib/state');
const { DEFAULT_ALERT_CONFIG } = require('./lib/constants');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Initialize state
state.init(wss);

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/obs', express.static(path.join(__dirname, '..', 'obs')));

// Paths
const logsDir = path.join(__dirname, 'logs');
const uploadsDir = path.join(__dirname, 'uploads');
const envPath = path.join(__dirname, '..', '.env');

const paths = {
  commandLogsFile: path.join(logsDir, 'commands.json'),
  userStatsFile: path.join(logsDir, 'stats.json'),
  customCommandsFile: path.join(logsDir, 'customCommands.json'),
  builtinCommandsFile: path.join(logsDir, 'builtinCommands.json'),
  announcementsFile: path.join(logsDir, 'announcements.json'),
  redemptionsFile: path.join(logsDir, 'redemptions.json'),
  eventSubEventsFile: path.join(logsDir, 'eventsub-events.json'),
  obsConfigFile: path.join(logsDir, 'obs-config.json'),
  alertConfigFile: path.join(logsDir, 'alert-config.json')
};

// Initialize logs directory and files
async function initLogs() {
  try {
    await fs.mkdir(logsDir, { recursive: true });
    await fs.mkdir(uploadsDir, { recursive: true });
    await fs.mkdir(path.join(uploadsDir, 'images'), { recursive: true });
    await fs.mkdir(path.join(uploadsDir, 'videos'), { recursive: true });
    await fs.mkdir(path.join(uploadsDir, 'sounds'), { recursive: true });

    const initFile = async (file, defaultData = []) => {
      try {
        await fs.access(file);
      } catch {
        await fs.writeFile(file, JSON.stringify(defaultData, null, 2));
      }
    };

    await initFile(paths.commandLogsFile);
    await initFile(paths.userStatsFile, {});
    await initFile(paths.customCommandsFile);
    await initFile(paths.announcementsFile);
    await initFile(paths.redemptionsFile);
    await initFile(paths.eventSubEventsFile);
    await initFile(paths.builtinCommandsFile, [
      { name: '!clip', cooldownSeconds: 60, description: 'Create a clip of the current stream', permission: 'Everyone' },
      { name: '!followage', cooldownSeconds: 0, description: 'Check how long you have been following the channel', permission: 'Everyone' },
      { name: '!8ball', cooldownSeconds: 5, description: 'Ask the magic 8ball a yes/no question', permission: 'Everyone' },
      { name: '!dice', cooldownSeconds: 5, description: 'Roll a die (default 6 sides, e.g. !dice 20)', permission: 'Everyone' },
      { name: '!coinflip', cooldownSeconds: 5, description: 'Flip a coin — heads or tails', permission: 'Everyone' },
      { name: '!shoutout', cooldownSeconds: 0, description: 'Give a shoutout to another streamer', permission: 'Moderator' },
      { name: '!so', cooldownSeconds: 0, description: 'Give a shoutout to another streamer', permission: 'Moderator' },
      { name: '!poll', cooldownSeconds: 0, description: 'Start or manage a poll', permission: 'Moderator' },
      { name: '!prediction', cooldownSeconds: 0, description: 'Start or manage a prediction', permission: 'Moderator' },
      { name: '!title', cooldownSeconds: 0, description: 'Update the stream title', permission: 'Moderator' },
      { name: '!game', cooldownSeconds: 0, description: 'Update the stream category', permission: 'Moderator' },
      { name: '!commands', cooldownSeconds: 0, description: 'List available commands', permission: 'Everyone' },
      { name: '!addfilter', cooldownSeconds: 0, description: 'Add a word to the chat filter', permission: 'Moderator' },
      { name: '!removefilter', cooldownSeconds: 0, description: 'Remove a word from the chat filter', permission: 'Moderator' },
      { name: '!filters', cooldownSeconds: 0, description: 'Show active chat filters', permission: 'Moderator' }
    ]);
    await initFile(paths.obsConfigFile, {
      overlays: {
        alerts: { enabled: true, volume: 0.8, duration: 5 },
        recentEvents: { enabled: true, limit: 10, showTime: true },
        chatBox: { enabled: true, messageTimeout: 8, hideBot: false },
        goalBar: { enabled: true, type: 'follow', goal: 1000 }
      }
    });
    await initFile(paths.alertConfigFile, DEFAULT_ALERT_CONFIG);
  } catch (error) {
    console.error('Failed to initialize logs:', error.message);
  }
}

// Routes
app.use('/api', require('./routes/api')(paths, envPath));
app.use('/api/filters', require('./routes/filters')(envPath));
app.use('/api/alerts', require('./routes/alerts')(paths.alertConfigFile));
app.use('/api/uploads', require('./routes/uploads')(uploadsDir));
app.use('/obs', require('./routes/obs')(paths));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Global error handler
const { errorHandler } = require('./lib/middleware');
app.use(errorHandler);

// WebSocket connection handler
wss.on('connection', (ws) => {
  console.log('Dashboard client connected');
  ws.send(JSON.stringify({ type: 'state', data: state.getBotState() }));
  ws.on('close', () => console.log('Dashboard client disconnected'));
});

// Start server
const PORT = process.env.DASHBOARD_PORT || 3001;
initLogs().then(() => {
  server.listen(PORT, () => {
    console.log(`Dashboard server running on http://localhost:${PORT}`);
  });
});
