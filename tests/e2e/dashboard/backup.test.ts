/**
 * Characterization: dashboard/routes/backup.js (mounted at /api/backup)
 * Backups live in <logsDir>/../backups; analytics in <logsDir>/analytics.json.
 */
jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('../../../src/lib/console-timestamp', () => ({}));

import * as fs from 'fs';
import * as path from 'path';
import { startDashboard, silenceConsole, Dash } from './helpers';

describe('dashboard /api/backup', () => {
  let d: Dash;
  let backupsDir: string;
  beforeEach(async () => {
    silenceConsole();
    d = await startDashboard();
    backupsDir = path.join(d.root, 'backups');
  });
  afterEach(async () => {
    await d.close();
  });

  const backupFile = (name: string) => JSON.parse(fs.readFileSync(path.join(backupsDir, name), 'utf8'));

  describe('list / create / download / delete', () => {
    it('GET /list creates the backups folder and returns []', async () => {
      expect(fs.existsSync(backupsDir)).toBe(false);
      const res = await d.get('/api/backup/list');
      expect(res.json).toEqual([]);
      expect(fs.statSync(backupsDir).isDirectory()).toBe(true);
    });

    it('POST /create snapshots the data files that exist', async () => {
      d.writeJson('quotes.json', { quotes: [{ id: 1 }] });
      const res = await d.post('/api/backup/create', {});
      expect(res.json).toEqual({
        success: true,
        filename: expect.stringMatching(/^backup-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.json$/),
        includes: ['customCommands', 'builtinCommands', 'announcements', 'quotes', 'alertConfig', 'obsConfig']
      });
      const content = backupFile(res.json.filename);
      expect(content.metadata).toEqual({ version: '1.0.0', createdAt: expect.any(String), includes: res.json.includes });
      expect(content.quotes).toEqual({ quotes: [{ id: 1 }] });
      expect(content.builtinCommands).toEqual(d.readJson('builtinCommands.json'));
      expect(content.loyalty).toBeUndefined();
    });

    it('POST /create honours include* options set to false', async () => {
      const res = await d.post('/api/backup/create', { options: { includeBuiltinCommands: false, includeAlertConfig: false } });
      expect(res.json.includes).toEqual(['customCommands', 'announcements', 'obsConfig']);
    });

    it('POST /create without a body backs up everything', async () => {
      const res = await d.request('POST', '/api/backup/create');
      expect(res.status).toBe(200);
      expect(res.json.includes).toEqual(['customCommands', 'builtinCommands', 'announcements', 'alertConfig', 'obsConfig']);
    });

    it('POST /create skips unreadable (corrupt) files', async () => {
      fs.writeFileSync(path.join(d.logsDir, 'announcements.json'), '{bad');
      const res = await d.post('/api/backup/create', {});
      expect(res.json.includes).not.toContain('announcements');
    });

    it('GET /list returns metadata newest first, tolerating corrupt backups', async () => {
      fs.mkdirSync(backupsDir, { recursive: true });
      fs.writeFileSync(path.join(backupsDir, 'old.json'), JSON.stringify({ metadata: { createdAt: '2020-01-01T00:00:00.000Z', includes: ['quotes'] } }));
      fs.writeFileSync(path.join(backupsDir, 'new.json'), JSON.stringify({ metadata: { createdAt: '2030-01-01T00:00:00.000Z' } }));
      fs.writeFileSync(path.join(backupsDir, 'broken.json'), 'nope');
      fs.writeFileSync(path.join(backupsDir, 'ignored.txt'), 'x');
      const res = await d.get('/api/backup/list');
      expect(res.json.map((b: { filename: string }) => b.filename)).toEqual(['new.json', 'broken.json', 'old.json']);
      expect(res.json[0]).toEqual({ filename: 'new.json', createdAt: '2030-01-01T00:00:00.000Z', size: expect.any(Number), includes: [] });
      expect(res.json[1].includes).toEqual([]);
      expect(res.json[2].includes).toEqual(['quotes']);
    });

    it('GET /:filename downloads a backup; 400 for non-.json, 404 when missing', async () => {
      const created = await d.post('/api/backup/create', {});
      const res = await d.get(`/api/backup/${created.json.filename}`);
      expect(res.json).toEqual(backupFile(created.json.filename));
      const bad = await d.get('/api/backup/file.txt');
      expect(bad.status).toBe(400);
      expect(bad.json).toEqual({ error: 'Invalid filename' });
      const missing = await d.get('/api/backup/missing.json');
      expect(missing.status).toBe(404);
      expect(missing.json).toEqual({ error: 'Backup not found' });
    });

    it.each(['..%2Flogs%2Fstats.json', '..%5Clogs%5Cstats.json', '%2E%2E%2F%2E%2E%2Fsecret.json', 'sub%2Fx.json'])(
      'GET /%s is a 400 (no reading outside the backups folder)', async (name) => {
        await d.post('/api/stats/someone');
        const res = await d.get(`/api/backup/${name}`);
        expect(res.status).toBe(400);
        expect(res.json).toEqual({ error: 'Invalid filename' });
      }
    );

    it('DELETE /:filename deletes a backup; 400 for non-.json, 404 when missing', async () => {
      const created = await d.post('/api/backup/create', {});
      expect((await d.del(`/api/backup/${created.json.filename}`)).json).toEqual({ success: true });
      expect(fs.readdirSync(backupsDir)).toEqual([]);
      expect((await d.del(`/api/backup/${created.json.filename}`)).status).toBe(404);
      expect((await d.del('/api/backup/x.txt')).status).toBe(400);
    });

    it.each(['..%2Flogs%2Fcommands.json', '..%5Clogs%5Ccommands.json'])('DELETE /%s is a 400 and deletes nothing', async (name) => {
      const res = await d.del(`/api/backup/${name}`);
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: 'Invalid filename' });
      expect(d.exists('commands.json')).toBe(true);
    });
  });

  describe('restore / upload', () => {
    it('POST /restore writes each known key present in the backup', async () => {
      const backup = {
        metadata: { version: '1.0.0' },
        quotes: { quotes: [], nextId: 5 },
        counters: { counters: {} },
        announcements: ['restored'],
        unknownKey: { x: 1 },
        loyalty: null
      };
      const res = await d.post('/api/backup/restore', { backup });
      expect(res.json).toEqual({ success: true, restored: ['announcements', 'quotes', 'counters'], errors: ['loyalty'] });
      expect(d.readJson('quotes.json')).toEqual({ quotes: [], nextId: 5 });
      expect(d.readJson('announcements.json')).toEqual(['restored']);
      expect(d.exists('loyalty.json')).toBe(false);
      expect(fs.readdirSync(d.logsDir).some(f => f.endsWith('.lock') || f.endsWith('.tmp'))).toBe(false);
    });

    it('POST /restore respects selections and overwrite:false', async () => {
      const backup = { metadata: {}, quotes: { q: 1 }, customCommands: [{ name: '!x' }], counters: { c: 1 } };
      const res = await d.post('/api/backup/restore', { backup, selections: ['quotes', 'customCommands'], overwrite: false });
      // customCommands.json exists (created by init) so it is skipped; quotes.json does not
      expect(res.json).toEqual({ success: true, restored: ['quotes'], errors: [] });
      expect(d.readJson('customCommands.json')).toEqual([]);
      expect(d.exists('counters.json')).toBe(false);
    });

    it('POST /restore reports non-object sections as errors instead of silently skipping them', async () => {
      // Every known section is a JSON object/array, so '', 0 and null are invalid and must not be written
      const res = await d.post('/api/backup/restore', { backup: { metadata: {}, announcements: '', quotes: 0, counters: null } });
      expect(res.json).toEqual({ success: true, restored: [], errors: ['announcements', 'quotes', 'counters'] });
      expect(d.exists('quotes.json')).toBe(false);
      expect(d.exists('counters.json')).toBe(false);
    });

    it('POST /restore restores empty (but valid) sections', async () => {
      const res = await d.post('/api/backup/restore', { backup: { metadata: {}, announcements: [] } });
      expect(res.json).toEqual({ success: true, restored: ['announcements'], errors: [] });
      expect(d.readJson('announcements.json')).toEqual([]);
    });

    it('POST /restore requires backup.metadata', async () => {
      const res = await d.post('/api/backup/restore', { backup: { quotes: {} } });
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: 'Invalid backup data' });
      expect((await d.post('/api/backup/restore', {})).status).toBe(400);
    });

    it('POST /upload stores the backup as uploaded-*.json without restoring it', async () => {
      const backup = { metadata: { createdAt: 'x' }, quotes: { a: 1 } };
      const res = await d.post('/api/backup/upload', { backup });
      expect(res.json).toEqual({ success: true, filename: expect.stringMatching(/^uploaded-.*\.json$/), metadata: { createdAt: 'x' } });
      expect(backupFile(res.json.filename)).toEqual(backup);
      expect(d.exists('quotes.json')).toBe(false);
      const bad = await d.post('/api/backup/upload', { backup: {} });
      expect(bad.status).toBe(400);
      expect(bad.json).toEqual({ error: 'Invalid backup data' });
    });
  });

  describe('analytics', () => {
    it('GET /analytics/summary creates analytics.json and returns zeros', async () => {
      const res = await d.get('/api/backup/analytics/summary');
      expect(res.json).toEqual({
        totalCommands: 0, totalMessages: 0, totalFollows: 0, totalSubscriptions: 0, totalBits: 0,
        totalStreamSessions: 0, totalStreamMinutes: 0, averageSessionDuration: 0, topCommands: []
      });
      expect(d.readJson('analytics.json')).toEqual({
        commandExecutions: [], hourlyStats: {}, commandStats: {}, streamSessions: [],
        config: { retentionDays: 30, sampleRate: 1, trackCommands: true, trackMessages: true, trackViewers: true },
        savedAt: expect.any(String)
      });
    });

    it('POST /analytics/track aggregates into the current hour and command stats', async () => {
      await d.post('/api/backup/analytics/track', { type: 'command', data: { command: '!Dice', success: true } });
      await d.post('/api/backup/analytics/track', { type: 'command', data: { command: '!dice', success: false } });
      await d.post('/api/backup/analytics/track', { type: 'command' });
      await d.post('/api/backup/analytics/track', { type: 'message' });
      await d.post('/api/backup/analytics/track', { type: 'follow' });
      await d.post('/api/backup/analytics/track', { type: 'subscription' });
      await d.post('/api/backup/analytics/track', { type: 'bits', data: { amount: 250 } });
      expect((await d.post('/api/backup/analytics/track', { type: 'unknown' })).json).toEqual({ success: true });

      const file = d.readJson('analytics.json');
      const hours = Object.values(file.hourlyStats) as Array<Record<string, unknown>>;
      expect(hours).toHaveLength(1);
      expect(hours[0]).toEqual({ hour: expect.stringMatching(/:00:00\.000Z$/), commands: 3, uniqueUsers: 0, messages: 1, follows: 1, subscriptions: 1, bits: 250 });
      expect(file.commandStats['!dice']).toEqual({
        name: '!dice', totalExecutions: 2, successfulExecutions: 1, failedExecutions: 1, uniqueUsers: 0, lastUsed: expect.any(String)
      });

      const summary = (await d.get('/api/backup/analytics/summary')).json;
      expect(summary).toMatchObject({ totalCommands: 3, totalMessages: 1, totalFollows: 1, totalSubscriptions: 1, totalBits: 250 });
      expect(summary.topCommands).toEqual([{ name: '!dice', count: 2, successRate: 50 }]);

      const commands = (await d.get('/api/backup/analytics/commands')).json;
      expect(commands).toEqual([{
        name: '!dice', totalExecutions: 2, successfulExecutions: 1, failedExecutions: 1, successRate: 50,
        averageResponseTime: 0, lastUsed: expect.any(String)
      }]);

      const daily = (await d.get('/api/backup/analytics/daily')).json;
      expect(daily).toEqual([{ date: expect.stringMatching(/^\d{4}-\d\d-\d\d$/), commands: 3, messages: 1, follows: 1, subscriptions: 1, bits: 250 }]);
    });

    it('daily excludes hours older than ?days and sessions are newest first with a limit', async () => {
      d.writeJson('analytics.json', {
        hourlyStats: {
          a: { hour: '2000-01-01T00:00:00.000Z', commands: 9 },
          b: { hour: '2999-01-01T05:00:00.000Z', commands: 1, bits: 3 },
          c: { hour: '2999-01-01T06:00:00.000Z', messages: 2 }
        },
        commandStats: {},
        streamSessions: [{ id: 1, durationMinutes: 30 }, { id: 2, durationMinutes: 61 }, { id: 3 }]
      });
      expect((await d.get('/api/backup/analytics/daily?days=3')).json).toEqual([
        { date: '2999-01-01', commands: 1, messages: 2, follows: 0, subscriptions: 0, bits: 3 }
      ]);
      expect((await d.get('/api/backup/analytics/sessions?limit=2')).json.map((s: { id: number }) => s.id)).toEqual([3, 2]);
      const summary = (await d.get('/api/backup/analytics/summary')).json;
      expect(summary).toMatchObject({ totalStreamSessions: 3, totalStreamMinutes: 91, averageSessionDuration: 30, totalCommands: 10 });
    });

    it('concurrent POST /analytics/track calls are all counted (file lock)', async () => {
      await Promise.all(Array.from({ length: 15 }, () => d.post('/api/backup/analytics/track', { type: 'message' })));
      expect((await d.get('/api/backup/analytics/summary')).json.totalMessages).toBe(15);
      expect(fs.readdirSync(d.logsDir).some(f => f.endsWith('.lock'))).toBe(false);
    });

    it('POST /analytics/track without a body answers 200 (an unknown event type counts nothing)', async () => {
      expect((await d.request('POST', '/api/backup/analytics/track')).status).toBe(200);
      expect((await d.get('/api/backup/analytics/summary')).json).toMatchObject({ totalCommands: 0, totalMessages: 0 });
    });
  });
});
