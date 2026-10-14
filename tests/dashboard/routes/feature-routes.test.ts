/**
 * Unit tests for the loyalty, song-queue and backup route factories
 * (src/dashboard/routes/*.ts). The HTTP behaviour is characterised end to end in
 * tests/e2e/dashboard; this covers what that suite cannot reach: fresh
 * routers per call, and a song-queue router built without dashboard state.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { createLoyaltyRouter } from '../../../src/dashboard/routes/loyalty';
import { createSongQueueRouter } from '../../../src/dashboard/routes/song-queue';
import { createBackupRouter } from '../../../src/dashboard/routes/backup';

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

function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

describe('feature route factories', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-routes-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('every call builds a new router', () => {
    const a = createLoyaltyRouter(dir);
    const b = createLoyaltyRouter(dir);
    a.stop();
    b.stop();
    expect(a).not.toBe(b);
    expect(createSongQueueRouter(dir)).not.toBe(createSongQueueRouter(dir));
    expect(createBackupRouter(dir)).not.toBe(createBackupRouter(dir));
  });

  it('loyalty stop() clears the watch-time interval', () => {
    const clear = jest.spyOn(global, 'clearInterval');
    const router = createLoyaltyRouter(dir);
    router.stop();
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('song-queue works without dashboard state (no broadcasts)', async () => {
    for (const state of [undefined, null, {}]) {
      fs.rmSync(path.join(dir, 'song-queue.json'), { force: true });
      fs.rmSync(path.join(dir, 'song-blocklist.json'), { force: true });
      await withApp(app => app.use('/q', createSongQueueRouter(dir, state)), async base => {
        const put = await fetch(`${base}/q/config`, {
          method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ maxPerUser: 5 })
        });
        expect((await put.json()).config.maxPerUser).toBe(5);
        const add = await post(`${base}/q/add`, { videoId: 'v1', title: 'Song', requester: 'alice', durationSeconds: 60 });
        expect(await add.json()).toMatchObject({ success: true, position: 1, queueLength: 1 });
        expect(await (await post(`${base}/q/block`, { type: 'keyword', value: 'song' })).json())
          .toMatchObject({ success: true, removedCount: 1 });
        expect((await (await fetch(`${base}/q/block/song`, { method: 'DELETE' })).json()).type).toBe('keyword');
        await post(`${base}/q/add`, { videoId: 'v2', title: 'Two', requester: 'bob', durationSeconds: 60 });
        expect((await (await post(`${base}/q/skip`, {})).json()).skippedSong.videoId).toBe('v2');
        await post(`${base}/q/add`, { videoId: 'v3', title: 'Three', requester: 'bob', durationSeconds: 60 });
        expect((await (await fetch(`${base}/q/1`, { method: 'DELETE' })).json()).removedSong.videoId).toBe('v3');
        await post(`${base}/q/add`, { videoId: 'v4', title: 'Four', requester: 'bob', durationSeconds: 60 });
        expect((await (await post(`${base}/q/clear`, {})).json()).clearedCount).toBe(1);
      });
    }
  });

  it('backups are stored next to the logs directory', async () => {
    const logsDir = path.join(dir, 'logs');
    fs.mkdirSync(logsDir);
    await withApp(app => app.use('/b', createBackupRouter(logsDir)), async base => {
      const res = await post(`${base}/b/create`, {});
      const { filename } = await res.json();
      expect(fs.existsSync(path.join(dir, 'backups', filename))).toBe(true);
    });
  });
});
