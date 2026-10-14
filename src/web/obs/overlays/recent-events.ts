/**
 * Recent Events Overlay
 * Displays a scrolling list of the latest followers, subscribers, bits, and raids
 *
 * Usage: Add as Browser Source in OBS
 * URL: http://localhost:3001/obs/overlays/recent-events.html
 * Recommended size: 400x400 or custom based on your scene
 *
 * URL Parameters:
 *   ?limit=10     - Maximum number of events to display
 *   ?type=follow  - Filter by event type (follow, subscription, bits, raid, all)
 *   ?showTime=true - Show time ago for each event (default: true)
 *
 * Events are fetched via the /obs/recent/:type endpoint and updated
 * via WebSocket when new events occur.
 */
(function() {
  'use strict';

  /** Section of GET /obs/config read by this overlay. */
  interface RecentEventsObsConfig {
    overlays: {
      recentEvents: {
        limit?: number;
        showTime?: boolean;
      };
    };
  }

  /**
   * An event from GET /obs/recent, or an `eventsub-event` / `alert` WebSocket payload.
   */
  interface RecentEvent {
    type?: string;
    alertType?: string;
    event?: string;
    user?: string;
    tier?: string;
    amount?: number;
    viewers?: number;
    reward?: string;
    timestamp?: string;
  }

  /** Response of GET /obs/recent. */
  interface RecentEventsResponse {
    events?: RecentEvent[];
  }

  type RecentEventsWindow = Window & {
    eventsList?: RecentEvent[];
  };

  const eventsList = document.getElementById('events-list')!;

  // Configuration - loaded from dashboard /obs/config endpoint
  let config = {
    maxEvents: 10,
    eventType: 'all',
    showTime: true,
    updateInterval: 5000 // Refresh events every 5 seconds
  };

  // Store events in memory
  let events: RecentEvent[] = [];

  // Load configuration from dashboard
  async function loadConfig(): Promise<void> {
    try {
      const res = await fetch('/obs/config');
      const obsConfig = await res.json() as RecentEventsObsConfig;
      const recentEventsConfig = obsConfig.overlays.recentEvents;

      // Apply dashboard configuration
      config.maxEvents = recentEventsConfig.limit || 10;
      config.eventType = 'all';
      config.showTime = recentEventsConfig.showTime !== false;
      config.updateInterval = 5000;

      // Allow URL parameters to override dashboard config
      const paramLimit = parseInt(OverlayUtils.getQueryParam('limit') as string);
      if (!isNaN(paramLimit)) config.maxEvents = paramLimit;
      const paramType = OverlayUtils.getQueryParam('type');
      if (paramType) config.eventType = paramType;
      const paramShowTime = OverlayUtils.getQueryParam('showTime');
      if (paramShowTime !== null) config.showTime = paramShowTime !== 'false';
    } catch (error) {
      console.error('Failed to load OBS config, using defaults:', error);
    }

    // Start fetching events
    fetchRecentEvents();
    setInterval(fetchRecentEvents, config.updateInterval);

    // Initialize WebSocket client
    initializeClient();
  }

  function initializeClient(): void {
    const client = new OverlayClient();

    // Listen for new events
    client.on('eventsub-event', (data: RecentEvent) => {
      if (data.event || data.alertType) {
        events.unshift(data);
        if (events.length > config.maxEvents) {
          events.pop();
        }
        renderEvents();
      }
    });

    client.on('alert', (data: RecentEvent) => {
      events.unshift(data);
      if (events.length > config.maxEvents) {
        events.pop();
      }
      renderEvents();
    });

    client.on('connected', () => {
      console.log('[RecentEventsOverlay] WebSocket connected');
    });
  }

  /**
   * Fetch recent events from server
   */
  async function fetchRecentEvents(): Promise<void> {
    try {
      const type = config.eventType === 'all' ? '' : config.eventType;
      const url = type ? `/obs/recent/${type}` : '/obs/recent';
      const response = await fetch(url);
      const data = await response.json() as RecentEventsResponse;

      if (data.events && Array.isArray(data.events)) {
        events = data.events.slice(0, config.maxEvents);
        renderEvents();
      }
    } catch (err) {
      console.error('[RecentEventsOverlay] Failed to fetch events:', err);
    }
  }

  /**
   * Build HTML for a single event
   */
  function buildEventHtml(event: RecentEvent): string {
    const type = event.type || event.alertType || 'unknown';
    const iconMap: Record<string, string> = {
      follow: '👤',
      subscription: '⭐',
      bits: '💎',
      raid: '🎮',
      redemption: '🎁'
    };
    const icon = iconMap[type] || '•';

    let text = '';
    switch (type) {
      case 'follow':
        text = `${event.user} followed`;
        break;
      case 'subscription':
        const tier = event.tier ? ` (${OverlayUtils.parseTier(event.tier)})` : '';
        text = `${event.user} subscribed${tier}`;
        break;
      case 'bits':
        text = `${event.user} cheered ${OverlayUtils.formatNumber(event.amount || 0)} bits`;
        break;
      case 'raid':
        text = `${event.user} raided with ${OverlayUtils.formatNumber(event.viewers || 0)} viewers`;
        break;
      case 'redemption':
        text = `${event.user} redeemed ${event.reward || 'unknown'}`;
        break;
      default:
        text = `${event.user} ${type}`;
    }

    const time = config.showTime && event.timestamp ?
      OverlayUtils.timeAgo(event.timestamp) : '';

    return `
          <div class="recent-event-item ${type}">
            <div class="event-icon">${icon}</div>
            <div class="event-text">${OverlayUtils.escapeHtml(text)}</div>
            ${time ? `<div class="event-time">${time}</div>` : ''}
          </div>
        `;
  }

  /**
   * Render events list
   */
  function renderEvents(): void {
    if (events.length === 0) {
      eventsList.innerHTML = '<div style="color: #666; text-align: center; padding: 20px;">No events yet</div>';
      return;
    }

    eventsList.innerHTML = events.map(event => buildEventHtml(event)).join('');
  }

  /**
   * Add event to the top of the list
   * (currently unused)
   */
  function addEvent(event: RecentEvent): void {
    // Add to beginning
    events.unshift(event);
    // Limit to maxEvents
    if (events.length > config.maxEvents) {
      events = events.slice(0, config.maxEvents);
    }
    renderEvents();
  }

  // Load configuration from dashboard and initialize
  loadConfig();

  // Expose for debugging
  (window as RecentEventsWindow).eventsList = events;

  console.log('[RecentEventsOverlay] Ready!');
})();
