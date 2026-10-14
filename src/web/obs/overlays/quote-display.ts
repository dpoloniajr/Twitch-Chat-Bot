(function() {
  'use strict';

  /** Quote object from GET /api/quotes/random or the quote-* WebSocket messages. */
  interface Quote {
    id?: number | string;
    text?: string;
    author?: string;
    game?: string;
    addedAt?: string;
  }

  /** Response of the quotes API: `{ quote: {...} }` or the bare quote. */
  type QuoteResponse = Quote & { quote?: Quote };

  /** Payload of the quote-display / quote-command WebSocket messages. */
  interface QuoteEvent {
    quote?: Quote;
  }

  /**
   * Payload (`data`) of the `quote-update` WebSocket message, broadcast by the
   * dashboard after every successful quote write:
   *   - add or edit: the quote object itself, as GET /api/quotes/:id returns it;
   *   - delete: `{ id, deleted: true }`;
   *   - import: `{ imported: n }`; config change: `{ config }`.
   * Only the first two have `text`.
   */
  type QuoteUpdateEvent = Quote & { deleted?: boolean; imported?: number };

  // Configuration from URL parameters
  const config = {
    mode: OverlayUtils.getQueryParam('mode') || 'normal', // normal, compact, minimal
    autoRotate: OverlayUtils.getQueryParam('rotate') === 'true',
    rotateInterval: parseInt(OverlayUtils.getQueryParam('interval') || '60000', 10),
    displayDuration: parseInt(OverlayUtils.getQueryParam('duration') || '0', 10), // 0 = always visible
    apiUrl: OverlayUtils.getQueryParam('api') || '/api/quotes/random',
    showAuthor: OverlayUtils.getQueryParam('author') !== 'false',
    showGame: OverlayUtils.getQueryParam('game') !== 'false',
    showDate: OverlayUtils.getQueryParam('date') !== 'false'
  };

  // State
  let currentQuote: Quote | null = null;
  let hideTimeout: ReturnType<typeof setTimeout> | null = null;

  // Elements
  const container = document.getElementById('quote-container')!;
  const textElement = document.getElementById('quote-text')!;
  const authorElement = document.getElementById('quote-author')!;
  const gameElement = document.getElementById('quote-game')!;
  const idElement = document.getElementById('quote-id')!;
  const dateElement = document.getElementById('quote-date')!;

  // Apply mode
  if (config.mode !== 'normal') {
    container.classList.add(config.mode);
  }

  /**
   * Fetch random quote
   * @returns {Promise<boolean>} whether a quote was displayed
   */
  async function fetchQuote(): Promise<boolean> {
    try {
      const response = await fetch(config.apiUrl);
      const data = await response.json() as QuoteResponse;

      if (data.quote || data) {
        return displayQuote(data.quote || data);
      }
    } catch (err) {
      console.error('[Quote] Failed to fetch:', err);
    }
    return false;
  }

  /**
   * Display a quote
   */
  function displayQuote(quote: Quote): boolean {
    if (!quote || !quote.text) return false;

    renderQuote(quote);

    // Show container
    showQuote();

    // Auto-hide if duration is set
    if (config.displayDuration > 0) {
      if (hideTimeout) clearTimeout(hideTimeout);
      hideTimeout = setTimeout(hideQuote, config.displayDuration);
    }
    return true;
  }

  /**
   * Write a quote into the elements without changing visibility
   */
  function renderQuote(quote: Quote): void {
    currentQuote = quote;

    // Update content
    textElement.textContent = quote.text || '';
    idElement.textContent = `#${quote.id}`;

    if (config.showAuthor && quote.author) {
      authorElement.textContent = `— ${quote.author}`;
      authorElement.style.display = '';
    } else {
      authorElement.style.display = 'none';
    }

    if (config.showGame && quote.game) {
      gameElement.textContent = quote.game;
      gameElement.style.display = '';
    } else {
      gameElement.style.display = 'none';
    }

    if (config.showDate && quote.addedAt) {
      dateElement.textContent = ` • ${new Date(quote.addedAt).toLocaleDateString()}`;
    } else {
      dateElement.textContent = '';
    }
  }

  /**
   * Whether an update refers to the quote currently on screen
   */
  function isCurrentQuote(update: QuoteUpdateEvent): boolean {
    return !!currentQuote && update.id !== undefined && String(update.id) === String(currentQuote.id);
  }

  /**
   * Apply a `quote-update` message: an edit of the quote on screen is shown
   * in place, deleting it swaps in another random quote, and when nothing is
   * on screen yet (no quotes existed) a new or imported quote is fetched/shown.
   * Updates to other quotes leave the display alone.
   */
  function handleQuoteUpdate(update: QuoteUpdateEvent | null | undefined): void {
    if (!update || typeof update !== 'object') return;

    if (update.deleted) {
      if (isCurrentQuote(update)) {
        // Swap in another quote; hide only when none is left
        currentQuote = null;
        fetchQuote().then(shown => {
          if (!shown) hideQuote();
        });
      }
      return;
    }

    if (update.text) {
      if (isCurrentQuote(update)) {
        renderQuote(update);
      } else if (!currentQuote) {
        displayQuote(update);
      }
      return;
    }

    if (update.imported && !currentQuote) {
      fetchQuote();
    }
  }

  /**
   * Show quote with animation
   */
  function showQuote(): void {
    container.classList.remove('hidden', 'hide');
    container.classList.add('show');
  }

  /**
   * Hide quote with animation
   */
  function hideQuote(): void {
    container.classList.remove('show');
    container.classList.add('hide');

    setTimeout(() => {
      container.classList.add('hidden');
    }, 500);
  }

  /**
   * Initialize
   */
  function init(): void {
    // Fetch initial quote
    fetchQuote();

    // Auto-rotate if enabled
    if (config.autoRotate) {
      setInterval(fetchQuote, config.rotateInterval);
    }
  }

  // Start
  init();

  // Listen for WebSocket commands
  const client = new OverlayClient();

  // Listen for quote display commands
  client.on('quote-display', (data: QuoteEvent) => {
    if (data.quote) {
      displayQuote(data.quote);
    }
  });

  // Live updates: the dashboard broadcasts `quote-update` after every quote write
  client.on('quote-update', (data: QuoteUpdateEvent) => {
    handleQuoteUpdate(data);
  });

  // Listen for hide commands
  client.on('quote-hide', () => {
    hideQuote();
  });

  // Listen for chat command triggers (!quote)
  client.on('quote-command', (data: QuoteEvent) => {
    if (data.quote) {
      displayQuote(data.quote);
    }
  });
})();
