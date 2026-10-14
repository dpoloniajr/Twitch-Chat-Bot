/**
 * Tests for src/lib/tts-service.ts (also loaded through the tts-service.js shim)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  configFromEnv, createTTSService, getCacheKey, TTSConfig, TTSHttpClient, TTS_PROVIDERS
} from '../../src/lib/tts-service';

describe('tts-service', () => {
  let dir: string;
  let http: { post: jest.Mock };

  const config = (overrides: Partial<TTSConfig> = {}): TTSConfig => ({
    ...configFromEnv({}, dir),
    ...overrides
  });
  const service = (overrides: Partial<TTSConfig> = {}) =>
    createTTSService(config(overrides), http as unknown as TTSHttpClient);
  const mp3s = () => fs.readdirSync(dir).filter((f) => f.endsWith('.mp3'));

  beforeEach(() => {
    dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tts-')), 'cache', 'tts');
    http = { post: jest.fn(async () => ({ data: Buffer.from('audio-bytes') })) };
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    fs.rmSync(path.dirname(path.dirname(dir)), { recursive: true, force: true });
  });

  describe('configFromEnv', () => {
    it('uses defaults', () => {
      const c = configFromEnv({}, '/x');
      expect(c).toEqual({
        provider: 'browser', elevenLabsApiKey: '', elevenLabsVoiceId: 'EXAVITQu4vr4xnSDxMaL', elevenLabsModel: 'eleven_monolingual_v1',
        openaiApiKey: '', openaiVoice: 'alloy', openaiModel: 'tts-1', cacheEnabled: true, cacheDir: '/x',
        cacheMaxAge: 86400000, cacheMaxSize: 104857600
      });
    });

    it('reads every variable', () => {
      const c = configFromEnv({
        TTS_PROVIDER: 'openai', ELEVENLABS_API_KEY: 'e', ELEVENLABS_VOICE_ID: 'v', ELEVENLABS_MODEL: 'm',
        OPENAI_API_KEY: 'o', OPENAI_TTS_VOICE: 'nova', OPENAI_TTS_MODEL: 'tts-1-hd',
        TTS_CACHE_ENABLED: 'false', TTS_CACHE_MAX_AGE: '10', TTS_CACHE_MAX_SIZE: '20'
      }, '/x');
      expect(c).toMatchObject({ provider: 'openai', elevenLabsVoiceId: 'v', openaiVoice: 'nova', cacheEnabled: false, cacheMaxAge: 10, cacheMaxSize: 20 });
    });

    it('puts the cache under dashboard/cache/tts in the project by default', () => {
      expect(configFromEnv({}).cacheDir).toBe(path.join(__dirname, '..', '..', 'dashboard', 'cache', 'tts'));
    });
  });

  describe('initialize', () => {
    it('creates the cache folder and loads existing mp3 files', async () => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'a.mp3'), '12345');
      fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
      const tts = service();
      await tts.initialize();
      expect(tts.getConfig()).toMatchObject({ cacheEnabled: true, cacheCount: 1, cacheSize: 5 });
    });

    it('disables the cache when the folder cannot be created', async () => {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      fs.writeFileSync(dir, 'a file in the way');
      const tts = service();
      await tts.initialize();
      expect(tts.getConfig().cacheEnabled).toBe(false);
    });

    it.each([['elevenlabs'], ['openai']])('falls back to browser when %s has no API key', async (provider) => {
      const tts = service({ provider });
      await tts.initialize();
      expect(tts.getConfig().provider).toBe('browser');
      expect(console.warn).toHaveBeenCalled();
    });

    it('keeps a provider that has a key, and skips the cache when disabled', async () => {
      const tts = service({ provider: 'openai', openaiApiKey: 'k', cacheEnabled: false });
      await tts.initialize();
      expect(tts.getConfig()).toMatchObject({ provider: 'openai', cacheEnabled: false });
      expect(fs.existsSync(dir)).toBe(false);
    });
  });

  describe('generateTTS', () => {
    it('tells the client to use browser TTS for the browser provider', async () => {
      await expect(service().generateTTS('hi')).resolves.toEqual({ success: true, provider: 'browser', useBrowserTTS: true });
      expect(http.post).not.toHaveBeenCalled();
    });

    it('calls ElevenLabs with the configured voice and caches the result', async () => {
      const tts = service({ provider: 'elevenlabs', elevenLabsApiKey: 'xi' });
      await tts.initialize();
      const result = await tts.generateTTS('hello');
      const key = getCacheKey('hello', 'EXAVITQu4vr4xnSDxMaL', 'elevenlabs');
      expect(result).toEqual({ success: true, audioUrl: `/api/tts/audio/${key}.mp3`, provider: 'elevenlabs', cached: false });
      expect(http.post).toHaveBeenCalledWith(
        'https://api.elevenlabs.io/v1/text-to-speech/EXAVITQu4vr4xnSDxMaL',
        { text: 'hello', model_id: 'eleven_monolingual_v1', voice_settings: { stability: 0.5, similarity_boost: 0.75 } },
        { headers: { 'xi-api-key': 'xi', 'Content-Type': 'application/json' }, responseType: 'arraybuffer', timeout: 30000 }
      );
      expect(fs.readFileSync(path.join(dir, `${key}.mp3`), 'utf8')).toBe('audio-bytes');

      // Second call is served from the cache
      await expect(tts.generateTTS('hello')).resolves.toMatchObject({ cached: true, audioUrl: result.audioUrl });
      expect(http.post).toHaveBeenCalledTimes(1);
    });

    it('calls OpenAI with an explicit voice and provider override', async () => {
      const tts = service({ openaiApiKey: 'sk' });
      await tts.initialize();
      await tts.generateTTS('hey', { provider: 'openai', voice: 'nova' });
      expect(http.post).toHaveBeenCalledWith(
        'https://api.openai.com/v1/audio/speech',
        { model: 'tts-1', input: 'hey', voice: 'nova', response_format: 'mp3' },
        expect.objectContaining({ headers: { Authorization: 'Bearer sk', 'Content-Type': 'application/json' } })
      );
    });

    it.each([
      ['elevenlabs', 'ElevenLabs TTS generation failed'],
      ['openai', 'OpenAI TTS generation failed']
    ])('falls back to browser TTS when %s fails', async (provider, message) => {
      http.post.mockRejectedValue({ message: 'boom', response: { data: 'quota' } });
      const tts = service({ provider, elevenLabsApiKey: 'xi', openaiApiKey: 'sk' });
      await tts.initialize();
      await expect(tts.generateTTS('x')).resolves.toEqual({ success: false, provider: 'browser', useBrowserTTS: true, error: message });
    });

    it('reports a failure when the cache is disabled, since there is nowhere to serve audio from', async () => {
      const tts = service({ provider: 'openai', openaiApiKey: 'k', cacheEnabled: false });
      await expect(tts.generateTTS('x')).resolves.toMatchObject({ success: false, error: 'Failed to save audio to cache' });
    });

    it('expires cached audio older than cacheMaxAge', async () => {
      const now = jest.spyOn(Date, 'now');
      now.mockReturnValue(1_000_000);
      const tts = service({ provider: 'openai', openaiApiKey: 'k', cacheMaxAge: 1000 });
      await tts.initialize();
      await tts.generateTTS('x');
      now.mockReturnValue(1_002_000);
      await expect(tts.generateTTS('x')).resolves.toMatchObject({ cached: false });
      expect(http.post).toHaveBeenCalledTimes(2);
    });

    it('regenerates when a cached file was deleted from disk', async () => {
      const tts = service({ provider: 'openai', openaiApiKey: 'k' });
      await tts.initialize();
      await tts.generateTTS('x');
      for (const f of mp3s()) fs.unlinkSync(path.join(dir, f));
      await expect(tts.generateTTS('x')).resolves.toMatchObject({ cached: false });
      expect(tts.getConfig()).toMatchObject({ cacheCount: 1, cacheSize: 11 });
    });

    it('evicts the least recently used files when over the size limit', async () => {
      let t = 1000;
      jest.spyOn(Date, 'now').mockImplementation(() => (t += 10));
      const tts = service({ provider: 'openai', openaiApiKey: 'k', cacheMaxSize: 25 });
      await tts.initialize();
      await tts.generateTTS('a'); // 11 bytes each
      await tts.generateTTS('b');
      await tts.generateTTS('a'); // touch a, so b is now oldest
      await tts.generateTTS('c'); // 33 > 25: evict ceil(3 * 25%) = 1 file
      const keys = mp3s().map((f) => f.replace('.mp3', '')).sort();
      expect(keys).toEqual([getCacheKey('a', 'alloy', 'openai'), getCacheKey('c', 'alloy', 'openai')].sort());
      expect(tts.getConfig()).toMatchObject({ cacheCount: 2, cacheSize: 22 });
    });

    it('keys the cache by provider and voice', () => {
      expect(getCacheKey('t', 'v', 'openai')).not.toBe(getCacheKey('t', 'v', 'elevenlabs'));
      expect(getCacheKey('t', 'v', 'openai')).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it('reports provider availability in getConfig', () => {
    expect(service({ openaiApiKey: 'k' }).getConfig().providers).toEqual({
      elevenlabs: { available: false, voice: 'EXAVITQu4vr4xnSDxMaL', model: 'eleven_monolingual_v1' },
      openai: { available: true, voice: 'alloy', model: 'tts-1' },
      browser: { available: true }
    });
  });

  it('exposes the provider names', () => {
    expect(TTS_PROVIDERS.BROWSER).toBe('browser');
  });
});
