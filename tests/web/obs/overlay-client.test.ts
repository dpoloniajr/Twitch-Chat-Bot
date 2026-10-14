/** @jest-environment jsdom */
/**
 * Characterization tests for obs/js/overlay-client.js (compiled from
 * src/web/obs/js/overlay-client.ts): OverlayClient, AlertQueue, TTSManager, OverlayUtils.
 */
import { loadOverlayClient, flush, OverlayHarness, MockAudio, MockUtterance } from '../support/obs-overlay-harness';

describe('obs/js/overlay-client.js', () => {
  let h: OverlayHarness;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-01T12:00:00Z'));
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    h?.window.close();
  });

  it('exports OverlayClient, AlertQueue, TTSManager and OverlayUtils on window', () => {
    h = loadOverlayClient();
    for (const name of ['OverlayClient', 'AlertQueue', 'TTSManager', 'OverlayUtils']) {
      expect(h.window[name]).toBeDefined();
    }
    expect(typeof h.window.OverlayClient).toBe('function');
  });

  describe('OverlayClient', () => {
    it('connects to ws://<host> by default and wss:// on https pages', () => {
      h = loadOverlayClient();
      new h.window.OverlayClient();
      expect(h.sockets[0].url).toBe('ws://overlay.test:3001');
      h.window.close();

      h = loadOverlayClient({ protocol: 'https' });
      new h.window.OverlayClient();
      expect(h.sockets[0].url).toBe('wss://overlay.test:3001');

      new h.window.OverlayClient({ wsUrl: 'ws://elsewhere:1' });
      expect(h.sockets[1].url).toBe('ws://elsewhere:1');
    });

    it('emits connected, the raw message, and the typed event with data.data', () => {
      h = loadOverlayClient();
      const client = new h.window.OverlayClient();
      const seen: Array<[string, unknown]> = [];
      client.on('connected', (d: unknown) => seen.push(['connected', d]));
      client.on('message', (d: unknown) => seen.push(['message', d]));
      client.on('alert', (d: unknown) => seen.push(['alert', d]));

      h.ws.open();
      expect(client.isConnected).toBe(true);
      h.ws.emit('alert', { user: 'bob' });

      expect(seen).toEqual([
        ['connected', undefined],
        ['message', { type: 'alert', data: { user: 'bob' } }],
        ['alert', { user: 'bob' }],
      ]);
    });

    it('logs (does not throw) on invalid JSON and isolates throwing listeners', () => {
      h = loadOverlayClient();
      const client = new h.window.OverlayClient();
      const good = jest.fn();
      client.on('chat', () => {
        throw new Error('boom');
      });
      client.on('chat', good);

      h.ws.raw('not json');
      expect(h.logs.error.some(a => a[0] === '[OverlayClient] Failed to parse message:')).toBe(true);

      h.ws.emit('chat', { message: 'hi' });
      expect(good).toHaveBeenCalledWith({ message: 'hi' });
      expect(h.logs.error.some(a => a[0] === '[OverlayClient] Error in chat listener:')).toBe(true);
    });

    it('off() removes a listener; on() is chainable', () => {
      h = loadOverlayClient();
      const client = new h.window.OverlayClient();
      const fn = jest.fn();
      expect(client.on('x', fn)).toBe(client);
      expect(client.off('x', fn)).toBe(client);
      expect(client.off('never', fn)).toBe(client);
      h.ws.emit('x', 1);
      expect(fn).not.toHaveBeenCalled();
    });

    it('emits disconnected and reconnects after reconnectInterval, up to maxReconnectAttempts', () => {
      h = loadOverlayClient();
      const client = new h.window.OverlayClient({ reconnectInterval: 1000, maxReconnectAttempts: 2 });
      const disconnected = jest.fn();
      client.on('disconnected', disconnected);

      h.sockets[0].serverClose();
      expect(disconnected).toHaveBeenCalledTimes(1);
      expect(client.isConnected).toBe(false);
      jest.advanceTimersByTime(999);
      expect(h.sockets).toHaveLength(1);
      jest.advanceTimersByTime(1);
      expect(h.sockets).toHaveLength(2);

      h.sockets[1].serverClose();
      jest.advanceTimersByTime(1000);
      expect(h.sockets).toHaveLength(3);

      h.sockets[2].serverClose();
      jest.advanceTimersByTime(5000);
      expect(h.sockets).toHaveLength(3);
      expect(h.logs.log.some(a => a[0] === '[OverlayClient] Max reconnect attempts reached')).toBe(true);
    });

    it('a successful open resets the reconnect counter; default interval is 3000ms', () => {
      h = loadOverlayClient();
      const client = new h.window.OverlayClient();
      h.sockets[0].serverClose();
      expect(client.reconnectAttempts).toBe(1);
      jest.advanceTimersByTime(3000);
      h.sockets[1].open();
      expect(client.reconnectAttempts).toBe(0);
    });

    it('forwards socket errors as an error event; close() closes and drops the socket', () => {
      h = loadOverlayClient();
      const client = new h.window.OverlayClient();
      const onError = jest.fn();
      client.on('error', onError);
      h.ws.onerror?.({ type: 'error' });
      expect(onError).toHaveBeenCalledWith({ type: 'error' });
      client.close();
      expect(h.sockets[0].closed).toBe(true);
      expect(client.ws).toBeNull();
    });

    it('schedules a reconnect when the WebSocket constructor throws', () => {
      h = loadOverlayClient();
      const w = h.window as unknown as Record<string, unknown>;
      const real = w.WebSocket;
      w.WebSocket = function () {
        throw new Error('blocked');
      };
      const client = new h.window.OverlayClient();
      expect(client.reconnectAttempts).toBe(1);
      w.WebSocket = real;
      jest.advanceTimersByTime(3000);
      expect(h.sockets).toHaveLength(1);
    });
  });

  describe('AlertQueue', () => {
    it('shows alerts one at a time using config.duration, then waits alertDelay', () => {
      h = loadOverlayClient();
      const events: string[] = [];
      const q = new h.window.AlertQueue({
        alertDuration: 4000,
        alertDelay: 500,
        onShow: (a: { alertType: string }) => events.push(`show:${a.alertType}`),
        onHide: (a: { alertType: string }) => events.push(`hide:${a.alertType}`),
      });
      q.add({ alertType: 'follow', config: { duration: 1000 } });
      q.queueAlert({ alertType: 'raid' });
      expect(events).toEqual(['show:follow']);
      expect(q.queue).toHaveLength(1);
      expect(q.isProcessing).toBe(true);
      return (async () => {
        await jest.advanceTimersByTimeAsync(1000);
        expect(events).toEqual(['show:follow', 'hide:follow']);
        await jest.advanceTimersByTimeAsync(500);
        expect(events).toEqual(['show:follow', 'hide:follow', 'show:raid']);
        await jest.advanceTimersByTimeAsync(3999);
        expect(events).toHaveLength(3);
        await jest.advanceTimersByTimeAsync(1);
        expect(events[3]).toBe('hide:raid');
        await jest.advanceTimersByTimeAsync(500);
        expect(q.isProcessing).toBe(false);
        expect(q.currentAlert).toBeNull();
      })();
    });

    it('uses defaults of 5000ms duration / 1000ms delay / volume 0.5', () => {
      h = loadOverlayClient();
      const q = new h.window.AlertQueue();
      expect([q.alertDuration, q.alertDelay, q.soundVolume, q.soundEnabled]).toEqual([5000, 1000, 0.5, true]);
    });

    it('loads sounds and plays a clone at the current alert volume, falling back to default', () => {
      h = loadOverlayClient();
      const q = new h.window.AlertQueue({ soundVolume: 0.3 });
      q.loadSound('default', '/d.mp3');
      q.loadSound('follow', '/f.mp3');
      const base = MockAudio.instances[1];
      expect(base.src).toBe('/f.mp3');
      expect(base.volume).toBe(0.3);
      expect(base.preload).toBe('auto');

      q.currentAlert = { config: { volume: 0.9 } };
      q.playSound('follow');
      const clone = MockAudio.instances[2];
      expect(clone.src).toBe('/f.mp3');
      expect(clone.volume).toBe(0.9);
      expect(clone.play).toHaveBeenCalled();

      q.currentAlert = null;
      q.playSound('unknown');
      const clone2 = MockAudio.instances[3];
      expect(clone2.src).toBe('/d.mp3');
      expect(clone2.volume).toBe(0.3);
    });

    it('does not play when sound is disabled; updateConfig updates settings and loaded volumes', () => {
      h = loadOverlayClient();
      const q = new h.window.AlertQueue({ soundEnabled: false });
      q.loadSound('default', '/d.mp3');
      q.playSound('default');
      expect(MockAudio.instances).toHaveLength(1);

      q.updateConfig({ alertDuration: 2000, alertDelay: 10, soundEnabled: true, soundVolume: 0.7 });
      expect([q.alertDuration, q.alertDelay, q.soundEnabled, q.soundVolume]).toEqual([2000, 10, true, 0.7]);
      expect(MockAudio.instances[0].volume).toBe(0.7);
      q.updateConfig({});
      expect(q.alertDuration).toBe(2000);
    });

    it('logs a warning when playback is rejected', async () => {
      h = loadOverlayClient();
      const q = new h.window.AlertQueue();
      q.loadSound('default', '/d.mp3');
      const base = MockAudio.instances[0];
      base.cloneNode = () => {
        const c = new MockAudio('/d.mp3');
        c.play = jest.fn(() => Promise.reject(new Error('autoplay')));
        return c;
      };
      q.playSound('default');
      await flush();
      expect(h.logs.warn.some(a => a[0] === '[AlertQueue] Sound play failed:')).toBe(true);
    });

    it('clear() empties the pending queue', () => {
      h = loadOverlayClient();
      const q = new h.window.AlertQueue();
      q.add({ alertType: 'a' });
      q.add({ alertType: 'b' });
      q.clear();
      expect(q.queue).toEqual([]);
    });
  });

  describe('TTSManager', () => {
    it('selects the exact-language voice, then the language family, then the default', () => {
      h = loadOverlayClient();
      expect(new h.window.TTSManager({ voice: 'en-GB' }).selectedVoice.name).toBe('English UK');
      expect(new h.window.TTSManager({ voice: 'de-AT' }).selectedVoice.name).toBe('Deutsch');
      const fr = new h.window.TTSManager({ voice: 'fr-FR' });
      expect(fr.selectedVoice.name).toBe('English US');
      fr.updateConfig({ voice: 'de-DE', rate: 2, pitch: 0.5, volume: 0.1, enabled: false });
      expect([fr.selectedVoice.name, fr.rate, fr.pitch, fr.volume, fr.enabled]).toEqual(['Deutsch', 2, 0.5, 0.1, false]);
    });

    it('re-reads voices on voiceschanged', () => {
      h = loadOverlayClient();
      const tts = new h.window.TTSManager({ voice: 'ja-JP' });
      h.speech.voices = [...h.speech.voices, { name: 'Japanese', lang: 'ja-JP' }];
      h.speech.onvoiceschanged?.();
      expect(tts.selectedVoice.name).toBe('Japanese');
    });

    it('speak() cancels, waits 50ms, speaks with the configured settings and resolves on end', async () => {
      h = loadOverlayClient();
      const tts = new h.window.TTSManager({ voice: 'en-GB', rate: 1.2, pitch: 0.8, volume: 0.6 });
      let done = false;
      const p = tts.speak('hello there').then(() => {
        done = true;
      });
      await flush();
      expect(h.speech.cancel).toHaveBeenCalled();
      expect(h.speech.speak).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(50);
      expect(h.speech.speak).toHaveBeenCalledTimes(1);
      const u = h.speech.spoken[0] as MockUtterance;
      expect(u).toBeInstanceOf(MockUtterance);
      expect(u.text).toBe('hello there');
      expect(u.voice).toEqual(expect.objectContaining({ name: 'English UK' }));
      expect([u.rate, u.pitch, u.volume]).toEqual([1.2, 0.8, 0.6]);
      expect(tts.currentUtterance).toBe(u);

      u.onstart?.();
      await jest.advanceTimersByTimeAsync(5000);
      expect(done).toBe(false);
      u.onend?.();
      await p;
      expect(done).toBe(true);
      expect(tts.currentUtterance).toBeNull();
    });

    it('speak() option overrides win over instance settings', async () => {
      h = loadOverlayClient();
      const tts = new h.window.TTSManager();
      tts.speak('x', { rate: 2, pitch: 0, volume: 0 });
      await jest.advanceTimersByTimeAsync(50);
      const u = h.speech.spoken[0];
      expect([u.rate, u.pitch, u.volume]).toEqual([2, 0, 0]);
    });

    it('resolves without speaking when disabled, unsupported, or given blank text', async () => {
      h = loadOverlayClient();
      await new h.window.TTSManager({ enabled: false }).speak('hi');
      await new h.window.TTSManager().speak('   ');
      expect(h.speech.speak).not.toHaveBeenCalled();
      h.window.close();

      h = loadOverlayClient({ speech: false });
      const tts = new h.window.TTSManager();
      expect(tts.supported).toBe(false);
      await tts.speak('hi');
    });

    it('gives up after 2s when speech never starts', async () => {
      h = loadOverlayClient();
      const tts = new h.window.TTSManager();
      let done = false;
      tts.speak('stuck').then(() => {
        done = true;
      });
      await jest.advanceTimersByTimeAsync(50 + 1999);
      expect(done).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
      expect(h.logs.error.some(a => String(a[0]).includes('Speech failed to start within 2 seconds'))).toBe(true);
    });

    it('resolves on utterance error', async () => {
      h = loadOverlayClient();
      const tts = new h.window.TTSManager();
      const p = tts.speak('err');
      await jest.advanceTimersByTimeAsync(50);
      h.speech.spoken[0].onerror?.({ error: 'synthesis-failed', charIndex: 0 });
      await p;
      expect(h.logs.warn.some(a => a[1] === 'synthesis-failed')).toBe(true);
    });

    it('a newer speak() resolves the previous one; stop() resolves the pending one and cancels', async () => {
      h = loadOverlayClient();
      const tts = new h.window.TTSManager();
      let first = false;
      tts.speak('one').then(() => {
        first = true;
      });
      await flush();
      const second = tts.speak('two');
      await flush();
      expect(first).toBe(true);
      await jest.advanceTimersByTimeAsync(50);
      expect(h.speech.spoken.map(u => u.text)).toEqual(['two']);

      tts.stop();
      await second;
      expect(h.speech.cancel).toHaveBeenCalled();
      expect(tts.currentUtterance).toBeNull();
    });

    it('waits for voices (voiceschanged or 1s) when none are loaded yet', async () => {
      h = loadOverlayClient({ voices: [] });
      const tts = new h.window.TTSManager({ voice: 'en-GB' });
      let ready = false;
      tts._ensureVoicesLoaded().then(() => {
        ready = true;
      });
      await flush();
      expect(ready).toBe(false);
      h.speech.voices = [{ name: 'English UK', lang: 'en-GB' }];
      h.speech.onvoiceschanged?.();
      await flush();
      expect(ready).toBe(true);
      expect(tts.selectedVoice.name).toBe('English UK');

      const tts2 = new h.window.TTSManager();
      tts2.voices = [];
      h.speech.voices = [];
      let ready2 = false;
      tts2._ensureVoicesLoaded().then(() => {
        ready2 = true;
      });
      await jest.advanceTimersByTimeAsync(1000);
      expect(ready2).toBe(true);
    });

    it('parseTemplate replaces known {placeholders} and keeps unknown ones', () => {
      h = loadOverlayClient();
      const tts = new h.window.TTSManager();
      expect(tts.parseTemplate('{user} gave {amount} {nope}', { user: 'Ann', amount: 5 })).toBe('Ann gave 5 {nope}');
      expect(tts.parseTemplate('', {})).toBe('');
      expect(tts.parseTemplate(undefined, {})).toBe('');
    });
  });

  describe('OverlayUtils', () => {
    it('timeAgo', () => {
      h = loadOverlayClient();
      const u = h.window.OverlayUtils;
      expect(u.timeAgo(new Date('2026-05-01T11:59:30Z'))).toBe('just now');
      expect(u.timeAgo('2026-05-01T11:55:00Z')).toBe('5m ago');
      expect(u.timeAgo('2026-05-01T09:00:00Z')).toBe('3h ago');
      expect(u.timeAgo('2026-04-29T12:00:00Z')).toBe('2d ago');
    });

    it('escapeHtml, formatNumber, parseTier, getQueryParam', () => {
      h = loadOverlayClient({ query: '?limit=7&name=a%20b' });
      const u = h.window.OverlayUtils;
      expect(u.escapeHtml('<b>"x" & y</b>')).toBe('&lt;b&gt;"x" &amp; y&lt;/b&gt;');
      expect(u.formatNumber(1234567)).toBe('1,234,567');
      expect(u.formatNumber(999)).toBe('999');
      expect(u.parseTier('1000')).toBe('Tier 1');
      expect(u.parseTier('3000')).toBe('Tier 3');
      expect(u.parseTier('Prime')).toBe('Prime');
      expect(u.parseTier('9000')).toBe('9000');
      expect(u.parseTier(undefined)).toBeUndefined();
      expect(u.getQueryParam('limit')).toBe('7');
      expect(u.getQueryParam('name')).toBe('a b');
      expect(u.getQueryParam('missing')).toBeNull();
    });
  });
});
