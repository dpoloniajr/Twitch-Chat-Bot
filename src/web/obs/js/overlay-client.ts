/**
 * OBS Overlay WebSocket Client
 * Shared module for connecting to the dashboard WebSocket server
 * and managing alert queues for OBS browser source overlays
 *
 * Plain global script (no module system): the four exports below are
 * declared at top level so the overlay page scripts can see their types,
 * and are also assigned onto `window` as before.
 */

/**
 * Listener for an OverlayClient event. Payloads come straight from the
 * dashboard WebSocket (`data.data` for typed messages), so they are untyped
 * here; each overlay annotates the shape it actually reads.
 */
type OverlayListener = (data: any) => void;

interface OverlayClientOptions {
  wsUrl?: string;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
}

/** Envelope of every dashboard WebSocket message. */
interface OverlayWsMessage {
  type?: string;
  data?: unknown;
}

/**
 * OverlayClient - WebSocket connection manager
 */
class OverlayClient {
  wsUrl: string;
  reconnectInterval: number;
  maxReconnectAttempts: number;
  ws: WebSocket | null;
  reconnectAttempts: number;
  listeners: Map<string, OverlayListener[]>;
  isConnected: boolean;

  constructor(options: OverlayClientOptions = {}) {
    // Build wsUrl: use https->wss, http->ws
    const defaultWsProtocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const defaultWsUrl = typeof window !== 'undefined' ? `${defaultWsProtocol}//${window.location.host}` : 'ws://localhost:3001';

    this.wsUrl = options.wsUrl || defaultWsUrl;
    this.reconnectInterval = options.reconnectInterval || 3000;
    this.maxReconnectAttempts = options.maxReconnectAttempts || Infinity;

    this.ws = null;
    this.reconnectAttempts = 0;
    this.listeners = new Map();
    this.isConnected = false;

    this._connect();
  }

  /**
   * Connect to WebSocket server
   */
  _connect(): void {
    try {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.onopen = () => {
        console.log('[OverlayClient] Connected to server');
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this._emit('connected');
      };

      this.ws.onmessage = (event: MessageEvent) => {
        try {
          const data: OverlayWsMessage = JSON.parse(event.data);
          this._emit('message', data);

          // Emit specific event type if present
          if (data.type) {
            this._emit(data.type, data.data);
          }
        } catch (err) {
          console.error('[OverlayClient] Failed to parse message:', err);
        }
      };

      this.ws.onclose = () => {
        console.log('[OverlayClient] Disconnected from server');
        this.isConnected = false;
        this._emit('disconnected');
        this._scheduleReconnect();
      };

      this.ws.onerror = (error: Event) => {
        console.error('[OverlayClient] WebSocket error:', error);
        this._emit('error', error);
      };
    } catch (err) {
      console.error('[OverlayClient] Failed to create WebSocket:', err);
      this._scheduleReconnect();
    }
  }

  /**
   * Schedule reconnection attempt
   */
  _scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('[OverlayClient] Max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    console.log(`[OverlayClient] Reconnecting in ${this.reconnectInterval}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      this._connect();
    }, this.reconnectInterval);
  }

  /**
   * Register event listener
   * @param {string} event - Event name
   * @param {Function} callback - Callback function
   */
  on(event: string, callback: OverlayListener): this {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(callback);
    return this;
  }

  /**
   * Remove event listener
   * @param {string} event - Event name
   * @param {Function} callback - Callback function to remove
   */
  off(event: string, callback: OverlayListener): this {
    if (!this.listeners.has(event)) return this;

    const callbacks = this.listeners.get(event)!;
    const index = callbacks.indexOf(callback);
    if (index > -1) {
      callbacks.splice(index, 1);
    }
    return this;
  }

  /**
   * Emit event to listeners
   * @param {string} event - Event name
   * @param {*} data - Event data
   */
  _emit(event: string, data?: unknown): void {
    if (!this.listeners.has(event)) return;

    this.listeners.get(event)!.forEach(callback => {
      try {
        callback(data);
      } catch (err) {
        console.error(`[OverlayClient] Error in ${event} listener:`, err);
      }
    });
  }

  /**
   * Close connection
   */
  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

/** Per-alert display settings read by AlertQueue (overlays may add more). */
interface AlertQueueItemConfig {
  duration?: number;
  volume?: number;
}

/** Minimum shape of an item queued in AlertQueue. */
interface AlertQueueItem {
  alertType?: string;
  config?: AlertQueueItemConfig;
}

interface AlertQueueOptions<T extends AlertQueueItem> {
  alertDuration?: number;
  alertDelay?: number;
  soundEnabled?: boolean;
  soundVolume?: number;
  onShow?: (alert: T) => void;
  onHide?: (alert: T) => void;
}

interface AlertQueueConfigUpdate {
  alertDuration?: number;
  alertDelay?: number;
  soundEnabled?: boolean;
  soundVolume?: number;
}

/**
 * AlertQueue - Manages sequential display of alerts
 */
class AlertQueue<T extends AlertQueueItem = AlertQueueItem> {
  alertDuration: number;
  alertDelay: number;
  soundEnabled: boolean;
  soundVolume: number;
  queue: T[];
  isProcessing: boolean;
  currentAlert: T | null;
  onShow: (alert: T) => void;
  onHide: (alert: T) => void;
  sounds: Record<string, HTMLAudioElement>;

  constructor(options: AlertQueueOptions<T> = {}) {
    this.alertDuration = options.alertDuration || 5000;
    this.alertDelay = options.alertDelay || 1000;
    this.soundEnabled = options.soundEnabled !== false;
    this.soundVolume = options.soundVolume || 0.5;

    this.queue = [];
    this.isProcessing = false;
    this.currentAlert = null;

    this.onShow = options.onShow || (() => {});
    this.onHide = options.onHide || (() => {});

    // Sound cache
    this.sounds = {};
  }

  /**
   * Load a sound file
   * @param {string} type - Alert type
   * @param {string} url - Sound file URL
   */
  loadSound(type: string, url: string): void {
    const audio = new Audio(url);
    audio.volume = this.soundVolume;
    audio.preload = 'auto';
    this.sounds[type] = audio;
  }

  /**
   * Play sound for alert type
   * @param {string} type - Alert type
   */
  playSound(type: string): void {
    if (!this.soundEnabled) return;

    const sound = this.sounds[type] || this.sounds['default'];
    if (sound) {
      // Clone audio to allow overlapping plays
      const clone = sound.cloneNode() as HTMLAudioElement;
      // Use volume from current alert's config, fall back to instance property
      clone.volume = this.currentAlert?.config?.volume ?? this.soundVolume;
      clone.play().catch(err => {
        console.warn('[AlertQueue] Sound play failed:', err);
      });
    }
  }

  /**
   * Add alert to queue
   * @param {Object} alert - Alert data
   */
  add(alert: T): void {
    this.queue.push(alert);
    console.log('[AlertQueue] Alert added:', alert.alertType, '- Queue size:', this.queue.length);

    if (!this.isProcessing) {
      this._processNext();
    }
  }

  /**
   * Alias for add() - for backwards compatibility
   */
  queueAlert(alert: T): void {
    this.add(alert);
  }

  /**
   * Process next alert in queue
   */
  async _processNext(): Promise<void> {
    if (this.queue.length === 0) {
      this.isProcessing = false;
      this.currentAlert = null;
      return;
    }

    this.isProcessing = true;
    this.currentAlert = this.queue.shift()!;

    console.log('[AlertQueue] Showing alert:', this.currentAlert.alertType);

    // Show alert (handler is responsible for sound playback based on config)
    this.onShow(this.currentAlert);

    // Get duration from alert's config, fall back to instance property
    const duration = this.currentAlert.config?.duration ?? this.alertDuration;

    // Wait for display duration
    await this._wait(duration);

    // Hide alert
    this.onHide(this.currentAlert);

    // Wait for delay between alerts
    await this._wait(this.alertDelay);

    // Process next (return for explicit async flow)
    return this._processNext();
  }

  /**
   * Promise-based wait
   * @param {number} ms - Milliseconds to wait
   */
  _wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Clear all queued alerts
   */
  clear(): void {
    this.queue = [];
    console.log('[AlertQueue] Queue cleared');
  }

  /**
   * Update configuration
   * @param {Object} config - New configuration
   */
  updateConfig(config: AlertQueueConfigUpdate): void {
    if (config.alertDuration !== undefined) {
      this.alertDuration = config.alertDuration;
    }
    if (config.alertDelay !== undefined) {
      this.alertDelay = config.alertDelay;
    }
    if (config.soundEnabled !== undefined) {
      this.soundEnabled = config.soundEnabled;
    }
    if (config.soundVolume !== undefined) {
      this.soundVolume = config.soundVolume;
      // Update existing sound volumes
      Object.values(this.sounds).forEach(sound => {
        sound.volume = this.soundVolume;
      });
    }
  }
}

interface TTSManagerOptions {
  enabled?: boolean;
  voice?: string;
  rate?: number;
  pitch?: number;
  volume?: number;
}

/** Fields of updateConfig(); undefined leaves a setting unchanged. */
interface TTSConfigUpdate {
  enabled?: boolean;
  voice?: string;
  rate?: number;
  pitch?: number;
  volume?: number;
}

interface TTSSpeakOptions {
  rate?: number;
  pitch?: number;
  volume?: number;
}

/**
 * TTS Manager - Handles Text-to-Speech for alerts
 */
class TTSManager {
  enabled: boolean;
  voice: string;
  rate: number;
  pitch: number;
  volume: number;
  supported: boolean;
  synth: SpeechSynthesis | null;
  voices: SpeechSynthesisVoice[];
  selectedVoice: SpeechSynthesisVoice | null | undefined;
  currentUtterance: SpeechSynthesisUtterance | null;
  _speakTimeoutId: ReturnType<typeof setTimeout> | null;
  _speakRequestId: number;
  _pendingSpeakResolver: (() => void) | null;

  constructor(options: TTSManagerOptions = {}) {
    this.enabled = options.enabled !== false;
    this.voice = options.voice || 'en-US';
    this.rate = options.rate || 1.0;
    this.pitch = options.pitch || 1.0;
    this.volume = options.volume || 0.8;

    // Check for speechSynthesis support
    this.supported = !!window.speechSynthesis;
    this.synth = window.speechSynthesis || null;
    this.voices = [];
    this.selectedVoice = null;
    this.currentUtterance = null; // Prevent garbage collection
    this._speakTimeoutId = null;
    this._speakRequestId = 0;
    this._pendingSpeakResolver = null;

    // Load voices only if supported
    if (this.supported) {
      this._loadVoices();
      if (this.synth!.onvoiceschanged !== undefined) {
        this.synth!.onvoiceschanged = () => this._loadVoices();
      }
    }
  }

  /**
   * Load available voices
   */
  _loadVoices(): void {
    this.voices = this.synth!.getVoices();
    this._selectVoice();
  }

  /**
   * Select voice based on language/region
   */
  _selectVoice(): void {
    if (this.voices.length === 0) return;

    // Try to find exact match
    this.selectedVoice = this.voices.find(v => v.lang === this.voice);

    // Fallback to language family
    if (!this.selectedVoice) {
      const langPrefix = this.voice.split('-')[0];
      this.selectedVoice = this.voices.find(v => v.lang.startsWith(langPrefix));
    }

    // Fallback to default
    if (!this.selectedVoice) {
      this.selectedVoice = this.voices.find(v => v.default) || this.voices[0];
    }
  }

  /**
   * Update TTS configuration
   */
  updateConfig(config: TTSConfigUpdate): void {
    if (config.enabled !== undefined) this.enabled = config.enabled;
    if (config.voice !== undefined) {
      this.voice = config.voice;
      this._selectVoice();
    }
    if (config.rate !== undefined) this.rate = config.rate;
    if (config.pitch !== undefined) this.pitch = config.pitch;
    if (config.volume !== undefined) this.volume = config.volume;
  }

  /**
   * Wait for voices to be loaded
   * @returns {Promise} Resolves when voices are available
   */
  _ensureVoicesLoaded(): Promise<void> {
    return new Promise((resolve) => {
      if (this.voices.length > 0) {
        resolve();
        return;
      }

      // Try loading voices immediately
      this._loadVoices();
      if (this.voices.length > 0) {
        resolve();
        return;
      }

      // Wait for voiceschanged event with timeout
      const timeout = setTimeout(() => {
        this._loadVoices(); // Try one more time
        resolve();
      }, 1000);

      if (this.synth!.onvoiceschanged !== undefined) {
        const handler = () => {
          clearTimeout(timeout);
          this._loadVoices();
          this.synth!.onvoiceschanged = () => this._loadVoices(); // Restore original handler
          resolve();
        };
        this.synth!.onvoiceschanged = handler;
      } else {
        // No voiceschanged event support, rely on timeout
      }
    });
  }

  /**
   * Speak text
   * @param {string} text - Text to speak
   * @param {Object} options - Override options
   * @returns {Promise} Resolves when speech completes
   */
  async speak(text: string, options: TTSSpeakOptions = {}): Promise<void> {
    return new Promise(async (resolve) => {
      // Resolve any previous pending speak promise
      if (this._pendingSpeakResolver) {
        this._pendingSpeakResolver();
      }
      this._pendingSpeakResolver = resolve;

      if (!this.enabled || !this.supported) {
        this._pendingSpeakResolver = null;
        resolve();
        return;
      }

      if (!text || text.trim() === '') {
        this._pendingSpeakResolver = null;
        resolve();
        return;
      }

      // Ensure voices are loaded before proceeding
      await this._ensureVoicesLoaded();

      // Cancel any ongoing speech
      this.synth!.cancel();

      // Track and cancel any pending speak timeout to avoid races
      if (this._speakTimeoutId) {
        clearTimeout(this._speakTimeoutId);
        this._speakTimeoutId = null;
      }

      // Monotonic request id to ignore stale scheduled callbacks
      this._speakRequestId++;
      const requestId = this._speakRequestId;

      // Some browsers need a resume call to ensure the engine isn't paused
      // or stuck from a previous cancel
      if (this.synth!.paused) {
        this.synth!.resume();
      }

      // Use a small timeout to ensure the cancel has taken effect
      // and the engine is ready for a new utterance
      this._speakTimeoutId = setTimeout(() => {
        // Clear stored timeout id now that it has fired
        this._speakTimeoutId = null;

        // If a newer speak request has been made, ignore this one
        if (requestId !== this._speakRequestId) {
          this._pendingSpeakResolver = null;
          resolve();
          return;
        }

        try {
          const utterance = new SpeechSynthesisUtterance(text);
          this.currentUtterance = utterance; // Keep reference to prevent GC

          utterance.voice = this.selectedVoice as SpeechSynthesisVoice | null;
          utterance.rate = options.rate !== undefined ? options.rate : this.rate;
          utterance.pitch = options.pitch !== undefined ? options.pitch : this.pitch;
          utterance.volume = options.volume !== undefined ? options.volume : this.volume;

          console.log('[TTS] Speaking with voice:', this.selectedVoice?.name || 'default');
          console.log('[TTS] SpeechSynthesis state - speaking:', this.synth!.speaking, 'pending:', this.synth!.pending, 'paused:', this.synth!.paused);

          // Set a timeout to detect if speech never starts
          const speechTimeout = setTimeout(() => {
            if (this.synth!.speaking === false && this.synth!.pending === false) {
              console.error('[TTS] ❌ Speech failed to start within 2 seconds - likely blocked by browser');
              console.error('[TTS] OBS Browser Source may have Web Speech API disabled');
              console.error('[TTS] 💡 Recommendation: Switch to API-based TTS (set TTS_PROVIDER=elevenlabs or openai)');
              this.currentUtterance = null;
              this._pendingSpeakResolver = null;
              resolve();
            }
          }, 2000);

          utterance.onstart = () => {
            clearTimeout(speechTimeout);
            console.log('[TTS] ✓ Speech started');
          };

          utterance.onend = () => {
            clearTimeout(speechTimeout);
            console.log('[TTS] ✓ Speech ended');
            this.currentUtterance = null;
            this._pendingSpeakResolver = null;
            resolve();
          };

          utterance.onerror = (err: SpeechSynthesisErrorEvent) => {
            clearTimeout(speechTimeout);
            console.warn('[TTS] ❌ Speech error:', err);
            console.warn('[TTS] Error details - error:', err.error, 'charIndex:', err.charIndex);
            this.currentUtterance = null;
            this._pendingSpeakResolver = null;
            resolve(); // Resolve anyway to not block alerts
          };

          this.synth!.speak(utterance);
        } catch (err) {
          console.error('[TTS] Failed to speak:', err);
          this._pendingSpeakResolver = null;
          resolve();
        }
      }, 50);
    });
  }

  /**
   * Parse template and replace placeholders
   * @param {string} template - Template with {placeholders}
   * @param {Object} data - Data object with values
   * @returns {string} Parsed text
   */
  parseTemplate(template: string | null | undefined, data: object): string {
    if (!template) return '';

    return template.replace(/\{(\w+)\}/g, (match, key: string) => {
      // Non-string values are coerced by String.prototype.replace, as before
      const values = data as Record<string, unknown>;
      return (values[key] !== undefined ? values[key] : match) as string;
    });
  }

  /**
   * Stop any ongoing speech
   */
  stop(): void {
    if (this._speakTimeoutId) {
      clearTimeout(this._speakTimeoutId);
      this._speakTimeoutId = null;
    }
    this._speakRequestId++; // Increment to invalidate any pending speak callbacks
    this.synth!.cancel();
    this.currentUtterance = null;

    // Resolve any pending speak promise so callers don't hang
    if (this._pendingSpeakResolver) {
      this._pendingSpeakResolver();
      this._pendingSpeakResolver = null;
    }
  }
}

/**
 * Utility functions
 */
const OverlayUtils = {
  /**
   * Format time ago string
   * @param {Date|string} date - Date to format
   * @returns {string} Formatted string like "2m ago"
   */
  timeAgo(date: Date | string | number): string {
    const now = new Date();
    const past = new Date(date);
    const diffMs = now.getTime() - past.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    if (diffDay > 0) return `${diffDay}d ago`;
    if (diffHour > 0) return `${diffHour}h ago`;
    if (diffMin > 0) return `${diffMin}m ago`;
    return 'just now';
  },

  /**
   * Escape HTML to prevent XSS
   * @param {string} str - String to escape
   * @returns {string} Escaped string
   */
  escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },

  /**
   * Format number with commas
   * @param {number} num - Number to format
   * @returns {string} Formatted number
   */
  formatNumber(num: number | string): string {
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  },

  /**
   * Get URL query parameter
   * @param {string} name - Parameter name
   * @returns {string|null} Parameter value or null
   */
  getQueryParam(name: string): string | null {
    const params = new URLSearchParams(window.location.search);
    return params.get(name);
  },

  /**
   * Parse subscription tier to friendly name
   * @param {string} tier - Tier value (1000, 2000, 3000)
   * @returns {string} Friendly tier name
   */
  parseTier(tier: string | undefined): string | undefined {
    const tierMap: Record<string, string> = {
      '1000': 'Tier 1',
      '2000': 'Tier 2',
      '3000': 'Tier 3',
      'Prime': 'Prime'
    };
    return tierMap[tier as string] || tier;
  }
};

interface Window {
  OverlayClient: typeof OverlayClient;
  AlertQueue: typeof AlertQueue;
  TTSManager: typeof TTSManager;
  OverlayUtils: typeof OverlayUtils;
}

// Export to global scope
window.OverlayClient = OverlayClient;
window.AlertQueue = AlertQueue;
window.TTSManager = TTSManager;
window.OverlayUtils = OverlayUtils;
