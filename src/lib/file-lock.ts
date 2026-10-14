/**
 * Cross-process file locking and atomic file writes
 *
 * Locks are an atomic mkdir of `<file>.lock` with the owner recorded in
 * `owner.json`, so the bot, the dashboard and the token generator serialise
 * their writes to the same files. A lock whose owner process is gone, or that
 * is older than `staleMs`, is broken.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';

export interface LockOptions {
  /** Lock directory (default: `<filePath>.lock`) */
  lockDir?: string;
  /** Attempts before giving up */
  retries?: number;
  /** Delay between attempts (ms) */
  retryDelay?: number;
  /** A lock held longer than this is considered abandoned (ms) */
  staleMs?: number;
}

interface LockOwner {
  pid: number;
  host: string;
  token: string;
  acquiredAt: number;
}

const DEFAULT_RETRIES = 50;
const DEFAULT_RETRY_DELAY = 100;
const DEFAULT_STALE_MS = 10000;
const OWNER_FILE = 'owner.json';

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readOwner(lockDir: string): LockOwner | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockDir, OWNER_FILE), 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * A lock is stale when its owner process on this host is gone, or when it
 * has been held longer than staleMs.
 */
export function isLockStale(lockDir: string, staleMs: number = DEFAULT_STALE_MS): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(lockDir);
  } catch {
    return false;
  }

  const owner = readOwner(lockDir);
  if (owner && owner.host === os.hostname() && owner.pid !== process.pid && !isProcessAlive(owner.pid)) {
    return true;
  }

  const acquiredAt = owner?.acquiredAt ?? stat.mtimeMs;
  return Date.now() - acquiredAt > staleMs;
}

/**
 * Remove an abandoned lock. The lock is first renamed aside and its owner
 * re-checked, so a lock that was re-acquired in the meantime is put back.
 */
function breakStaleLock(lockDir: string): void {
  const expectedToken = readOwner(lockDir)?.token;
  const tombstone = `${lockDir}.stale-${randomBytes(4).toString('hex')}`;

  try {
    fs.renameSync(lockDir, tombstone);
  } catch {
    return;
  }

  if (readOwner(tombstone)?.token !== expectedToken) {
    try {
      fs.renameSync(tombstone, lockDir);
    } catch {
      // Someone else holds the lock now; nothing more to do
    }
    return;
  }

  console.warn(`Removed stale lock ${lockDir}`);
  fs.rmSync(tombstone, { recursive: true, force: true });
}

function tryAcquire(lockDir: string): string | null {
  try {
    fs.mkdirSync(lockDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return null;
    }
    throw error;
  }

  const owner: LockOwner = {
    pid: process.pid,
    host: os.hostname(),
    token: randomBytes(8).toString('hex'),
    acquiredAt: Date.now(),
  };
  try {
    fs.writeFileSync(path.join(lockDir, OWNER_FILE), JSON.stringify(owner));
  } catch {
    // The lock is held either way; without an owner file it can only expire by age
  }
  return owner.token;
}

function release(lockDir: string, token: string, filePath: string): void {
  // If our lock was broken as stale, the directory may now belong to someone else
  const owner = readOwner(lockDir);
  if (owner && owner.token !== token) {
    return;
  }
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch (error) {
    // We already finished the action; report it and move on
    console.error(`Failed to release lock for ${filePath}:`, (error as Error).message);
  }
}

function resolveOptions(filePath: string, options: LockOptions) {
  return {
    lockDir: options.lockDir ?? `${filePath}.lock`,
    retries: options.retries ?? DEFAULT_RETRIES,
    retryDelay: options.retryDelay ?? DEFAULT_RETRY_DELAY,
    staleMs: options.staleMs ?? DEFAULT_STALE_MS,
  };
}

/**
 * Run `action` while holding the cross-process lock for `filePath`.
 */
export async function withCrossProcessLock<T>(
  filePath: string,
  action: () => Promise<T> | T,
  options: LockOptions = {}
): Promise<T> {
  const { lockDir, retries, retryDelay, staleMs } = resolveOptions(filePath, options);
  await fs.promises.mkdir(path.dirname(lockDir), { recursive: true });

  let token: string | null = null;
  for (let i = 0; i < retries && token === null; i++) {
    token = tryAcquire(lockDir);
    if (token === null) {
      if (isLockStale(lockDir, staleMs)) {
        breakStaleLock(lockDir);
      } else {
        await sleep(retryDelay);
      }
    }
  }

  if (token === null) {
    throw new Error(`Could not acquire lock for ${filePath} after ${retries} attempts`);
  }

  try {
    return await action();
  } finally {
    release(lockDir, token, filePath);
  }
}

/**
 * Synchronous version of withCrossProcessLock. Waiting blocks the thread
 * without spinning the CPU.
 */
export function withCrossProcessLockSync<T>(
  filePath: string,
  action: () => T,
  options: LockOptions = {}
): T {
  const { lockDir, retries, retryDelay, staleMs } = resolveOptions(filePath, options);
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });

  let token: string | null = null;
  for (let i = 0; i < retries && token === null; i++) {
    token = tryAcquire(lockDir);
    if (token === null) {
      if (isLockStale(lockDir, staleMs)) {
        breakStaleLock(lockDir);
      } else {
        sleepSync(retryDelay);
      }
    }
  }

  if (token === null) {
    throw new Error(`Could not acquire lock for ${filePath} after ${retries} attempts`);
  }

  try {
    return action();
  } finally {
    release(lockDir, token, filePath);
  }
}

function tempPathFor(filePath: string): string {
  return `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
}

/** On Windows, rename can briefly fail while another process has the file open */
function isRetryableRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

/**
 * Write a file via a temp file and rename, so readers never see a partial file.
 */
export async function writeFileAtomic(filePath: string, content: string | Uint8Array): Promise<void> {
  const tmpPath = tempPathFor(filePath);
  await fs.promises.writeFile(tmpPath, content);
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(tmpPath, filePath);
      return;
    } catch (error) {
      if (!isRetryableRenameError(error) || attempt >= 5) {
        await fs.promises.unlink(tmpPath).catch(() => {});
        throw error;
      }
      await sleep(50);
    }
  }
}

/**
 * Synchronous version of writeFileAtomic.
 */
export function writeFileAtomicSync(filePath: string, content: string | Uint8Array): void {
  const tmpPath = tempPathFor(filePath);
  fs.writeFileSync(tmpPath, content);

  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmpPath, filePath);
      return;
    } catch (error) {
      if (!isRetryableRenameError(error) || attempt >= 5) {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          // Already gone
        }
        throw error;
      }
      sleepSync(50);
    }
  }
}

/**
 * Read-modify-write a JSON file under the cross-process lock.
 *
 * `update` receives the current file contents (null if the file does not
 * exist) and returns the data to write, or undefined to write nothing. If the
 * file exists but cannot be parsed, this throws without writing.
 */
export function updateJsonFileSync<T>(
  filePath: string,
  update: (current: T | null) => T | undefined,
  options: LockOptions = {}
): T | undefined {
  return withCrossProcessLockSync(
    filePath,
    () => {
      let current: T | null = null;
      if (fs.existsSync(filePath)) {
        current = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
      }

      const next = update(current);
      if (next !== undefined) {
        writeFileAtomicSync(filePath, JSON.stringify(next, null, 2));
      }
      return next;
    },
    options
  );
}
