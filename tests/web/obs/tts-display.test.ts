/** @jest-environment jsdom */
/**
 * Characterization tests for obs/overlays/tts-display.html + tts-display.js
 * (compiled from src/web/obs/overlays/tts-display.ts).
 */
import { loadOverlay, flush, click, OverlayHarness, LoadOverlayOptions } from '../support/obs-overlay-harness';

async function load(opts: LoadOverlayOptions = {}): Promise<OverlayHarness> {
  const h = loadOverlay('tts-display', opts);
  await flush();
  return h;
}

describe('obs/overlays/tts-display.html', () => {
  let h: OverlayHarness;
  const container = () => h.$('tts-container');
  const audio = () => h.$('tts-audio') as HTMLAudioElement & Record<string, any>;

  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    h?.window.close();
  });

  it('ignores alerts that are not TTS', async () => {
    h = await load();
    h.ws.emit('alert', { alertType: 'follow', user: 'x', message: 'y' });
    await flush();
    expect(container().className).toBe('tts-container');
    expect(h.speech.spoken).toHaveLength(0);
  });

  it('shows a TTS alert that has no message instead of throwing', async () => {
    h = await load({ query: '?debug=true' });
    h.ws.emit('alert', { alertType: 'tts', user: 'Quiet', audioUrl: '/tts/clip.mp3', config: { duration: 1000 } });
    await flush();
    expect(h.logs.error.filter(a => String(a[0]).startsWith('[OverlayClient] Error'))).toEqual([]);
    expect(h.$('debug-last-tts').textContent).toBe('Quiet: "..."');
    expect(h.$('tts-username').textContent).toBe('Quiet');
    expect(h.$('tts-text').textContent).toBe('');
    expect(container().classList.contains('visible')).toBe(true);
  });

  it('a TTS alert without message or user falls back to browser speech of nothing', async () => {
    h = await load();
    h.ws.emit('alert', { alertType: 'tts', config: { duration: 1000 } });
    await flush();
    expect(h.logs.error.filter(a => String(a[0]).startsWith('[OverlayClient] Error'))).toEqual([]);
    expect(h.$('tts-username').textContent).toBe('');
    expect(container().classList.contains('visible')).toBe(true);
    await jest.advanceTimersByTimeAsync(1000);
    expect(container().className).toBe('tts-container');
    expect(h.speech.spoken).toHaveLength(0);
  });

  it('plays API audio from audioUrl, animates the progress bar and hides after audio end + duration', async () => {
    h = await load();
    h.ws.emit('alert', { alertType: 'tts', user: 'Zed', message: 'Read this please', audioUrl: '/tts/clip.mp3', config: { duration: 3000 } });
    await flush();
    expect(h.$('tts-username').textContent).toBe('Zed');
    expect(h.$('tts-text').textContent).toBe('Read this please');
    expect(container().className).toBe('tts-container visible slide-up speaking');
    expect(audio().getAttribute('src')).toBe('http://localhost:3001/tts/clip.mp3');
    expect(audio().volume).toBe(1);
    expect(h.mediaPlay).toHaveBeenCalledTimes(1);
    expect(h.$('tts-progress').style.width).toBe('0%');
    expect(h.$('tts-progress').style.transition).toBe('none');

    await jest.advanceTimersByTimeAsync(50);
    expect(h.$('tts-progress').style.transition).toBe('width 3000ms linear');
    expect(h.$('tts-progress').style.width).toBe('100%');

    await jest.advanceTimersByTimeAsync(3000);
    // still waiting for the audio to finish
    expect(container().classList.contains('visible')).toBe(true);
    audio().onended?.(new h.window.Event('ended'));
    await flush();
    expect(container().className).toBe('tts-container');
    expect(h.$('tts-progress').style.width).toBe('0%');
    expect(h.mediaPause).toHaveBeenCalled();
    expect(audio().getAttribute('src')).toBe('');
    expect(h.speech.spoken).toHaveLength(0);
  });

  it('uses browser speech (config.ttsTemplate or the message) when there is no audioUrl', async () => {
    h = await load({ query: '?rate=1.5&pitch=0.5&volume=0.25' });
    h.ws.emit('alert', { alertType: 'tts', user: 'Amy', message: 'hello world', config: { ttsTemplate: '{user} says {message}' } });
    await jest.advanceTimersByTimeAsync(50);
    expect(h.speech.spoken).toHaveLength(1);
    const u = h.speech.spoken[0];
    expect(u.text).toBe('Amy says hello world');
    expect([u.rate, u.pitch, u.volume]).toEqual([1.5, 0.5, 0.25]);
    u.onend?.();
    await jest.advanceTimersByTimeAsync(5000 - 50);
    expect(container().className).toBe('tts-container');
  });

  it('falls back to browser speech when API audio fails', async () => {
    h = await load();
    h.mediaPlay.mockImplementation(() => Promise.reject(new Error('decode error')));
    h.ws.emit('alert', { alertType: 'tts', user: 'Bo', message: 'fallback text', audioUrl: '/tts/bad.mp3' });
    await flush();
    expect(h.logs.error.some(a => a[0] === 'TTS speak error:')).toBe(true);
    await jest.advanceTimersByTimeAsync(50);
    expect(h.speech.spoken.map(u => u.text)).toEqual(['fallback text']);
  });

  it('a new TTS alert hides the current one and shows the new one 300ms later', async () => {
    h = await load({ query: '?duration=500' });
    h.ws.emit('alert', { alertType: 'tts', user: 'One', message: 'first', audioUrl: '/a.mp3' });
    await flush();
    h.ws.emit('alert', { alertType: 'tts', user: 'Two', message: 'second', audioUrl: '/b.mp3' });
    await flush();
    expect(container().className).toBe('tts-container');
    expect(h.$('tts-username').textContent).toBe('One');
    await jest.advanceTimersByTimeAsync(300);
    expect(h.$('tts-username').textContent).toBe('Two');
    expect(audio().getAttribute('src')).toBe('http://localhost:3001/b.mp3');
    // ?duration below the 1s minimum is clamped to 1000ms
    await jest.advanceTimersByTimeAsync(50);
    expect(h.$('tts-progress').style.transition).toBe('width 1000ms linear');
  });

  it('shows the audio unlock button after 500ms; clicking it primes speech and audio and hides it', async () => {
    h = await load({ query: '?debug=true' });
    const btn = h.$('audio-unlock-button');
    expect(btn.classList.contains('hidden')).toBe(true);
    jest.advanceTimersByTime(500);
    expect(btn.classList.contains('hidden')).toBe(false);

    click(btn);
    expect(btn.classList.contains('hidden')).toBe(true);
    expect(h.speech.cancel).toHaveBeenCalled();
    expect(h.speech.spoken).toHaveLength(1);
    expect(h.speech.spoken[0].text).toBe('.');
    expect(h.speech.spoken[0].volume).toBe(0.01);
    expect(h.speech.spoken[0].rate).toBe(10);
    expect(h.mediaPlay).toHaveBeenCalledTimes(1);
    expect(h.$('debug-audio').textContent).toBe('Unlocked ✓');
    await flush();
    expect(audio().volume).toBe(1);

    // only once
    click(h.document.body);
    expect(h.speech.spoken).toHaveLength(1);
  });

  it('auto-unlocks inside OBS (window.obsstudio) after 5.5s', async () => {
    h = await load({ beforeScripts: hh => { hh.window.obsstudio = {}; } });
    jest.advanceTimersByTime(5499);
    expect(h.speech.spoken).toHaveLength(0);
    jest.advanceTimersByTime(1);
    expect(h.speech.spoken.map(u => u.text)).toEqual(['.']);
    expect(h.$('audio-unlock-button').classList.contains('hidden')).toBe(true);
  });

  it('?debug=true shows the panel, voice info, connection state and runs the auto-test after 2s', async () => {
    h = await load({ query: '?debug=true&voice=en-GB' });
    expect(h.$('debug-panel').classList.contains('visible')).toBe(true);
    expect(h.$('debug-voices-count').textContent).toBe('3 voices (en-GB)');
    expect(h.$('debug-voice').textContent).toBe('English UK');
    expect(h.$('debug-status').textContent).toBe('Initialized');
    h.ws.open();
    expect(h.$('debug-connection').textContent).toBe('Connected');
    expect(h.$('debug-status').textContent).toBe('Listening for TTS events...');

    h.ws.emit('alert', { alertType: 'tts', user: 'Dbg', message: 'a'.repeat(40), audioUrl: '/x.mp3' });
    await flush();
    expect(h.$('debug-last-tts').textContent).toBe(`Dbg: "${'a'.repeat(30)}..."`);
    expect(h.$('debug-status').textContent).toBe('Speaking...');

    expect(typeof h.window.testTTS).toBe('function');
    h.ws.serverClose();
    expect(h.$('debug-connection').textContent).toBe('Disconnected');
    await jest.advanceTimersByTimeAsync(2000);
    expect(h.$('tts-username').textContent).toBe('AutoTest');
    expect(h.$('tts-text').textContent).toBe('Welcome to the TTS overlay! This is a test message.');
  });

  it('without ?debug there is no testTTS helper', async () => {
    h = await load();
    expect(h.window.testTTS).toBeUndefined();
    expect(h.$('debug-panel').classList.contains('visible')).toBe(false);
  });
});
