/** @jest-environment jsdom */
/**
 * Characterization tests for obs/overlays/alerts.html + alerts.js
 * (compiled from src/web/obs/overlays/alerts.ts).
 */
import { loadOverlay, flush, OverlayHarness, MockAudio, LoadOverlayOptions } from '../support/obs-overlay-harness';

const ALERT_CONFIG = {
  global: { enabled: true, ttsEnabled: false, defaultVolume: 0.6, defaultDuration: 4, defaultDelay: 2 },
  alertTypes: {
    follow: { enabled: true, duration: 3, messageTemplate: 'Welcome {user}! {user} is here' },
    bits: { enabled: true, minBits: 100, messageTemplate: '{user} cheered {amount}', textColor: '#00ff00' },
    raid: { enabled: true, minViewers: 10 },
    subscription: { enabled: true, messageTemplate: '{user} subbed at {tier}', borderColor: '#123456', fontSize: 40 },
    redemption: { enabled: false },
  },
};

async function load(opts: LoadOverlayOptions = {}): Promise<OverlayHarness> {
  const h = loadOverlay('alerts', {
    routes: { '/api/alerts/config': { body: ALERT_CONFIG } },
    ...opts,
  });
  await flush();
  return h;
}

describe('obs/overlays/alerts.html', () => {
  let h: OverlayHarness;

  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    h?.window.close();
  });

  it('loads /api/alerts/config, connects the WebSocket and preloads the default sounds', async () => {
    h = await load();
    expect(h.fetchCalls.map(c => c.url)).toEqual(['/api/alerts/config']);
    expect(h.sockets).toHaveLength(1);
    expect(h.ws.url).toBe('ws://localhost:3001');
    expect(MockAudio.instances.map(a => a.src)).toEqual([
      '../assets/sounds/follow.mp3',
      '../assets/sounds/subscribe.mp3',
      '../assets/sounds/bits.mp3',
      '../assets/sounds/raid.mp3',
      '../assets/sounds/redemption.mp3',
      '../assets/sounds/default.mp3',
      '../assets/sounds/default.mp3',
    ]);
    expect(MockAudio.instances.every(a => a.volume === 0.6)).toBe(true);
    expect(typeof h.window.testAlert).toBe('function');
    expect(typeof h.window.testAllAlerts).toBe('function');
    expect(h.window.alertQueue).toBeDefined();
    expect(h.window.client).toBeDefined();
  });

  it('renders a follow alert from the WebSocket, plays its sound, then hides it after the type duration', async () => {
    h = await load();
    h.ws.open();
    h.ws.emit('alert', { alertType: 'follow', user: 'Alice', message: 'hi all' });

    expect(h.$('alertWrapper').classList.contains('visible')).toBe(true);
    expect(h.$('alertBox').className).toBe('alert-box follow animate-bounceIn');
    expect(h.$('alertIcon').textContent).toBe('👤');
    expect(h.$('alertTypeLabel').textContent).toBe('New Follower');
    expect(h.$('alertUsername').textContent).toBe('Alice');
    expect(h.$('alertMessage').textContent).toBe('Welcome Alice! Alice is here');
    expect(h.$('alertUserMessage').textContent).toBe('"hi all"');
    expect(h.$('alertUserMessage').style.display).toBe('block');
    expect(h.$('alertDetails').textContent).toBe('');

    const played = MockAudio.instances.slice(7);
    expect(played).toHaveLength(1);
    expect(played[0].src).toBe('../assets/sounds/follow.mp3');
    expect(played[0].volume).toBe(0.8); // ?volume default, since neither data.config nor type config sets one
    expect(played[0].play).toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(2999);
    expect(h.$('alertBox').classList.contains('animate-fadeOutUp')).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(h.$('alertBox').className).toBe('alert-box follow animate-fadeOutUp');
    expect(h.$('alertWrapper').classList.contains('visible')).toBe(true);
    await jest.advanceTimersByTimeAsync(500);
    expect(h.$('alertWrapper').classList.contains('visible')).toBe(false);
    expect(h.$('alertBox').className).toBe('alert-box');
    expect(h.$('mediaContainer').innerHTML).toBe('');
  });

  it('queues alerts and shows the next one after the global delay', async () => {
    h = await load();
    h.ws.emit('alert', { alertType: 'follow', user: 'One' });
    h.ws.emit('alert', { alertType: 'follow', user: 'Two' });
    expect(h.$('alertUsername').textContent).toBe('One');
    expect(h.window.alertQueue.queue).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(3000 + 2000 - 1);
    expect(h.$('alertUsername').textContent).toBe('One');
    await jest.advanceTimersByTimeAsync(1);
    expect(h.$('alertUsername').textContent).toBe('Two');
  });

  it('formats bits, raid and subscription tier details', async () => {
    h = await load();
    h.ws.emit('alert', { alertType: 'bits', user: 'Bob', amount: 1500, config: { duration: 100 } });
    expect(h.$('alertAmount').textContent).toBe('1,500 Bits');
    expect(h.$('alertAmount').style.display).toBe('block');
    expect(h.$('alertAmount').style.color).toBe('rgb(0, 255, 0)');
    expect(h.$('alertMessage').textContent).toBe('Bob cheered 1500');
    await jest.advanceTimersByTimeAsync(100 + 2000);

    h.ws.emit('alert', { alertType: 'raid', user: 'Rae', viewers: 12345, config: { duration: 100 } });
    expect(h.$('alertDetails').textContent).toBe('12,345 viewers');
    expect(h.$('alertIcon').textContent).toBe('🎮');
    expect(h.$('alertMessage').textContent).toBe('');
    await jest.advanceTimersByTimeAsync(100 + 2000);

    h.ws.emit('alert', { alertType: 'subscription', user: 'Sue', tier: '2000', config: { duration: 100 } });
    expect(h.$('alertTier').textContent).toBe('Tier 2');
    expect(h.$('alertTier').className).toBe('alert-tier tier-2');
    expect(h.$('alertTier').style.display).toBe('inline-block');
    expect(h.$('alertMessage').textContent).toBe('Sue subbed at Tier 2');
    expect(h.$('alertBox').style.borderColor).toBe('rgb(18, 52, 86)');
    expect(h.$('alertUsername').style.fontSize).toBe('40px');
  });

  it('applies server-sent config (image, animations, colors) over the type config', async () => {
    h = await load();
    h.ws.emit('alert', {
      alertType: 'follow',
      user: 'Img',
      config: { image: '/uploads/a.png', enterAnimation: 'zoomIn', exitAnimation: 'zoomOut', backgroundColor: 'red', duration: 1000 },
    });
    const img = h.$('mediaContainer').querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/uploads/a.png');
    expect(img.className).toBe('alert-media');
    expect(h.$('alertBox').classList.contains('animate-zoomIn')).toBe(true);
    expect(h.$('alertBox').style.background).toBe('red');
    await jest.advanceTimersByTimeAsync(1000);
    expect(h.$('alertBox').className).toBe('alert-box follow animate-zoomOut');
  });

  it('prefers video media and pauses it when hiding', async () => {
    h = await load();
    h.ws.emit('alert', { alertType: 'follow', user: 'Vid', config: { video: '/v.mp4', image: '/i.png', duration: 100 } });
    const video = h.$('mediaContainer').querySelector('video') as HTMLVideoElement;
    expect(video.getAttribute('src')).toBe('/v.mp4');
    expect(video.className).toBe('alert-video');
    expect([video.autoplay, video.loop, video.muted]).toEqual([true, true, true]);
    expect(h.$('mediaContainer').querySelector('img')).toBeNull();
    await jest.advanceTimersByTimeAsync(600);
    expect(h.mediaPause).toHaveBeenCalled();
  });

  it('drops alerts when globally disabled, type-disabled or under the bits/raid minimum', async () => {
    h = await load();
    h.ws.emit('alert', { alertType: 'redemption', user: 'R', reward: 'Hydrate' });
    h.ws.emit('alert', { alertType: 'bits', user: 'B', amount: 99 });
    h.ws.emit('alert', { alertType: 'raid', user: 'Ra', viewers: 9 });
    expect(h.$('alertWrapper').classList.contains('visible')).toBe(false);
    expect(h.window.alertQueue.queue).toHaveLength(0);

    h.ws.emit('alertConfig', { ...ALERT_CONFIG, global: { ...ALERT_CONFIG.global, enabled: false } });
    h.ws.emit('alert', { alertType: 'follow', user: 'F' });
    expect(h.$('alertWrapper').classList.contains('visible')).toBe(false);
  });

  it('alertConfig messages update queue timing and volume', async () => {
    h = await load();
    h.ws.emit('alertConfig', { global: { defaultDuration: 9, defaultDelay: 3, defaultVolume: 0.2 }, alertTypes: {} });
    const q = h.window.alertQueue;
    expect([q.alertDuration, q.alertDelay, q.soundVolume]).toEqual([9000, 3000, 0.2]);
  });

  it('falls back to defaults when the config request fails', async () => {
    h = await load({ routes: { '/api/alerts/config': { networkError: true } } });
    expect(h.logs.warn.some(a => a[0] === '[Alerts] Failed to load config, using defaults:')).toBe(true);
    h.ws.emit('alert', { alertType: 'follow', user: 'Dflt' });
    expect(h.$('alertUsername').textContent).toBe('Dflt');
    expect(h.$('alertMessage').textContent).toBe('');
    await jest.advanceTimersByTimeAsync(4999);
    expect(h.$('alertBox').classList.contains('animate-fadeOutUp')).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(h.$('alertBox').classList.contains('animate-fadeOutUp')).toBe(true);
  });

  it('uses a custom sound when sound=custom and none when sound=none', async () => {
    h = await load({
      routes: {
        '/api/alerts/config': { body: { global: {}, alertTypes: {
          follow: { sound: 'custom', customSound: '/uploads/ding.mp3', duration: 1 },
          raid: { sound: 'none', duration: 1 },
        } } },
      },
    });
    const before = MockAudio.instances.length;
    h.ws.emit('alert', { alertType: 'follow', user: 'C' });
    const created = MockAudio.instances.slice(before);
    expect(created.map(a => a.src)).toEqual(['/uploads/ding.mp3', '/uploads/ding.mp3']);
    expect(created[1].play).toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1000 + 1000);
    const before2 = MockAudio.instances.length;
    h.ws.emit('alert', { alertType: 'raid', user: 'N', viewers: 1 });
    expect(h.$('alertUsername').textContent).toBe('N');
    expect(MockAudio.instances.length).toBe(before2);
  });

  it('speaks the TTS template 500ms after showing when TTS is enabled globally and for the type', async () => {
    h = await load({
      routes: {
        '/api/alerts/config': { body: {
          global: { ttsEnabled: true, ttsVoice: 'en-GB', ttsRate: 1.5 },
          alertTypes: { bits: { ttsEnabled: true, ttsTemplate: '{user} sent {amount} bits: {message}', volume: 0.4 } },
        } },
      },
    });
    h.ws.emit('alert', { alertType: 'bits', user: 'Tia', amount: 300, message: 'gg' });
    await jest.advanceTimersByTimeAsync(500);
    expect(h.speech.cancel).toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(50);
    expect(h.speech.spoken).toHaveLength(1);
    const u = h.speech.spoken[0];
    expect(u.text).toBe('Tia sent 300 bits: gg');
    expect(u.rate).toBe(1.5);
    expect(u.volume).toBe(0.4);
    expect(u.voice).toEqual(expect.objectContaining({ lang: 'en-GB' }));
  });

  it('shows the debug panel with ?debug=true and tracks status / last alert / queue', async () => {
    h = await load({ query: '?debug=true' });
    expect(h.$('debugPanel').classList.contains('visible')).toBe(true);
    h.ws.open();
    expect(h.$('debugStatus').textContent).toBe('Connected');
    h.ws.emit('alert', { alertType: 'follow', user: 'Dee' });
    expect(h.$('debugLastAlert').textContent).toBe('follow: Dee');
    expect(h.$('debugQueue').textContent).toBe('0');
    h.ws.serverClose();
    expect(h.$('debugStatus').textContent).toBe('Disconnected');
  });

  it('hides the viewer message when the type config sets showMessage: false', async () => {
    h = await load({
      routes: { '/api/alerts/config': { body: { ...ALERT_CONFIG, alertTypes: {
        ...ALERT_CONFIG.alertTypes,
        bits: { ...ALERT_CONFIG.alertTypes.bits, showMessage: false, duration: 1 },
        subscription: { ...ALERT_CONFIG.alertTypes.subscription, showMessage: true, duration: 1 },
      } } } },
    });
    h.ws.emit('alert', { alertType: 'bits', user: 'B', amount: 500, message: 'secret' });
    expect(h.$('alertUsername').textContent).toBe('B');
    expect(h.$('alertUserMessage').style.display).toBe('none');
    await jest.advanceTimersByTimeAsync(1000 + 2000);

    h.ws.emit('alert', { alertType: 'subscription', user: 'S', tier: '1000', message: 'shown' });
    expect(h.$('alertUserMessage').textContent).toBe('"shown"');
    expect(h.$('alertUserMessage').style.display).toBe('block');
  });

  it('server-sent config.showMessage overrides the type config', async () => {
    h = await load();
    h.ws.emit('alert', { alertType: 'follow', user: 'A', message: 'hidden', config: { showMessage: false, duration: 100 } });
    expect(h.$('alertUserMessage').style.display).toBe('none');
  });

  it('an explicit ?duration overrides both the type config and server-sent config', async () => {
    h = await load({ query: '?duration=1500' });
    // type config says 3s, the server says 10s: the URL wins
    h.ws.emit('alert', { alertType: 'follow', user: 'D', config: { duration: 10000 } });
    await jest.advanceTimersByTimeAsync(1499);
    expect(h.$('alertBox').classList.contains('animate-fadeOutUp')).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(h.$('alertBox').classList.contains('animate-fadeOutUp')).toBe(true);
  });

  it('an unusable ?duration is ignored and the server config applies', async () => {
    h = await load({ query: '?duration=abc&volume=7' });
    h.ws.emit('alert', { alertType: 'follow', user: 'D' });
    expect(MockAudio.instances.slice(7)[0].volume).toBe(0.8);
    await jest.advanceTimersByTimeAsync(2999);
    expect(h.$('alertBox').classList.contains('animate-fadeOutUp')).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(h.$('alertBox').classList.contains('animate-fadeOutUp')).toBe(true);
  });

  it('an explicit ?volume overrides the type and server-sent volume, including 0', async () => {
    h = await load({ query: '?volume=0' });
    h.ws.emit('alert', { alertType: 'follow', user: 'V', config: { volume: 0.9, duration: 100 } });
    const played = MockAudio.instances.slice(7);
    expect(played).toHaveLength(1);
    expect(played[0].volume).toBe(0);
  });

  it('testAlert() fills in type defaults', async () => {
    h = await load();
    h.window.testAlert('bits', 'Tester');
    expect(h.$('alertAmount').textContent).toBe('100 Bits');
    expect(h.window.alertQueue.currentAlert.isTest).toBe(true);
  });
});
