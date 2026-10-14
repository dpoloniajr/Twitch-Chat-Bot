/**
 * Dashboard API routes (mounted at /api): bot status, command logs, user stats,
 * custom and built-in commands, chat relay, redemptions, EventSub events,
 * announcements, settings, bot restart, test alerts and TTS.
 */

import { Router } from 'express';
import { promises as fs } from 'fs';
import * as path from 'path';
import { withFileLock, validateRequest, asyncHandler, upsertEnvValue, ValidationError } from '../lib/utils';
import * as state from '../lib/state';
import * as ttsService from '../../lib/tts-service';
import { projectPath } from '../../utils/project-root';
import type { DashboardCommandLog } from '../lib/types';

/** Data files the API routes read and write */
export interface ApiPaths {
  commandLogsFile: string;
  userStatsFile: string;
  customCommandsFile: string;
  builtinCommandsFile: string;
  redemptionsFile: string;
  eventSubEventsFile: string;
  announcementsFile: string;
  [key: string]: string;
}

/** An entry in stats.json */
interface UserStatsEntry {
  commands: number;
  firstSeen: string;
  lastCommand: string | null;
}

/** An entry in customCommands.json */
interface CustomCommand {
  name: string;
  response: string;
  level: string;
  fetchEnabled: boolean;
  fetchUrl: string;
  cooldownSeconds: number;
  [key: string]: unknown;
}

/** An entry in builtinCommands.json */
interface BuiltinCommand {
  name: string;
  cooldownSeconds?: number;
  [key: string]: unknown;
}

/** Alert broadcast by POST /test-alert */
interface TestAlertData {
  alertType: string;
  user: string;
  timestamp: string;
  message?: string;
  tier?: string;
  amount?: number;
  viewers?: number;
  reward?: string;
  config?: unknown;
  audioUrl?: unknown;
  useBrowserTTS?: unknown;
}

/** A chat hype burst broadcast by POST /hype/trigger */
interface HypeEvent {
  channel: string;
  /** Messages in the detection window */
  count: number;
  /** Message count that triggers hype */
  threshold?: number;
  /** Detection window (seconds) */
  windowSec?: number;
  timestamp: string;
}

/**
 * Create the /api router. Each call returns a new router bound to `paths` and `envPath`.
 */
export function createApiRouter(paths: ApiPaths, envPath: string): Router {
  const router = Router();
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
    const newLog: DashboardCommandLog = {
      timestamp: new Date().toISOString(),
      user: req.body.user,
      command: req.body.command,
      channel: req.body.channel,
      success: req.body.success !== false
    };

    await withFileLock(commandLogsFile, async () => {
      const logs: DashboardCommandLog[] = JSON.parse(await fs.readFile(commandLogsFile, 'utf8'));
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
    cooldownSeconds: { required: true, type: 'number', min: 0 }
  }), asyncHandler(async (req, res) => {
    const { cooldownSeconds } = req.body;
    const targetName = (req.params.name as string).trim().toLowerCase();

    if (!targetName.startsWith('!')) {
      throw new ValidationError('Command name must start with !');
    }

    const commands = await withFileLock(builtinCommandsFile, async () => {
      const cmds: BuiltinCommand[] = JSON.parse(await fs.readFile(builtinCommandsFile, 'utf8'));
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

    // Chat commands start with "!" (the bot matches the typed "!name"), so add it when missing
    const trimmedName = (name as string).trim().toLowerCase();
    const normalizedName = trimmedName.startsWith('!') ? trimmedName : `!${trimmedName}`;
    if (normalizedName.length < 2 || /\s/.test(normalizedName)) {
      throw new ValidationError('Command name must be a single word, e.g. !discord');
    }
    const allowedLevels = ['everyone', 'mod', 'broadcaster'];
    const finalLevel = allowedLevels.includes(level) ? level : 'everyone';
    const finalCooldown = Number.isFinite(Number(cooldownSeconds)) && Number(cooldownSeconds) > 0 ? Number(cooldownSeconds) : 0;

    const filtered = await withFileLock(customCommandsFile, async () => {
      const commands: CustomCommand[] = JSON.parse(await fs.readFile(customCommandsFile, 'utf8'));
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
    const target = (req.params.name as string).trim().toLowerCase();
    const filtered = await withFileLock(customCommandsFile, async () => {
      const commands: CustomCommand[] = JSON.parse(await fs.readFile(customCommandsFile, 'utf8'));
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
    const username = (req.params.username as string).toLowerCase();
    const stats = await withFileLock(userStatsFile, async () => {
      const s: Record<string, UserStatsEntry> = JSON.parse(await fs.readFile(userStatsFile, 'utf8'));
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
      const redemptions: unknown[] = JSON.parse(await fs.readFile(redemptionsFile, 'utf8'));
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
      const events: unknown[] = JSON.parse(await fs.readFile(eventSubEventsFile, 'utf8'));
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

  // Save announcements (validated in full before announcements.json or .env is touched)
  router.post('/announcements', validateRequest({
    announcements: { required: true, type: 'object' }
  }), asyncHandler(async (req, res) => {
    const { announcements } = req.body;
    if (!Array.isArray(announcements) || !announcements.every(a => typeof a === 'string')) {
      throw new ValidationError('announcements must be an array of strings');
    }
    if (announcements.some(a => /[\r\n]/.test(a))) {
      throw new ValidationError('announcements cannot contain line breaks');
    }
    await withFileLock(announcementsFile, async () => {
      await fs.writeFile(announcementsFile, JSON.stringify(announcements, null, 2));
    });
    await upsertEnvValue(envPath, 'ANNOUNCEMENTS', (announcements as string[]).join('|'));
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
    const { alertType = 'follow', user = 'TestUser', message, tier, amount, viewers, reward, config, audioUrl, useBrowserTTS } = req.body;
    const alertData: TestAlertData = { alertType, user, timestamp: new Date().toISOString() };
    if (message) alertData.message = message;
    if (alertType === 'subscription' && tier) alertData.tier = tier;
    if (alertType === 'bits' && amount) alertData.amount = Number(amount);
    if (alertType === 'raid' && viewers) alertData.viewers = Number(viewers);
    if (alertType === 'redemption' && reward) alertData.reward = reward;
    if (config) alertData.config = config; // Preserve custom config for overlays (e.g., TTS settings)
    if (audioUrl !== undefined) alertData.audioUrl = audioUrl; // TTS audio URL
    if (useBrowserTTS !== undefined) alertData.useBrowserTTS = useBrowserTTS; // Browser TTS flag
    state.broadcastState({ type: 'alert', data: alertData });
    res.json({ success: true, alert: alertData });
  });

  // Hype train trigger (from the bot's chat-hype detector): relay it to the
  // dashboard pages and OBS overlays over the WebSocket as a 'hype' message
  router.post('/hype/trigger', validateRequest({
    channel: { required: true, type: 'string' },
    count: { required: true, type: 'number', min: 0 }
  }), (req, res) => {
    const { channel, count, threshold, windowSec } = req.body;
    const hype: HypeEvent = {
      channel,
      count,
      threshold: typeof threshold === 'number' ? threshold : undefined,
      windowSec: typeof windowSec === 'number' ? windowSec : undefined,
      timestamp: new Date().toISOString()
    };
    state.broadcastState({ type: 'hype', data: hype });
    res.json({ success: true });
  });

  // TTS API endpoints
  // Get TTS service configuration
  router.get('/tts/config', (req, res) => {
    res.json(ttsService.getConfig());
  });

  // Generate TTS audio
  router.post('/tts/generate', asyncHandler(async (req, res) => {
    // Security: Restrict to localhost to prevent API credit abuse
    const remoteAddr = req.ip || req.connection.remoteAddress || req.socket.remoteAddress;
    const isLocalhost = remoteAddr === '127.0.0.1' ||
                        remoteAddr === '::1' ||
                        remoteAddr === '::ffff:127.0.0.1' ||
                        remoteAddr === 'localhost';

    if (!isLocalhost) {
      res.status(403).json({ success: false, error: 'TTS generation restricted to localhost' });
      return;
    }

    const { text, voice, provider } = req.body;

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      res.status(400).json({ success: false, error: 'Text is required' });
      return;
    }

    if (text.length > 200) {
      res.status(400).json({ success: false, error: 'Text too long (max 200 characters)' });
      return;
    }

    const result = await ttsService.generateTTS(text, { voice, provider });
    res.json(result);
  }));

  // Serve cached TTS audio files
  router.get('/tts/audio/:filename', asyncHandler(async (req, res) => {
    const filename = req.params.filename as string;

    // Validate filename (only allow hash.mp3 format)
    if (!/^[a-f0-9]{64}\.mp3$/.test(filename)) {
      res.status(400).json({ success: false, error: 'Invalid filename' });
      return;
    }

    // dashboard/cache/tts (the folder tts-service caches into); resolved from the project
    // root because this module runs from dist/ in production
    const cacheDir = projectPath('dashboard', 'cache', 'tts');
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
}
