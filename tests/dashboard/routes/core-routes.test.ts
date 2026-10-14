/**
 * Unit tests for the api, filters, alerts, obs, uploads, counters and quotes route
 * factories (src/dashboard/routes/*.ts). The HTTP behaviour is characterised end to
 * end in tests/e2e/dashboard; this covers what that suite does not reach: fresh
 * routers per call, and serving a cached TTS file.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

// Point projectPath() at a temp folder so the TTS cache test never writes into the repo
const mockRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'core-routes-root-'));
jest.mock('../../../src/utils/project-root', () => ({
  findProjectRoot: () => mockRoot,
  projectPath: (...segments: string[]) => require('path').join(mockRoot, ...segments)
}));

import { createApiRouter, ApiPaths } from '../../../src/dashboard/routes/api';
import { createFiltersRouter } from '../../../src/dashboard/routes/filters';
import { createAlertsRouter } from '../../../src/dashboard/routes/alerts';
import { createObsRouter } from '../../../src/dashboard/routes/obs';
import { createUploadsRouter } from '../../../src/dashboard/routes/uploads';
import { createCountersRouter } from '../../../src/dashboard/routes/counters';
import { createQuotesRouter } from '../../../src/dashboard/routes/quotes';

/* eslint-disable @typescript-eslint/no-require-imports */

async function withApp(mount: (app: express.Express) => void, fn: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  mount(app);
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

describe('core route factories', () => {
  let dir: string;
  let paths: ApiPaths;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-routes-'));
    paths = {
      commandLogsFile: path.join(dir, 'commands.json'),
      userStatsFile: path.join(dir, 'stats.json'),
      customCommandsFile: path.join(dir, 'customCommands.json'),
      builtinCommandsFile: path.join(dir, 'builtinCommands.json'),
      redemptionsFile: path.join(dir, 'redemptions.json'),
      eventSubEventsFile: path.join(dir, 'eventsub-events.json'),
      announcementsFile: path.join(dir, 'announcements.json'),
      obsConfigFile: path.join(dir, 'obs-config.json'),
      alertConfigFile: path.join(dir, 'alert-config.json')
    };
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  afterAll(() => {
    fs.rmSync(mockRoot, { recursive: true, force: true });
  });

  it('every call builds a new router with only its own handlers', () => {
    const builds: Array<() => express.Router> = [
      () => createApiRouter(paths, path.join(dir, '.env')),
      () => createFiltersRouter(path.join(dir, '.env')),
      () => createAlertsRouter(paths.alertConfigFile),
      () => createObsRouter({ ...paths, obsConfigFile: path.join(dir, 'obs-config.json') }),
      () => createUploadsRouter(dir),
      () => createCountersRouter(dir),
      () => createQuotesRouter(dir)
    ];
    for (const build of builds) {
      const a = build();
      const b = build();
      expect(a).not.toBe(b);
      expect(b.stack.length).toBe(a.stack.length);
    }
  });

  it('routers built for different files do not share state', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'core-routes-'));
    try {
      fs.writeFileSync(paths.commandLogsFile, '[]');
      fs.writeFileSync(path.join(other, 'commands.json'), '["other"]');
      await withApp(app => {
        app.use('/a', createApiRouter(paths, path.join(dir, '.env')));
        app.use('/b', createApiRouter({ ...paths, commandLogsFile: path.join(other, 'commands.json') }, path.join(other, '.env')));
      }, async base => {
        expect(await (await fetch(`${base}/a/logs`)).json()).toEqual([]);
        expect(await (await fetch(`${base}/b/logs`)).json()).toEqual(['other']);
      });
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('GET /tts/audio/:filename serves a cached file from <project root>/dashboard/cache/tts', async () => {
    const name = `${'b'.repeat(64)}.mp3`;
    const cacheDir = path.join(mockRoot, 'dashboard', 'cache', 'tts');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, name), 'ID3audio');
    await withApp(app => app.use('/api', createApiRouter(paths, path.join(dir, '.env'))), async base => {
      const res = await fetch(`${base}/api/tts/audio/${name}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('audio/mpeg');
      expect(res.headers.get('cache-control')).toBe('public, max-age=86400');
      expect(await res.text()).toBe('ID3audio');
    });
  });
});
