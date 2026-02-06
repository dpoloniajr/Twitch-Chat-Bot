/**
 * Settings Import/Export System
 * Backup and restore bot configuration
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/logger';

const logger = createLogger('Backup');

/**
 * Backup metadata
 */
export interface BackupMetadata {
  version: string;
  createdAt: string;
  botName?: string;
  channels?: string[];
  includes: string[];
}

/**
 * Full backup data structure
 */
export interface BackupData {
  metadata: BackupMetadata;
  customCommands?: unknown[];
  builtinCommands?: unknown[];
  announcements?: unknown[];
  filters?: {
    words: string[];
    settings: Record<string, unknown>;
  };
  loyalty?: {
    config: Record<string, unknown>;
    users?: Record<string, unknown>;
  };
  quotes?: {
    config: Record<string, unknown>;
    quotes?: unknown[];
  };
  counters?: {
    config: Record<string, unknown>;
    counters?: Record<string, unknown>;
  };
  alertConfig?: Record<string, unknown>;
  obsConfig?: Record<string, unknown>;
}

/**
 * Export options
 */
export interface ExportOptions {
  includeCustomCommands?: boolean;
  includeBuiltinCommands?: boolean;
  includeAnnouncements?: boolean;
  includeFilters?: boolean;
  includeLoyalty?: boolean;
  includeLoyaltyUsers?: boolean;
  includeQuotes?: boolean;
  includeQuotesData?: boolean;
  includeCounters?: boolean;
  includeAlertConfig?: boolean;
  includeObsConfig?: boolean;
}

const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  includeCustomCommands: true,
  includeBuiltinCommands: true,
  includeAnnouncements: true,
  includeFilters: true,
  includeLoyalty: true,
  includeLoyaltyUsers: false, // User data can be large
  includeQuotes: true,
  includeQuotesData: true,
  includeCounters: true,
  includeAlertConfig: true,
  includeObsConfig: true,
};

/**
 * Backup manager class
 */
export class BackupManager {
  private logsDir: string;

  constructor(logsDir?: string) {
    this.logsDir = logsDir || path.join(process.cwd(), 'dashboard', 'logs');
  }

  /**
   * Read JSON file safely
   */
  private async readJsonFile(filename: string): Promise<unknown | null> {
    const filePath = path.join(this.logsDir, filename);
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(content);
      }
    } catch (error) {
      logger.warn(`Failed to read ${filename}`, {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
    return null;
  }

  /**
   * Write JSON file safely
   */
  private async writeJsonFile(filename: string, data: unknown): Promise<boolean> {
    const filePath = path.join(this.logsDir, filename);
    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      return true;
    } catch (error) {
      logger.error(`Failed to write ${filename}`, {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    }
  }

  /**
   * Create a backup of all settings
   */
  async createBackup(options: ExportOptions = {}): Promise<BackupData> {
    const opts = { ...DEFAULT_EXPORT_OPTIONS, ...options };
    const includes: string[] = [];

    const backup: BackupData = {
      metadata: {
        version: '1.0.0',
        createdAt: new Date().toISOString(),
        includes: [],
      },
    };

    // Custom commands
    if (opts.includeCustomCommands) {
      const data = await this.readJsonFile('customCommands.json');
      if (data) {
        backup.customCommands = data as unknown[];
        includes.push('customCommands');
      }
    }

    // Builtin commands
    if (opts.includeBuiltinCommands) {
      const data = await this.readJsonFile('builtinCommands.json');
      if (data) {
        backup.builtinCommands = data as unknown[];
        includes.push('builtinCommands');
      }
    }

    // Announcements
    if (opts.includeAnnouncements) {
      const data = await this.readJsonFile('announcements.json');
      if (data) {
        backup.announcements = data as unknown[];
        includes.push('announcements');
      }
    }

    // Filters
    if (opts.includeFilters) {
      const data = (await this.readJsonFile('filters.json')) as Record<string, unknown> | null;
      if (data) {
        backup.filters = {
          words: (data.words as string[]) || [],
          settings: data,
        };
        includes.push('filters');
      }
    }

    // Loyalty
    if (opts.includeLoyalty) {
      const data = (await this.readJsonFile('loyalty.json')) as Record<string, unknown> | null;
      if (data) {
        backup.loyalty = {
          config: (data.config as Record<string, unknown>) || {},
        };
        if (opts.includeLoyaltyUsers && data.users) {
          backup.loyalty.users = data.users as Record<string, unknown>;
        }
        includes.push('loyalty');
        if (opts.includeLoyaltyUsers) includes.push('loyaltyUsers');
      }
    }

    // Quotes
    if (opts.includeQuotes) {
      const data = (await this.readJsonFile('quotes.json')) as Record<string, unknown> | null;
      if (data) {
        backup.quotes = {
          config: (data.config as Record<string, unknown>) || {},
        };
        if (opts.includeQuotesData && data.quotes) {
          backup.quotes.quotes = data.quotes as unknown[];
        }
        includes.push('quotes');
        if (opts.includeQuotesData) includes.push('quotesData');
      }
    }

    // Counters
    if (opts.includeCounters) {
      const data = (await this.readJsonFile('counters.json')) as Record<string, unknown> | null;
      if (data) {
        backup.counters = {
          config: (data.config as Record<string, unknown>) || {},
          counters: (data.counters as Record<string, unknown>) || {},
        };
        includes.push('counters');
      }
    }

    // Alert config
    if (opts.includeAlertConfig) {
      const data = await this.readJsonFile('alert-config.json');
      if (data) {
        backup.alertConfig = data as Record<string, unknown>;
        includes.push('alertConfig');
      }
    }

    // OBS config
    if (opts.includeObsConfig) {
      const data = await this.readJsonFile('obs-config.json');
      if (data) {
        backup.obsConfig = data as Record<string, unknown>;
        includes.push('obsConfig');
      }
    }

    backup.metadata.includes = includes;
    logger.info('Backup created', { includes });

    return backup;
  }

  /**
   * Restore settings from backup
   */
  async restoreBackup(
    backup: BackupData,
    options?: {
      overwrite?: boolean;
      selections?: string[];
    }
  ): Promise<{ restored: string[]; errors: string[] }> {
    const restored: string[] = [];
    const errors: string[] = [];
    const overwrite = options?.overwrite ?? true;
    const selections = options?.selections;

    const shouldRestore = (key: string): boolean => {
      if (selections && !selections.includes(key)) return false;
      return backup.metadata.includes.includes(key);
    };

    // Custom commands
    if (shouldRestore('customCommands') && backup.customCommands) {
      if (overwrite) {
        if (await this.writeJsonFile('customCommands.json', backup.customCommands)) {
          restored.push('customCommands');
        } else {
          errors.push('customCommands');
        }
      }
    }

    // Builtin commands
    if (shouldRestore('builtinCommands') && backup.builtinCommands) {
      if (await this.writeJsonFile('builtinCommands.json', backup.builtinCommands)) {
        restored.push('builtinCommands');
      } else {
        errors.push('builtinCommands');
      }
    }

    // Announcements
    if (shouldRestore('announcements') && backup.announcements) {
      if (await this.writeJsonFile('announcements.json', backup.announcements)) {
        restored.push('announcements');
      } else {
        errors.push('announcements');
      }
    }

    // Filters
    if (shouldRestore('filters') && backup.filters) {
      if (await this.writeJsonFile('filters.json', backup.filters.settings)) {
        restored.push('filters');
      } else {
        errors.push('filters');
      }
    }

    // Loyalty
    if (shouldRestore('loyalty') && backup.loyalty) {
      const existingData = (await this.readJsonFile('loyalty.json')) as Record<string, unknown> | null;
      const newData: Record<string, unknown> = {
        ...(existingData || {}),
        config: backup.loyalty.config,
      };

      if (shouldRestore('loyaltyUsers') && backup.loyalty.users) {
        newData.users = backup.loyalty.users;
      }

      if (await this.writeJsonFile('loyalty.json', newData)) {
        restored.push('loyalty');
      } else {
        errors.push('loyalty');
      }
    }

    // Quotes
    if (shouldRestore('quotes') && backup.quotes) {
      const existingData = (await this.readJsonFile('quotes.json')) as Record<string, unknown> | null;
      const newData: Record<string, unknown> = {
        ...(existingData || {}),
        config: backup.quotes.config,
      };

      if (shouldRestore('quotesData') && backup.quotes.quotes) {
        newData.quotes = backup.quotes.quotes;
        // Update nextId
        const maxId = (backup.quotes.quotes as Array<{ id: number }>).reduce(
          (max, q) => Math.max(max, q.id || 0),
          0
        );
        newData.nextId = maxId + 1;
      }

      if (await this.writeJsonFile('quotes.json', newData)) {
        restored.push('quotes');
      } else {
        errors.push('quotes');
      }
    }

    // Counters
    if (shouldRestore('counters') && backup.counters) {
      const newData = {
        config: backup.counters.config,
        counters: backup.counters.counters,
        history: [],
      };

      if (await this.writeJsonFile('counters.json', newData)) {
        restored.push('counters');
      } else {
        errors.push('counters');
      }
    }

    // Alert config
    if (shouldRestore('alertConfig') && backup.alertConfig) {
      if (await this.writeJsonFile('alert-config.json', backup.alertConfig)) {
        restored.push('alertConfig');
      } else {
        errors.push('alertConfig');
      }
    }

    // OBS config
    if (shouldRestore('obsConfig') && backup.obsConfig) {
      if (await this.writeJsonFile('obs-config.json', backup.obsConfig)) {
        restored.push('obsConfig');
      } else {
        errors.push('obsConfig');
      }
    }

    logger.info('Backup restored', { restored, errors });

    return { restored, errors };
  }

  /**
   * Save backup to file
   */
  saveBackupToFile(backup: BackupData, filename?: string): string {
    const backupDir = path.join(this.logsDir, '..', 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const finalFilename =
      filename || `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const filePath = path.join(backupDir, finalFilename);

    fs.writeFileSync(filePath, JSON.stringify(backup, null, 2));
    logger.info('Backup saved to file', { path: filePath });

    return filePath;
  }

  /**
   * Load backup from file
   */
  loadBackupFromFile(filePath: string): BackupData {
    const content = fs.readFileSync(filePath, 'utf-8');
    const backup = JSON.parse(content) as BackupData;

    if (!backup.metadata || !backup.metadata.version) {
      throw new Error('Invalid backup file format');
    }

    return backup;
  }

  /**
   * List available backups
   */
  listBackups(): Array<{ filename: string; createdAt: string; size: number }> {
    const backupDir = path.join(this.logsDir, '..', 'backups');

    if (!fs.existsSync(backupDir)) {
      return [];
    }

    const files = fs.readdirSync(backupDir).filter((f) => f.endsWith('.json'));

    return files.map((filename) => {
      const filePath = path.join(backupDir, filename);
      const stats = fs.statSync(filePath);

      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(content) as BackupData;
        return {
          filename,
          createdAt: data.metadata?.createdAt || stats.mtime.toISOString(),
          size: stats.size,
        };
      } catch {
        return {
          filename,
          createdAt: stats.mtime.toISOString(),
          size: stats.size,
        };
      }
    });
  }

  /**
   * Delete a backup file
   */
  deleteBackup(filename: string): boolean {
    const backupDir = path.join(this.logsDir, '..', 'backups');
    const filePath = path.join(backupDir, filename);

    if (!fs.existsSync(filePath)) {
      return false;
    }

    fs.unlinkSync(filePath);
    logger.info('Backup deleted', { filename });
    return true;
  }
}

// Singleton
let defaultManager: BackupManager | null = null;

export function getBackupManager(logsDir?: string): BackupManager {
  if (!defaultManager) {
    defaultManager = new BackupManager(logsDir);
  }
  return defaultManager;
}

export function resetBackupManager(): void {
  defaultManager = null;
}
