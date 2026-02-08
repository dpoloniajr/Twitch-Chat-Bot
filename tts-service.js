/**
 * TTS Service - Premium AI Text-to-Speech Integration
 *
 * Supports multiple TTS providers with automatic fallback:
 * - ElevenLabs (Premium quality, voice cloning)
 * - OpenAI TTS (Good quality, reliable)
 * - Browser Web Speech API (Free fallback)
 */

const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

// TTS Provider Configuration
const TTS_PROVIDERS = {
  ELEVENLABS: 'elevenlabs',
  OPENAI: 'openai',
  BROWSER: 'browser'
};

// Service configuration
const config = {
  provider: process.env.TTS_PROVIDER || TTS_PROVIDERS.BROWSER,

  // ElevenLabs
  elevenLabsApiKey: process.env.ELEVENLABS_API_KEY || '',
  elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL', // Default: Sarah
  elevenLabsModel: process.env.ELEVENLABS_MODEL || 'eleven_monolingual_v1',

  // OpenAI
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiVoice: process.env.OPENAI_TTS_VOICE || 'alloy', // alloy, echo, fable, onyx, nova, shimmer
  openaiModel: process.env.OPENAI_TTS_MODEL || 'tts-1', // tts-1 or tts-1-hd

  // Cache settings
  cacheEnabled: process.env.TTS_CACHE_ENABLED !== 'false',
  cacheDir: path.join(__dirname, 'dashboard', 'cache', 'tts'),
  cacheMaxAge: parseInt(process.env.TTS_CACHE_MAX_AGE || '86400000', 10), // 24 hours
  cacheMaxSize: parseInt(process.env.TTS_CACHE_MAX_SIZE || '104857600', 10), // 100MB
};

// Cache management
let cacheSize = 0;
const cacheMap = new Map(); // text hash -> { file, timestamp, size }

/**
 * Initialize the TTS service
 */
async function initialize() {
  // Create cache directory if it doesn't exist
  if (config.cacheEnabled) {
    try {
      await fs.mkdir(config.cacheDir, { recursive: true });
      console.log('[TTS] Cache directory initialized:', config.cacheDir);

      // Load existing cache metadata
      await loadCacheMetadata();
    } catch (err) {
      console.error('[TTS] Failed to create cache directory:', err.message);
      config.cacheEnabled = false;
    }
  }

  // Log active provider
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

/**
 * Load cache metadata from disk
 */
async function loadCacheMetadata() {
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
    console.error('[TTS] Failed to load cache metadata:', err.message);
  }
}

/**
 * Generate a cache key from text and voice settings
 */
function getCacheKey(text, voice) {
  const data = `${text}:${voice}:${config.provider}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Check if text is cached
 */
async function getCachedAudio(text, voice) {
  if (!config.cacheEnabled) return null;

  const hash = getCacheKey(text, voice);
  const cached = cacheMap.get(hash);

  if (!cached) return null;

  // Check if cache is expired
  const age = Date.now() - cached.timestamp;
  if (age > config.cacheMaxAge) {
    await deleteCachedAudio(hash);
    return null;
  }

  // Verify file still exists
  try {
    await fs.access(cached.file);
    return cached.file;
  } catch (err) {
    cacheMap.delete(hash);
    cacheSize -= cached.size;
    return null;
  }
}

/**
 * Save audio to cache
 */
async function saveCachedAudio(text, voice, audioBuffer) {
  if (!config.cacheEnabled) return null;

  const hash = getCacheKey(text, voice);
  const filePath = path.join(config.cacheDir, `${hash}.mp3`);

  try {
    await fs.writeFile(filePath, audioBuffer);
    const stats = await fs.stat(filePath);

    cacheMap.set(hash, {
      file: filePath,
      timestamp: Date.now(),
      size: stats.size
    });

    cacheSize += stats.size;

    // Cleanup if cache is too large
    if (cacheSize > config.cacheMaxSize) {
      await cleanupCache();
    }

    return filePath;
  } catch (err) {
    console.error('[TTS] Failed to save cached audio:', err.message);
    return null;
  }
}

/**
 * Delete cached audio file
 */
async function deleteCachedAudio(hash) {
  const cached = cacheMap.get(hash);
  if (!cached) return;

  try {
    await fs.unlink(cached.file);
    cacheSize -= cached.size;
    cacheMap.delete(hash);
  } catch (err) {
    console.error('[TTS] Failed to delete cached audio:', err.message);
  }
}

/**
 * Cleanup old cache files (LRU)
 */
async function cleanupCache() {
  console.log('[TTS] Cache size exceeded, cleaning up...');

  // Sort by timestamp (oldest first)
  const entries = Array.from(cacheMap.entries())
    .sort((a, b) => a[1].timestamp - b[1].timestamp);

  // Delete oldest 25% of files
  const deleteCount = Math.ceil(entries.length * 0.25);

  for (let i = 0; i < deleteCount; i++) {
    await deleteCachedAudio(entries[i][0]);
  }

  console.log(`[TTS] Cleaned up ${deleteCount} files. New cache size: ${(cacheSize / 1024 / 1024).toFixed(2)} MB`);
}

/**
 * Generate TTS audio using ElevenLabs API
 */
async function generateElevenLabsTTS(text, voiceId = null) {
  const voice = voiceId || config.elevenLabsVoiceId;

  try {
    const response = await axios.post(
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

    return Buffer.from(response.data);
  } catch (err) {
    console.error('[TTS] ElevenLabs API error:', err.response?.data || err.message);
    throw new Error('ElevenLabs TTS generation failed');
  }
}

/**
 * Generate TTS audio using OpenAI TTS API
 */
async function generateOpenAITTS(text, voice = null) {
  const selectedVoice = voice || config.openaiVoice;

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/audio/speech',
      {
        model: config.openaiModel,
        input: text,
        voice: selectedVoice,
        response_format: 'mp3'
      },
      {
        headers: {
          'Authorization': `Bearer ${config.openaiApiKey}`,
          'Content-Type': 'application/json'
        },
        responseType: 'arraybuffer',
        timeout: 30000
      }
    );

    return Buffer.from(response.data);
  } catch (err) {
    console.error('[TTS] OpenAI API error:', err.response?.data || err.message);
    throw new Error('OpenAI TTS generation failed');
  }
}

/**
 * Generate TTS audio (main entry point)
 *
 * @param {string} text - Text to convert to speech
 * @param {object} options - TTS options
 * @param {string} options.voice - Voice ID/name
 * @param {string} options.provider - Override provider
 * @returns {Promise<{success: boolean, audioPath?: string, provider: string, error?: string}>}
 */
async function generateTTS(text, options = {}) {
  const voice = options.voice || config.elevenLabsVoiceId || config.openaiVoice;
  const provider = options.provider || config.provider;

  // Check cache first
  const cachedPath = await getCachedAudio(text, voice);
  if (cachedPath) {
    console.log('[TTS] Using cached audio');
    return {
      success: true,
      audioPath: cachedPath,
      provider: provider,
      cached: true
    };
  }

  // Generate new audio based on provider
  try {
    let audioBuffer;

    if (provider === TTS_PROVIDERS.ELEVENLABS) {
      audioBuffer = await generateElevenLabsTTS(text, voice);
    } else if (provider === TTS_PROVIDERS.OPENAI) {
      audioBuffer = await generateOpenAITTS(text, voice);
    } else {
      // Browser TTS - return signal to use client-side
      return {
        success: true,
        provider: TTS_PROVIDERS.BROWSER,
        useBrowserTTS: true
      };
    }

    // Save to cache
    const audioPath = await saveCachedAudio(text, voice, audioBuffer);

    if (!audioPath) {
      throw new Error('Failed to save audio to cache');
    }

    console.log('[TTS] Generated new audio:', provider);

    return {
      success: true,
      audioPath,
      provider,
      cached: false
    };
  } catch (err) {
    console.error('[TTS] Generation failed:', err.message);

    // Fallback to browser TTS
    return {
      success: false,
      provider: TTS_PROVIDERS.BROWSER,
      useBrowserTTS: true,
      error: err.message
    };
  }
}

/**
 * Get TTS configuration
 */
function getConfig() {
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

module.exports = {
  initialize,
  generateTTS,
  getConfig,
  TTS_PROVIDERS
};
