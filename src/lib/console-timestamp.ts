/**
 * Patches the global console methods to prepend a [HH:MM:SS] timestamp to every log call.
 * Import this module once at the top of each entry point. The guard prevents
 * double-patching if the module is loaded more than once.
 */

type TimestampedConsole = Console & { __timestamped?: boolean };

export function getTimestamp(date: Date = new Date()): string {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `[${h}:${m}:${s}]`;
}

/**
 * Patch `target` (the global console by default). Returns false if it was already patched.
 */
export function installConsoleTimestamps(target: Console = console): boolean {
  const patched = target as TimestampedConsole;
  if (patched.__timestamped) return false;
  patched.__timestamped = true;

  // Variadic text methods: the timestamp is prepended as the first argument
  (['log', 'warn', 'error', 'info', 'debug', 'trace'] as const).forEach((method) => {
    const original = target[method].bind(target);
    target[method] = (...args: unknown[]) => {
      original(getTimestamp(), ...args);
    };
  });

  // console.dir and console.table treat their first argument specially (object to
  // inspect / tabulate), so the timestamp goes on its own line first
  (['dir', 'table'] as const).forEach((method) => {
    const original = target[method].bind(target) as (...args: unknown[]) => void;
    target[method] = (...args: unknown[]) => {
      process.stdout.write(getTimestamp() + '\n');
      original(...args);
    };
  });
  return true;
}

installConsoleTimestamps();
