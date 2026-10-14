/**
 * Tests for src/lib/env-manager.ts (also loaded through the lib/env-manager.js shim)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EnvManager } from '../../src/lib/env-manager';

describe('EnvManager', () => {
  let dir: string;
  let envPath: string;
  let backupDir: string;
  let env: EnvManager;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-manager-'));
    envPath = path.join(dir, '.env');
    backupDir = path.join(dir, 'backups');
    env = new EnvManager(envPath, backupDir);
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('resolves paths and creates the backup folder', () => {
      expect(env.envPath).toBe(path.resolve(envPath));
      expect(fs.statSync(backupDir).isDirectory()).toBe(true);
    });

    it('defaults to ENV_PATH and BACKUP_DIR', () => {
      process.env.ENV_PATH = path.join(dir, 'custom.env');
      process.env.BACKUP_DIR = path.join(dir, 'custom-backups');
      const m = new EnvManager();
      expect(m.envPath).toBe(process.env.ENV_PATH);
      expect(m.backupDir).toBe(process.env.BACKUP_DIR);
      expect(fs.existsSync(process.env.BACKUP_DIR)).toBe(true);
    });

    it('falls back to .env and backups relative to the working folder', () => {
      delete process.env.ENV_PATH;
      delete process.env.BACKUP_DIR;
      const cwd = process.cwd();
      process.chdir(dir);
      try {
        const m = new EnvManager();
        expect(m.envPath).toBe(path.join(fs.realpathSync(dir), '.env'));
        expect(m.backupDir).toBe(path.join(fs.realpathSync(dir), 'backups'));
      } finally {
        process.chdir(cwd);
      }
    });
  });

  describe('parseEnv', () => {
    it('reads keys, strips double quotes and trims values', () => {
      expect(env.parseEnv('A=1\nB = two \nC="quoted value"\nD=\nE.F-G=x')).toEqual({
        A: '1', B: 'two', C: 'quoted value', D: '', 'E.F-G': 'x'
      });
    });

    it('ignores comments, blank lines and malformed lines', () => {
      expect(env.parseEnv('# A=1\n\nnot a pair\n=novalue\nB=2')).toEqual({ B: '2' });
    });

    it('handles CRLF line endings', () => {
      expect(env.parseEnv('A=1\r\nB="x"\r\n')).toEqual({ A: '1', B: 'x' });
    });

    it('keeps everything after the first = and leaves single quotes alone', () => {
      expect(env.parseEnv("URL=http://x/?a=b\nS='single'")).toEqual({ URL: 'http://x/?a=b', S: "'single'" });
    });

    it('lets a later duplicate key win', () => {
      expect(env.parseEnv('A=1\nA=2')).toEqual({ A: '2' });
    });

    it('does not strip a lone quote', () => {
      expect(env.parseEnv('A="')).toEqual({ A: '"' });
      expect(env.parseEnv('A="open')).toEqual({ A: '"open' });
    });
  });

  describe('getEnv', () => {
    it('returns {} when the file does not exist', async () => {
      await expect(env.getEnv()).resolves.toEqual({});
    });

    it('parses the file', async () => {
      fs.writeFileSync(envPath, '# comment\nPORT=3000\n');
      await expect(env.getEnv()).resolves.toEqual({ PORT: '3000' });
    });

    it('logs and rethrows read errors', async () => {
      fs.mkdirSync(envPath);
      const error = jest.spyOn(console, 'error').mockImplementation(() => {});
      await expect(env.getEnv()).rejects.toThrow();
      expect(error).toHaveBeenCalledWith('Error reading .env:', expect.anything());
    });
  });

  describe('updateEnv', () => {
    it('replaces existing keys in place and keeps comments and order', async () => {
      fs.writeFileSync(envPath, '# Top\nPORT=3000\n# Mid\nTOKEN=old\nOTHER=1\n');
      const content = await env.updateEnv({ TOKEN: 'new' });
      expect(content).toBe('# Top\nPORT=3000\n# Mid\nTOKEN=new\nOTHER=1\n');
      expect(fs.readFileSync(envPath, 'utf8')).toBe(content);
    });

    it('appends new keys after the existing content', async () => {
      fs.writeFileSync(envPath, 'A=1\n');
      await env.updateEnv({ B: 'two', C: 3, D: true });
      // The file ended with a newline, so the empty last line stays before the new keys
      expect(fs.readFileSync(envPath, 'utf8')).toBe('A=1\n\nB=two\nC=3\nD=true');
    });

    it('creates the file when it does not exist', async () => {
      await env.updateEnv({ A: '1' });
      // An empty file splits into one empty line, which is kept
      expect(fs.readFileSync(envPath, 'utf8')).toBe('\nA=1');
    });

    it('does not touch commented-out keys', async () => {
      fs.writeFileSync(envPath, '# TOKEN=commented\nTOKEN=live');
      await env.updateEnv({ TOKEN: 'next' });
      expect(fs.readFileSync(envPath, 'utf8')).toBe('# TOKEN=commented\nTOKEN=next');
    });

    it('replaces every copy of a duplicated key', async () => {
      fs.writeFileSync(envPath, 'A=1\nA=2');
      await env.updateEnv({ A: '3' });
      expect(fs.readFileSync(envPath, 'utf8')).toBe('A=3\nA=3');
    });

    it('keeps CRLF on untouched lines but writes replaced lines with LF', async () => {
      fs.writeFileSync(envPath, 'A=1\r\nB=2\r\n');
      await env.updateEnv({ A: 'x' });
      expect(fs.readFileSync(envPath, 'utf8')).toBe('A=x\nB=2\r\n');
    });

    it('does not treat inherited properties as updates', async () => {
      fs.writeFileSync(envPath, 'toString=1\nconstructor=2');
      await env.updateEnv({ OTHER: 'y' });
      expect(fs.readFileSync(envPath, 'utf8')).toBe('toString=1\nconstructor=2\nOTHER=y');
    });

    it('serialises concurrent updates so none are lost', async () => {
      fs.writeFileSync(envPath, '');
      await Promise.all(Array.from({ length: 10 }, (_, i) => env.updateEnv({ [`K${i}`]: String(i) })));
      const values = env.parseEnv(fs.readFileSync(envPath, 'utf8'));
      expect(Object.keys(values)).toHaveLength(10);
      expect(fs.existsSync(`${envPath}.lock`)).toBe(false);
    });

    it('releases the lock when the write fails', async () => {
      const readOnlyDir = path.join(dir, 'ro');
      fs.mkdirSync(readOnlyDir);
      const target = path.join(readOnlyDir, '.env');
      fs.mkdirSync(target); // a folder where the file should be: the write fails
      const m = new EnvManager(target, backupDir);
      await expect(m.updateEnv({ A: '1' })).rejects.toThrow();
      expect(fs.existsSync(`${target}.lock`)).toBe(false);
    });
  });

  describe('backups', () => {
    it('refuses to back up a missing .env', async () => {
      await expect(env.createBackup()).rejects.toThrow('.env file does not exist');
    });

    it('creates, lists and restores a backup, saving the current file first', async () => {
      fs.writeFileSync(envPath, 'A=original');
      const name = await env.createBackup();
      expect(name).toMatch(/^\.env\.backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
      expect(fs.readFileSync(path.join(backupDir, name), 'utf8')).toBe('A=original');

      fs.writeFileSync(envPath, 'A=changed');
      // Make sure the safety backup gets a different timestamp
      await new Promise((r) => setTimeout(r, 5));
      await env.restoreBackup(name);

      expect(fs.readFileSync(envPath, 'utf8')).toBe('A=original');
      const backups = env.listBackups();
      expect(backups).toHaveLength(2);
      const contents = backups.map((b) => fs.readFileSync(path.join(backupDir, b.filename), 'utf8'));
      expect(contents.sort()).toEqual(['A=changed', 'A=original']);
      expect(Object.keys(backups[0]).sort()).toEqual(['createdAt', 'filename', 'size']);
      expect(typeof backups[0].createdAt.getTime()).toBe('number');
      expect(backups[0].size).toBe(fs.statSync(path.join(backupDir, backups[0].filename)).size);
    });

    it('lists newest first and ignores other files', () => {
      fs.writeFileSync(path.join(backupDir, '.env.backup-old'), 'a');
      fs.writeFileSync(path.join(backupDir, '.env.backup-new'), 'bb');
      fs.writeFileSync(path.join(backupDir, 'notes.txt'), 'x');
      fs.utimesSync(path.join(backupDir, '.env.backup-old'), new Date(1000), new Date(1000));
      expect(env.listBackups().map((b) => [b.filename, b.size])).toEqual([
        ['.env.backup-new', 2], ['.env.backup-old', 1]
      ]);
    });

    it('returns [] when the backup folder is gone', () => {
      fs.rmSync(backupDir, { recursive: true });
      expect(env.listBackups()).toEqual([]);
    });

    it('rejects an unknown backup without changing .env', async () => {
      fs.writeFileSync(envPath, 'A=1');
      await expect(env.restoreBackup('.env.backup-missing')).rejects.toThrow('Backup .env.backup-missing not found');
      expect(fs.readFileSync(envPath, 'utf8')).toBe('A=1');
      expect(env.listBackups()).toEqual([]);
    });

    it('restores without a safety backup when .env does not exist', async () => {
      fs.writeFileSync(path.join(backupDir, '.env.backup-x'), 'A=from-backup');
      await env.restoreBackup('.env.backup-x');
      expect(fs.readFileSync(envPath, 'utf8')).toBe('A=from-backup');
      expect(env.listBackups()).toHaveLength(1);
    });

    it('rejects a backup name with path segments or without the backup prefix', async () => {
      fs.writeFileSync(envPath, 'A=1');
      fs.writeFileSync(path.join(dir, 'outside.txt'), 'A=outside');
      fs.writeFileSync(path.join(dir, '.env.backup-outside'), 'A=outside');
      fs.writeFileSync(path.join(backupDir, 'other.txt'), 'A=outside');
      for (const name of ['../outside.txt', '../.env.backup-outside', '.env.backup-a/../../outside.txt',
        '.env.backup-a\\..\\x', 'other.txt', path.join(dir, 'outside.txt'), '']) {
        await expect(env.restoreBackup(name)).rejects.toMatchObject({
          name: 'ValidationError', statusCode: 400, message: `Invalid backup name: ${name}`
        });
      }
      await expect(env.restoreBackup(42 as unknown as string)).rejects.toThrow('Invalid backup name: 42');
      expect(fs.readFileSync(envPath, 'utf8')).toBe('A=1');
      expect(env.listBackups()).toEqual([]);
    });

    it('isBackupName accepts only bare names with the backup prefix', () => {
      expect(EnvManager.isBackupName('.env.backup-2026-01-01T00-00-00-000Z')).toBe(true);
      expect(EnvManager.isBackupName('.env.backup-..')).toBe(true); // still a file inside the folder
      expect(EnvManager.isBackupName('../.env.backup-x')).toBe(false);
      expect(EnvManager.isBackupName('.env.backup-x/y')).toBe(false);
      expect(EnvManager.isBackupName('.env.backup-x\\y')).toBe(false);
      expect(EnvManager.isBackupName('.env')).toBe(false);
      expect(EnvManager.isBackupName(null)).toBe(false);
    });
  });
});
