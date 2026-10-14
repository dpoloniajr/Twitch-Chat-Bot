/**
 * Bot restart support. The dashboard's "Restart Bot" button writes
 * dashboard/logs/restart.flag; the bot sees it and exits with
 * RESTART_EXIT_CODE. The supervisor (supervisor.ts, what `npm start` and
 * `npm run bot` run) starts the bot again on that code, so the new process
 * reads the edited .env. Any other exit code ends the supervisor too.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';

/** Exit code meaning "start me again" (EX_TEMPFAIL from sysexits.h) */
export const RESTART_EXIT_CODE = 75;

/** Fastest restart loop the supervisor allows (protects against a flag that keeps coming back) */
export const MIN_RESTART_DELAY_MS = 1000;

export interface SupervisorOptions {
  /** Node script to run (dist/bot/main.js) */
  script: string;
  /** Extra arguments for the script (e.g. --account name) */
  args?: string[];
  /** Spawns the child (child_process.spawn; replaced in tests) */
  spawnFn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  /** Node binary (process.execPath) */
  nodePath?: string;
  /** Called with the exit code once the supervisor stops (process.exit in production) */
  onExit: (code: number) => void;
  /** Delay before a restart in ms (default MIN_RESTART_DELAY_MS) */
  restartDelayMs?: number;
  log?: (message: string) => void;
}

export interface Supervisor {
  /** Number of times the bot has been started */
  readonly starts: number;
  /** Forward a signal to the bot and stop supervising (no restart after it exits) */
  stop: (signal?: NodeJS.Signals) => void;
}

/**
 * Run the bot as a child process, starting it again whenever it exits with
 * RESTART_EXIT_CODE. Stdio is inherited, so its output looks unchanged.
 */
export function superviseBot(options: SupervisorOptions): Supervisor {
  const spawnFn = options.spawnFn ?? spawn;
  const nodePath = options.nodePath ?? process.execPath;
  const log = options.log ?? ((message: string) => console.log(message));
  const delay = Math.max(MIN_RESTART_DELAY_MS, options.restartDelayMs ?? MIN_RESTART_DELAY_MS);

  let child: ChildProcess | null = null;
  let stopping = false;
  let starts = 0;

  function start(): void {
    starts++;
    child = spawnFn(nodePath, [options.script, ...(options.args ?? [])], { stdio: 'inherit' });
    child.on('error', (error: Error) => {
      log(`✗ Could not start the bot: ${error.message}`);
      child = null;
      options.onExit(1);
    });
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      child = null;
      if (!stopping && code === RESTART_EXIT_CODE) {
        log('🔄 Bot asked to restart; starting it again...');
        setTimeout(() => {
          if (!stopping) start();
        }, delay);
        return;
      }
      options.onExit(code ?? (signal ? 1 : 0));
    });
  }

  start();

  return {
    get starts() {
      return starts;
    },
    stop(signal: NodeJS.Signals = 'SIGTERM') {
      stopping = true;
      if (child) child.kill(signal);
      else options.onExit(0);
    }
  };
}
