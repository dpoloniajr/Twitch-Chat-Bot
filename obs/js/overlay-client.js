/**
 * OBS Overlay WebSocket Client
 * Shared module for connecting to the dashboard WebSocket server
 * and managing alert queues for OBS browser source overlays
 */

(function(global) {
  'use strict';

  /**
   * OverlayClient - WebSocket connection manager
   */
  class OverlayClient {
    constructor(options = {}) {
      this.wsUrl = options.wsUrl || `ws://${window.location.host}`;
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
    _connect() {
      try {
        this.ws = new WebSocket(this.wsUrl);

        this.ws.onopen = () => {
          console.log('[OverlayClient] Connected to server');
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this._emit('connected');
        };

        this.ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
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

        this.ws.onerror = (error) => {
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
    _scheduleReconnect() {
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
    on(event, callback) {
      if (!this.listeners.has(event)) {
        this.listeners.set(event, []);
      }
      this.listeners.get(event).push(callback);
      return this;
    }

    /**
     * Remove event listener
     * @param {string} event - Event name
     * @param {Function} callback - Callback function to remove
     */
    off(event, callback) {
      if (!this.listeners.has(event)) return this;

      const callbacks = this.listeners.get(event);
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
    _emit(event, data) {
      if (!this.listeners.has(event)) return;

      this.listeners.get(event).forEach(callback => {
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
    close() {
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }
    }
  }

  /**
   * AlertQueue - Manages sequential display of alerts
   */
  class AlertQueue {
    constructor(options = {}) {
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
    loadSound(type, url) {
      const audio = new Audio(url);
      audio.volume = this.soundVolume;
      audio.preload = 'auto';
      this.sounds[type] = audio;
    }

    /**
     * Play sound for alert type
     * @param {string} type - Alert type
     */
    playSound(type) {
      if (!this.soundEnabled) return;

      const sound = this.sounds[type] || this.sounds['default'];
      if (sound) {
        // Clone audio to allow overlapping plays
        const clone = sound.cloneNode();
        clone.volume = this.soundVolume;
        clone.play().catch(err => {
          console.warn('[AlertQueue] Sound play failed:', err);
        });
      }
    }

    /**
     * Add alert to queue
     * @param {Object} alert - Alert data
     */
    add(alert) {
      this.queue.push(alert);
      console.log('[AlertQueue] Alert added:', alert.alertType, '- Queue size:', this.queue.length);

      if (!this.isProcessing) {
        this._processNext();
      }
    }

    /**
     * Alias for add() - for backwards compatibility
     */
    queueAlert(alert) {
      this.add(alert);
    }

    /**
     * Process next alert in queue
     */
    async _processNext() {
      if (this.queue.length === 0) {
        this.isProcessing = false;
        this.currentAlert = null;
        return;
      }

      this.isProcessing = true;
      this.currentAlert = this.queue.shift();

      console.log('[AlertQueue] Showing alert:', this.currentAlert.alertType);

      // Play sound
      this.playSound(this.currentAlert.alertType);

      // Show alert
      this.onShow(this.currentAlert);

      // Wait for display duration
      await this._wait(this.alertDuration);

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
    _wait(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Clear all queued alerts
     */
    clear() {
      this.queue = [];
      console.log('[AlertQueue] Queue cleared');
    }

    /**
     * Update configuration
     * @param {Object} config - New configuration
     */
    updateConfig(config) {
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

  /**
   * TTS Manager - Handles Text-to-Speech for alerts
   */
  class TTSManager {
    constructor(options = {}) {
      this.enabled = options.enabled !== false;
      this.voice = options.voice || 'en-US';
      this.rate = options.rate || 1.0;
      this.pitch = options.pitch || 1.0;
      this.volume = options.volume || 0.8;

      this.synth = window.speechSynthesis;
      this.voices = [];
      this.selectedVoice = null;

      // Load voices
      this._loadVoices();
      if (this.synth.onvoiceschanged !== undefined) {
        this.synth.onvoiceschanged = () => this._loadVoices();
      }
    }

    /**
     * Load available voices
     */
    _loadVoices() {
      this.voices = this.synth.getVoices();
      this._selectVoice();
    }

    /**
     * Select voice based on language/region
     */
    _selectVoice() {
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
    updateConfig(config) {
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
     * Speak text
     * @param {string} text - Text to speak
     * @param {Object} options - Override options
     * @returns {Promise} Resolves when speech completes
     */
    speak(text, options = {}) {
      return new Promise((resolve, reject) => {
        if (!this.enabled) {
          resolve();
          return;
        }

        if (!text || text.trim() === '') {
          resolve();
          return;
        }

        // Cancel any ongoing speech
        this.synth.cancel();

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.voice = this.selectedVoice;
        utterance.rate = options.rate || this.rate;
        utterance.pitch = options.pitch || this.pitch;
        utterance.volume = options.volume || this.volume;

        utterance.onend = () => resolve();
        utterance.onerror = (err) => {
          console.warn('[TTS] Error:', err);
          resolve(); // Resolve anyway to not block alerts
        };

        this.synth.speak(utterance);
      });
    }

    /**
     * Parse template and replace placeholders
     * @param {string} template - Template with {placeholders}
     * @param {Object} data - Data object with values
     * @returns {string} Parsed text
     */
    parseTemplate(template, data) {
      if (!template) return '';

      return template.replace(/\{(\w+)\}/g, (match, key) => {
        return data[key] !== undefined ? data[key] : match;
      });
    }

    /**
     * Stop any ongoing speech
     */
    stop() {
      this.synth.cancel();
    }
  }

  /**
   * Utility functions
   */
  const Utils = {
    /**
     * Format time ago string
     * @param {Date|string} date - Date to format
     * @returns {string} Formatted string like "2m ago"
     */
    timeAgo(date) {
      const now = new Date();
      const past = new Date(date);
      const diffMs = now - past;
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
    escapeHtml(str) {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    },

    /**
     * Format number with commas
     * @param {number} num - Number to format
     * @returns {string} Formatted number
     */
    formatNumber(num) {
      return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    },

    /**
     * Get URL query parameter
     * @param {string} name - Parameter name
     * @returns {string|null} Parameter value or null
     */
    getQueryParam(name) {
      const params = new URLSearchParams(window.location.search);
      return params.get(name);
    },

    /**
     * Parse subscription tier to friendly name
     * @param {string} tier - Tier value (1000, 2000, 3000)
     * @returns {string} Friendly tier name
     */
    parseTier(tier) {
      const tierMap = {
        '1000': 'Tier 1',
        '2000': 'Tier 2',
        '3000': 'Tier 3',
        'Prime': 'Prime'
      };
      return tierMap[tier] || tier;
    }
  };

  // Export to global scope
  global.OverlayClient = OverlayClient;
  global.AlertQueue = AlertQueue;
  global.TTSManager = TTSManager;
  global.OverlayUtils = Utils;

})(typeof window !== 'undefined' ? window : this);
