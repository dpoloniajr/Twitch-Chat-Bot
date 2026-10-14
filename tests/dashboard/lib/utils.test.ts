/**
 * Tests for src/dashboard/lib/utils.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { NextFunction, Request, Response } from 'express';
import {
  ValidationError,
  asyncHandler,
  validateRequest,
  withFileLock,
  createJsonStore,
  upsertEnvValue,
  validateMimeType,
  checkUploadRateLimit,
  uploadRateLimitBucketCount,
  readEnvFileSync
} from '../../../src/dashboard/lib/utils';
import * as apiUtils from '../../../src/lib/api-utils';
import { UPLOAD_LIMIT_COUNT, UPLOAD_LIMIT_WINDOW } from '../../../src/dashboard/lib/constants';

describe('dashboard utils', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-utils-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('re-exports the api-utils helpers unchanged', () => {
    expect(ValidationError).toBe(apiUtils.ValidationError);
    expect(asyncHandler).toBe(apiUtils.asyncHandler);
    expect(validateRequest).toBe(apiUtils.validateRequest);
  });

  describe('withFileLock', () => {
    it('returns the action result and releases the lock', async () => {
      const file = path.join(dir, 'a.json');
      await expect(withFileLock(file, async () => 42)).resolves.toBe(42);
      expect(fs.existsSync(`${file}.lock`)).toBe(false);
    });

    it('holds the lock during the action and serialises concurrent callers', async () => {
      const file = path.join(dir, 'a.json');
      const order: string[] = [];
      const slow = withFileLock(file, async () => {
        expect(fs.existsSync(`${file}.lock`)).toBe(true);
        order.push('slow-start');
        await new Promise(r => setTimeout(r, 80));
        order.push('slow-end');
      });
      await new Promise(r => setTimeout(r, 10));
      const fast = withFileLock(file, () => {
        order.push('fast');
      });
      await Promise.all([slow, fast]);
      expect(order).toEqual(['slow-start', 'slow-end', 'fast']);
    });

    it('propagates action errors and still releases the lock', async () => {
      const file = path.join(dir, 'a.json');
      await expect(withFileLock(file, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
      expect(fs.existsSync(`${file}.lock`)).toBe(false);
    });
  });

  describe('createJsonStore', () => {
    interface Doc { items: string[]; savedAt?: string }

    it('creates the file from makeDefaults on first read', async () => {
      const file = path.join(dir, 'store.json');
      const makeDefaults = jest.fn((): Doc => ({ items: ['x'] }));
      const store = createJsonStore(file, makeDefaults);
      const data = await store.read();
      expect(data.items).toEqual(['x']);
      expect(typeof data.savedAt).toBe('string');
      expect(makeDefaults).toHaveBeenCalledTimes(1);
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(data);
    });

    it('reads an existing file without calling makeDefaults', async () => {
      const file = path.join(dir, 'store.json');
      fs.writeFileSync(file, JSON.stringify({ items: ['kept'] }));
      const makeDefaults = jest.fn((): Doc => ({ items: [] }));
      const data = await createJsonStore(file, makeDefaults).read();
      expect(data).toEqual({ items: ['kept'] });
      expect(makeDefaults).not.toHaveBeenCalled();
    });

    it('rejects when the file holds invalid JSON', async () => {
      const file = path.join(dir, 'store.json');
      fs.writeFileSync(file, '{oops');
      await expect(createJsonStore(file, (): Doc => ({ items: [] })).read()).rejects.toThrow(SyntaxError);
    });

    it('write stamps savedAt on the object and writes pretty JSON', async () => {
      const file = path.join(dir, 'store.json');
      const store = createJsonStore(file, (): Doc => ({ items: [] }));
      const doc: Doc = { items: ['a'] };
      await store.write(doc);
      expect(typeof doc.savedAt).toBe('string');
      expect(fs.readFileSync(file, 'utf8')).toBe(JSON.stringify(doc, null, 2));
    });

    describe('locked', () => {
      const req = {} as Request;
      const res = {} as Response;

      it('runs the handler while holding the file lock', async () => {
        const file = path.join(dir, 'store.json');
        const store = createJsonStore(file, (): Doc => ({ items: [] }));
        const next = jest.fn() as unknown as NextFunction;
        let lockHeld = false;
        let resolveDone!: () => void;
        const done = new Promise<void>(r => { resolveDone = r; });
        store.locked(async (rq, rs, nx) => {
          expect(rq).toBe(req);
          expect(rs).toBe(res);
          expect(nx).toBe(next);
          lockHeld = fs.existsSync(`${file}.lock`);
          resolveDone();
        })(req, res, next);
        await done;
        await new Promise(r => setTimeout(r, 20));
        expect(lockHeld).toBe(true);
        expect(next).not.toHaveBeenCalled();
        expect(fs.existsSync(`${file}.lock`)).toBe(false);
      });

      it.each([
        ['rejects', async () => { throw new Error('async fail'); }],
        ['throws synchronously', () => { throw new Error('sync fail'); }]
      ])('passes the error to next when the handler %s', async (_label, handler) => {
        const file = path.join(dir, 'store.json');
        const store = createJsonStore(file, (): Doc => ({ items: [] }));
        const err = await new Promise<unknown>(resolve => {
          store.locked(handler)(req, res, resolve as NextFunction);
        });
        expect(err).toBeInstanceOf(Error);
        expect(fs.existsSync(`${file}.lock`)).toBe(false);
      });
    });
  });

  describe('upsertEnvValue', () => {
    let envPath: string;
    beforeEach(() => {
      envPath = path.join(dir, '.env');
    });
    const read = () => fs.readFileSync(envPath, 'utf8');

    it('creates the file when missing', async () => {
      await upsertEnvValue(envPath, 'KEY', 'v');
      expect(read()).toBe('KEY=v\n');
    });

    it('writes a single line into an empty file', async () => {
      fs.writeFileSync(envPath, '');
      await upsertEnvValue(envPath, 'KEY', 'v');
      expect(read()).toBe('KEY=v\n');
    });

    it('replaces only the matching line in place', async () => {
      fs.writeFileSync(envPath, 'A=1\nKEY=old\nMY_KEY=keep\nB=2\n');
      await upsertEnvValue(envPath, 'KEY', 'new');
      expect(read()).toBe('A=1\nKEY=new\nMY_KEY=keep\nB=2\n');
    });

    it('appends when the key is absent, normalising trailing whitespace', async () => {
      fs.writeFileSync(envPath, 'A=1\n\n\n');
      await upsertEnvValue(envPath, 'KEY', 'v');
      expect(read()).toBe('A=1\nKEY=v\n');

      fs.writeFileSync(envPath, 'A=1');
      await upsertEnvValue(envPath, 'KEY', 'v');
      expect(read()).toBe('A=1\nKEY=v\n');
    });

    it.each(['cost $& now', "a $1 b $$ c $' d $` e"])('writes replacement patterns in the value literally (%s)', async (value) => {
      fs.writeFileSync(envPath, 'KEY=old\nB=2\n');
      await upsertEnvValue(envPath, 'KEY', value);
      expect(read()).toBe(`KEY=${value}\nB=2\n`);
    });

    it('keeps CRLF line endings when replacing', async () => {
      fs.writeFileSync(envPath, 'A=1\r\nKEY=old\r\nB=2\r\n');
      await upsertEnvValue(envPath, 'KEY', 'new');
      expect(read()).toBe('A=1\r\nKEY=new\r\nB=2\r\n');
    });

    it.each(['a\nINJECTED=1', 'a\rb', 'trailing\n'])('rejects a value with a line break (%j) with a 400 and leaves the file alone', async (value) => {
      fs.writeFileSync(envPath, 'KEY=old\n');
      await expect(upsertEnvValue(envPath, 'KEY', value)).rejects.toMatchObject({ name: 'ValidationError', statusCode: 400 });
      expect(read()).toBe('KEY=old\n');
    });

    it.each(['', 'A.B', 'K*', '1KEY', 'KEY=X', 'A B', '^A'])('rejects an invalid key %j', async (key) => {
      fs.writeFileSync(envPath, 'A.B=1\nAAB=2\n');
      await expect(upsertEnvValue(envPath, key, 'v')).rejects.toThrow('Invalid .env key');
      expect(read()).toBe('A.B=1\nAAB=2\n');
    });

    it('rethrows read errors other than ENOENT', async () => {
      fs.mkdirSync(envPath);
      await expect(upsertEnvValue(envPath, 'KEY', 'v')).rejects.toMatchObject({ code: 'EISDIR' });
    });
  });

  describe('readEnvFileSync', () => {
    it('returns an empty map for a missing file', () => {
      expect(readEnvFileSync(path.join(dir, 'missing.env'))).toEqual({});
    });

    it('parses KEY=value lines, export prefixes, quotes, comments and CRLF', () => {
      const envPath = path.join(dir, '.env');
      fs.writeFileSync(envPath, [
        '# comment',
        'A=1',
        'export B = two words ',
        'C="quoted # not a comment"',
        "D='single'",
        'E=value # trailing comment',
        'F=',
        'G=a=b|c',
        'not a pair',
        'A=override'
      ].join('\r\n'));
      expect(readEnvFileSync(envPath)).toEqual({
        A: 'override', B: 'two words', C: 'quoted # not a comment', D: 'single', E: 'value', F: '', G: 'a=b|c'
      });
    });
  });

  describe('validateMimeType', () => {
    const buf = (...bytes: number[]) => Buffer.from(bytes);
    const pad = (bytes: number[], len = 16) => Buffer.from([...bytes, ...new Array(Math.max(0, len - bytes.length)).fill(0)]);
    const RIFF = [0x52, 0x49, 0x46, 0x46];
    const FTYP_AT_4 = [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70];

    it.each([
      ['.png', pad([0x89, 0x50, 0x4e, 0x47])],
      ['.jpg', pad([0xff, 0xd8, 0xff])],
      ['.jpeg', pad([0xff, 0xd8, 0xff])],
      ['.gif', pad([0x47, 0x49, 0x46])],
      ['.webm', pad([0x1a, 0x45, 0xdf, 0xa3])],
      ['.mp3', pad([0x49, 0x44, 0x33])],
      ['.ogg', pad([0x4f, 0x67, 0x67, 0x53])],
      ['.webp', pad([...RIFF, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])],
      ['.wav', pad([...RIFF, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])],
      ['.mp4', pad(FTYP_AT_4)],
      ['.m4a', pad(FTYP_AT_4)],
      ['.mov', pad(FTYP_AT_4)]
    ])('accepts a valid %s header', (ext, data) => {
      expect(validateMimeType(data, ext)).toBe(true);
    });

    it.each([
      ['.png', pad([0x89, 0x50, 0x4e, 0x00])],
      ['.jpg', pad([0x89, 0x50, 0x4e, 0x47])],
      ['.gif', buf(0x47, 0x49)],
      ['.webp', pad([...RIFF, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])],
      ['.wav', pad([...RIFF, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])],
      ['.webp', buf(...RIFF, 0, 0, 0, 0, 0x57, 0x45, 0x42)],
      ['.wav', pad([0x00, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])],
      ['.mp4', buf(0, 0, 0, 0x18, 0x66, 0x74, 0x79)],
      ['.mov', pad([0x66, 0x74, 0x79, 0x70])],
      ['.exe', pad([0x4d, 0x5a])],
      ['.PNG', pad([0x89, 0x50, 0x4e, 0x47])],
      ['', pad([])]
    ])('rejects %s with a wrong, short or unknown header', (ext, data) => {
      expect(validateMimeType(data, ext)).toBe(false);
    });
  });

  describe('checkUploadRateLimit', () => {
    let ipCounter = 0;
    const freshIp = () => `10.0.0.${++ipCounter}`;

    it(`allows ${UPLOAD_LIMIT_COUNT} uploads per window, then refuses without recording`, () => {
      const now = 1_000_000;
      const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
      const ip = freshIp();
      for (let i = 0; i < UPLOAD_LIMIT_COUNT; i++) {
        expect(checkUploadRateLimit(ip)).toBe(true);
      }
      expect(checkUploadRateLimit(ip)).toBe(false);
      expect(checkUploadRateLimit(ip)).toBe(false);

      // Refused attempts were not recorded: all slots free up together
      spy.mockReturnValue(now + UPLOAD_LIMIT_WINDOW - 1);
      expect(checkUploadRateLimit(ip)).toBe(false);
      spy.mockReturnValue(now + UPLOAD_LIMIT_WINDOW);
      for (let i = 0; i < UPLOAD_LIMIT_COUNT; i++) {
        expect(checkUploadRateLimit(ip)).toBe(true);
      }
      expect(checkUploadRateLimit(ip)).toBe(false);
    });

    it('slides the window per timestamp', () => {
      const spy = jest.spyOn(Date, 'now').mockReturnValue(0);
      const ip = freshIp();
      expect(checkUploadRateLimit(ip)).toBe(true);
      spy.mockReturnValue(30_000);
      for (let i = 1; i < UPLOAD_LIMIT_COUNT; i++) expect(checkUploadRateLimit(ip)).toBe(true);
      expect(checkUploadRateLimit(ip)).toBe(false);
      spy.mockReturnValue(UPLOAD_LIMIT_WINDOW);
      expect(checkUploadRateLimit(ip)).toBe(true);
      expect(checkUploadRateLimit(ip)).toBe(false);
    });

    it('tracks each IP separately', () => {
      jest.spyOn(Date, 'now').mockReturnValue(5_000_000);
      const a = freshIp();
      const b = freshIp();
      for (let i = 0; i < UPLOAD_LIMIT_COUNT; i++) checkUploadRateLimit(a);
      expect(checkUploadRateLimit(a)).toBe(false);
      expect(checkUploadRateLimit(b)).toBe(true);
    });

    it('prunes IPs with no upload inside the window, at most once per window', () => {
      const spy = jest.spyOn(Date, 'now').mockReturnValue(100_000_000);
      const ips = [freshIp(), freshIp(), freshIp()];
      // The first call sweeps (and drops) earlier tests' idle buckets
      for (const ip of ips) checkUploadRateLimit(ip);
      expect(uploadRateLimitBucketCount()).toBe(3);

      // Within the window nothing is dropped
      spy.mockReturnValue(100_000_000 + UPLOAD_LIMIT_WINDOW - 1);
      checkUploadRateLimit(ips[0]);
      expect(uploadRateLimitBucketCount()).toBe(3);

      // A window later, the idle buckets (all but the one just used) are swept
      spy.mockReturnValue(100_000_000 + 2 * UPLOAD_LIMIT_WINDOW - 2);
      const fresh = freshIp();
      checkUploadRateLimit(fresh);
      expect(uploadRateLimitBucketCount()).toBe(2);
    });
  });
});
