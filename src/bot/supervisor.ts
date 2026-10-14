/**
 * Entry point for `npm start` / `npm run bot`: runs dist/bot/main.js and starts
 * it again when it exits to restart (see restart.ts). Arguments are passed
 * through (e.g. `--account name`). Ctrl+C and SIGTERM are forwarded to the bot.
 */

import * as path from 'path';
import { superviseBot } from './restart';

const supervisor = superviseBot({
  script: path.join(__dirname, 'main.js'),
  args: process.argv.slice(2),
  onExit: code => process.exit(code)
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => supervisor.stop(signal));
}
