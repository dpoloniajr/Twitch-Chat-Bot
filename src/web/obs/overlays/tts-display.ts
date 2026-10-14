/**
 * TTS Display Overlay
 * (Script body is wrapped in a function scope so its top-level names do not
 * clash with the other overlay scripts compiled in the same TypeScript program.)
 */
(function() {
  /** Per-alert config sent with a TTS alert (fields read here). */
  interface TTSAlertConfig {
    duration?: number;
    ttsTemplate?: string;
  }

  /** Payload of the `alert` WebSocket message as read by this overlay. */
  interface TTSAlert {
    alertType?: string;
    user?: string;
    message?: string; // may be missing; treated as empty
    timestamp?: string;
    audioUrl?: string;
    useBrowserTTS?: boolean;
    config?: TTSAlertConfig;
  }

  type TTSDisplayWindow = Window & {
    obsstudio?: unknown;
    testTTS?: (user?: string, message?: string) => void;
  };

  // Helper function to validate and clamp numeric values
  function clamp(value: string | null, min: number, max: number, defaultValue: number): number {
    const num = parseFloat(value as string);
    if (isNaN(num)) return defaultValue;
    return Math.max(min, Math.min(max, num));
  }

  function clampInt(value: string | null, min: number, max: number, defaultValue: number): number {
    const num = parseInt(value as string, 10);
    if (isNaN(num)) return defaultValue;
    return Math.max(min, Math.min(max, num));
  }

  // Parse and validate URL parameters
  const urlParams = new URLSearchParams(window.location.search);
  const debugMode = urlParams.get('debug') === 'true';
  const voicePreference = urlParams.get('voice') || 'en-US'; // Language code

  // Validate numeric parameters with safe ranges and fallbacks
  const speechRate = clamp(urlParams.get('rate'), 0.5, 2.0, 1.0);
  const speechPitch = clamp(urlParams.get('pitch'), 0.0, 2.0, 1.0);
  const speechVolume = clamp(urlParams.get('volume'), 0.0, 1.0, 1.0);
  const displayDuration = clampInt(urlParams.get('duration'), 1000, 60000, 5000); // 1s to 60s

  // Show debug panel if enabled
  if (debugMode) {
    document.getElementById('debug-panel')!.classList.add('visible');
    // Log validated parameters
    console.log('TTS Parameters:', {
      voice: voicePreference,
      rate: speechRate,
      pitch: speechPitch,
      volume: speechVolume,
      duration: displayDuration
    });
  }

  function updateDebug(key: string, value: string): void {
    if (debugMode) {
      const element = document.getElementById(`debug-${key}`);
      if (element) {
        element.textContent = value;
      }
    }
  }

  // Initialize WebSocket client
  const client = new OverlayClient();
  const ttsContainer = document.getElementById('tts-container')!;
  const ttsUsername = document.getElementById('tts-username')!;
  const ttsText = document.getElementById('tts-text')!;
  const ttsProgress = document.getElementById('tts-progress')!;

  // Initialize TTS Manager
  const ttsManager = new TTSManager({
    enabled: true,
    voice: voicePreference,
    rate: speechRate,
    pitch: speechPitch,
    volume: speechVolume
  });

  // Update debug panel with voice information after voices load
  (async () => {
    try {
      // Wait for voices to load
      await ttsManager._ensureVoicesLoaded();

      // Update debug panel
      const voiceCount = ttsManager.voices.length;
      const selectedVoice = ttsManager.selectedVoice?.name || 'Default';

      updateDebug('voices-count', `${voiceCount} voice${voiceCount !== 1 ? 's' : ''} (${voicePreference})`);
      updateDebug('voice', selectedVoice);

      console.log(`[TTS] Loaded ${voiceCount} voices, selected: ${selectedVoice}`);
    } catch (err) {
      console.warn('[TTS] Failed to load voice info:', err);
      updateDebug('voices-count', 'Error loading');
    }
  })();

  // Unlock audio on any user interaction (required for browser autoplay policies)
  let audioUnlocked = false;
  const unlockButton = document.getElementById('audio-unlock-button');

  function unlockAudio(): void {
    if (audioUnlocked) return;

    console.log('[TTS] Attempting to unlock audio...');

    try {
      // Unlock Web Speech API - must speak actual audio, not empty string
      if (window.speechSynthesis) {
        // Cancel any pending speech first
        window.speechSynthesis.cancel();

        // Speak a very short phrase with minimal volume to unlock the API
        // Empty string or volume=0 doesn't properly unlock in all browsers
        const utterance = new SpeechSynthesisUtterance('.');
        utterance.volume = 0.01; // Very quiet but not silent
        utterance.rate = 10; // Very fast to minimize duration

        // Track if unlock was successful
        utterance.onstart = () => {
          console.log('[TTS] Audio unlock successful - speech API activated');
          window.speechSynthesis.cancel(); // Cancel immediately after starting
        };

        utterance.onerror = (err: SpeechSynthesisErrorEvent) => {
          console.warn('[TTS] Audio unlock may have failed:', err);
        };

        window.speechSynthesis.speak(utterance);
      }

      // Unlock HTML5 Audio
      const audio = document.getElementById('tts-audio') as HTMLAudioElement | null;
      if (audio) {
        audio.volume = 0.01; // Very quiet but not muted
        const playPromise = audio.play();

        if (playPromise !== undefined) {
          playPromise.then(() => {
            audio.pause();
            audio.currentTime = 0;
            audio.volume = 1.0; // Restore normal volume
            console.log('[TTS] HTML5 Audio unlocked');
          }).catch((err) => {
            console.warn('[TTS] HTML5 Audio unlock failed:', err);
          });
        }
      }

      audioUnlocked = true;
      updateDebug('status', 'Audio unlocked - Ready');
      updateDebug('audio', 'Unlocked ✓');

      // Hide unlock button
      if (unlockButton) {
        unlockButton.classList.add('hidden');
      }
    } catch (err) {
      console.error('[TTS] Failed to unlock audio:', err);
      updateDebug('audio', 'Unlock failed');
    }
  }

  // Show unlock button on first load (auto-hide after 3 seconds if in OBS)
  if (unlockButton) {
    // Check if we're in OBS browser source (window.obsstudio exists)
    const isOBS = typeof (window as TTSDisplayWindow).obsstudio !== 'undefined';

    // Show button briefly to allow user to click
    setTimeout(() => {
      unlockButton.classList.remove('hidden');

      // Auto-hide after 5 seconds in OBS (user can refresh to show again)
      if (isOBS) {
        setTimeout(() => {
          if (!audioUnlocked) {
            unlockButton.classList.add('hidden');
            // Attempt auto-unlock anyway (may work in some OBS versions)
            unlockAudio();
          }
        }, 5000);
      }
    }, 500);

    // Handle button click
    unlockButton.addEventListener('click', () => {
      unlockAudio();
    });
  }

  // Add click/touch listeners to unlock audio anywhere on page
  document.addEventListener('click', unlockAudio);
  document.addEventListener('touchstart', unlockAudio);

  updateDebug('status', 'Ready');

  // Current TTS state
  let currentTTS: TTSAlert | null = null;

  // WebSocket connection events
  client.on('connected', () => {
    console.log('Connected to dashboard WebSocket');
    updateDebug('connection', 'Connected');
    updateDebug('status', 'Listening for TTS events...');
  });

  client.on('disconnected', () => {
    console.log('Disconnected from dashboard WebSocket');
    updateDebug('connection', 'Disconnected');
    updateDebug('status', 'Reconnecting...');
  });

  // Handle alert events (TTS is sent as an alert type)
  client.on('alert', async (alertData: TTSAlert) => {
    // Only process TTS alerts
    if (alertData.alertType !== 'tts') {
      return;
    }

    console.log('TTS alert received:', alertData);
    updateDebug('last-tts', `${alertData.user}: "${(alertData.message || '').substring(0, 30)}..."`);

    // Hide current TTS if showing
    if (currentTTS) {
      hideTTS();
      await new Promise(resolve => setTimeout(resolve, 300)); // Wait for hide animation
    }

    // Display new TTS
    displayTTS(alertData);
  });

  // Display TTS message
  async function displayTTS(data: TTSAlert): Promise<void> {
    currentTTS = data;
    const { user = '', message = '', config } = data;
    const duration = config?.duration || displayDuration;

    // Update content
    ttsUsername.textContent = user;
    ttsText.textContent = message;

    // Show container
    ttsContainer.classList.add('visible', 'slide-up');

    // Reset and animate progress bar
    ttsProgress.style.transition = 'none';
    ttsProgress.style.width = '0%';
    setTimeout(() => {
      ttsProgress.style.transition = `width ${duration}ms linear`;
      ttsProgress.style.width = '100%';
    }, 50);

    // Speak the text (must complete before hiding)
    updateDebug('status', 'Speaking...');
    ttsContainer.classList.add('speaking');

    // Race audio playback against duration timeout
    const playbackPromise = (async () => {
      try {
        // Check if API-generated audio is available
        if (data.audioUrl && !data.useBrowserTTS) {
          // Use API-generated audio
          const audio = document.getElementById('tts-audio') as HTMLAudioElement;
          const dashboardUrl = window.location.origin;  // Use origin instead of hardcoded port
          audio.src = dashboardUrl + data.audioUrl;
          audio.volume = speechVolume;

          await new Promise((resolve, reject) => {
            audio.onended = resolve;
            audio.onerror = reject;
            audio.play().catch(reject);
          });

          updateDebug('voice', 'API TTS');
        } else {
          // Fall back to browser TTS
          const textToSpeak = config?.ttsTemplate || message;
          const parsedText = ttsManager.parseTemplate(textToSpeak, data);
          await ttsManager.speak(parsedText);
          updateDebug('voice', ttsManager.selectedVoice?.name || 'Default (Browser)');
        }
      } catch (err) {
        console.error('TTS speak error:', err);
        updateDebug('status', 'Speech error');

        // If API TTS failed, try browser TTS as fallback
        if (data.audioUrl && !data.useBrowserTTS) {
          try {
            const textToSpeak = config?.ttsTemplate || message;
            const parsedText = ttsManager.parseTemplate(textToSpeak, data);
            await ttsManager.speak(parsedText);
            updateDebug('voice', 'Browser TTS (Fallback)');
          } catch (fallbackErr) {
            console.error('Browser TTS fallback also failed:', fallbackErr);
          }
        }
      }
    })();

    const timeoutPromise = new Promise(resolve => setTimeout(resolve, duration));

    // Wait for BOTH playback to complete AND timeout to elapse
    await Promise.all([playbackPromise, timeoutPromise]);

    ttsContainer.classList.remove('speaking');
    updateDebug('status', 'Displayed');

    // Now hide after both audio and timer are done
    hideTTS();
  }

  // Hide TTS message
  function hideTTS(): void {
    ttsContainer.classList.remove('visible', 'slide-up', 'speaking');
    ttsProgress.style.width = '0%';

    // Stop any playing audio
    const audio = document.getElementById('tts-audio') as HTMLAudioElement;
    audio.pause();
    audio.currentTime = 0;
    audio.src = '';

    currentTTS = null;
    updateDebug('status', 'Hidden');
  }

  // Manual testing (for development)
  if (debugMode) {
    console.log('Debug mode enabled. Use testTTS() to test overlay.');
    (window as TTSDisplayWindow).testTTS = function(user = 'TestUser', message = 'This is a test TTS message.') {
      displayTTS({
        user,
        message,
        timestamp: new Date().toISOString(),
        config: {
          duration: displayDuration,
          ttsTemplate: message
        }
      });
    };
    // Auto-test after 2 seconds
    setTimeout(() => {
      console.log('Running auto-test...');
      (window as TTSDisplayWindow).testTTS!('AutoTest', 'Welcome to the TTS overlay! This is a test message.');
    }, 2000);
  }

  updateDebug('status', 'Initialized');
})();
