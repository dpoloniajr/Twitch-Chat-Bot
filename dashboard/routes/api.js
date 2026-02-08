const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const { withFileLock, validateRequest, asyncHandler } = require('../lib/utils');
const state = require('../lib/state');
const ttsService = require('../../tts-service');

module.exports = function(paths, envPath) {
  const { commandLogsFile, userStatsFile, customCommandsFile, builtinCommandsFile, redemptionsFile, eventSubEventsFile, announcementsFile } = paths;

  // Get bot status
  router.get('/status', (req, res) => {
    res.json(state.getBotState());
  });

  // Get command logs
  router.get('/logs', asyncHandler(async (req, res) => {
    const data = await fs.readFile(commandLogsFile, 'utf8');
    res.json(JSON.parse(data));
  }));

  // Add command log
  router.post('/logs', validateRequest({
    user: { required: true, type: 'string' },
    command: { required: true, type: 'string' }
  }), asyncHandler(async (req, res) => {
    const newLog = {
      timestamp: new Date().toISOString(),
      user: req.body.user,
      command: req.body.command,
      channel: req.body.channel,
      success: req.body.success !== false
    };

    await withFileLock(commandLogsFile, async () => {
      const logs = JSON.parse(await fs.readFile(commandLogsFile, 'utf8'));
      logs.push(newLog);
      if (logs.length > 1000) logs.shift();
      await fs.writeFile(commandLogsFile, JSON.stringify(logs, null, 2));
    });

    const botState = state.getBotState();
    state.updateBotState({
      commandsExecuted: (botState.commandsExecuted || 0) + 1,
      lastCommand: newLog
    });
    state.broadcastState({ type: 'log', data: newLog });

    res.json({ success: true });
  }));

  // Get user stats
  router.get('/stats', asyncHandler(async (req, res) => {
    const data = await fs.readFile(userStatsFile, 'utf8');
    res.json(JSON.parse(data));
  }));

  // Custom commands CRUD
  router.get('/custom-commands', asyncHandler(async (req, res) => {
    const data = await fs.readFile(customCommandsFile, 'utf8');
    res.json(JSON.parse(data));
  }));

  // Built-in commands configuration
  router.get('/builtin-commands', asyncHandler(async (req, res) => {
    const data = await fs.readFile(builtinCommandsFile, 'utf8');
    res.json(JSON.parse(data));
  }));

  router.put('/builtin-commands/:name', validateRequest({
    cooldownSeconds: { type: 'number', min: 0 }
  }), asyncHandler(async (req, res) => {
    const { cooldownSeconds } = req.body;
    const targetName = req.params.name.trim().toLowerCase();

    if (!targetName.startsWith('!')) {
      throw new Error('Command name must start with !');
    }

    const commands = await withFileLock(builtinCommandsFile, async () => {
      const cmds = JSON.parse(await fs.readFile(builtinCommandsFile, 'utf8'));
      const command = cmds.find(cmd => cmd.name === targetName);
      if (command) {
        command.cooldownSeconds = cooldownSeconds;
        await fs.writeFile(builtinCommandsFile, JSON.stringify(cmds, null, 2));
      }
      return cmds;
    });

    state.broadcastState({ type: 'builtinCommands', data: commands });
    res.json({ success: true, commands });
  }));

  router.post('/custom-commands', validateRequest({
    name: { required: true, type: 'string' },
    response: { required: true, type: 'string' }
  }), asyncHandler(async (req, res) => {
    const { name, response, level, fetchUrl, fetchEnabled, cooldownSeconds } = req.body;

    const normalizedName = name.trim().toLowerCase();
    const allowedLevels = ['everyone', 'mod', 'broadcaster'];
    const finalLevel = allowedLevels.includes(level) ? level : 'everyone';
    const finalCooldown = Number.isFinite(Number(cooldownSeconds)) && Number(cooldownSeconds) > 0 ? Number(cooldownSeconds) : 0;

    const filtered = await withFileLock(customCommandsFile, async () => {
      const commands = JSON.parse(await fs.readFile(customCommandsFile, 'utf8'));
      const cmds = commands.filter(cmd => cmd.name !== normalizedName);
      cmds.push({
        name: normalizedName,
        response: (response || '').trim(),
        level: finalLevel,
        fetchEnabled: !!fetchEnabled,
        fetchUrl: (fetchUrl || '').trim(),
        cooldownSeconds: finalCooldown
      });
      await fs.writeFile(customCommandsFile, JSON.stringify(cmds, null, 2));
      return cmds;
    });

    state.broadcastState({ type: 'customCommands', data: filtered });
    res.json({ success: true });
  }));

  router.delete('/custom-commands/:name', asyncHandler(async (req, res) => {
    const target = req.params.name.trim().toLowerCase();
    const filtered = await withFileLock(customCommandsFile, async () => {
      const commands = JSON.parse(await fs.readFile(customCommandsFile, 'utf8'));
      const cmds = commands.filter(cmd => cmd.name !== target && cmd.name !== `!${target}`);
      await fs.writeFile(customCommandsFile, JSON.stringify(cmds, null, 2));
      return cmds;
    });

    state.broadcastState({ type: 'customCommands', data: filtered });
    res.json({ success: true });
  }));

  // Broadcast chat message
  router.post('/chat', validateRequest({
    message: { required: true, type: 'string' }
  }), (req, res) => {
    const chat = {
      timestamp: new Date().toISOString(),
      channel: req.body.channel,
      user: req.body.user,
      message: req.body.message
    };
    state.broadcastState({ type: 'chat', data: chat });
    res.json({ success: true });
  });

  // Update user stats
  router.post('/stats/:username', asyncHandler(async (req, res) => {
    const username = req.params.username.toLowerCase();
    const stats = await withFileLock(userStatsFile, async () => {
      const s = JSON.parse(await fs.readFile(userStatsFile, 'utf8'));
      if (!s[username]) {
        s[username] = { commands: 0, firstSeen: new Date().toISOString(), lastCommand: null };
      }
      s[username].commands++;
      s[username].lastCommand = new Date().toISOString();
      await fs.writeFile(userStatsFile, JSON.stringify(s, null, 2));
      return s;
    });

    state.broadcastState({ type: 'stats', data: stats });
    res.json({ success: true });
  }));

  // Clear logs
  router.delete('/logs', asyncHandler(async (req, res) => {
    await withFileLock(commandLogsFile, async () => {
      await fs.writeFile(commandLogsFile, JSON.stringify([], null, 2));
    });
    res.json({ success: true });
  }));

  // Update bot state (called by parent process)
  router.post('/update-state', (req, res) => {
    state.updateBotState(req.body);
    res.json({ success: true });
  });

  // Get redemptions log
  router.get('/redemptions', asyncHandler(async (req, res) => {
    const data = await fs.readFile(redemptionsFile, 'utf8');
    res.json(JSON.parse(data));
  }));

  // Log redemption (from bot)
  router.post('/redemptions', validateRequest({
    user: { required: true, type: 'string' },
    reward: { required: true, type: 'string' }
  }), asyncHandler(async (req, res) => {
    await withFileLock(redemptionsFile, async () => {
      const redemptions = JSON.parse(await fs.readFile(redemptionsFile, 'utf8'));
      redemptions.push({ ...req.body, timestamp: new Date().toISOString() });
      if (redemptions.length > 100) redemptions.shift();
      await fs.writeFile(redemptionsFile, JSON.stringify(redemptions, null, 2));
    });
    state.broadcastState({ type: 'redemption', data: req.body });
    res.json({ success: true });
  }));

  // Get EventSub events log
  router.get('/eventsub-events', asyncHandler(async (req, res) => {
    const data = await fs.readFile(eventSubEventsFile, 'utf8');
    res.json(JSON.parse(data));
  }));

  // Log EventSub event
  router.post('/eventsub-events', validateRequest({
    type: { required: true, type: 'string' }
  }), asyncHandler(async (req, res) => {
    await withFileLock(eventSubEventsFile, async () => {
      const events = JSON.parse(await fs.readFile(eventSubEventsFile, 'utf8'));
      events.push({ ...req.body, timestamp: new Date().toISOString() });
      if (events.length > 100) events.shift();
      await fs.writeFile(eventSubEventsFile, JSON.stringify(events, null, 2));
    });
    state.broadcastState({ type: 'eventsub-event', data: req.body });
    res.json({ success: true });
  }));

  // Get announcements
  router.get('/announcements', asyncHandler(async (req, res) => {
    const data = await fs.readFile(announcementsFile, 'utf8');
    res.json(JSON.parse(data));
  }));

  // Save announcements
  router.post('/announcements', validateRequest({
    announcements: { required: true, type: 'object' }
  }), asyncHandler(async (req, res) => {
    const { announcements } = req.body;
    const { upsertEnvValue } = require('../lib/utils');
    await withFileLock(announcementsFile, async () => {
      await fs.writeFile(announcementsFile, JSON.stringify(announcements, null, 2));
    });
    await upsertEnvValue(envPath, 'ANNOUNCEMENTS', (announcements || []).join('|'));
    state.broadcastState({ type: 'announcements', data: announcements });
    res.json({ success: true });
  }));

  // Get settings
  router.get('/settings', (req, res) => {
    res.json({
      commandRefreshInterval: Number(process.env.COMMAND_REFRESH_INTERVAL || 60)
    });
  });

  // Save settings
  router.post('/settings', validateRequest({
    commandRefreshInterval: { required: true, type: 'number', min: 5 }
  }), asyncHandler(async (req, res) => {
    const { commandRefreshInterval } = req.body;
    const { upsertEnvValue } = require('../lib/utils');
    
    await upsertEnvValue(envPath, 'COMMAND_REFRESH_INTERVAL', commandRefreshInterval.toString());
    process.env.COMMAND_REFRESH_INTERVAL = commandRefreshInterval.toString();
    
    res.json({ success: true });
  }));

  // Restart bot
  router.post('/bot/restart', asyncHandler(async (req, res) => {
    const restartFlagPath = path.join(path.dirname(commandLogsFile), 'restart.flag');
    await fs.writeFile(restartFlagPath, Date.now().toString());
    res.json({ success: true, message: 'Restart signal sent' });
  }));

  // Test alert endpoint for OBS overlay testing (compatibility with Excella.js)
  router.post('/test-alert', (req, res) => {
    const { alertType = 'follow', user = 'TestUser', message, tier, amount, viewers, reward, config } = req.body;
    const alertData = { alertType, user, timestamp: new Date().toISOString() };
    if (message) alertData.message = message;
    if (alertType === 'subscription' && tier) alertData.tier = tier;
    if (alertType === 'bits' && amount) alertData.amount = Number(amount);
    if (alertType === 'raid' && viewers) alertData.viewers = Number(viewers);
    if (alertType === 'redemption' && reward) alertData.reward = reward;
    if (config) alertData.config = config; // Preserve custom config for overlays (e.g., TTS settings)
    state.broadcastState({ type: 'alert', data: alertData });
    res.json({ success: true, alert: alertData });
  });

  // TTS API endpoints
  // Get TTS service configuration
  router.get('/tts/config', (req, res) => {
    res.json(ttsService.getConfig());
  });

  // Generate TTS audio
  router.post('/tts/generate', asyncHandler(async (req, res) => {
    const { text, voice, provider } = req.body;

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'Text is required' });
    }

    if (text.length > 500) {
      return res.status(400).json({ success: false, error: 'Text too long (max 500 characters)' });
    }

    const result = await ttsService.generateTTS(text, { voice, provider });
    res.json(result);
  }));

  // Serve cached TTS audio files
  router.get('/tts/audio/:filename', asyncHandler(async (req, res) => {
    const filename = req.params.filename;

    // Validate filename (only allow hash.mp3 format)
    if (!/^[a-f0-9]{64}\.mp3$/.test(filename)) {
      return res.status(400).json({ success: false, error: 'Invalid filename' });
    }

    const cacheDir = path.join(__dirname, '..', 'cache', 'tts');
    const filePath = path.join(cacheDir, filename);

    try {
      await fs.access(filePath);
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
      res.sendFile(filePath);
    } catch (err) {
      res.status(404).json({ success: false, error: 'Audio file not found' });
    }
  }));

  return router;
};
