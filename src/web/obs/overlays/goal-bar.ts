/**
 * Goal Bar Overlay
 * Displays progress toward follower or subscriber goals
 *
 * Usage: Add as Browser Source in OBS
 * URL: http://localhost:3001/obs/overlays/goal-bar.html
 * Recommended size: 600x150 or custom based on your scene
 *
 * URL Parameters:
 *   ?type=follow        - Goal type: follow or subscriber (default: follow)
 *   ?goal=1000          - Target number (default: 1000)
 *   ?current=0          - Starting current number (default: 0, loaded from API)
 *   ?title=Follower Goal - Custom title to display
 *
 * Configuration is loaded from /obs/config endpoint if available.
 */
(function() {
  'use strict';

  /** Section of GET /obs/config read by this overlay. */
  interface GoalBarObsConfig {
    overlays: {
      goalBar: {
        type?: string;
        goal?: number;
      };
    };
  }

  /** Payload of the `eventsub-event` WebSocket message (fields read here). */
  interface GoalEventSubEvent {
    event?: string;
  }

  /** Payload of the `alert` WebSocket message (fields read here). */
  interface GoalAlertEvent {
    alertType?: string;
  }

  type GoalBarWindow = Window & {
    goalCurrent?: number;
    client?: OverlayClient;
    updateDisplay?: () => void;
    config?: typeof config;
    testIncrement?: () => void;
    testDecrement?: () => void;
    testSet?: (value: number) => void;
  };

  // Configuration - loaded from dashboard /obs/config endpoint
  let config = {
    type: 'follow',
    goalTarget: 1000,
    title: 'Follower Goal'
  };

  let goalCurrent = 0;

  // Load configuration from dashboard
  async function loadConfig(): Promise<void> {
    try {
      const res = await fetch('/obs/config');
      const obsConfig = await res.json() as GoalBarObsConfig;
      const goalBarConfig = obsConfig.overlays.goalBar;

      // Apply dashboard configuration
      config.type = goalBarConfig.type || 'follow';
      config.goalTarget = goalBarConfig.goal || 1000;
      config.title = config.type === 'subscriber' ? 'Subscriber Goal' : 'Follower Goal';
      goalCurrent = 0;

      // Allow URL parameters to override dashboard config
      const paramType = OverlayUtils.getQueryParam('type');
      if (paramType) config.type = paramType;
      const paramGoal = parseInt(OverlayUtils.getQueryParam('goal') as string);
      if (!isNaN(paramGoal)) config.goalTarget = paramGoal;
      const paramTitle = OverlayUtils.getQueryParam('title');
      if (paramTitle) config.title = paramTitle;
      const paramCurrent = parseInt(OverlayUtils.getQueryParam('current') as string);
      if (!isNaN(paramCurrent)) goalCurrent = paramCurrent;
    } catch (error) {
      console.error('Failed to load OBS config, using defaults:', error);
    }

    // Initialize the display and WebSocket
    initializeDisplay();
    initializeClient();
  }

  function initializeDisplay(): void {
    // Set title
    goalTitle.textContent = config.title;

    // Set type-specific styling
    if (config.type === 'subscriber') {
      goalProgress.classList.add('goal-subscriber');
    } else {
      goalProgress.classList.add('goal-follow');
    }

    // Update display
    updateDisplay();
  }

  function initializeClient(): void {
    const client = new OverlayClient();

    // Listen for follow/subscriber events
    client.on('eventsub-event', (data: GoalEventSubEvent) => {
      if ((config.type === 'follow' && data.event === 'follow') ||
          (config.type === 'subscriber' && data.event === 'subscription')) {
        goalCurrent++;
        updateDisplay();
      }
    });

    client.on('alert', (data: GoalAlertEvent) => {
      if ((config.type === 'follow' && data.alertType === 'follow') ||
          (config.type === 'subscriber' && data.alertType === 'subscription')) {
        goalCurrent++;
        updateDisplay();
      }
    });

    client.on('connected', () => {
      console.log('[GoalBarOverlay] WebSocket connected');
    });

    // Expose for debugging
    (window as GoalBarWindow).goalCurrent = goalCurrent;
    (window as GoalBarWindow).client = client;
  }

  // DOM elements
  const goalTitle = document.getElementById('goal-title')!;
  const goalProgress = document.getElementById('goal-progress')!;
  const goalText = document.getElementById('goal-text')!;
  const goalPercentage = document.getElementById('goal-percentage')!;
  const goalCurrentEl = document.getElementById('goal-current')!;
  const goalTargetEl = document.getElementById('goal-target')!;
  const goalRemainingEl = document.getElementById('goal-remaining')!;

  /**
   * Update goal display
   */
  function updateDisplay(): void {
    const percentage = Math.min((goalCurrent / config.goalTarget) * 100, 100);
    const remaining = Math.max(config.goalTarget - goalCurrent, 0);

    // Update progress bar width
    goalProgress.style.width = `${percentage}%`;

    // Update text in progress bar
    goalText.textContent = `${OverlayUtils.formatNumber(goalCurrent)} / ${OverlayUtils.formatNumber(config.goalTarget)}`;

    // Update percentage text
    goalPercentage.textContent = `${Math.round(percentage)}%`;

    // Update stats
    goalCurrentEl.textContent = OverlayUtils.formatNumber(goalCurrent);
    goalTargetEl.textContent = OverlayUtils.formatNumber(config.goalTarget);
    goalRemainingEl.textContent = OverlayUtils.formatNumber(remaining);

    console.log(`[GoalBarOverlay] Updated: ${goalCurrent}/${config.goalTarget} (${percentage.toFixed(1)}%)`);
  }

  // Load configuration from dashboard and initialize
  loadConfig();

  // Expose for debugging
  (window as GoalBarWindow).updateDisplay = updateDisplay;
  (window as GoalBarWindow).config = config;

  // Test functions
  (window as GoalBarWindow).testIncrement = () => {
    goalCurrent++;
    updateDisplay();
  };

  (window as GoalBarWindow).testDecrement = () => {
    goalCurrent = Math.max(goalCurrent - 1, 0);
    updateDisplay();
  };

  (window as GoalBarWindow).testSet = (value: number) => {
    goalCurrent = Math.min(value, config.goalTarget);
    updateDisplay();
  };

  console.log('[GoalBarOverlay] Ready!');
})();
