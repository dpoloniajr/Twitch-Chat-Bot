/**
 * Quotes System
 * Store and retrieve memorable quotes from stream
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/logger';

const logger = createLogger('Quotes');

/**
 * Quote data structure
 */
export interface Quote {
  id: number;
  text: string;
  addedBy: string;
  addedAt: string;
  game?: string;
  context?: string;
}

/**
 * Quotes manager configuration
 */
export interface QuotesConfig {
  /** Maximum number of quotes */
  maxQuotes: number;
  /** Minimum quote length */
  minLength: number;
  /** Maximum quote length */
  maxLength: number;
  /** Allow duplicate quotes */
  allowDuplicates: boolean;
}

const DEFAULT_CONFIG: QuotesConfig = {
  maxQuotes: 10000,
  minLength: 5,
  maxLength: 500,
  allowDuplicates: false,
};

/**
 * Quotes manager class
 */
export class QuotesManager {
  private quotes: Quote[];
  private config: QuotesConfig;
  private dataPath: string;
  private nextId: number;
  private dirty: boolean = false;
  private saveInterval: NodeJS.Timeout | null = null;

  constructor(options?: {
    dataPath?: string;
    config?: Partial<QuotesConfig>;
    autoSaveIntervalMs?: number;
  }) {
    this.quotes = [];
    this.config = { ...DEFAULT_CONFIG, ...options?.config };
    this.dataPath = options?.dataPath || path.join(process.cwd(), 'dashboard', 'logs', 'quotes.json');
    this.nextId = 1;

    this.loadData();

    // Auto-save periodically
    const autoSaveInterval = options?.autoSaveIntervalMs || 60000;
    if (autoSaveInterval > 0) {
      this.saveInterval = setInterval(() => this.saveIfDirty(), autoSaveInterval);
    }
  }

  /**
   * Load quotes from file
   */
  private loadData(): void {
    try {
      if (fs.existsSync(this.dataPath)) {
        const content = fs.readFileSync(this.dataPath, 'utf-8');
        const parsed = JSON.parse(content);

        if (Array.isArray(parsed.quotes)) {
          this.quotes = parsed.quotes;
        }
        if (parsed.config) {
          this.config = { ...this.config, ...parsed.config };
        }
        if (parsed.nextId) {
          this.nextId = parsed.nextId;
        }

        // Ensure nextId is higher than any existing quote
        const maxId = this.quotes.reduce((max, q) => Math.max(max, q.id), 0);
        if (this.nextId <= maxId) {
          this.nextId = maxId + 1;
        }

        logger.info('Loaded quotes', { count: this.quotes.length });
      }
    } catch (error) {
      logger.error('Failed to load quotes', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Save quotes to file
   */
  saveData(): void {
    try {
      const dir = path.dirname(this.dataPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const saveData = {
        quotes: this.quotes,
        config: this.config,
        nextId: this.nextId,
        savedAt: new Date().toISOString(),
      };

      fs.writeFileSync(this.dataPath, JSON.stringify(saveData, null, 2));
      this.dirty = false;
      logger.debug('Saved quotes', { count: this.quotes.length });
    } catch (error) {
      logger.error('Failed to save quotes', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Save if there are pending changes
   */
  private saveIfDirty(): void {
    if (this.dirty) {
      this.saveData();
    }
  }

  /**
   * Add a new quote
   */
  addQuote(
    text: string,
    addedBy: string,
    options?: { game?: string; context?: string }
  ): { success: boolean; quote?: Quote; error?: string } {
    // Validate text
    const trimmedText = text.trim();

    if (trimmedText.length < this.config.minLength) {
      return {
        success: false,
        error: `Quote must be at least ${this.config.minLength} characters`,
      };
    }

    if (trimmedText.length > this.config.maxLength) {
      return {
        success: false,
        error: `Quote must be at most ${this.config.maxLength} characters`,
      };
    }

    // Check for duplicates
    if (!this.config.allowDuplicates) {
      const normalizedText = trimmedText.toLowerCase();
      const duplicate = this.quotes.find(
        (q) => q.text.toLowerCase() === normalizedText
      );
      if (duplicate) {
        return {
          success: false,
          error: `This quote already exists as #${duplicate.id}`,
        };
      }
    }

    // Check max quotes limit
    if (this.quotes.length >= this.config.maxQuotes) {
      return {
        success: false,
        error: `Maximum quote limit (${this.config.maxQuotes}) reached`,
      };
    }

    const quote: Quote = {
      id: this.nextId++,
      text: trimmedText,
      addedBy: addedBy.toLowerCase(),
      addedAt: new Date().toISOString(),
      game: options?.game,
      context: options?.context,
    };

    this.quotes.push(quote);
    this.dirty = true;

    logger.info('Quote added', { id: quote.id, addedBy });

    return { success: true, quote };
  }

  /**
   * Get a quote by ID
   */
  getQuote(id: number): Quote | null {
    return this.quotes.find((q) => q.id === id) || null;
  }

  /**
   * Get a random quote
   */
  getRandomQuote(): Quote | null {
    if (this.quotes.length === 0) {
      return null;
    }

    const index = Math.floor(Math.random() * this.quotes.length);
    return this.quotes[index];
  }

  /**
   * Search quotes by text
   */
  searchQuotes(query: string, limit: number = 10): Quote[] {
    const normalizedQuery = query.toLowerCase();

    return this.quotes
      .filter((q) => q.text.toLowerCase().includes(normalizedQuery))
      .slice(0, limit);
  }

  /**
   * Get quotes by user
   */
  getQuotesByUser(username: string, limit: number = 10): Quote[] {
    const normalizedUsername = username.toLowerCase();

    return this.quotes
      .filter((q) => q.addedBy === normalizedUsername)
      .slice(-limit);
  }

  /**
   * Get quotes by game
   */
  getQuotesByGame(game: string, limit: number = 10): Quote[] {
    const normalizedGame = game.toLowerCase();

    return this.quotes
      .filter((q) => q.game?.toLowerCase() === normalizedGame)
      .slice(-limit);
  }

  /**
   * Delete a quote by ID
   */
  deleteQuote(id: number): { success: boolean; error?: string } {
    const index = this.quotes.findIndex((q) => q.id === id);

    if (index === -1) {
      return { success: false, error: `Quote #${id} not found` };
    }

    this.quotes.splice(index, 1);
    this.dirty = true;

    logger.info('Quote deleted', { id });

    return { success: true };
  }

  /**
   * Edit a quote
   */
  editQuote(
    id: number,
    newText: string
  ): { success: boolean; quote?: Quote; error?: string } {
    const quote = this.getQuote(id);

    if (!quote) {
      return { success: false, error: `Quote #${id} not found` };
    }

    const trimmedText = newText.trim();

    if (trimmedText.length < this.config.minLength) {
      return {
        success: false,
        error: `Quote must be at least ${this.config.minLength} characters`,
      };
    }

    if (trimmedText.length > this.config.maxLength) {
      return {
        success: false,
        error: `Quote must be at most ${this.config.maxLength} characters`,
      };
    }

    quote.text = trimmedText;
    this.dirty = true;

    logger.info('Quote edited', { id });

    return { success: true, quote };
  }

  /**
   * Get total quote count
   */
  getQuoteCount(): number {
    return this.quotes.length;
  }

  /**
   * Get all quotes (paginated)
   */
  getAllQuotes(page: number = 1, pageSize: number = 20): {
    quotes: Quote[];
    totalPages: number;
    totalQuotes: number;
    currentPage: number;
  } {
    const totalQuotes = this.quotes.length;
    const totalPages = Math.ceil(totalQuotes / pageSize);
    const currentPage = Math.max(1, Math.min(page, totalPages || 1));

    const start = (currentPage - 1) * pageSize;
    const quotes = this.quotes.slice(start, start + pageSize);

    return { quotes, totalPages, totalQuotes, currentPage };
  }

  /**
   * Get recent quotes
   */
  getRecentQuotes(limit: number = 10): Quote[] {
    return this.quotes.slice(-limit).reverse();
  }

  /**
   * Format a quote for display
   */
  formatQuote(quote: Quote): string {
    const dateStr = new Date(quote.addedAt).toLocaleDateString();
    let formatted = `#${quote.id}: "${quote.text}"`;

    if (quote.game) {
      formatted += ` [${quote.game}]`;
    }

    formatted += ` - Added by ${quote.addedBy} on ${dateStr}`;

    return formatted;
  }

  /**
   * Format a quote for chat (shorter version)
   */
  formatQuoteShort(quote: Quote): string {
    return `#${quote.id}: "${quote.text}"`;
  }

  /**
   * Get configuration
   */
  getConfig(): QuotesConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<QuotesConfig>): void {
    this.config = { ...this.config, ...updates };
    this.dirty = true;
    logger.info('Quotes config updated', { updates: Object.keys(updates) });
  }

  /**
   * Export quotes to array
   */
  exportQuotes(): Quote[] {
    return [...this.quotes];
  }

  /**
   * Import quotes from array
   */
  importQuotes(quotes: Quote[], merge: boolean = true): {
    imported: number;
    skipped: number;
  } {
    let imported = 0;
    let skipped = 0;

    if (!merge) {
      this.quotes = [];
      this.nextId = 1;
    }

    for (const quote of quotes) {
      // Check for duplicates if not allowing them
      if (!this.config.allowDuplicates) {
        const normalizedText = quote.text.toLowerCase();
        const exists = this.quotes.some(
          (q) => q.text.toLowerCase() === normalizedText
        );
        if (exists) {
          skipped++;
          continue;
        }
      }

      const newQuote: Quote = {
        ...quote,
        id: this.nextId++,
      };

      this.quotes.push(newQuote);
      imported++;
    }

    this.dirty = true;
    logger.info('Quotes imported', { imported, skipped });

    return { imported, skipped };
  }

  /**
   * Clean up and stop auto-save
   */
  destroy(): void {
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
      this.saveInterval = null;
    }
    this.saveIfDirty();
  }
}

// Singleton instance
let defaultManager: QuotesManager | null = null;

export function getQuotesManager(): QuotesManager {
  if (!defaultManager) {
    defaultManager = new QuotesManager();
  }
  return defaultManager;
}

export function resetQuotesManager(): void {
  if (defaultManager) {
    defaultManager.destroy();
    defaultManager = null;
  }
}
