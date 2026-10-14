/**
 * Characterization: dashboard/routes/alerts.js (mounted at /api/alerts)
 */
jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('../../../src/lib/console-timestamp', () => ({}));

import * as fs from 'fs';
import { startDashboard, openWs, silenceConsole, Dash } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DEFAULT_ALERT_CONFIG, ANIMATIONS, TTS_VOICES } = require('../../../src/dashboard/lib/constants');

describe('dashboard /api/alerts', () => {
  let d: Dash;
  beforeEach(async () => {
    silenceConsole();
    d = await startDashboard();
  });
  afterEach(async () => {
    await d.close();
  });

  describe('GET /config', () => {
    it('returns the default config created by init()', async () => {
      const res = await d.get('/api/alerts/config');
      expect(res.status).toBe(200);
      expect(res.json).toEqual(DEFAULT_ALERT_CONFIG);
      expect(d.readJson('alert-config.json')).toEqual(DEFAULT_ALERT_CONFIG);
    });

    it('merges missing default alert types into the response and the file', async () => {
      d.writeJson('alert-config.json', { global: { enabled: false }, alertTypes: { follow: { enabled: false } } });
      const res = await d.get('/api/alerts/config');
      expect(res.json.global).toEqual({ enabled: false });
      expect(res.json.alertTypes.follow).toEqual({ enabled: false });
      expect(Object.keys(res.json.alertTypes).sort()).toEqual(Object.keys(DEFAULT_ALERT_CONFIG.alertTypes).sort());
      expect(d.readJson('alert-config.json').alertTypes.first_chatter).toEqual(DEFAULT_ALERT_CONFIG.alertTypes.first_chatter);
    });

    it('does not rewrite the file when nothing is missing', async () => {
      const before = fs.statSync(d.paths.alertConfigFile).mtimeMs;
      await new Promise(r => setTimeout(r, 20));
      await d.get('/api/alerts/config');
      expect(fs.statSync(d.paths.alertConfigFile).mtimeMs).toBe(before);
    });

    it('a config without alertTypes is returned as-is', async () => {
      d.writeJson('alert-config.json', { global: {} });
      expect((await d.get('/api/alerts/config')).json).toEqual({ global: {} });
    });

    it('falls back to the defaults (without touching the file) when the file is corrupt', async () => {
      fs.writeFileSync(d.paths.alertConfigFile, '{nope');
      const res = await d.get('/api/alerts/config');
      expect(res.status).toBe(200);
      expect(res.json).toEqual(DEFAULT_ALERT_CONFIG);
      expect(fs.readFileSync(d.paths.alertConfigFile, 'utf8')).toBe('{nope');
    });
  });

  it('POST /config replaces the whole file (no validation) and broadcasts', async () => {
    const ws = await openWs(d);
    const since = ws.messages.length;
    const res = await d.post('/api/alerts/config', { anything: 1 });
    expect(res.json).toEqual({ success: true, config: { anything: 1 } });
    expect(d.readJson('alert-config.json')).toEqual({ anything: 1 });
    const msg = await ws.waitFor('alertConfig', since);
    expect(msg.data).toEqual({ anything: 1 });
    ws.close();
  });

  describe('POST /config/:alertType', () => {
    it('merges into the (lowercased) alert type', async () => {
      const res = await d.post('/api/alerts/config/FOLLOW', { duration: 9, textColor: '#fff' });
      expect(res.status).toBe(200);
      expect(res.json.config).toEqual({ ...DEFAULT_ALERT_CONFIG.alertTypes.follow, duration: 9, textColor: '#fff' });
      expect(d.readJson('alert-config.json').alertTypes.follow.duration).toBe(9);
    });

    it('creates an unknown alert type', async () => {
      const res = await d.post('/api/alerts/config/custom', { a: 1 });
      expect(res.json).toEqual({ success: true, config: { a: 1 } });
      expect(d.readJson('alert-config.json').alertTypes.custom).toEqual({ a: 1 });
    });

    it('POST /config/global merges into the global settings and broadcasts', async () => {
      const ws = await openWs(d);
      const since = ws.messages.length;
      const res = await d.post('/api/alerts/config/global', { ttsEnabled: true });
      expect(res.json).toEqual({ success: true, global: { ...DEFAULT_ALERT_CONFIG.global, ttsEnabled: true } });
      const file = d.readJson('alert-config.json');
      expect(file.global.ttsEnabled).toBe(true);
      expect(file.alertTypes.global).toBeUndefined();
      expect((await ws.waitFor('alertConfig', since)).data.global.ttsEnabled).toBe(true);
      ws.close();
    });

    it('POST /config/reset resets one alert type to its defaults', async () => {
      await d.post('/api/alerts/config/follow', { duration: 99 });
      await d.post('/api/alerts/config/raid', { duration: 42 });
      const res = await d.post('/api/alerts/config/reset', { alertType: 'follow' });
      expect(res.json.success).toBe(true);
      const file = d.readJson('alert-config.json');
      expect(file.alertTypes.follow).toEqual(DEFAULT_ALERT_CONFIG.alertTypes.follow);
      expect(file.alertTypes.raid.duration).toBe(42);
      expect(file.alertTypes.reset).toBeUndefined();
    });

    it('POST /config/reset without a known alertType resets everything', async () => {
      await d.post('/api/alerts/config/raid', { duration: 42 });
      await d.post('/api/alerts/config/global', { ttsEnabled: true });
      for (const body of [{}, { alertType: 'nope' }]) {
        const res = await d.post('/api/alerts/config/reset', body);
        expect(res.json).toEqual({ success: true, config: DEFAULT_ALERT_CONFIG });
        expect(d.readJson('alert-config.json')).toEqual(DEFAULT_ALERT_CONFIG);
      }
      // The reset writes a copy: later edits do not leak into the defaults
      await d.post('/api/alerts/config/raid', { duration: 1 });
      expect((await d.post('/api/alerts/config/reset', {})).json.config.alertTypes.raid.duration).toBe(DEFAULT_ALERT_CONFIG.alertTypes.raid.duration);
    });

    it('with an empty body leaves the type unchanged', async () => {
      const res = await d.post('/api/alerts/config/raid', {});
      expect(res.json.config).toEqual(DEFAULT_ALERT_CONFIG.alertTypes.raid);
    });

    it('fails with 500 when the file has no alertTypes', async () => {
      d.writeJson('alert-config.json', { global: {} });
      const res = await d.post('/api/alerts/config/follow', { a: 1 });
      expect(res.status).toBe(500);
      expect(res.json.success).toBe(false);
    });
  });

  describe('POST /config/:alertType/variation/:variationKey', () => {
    it('merges into an existing variation', async () => {
      const res = await d.post('/api/alerts/config/BITS/variation/100', { messageTemplate: 'Wow' });
      expect(res.json).toEqual({ success: true, variation: { ...DEFAULT_ALERT_CONFIG.alertTypes.bits.variations['100'], messageTemplate: 'Wow' } });
      expect(d.readJson('alert-config.json').alertTypes.bits.variations['100'].messageTemplate).toBe('Wow');
    });

    it('creates the variations map when missing', async () => {
      const res = await d.post('/api/alerts/config/follow/variation/special', { sound: 's.mp3' });
      expect(res.json.variation).toEqual({ sound: 's.mp3' });
      expect(d.readJson('alert-config.json').alertTypes.follow.variations).toEqual({ special: { sound: 's.mp3' } });
    });

    it('unknown alert type is a 404 and changes nothing', async () => {
      const before = d.readJson('alert-config.json');
      const res = await d.post('/api/alerts/config/nope/variation/x', { a: 1 });
      expect(res.status).toBe(404);
      expect(res.json).toEqual({ success: false, error: 'Unknown alert type: nope' });
      expect(d.readJson('alert-config.json')).toEqual(before);
    });
  });

  describe('POST /test', () => {
    it('defaults to a follow test alert with the configured look and broadcasts it', async () => {
      const ws = await openWs(d);
      const since = ws.messages.length;
      const res = await d.post('/api/alerts/test', {});
      const f = DEFAULT_ALERT_CONFIG.alertTypes.follow;
      const g = DEFAULT_ALERT_CONFIG.global;
      expect(res.json).toEqual({
        success: true,
        alert: {
          alertType: 'follow',
          user: 'TestUser',
          timestamp: expect.any(String),
          isTest: true,
          config: {
            duration: f.duration * 1000,
            volume: f.volume,
            enterAnimation: f.enterAnimation,
            exitAnimation: f.exitAnimation,
            layout: f.layout,
            showMessage: f.showMessage,
            textColor: f.textColor,
            backgroundColor: f.backgroundColor,
            borderColor: f.borderColor,
            fontFamily: f.fontFamily,
            fontSize: f.fontSize,
            messageTemplate: f.messageTemplate,
            sound: f.sound,
            customSound: null,
            image: null,
            video: null,
            ttsEnabled: false,
            ttsTemplate: f.ttsTemplate,
            ttsVoice: g.ttsVoice,
            ttsRate: g.ttsRate,
            ttsPitch: g.ttsPitch
          }
        }
      });
      const msg = await ws.waitFor('alert', since);
      expect(msg.data.isTest).toBe(true);
      ws.close();
    });

    it('fills type-specific defaults', async () => {
      expect((await d.post('/api/alerts/test', { alertType: 'subscription' })).json.alert.tier).toBe('1000');
      expect((await d.post('/api/alerts/test', { alertType: 'bits' })).json.alert.amount).toBe(100);
      expect((await d.post('/api/alerts/test', { alertType: 'bits', amount: 'abc' })).json.alert.amount).toBe(100);
      expect((await d.post('/api/alerts/test', { alertType: 'bits', amount: '7' })).json.alert.amount).toBe(7);
      expect((await d.post('/api/alerts/test', { alertType: 'raid' })).json.alert.viewers).toBe(50);
      expect((await d.post('/api/alerts/test', { alertType: 'redemption' })).json.alert.reward).toBe('Hydrate!');
      const withMsg = await d.post('/api/alerts/test', { alertType: 'follow', user: 'Bob', message: 'hey', useConfig: false });
      expect(withMsg.json.alert).toEqual({ alertType: 'follow', user: 'Bob', timestamp: expect.any(String), isTest: true, config: null, message: 'hey' });
    });

    it('ttsEnabled requires both the type and the global flag', async () => {
      await d.post('/api/alerts/config/follow', { ttsEnabled: true });
      expect((await d.post('/api/alerts/test', {})).json.alert.config.ttsEnabled).toBe(false);
      const cfg = d.readJson('alert-config.json');
      cfg.global.ttsEnabled = true;
      d.writeJson('alert-config.json', cfg);
      expect((await d.post('/api/alerts/test', {})).json.alert.config.ttsEnabled).toBe(true);
    });

    it('uses the defaults when the config file is corrupt', async () => {
      fs.writeFileSync(d.paths.alertConfigFile, 'garbage');
      const res = await d.post('/api/alerts/test', { alertType: 'raid' });
      expect(res.json.alert.config.duration).toBe(DEFAULT_ALERT_CONFIG.alertTypes.raid.duration * 1000);
    });

    it('unknown alert type is a 404 (nothing broadcast); without useConfig it is sent as-is', async () => {
      const res = await d.post('/api/alerts/test', { alertType: 'nope' });
      expect(res.status).toBe(404);
      expect(res.json).toEqual({ success: false, error: 'Unknown alert type: nope' });
      const raw = await d.post('/api/alerts/test', { alertType: 'nope', useConfig: false });
      expect(raw.status).toBe(200);
      expect(raw.json.alert).toMatchObject({ alertType: 'nope', config: null });
    });

    it('without a body sends the default follow test alert', async () => {
      const res = await d.request('POST', '/api/alerts/test');
      expect(res.status).toBe(200);
      expect(res.json.alert).toMatchObject({ alertType: 'follow', user: 'TestUser', isTest: true });
    });
  });

  it('GET /animations and /tts/voices return the constant lists', async () => {
    expect((await d.get('/api/alerts/animations')).json).toEqual(ANIMATIONS);
    expect((await d.get('/api/alerts/tts/voices')).json).toEqual({ voices: TTS_VOICES });
  });

  it('concurrent POST /config/:alertType updates are all kept (file lock)', async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) => d.post('/api/alerts/config/follow', { [`k${i}`]: i })));
    const follow = d.readJson('alert-config.json').alertTypes.follow;
    for (let i = 0; i < 10; i++) expect(follow[`k${i}`]).toBe(i);
  });
});
