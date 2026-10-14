/**
 * Reads and updates the .env file in place, keeping comments and key order,
 * and manages timestamped backups of it.
 */

import * as fs from 'fs';
import * as path from 'path';
import { withCrossProcessLock } from './file-lock';
import { ValidationError } from './api-utils';

export type EnvValues = Record<string, string>;

export interface EnvBackup {
  filename: string;
  createdAt: Date;
  size: number;
}

/** `KEY=value` with optional spaces; keys may contain letters, digits, `_`, `.` and `-` */
const ENV_LINE = /^\s*([\w.-]+)\s*=\s*(.*)?\s*$/;
const BACKUP_PREFIX = '.env.backup-';

export class EnvManager {
  readonly envPath: string;
  readonly backupDir: string;

  constructor(envPath: string = process.env.ENV_PATH || '.env', backupDir: string = process.env.BACKUP_DIR || 'backups') {
    this.envPath = path.resolve(envPath);
    this.backupDir = path.resolve(backupDir);

    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }
  }

  /**
   * Read the current .env file as key/value pairs ({} when it does not exist).
   */
  async getEnv(): Promise<EnvValues> {
    try {
      if (!fs.existsSync(this.envPath)) return {};
      const content = fs.readFileSync(this.envPath, 'utf8');
      return this.parseEnv(content);
    } catch (error) {
      console.error('Error reading .env:', error);
      throw error;
    }
  }

  /**
   * Parse .env text into key/value pairs. Surrounding double quotes are removed
   * and values are trimmed; comments and other lines are ignored.
   */
  parseEnv(content: string): EnvValues {
    const config: EnvValues = {};
    content.split('\n').forEach((line) => {
      const match = line.match(ENV_LINE);
      if (match) {
        let value = match[2] || '';
        if (value.length > 0 && value.startsWith('"') && value.endsWith('"')) {
          value = value.substring(1, value.length - 1);
        }
        config[match[1]] = value.trim();
      }
    });
    return config;
  }

  /**
   * Set the given keys in the .env file, keeping comments and order. Existing
   * keys are replaced where they are; new keys are appended. Returns the new content.
   */
  async updateEnv(updates: Record<string, string | number | boolean>): Promise<string> {
    return await withCrossProcessLock(this.envPath, async () => {
      let content = '';
      if (fs.existsSync(this.envPath)) {
        content = fs.readFileSync(this.envPath, 'utf8');
      }

      let lines = content.split('\n');
      const updatedKeys = new Set<string>();

      lines = lines.map((line) => {
        const match = line.match(ENV_LINE);
        if (match) {
          const key = match[1];
          if (Object.prototype.hasOwnProperty.call(updates, key)) {
            updatedKeys.add(key);
            return `${key}=${updates[key]}`;
          }
        }
        return line;
      });

      Object.keys(updates).forEach((key) => {
        if (!updatedKeys.has(key)) {
          lines.push(`${key}=${updates[key]}`);
        }
      });

      const updatedContent = lines.join('\n');
      fs.writeFileSync(this.envPath, updatedContent);
      return updatedContent;
    });
  }

  /**
   * Copy the current .env into the backup folder and return the backup's file name.
   */
  async createBackup(): Promise<string> {
    if (!fs.existsSync(this.envPath)) {
      throw new Error('.env file does not exist');
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `${BACKUP_PREFIX}${timestamp}`;
    const backupPath = path.join(this.backupDir, backupName);

    fs.copyFileSync(this.envPath, backupPath);
    return backupName;
  }

  /**
   * True for a string that names a backup file directly inside the backup
   * folder: it has the backup prefix and no path separators.
   */
  static isBackupName(name: unknown): name is string {
    return typeof name === 'string' &&
      name.startsWith(BACKUP_PREFIX) &&
      !/[\\/]/.test(name);
  }

  /**
   * List backups, newest first.
   */
  listBackups(): EnvBackup[] {
    if (!fs.existsSync(this.backupDir)) return [];
    return fs.readdirSync(this.backupDir)
      .filter((file) => file.startsWith(BACKUP_PREFIX))
      .map((file) => {
        const stats = fs.statSync(path.join(this.backupDir, file));
        return {
          filename: file,
          createdAt: stats.mtime,
          size: stats.size
        };
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /**
   * Restore .env from a backup, first backing up the current file.
   * Only a bare backup file name (as listBackups() returns it) is accepted, so
   * no file outside the backup folder can be copied over .env.
   * @throws ValidationError (400) for any other name
   */
  async restoreBackup(backupName: string): Promise<void> {
    if (!EnvManager.isBackupName(backupName)) {
      throw new ValidationError(`Invalid backup name: ${String(backupName)}`);
    }
    const backupPath = path.join(this.backupDir, backupName);
    if (!fs.existsSync(backupPath)) {
      throw new Error(`Backup ${backupName} not found`);
    }

    if (fs.existsSync(this.envPath)) {
      await this.createBackup();
    }

    await withCrossProcessLock(this.envPath, async () => {
      fs.copyFileSync(backupPath, this.envPath);
    });
  }
}
