/**
 * Tests for src/bot/restart.ts: the supervisor that restarts the bot when it
 * exits with RESTART_EXIT_CODE (the dashboard's "Restart Bot" button).
 * Unit tests drive a fake child process; the E2E block runs real Node children.
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ChildProcess } from 'child_process';
import { superviseBot, RESTART_EXIT_CODE, MIN_RESTART_DELAY_MS } from '../../src/bot/restart';

class FakeChild extends EventEmitter {
  killed: NodeJS.Signals[] = [];
  kill(signal: NodeJS.Signals): boolean {
    this.killed.push(signal);
    return true;
  }
}

function setup(restartDelayMs?: number) {
  const children: FakeChild[] = [];
  const spawnCalls: Array<{ command: string; args: string[]; options: unknown }> = [];
  const exits: number[] = [];
  const logs: string[] = [];
  const supervisor = superviseBot({
    script: '/app/dist/bot/main.js',
    args: ['--account', 'main'],
    nodePath: '/usr/bin/node',
    spawnFn: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    },
    onExit: code => exits.push(code),
    restartDelayMs,
    log: message => logs.push(message)
  });
  return { supervisor, children, spawnCalls, exits, logs, last: () => children[children.length - 1] };
}

describe('superviseBot', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('starts the bot script with the given args and inherited stdio', () => {
    const t = setup();
    expect(t.spawnCalls).toEqual([{ command: '/usr/bin/node', args: ['/app/dist/bot/main.js', '--account', 'main'], options: { stdio: 'inherit' } }]);
    expect(t.supervisor.starts).toBe(1);
  });

  it('starts it again after the restart code, after the delay', () => {
    const t = setup();
    t.last().emit('exit', RESTART_EXIT_CODE, null);
    expect(t.logs).toEqual(['🔄 Bot asked to restart; starting it again...']);
    expect(t.children).toHaveLength(1);
    jest.advanceTimersByTime(MIN_RESTART_DELAY_MS - 1);
    expect(t.children).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(t.children).toHaveLength(2);
    expect(t.supervisor.starts).toBe(2);
    expect(t.exits).toEqual([]);
  });

  it('keeps restarting as often as asked', () => {
    const t = setup();
    for (let i = 0; i < 5; i++) {
      t.last().emit('exit', RESTART_EXIT_CODE, null);
      jest.advanceTimersByTime(MIN_RESTART_DELAY_MS);
    }
    expect(t.supervisor.starts).toBe(6);
  });

  it('never restarts faster than the minimum delay', () => {
    const t = setup(0);
    t.last().emit('exit', RESTART_EXIT_CODE, null);
    jest.advanceTimersByTime(MIN_RESTART_DELAY_MS - 1);
    expect(t.children).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(t.children).toHaveLength(2);
  });

  it.each([
    ['a clean exit', 0, null, 0],
    ['a crash', 1, null, 1],
    ['another code', 2, null, 2],
    ['a signal', null, 'SIGKILL', 1],
    ['no code and no signal', null, null, 0]
  ])('ends with the bot on %s', (_label, code, signal, expected) => {
    const t = setup();
    t.last().emit('exit', code, signal);
    jest.runOnlyPendingTimers();
    expect(t.exits).toEqual([expected]);
    expect(t.children).toHaveLength(1);
  });

  it('reports a spawn error as exit 1', () => {
    const t = setup();
    t.last().emit('error', new Error('ENOENT'));
    expect(t.logs).toEqual(['✗ Could not start the bot: ENOENT']);
    expect(t.exits).toEqual([1]);
  });

  it('stop() forwards the signal and does not restart, even on the restart code', () => {
    const t = setup();
    t.supervisor.stop('SIGINT');
    expect(t.last().killed).toEqual(['SIGINT']);
    t.last().emit('exit', RESTART_EXIT_CODE, null);
    jest.runOnlyPendingTimers();
    expect(t.children).toHaveLength(1);
    expect(t.exits).toEqual([RESTART_EXIT_CODE]);
  });

  it('stop() during the restart delay cancels the restart and exits', () => {
    const t = setup();
    t.last().emit('exit', RESTART_EXIT_CODE, null);
    t.supervisor.stop();
    jest.runOnlyPendingTimers();
    expect(t.children).toHaveLength(1);
    expect(t.exits).toEqual([0]);
  });

  it('stop() defaults to SIGTERM', () => {
    const t = setup();
    t.supervisor.stop();
    expect(t.last().killed).toEqual(['SIGTERM']);
  });
});

describe('superviseBot with real processes (E2E)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // A stand-in bot: records each start, asks to restart `restarts` times, then exits with `finalCode`
  function writeBot(restarts: number, finalCode: number): string {
    const script = path.join(dir, 'bot.js');
    fs.writeFileSync(script, `
      const fs = require('fs');
      const log = ${JSON.stringify(path.join(dir, 'starts.log'))};
      fs.appendFileSync(log, process.argv.slice(2).join(' ') + '\\n');
      const starts = fs.readFileSync(log, 'utf8').trim().split('\\n').length;
      process.exit(starts <= ${restarts} ? ${RESTART_EXIT_CODE} : ${finalCode});
    `);
    return script;
  }

  const run = (script: string) => new Promise<{ code: number; starts: string[] }>(resolve => {
    superviseBot({
      script,
      args: ['--account', 'test'],
      log: () => {},
      onExit: code => resolve({ code, starts: fs.readFileSync(path.join(dir, 'starts.log'), 'utf8').trim().split('\n') })
    });
  });

  it('restarts the bot each time it asks, then ends with its final code', async () => {
    const result = await run(writeBot(2, 0));
    expect(result).toEqual({ code: 0, starts: ['--account test', '--account test', '--account test'] });
  }, 15000);

  it('passes a crash code through without restarting', async () => {
    const result = await run(writeBot(0, 3));
    expect(result).toEqual({ code: 3, starts: ['--account test'] });
  });
});
