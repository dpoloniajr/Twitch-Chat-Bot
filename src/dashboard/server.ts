/**
 * Dashboard server: the Express app (static pages, OBS overlays, uploads and the
 * /api routes), its HTTP server and the WebSocket server that pushes state to the
 * dashboard pages. createDashboard() builds everything without starting it;
 * src/dashboard/main.ts (`node dist/dashboard/main.js`) loads .env and listens.
 */

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import * as http from 'http';
import WebSocket from 'ws';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as state from './lib/state';
import { DEFAULT_ALERT_CONFIG, DEFAULT_BUILTIN_COMMANDS, type BuiltinCommandEntry } from './lib/constants';
import { errorHandler, sameOriginGuard, requireBotSecret, allowDashboardPages, ensureBody } from './lib/middleware';
import * as ttsService from '../lib/tts-service';
import { projectPath } from '../utils/project-root';
import { createApiRouter } from './routes/api';
import { createFiltersRouter, readChatFiltersFromEnv } from './routes/filters';
import { createAlertsRouter } from './routes/alerts';
import { createUploadsRouter } from './routes/uploads';
import { createObsRouter } from './routes/obs';
import { createLoyaltyRouter } from './routes/loyalty';
import { createQuotesRouter } from './routes/quotes';
import { createCountersRouter } from './routes/counters';
import { createBackupRouter } from './routes/backup';
import { createSongQueueRouter } from './routes/song-queue';
import { createConfigRouter } from './routes/config';

export interface DashboardOptions {
  /** JSON data directory (default dashboard/logs) */
  logsDir?: string;
  /** Uploaded media directory (default dashboard/uploads) */
  uploadsDir?: string;
  /** .env file the settings routes edit (default: the project's .env) */
  envPath?: string;
  /** Initialise the TTS cache on init() (default true) */
  initTts?: boolean;
  /**
   * Env keys the system environment set before .env was loaded (dashboard/main.ts
   * captures them). Without it, the Settings page infers them by comparing
   * process.env with .env.
   */
  environmentKeys?: string[];
}

/** The data files createDashboard() uses (all inside logsDir) */
export interface DashboardPaths {
  commandLogsFile: string;
  userStatsFile: string;
  customCommandsFile: string;
  builtinCommandsFile: string;
  announcementsFile: string;
  redemptionsFile: string;
  eventSubEventsFile: string;
  obsConfigFile: string;
  alertConfigFile: string;
  [key: string]: string;
}

export interface Dashboard {
  app: Express;
  server: http.Server;
  wss: WebSocket.Server;
  paths: DashboardPaths;
  /** Create data files and the TTS cache before serving */
  init: () => Promise<unknown>;
  /** Stop timers and close the HTTP and WebSocket servers */
  close: () => Promise<void>;
}

/**
 * Build the dashboard (Express app, HTTP server and WebSocket server) without
 * starting it. Directories default to the project layout; tests pass temp dirs.
 */
export function createDashboard(options: DashboardOptions = {}): Dashboard {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server });

  // Initialize state
  state.init(wss);

  // Paths
  const logsDir = options.logsDir || projectPath('dashboard', 'logs');
  const uploadsDir = options.uploadsDir || projectPath('dashboard', 'uploads');
  const envPath = options.envPath || projectPath('.env');

  // Seed the chat filter settings from .env, so filter edits extend the saved
  // settings instead of replacing them with the in-memory defaults
  state.updateChatFilters(readChatFiltersFromEnv(envPath));

  // Middleware
  // Reject cross-site writes before parsing their bodies (CSRF)
  app.use(sameOriginGuard);
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));
  app.use(ensureBody);
  app.use(express.static(projectPath('dashboard', 'public')));
  app.use('/uploads', express.static(uploadsDir));
  app.use('/obs', express.static(projectPath('obs')));

  const paths: DashboardPaths = {
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

  // Migrate built-in commands: add new commands to existing installations
  async function migrateBuiltinCommands(): Promise<void> {
    try {
      const content = await fs.readFile(paths.builtinCommandsFile, 'utf-8');
      const commands = JSON.parse(content) as BuiltinCommandEntry[];

      // Add every default command the file lacks (commands added in later versions)
      let updated = false;
      for (const newCmd of DEFAULT_BUILTIN_COMMANDS) {
        if (!commands.find(c => c.name === newCmd.name)) {
          commands.push({ ...newCmd });
          updated = true;
        }
      }

      if (updated) {
        await fs.writeFile(paths.builtinCommandsFile, JSON.stringify(commands, null, 2));
        console.log('✓ Migrated built-in commands: added new commands for existing users');
      }
    } catch (error) {
      console.warn('Could not migrate built-in commands:', (error as Error).message);
    }
  }

  // Initialize logs directory and files
  async function initLogs(): Promise<void> {
    try {
      await fs.mkdir(logsDir, { recursive: true });
      await fs.mkdir(uploadsDir, { recursive: true });
      await fs.mkdir(path.join(uploadsDir, 'images'), { recursive: true });
      await fs.mkdir(path.join(uploadsDir, 'videos'), { recursive: true });
      await fs.mkdir(path.join(uploadsDir, 'sounds'), { recursive: true });

      const initFile = async (file: string, defaultData: unknown = []): Promise<void> => {
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
      await initFile(paths.builtinCommandsFile, DEFAULT_BUILTIN_COMMANDS);
      await initFile(paths.obsConfigFile, {
        overlays: {
          alerts: { enabled: true, volume: 0.8, duration: 5 },
          recentEvents: { enabled: true, limit: 10, showTime: true },
          chatBox: { enabled: true, messageTimeout: 8, hideBot: false },
          goalBar: { enabled: true, type: 'follow', goal: 1000 }
        }
      });
      await initFile(paths.alertConfigFile, DEFAULT_ALERT_CONFIG);

      // Run migration for existing installations
      await migrateBuiltinCommands();
    } catch (error) {
      console.error('Failed to initialize logs:', (error as Error).message);
    }
  }

  // Writes only the bot makes need its x-bot-secret when DASHBOARD_INTERNAL_SECRET
  // is set (read once, here). The browser pages cannot hold the secret, so routes
  // they also call (chat relay, test alerts, command log, song skip from the song
  // player overlay, ...) rely on sameOriginGuard instead.
  const botOnly = requireBotSecret(process.env.DASHBOARD_INTERNAL_SECRET);
  app.post(['/api/redemptions', '/api/eventsub-events', '/api/update-state', '/api/hype/trigger', '/api/tts/generate'], botOnly);
  // Dashboard pages may also make the admin writes on these otherwise bot-only
  // routes (see allowDashboardPages): loyalty settings and point edits, and every
  // song queue action except adding a song (the bot charges points for that).
  // Points-earning loyalty routes (award, add, deduct, gamba, duel) stay bot-only.
  const botOrDashboard = allowDashboardPages(botOnly);
  app.use('/api/loyalty', (req: Request, res: Response, next: NextFunction) => {
    const isAdminEdit = (req.method === 'PUT' && /^\/config\/?$/i.test(req.path)) ||
      (req.method === 'PUT' && /^\/user\/[^/]+\/points\/?$/i.test(req.path));
    (isAdminEdit ? botOrDashboard : botOnly)(req, res, next);
  });
  app.use('/api/song-queue', (req: Request, res: Response, next: NextFunction) => {
    // The song player overlay skips finished songs without an Origin check of its own
    const isOverlaySkip = req.method === 'POST' && /^\/skip\/?$/i.test(req.path);
    if (isOverlaySkip) return next();
    const isAdd = req.method === 'POST' && /^\/add\/?$/i.test(req.path);
    (isAdd ? botOnly : botOrDashboard)(req, res, next);
  });

  // Routes
  const broadcast = state.broadcastState;
  app.use('/api', createApiRouter(paths, envPath));
  // TTS settings saved on the Settings page apply to this process right away
  app.use('/api/config', createConfigRouter(envPath, {
    environmentKeys: options.environmentKeys,
    onChange: () => ttsService.reconfigure(process.env)
  }));
  app.use('/api/filters', createFiltersRouter(envPath));
  app.use('/api/alerts', createAlertsRouter(paths.alertConfigFile));
  app.use('/api/uploads', createUploadsRouter(uploadsDir));
  app.use('/obs', createObsRouter(paths));

  // Phase 2/3 Feature Routes
  const loyaltyRouter = createLoyaltyRouter(logsDir, broadcast);
  app.use('/api/loyalty', loyaltyRouter);
  app.use('/api/quotes', createQuotesRouter(logsDir, broadcast));
  app.use('/api/counters', createCountersRouter(logsDir, broadcast));
  app.use('/api/backup', createBackupRouter(logsDir));
  app.use('/api/song-queue', createSongQueueRouter(logsDir, state, () => void loyaltyRouter.publish()));

  // Health check
  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  // Global error handler
  app.use(errorHandler);

  // WebSocket connection handler
  wss.on('connection', (ws) => {
    console.log('Dashboard client connected');
    ws.send(JSON.stringify({ type: 'state', data: state.getBotState() }));
    ws.on('close', () => console.log('Dashboard client disconnected'));
  });

  // Create data files and the TTS cache before serving
  function init(): Promise<unknown> {
    return Promise.all([initLogs(), options.initTts === false ? null : ttsService.initialize()]);
  }

  // Stop timers and close the HTTP and WebSocket servers
  async function close(): Promise<void> {
    loyaltyRouter.stop();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    if (server.listening) {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }

  return { app, server, wss, paths, init, close };
}
