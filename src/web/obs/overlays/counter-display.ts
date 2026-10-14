(function() {
  'use strict';

  /** Counter values by name, as this overlay reads them. */
  type CounterValues = Record<string, number>;

  /** One counter object as stored by the dashboard (fields read here). */
  interface CounterEntry {
    name: string;
    value: number;
  }

  /**
   * Counter data accepted from the API and from WebSocket messages:
   *   - GET /api/counters returns `CounterEntry[]` (one object per counter);
   *   - the `counter-update` WebSocket message carries that same array as its
   *     `data`, broadcast by the dashboard after every counter write
   *     (create, update, increment, decrement, reset, delete, config);
   *   - a name -> value map, bare or as `{ counters: ... }`, is still accepted
   *     for custom ?api endpoints.
   */
  type CountersPayload = CounterEntry[] | CounterValues | { counters?: CounterEntry[] | CounterValues };

  // Configuration from URL parameters
  const config = {
    mode: OverlayUtils.getQueryParam('mode') || 'single', // single, multi, score
    counter: OverlayUtils.getQueryParam('counter') || 'deaths',
    counters: (OverlayUtils.getQueryParam('counters') || 'deaths,wins,losses').split(','),
    pollInterval: parseInt(OverlayUtils.getQueryParam('poll') || '5000', 10),
    apiUrl: OverlayUtils.getQueryParam('api') || '/api/counters'
  };

  // State
  let previousValues: Record<string, number> = {};

  // Elements
  const singleContainer = document.getElementById('single-counter')!;
  const multiContainer = document.getElementById('multi-counter')!;
  const scoreContainer = document.getElementById('score-display')!;
  const counterLabel = document.getElementById('counter-label')!;
  const counterValue = document.getElementById('counter-value')!;
  const winsValue = document.getElementById('wins-value')!;
  const lossesValue = document.getElementById('losses-value')!;
  const winrateValue = document.getElementById('winrate-value')!;

  /**
   * Initialize display mode
   */
  function initMode(): void {
    switch (config.mode) {
      case 'single':
        singleContainer.classList.remove('hidden');
        counterLabel.textContent = formatLabel(config.counter);
        break;
      case 'multi':
        multiContainer.classList.remove('hidden');
        initMultiCounters();
        break;
      case 'score':
        scoreContainer.classList.remove('hidden');
        break;
    }
  }

  /**
   * Format counter label
   */
  function formatLabel(name: string): string {
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  /**
   * Initialize multi-counter elements
   */
  function initMultiCounters(): void {
    config.counters.forEach(name => {
      const div = document.createElement('div');
      div.className = 'counter-item';
      div.id = `counter-${name}`;

      // Built with textContent: names come from the URL and must not become markup
      const label = document.createElement('span');
      label.className = 'counter-label';
      label.textContent = formatLabel(name);

      const value = document.createElement('span');
      value.className = 'counter-value';
      value.id = `value-${name}`;
      value.textContent = '0';

      div.append(label, value);
      multiContainer.appendChild(div);
    });
  }

  /**
   * Turn any accepted counters payload into a name -> value map.
   * Returns null for payloads that carry no counter data.
   */
  function toCounterValues(data: CountersPayload | null | undefined): CounterValues | null {
    if (!data || typeof data !== 'object') return null;
    const counters = Array.isArray(data) ? data : ((data as { counters?: CounterEntry[] | CounterValues }).counters || data);

    if (!Array.isArray(counters)) return counters as CounterValues;

    const values: CounterValues = {};
    counters.forEach(counter => {
      if (counter && typeof counter.name === 'string') {
        values[counter.name] = Number(counter.value) || 0;
      }
    });
    return values;
  }

  /**
   * Apply a counters payload from the API or a WebSocket message
   */
  function applyCounters(data: CountersPayload | null | undefined): void {
    const counters = toCounterValues(data);
    if (counters) {
      updateDisplay(counters);
    }
  }

  /**
   * Fetch counter data from API
   */
  async function fetchCounters(): Promise<void> {
    try {
      const response = await fetch(config.apiUrl);
      applyCounters(await response.json() as CountersPayload);
    } catch (err) {
      console.error('[Counter] Failed to fetch:', err);
    }
  }

  /**
   * Update display with new values
   */
  function updateDisplay(counters: CounterValues): void {
    switch (config.mode) {
      case 'single':
        updateSingleCounter(counters[config.counter] || 0);
        break;
      case 'multi':
        updateMultiCounters(counters);
        break;
      case 'score':
        updateScore(counters);
        break;
    }
  }

  /**
   * Update single counter
   */
  function updateSingleCounter(value: number): void {
    const prevValue = previousValues[config.counter] || 0;
    const element = document.getElementById('main-counter')!;

    counterValue.textContent = OverlayUtils.formatNumber(value);

    if (value !== prevValue) {
      highlightChange(element, value > prevValue);
    }

    previousValues[config.counter] = value;
  }

  /**
   * Update multi counters
   */
  function updateMultiCounters(counters: CounterValues): void {
    config.counters.forEach(name => {
      const value = counters[name] || 0;
      const prevValue = previousValues[name] || 0;
      const valueElement = document.getElementById(`value-${name}`);
      const itemElement = document.getElementById(`counter-${name}`)!;

      if (valueElement) {
        valueElement.textContent = OverlayUtils.formatNumber(value);

        if (value !== prevValue) {
          highlightChange(itemElement, value > prevValue);
        }
      }

      previousValues[name] = value;
    });
  }

  /**
   * Update score display
   */
  function updateScore(counters: CounterValues): void {
    const wins = counters.wins || 0;
    const losses = counters.losses || 0;
    const total = wins + losses;
    const winRate = total > 0 ? ((wins / total) * 100).toFixed(1) : '0.0';

    winsValue.textContent = OverlayUtils.formatNumber(wins);
    lossesValue.textContent = OverlayUtils.formatNumber(losses);
    winrateValue.textContent = `${winRate}% Win Rate`;
  }

  /**
   * Highlight counter change
   */
  function highlightChange(element: HTMLElement, isIncrease: boolean): void {
    element.classList.add('highlight');
    if (!isIncrease) {
      element.classList.add('decrease');
    }

    setTimeout(() => {
      element.classList.remove('highlight', 'decrease');
    }, 2000);
  }

  // Initialize
  initMode();
  fetchCounters();

  // Poll for updates (fallback for missed WebSocket messages)
  setInterval(fetchCounters, config.pollInterval);

  // Live updates: the dashboard broadcasts `counter-update` after every counter write
  const client = new OverlayClient();
  client.on('counter-update', (data: CountersPayload) => {
    applyCounters(data);
  });
})();
