/**
 * Characterization: /api/env routes (token status, .env backups and restore).
 */

import * as fs from 'fs';
import * as path from 'path';
import { Harness, postJson, quietOutput, startHarness } from './harness';

describe('/api/env', () => {
  quietOutput();
  let h: Harness;

  afterEach(async () => {
    if (h) await h.close();
  });

  describe('GET /status', () => {
    it('reports which credentials are present', async () => {
      h = await startHarness({ env: 'TWITCH_CLIENT_ID=abc\nTWITCH_ACCESS_TOKEN=tok\nTWITCH_CLIENT_SECRET=\n' });
      const res = await fetch(`${h.base}/api/env/status`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        success: true,
        botToken: true,
        broadcasterToken: false,
        clientId: true,
        clientSecret: false
      });
    });

    it('reads the file on every request', async () => {
      h = await startHarness();
      expect((await (await fetch(`${h.base}/api/env/status`)).json()).botToken).toBe(false);
      h.writeEnv('TWITCH_BROADCASTER_ACCESS_TOKEN=x\n');
      expect((await (await fetch(`${h.base}/api/env/status`)).json()).broadcasterToken).toBe(true);
    });

    it('sends 500 when .env cannot be read', async () => {
      h = await startHarness();
      fs.mkdirSync(h.envPath);
      const res = await fetch(`${h.base}/api/env/status`);
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/EISDIR/);
    });
  });

  describe('backups', () => {
    it('lists no backups at first', async () => {
      h = await startHarness({ env: 'A=1\n' });
      expect(await (await fetch(`${h.base}/api/env/backups`)).json()).toEqual({ success: true, backups: [] });
    });

    it('creates a backup and lists it', async () => {
      h = await startHarness({ env: 'A=1\n' });
      const res = await postJson(`${h.base}/api/env/backup`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.backupName).toMatch(/^\.env\.backup-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/);
      expect(fs.readFileSync(path.join(h.backupDir, body.backupName), 'utf8')).toBe('A=1\n');

      const list = await (await fetch(`${h.base}/api/env/backups`)).json();
      expect(list.success).toBe(true);
      expect(list.backups).toHaveLength(1);
      expect(list.backups[0]).toEqual({ filename: body.backupName, createdAt: expect.any(String), size: 4 });
      expect(new Date(list.backups[0].createdAt).toISOString()).toBe(list.backups[0].createdAt);
    });

    it('lists only .env.backup-* files', async () => {
      h = await startHarness({ env: 'A=1\n' });
      fs.writeFileSync(path.join(h.backupDir, 'other.txt'), 'x');
      fs.writeFileSync(path.join(h.backupDir, '.env.backup-manual'), 'B=2\n');
      const list = await (await fetch(`${h.base}/api/env/backups`)).json();
      expect(list.backups.map((b: { filename: string }) => b.filename)).toEqual(['.env.backup-manual']);
    });

    it('lists nothing when the backup folder is gone', async () => {
      h = await startHarness({ env: 'A=1\n' });
      fs.rmSync(h.backupDir, { recursive: true });
      expect(await (await fetch(`${h.base}/api/env/backups`)).json()).toEqual({ success: true, backups: [] });
    });

    it('sends 500 when listing fails', async () => {
      h = await startHarness({ env: 'A=1\n' });
      fs.rmSync(h.backupDir, { recursive: true });
      fs.writeFileSync(h.backupDir, 'not a folder');
      const res = await fetch(`${h.base}/api/env/backups`);
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/ENOTDIR/);
    });

    it('fails with 500 when there is no .env to back up', async () => {
      h = await startHarness();
      const res = await postJson(`${h.base}/api/env/backup`);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ success: false, error: '.env file does not exist' });
    });
  });

  describe('POST /restore', () => {
    it('requires backupName', async () => {
      h = await startHarness({ env: 'A=1\n' });
      for (const body of [{}, { backupName: '' }, { backupName: null }]) {
        const res = await postJson(`${h.base}/api/env/restore`, body);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ success: false, error: 'backupName is required' });
      }
    });

    it('sends 500 for an unknown backup', async () => {
      h = await startHarness({ env: 'A=1\n' });
      const res = await postJson(`${h.base}/api/env/restore`, { backupName: '.env.backup-nope' });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ success: false, error: 'Backup .env.backup-nope not found' });
    });

    it('restores a backup after backing up the current file', async () => {
      h = await startHarness({ env: 'A=1\n' });
      const { backupName } = await (await postJson(`${h.base}/api/env/backup`)).json();
      h.writeEnv('A=2\n');
      // backups are named by millisecond timestamp; keep the next one distinct
      await new Promise((r) => setTimeout(r, 5));

      const res = await postJson(`${h.base}/api/env/restore`, { backupName });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, message: 'Restore successful' });
      expect(h.readEnv()).toBe('A=1\n');

      const backups = h.backups();
      expect(backups).toHaveLength(2);
      const safety = backups.find((b) => b !== backupName) as string;
      expect(fs.readFileSync(path.join(h.backupDir, safety), 'utf8')).toBe('A=2\n');
    });

    it('restores without a safety backup when .env is missing', async () => {
      h = await startHarness();
      fs.writeFileSync(path.join(h.backupDir, '.env.backup-x'), 'B=1\n');
      const res = await postJson(`${h.base}/api/env/restore`, { backupName: '.env.backup-x' });
      expect(res.status).toBe(200);
      expect(h.readEnv()).toBe('B=1\n');
      expect(h.backups()).toEqual(['.env.backup-x']);
    });

    it('rejects names that leave the backup folder or are not backups, with 400', async () => {
      h = await startHarness({ env: 'A=1\n' });
      fs.writeFileSync(path.join(h.dir, 'outside.txt'), 'STOLEN=1\n');
      fs.writeFileSync(path.join(h.dir, '.env.backup-outside'), 'STOLEN=1\n');
      fs.writeFileSync(path.join(h.backupDir, 'notes.txt'), 'STOLEN=1\n');
      for (const backupName of [
        '../outside.txt', '../.env.backup-outside', '.env.backup-x/../../outside.txt',
        '.env.backup-..\\..\\outside.txt', 'notes.txt', '/etc/passwd'
      ]) {
        const res = await postJson(`${h.base}/api/env/restore`, { backupName });
        expect([backupName, res.status]).toEqual([backupName, 400]);
        expect(await res.json()).toEqual({ success: false, error: `Invalid backup name: ${backupName}` });
      }
      expect(h.readEnv()).toBe('A=1\n');
      expect(h.backups()).toEqual(['notes.txt']);
    });

    it('rejects a non-string backupName with 400', async () => {
      h = await startHarness({ env: 'A=1\n' });
      for (const backupName of [42, ['.env.backup-x'], { a: 1 }]) {
        const res = await postJson(`${h.base}/api/env/restore`, { backupName });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/^Invalid backup name/);
      }
      expect(h.readEnv()).toBe('A=1\n');
    });

    it('sends 400 when the request has no JSON body', async () => {
      h = await startHarness({ env: 'A=1\n' });
      const res = await fetch(`${h.base}/api/env/restore`, { method: 'POST' });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ success: false, error: 'backupName is required' });
    });
  });
});
