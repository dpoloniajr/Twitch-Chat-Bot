/**
 * Characterization: dashboard/routes/obs.js and the /obs static overlay files
 */
jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('../../../src/lib/console-timestamp', () => ({}));

import * as fs from 'fs';
import { startDashboard, openWs, silenceConsole, Dash } from './helpers';

const DEFAULT_OBS = {
  overlays: {
    alerts: { enabled: true, volume: 0.8, duration: 5 },
    recentEvents: { enabled: true, limit: 10, showTime: true },
    chatBox: { enabled: true, messageTimeout: 8, hideBot: false },
    goalBar: { enabled: true, type: 'follow', goal: 1000 }
  }
};

describe('dashboard /obs', () => {
  let d: Dash;
  beforeEach(async () => {
    silenceConsole();
    d = await startDashboard();
  });
  afterEach(async () => {
    await d.close();
  });

  describe('config', () => {
    it('GET /obs/config returns the default written by init()', async () => {
      expect((await d.get('/obs/config')).json).toEqual(DEFAULT_OBS);
    });

    it('POST /obs/config replaces the file and broadcasts', async () => {
      const ws = await openWs(d);
      const since = ws.messages.length;
      const body = { overlays: { alerts: { enabled: false } }, extra: 1 };
      const res = await d.post('/obs/config', body);
      expect(res.json).toEqual({ success: true, config: body });
      expect(d.readJson('obs-config.json')).toEqual(body);
      expect((await ws.waitFor('obsConfig', since)).data).toEqual(body);
      ws.close();
    });

    it('POST /obs/config requires an overlays object', async () => {
      const missing = await d.post('/obs/config', {});
      expect(missing.status).toBe(400);
      expect(missing.json).toEqual({ success: false, error: 'overlays is required' });
      const str = await d.post('/obs/config', { overlays: 'x' });
      expect(str.status).toBe(400);
      expect(str.json.error).toBe('overlays must be a object');
      expect(d.readJson('obs-config.json')).toEqual(DEFAULT_OBS);
    });
  });

  describe('recent events', () => {
    const events = [
      { event: 'follow', user: 'f1', timestamp: '1' },
      { alertType: 'subscription', userName: 's1', timestamp: '2' },
      { event: 'subscriber', username: 's2', timestamp: '3' },
      { event: 'bits', user: 'b1', timestamp: '4', amount: 100 },
      { event: 'raid', user: 'r1', timestamp: '5' }
    ];

    it('GET /obs/recent returns all events newest first with type/user normalized', async () => {
      d.writeJson('eventsub-events.json', events);
      const res = await d.get('/obs/recent');
      expect(res.json.type).toBe('all');
      expect(res.json.count).toBe(5);
      expect(res.json.events[0]).toEqual({ type: 'raid', user: 'r1', timestamp: '5', event: 'raid' });
      expect(res.json.events[3]).toEqual({ type: 'subscription', user: 's1', timestamp: '2', alertType: 'subscription', userName: 's1' });
      expect(res.json.events.map((e: { timestamp: string }) => e.timestamp)).toEqual(['5', '4', '3', '2', '1']);
    });

    it('GET /obs/recent caps at 50 events', async () => {
      d.writeJson('eventsub-events.json', Array.from({ length: 60 }, (_, i) => ({ event: 'follow', user: `u${i}`, timestamp: String(i) })));
      const res = await d.get('/obs/recent');
      expect(res.json.count).toBe(50);
      expect(res.json.events[0].user).toBe('u59');
      expect(res.json.events[49].user).toBe('u10');
    });

    it('GET /obs/recent/:type filters by type (aliases and case included)', async () => {
      d.writeJson('eventsub-events.json', events);
      const follow = await d.get('/obs/recent/follow');
      expect(follow.status).toBe(200);
      expect(follow.json).toEqual({ type: 'follow', count: 1, events: [{ type: 'follow', user: 'f1', timestamp: '1', event: 'follow' }] });
      // subscriber/subscription match both stored spellings
      for (const t of ['subscriber', 'Subscription']) {
        const subs = await d.get(`/obs/recent/${t}`);
        expect(subs.json.type).toBe(t.toLowerCase());
        expect(subs.json.events.map((e: { user: string }) => e.user)).toEqual(['s2', 's1']);
      }
      expect((await d.get('/obs/recent/cheer')).json.events.map((e: { user: string }) => e.user)).toEqual(['b1']);
      expect((await d.get('/obs/recent/ALL')).json.count).toBe(5);
      expect((await d.get('/obs/recent/redemption')).json).toEqual({ type: 'redemption', count: 0, events: [] });
    });

    it.each(['nonsense', 'constructor', '__proto__'])('GET /obs/recent/%s is a 400', async (type) => {
      d.writeJson('eventsub-events.json', events);
      const res = await d.get(`/obs/recent/${type}`);
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ success: false, error: 'Invalid event type' });
    });

    it('a corrupt eventsub-events.json answers 500 instead of hanging', async () => {
      fs.writeFileSync(d.paths.eventSubEventsFile, '{ not json');
      for (const url of ['/obs/recent', '/obs/recent/follow']) {
        const res = await d.get(url, { timeoutMs: 2000 });
        expect(res.status).toBe(500);
        expect(res.json.success).toBe(false);
      }
    });
  });

  describe('static overlay files', () => {
    it('serves the overlay HTML and JS from obs/', async () => {
      const html = await d.get('/obs/overlays/alerts.html');
      expect(html.status).toBe(200);
      expect(html.headers['content-type']).toMatch(/text\/html/);
      const js = await d.get('/obs/js/overlay-client.js');
      expect(js.status).toBe(200);
      expect(js.headers['content-type']).toMatch(/javascript/);
      expect((await d.get('/obs/overlays/missing.html')).status).toBe(404);
    });
  });
});
