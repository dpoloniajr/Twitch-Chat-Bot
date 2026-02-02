const fs = require('fs');
const path = require('path');
const { withCrossProcessLock } = require('./file-lock');

class EnvManager {
  constructor(envPath = process.env.ENV_PATH || '.env', backupDir = process.env.BACKUP_DIR || 'backups') {
    this.envPath = path.resolve(envPath);
    this.backupDir = path.resolve(backupDir);
    
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }
  }

  /**
   * Reads the current .env file and parses it into an object
   */
  async getEnv() {
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
   * Parses .env string into object
   */
  parseEnv(content) {
    const config = {};
    content.split('\n').forEach(line => {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
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
   * Updates specific keys in the .env file while preserving comments and order
   */
  async updateEnv(updates) {
    return await withCrossProcessLock(this.envPath, async () => {
      let content = '';
      if (fs.existsSync(this.envPath)) {
        content = fs.readFileSync(this.envPath, 'utf8');
      }

      let lines = content.split('\n');
      const updatedKeys = new Set();

      // Update existing keys
      lines = lines.map(line => {
        const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
        if (match) {
          const key = match[1];
          if (updates.hasOwnProperty(key)) {
            updatedKeys.add(key);
            return `${key}=${updates[key]}`;
          }
        }
        return line;
      });

      // Add new keys
      Object.keys(updates).forEach(key => {
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
   * Creates a backup of the current .env file
   */
  async createBackup() {
    if (!fs.existsSync(this.envPath)) {
      throw new Error('.env file does not exist');
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `.env.backup-${timestamp}`;
    const backupPath = path.join(this.backupDir, backupName);

    fs.copyFileSync(this.envPath, backupPath);
    return backupName;
  }

  /**
   * Lists all available backups
   */
  listBackups() {
    if (!fs.existsSync(this.backupDir)) return [];
    return fs.readdirSync(this.backupDir)
      .filter(file => file.startsWith('.env.backup-'))
      .map(file => {
        const stats = fs.statSync(path.join(this.backupDir, file));
        return {
          filename: file,
          createdAt: stats.mtime,
          size: stats.size
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Restores .env from a backup
   */
  async restoreBackup(backupName) {
    const backupPath = path.join(this.backupDir, backupName);
    if (!fs.existsSync(backupPath)) {
      throw new Error(`Backup ${backupName} not found`);
    }

    // Create a safety backup of current .env before restoring
    if (fs.existsSync(this.envPath)) {
      await this.createBackup();
    }

    return await withCrossProcessLock(this.envPath, async () => {
      fs.copyFileSync(backupPath, this.envPath);
    });
  }
}

module.exports = EnvManager;
