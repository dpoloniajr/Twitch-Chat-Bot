/**
 * Helpers shared by the dashboard routes: file locking, JSON file stores,
 * .env editing and upload validation. Re-exports the API helpers from
 * src/lib/api-utils so routes can import everything from one place.
 */

import * as fsSync from 'fs';
import { promises as fs } from 'fs';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { MIME_SIGNATURES, UPLOAD_LIMIT_WINDOW, UPLOAD_LIMIT_COUNT } from './constants';
import { withCrossProcessLock, writeFileAtomic } from '../../lib/file-lock';
import { ValidationError } from '../../lib/api-utils';

export { ValidationError, asyncHandler, validateRequest } from '../../lib/api-utils';

// Wraps the cross-process lock to provide the same interface
export async function withFileLock<T>(filePath: string, action: () => Promise<T> | T): Promise<T> {
  return withCrossProcessLock(filePath, action);
}

/** Object stored by createJsonStore; write() stamps savedAt */
export interface JsonStoreData {
  savedAt?: string;
}

/** A route handler wrapped by JsonStore.locked */
export type StoreHandler = (req: Request, res: Response, next: NextFunction) => unknown;

export interface JsonStore<T extends JsonStoreData> {
  /** Read the file, creating it from makeDefaults() if it does not exist */
  read: () => Promise<T>;
  /** Stamp savedAt on `data` (mutating it) and write the file atomically */
  write: (data: T) => Promise<void>;
  /** Run a route handler while holding the file's cross-process lock */
  locked: (handler: StoreHandler) => RequestHandler;
}

// JSON file store: creates the file from makeDefaults() on first read, stamps savedAt on write
export function createJsonStore<T extends JsonStoreData>(filePath: string, makeDefaults: () => T): JsonStore<T> {
  const write = async (data: T): Promise<void> => {
    data.savedAt = new Date().toISOString();
    await writeFileAtomic(filePath, JSON.stringify(data, null, 2));
  };

  const read = async (): Promise<T> => {
    try {
      await fs.access(filePath);
    } catch {
      await write(makeDefaults());
    }
    return JSON.parse(await fs.readFile(filePath, 'utf-8')) as T;
  };

  // Wrap a route handler that reads then writes, so the whole read-modify-write
  // holds the same cross-process lock the bot uses for this file
  const locked = (handler: StoreHandler): RequestHandler => (req, res, next) =>
    withCrossProcessLock(filePath, () => handler(req, res, next)).catch(next);

  return { read, write, locked };
}

/** A .env variable name: letters, digits and underscores, not starting with a digit */
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Set `key=value` in a .env file under its lock: replaces the first existing
 * `key=` line, otherwise appends one (creating the file if missing).
 * The value is written verbatim; a value containing a line break is rejected
 * (ValidationError, 400) because it would add extra .env lines.
 */
export async function upsertEnvValue(envPath: string, key: string, value: string): Promise<void> {
  if (!ENV_KEY_PATTERN.test(key)) {
    throw new Error(`Invalid .env key: ${JSON.stringify(key)}`);
  }
  if (/[\r\n]/.test(value)) {
    throw new ValidationError(`${key} value cannot contain line breaks`);
  }

  return withFileLock(envPath, async () => {
    const line = `${key}=${value}`;
    let envContent = '';
    try {
      envContent = await fs.readFile(envPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    if (envContent) {
      // `key` is validated above, so it has no RegExp metacharacters
      const regex = new RegExp(`^${key}=.*$`, 'm');
      if (regex.test(envContent)) {
        // Replacer function: the value is inserted literally (no `$&`/`$1` expansion)
        envContent = envContent.replace(regex, () => line);
      } else {
        envContent = envContent.trimEnd();
        envContent += (envContent.endsWith('\n') ? '' : '\n') + line + '\n';
      }
    } else {
      envContent = line + '\n';
    }

    await fs.writeFile(envPath, envContent);
  });
}

/**
 * Format a value for a .env line so dotenv and readEnvFileSync() read it back
 * unchanged. Plain values are written bare; values with `#`, quotes or edge
 * spaces are single-quoted (dotenv keeps single-quoted text literally), or
 * double-quoted when they contain a single quote but no `"` or backslash.
 * Throws ValidationError for line breaks or values that cannot round-trip.
 */
export function formatEnvValue(key: string, value: string): string {
  if (/[\r\n\0]/.test(value)) {
    throw new ValidationError(`${key} value cannot contain line breaks`);
  }
  const needsQuotes = /[#'"`]/.test(value) || value !== value.trim();
  if (!needsQuotes) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"') && !value.includes('\\')) return `"${value}"`;
  throw new ValidationError(`${key} value cannot contain both ' and " (or ' and a backslash)`);
}

/**
 * Apply several .env edits in one locked write: a string sets the key (the
 * first `KEY=` / `export KEY=` line is replaced and any later duplicates are
 * dropped, otherwise a line is appended), null removes every line for the key.
 * Other lines, comments and blank lines are kept as they are.
 */
export async function updateEnvValues(envPath: string, updates: Record<string, string | null>): Promise<void> {
  const lines: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (!ENV_KEY_PATTERN.test(key)) throw new Error(`Invalid .env key: ${JSON.stringify(key)}`);
    lines[key] = value === null ? null : `${key}=${formatEnvValue(key, value)}`;
  }

  await withFileLock(envPath, async () => {
    let content = '';
    try {
      content = await fs.readFile(envPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    const existing = content === '' ? [] : content.replace(/(\r?\n)+$/, '').split(/\r?\n/);
    const written = new Set<string>();
    const out: string[] = [];
    for (const line of existing) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      const key = match?.[1];
      if (key === undefined || !Object.prototype.hasOwnProperty.call(lines, key)) {
        out.push(line);
        continue;
      }
      const replacement = lines[key];
      if (replacement !== null && !written.has(key)) out.push(replacement);
      written.add(key);
    }
    for (const [key, line] of Object.entries(lines)) {
      if (line !== null && !written.has(key)) out.push(line);
    }

    // Written in place, not renamed over: .env is often a single-file Docker bind
    // mount (rename fails there) and keeps its permissions this way
    await fs.writeFile(envPath, out.length ? out.join(eol) + eol : '');
  });
}

/**
 * Read a .env file into a key/value map (missing file: empty map). Handles the
 * subset of dotenv syntax the dashboard and token generator write: `KEY=value`
 * lines, an optional `export ` prefix, `#` comments and single/double quotes.
 */
export function readEnvFileSync(envPath: string): Record<string, string> {
  let content: string;
  try {
    content = fsSync.readFileSync(envPath, 'utf8');
  } catch {
    return {};
  }

  const values: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(rawLine);
    if (!match) continue;
    let value = match[2];
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, '');
    values[match[1]] = value;
  }
  return values;
}

/**
 * Check that `buffer` starts with the magic number for file extension `ext`
 * (lowercase, with the dot). Unknown extensions are rejected.
 */
export function validateMimeType(buffer: Uint8Array, ext: string): boolean {
  const signature = MIME_SIGNATURES[ext];
  if (!signature) {
    return false;
  }

  if (ext === '.webp' || ext === '.wav') {
    if (buffer.length < 12) return false;
    if (buffer[0] !== 0x52 || buffer[1] !== 0x49 || buffer[2] !== 0x46 || buffer[3] !== 0x46) {
      return false;
    }
    if (ext === '.webp') {
      return buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50;
    }
    if (ext === '.wav') {
      return buffer[8] === 0x57 && buffer[9] === 0x41 && buffer[10] === 0x56 && buffer[11] === 0x45;
    }
  }

  if (ext === '.mp4' || ext === '.m4a' || ext === '.mov') {
    if (buffer.length < 8) return false;
    return buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70;
  }

  for (let i = 0; i < signature.length; i++) {
    if (buffer[i] !== signature[i]) {
      return false;
    }
  }
  return true;
}

// Upload timestamps per client IP; buckets with no upload inside the window are pruned
const uploadRateLimits = new Map<string, number[]>();
let lastRateLimitSweep = 0;

/** Drop every bucket whose newest upload is older than the window (at most once per window) */
function sweepUploadRateLimits(now: number): void {
  if (now - lastRateLimitSweep < UPLOAD_LIMIT_WINDOW) return;
  lastRateLimitSweep = now;
  for (const [ip, timestamps] of uploadRateLimits) {
    if (timestamps.every(t => now - t >= UPLOAD_LIMIT_WINDOW)) uploadRateLimits.delete(ip);
  }
}

/**
 * Record an upload from `ip`. Returns false (and records nothing) when the IP
 * already made UPLOAD_LIMIT_COUNT uploads within the last UPLOAD_LIMIT_WINDOW ms.
 * Callers pass a fixed placeholder (e.g. 'unknown') when the address is not
 * known, so such requests share one bucket (fail closed).
 */
export function checkUploadRateLimit(ip: string): boolean {
  const now = Date.now();
  sweepUploadRateLimits(now);

  const timestamps = (uploadRateLimits.get(ip) || []).filter(t => now - t < UPLOAD_LIMIT_WINDOW);

  if (timestamps.length >= UPLOAD_LIMIT_COUNT) {
    uploadRateLimits.set(ip, timestamps);
    return false;
  }

  timestamps.push(now);
  uploadRateLimits.set(ip, timestamps);
  return true;
}

/** Number of IPs currently tracked by checkUploadRateLimit (for tests and diagnostics) */
export function uploadRateLimitBucketCount(): number {
  return uploadRateLimits.size;
}
