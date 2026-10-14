/**
 * Entry point for `node dist/token-generator/main.js` (npm run token-generator):
 * timestamps console output, loads .env from the working folder into
 * process.env, then starts the server.
 */

import '../lib/console-timestamp';
import * as dotenv from 'dotenv';
import { createTokenGenerator } from './server';

dotenv.config();
createTokenGenerator().start();
