/**
 * Enhanced Alerts Overlay
 * Displays animated alerts with custom media, TTS, and full configuration support
 *
 * Usage: Add as Browser Source in OBS
 * URL: http://localhost:3001/obs/overlays/alerts.html
 * Recommended size: 800x400 or custom based on your scene
 *
 * URL Parameters:
 *   ?debug=true       - Show debug panel
 *   ?duration=5000    - Override alert duration (ms), over the server config
 *   ?volume=0.5       - Override sound volume (0-1), over the server config
 */
(function() {
  'use strict';

  /** `global` section of GET /api/alerts/config (and the alertConfig WS message). */
  interface AlertsGlobalConfig {
    enabled?: boolean;
    ttsEnabled?: boolean;
    ttsVoice?: string;
    ttsRate?: number;
    ttsPitch?: number;
    defaultVolume?: number;
    defaultDuration?: number; // seconds
    defaultDelay?: number; // seconds
  }

  /** Per-type section of `alertTypes` in the alerts config. */
  interface AlertTypeConfig {
    enabled?: boolean;
    minBits?: number;
    minViewers?: number;
    duration?: number; // seconds
    volume?: number;
    enterAnimation?: string;
    exitAnimation?: string;
    textColor?: string;
    borderColor?: string;
    backgroundColor?: string;
    fontSize?: number;
    fontFamily?: string;
    messageTemplate?: string;
    showMessage?: boolean;
    sound?: string;
    customSound?: string;
    image?: string;
    video?: string;
    ttsEnabled?: boolean;
    ttsTemplate?: string;
  }

  interface AlertsConfig {
    global?: AlertsGlobalConfig;
    alertTypes?: Record<string, AlertTypeConfig>;
  }

  /** `config` sent with an alert by the server (overrides the type config). */
  interface AlertEventConfig {
    duration?: number; // ms
    volume?: number;
    enterAnimation?: string;
    exitAnimation?: string;
    textColor?: string;
    borderColor?: string;
    backgroundColor?: string;
    fontSize?: number;
    fontFamily?: string;
    messageTemplate?: string;
    showMessage?: boolean;
    customSound?: string;
    image?: string;
    video?: string;
    ttsEnabled?: boolean;
    ttsTemplate?: string;
    ttsVoice?: string;
    ttsRate?: number;
    ttsPitch?: number;
  }

  interface AlertVariationConfig {
    messageTemplate?: string;
    image?: string;
    video?: string;
  }

  /** Payload of the `alert` WebSocket message. */
  interface AlertEvent {
    alertType: string;
    user?: string;
    amount?: number;
    viewers?: number;
    reward?: string;
    tier?: string;
    message?: string;
    isTest?: boolean;
    config?: AlertEventConfig;
    variationConfig?: AlertVariationConfig;
  }

  /** Config computed in handleAlert() and attached to the queued alert. */
  interface MergedAlertConfig {
    duration: number;
    volume: number;
    enterAnimation: string;
    exitAnimation: string;
    textColor?: string;
    borderColor?: string;
    backgroundColor?: string;
    fontSize: number;
    fontFamily: string;
    messageTemplate?: string;
    sound: string;
    customSound?: string;
    image?: string;
    video?: string;
    ttsEnabled?: boolean;
    ttsTemplate?: string;
    ttsVoice?: string;
    ttsRate?: number;
    ttsPitch?: number;
    showMessage?: boolean; // false hides the viewer's message
  }

  type QueuedAlert = Omit<AlertEvent, 'config'> & { config: MergedAlertConfig };

  type AlertsWindow = Window & {
    alertQueue?: AlertQueue<QueuedAlert>;
    client?: OverlayClient;
    testAlert?: typeof testAlert;
    testAllAlerts?: typeof testAllAlerts;
  };

  /**
   * Read a numeric URL parameter given explicitly in the overlay URL.
   * Returns null when it is absent or not a usable number, so the server
   * config applies; an explicit value overrides the server config.
   */
  function numericParam(name: string, isValid: (value: number) => boolean): number | null {
    const raw = OverlayUtils.getQueryParam(name);
    if (raw === null || raw.trim() === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) && isValid(value) ? value : null;
  }

  // Configuration
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const config = {
    wsUrl: `${wsProtocol}//${window.location.host}`,
    debug: OverlayUtils.getQueryParam('debug') === 'true',

    // Explicit URL overrides (null = not given): they win over the server and per-alert config
    durationOverride: numericParam('duration', value => value > 0),
    volumeOverride: numericParam('volume', value => value >= 0 && value <= 1),

    // Defaults, used when neither the URL nor the server config sets a value
    defaultDelay: 1000,
    defaultVolume: 0.8,
    defaultEnterAnimation: 'bounceIn',
    defaultExitAnimation: 'fadeOutUp'
  };

  // Alert type icons
  const alertIcons: Record<string, string> = {
    follow: '👤',
    subscription: '⭐',
    bits: '💎',
    raid: '🎮',
    redemption: '🎁',
    first_chatter: '👋'
  };

  // Alert type labels
  const alertLabels: Record<string, string> = {
    follow: 'New Follower',
    subscription: 'New Subscriber',
    bits: 'Cheer',
    raid: 'Raid',
    redemption: 'Channel Points',
    first_chatter: 'First Time in Chat'
  };

  // Default sounds (relative to overlay)
  const defaultSounds: Record<string, string> = {
    follow: '../assets/sounds/follow.mp3',
    subscription: '../assets/sounds/subscribe.mp3',
    bits: '../assets/sounds/bits.mp3',
    raid: '../assets/sounds/raid.mp3',
    redemption: '../assets/sounds/redemption.mp3',
    first_chatter: '../assets/sounds/default.mp3',
    default: '../assets/sounds/default.mp3'
  };

  // State
  let alertConfig: AlertsConfig | null = null;
  let ttsManager: TTSManager | null = null;
  let alertQueue: AlertQueue<QueuedAlert> | null = null;
  let client: OverlayClient | null = null;

  // DOM Elements
  const alertWrapper = document.getElementById('alertWrapper')!;
  const alertBox = document.getElementById('alertBox')!;
  const alertIcon = document.getElementById('alertIcon')!;
  const alertTypeLabel = document.getElementById('alertTypeLabel')!;
  const alertUsername = document.getElementById('alertUsername')!;
  const alertAmount = document.getElementById('alertAmount')!;
  const alertMessage = document.getElementById('alertMessage')!;
  const alertDetails = document.getElementById('alertDetails')!;
  const alertTier = document.getElementById('alertTier')!;
  const alertUserMessage = document.getElementById('alertUserMessage')!;
  const mediaContainer = document.getElementById('mediaContainer')!;
  const debugPanel = document.getElementById('debugPanel')!;

  // Show debug panel if enabled
  if (config.debug) {
    debugPanel.classList.add('visible');
  }

  // Initialize
  async function init(): Promise<void> {
    // Load alert configuration from server
    try {
      const res = await fetch('/api/alerts/config');
      alertConfig = await res.json() as AlertsConfig;
      console.log('[Alerts] Loaded config:', alertConfig);
    } catch (error) {
      console.warn('[Alerts] Failed to load config, using defaults:', error);
      alertConfig = { global: {}, alertTypes: {} };
    }

    // Initialize TTS Manager
    ttsManager = new TTSManager({
      enabled: alertConfig.global?.ttsEnabled || false,
      voice: alertConfig.global?.ttsVoice || 'en-US',
      rate: alertConfig.global?.ttsRate || 1.0,
      pitch: alertConfig.global?.ttsPitch || 1.0,
      volume: alertConfig.global?.defaultVolume || 0.8
    });

    // Initialize Alert Queue
    alertQueue = new AlertQueue<QueuedAlert>({
      alertDuration: (alertConfig.global?.defaultDuration || 5) * 1000,
      alertDelay: (alertConfig.global?.defaultDelay || 1) * 1000,
      soundEnabled: true,
      soundVolume: alertConfig.global?.defaultVolume || 0.8,
      onShow: showAlert,
      onHide: hideAlert
    });

    // Load default sounds
    Object.keys(defaultSounds).forEach(type => {
      alertQueue!.loadSound(type, defaultSounds[type]);
    });

    // Connect to WebSocket
    client = new OverlayClient({ wsUrl: config.wsUrl });

    client.on('connected', () => {
      console.log('[Alerts] WebSocket connected');
      updateDebug('status', 'Connected');
    });

    client.on('disconnected', () => {
      console.log('[Alerts] WebSocket disconnected');
      updateDebug('status', 'Disconnected');
    });

    client.on('alert', handleAlert);
    client.on('alertConfig', (newConfig: AlertsConfig) => {
      alertConfig = newConfig;
      console.log('[Alerts] Config updated:', alertConfig);

      // Propagate config changes to runtime components
      if (ttsManager && typeof ttsManager.updateConfig === 'function') {
        ttsManager.updateConfig({
          enabled: alertConfig.global?.ttsEnabled,
          voice: alertConfig.global?.ttsVoice,
          rate: alertConfig.global?.ttsRate,
          pitch: alertConfig.global?.ttsPitch,
          volume: alertConfig.global?.defaultVolume
        });
      }

      if (alertQueue && typeof alertQueue.updateConfig === 'function') {
        alertQueue.updateConfig({
          alertDuration: (alertConfig.global?.defaultDuration || 5) * 1000,
          alertDelay: (alertConfig.global?.defaultDelay || 1) * 1000,
          soundVolume: alertConfig.global?.defaultVolume
        });
      }
    });

    // Expose for debugging
    (window as AlertsWindow).alertQueue = alertQueue;
    (window as AlertsWindow).client = client;
    (window as AlertsWindow).testAlert = testAlert;
    (window as AlertsWindow).testAllAlerts = testAllAlerts;

    console.log('[Alerts] Ready!');
    console.log('  testAlert(type, user, options) - Test single alert');
    console.log('  testAllAlerts() - Test all alert types in sequence');
  }

  // Handle incoming alert
  function handleAlert(data: AlertEvent): void {
    console.log('[Alerts] Received alert:', data);
    updateDebug('lastAlert', `${data.alertType}: ${data.user}`);

    // Check if alerts are globally enabled
    if (alertConfig!.global?.enabled === false) {
      console.log('[Alerts] Alerts are globally disabled');
      return;
    }

    // Get type-specific config
    const typeConfig: AlertTypeConfig = alertConfig!.alertTypes?.[data.alertType] || {};

    // Check if alert type is enabled
    if (typeConfig.enabled === false) {
      console.log(`[Alerts] ${data.alertType} alerts are disabled`);
      return;
    }

    // Check minimum thresholds
    if (data.alertType === 'bits' && typeConfig.minBits) {
      if ((data.amount || 0) < typeConfig.minBits) {
        console.log(`[Alerts] Bits below minimum (${data.amount} < ${typeConfig.minBits})`);
        return;
      }
    }
    if (data.alertType === 'raid' && typeConfig.minViewers) {
      if ((data.viewers || 0) < typeConfig.minViewers) {
        console.log(`[Alerts] Raid below minimum viewers (${data.viewers} < ${typeConfig.minViewers})`);
        return;
      }
    }

    // Merge configs: explicit URL params first, then data.config from the server,
    // then typeConfig, then defaults
    const mergedConfig: MergedAlertConfig = {
      duration: config.durationOverride ?? (data.config?.duration || (typeConfig.duration || 5) * 1000),
      volume: config.volumeOverride ?? data.config?.volume ?? typeConfig.volume ?? config.defaultVolume,
      enterAnimation: data.config?.enterAnimation || typeConfig.enterAnimation || config.defaultEnterAnimation,
      exitAnimation: data.config?.exitAnimation || typeConfig.exitAnimation || config.defaultExitAnimation,
      textColor: data.config?.textColor || typeConfig.textColor,
      borderColor: data.config?.borderColor || typeConfig.borderColor,
      backgroundColor: data.config?.backgroundColor || typeConfig.backgroundColor,
      fontSize: data.config?.fontSize || typeConfig.fontSize || 28,
      fontFamily: data.config?.fontFamily || typeConfig.fontFamily || 'Segoe UI',
      messageTemplate: data.variationConfig?.messageTemplate || data.config?.messageTemplate || typeConfig.messageTemplate,
      showMessage: data.config?.showMessage ?? typeConfig.showMessage,
      sound: typeConfig.sound || 'default',
      customSound: data.config?.customSound ?? typeConfig.customSound,
      image: data.config?.image ?? data.variationConfig?.image ?? typeConfig.image,
      video: data.config?.video ?? data.variationConfig?.video ?? typeConfig.video,
      ttsEnabled: (data.config?.ttsEnabled ?? typeConfig.ttsEnabled) && alertConfig!.global?.ttsEnabled,
      ttsTemplate: data.config?.ttsTemplate || typeConfig.ttsTemplate,
      ttsVoice: data.config?.ttsVoice || alertConfig!.global?.ttsVoice,
      ttsRate: data.config?.ttsRate || alertConfig!.global?.ttsRate,
      ttsPitch: data.config?.ttsPitch || alertConfig!.global?.ttsPitch
    };

    // Build alert object
    const alert: QueuedAlert = {
      ...data,
      config: mergedConfig
    };

    // Load custom sound if specified
    if (mergedConfig.sound === 'custom' && mergedConfig.customSound) {
      alertQueue!.loadSound(data.alertType + '_custom', mergedConfig.customSound);
    }

    // Add to queue
    alertQueue!.add(alert);
    updateDebug('queue', alertQueue!.queue.length);
  }

  // Show alert
  function showAlert(alert: QueuedAlert): void {
    const cfg = alert.config || ({} as MergedAlertConfig);

    // Reset state
    mediaContainer.innerHTML = '';
    alertAmount.style.display = 'none';
    alertTier.style.display = 'none';
    alertUserMessage.style.display = 'none';

    // Set alert type class
    alertBox.className = 'alert-box ' + alert.alertType;

    // Apply custom styles
    if (cfg.textColor) {
      alertUsername.style.color = cfg.textColor;
    }
    if (cfg.borderColor) {
      alertBox.style.borderColor = cfg.borderColor;
      alertBox.style.boxShadow = `0 8px 32px ${cfg.borderColor}40`;
    }
    if (cfg.backgroundColor) {
      alertBox.style.background = cfg.backgroundColor;
    }
    if (cfg.fontSize) {
      alertUsername.style.fontSize = cfg.fontSize + 'px';
    }
    if (cfg.fontFamily) {
      alertBox.style.fontFamily = cfg.fontFamily;
    }

    // Display media (video takes precedence)
    if (cfg.video) {
      const video = document.createElement('video');
      video.src = cfg.video;
      video.className = 'alert-video';
      video.autoplay = true;
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      mediaContainer.appendChild(video);
    } else if (cfg.image) {
      const img = document.createElement('img');
      img.src = cfg.image;
      img.className = 'alert-media';
      img.alt = 'Alert';
      mediaContainer.appendChild(img);
    }

    // Set icon and labels
    alertIcon.textContent = alertIcons[alert.alertType] || '🔔';
    alertTypeLabel.textContent = alertLabels[alert.alertType] || 'Alert';
    alertUsername.textContent = alert.user || 'Unknown';

    // Set message
    let message = cfg.messageTemplate || '';
    // Replace placeholders (global regex for multiple occurrences)
    message = message.replace(/\{(\w+)\}/g, (match, key: string) => {
      const values: Record<string, string | number> = {
        'user': alert.user || '',
        'amount': alert.amount || '',
        'viewers': alert.viewers || '',
        'reward': alert.reward || '',
        'tier': OverlayUtils.parseTier(alert.tier) || ''
      };
      // Numbers are coerced to strings by String.prototype.replace
      return (values[key] !== undefined ? values[key] : match) as string;
    });
    alertMessage.textContent = message;

    // Type-specific content
    if (alert.alertType === 'bits' && alert.amount) {
      alertAmount.textContent = OverlayUtils.formatNumber(alert.amount) + ' Bits';
      alertAmount.style.display = 'block';
      alertAmount.style.color = cfg.textColor || '#ffbb00';
    }

    if (alert.alertType === 'raid' && alert.viewers) {
      alertDetails.textContent = OverlayUtils.formatNumber(alert.viewers) + ' viewers';
    } else {
      alertDetails.textContent = '';
    }

    if (alert.alertType === 'subscription' && alert.tier) {
      const tierText = OverlayUtils.parseTier(alert.tier) as string;
      alertTier.textContent = tierText;
      alertTier.className = 'alert-tier';
      if (alert.tier === 'Prime') {
        alertTier.classList.add('tier-prime');
      } else if (alert.tier === '1000') {
        alertTier.classList.add('tier-1');
      } else if (alert.tier === '2000') {
        alertTier.classList.add('tier-2');
      } else if (alert.tier === '3000') {
        alertTier.classList.add('tier-3');
      }
      alertTier.style.display = 'inline-block';
    }

    if (alert.alertType === 'redemption' && alert.reward) {
      alertDetails.textContent = alert.reward;
    }

    // Show user message if present and not disabled by config
    if (alert.message && cfg.showMessage !== false) {
      alertUserMessage.textContent = '"' + alert.message + '"';
      alertUserMessage.style.display = 'block';
    }

    // Play sound
    const soundType = (cfg.sound === 'custom' && cfg.customSound)
      ? alert.alertType + '_custom'
      : (cfg.sound === 'none' ? null : alert.alertType);
    if (soundType) {
      alertQueue!.playSound(soundType);
    }

    // Show with animation
    alertWrapper.classList.add('visible');
    alertBox.classList.add('animate-' + (cfg.enterAnimation || 'bounceIn'));

    // Handle TTS
    if (cfg.ttsEnabled && cfg.ttsTemplate) {
      // Parse TTS template
      const ttsText = ttsManager!.parseTemplate(cfg.ttsTemplate, {
        user: alert.user || 'Someone',
        amount: alert.amount || '',
        viewers: alert.viewers || '',
        reward: alert.reward || '',
        tier: OverlayUtils.parseTier(alert.tier) || '',
        message: alert.message || ''
      });

      // Speak after a short delay
      setTimeout(() => {
        // Update TTS manager config (voice, rate, pitch) before speaking
        ttsManager!.updateConfig({
          voice: cfg.ttsVoice,
          rate: cfg.ttsRate,
          pitch: cfg.ttsPitch,
          volume: cfg.volume
        });
        ttsManager!.speak(ttsText);
      }, 500);
    }

    updateDebug('queue', alertQueue!.queue.length);
  }

  // Hide alert
  function hideAlert(alert: QueuedAlert): void {
    const cfg = alert.config || ({} as MergedAlertConfig);
    const exitAnimation = cfg.exitAnimation || 'fadeOutUp';

    // Remove enter animation
    alertBox.className = 'alert-box ' + alert.alertType;

    // Add exit animation
    alertBox.classList.add('animate-' + exitAnimation);

    // Hide after animation
    setTimeout(() => {
      alertWrapper.classList.remove('visible');
      alertBox.className = 'alert-box';

      // Reset styles
      alertUsername.style.color = '';
      alertBox.style.borderColor = '';
      alertBox.style.boxShadow = '';
      alertBox.style.background = '';
      alertUsername.style.fontSize = '';
      alertBox.style.fontFamily = '';
      alertAmount.style.color = '';

      // Stop video if playing
      const video = mediaContainer.querySelector('video');
      if (video) {
        video.pause();
      }
      mediaContainer.innerHTML = '';

      updateDebug('queue', alertQueue!.queue.length);
    }, 500);
  }

  // Update debug panel
  function updateDebug(field: string, value: string | number): void {
    if (!config.debug) return;
    const el = document.getElementById('debug' + field.charAt(0).toUpperCase() + field.slice(1));
    if (el) el.textContent = value as string;
  }

  // Test alert function
  function testAlert(type = 'follow', user = 'TestUser', options: Partial<AlertEvent> = {}): void {
    const alertData: AlertEvent = {
      alertType: type,
      user: user,
      isTest: true,
      ...options
    };

    // Add sensible defaults for type-specific fields if not provided
    if (type === 'subscription' && !options.tier) alertData.tier = '1000';
    if (type === 'bits' && !options.amount) alertData.amount = 100;
    if (type === 'raid' && !options.viewers) alertData.viewers = 50;
    if (type === 'redemption' && !options.reward) alertData.reward = 'Hydrate!';

    handleAlert(alertData);
  }

  // Test all alert types
  function testAllAlerts(): void {
    console.log('[Alerts] Testing all alert types...');
    testAlert('follow', 'FollowUser');
    setTimeout(() => testAlert('subscription', 'SubUser', { tier: '2000', message: 'Love the stream!' }), 2000);
    setTimeout(() => testAlert('bits', 'BitsUser', { amount: 500, message: 'Here are some bits!' }), 4000);
    setTimeout(() => testAlert('raid', 'RaidUser', { viewers: 150 }), 6000);
    setTimeout(() => testAlert('redemption', 'RedeemUser', { reward: 'Highlight My Message', message: 'Notice me!' }), 8000);
  }

  // Initialize on load
  init();
})();
