/**
 * Tests for cross-process file locking (src/lib/file-lock.ts)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import {
  withCrossProcessLock,
  withCrossProcessLockSync,
  isLockStale,
  writeFileAtomicSync,
  updateJsonFileSync,
} from '../../src/lib/file-lock';

const FAST = { retries: 3, retryDelay: 10 };

describe('file-lock', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-lock-'));
    file = path.join(dir, 'data.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeLock(owner: object | null, ageMs: number = 0): string {
    const lockDir = `${file}.lock`;
    fs.mkdirSync(lockDir);
    if (owner) {
      fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify(owner));
    }
    if (ageMs) {
      const then = new Date(Date.now() - ageMs);
      fs.utimesSync(lockDir, then, then);
    }
    return lockDir;
  }

  async function waitForLock(): Promise<void> {
    while (!fs.existsSync(path.join(`${file}.lock`, 'owner.json'))) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  describe('mutual exclusion', () => {
    it('releases the lock after the action and returns its result', () => {
      expect(withCrossProcessLockSync(file, () => 42)).toBe(42);
      expect(fs.existsSync(`${file}.lock`)).toBe(false);
    });

    it('releases the lock when the action throws', () => {
      expect(() =>
        withCrossProcessLockSync(file, () => {
          throw new Error('boom');
        })
      ).toThrow('boom');
      expect(fs.existsSync(`${file}.lock`)).toBe(false);
    });

    it('blocks the sync lock while the async lock is held', async () => {
      let release!: () => void;
      const held = withCrossProcessLock(file, () => new Promise<void>((r) => (release = r)));
      await waitForLock();

      expect(() => withCrossProcessLockSync(file, () => 1, FAST)).toThrow(/Could not acquire lock/);

      release();
      await held;
      expect(withCrossProcessLockSync(file, () => 2, FAST)).toBe(2);
    });

    it('blocks a second async lock while the async lock is held', async () => {
      let release!: () => void;
      const held = withCrossProcessLock(file, () => new Promise<void>((r) => (release = r)));
      await waitForLock();

      await expect(withCrossProcessLock(file, async () => 1, FAST)).rejects.toThrow(
        /Could not acquire lock/
      );

      release();
      await held;
    });

    it('serialises concurrent async read-modify-write callers in one process', async () => {
      fs.writeFileSync(file, '0');
      const increments = Array.from({ length: 10 }, () =>
        withCrossProcessLock(file, async () => {
          const value = parseInt(await fs.promises.readFile(file, 'utf8'), 10);
          await new Promise((resolve) => setTimeout(resolve, 5));
          await fs.promises.writeFile(file, String(value + 1));
          return value + 1;
        }, { retries: 1000, retryDelay: 2 })
      );

      expect((await Promise.all(increments)).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(fs.readFileSync(file, 'utf8')).toBe('10');
      expect(fs.existsSync(`${file}.lock`)).toBe(false);
    });

    it('serialises read-modify-write across separate processes', async () => {
      fs.writeFileSync(file, JSON.stringify({ count: 0 }));
      const libPath = path.resolve(__dirname, '../../src/lib/file-lock.ts');
      const script = `
        const fs = require('fs');
        const { withCrossProcessLockSync, writeFileAtomicSync } = require(${JSON.stringify(libPath)});
        const file = process.argv[1];
        for (let i = 0; i < 25; i++) {
          withCrossProcessLockSync(file, () => {
            const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
            data.count++;
            writeFileAtomicSync(file, JSON.stringify(data));
          }, { retries: 1000, retryDelay: 2 });
        }
      `;

      const runs = Array.from({ length: 4 }, () =>
        new Promise<number>((resolve) => {
          const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', script, file], { stdio: 'inherit' });
          child.on('exit', (code) => resolve(code ?? 1));
        })
      );

      expect(await Promise.all(runs)).toEqual([0, 0, 0, 0]);
      expect(JSON.parse(fs.readFileSync(file, 'utf-8')).count).toBe(100);
    }, 30000);
  });

  describe('stale locks', () => {
    it('breaks a lock whose owner process is gone', () => {
      writeLock({ pid: 2147483646, host: os.hostname(), token: 'dead', acquiredAt: Date.now() });

      expect(withCrossProcessLockSync(file, () => 'ok', FAST)).toBe('ok');
      expect(fs.existsSync(`${file}.lock`)).toBe(false);
    });

    it('breaks a lock older than staleMs', () => {
      writeLock(null, 60000);

      expect(withCrossProcessLockSync(file, () => 'ok', FAST)).toBe('ok');
    });

    it('does not break a recent lock held by a live process', () => {
      const lockDir = writeLock({ pid: process.ppid, host: os.hostname(), token: 'live', acquiredAt: Date.now() });

      expect(isLockStale(lockDir)).toBe(false);
      expect(() => withCrossProcessLockSync(file, () => 1, FAST)).toThrow(/Could not acquire lock/);
      expect(fs.existsSync(lockDir)).toBe(true);
    });

    it('is recognised as stale by the async helper too', async () => {
      writeLock({ pid: 2147483646, host: os.hostname(), token: 'dead', acquiredAt: Date.now() });

      await expect(withCrossProcessLock(file, async () => 'ok', FAST)).resolves.toBe('ok');
    });
  });

  describe('writeFileAtomicSync', () => {
    it('replaces the file and leaves no temp files behind', () => {
      fs.writeFileSync(file, 'old');
      writeFileAtomicSync(file, 'new');

      expect(fs.readFileSync(file, 'utf-8')).toBe('new');
      expect(fs.readdirSync(dir)).toEqual(['data.json']);
    });
  });

  describe('updateJsonFileSync', () => {
    it('passes null when the file does not exist and writes the result', () => {
      const seen: unknown[] = [];
      updateJsonFileSync<{ n: number }>(file, (current) => {
        seen.push(current);
        return { n: 1 };
      });

      expect(seen).toEqual([null]);
      expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ n: 1 });
    });

    it('writes nothing when update returns undefined', () => {
      fs.writeFileSync(file, '{"n":1}');
      updateJsonFileSync(file, () => undefined);

      expect(fs.readFileSync(file, 'utf-8')).toBe('{"n":1}');
    });

    it('throws without writing when the file cannot be parsed', () => {
      fs.writeFileSync(file, '{"users": {"alice"');
      const update = jest.fn(() => ({}));

      expect(() => updateJsonFileSync(file, update)).toThrow();
      expect(update).not.toHaveBeenCalled();
      expect(fs.readFileSync(file, 'utf-8')).toBe('{"users": {"alice"');
      expect(fs.existsSync(`${file}.lock`)).toBe(false);
    });
  });
});
