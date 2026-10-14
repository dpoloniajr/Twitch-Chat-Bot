/**
 * Dashboard API Routes for Quotes System
 */

import { Router } from 'express';
import * as path from 'path';
import { createJsonStore } from '../lib/utils';
import type { Quote, QuotesConfig } from '../../services/quotes';
import type { BroadcastMessage } from '../lib/types';

/** Shape of quotes.json (shared with the bot; any field may be missing) */
export interface QuotesData {
  quotes?: Quote[];
  config?: Partial<QuotesConfig>;
  nextId?: number;
  savedAt?: string;
  [key: string]: unknown;
}

/**
 * Create the /api/quotes router, storing quotes in `<logsDir>/quotes.json`.
 * After every successful write, `broadcast` (if given) receives a 'quote-update' message.
 */
// GET /config, GET /export and PUT /config are registered before the /:id routes,
// which would otherwise treat "config" and "export" as quote ids.
export function createQuotesRouter(logsDir: string, broadcast?: (message: BroadcastMessage) => void): Router {
  const router = Router();
  const quotesFile = path.join(logsDir, 'quotes.json');

  // Tell the dashboard and overlays about a quote write. data is the added or edited
  // quote (same JSON as GET /random); deletes, imports and config changes carry no `text`.
  const publish = (data: unknown): void => {
    broadcast?.({ type: 'quote-update', data });
  };

  // Quotes data, created empty on first read
  const { read: readData, write: writeData, locked } = createJsonStore<QuotesData>(quotesFile, () => ({
    quotes: [],
    config: {
      maxQuotes: 10000,
      minLength: 5,
      maxLength: 500,
      allowDuplicates: false
    },
    nextId: 1
  }));

  // GET /api/quotes - Get all quotes (paginated)
  router.get('/', async (req, res, next) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const pageSize = parseInt(req.query.pageSize as string) || 20;
      const search = (req.query.search as string | undefined)?.toLowerCase();

      const data = await readData();
      let quotes = data.quotes || [];

      // Apply search filter
      if (search) {
        // Imported or hand-edited quotes may lack fields, so every one is optional here
        const matches = (field: unknown): boolean => typeof field === 'string' && field.toLowerCase().includes(search);
        quotes = quotes.filter(q => matches(q.text) || matches(q.addedBy) || matches(q.game));
      }

      const totalQuotes = quotes.length;
      const totalPages = Math.ceil(totalQuotes / pageSize);
      const currentPage = Math.max(1, Math.min(page, totalPages || 1));

      const start = (currentPage - 1) * pageSize;
      const paginatedQuotes = quotes.slice(start, start + pageSize);

      res.json({
        quotes: paginatedQuotes,
        totalQuotes,
        totalPages,
        currentPage,
        pageSize
      });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/quotes/random - Get a random quote
  router.get('/random', async (req, res, next) => {
    try {
      const data = await readData();
      const quotes = data.quotes || [];

      if (quotes.length === 0) {
        res.status(404).json({ error: 'No quotes available' });
        return;
      }

      const randomIndex = Math.floor(Math.random() * quotes.length);
      res.json(quotes[randomIndex]);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/quotes/config - Get quotes config
  router.get('/config', async (req, res, next) => {
    try {
      const data = await readData();
      res.json(data.config || {});
    } catch (error) {
      next(error);
    }
  });

  // GET /api/quotes/export - Export all quotes
  router.get('/export', async (req, res, next) => {
    try {
      const data = await readData();
      res.json({
        quotes: data.quotes || [],
        exportedAt: new Date().toISOString()
      });
    } catch (error) {
      next(error);
    }
  });

  // PUT /api/quotes/config - Update quotes config
  router.put('/config', locked(async (req, res, next) => {
    try {
      const data = await readData();
      data.config = { ...data.config, ...req.body };
      await writeData(data);
      publish({ config: data.config });
      res.json({ success: true, config: data.config });
    } catch (error) {
      next(error);
    }
  }));

  // GET /api/quotes/:id - Get quote by ID
  router.get('/:id', async (req, res, next) => {
    try {
      const id = parseInt(req.params.id as string);
      const data = await readData();
      const quote = (data.quotes || []).find(q => q.id === id);

      if (!quote) {
        res.status(404).json({ error: 'Quote not found' });
        return;
      }

      res.json(quote);
    } catch (error) {
      next(error);
    }
  });

  // POST /api/quotes - Add a new quote
  router.post('/', locked(async (req, res, next) => {
    try {
      const { text, addedBy, game, context } = req.body;

      if (!text || !addedBy) {
        res.status(400).json({ error: 'Text and addedBy are required' });
        return;
      }

      const data = await readData();
      const config = data.config || {};

      // Validate text length
      const trimmedText = (text as string).trim();
      if (trimmedText.length < (config.minLength || 5)) {
        res.status(400).json({
          error: `Quote must be at least ${config.minLength || 5} characters`
        });
        return;
      }
      if (trimmedText.length > (config.maxLength || 500)) {
        res.status(400).json({
          error: `Quote must be at most ${config.maxLength || 500} characters`
        });
        return;
      }

      // Check for duplicates
      if (!config.allowDuplicates) {
        const normalizedText = trimmedText.toLowerCase();
        const duplicate = (data.quotes || []).find(
          q => q.text.toLowerCase() === normalizedText
        );
        if (duplicate) {
          res.status(400).json({
            error: `This quote already exists as #${duplicate.id}`
          });
          return;
        }
      }

      // Check max quotes limit
      if ((data.quotes || []).length >= (config.maxQuotes || 10000)) {
        res.status(400).json({ error: 'Maximum quote limit reached' });
        return;
      }

      const quote: Quote = {
        id: data.nextId || 1,
        text: trimmedText,
        addedBy: addedBy.toLowerCase(),
        addedAt: new Date().toISOString(),
        game: game || undefined,
        context: context || undefined
      };

      if (!data.quotes) data.quotes = [];
      data.quotes.push(quote);
      data.nextId = (data.nextId || 1) + 1;

      await writeData(data);
      publish(quote);
      res.status(201).json({ success: true, quote });
    } catch (error) {
      next(error);
    }
  }));

  // PUT /api/quotes/:id - Edit a quote (same length and duplicate checks as POST)
  router.put('/:id', locked(async (req, res, next) => {
    try {
      const id = parseInt(req.params.id as string);
      const { text, game, context } = req.body;

      const data = await readData();
      const quoteIndex = (data.quotes || []).findIndex(q => q.id === id);

      if (quoteIndex === -1) {
        res.status(404).json({ error: 'Quote not found' });
        return;
      }
      const quotes = data.quotes!;

      if (text) {
        const config = data.config || {};
        const trimmedText = (text as string).trim();

        if (trimmedText.length < (config.minLength || 5)) {
          res.status(400).json({
            error: `Quote must be at least ${config.minLength || 5} characters`
          });
          return;
        }
        if (trimmedText.length > (config.maxLength || 500)) {
          res.status(400).json({
            error: `Quote must be at most ${config.maxLength || 500} characters`
          });
          return;
        }

        if (!config.allowDuplicates) {
          const normalizedText = trimmedText.toLowerCase();
          const duplicate = quotes.find(q => q.id !== id && typeof q.text === 'string' && q.text.toLowerCase() === normalizedText);
          if (duplicate) {
            res.status(400).json({ error: `This quote already exists as #${duplicate.id}` });
            return;
          }
        }

        quotes[quoteIndex].text = trimmedText;
      }

      if (game !== undefined) {
        quotes[quoteIndex].game = game || undefined;
      }
      if (context !== undefined) {
        quotes[quoteIndex].context = context || undefined;
      }

      await writeData(data);
      publish(quotes[quoteIndex]);
      res.json({ success: true, quote: quotes[quoteIndex] });
    } catch (error) {
      next(error);
    }
  }));

  // DELETE /api/quotes/:id - Delete a quote
  router.delete('/:id', locked(async (req, res, next) => {
    try {
      const id = parseInt(req.params.id as string);
      const data = await readData();
      const quoteIndex = (data.quotes || []).findIndex(q => q.id === id);

      if (quoteIndex === -1) {
        res.status(404).json({ error: 'Quote not found' });
        return;
      }

      data.quotes!.splice(quoteIndex, 1);
      await writeData(data);
      publish({ id, deleted: true });

      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }));

  // POST /api/quotes/import - Import quotes. Each one gets the POST rules (trimmed text
  // within the configured length, no duplicates unless allowed) and keeps only the quote
  // fields; invalid entries are counted as skipped.
  router.post('/import', locked(async (req, res, next) => {
    try {
      const { quotes, merge = true } = req.body;

      if (!Array.isArray(quotes)) {
        res.status(400).json({ error: 'Quotes must be an array' });
        return;
      }

      const data = await readData();
      let imported = 0;
      let skipped = 0;

      if (!merge) {
        data.quotes = [];
        data.nextId = 1;
      }
      // A hand-edited quotes.json may lack either field
      if (!data.quotes) data.quotes = [];
      if (!Number.isInteger(data.nextId)) data.nextId = Math.max(0, ...data.quotes.map(q => Number(q.id) || 0)) + 1;

      const config = data.config || {};
      const minLength = config.minLength || 5;
      const maxLength = config.maxLength || 500;
      const optionalText = (value: unknown): string | undefined =>
        typeof value === 'string' && value.trim() ? value.trim() : undefined;

      for (const quote of quotes as Array<Partial<Quote> | null>) {
        const text = typeof quote?.text === 'string' ? quote.text.trim() : '';
        if (!quote || text.length < minLength || text.length > maxLength) {
          skipped++;
          continue;
        }

        // Check for duplicates
        if (!config.allowDuplicates) {
          const normalizedText = text.toLowerCase();
          const exists = data.quotes!.some(
            q => typeof q.text === 'string' && q.text.toLowerCase() === normalizedText
          );
          if (exists) {
            skipped++;
            continue;
          }
        }

        data.quotes!.push({
          id: data.nextId!++,
          text,
          addedBy: (optionalText(quote.addedBy) || 'unknown').toLowerCase(),
          addedAt: typeof quote.addedAt === 'string' && !Number.isNaN(Date.parse(quote.addedAt)) ? quote.addedAt : new Date().toISOString(),
          game: optionalText(quote.game),
          context: optionalText(quote.context)
        });
        imported++;
      }

      await writeData(data);
      publish({ imported, skipped });
      res.json({ success: true, imported, skipped });
    } catch (error) {
      next(error);
    }
  }));

  return router;
}
