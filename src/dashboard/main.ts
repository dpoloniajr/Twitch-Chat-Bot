/**
 * Dashboard entry point (`node dist/dashboard/main.js` / `npm run dashboard`):
 * timestamps console output, loads the project's .env, then builds the dashboard
 * and listens on 127.0.0.1:DASHBOARD_PORT (default 3001).
 */

// Timestamps on console output (patches the global console when loaded)
import '../lib/console-timestamp';

import * as dotenv from 'dotenv';
import { projectPath } from '../utils/project-root';

// Keys the system environment sets (e.g. docker-compose); dotenv never overrides
// them, so the Settings page shows them locked. Captured before .env is loaded.
const environmentKeys = Object.keys(process.env).filter(key => process.env[key] !== '');

// Load .env before requiring modules that read settings at load time (tts-service)
dotenv.config({ path: projectPath('.env') });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createDashboard } = require('./server') as typeof import('./server');

const { server, init } = createDashboard({ environmentKeys });
const PORT = process.env.DASHBOARD_PORT || 3001;
// Loopback by default; Docker sets DASHBOARD_HOST=0.0.0.0 so the published port is reachable
const HOST = process.env.DASHBOARD_HOST || '127.0.0.1';
init().then(() => {
  // A string port is passed through as before (net treats numeric strings as ports)
  server.listen(PORT as number, HOST, () => {
    console.log(`Dashboard server running on http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize server:', err);
  process.exit(1);
});
