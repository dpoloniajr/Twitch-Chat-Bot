/**
 * Dashboard API Routes for Backup/Restore and Analytics
 */

import express, { type Router } from 'express';
import * as path from 'path';
import * as fsSync from 'fs';
import { withCrossProcessLock, writeFileAtomic } from '../../lib/file-lock';

const fs = fsSync.promises;

/** Backup file metadata block */
export interface BackupMetadata {
  version: string;
  createdAt: string;
  /** Keys of the data sections the backup holds */
  includes: string[];
  [key: string]: unknown;
}

/** A backup file: metadata plus one parsed JSON section per included data file */
export interface BackupData {
  metadata: BackupMetadata;
  [key: string]: unknown;
}

/** An entry of GET /list */
export interface BackupListEntry {
  filename: string;
  createdAt: string;
  size: number;
  includes: string[];
}

/** Counters for one hour of analytics.json */
export interface HourlyStats {
  /** ISO timestamp of the hour start */
  hour: string;
  commands: number;
  uniqueUsers: number;
  messages: number;
  follows?: number;
  subscriptions?: number;
  bits?: number;
  [key: string]: unknown;
}

/** Per-command counters in analytics.json */
export interface CommandStats {
  name: string;
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  uniqueUsers: number;
  averageResponseTime?: number;
  lastUsed?: string;
  [key: string]: unknown;
}

/** A recorded stream session */
export interface StreamSession {
  durationMinutes?: number;
  [key: string]: unknown;
}

/** Shape of analytics.json */
export interface AnalyticsData {
  commandExecutions?: unknown[];
  hourlyStats?: Record<string, HourlyStats>;
  commandStats?: Record<string, CommandStats>;
  streamSessions?: StreamSession[];
  config?: Record<string, unknown>;
  savedAt?: string;
  [key: string]: unknown;
}

/** One day of GET /analytics/daily */
interface DailyStats {
  date: string;
  commands: number;
  messages: number;
  follows: number;
  subscriptions: number;
  bits: number;
}

/**
 * Build the /api/backup router: backups live in `<logsDir>/../backups`,
 * analytics in `<logsDir>/analytics.json`.
 */
export function createBackupRouter(logsDir: string): Router {
  const router = express.Router();
  const backupsDir = path.join(logsDir, '..', 'backups');
  const analyticsFile = path.join(logsDir, 'analytics.json');

  /**
   * Resolve a backup file name from the URL to its path in backupsDir, or null
   * when it is not a bare `*.json` file name (e.g. a decoded "../" traversal).
   */
  const backupPath = (filename: string): string | null => {
    if (!filename.endsWith('.json') || filename !== path.basename(filename) || /[\\/\0]/.test(filename)) {
      return null;
    }
    return path.join(backupsDir, filename);
  };

  // Ensure backups directory exists
  const ensureBackupsDir = async (): Promise<void> => {
    try {
      await fs.mkdir(backupsDir, { recursive: true });
    } catch {
      // Directory exists
    }
  };

  // ==================== Backup Routes ====================

  // GET /api/backup/list - List all backups
  router.get('/list', async (req, res, next) => {
    try {
      await ensureBackupsDir();

      const files = await fs.readdir(backupsDir);
      const backups: BackupListEntry[] = [];

      for (const filename of files.filter(f => f.endsWith('.json'))) {
        const filePath = path.join(backupsDir, filename);
        const stats = await fs.stat(filePath);

        try {
          const content = await fs.readFile(filePath, 'utf-8');
          const data = JSON.parse(content) as Partial<BackupData> | null;
          backups.push({
            filename,
            createdAt: data!.metadata?.createdAt || stats.mtime.toISOString(),
            size: stats.size,
            includes: data!.metadata?.includes || []
          });
        } catch {
          backups.push({
            filename,
            createdAt: stats.mtime.toISOString(),
            size: stats.size,
            includes: []
          });
        }
      }

      backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      res.json(backups);
    } catch (error) {
      next(error);
    }
  });

  // POST /api/backup/create - Create a new backup
  router.post('/create', async (req, res, next) => {
    try {
      await ensureBackupsDir();

      // A body-less request (no JSON content type) leaves req.body undefined: back up everything
      const options = ((req.body as { options?: Record<string, unknown> } | undefined)?.options || {});
      const backup: BackupData = {
        metadata: {
          version: '1.0.0',
          createdAt: new Date().toISOString(),
          includes: []
        }
      };

      const filesToBackup = [
        { key: 'customCommands', file: 'customCommands.json', option: 'includeCustomCommands' },
        { key: 'builtinCommands', file: 'builtinCommands.json', option: 'includeBuiltinCommands' },
        { key: 'announcements', file: 'announcements.json', option: 'includeAnnouncements' },
        { key: 'filters', file: 'filters.json', option: 'includeFilters' },
        { key: 'loyalty', file: 'loyalty.json', option: 'includeLoyalty' },
        { key: 'quotes', file: 'quotes.json', option: 'includeQuotes' },
        { key: 'counters', file: 'counters.json', option: 'includeCounters' },
        { key: 'alertConfig', file: 'alert-config.json', option: 'includeAlertConfig' },
        { key: 'obsConfig', file: 'obs-config.json', option: 'includeObsConfig' }
      ];

      for (const item of filesToBackup) {
        if (options[item.option] === false) continue;

        const filePath = path.join(logsDir, item.file);
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          backup[item.key] = JSON.parse(content);
          backup.metadata.includes.push(item.key);
        } catch {
          // File doesn't exist, skip
        }
      }

      // Generate filename
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `backup-${timestamp}.json`;
      const filePath = path.join(backupsDir, filename);

      await fs.writeFile(filePath, JSON.stringify(backup, null, 2));

      res.json({
        success: true,
        filename,
        includes: backup.metadata.includes
      });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/backup/:filename - Download a backup
  router.get('/:filename', async (req, res, next) => {
    try {
      const filePath = backupPath(req.params.filename);
      if (!filePath) {
        res.status(400).json({ error: 'Invalid filename' });
        return;
      }

      if (!fsSync.existsSync(filePath)) {
        res.status(404).json({ error: 'Backup not found' });
        return;
      }

      const content = await fs.readFile(filePath, 'utf-8');
      res.json(JSON.parse(content));
    } catch (error) {
      next(error);
    }
  });

  // POST /api/backup/restore - Restore from backup
  router.post('/restore', async (req, res, next) => {
    try {
      const { backup, selections, overwrite = true } = (req.body || {}) as {
        backup?: BackupData;
        selections?: string[];
        overwrite?: boolean;
      };

      if (!backup || !backup.metadata) {
        res.status(400).json({ error: 'Invalid backup data' });
        return;
      }

      const restored: string[] = [];
      const errors: string[] = [];

      const filesToRestore = [
        { key: 'customCommands', file: 'customCommands.json' },
        { key: 'builtinCommands', file: 'builtinCommands.json' },
        { key: 'announcements', file: 'announcements.json' },
        { key: 'filters', file: 'filters.json' },
        { key: 'loyalty', file: 'loyalty.json' },
        { key: 'quotes', file: 'quotes.json' },
        { key: 'counters', file: 'counters.json' },
        { key: 'alertConfig', file: 'alert-config.json' },
        { key: 'obsConfig', file: 'obs-config.json' }
      ];

      for (const item of filesToRestore) {
        // Skip if not in selections
        if (selections && !selections.includes(item.key)) continue;

        // Skip sections the backup does not have
        const section = backup[item.key];
        if (section === undefined) continue;

        const filePath = path.join(logsDir, item.file);

        // Every data file holds a JSON object or array; anything else ('' / 0 / null)
        // would leave an unreadable file, so it is reported instead of written
        if (typeof section !== 'object' || section === null) {
          errors.push(item.key);
          continue;
        }

        try {
          // Check if file exists and overwrite is false
          if (!overwrite) {
            try {
              await fs.access(filePath);
              continue; // File exists, skip
            } catch {
              // File doesn't exist, proceed
            }
          }

          // Same lock the bot's managers take for these files
          await withCrossProcessLock(filePath, () =>
            writeFileAtomic(filePath, JSON.stringify(section, null, 2))
          );
          restored.push(item.key);
        } catch (error) {
          errors.push(item.key);
        }
      }

      res.json({ success: true, restored, errors });
    } catch (error) {
      next(error);
    }
  });

  // DELETE /api/backup/:filename - Delete a backup
  router.delete('/:filename', async (req, res, next) => {
    try {
      const filePath = backupPath(req.params.filename);
      if (!filePath) {
        res.status(400).json({ error: 'Invalid filename' });
        return;
      }

      if (!fsSync.existsSync(filePath)) {
        res.status(404).json({ error: 'Backup not found' });
        return;
      }

      await fs.unlink(filePath);
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/backup/upload - Upload and restore a backup file
  router.post('/upload', async (req, res, next) => {
    try {
      const { backup } = (req.body || {}) as { backup?: BackupData };

      if (!backup || !backup.metadata) {
        res.status(400).json({ error: 'Invalid backup data' });
        return;
      }

      // Save the uploaded backup
      await ensureBackupsDir();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `uploaded-${timestamp}.json`;
      const filePath = path.join(backupsDir, filename);

      await fs.writeFile(filePath, JSON.stringify(backup, null, 2));

      res.json({
        success: true,
        filename,
        metadata: backup.metadata
      });
    } catch (error) {
      next(error);
    }
  });

  // ==================== Analytics Routes ====================

  // Initialize analytics file
  const initAnalytics = async (): Promise<void> => {
    try {
      await fs.access(analyticsFile);
    } catch {
      await fs.writeFile(analyticsFile, JSON.stringify({
        commandExecutions: [],
        hourlyStats: {},
        commandStats: {},
        streamSessions: [],
        config: {
          retentionDays: 30,
          sampleRate: 1,
          trackCommands: true,
          trackMessages: true,
          trackViewers: true
        },
        savedAt: new Date().toISOString()
      }, null, 2));
    }
  };

  // Read analytics
  const readAnalytics = async (): Promise<AnalyticsData> => {
    await initAnalytics();
    const content = await fs.readFile(analyticsFile, 'utf-8');
    return JSON.parse(content) as AnalyticsData;
  };

  // Write analytics atomically (callers hold the file's lock for the read-modify-write)
  const writeAnalytics = async (data: AnalyticsData): Promise<void> => {
    data.savedAt = new Date().toISOString();
    await writeFileAtomic(analyticsFile, JSON.stringify(data, null, 2));
  };

  // GET /api/backup/analytics/summary - Get analytics summary
  router.get('/analytics/summary', async (req, res, next) => {
    try {
      const data = await readAnalytics();

      let totalCommands = 0;
      let totalMessages = 0;
      let totalFollows = 0;
      let totalSubscriptions = 0;
      let totalBits = 0;

      for (const stats of Object.values(data.hourlyStats || {})) {
        totalCommands += stats.commands || 0;
        totalMessages += stats.messages || 0;
        totalFollows += stats.follows || 0;
        totalSubscriptions += stats.subscriptions || 0;
        totalBits += stats.bits || 0;
      }

      const sessions = data.streamSessions || [];
      const totalStreamMinutes = sessions.reduce((sum, s) => sum + (s.durationMinutes || 0), 0);

      const topCommands = Object.entries(data.commandStats || {})
        .sort((a, b) => (b[1].totalExecutions || 0) - (a[1].totalExecutions || 0))
        .slice(0, 10)
        .map(([name, stats]) => ({
          name,
          count: stats.totalExecutions || 0,
          successRate: stats.totalExecutions > 0
            ? Math.round((stats.successfulExecutions / stats.totalExecutions) * 100)
            : 0
        }));

      res.json({
        totalCommands,
        totalMessages,
        totalFollows,
        totalSubscriptions,
        totalBits,
        totalStreamSessions: sessions.length,
        totalStreamMinutes,
        averageSessionDuration: sessions.length > 0
          ? Math.round(totalStreamMinutes / sessions.length)
          : 0,
        topCommands
      });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/backup/analytics/daily - Get daily statistics
  router.get('/analytics/daily', async (req, res, next) => {
    try {
      const days = parseInt(req.query.days as string) || 7;
      const data = await readAnalytics();

      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      const startStr = startDate.toISOString();

      const dailyStats: Record<string, DailyStats> = {};

      for (const [, stats] of Object.entries(data.hourlyStats || {})) {
        if (stats.hour < startStr) continue;

        const dateKey = stats.hour.substring(0, 10);
        if (!dailyStats[dateKey]) {
          dailyStats[dateKey] = {
            date: dateKey,
            commands: 0,
            messages: 0,
            follows: 0,
            subscriptions: 0,
            bits: 0
          };
        }

        dailyStats[dateKey].commands += stats.commands || 0;
        dailyStats[dateKey].messages += stats.messages || 0;
        dailyStats[dateKey].follows += stats.follows || 0;
        dailyStats[dateKey].subscriptions += stats.subscriptions || 0;
        dailyStats[dateKey].bits += stats.bits || 0;
      }

      const result = Object.values(dailyStats).sort((a, b) =>
        a.date.localeCompare(b.date)
      );

      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/backup/analytics/commands - Get command statistics
  router.get('/analytics/commands', async (req, res, next) => {
    try {
      const limit = parseInt(req.query.limit as string) || 20;
      const data = await readAnalytics();

      const commands = Object.entries(data.commandStats || {})
        .map(([name, stats]) => ({
          name,
          totalExecutions: stats.totalExecutions || 0,
          successfulExecutions: stats.successfulExecutions || 0,
          failedExecutions: stats.failedExecutions || 0,
          successRate: stats.totalExecutions > 0
            ? Math.round((stats.successfulExecutions / stats.totalExecutions) * 100)
            : 0,
          averageResponseTime: stats.averageResponseTime || 0,
          lastUsed: stats.lastUsed
        }))
        .sort((a, b) => b.totalExecutions - a.totalExecutions)
        .slice(0, limit);

      res.json(commands);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/backup/analytics/sessions - Get stream sessions
  router.get('/analytics/sessions', async (req, res, next) => {
    try {
      const limit = parseInt(req.query.limit as string) || 10;
      const data = await readAnalytics();

      const sessions = (data.streamSessions || [])
        .slice(-limit)
        .reverse();

      res.json(sessions);
    } catch (error) {
      next(error);
    }
  });

  // POST /api/backup/analytics/track - Track an event
  router.post('/analytics/track', async (req, res, next) => {
    try {
      const { type, data: eventData } = (req.body || {}) as {
        type?: string;
        data?: { command?: string; success?: boolean; amount?: number };
      };
      // Concurrent track calls must not lose updates
      await withCrossProcessLock(analyticsFile, async () => {
        const analyticsData = await readAnalytics();

        const hourKey = new Date().toISOString().substring(0, 13) + ':00:00.000Z';

        if (!analyticsData.hourlyStats) analyticsData.hourlyStats = {};
        if (!analyticsData.hourlyStats[hourKey]) {
          analyticsData.hourlyStats[hourKey] = {
            hour: hourKey,
            commands: 0,
            uniqueUsers: 0,
            messages: 0
          };
        }

        const hourly = analyticsData.hourlyStats[hourKey];

        switch (type) {
          case 'command':
            hourly.commands++;
            if (eventData?.command) {
              if (!analyticsData.commandStats) analyticsData.commandStats = {};
              const cmd = eventData.command.toLowerCase();
              if (!analyticsData.commandStats[cmd]) {
                analyticsData.commandStats[cmd] = {
                  name: cmd,
                  totalExecutions: 0,
                  successfulExecutions: 0,
                  failedExecutions: 0,
                  uniqueUsers: 0
                };
              }
              analyticsData.commandStats[cmd].totalExecutions++;
              if (eventData.success) {
                analyticsData.commandStats[cmd].successfulExecutions++;
              } else {
                analyticsData.commandStats[cmd].failedExecutions++;
              }
              analyticsData.commandStats[cmd].lastUsed = new Date().toISOString();
            }
            break;
          case 'message':
            hourly.messages++;
            break;
          case 'follow':
            hourly.follows = (hourly.follows || 0) + 1;
            break;
          case 'subscription':
            hourly.subscriptions = (hourly.subscriptions || 0) + 1;
            break;
          case 'bits':
            hourly.bits = (hourly.bits || 0) + (eventData?.amount || 0);
            break;
        }

        await writeAnalytics(analyticsData);
      });
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
