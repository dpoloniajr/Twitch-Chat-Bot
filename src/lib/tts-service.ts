/**
 * TTS Service - Premium AI Text-to-Speech Integration
 *
 * Supports multiple TTS providers with automatic fallback:
 * - ElevenLabs (Premium quality, voice cloning)
 * - OpenAI TTS (Good quality, reliable)
 * - Browser Web Speech API (Free fallback)
 *
 * Generated audio is cached on disk as `<sha256>.mp3` and evicted by age and
 * total size (least recently used first).
 */

import axios from 'axios';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { projectPath } from '../utils/project-root';

export const TTS_PROVIDERS = {
  ELEVENLABS: 'elevenlabs',
  OPENAI: 'openai',
  BROWSER: 'browser'
} as const;

export type TTSProvider = (typeof TTS_PROVIDERS)[keyof typeof TTS_PROVIDERS];

export interface TTSConfig {
  provider: string;
  elevenLabsApiKey: string;
  elevenLabsVoiceId: string;
  elevenLabsModel: string;
  openaiApiKey: string;
  openaiVoice: string;
  openaiModel: string;
  cacheEnabled: boolean;
  cacheDir: string;
  /** ms */
  cacheMaxAge: number;
  /** bytes */
  cacheMaxSize: number;
}

export interface GenerateOptions {
  voice?: string;
  provider?: string;
}

export interface GenerateResult {
  success: boolean;
  provider: string;
  /** URL the dashboard serves the audio from */
  audioUrl?: string;
  cached?: boolean;
  useBrowserTTS?: boolean;
  error?: string;
}

export interface TTSPublicConfig {
  provider: string;
  cacheEnabled: boolean;
  cacheSize: number;
  cacheCount: number;
  providers: {
    elevenlabs: { available: boolean; voice: string; model: string };
    openai: { available: boolean; voice: string; model: string };
    browser: { available: true };
  };
}

export interface TTSService {
  initialize(): Promise<void>;
  generateTTS(text: string, options?: GenerateOptions): Promise<GenerateResult>;
  getConfig(): TTSPublicConfig;
  /**
   * Re-read the provider, keys, voices, models and cache limits from `env`
   * (the dashboard Settings page saves them live). The cache directory and
   * whether caching is enabled are fixed at initialize().
   */
  reconfigure(env?: NodeJS.ProcessEnv): void;
}

interface CacheEntry {
  file: string;
  timestamp: number;
  size: number;
}

interface HttpError {
  message: string;
  response?: { data?: unknown };
}

/** The axios subset the service uses */
export interface TTSHttpClient {
  post(url: string, body: unknown, config: Record<string, unknown>): Promise<{ data: ArrayBuffer | Buffer }>;
}

/**
 * Read the service configuration from environment variables.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env, cacheDir: string = projectPath('dashboard', 'cache', 'tts')): TTSConfig {
  return {
    provider: env.TTS_PROVIDER || TTS_PROVIDERS.BROWSER,

    // ElevenLabs
    elevenLabsApiKey: env.ELEVENLABS_API_KEY || '',
    elevenLabsVoiceId: env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL', // Default: Sarah
    elevenLabsModel: env.ELEVENLABS_MODEL || 'eleven_monolingual_v1',

    // OpenAI
    openaiApiKey: env.OPENAI_API_KEY || '',
    openaiVoice: env.OPENAI_TTS_VOICE || 'alloy', // alloy, echo, fable, onyx, nova, shimmer
    openaiModel: env.OPENAI_TTS_MODEL || 'tts-1', // tts-1 or tts-1-hd

    // Cache settings
    cacheEnabled: env.TTS_CACHE_ENABLED !== 'false',
    cacheDir,
    cacheMaxAge: parseInt(env.TTS_CACHE_MAX_AGE || '86400000', 10), // 24 hours
    cacheMaxSize: parseInt(env.TTS_CACHE_MAX_SIZE || '104857600', 10) // 100MB
  };
}

/**
 * Create a TTS service with its own configuration and cache state.
 */
export function createTTSService(config: TTSConfig = configFromEnv(), http: TTSHttpClient = axios): TTSService {
  let cacheSize = 0;
  const cacheMap = new Map<string, CacheEntry>(); // text hash -> entry

  async function initialize(): Promise<void> {
    if (config.cacheEnabled) {
      try {
        await fs.mkdir(config.cacheDir, { recursive: true });
        console.log('[TTS] Cache directory initialized:', config.cacheDir);

        await loadCacheMetadata();
      } catch (err) {
        console.error('[TTS] Failed to create cache directory:', (err as Error).message);
        config.cacheEnabled = false;
      }
    }

    console.log('[TTS] Active provider:', config.provider);
    if (config.provider === TTS_PROVIDERS.ELEVENLABS && !config.elevenLabsApiKey) {
      console.warn('[TTS] ElevenLabs selected but no API key provided. Falling back to browser TTS.');
      config.provider = TTS_PROVIDERS.BROWSER;
    }
    if (config.provider === TTS_PROVIDERS.OPENAI && !config.openaiApiKey) {
      console.warn('[TTS] OpenAI TTS selected but no API key provided. Falling back to browser TTS.');
      config.provider = TTS_PROVIDERS.BROWSER;
    }
  }

  async function loadCacheMetadata(): Promise<void> {
    try {
      const files = await fs.readdir(config.cacheDir);

      for (const file of files) {
        if (!file.endsWith('.mp3')) continue;

        const filePath = path.join(config.cacheDir, file);
        const stats = await fs.stat(filePath);
        const hash = file.replace('.mp3', '');

        cacheMap.set(hash, {
          file: filePath,
          timestamp: stats.mtime.getTime(),
          size: stats.size
        });

        cacheSize += stats.size;
      }

      console.log(`[TTS] Loaded cache: ${cacheMap.size} files, ${(cacheSize / 1024 / 1024).toFixed(2)} MB`);
    } catch (err) {
      console.error('[TTS] Failed to load cache metadata:', (err as Error).message);
    }
  }

  async function getCachedAudio(text: string, voice: string, provider: string): Promise<string | null> {
    if (!config.cacheEnabled) return null;

    const hash = getCacheKey(text, voice, provider);
    const cached = cacheMap.get(hash);

    if (!cached) return null;

    const age = Date.now() - cached.timestamp;
    if (age > config.cacheMaxAge) {
      await deleteCachedAudio(hash);
      return null;
    }

    // Touch on access for LRU eviction
    cached.timestamp = Date.now();
    cacheMap.set(hash, cached);

    // Verify the file still exists
    try {
      await fs.access(cached.file);
      return cached.file;
    } catch {
      cacheMap.delete(hash);
      cacheSize -= cached.size;
      return null;
    }
  }

  async function saveCachedAudio(text: string, voice: string, provider: string, audioBuffer: Buffer): Promise<string | null> {
    if (!config.cacheEnabled) return null;

    const hash = getCacheKey(text, voice, provider);
    const filePath = path.join(config.cacheDir, `${hash}.mp3`);

    try {
      // An existing entry for this hash is being replaced (concurrent writes)
      const existingEntry = cacheMap.get(hash);
      const oldSize = existingEntry ? existingEntry.size : 0;

      await fs.writeFile(filePath, audioBuffer);
      const stats = await fs.stat(filePath);

      cacheMap.set(hash, {
        file: filePath,
        timestamp: Date.now(),
        size: stats.size
      });

      cacheSize = cacheSize - oldSize + stats.size;

      if (cacheSize > config.cacheMaxSize) {
        await cleanupCache();
      }

      return filePath;
    } catch (err) {
      console.error('[TTS] Failed to save cached audio:', (err as Error).message);
      return null;
    }
  }

  async function deleteCachedAudio(hash: string): Promise<void> {
    const cached = cacheMap.get(hash);
    if (!cached) return;

    try {
      await fs.unlink(cached.file);
      cacheSize -= cached.size;
      cacheMap.delete(hash);
    } catch (err) {
      console.error('[TTS] Failed to delete cached audio:', (err as Error).message);
    }
  }

  /**
   * Evict the oldest 25% of entries, repeatedly, until the cache is under its size limit.
   */
  async function cleanupCache(): Promise<void> {
    console.log('[TTS] Cache size exceeded, cleaning up...');

    let totalDeleted = 0;

    while (cacheSize > config.cacheMaxSize && cacheMap.size > 0) {
      const entries = Array.from(cacheMap.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp);

      if (entries.length === 0) break;

      const deleteCount = Math.max(1, Math.ceil(entries.length * 0.25));

      for (let i = 0; i < deleteCount && i < entries.length; i++) {
        await deleteCachedAudio(entries[i][0]);
        totalDeleted++;
      }
    }

    console.log(`[TTS] Cleaned up ${totalDeleted} files. New cache size: ${(cacheSize / 1024 / 1024).toFixed(2)} MB`);
  }

  async function generateElevenLabsTTS(text: string, voiceId: string | null = null): Promise<Buffer> {
    const voice = voiceId || config.elevenLabsVoiceId;

    try {
      const response = await http.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${voice}`,
        {
          text,
          model_id: config.elevenLabsModel,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75
          }
        },
        {
          headers: {
            'xi-api-key': config.elevenLabsApiKey,
            'Content-Type': 'application/json'
          },
          responseType: 'arraybuffer',
          timeout: 30000
        }
      );

      return Buffer.from(response.data as ArrayBuffer);
    } catch (err) {
      const error = err as HttpError;
      console.error('[TTS] ElevenLabs API error:', error.response?.data || error.message);
      throw new Error('ElevenLabs TTS generation failed');
    }
  }

  async function generateOpenAITTS(text: string, voice: string | null = null): Promise<Buffer> {
    const selectedVoice = voice || config.openaiVoice;

    try {
      const response = await http.post(
        'https://api.openai.com/v1/audio/speech',
        {
          model: config.openaiModel,
          input: text,
          voice: selectedVoice,
          response_format: 'mp3'
        },
        {
          headers: {
            Authorization: `Bearer ${config.openaiApiKey}`,
            'Content-Type': 'application/json'
          },
          responseType: 'arraybuffer',
          timeout: 30000
        }
      );

      return Buffer.from(response.data as ArrayBuffer);
    } catch (err) {
      const error = err as HttpError;
      console.error('[TTS] OpenAI API error:', error.response?.data || error.message);
      throw new Error('OpenAI TTS generation failed');
    }
  }

  /**
   * Generate TTS audio (main entry point). Falls back to browser TTS on any failure.
   */
  async function generateTTS(text: string, options: GenerateOptions = {}): Promise<GenerateResult> {
    const provider = options.provider || config.provider;

    let voice: string;
    if (options.voice) {
      voice = options.voice;
    } else if (provider === TTS_PROVIDERS.ELEVENLABS) {
      voice = config.elevenLabsVoiceId;
    } else if (provider === TTS_PROVIDERS.OPENAI) {
      voice = config.openaiVoice;
    } else {
      voice = 'browser'; // Browser TTS doesn't need a voice ID
    }

    const cachedPath = await getCachedAudio(text, voice, provider);
    if (cachedPath) {
      console.log('[TTS] Using cached audio');
      const filename = path.basename(cachedPath);
      return {
        success: true,
        audioUrl: `/api/tts/audio/${filename}`, // A URL, not the filesystem path
        provider: provider,
        cached: true
      };
    }

    try {
      let audioBuffer: Buffer;

      if (provider === TTS_PROVIDERS.ELEVENLABS) {
        audioBuffer = await generateElevenLabsTTS(text, voice);
      } else if (provider === TTS_PROVIDERS.OPENAI) {
        audioBuffer = await generateOpenAITTS(text, voice);
      } else {
        // Browser TTS: tell the client to speak it itself
        return {
          success: true,
          provider: TTS_PROVIDERS.BROWSER,
          useBrowserTTS: true
        };
      }

      const audioPath = await saveCachedAudio(text, voice, provider, audioBuffer);

      if (!audioPath) {
        throw new Error('Failed to save audio to cache');
      }

      console.log('[TTS] Generated new audio:', provider);

      const filename = path.basename(audioPath);
      return {
        success: true,
        audioUrl: `/api/tts/audio/${filename}`,
        provider,
        cached: false
      };
    } catch (err) {
      console.error('[TTS] Generation failed:', (err as Error).message);

      return {
        success: false,
        provider: TTS_PROVIDERS.BROWSER,
        useBrowserTTS: true,
        error: (err as Error).message
      };
    }
  }

  function getConfig(): TTSPublicConfig {
    return {
      provider: config.provider,
      cacheEnabled: config.cacheEnabled,
      cacheSize: cacheSize,
      cacheCount: cacheMap.size,
      providers: {
        elevenlabs: {
          available: !!config.elevenLabsApiKey,
          voice: config.elevenLabsVoiceId,
          model: config.elevenLabsModel
        },
        openai: {
          available: !!config.openaiApiKey,
          voice: config.openaiVoice,
          model: config.openaiModel
        },
        browser: {
          available: true
        }
      }
    };
  }

  function reconfigure(env: NodeJS.ProcessEnv = process.env): void {
    const { cacheDir: _dir, cacheEnabled: _enabled, ...next } = configFromEnv(env, config.cacheDir);
    Object.assign(config, next);
  }

  return { initialize, generateTTS, getConfig, reconfigure };
}

/**
 * Cache key from text, voice and provider
 */
export function getCacheKey(text: string, voice: string, provider: string): string {
  const data = `${text}:${voice}:${provider}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Default instance, configured from process.env when this module is first loaded
const defaultService = createTTSService();

export const initialize = defaultService.initialize;
export const generateTTS = defaultService.generateTTS;
export const getConfig = defaultService.getConfig;
export const reconfigure = defaultService.reconfigure;
