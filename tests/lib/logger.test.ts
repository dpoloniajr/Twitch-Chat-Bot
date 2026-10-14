/**
 * Tests for src/lib/logger.ts and src/lib/console-timestamp.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '../../src/lib/logger';
import { getTimestamp, installConsoleTimestamps } from '../../src/lib/console-timestamp';

describe('Logger', () => {
  let dir: string;
  let out: jest.SpyInstance;
  let err: jest.SpyInstance;
  const logFile = () => fs.readFileSync(path.join(dir, 'token-generator.log'), 'utf8');

  beforeEach(() => {
    dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'logger-')), 'nested', 'logs');
    out = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    err = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    fs.rmSync(path.dirname(path.dirname(dir)), { recursive: true, force: true });
    delete process.env.DEBUG;
  });

  it('logs to <root>/logs by default', () => {
    expect(new Logger('x').logDir).toBe(path.join(__dirname, '..', '..', 'logs'));
  });

  it('creates the log folder', () => {
    new Logger('Mod', dir);
    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });

  it('formats lines with an ISO timestamp, level and module', () => {
    expect(new Logger('Mod', dir).formatMessage('INFO', 'hi')).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[INFO\] \[Mod\] hi$/);
  });

  it('writes info to stdout and the file', () => {
    new Logger('Mod', dir).info('hello');
    expect(out).toHaveBeenCalledWith(expect.stringMatching(/\[INFO\] \[Mod\] hello\n$/));
    expect(err).not.toHaveBeenCalled();
    expect(logFile()).toMatch(/\[INFO\] \[Mod\] hello\n$/);
  });

  it('writes warn and error to stderr', () => {
    const log = new Logger('Mod', dir);
    log.warn('careful');
    log.error('broken');
    expect(err).toHaveBeenCalledTimes(2);
    expect(out).not.toHaveBeenCalled();
    expect(logFile().split('\n').filter(Boolean)).toHaveLength(2);
  });

  it('adds data: inspected on the console and as JSON in the file', () => {
    new Logger('Mod', dir).info('with data', { a: 1 });
    expect(out).toHaveBeenCalledTimes(2);
    expect(logFile()).toMatch(/with data \{"a":1\}\n$/);
  });

  it('skips falsy data', () => {
    new Logger('Mod', dir).info('zero', 0);
    expect(out).toHaveBeenCalledTimes(1);
    expect(logFile()).toMatch(/zero\n$/);
  });

  it('only writes debug lines when DEBUG is set', () => {
    const log = new Logger('Mod', dir);
    log.debug('hidden');
    expect(fs.existsSync(path.join(dir, 'token-generator.log'))).toBe(false);
    process.env.DEBUG = '1';
    log.debug('shown');
    expect(logFile()).toContain('[DEBUG] [Mod] shown');
  });
});

describe('console timestamps', () => {
  it('formats the local time as [HH:MM:SS]', () => {
    expect(getTimestamp(new Date(2026, 0, 2, 3, 4, 5))).toBe('[03:04:05]');
    expect(getTimestamp(new Date(2026, 0, 2, 23, 59, 9))).toBe('[23:59:09]');
    expect(getTimestamp()).toMatch(/^\[\d{2}:\d{2}:\d{2}\]$/);
  });

  function fakeConsole() {
    const calls: Array<[string, unknown[]]> = [];
    const target = {} as Record<string, (...args: unknown[]) => void>;
    for (const m of ['log', 'warn', 'error', 'info', 'debug', 'trace', 'dir', 'table']) {
      target[m] = (...args: unknown[]) => { calls.push([m, args]); };
    }
    return { target: target as unknown as Console, calls };
  }

  it('prepends the timestamp to text methods', () => {
    const { target, calls } = fakeConsole();
    expect(installConsoleTimestamps(target)).toBe(true);
    target.log('a', 1);
    target.error('b');
    expect(calls[0]).toEqual(['log', [expect.stringMatching(/^\[\d{2}:\d{2}:\d{2}\]$/), 'a', 1]]);
    expect(calls[1][1][1]).toBe('b');
  });

  it('prints the timestamp on its own line for dir and table', () => {
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { target, calls } = fakeConsole();
    installConsoleTimestamps(target);
    target.table([{ a: 1 }]);
    target.dir({ b: 2 });
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[0][0]).toMatch(/^\[\d{2}:\d{2}:\d{2}\]\n$/);
    expect(calls).toEqual([['table', [[{ a: 1 }]]], ['dir', [{ b: 2 }]]]);
  });

  it('patches only once', () => {
    const { target, calls } = fakeConsole();
    installConsoleTimestamps(target);
    expect(installConsoleTimestamps(target)).toBe(false);
    target.log('x');
    expect(calls[0][1]).toHaveLength(2);
  });

  it('patches the global console when the module loads', () => {
    jest.isolateModules(() => {
      const saved = { ...console };
      const flagged = console as Console & { __timestamped?: boolean };
      const before = flagged.__timestamped;
      delete flagged.__timestamped;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('../../src/lib/console-timestamp');
        expect(flagged.__timestamped).toBe(true);
        expect(console.log).not.toBe(saved.log);
      } finally {
        Object.assign(console, saved);
        flagged.__timestamped = before;
      }
    });
  });
});
