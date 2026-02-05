/**
 * Tests for Backup Manager
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  BackupManager,
  BackupData,
  getBackupManager,
  resetBackupManager,
} from '../../src/services/backup';

// Mock fs module
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  readdirSync: jest.fn(),
  statSync: jest.fn(),
  mkdirSync: jest.fn(),
  unlinkSync: jest.fn(),
}));

const mockFs = fs as jest.Mocked<typeof fs>;

describe('BackupManager', () => {
  let manager: BackupManager;
  const testLogsDir = '/test/logs';

  beforeEach(() => {
    jest.clearAllMocks();
    resetBackupManager();
    manager = new BackupManager(testLogsDir);
  });

  describe('createBackup', () => {
    it('should create backup with all default options', async () => {
      // Mock file reads
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation((filePath: fs.PathLike | number) => {
        const fileStr = String(filePath);
        if (fileStr.includes('customCommands.json')) {
          return JSON.stringify([{ name: '!test', response: 'Test response' }]);
        }
        if (fileStr.includes('builtinCommands.json')) {
          return JSON.stringify([{ name: '!clip', cooldown: 60 }]);
        }
        if (fileStr.includes('announcements.json')) {
          return JSON.stringify([{ text: 'Follow the stream!' }]);
        }
        if (fileStr.includes('filters.json')) {
          return JSON.stringify({ words: ['badword'], enabled: true });
        }
        if (fileStr.includes('loyalty.json')) {
          return JSON.stringify({ config: { enabled: true }, users: {} });
        }
        if (fileStr.includes('quotes.json')) {
          return JSON.stringify({ config: {}, quotes: [{ id: 1, text: 'Quote' }] });
        }
        if (fileStr.includes('counters.json')) {
          return JSON.stringify({ config: {}, counters: { deaths: 0 } });
        }
        if (fileStr.includes('alert-config.json')) {
          return JSON.stringify({ enabled: true });
        }
        if (fileStr.includes('obs-config.json')) {
          return JSON.stringify({ overlays: {} });
        }
        return '{}';
      });

      const backup = await manager.createBackup();

      expect(backup.metadata.version).toBe('1.0.0');
      expect(backup.metadata.createdAt).toBeDefined();
      expect(backup.customCommands).toBeDefined();
      expect(backup.builtinCommands).toBeDefined();
      expect(backup.announcements).toBeDefined();
      expect(backup.filters).toBeDefined();
      expect(backup.metadata.includes).toContain('customCommands');
      expect(backup.metadata.includes).toContain('builtinCommands');
    });

    it('should skip files that do not exist', async () => {
      mockFs.existsSync.mockReturnValue(false);

      const backup = await manager.createBackup();

      expect(backup.metadata.includes).toHaveLength(0);
      expect(backup.customCommands).toBeUndefined();
    });

    it('should respect export options', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ data: 'test' }));

      const backup = await manager.createBackup({
        includeCustomCommands: true,
        includeBuiltinCommands: false,
        includeAnnouncements: false,
        includeFilters: false,
        includeLoyalty: false,
        includeQuotes: false,
        includeCounters: false,
        includeAlertConfig: false,
        includeObsConfig: false,
      });

      expect(backup.customCommands).toBeDefined();
      expect(backup.builtinCommands).toBeUndefined();
      expect(backup.announcements).toBeUndefined();
    });

    it('should handle JSON parse errors gracefully', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('invalid json');

      const backup = await manager.createBackup();

      // Should not include files that failed to parse
      expect(backup.metadata.includes).toHaveLength(0);
    });

    it('should exclude loyalty users by default', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation((filePath: fs.PathLike | number) => {
        const fileStr = String(filePath);
        if (fileStr.includes('loyalty.json')) {
          return JSON.stringify({
            config: { enabled: true },
            users: { user1: { points: 100 } },
          });
        }
        return '{}';
      });

      const backup = await manager.createBackup({
        includeLoyalty: true,
        includeLoyaltyUsers: false,
      });

      expect(backup.loyalty?.config).toBeDefined();
      expect(backup.loyalty?.users).toBeUndefined();
    });

    it('should include loyalty users when requested', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation((filePath: fs.PathLike | number) => {
        const fileStr = String(filePath);
        if (fileStr.includes('loyalty.json')) {
          return JSON.stringify({
            config: { enabled: true },
            users: { user1: { points: 100 } },
          });
        }
        return '{}';
      });

      const backup = await manager.createBackup({
        includeLoyalty: true,
        includeLoyaltyUsers: true,
      });

      expect(backup.loyalty?.users).toBeDefined();
      expect(backup.metadata.includes).toContain('loyaltyUsers');
    });
  });

  describe('restoreBackup', () => {
    const sampleBackup: BackupData = {
      metadata: {
        version: '1.0.0',
        createdAt: new Date().toISOString(),
        includes: ['customCommands', 'builtinCommands', 'filters'],
      },
      customCommands: [{ name: '!test', response: 'Test' }],
      builtinCommands: [{ name: '!clip', cooldown: 60 }],
      filters: {
        words: ['badword'],
        settings: { enabled: true },
      },
    };

    it('should restore all included items', async () => {
      mockFs.writeFileSync.mockReturnValue(undefined);

      const result = await manager.restoreBackup(sampleBackup);

      expect(result.restored).toContain('customCommands');
      expect(result.restored).toContain('builtinCommands');
      expect(result.restored).toContain('filters');
      expect(result.errors).toHaveLength(0);
      expect(mockFs.writeFileSync).toHaveBeenCalledTimes(3);
    });

    it('should respect selections', async () => {
      mockFs.writeFileSync.mockReturnValue(undefined);

      const result = await manager.restoreBackup(sampleBackup, {
        selections: ['customCommands'],
      });

      expect(result.restored).toContain('customCommands');
      expect(result.restored).not.toContain('builtinCommands');
      expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);
    });

    it('should handle write errors', async () => {
      mockFs.writeFileSync.mockImplementation(() => {
        throw new Error('Write failed');
      });

      const result = await manager.restoreBackup(sampleBackup);

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.restored).toHaveLength(0);
    });

    it('should skip items not in backup', async () => {
      mockFs.writeFileSync.mockReturnValue(undefined);

      const minimalBackup: BackupData = {
        metadata: {
          version: '1.0.0',
          createdAt: new Date().toISOString(),
          includes: ['customCommands'],
        },
        customCommands: [{ name: '!test' }],
      };

      const result = await manager.restoreBackup(minimalBackup);

      expect(result.restored).toContain('customCommands');
      expect(result.restored).not.toContain('filters');
    });

    it('should restore loyalty with merged data', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ existingData: true }));
      mockFs.writeFileSync.mockReturnValue(undefined);

      const loyaltyBackup: BackupData = {
        metadata: {
          version: '1.0.0',
          createdAt: new Date().toISOString(),
          includes: ['loyalty'],
        },
        loyalty: {
          config: { enabled: true, pointsPerMessage: 10 },
        },
      };

      const result = await manager.restoreBackup(loyaltyBackup);

      expect(result.restored).toContain('loyalty');
    });

    it('should update nextId when restoring quotes', async () => {
      mockFs.existsSync.mockReturnValue(false);
      mockFs.writeFileSync.mockReturnValue(undefined);

      const quotesBackup: BackupData = {
        metadata: {
          version: '1.0.0',
          createdAt: new Date().toISOString(),
          includes: ['quotes', 'quotesData'],
        },
        quotes: {
          config: {},
          quotes: [
            { id: 1, text: 'Quote 1' },
            { id: 5, text: 'Quote 5' },
            { id: 3, text: 'Quote 3' },
          ],
        },
      };

      await manager.restoreBackup(quotesBackup);

      const writeCall = mockFs.writeFileSync.mock.calls[0];
      const writtenData = JSON.parse(writeCall[1] as string);

      expect(writtenData.nextId).toBe(6); // max(1,5,3) + 1
    });
  });

  describe('saveBackupToFile', () => {
    it('should save backup to file', () => {
      mockFs.existsSync.mockReturnValue(false);
      mockFs.mkdirSync.mockReturnValue(undefined);
      mockFs.writeFileSync.mockReturnValue(undefined);

      const backup: BackupData = {
        metadata: {
          version: '1.0.0',
          createdAt: new Date().toISOString(),
          includes: [],
        },
      };

      const filePath = manager.saveBackupToFile(backup);

      expect(filePath).toContain('backup-');
      expect(filePath).toContain('.json');
      expect(mockFs.writeFileSync).toHaveBeenCalled();
    });

    it('should create backup directory if not exists', () => {
      mockFs.existsSync.mockReturnValue(false);
      mockFs.mkdirSync.mockReturnValue(undefined);
      mockFs.writeFileSync.mockReturnValue(undefined);

      const backup: BackupData = {
        metadata: {
          version: '1.0.0',
          createdAt: new Date().toISOString(),
          includes: [],
        },
      };

      manager.saveBackupToFile(backup);

      expect(mockFs.mkdirSync).toHaveBeenCalledWith(
        expect.any(String),
        { recursive: true }
      );
    });

    it('should use custom filename if provided', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.writeFileSync.mockReturnValue(undefined);

      const backup: BackupData = {
        metadata: {
          version: '1.0.0',
          createdAt: new Date().toISOString(),
          includes: [],
        },
      };

      const filePath = manager.saveBackupToFile(backup, 'custom-backup.json');

      expect(filePath).toContain('custom-backup.json');
    });
  });

  describe('loadBackupFromFile', () => {
    it('should load valid backup file', () => {
      const validBackup: BackupData = {
        metadata: {
          version: '1.0.0',
          createdAt: new Date().toISOString(),
          includes: ['customCommands'],
        },
        customCommands: [{ name: '!test' }],
      };

      mockFs.readFileSync.mockReturnValue(JSON.stringify(validBackup));

      const loaded = manager.loadBackupFromFile('/path/to/backup.json');

      expect(loaded.metadata.version).toBe('1.0.0');
      expect(loaded.customCommands).toHaveLength(1);
    });

    it('should throw error for invalid backup format', () => {
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ invalid: true }));

      expect(() => {
        manager.loadBackupFromFile('/path/to/invalid.json');
      }).toThrow('Invalid backup file format');
    });

    it('should throw error for invalid JSON', () => {
      mockFs.readFileSync.mockReturnValue('not valid json');

      expect(() => {
        manager.loadBackupFromFile('/path/to/bad.json');
      }).toThrow();
    });
  });

  describe('listBackups', () => {
    it('should return empty array if no backup directory', () => {
      mockFs.existsSync.mockReturnValue(false);

      const backups = manager.listBackups();

      expect(backups).toHaveLength(0);
    });

    it('should list backup files', () => {
      mockFs.existsSync.mockReturnValue(true);
      (mockFs.readdirSync as jest.Mock).mockReturnValue([
        'backup-2024-01-01.json',
        'backup-2024-01-02.json',
        'not-a-backup.txt',
      ]);

      mockFs.statSync.mockReturnValue({
        size: 1024,
        mtime: new Date('2024-01-01'),
      } as fs.Stats);

      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({
          metadata: { createdAt: '2024-01-01T00:00:00.000Z' },
        })
      );

      const backups = manager.listBackups();

      expect(backups).toHaveLength(2); // Only .json files
      expect(backups[0].filename).toBe('backup-2024-01-01.json');
      expect(backups[0].size).toBe(1024);
    });

    it('should handle parse errors when reading backup metadata', () => {
      mockFs.existsSync.mockReturnValue(true);
      (mockFs.readdirSync as jest.Mock).mockReturnValue(['backup.json']);
      mockFs.statSync.mockReturnValue({
        size: 1024,
        mtime: new Date('2024-01-01'),
      } as fs.Stats);
      mockFs.readFileSync.mockReturnValue('invalid json');

      const backups = manager.listBackups();

      expect(backups).toHaveLength(1);
      // Should fall back to file mtime
      expect(backups[0].createdAt).toBeDefined();
    });
  });

  describe('deleteBackup', () => {
    it('should delete existing backup', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.unlinkSync.mockReturnValue(undefined);

      const result = manager.deleteBackup('backup.json');

      expect(result).toBe(true);
      expect(mockFs.unlinkSync).toHaveBeenCalled();
    });

    it('should return false for non-existent backup', () => {
      mockFs.existsSync.mockReturnValue(false);

      const result = manager.deleteBackup('nonexistent.json');

      expect(result).toBe(false);
      expect(mockFs.unlinkSync).not.toHaveBeenCalled();
    });
  });

  describe('singleton management', () => {
    it('should return same instance', () => {
      const manager1 = getBackupManager(testLogsDir);
      const manager2 = getBackupManager();

      expect(manager1).toBe(manager2);
    });

    it('should reset singleton', () => {
      const manager1 = getBackupManager(testLogsDir);
      resetBackupManager();
      const manager2 = getBackupManager(testLogsDir);

      expect(manager1).not.toBe(manager2);
    });
  });
});
