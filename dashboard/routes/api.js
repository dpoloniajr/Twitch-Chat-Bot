const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const { withFileLock } = require('../lib/utils');
const state = require('../lib/state');

module.exports = function(paths, envPath) {
  const { commandLogsFile, userStatsFile, customCommandsFile, builtinCommandsFile, redemptionsFile, eventSubEventsFile, announcementsFile } = paths;

  // Get bot status
  router.get('/status', (req, res) => {
    res.json(state.getBotState());
  });

  // Get command logs
  router.get('/logs', async (req, res) => {
    try {
      const data = await fs.readFile(commandLogsFile, 'utf8');
      res.json(JSON.parse(data));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Add command log
  router.post('/logs', async (req, res) => {
    try {
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
        commandsExecuted: botState.commandsExecuted + 1,
        lastCommand: newLog
      });
      state.broadcastState({ type: 'log', data: newLog });

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get user stats
  router.get('/stats', async (req, res) => {
    try {
      const data = await fs.readFile(userStatsFile, 'utf8');
      res.json(JSON.parse(data));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Custom commands CRUD
  router.get('/custom-commands', async (req, res) => {
    try {
      const data = await fs.readFile(customCommandsFile, 'utf8');
      res.json(JSON.parse(data));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Built-in commands configuration
  router.get('/builtin-commands', async (req, res) => {
    try {
      const data = await fs.readFile(builtinCommandsFile, 'utf8');
      res.json(JSON.parse(data));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.put('/builtin-commands/:name', async (req, res) => {
    try {
      const { cooldownSeconds } = req.body;
      const targetName = req.params.name.trim().toLowerCase();

      if (!targetName.startsWith('!')) {
        return res.status(400).json({ error: 'Command name must start with !' });
      }

      const commands = await withFileLock(builtinCommandsFile, async () => {
        const cmds = JSON.parse(await fs.readFile(builtinCommandsFile, 'utf8'));
        const command = cmds.find(cmd => cmd.name === targetName);
        if (command) {
          command.cooldownSeconds = Number.isFinite(Number(cooldownSeconds)) && Number(cooldownSeconds) >= 0 ? Number(cooldownSeconds) : 0;
          await fs.writeFile(builtinCommandsFile, JSON.stringify(cmds, null, 2));
        }
        return cmds;
      });

      state.broadcastState({ type: 'builtinCommands', data: commands });
      res.json({ success: true, commands });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/custom-commands', async (req, res) => {
    try {
      const { name, response, level, fetchUrl, fetchEnabled, cooldownSeconds } = req.body;
      if (!name) return res.status(400).json({ error: 'name is required' });

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
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.delete('/custom-commands/:name', async (req, res) => {
    try {
      const target = req.params.name.trim().toLowerCase();
      const filtered = await withFileLock(customCommandsFile, async () => {
        const commands = JSON.parse(await fs.readFile(customCommandsFile, 'utf8'));
        const cmds = commands.filter(cmd => cmd.name !== target && cmd.name !== `!${target}`);
        await fs.writeFile(customCommandsFile, JSON.stringify(cmds, null, 2));
        return cmds;
      });

      state.broadcastState({ type: 'customCommands', data: filtered });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Broadcast chat message
  router.post('/chat', (req, res) => {
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
  router.post('/stats/:username', async (req, res) => {
    try {
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
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Clear logs
  router.delete('/logs', async (req, res) => {
    try {
      await withFileLock(commandLogsFile, async () => {
        await fs.writeFile(commandLogsFile, JSON.stringify([], null, 2));
      });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Update bot state (called by parent process)
  router.post('/update-state', (req, res) => {
    state.updateBotState(req.body);
    res.json({ success: true });
  });

  // Get redemptions log
  router.get('/redemptions', async (req, res) => {
    try {
      const data = await fs.readFile(redemptionsFile, 'utf8');
      res.json(JSON.parse(data));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Log redemption (from bot)
  router.post('/redemptions', async (req, res) => {
    try {
      await withFileLock(redemptionsFile, async () => {
        const redemptions = JSON.parse(await fs.readFile(redemptionsFile, 'utf8'));
        redemptions.push({ ...req.body, timestamp: new Date().toISOString() });
        if (redemptions.length > 100) redemptions.shift();
        await fs.writeFile(redemptionsFile, JSON.stringify(redemptions, null, 2));
      });
      state.broadcastState({ type: 'redemption', data: req.body });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get EventSub events log
  router.get('/eventsub-events', async (req, res) => {
    try {
      const data = await fs.readFile(eventSubEventsFile, 'utf8');
      res.json(JSON.parse(data));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Log EventSub event
  router.post('/eventsub-events', async (req, res) => {
    try {
      await withFileLock(eventSubEventsFile, async () => {
        const events = JSON.parse(await fs.readFile(eventSubEventsFile, 'utf8'));
        events.push({ ...req.body, timestamp: new Date().toISOString() });
        if (events.length > 100) events.shift();
        await fs.writeFile(eventSubEventsFile, JSON.stringify(events, null, 2));
      });
      state.broadcastState({ type: 'eventsub-event', data: req.body });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get announcements
  router.get('/announcements', async (req, res) => {
    try {
      const data = await fs.readFile(announcementsFile, 'utf8');
      res.json(JSON.parse(data));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Save announcements
  router.post('/announcements', async (req, res) => {
    try {
      const { announcements } = req.body;
      const { upsertEnvValue } = require('../lib/utils');
      await withFileLock(announcementsFile, async () => {
        await fs.writeFile(announcementsFile, JSON.stringify(announcements, null, 2));
      });
      await upsertEnvValue(envPath, 'ANNOUNCEMENTS', (announcements || []).join('|'));
      state.broadcastState({ type: 'announcements', data: announcements });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Test alert endpoint for OBS overlay testing (compatibility with Excella.js)
  router.post('/test-alert', (req, res) => {
    const { alertType = 'follow', user = 'TestUser', message, tier, amount, viewers, reward } = req.body;
    const alertData = { alertType, user, timestamp: new Date().toISOString() };
    if (message) alertData.message = message;
    if (alertType === 'subscription' && tier) alertData.tier = tier;
    if (alertType === 'bits' && amount) alertData.amount = Number(amount);
    if (alertType === 'raid' && viewers) alertData.viewers = Number(viewers);
    if (alertType === 'redemption' && reward) alertData.reward = reward;
    state.broadcastState({ type: 'alert', data: alertData });
    res.json({ success: true, alert: alertData });
  });

  return router;
};
