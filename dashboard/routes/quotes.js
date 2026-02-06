/**
 * Dashboard API Routes for Quotes System
 */

const express = require('express');
const path = require('path');
const fs = require('fs').promises;

module.exports = function(logsDir) {
  const router = express.Router();
  const quotesFile = path.join(logsDir, 'quotes.json');

  // Initialize file if needed
  const initFile = async () => {
    try {
      await fs.access(quotesFile);
    } catch {
      await fs.writeFile(quotesFile, JSON.stringify({
        quotes: [],
        config: {
          maxQuotes: 10000,
          minLength: 5,
          maxLength: 500,
          allowDuplicates: false
        },
        nextId: 1,
        savedAt: new Date().toISOString()
      }, null, 2));
    }
  };

  // Read quotes data
  const readData = async () => {
    await initFile();
    const content = await fs.readFile(quotesFile, 'utf-8');
    return JSON.parse(content);
  };

  // Write quotes data
  const writeData = async (data) => {
    data.savedAt = new Date().toISOString();
    await fs.writeFile(quotesFile, JSON.stringify(data, null, 2));
  };

  // GET /api/quotes - Get all quotes (paginated)
  router.get('/', async (req, res, next) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const pageSize = parseInt(req.query.pageSize) || 20;
      const search = req.query.search?.toLowerCase();

      const data = await readData();
      let quotes = data.quotes || [];

      // Apply search filter
      if (search) {
        quotes = quotes.filter(q =>
          q.text.toLowerCase().includes(search) ||
          q.addedBy.toLowerCase().includes(search) ||
          (q.game && q.game.toLowerCase().includes(search))
        );
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
        return res.status(404).json({ error: 'No quotes available' });
      }

      const randomIndex = Math.floor(Math.random() * quotes.length);
      res.json(quotes[randomIndex]);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/quotes/:id - Get quote by ID
  router.get('/:id', async (req, res, next) => {
    try {
      const id = parseInt(req.params.id);
      const data = await readData();
      const quote = (data.quotes || []).find(q => q.id === id);

      if (!quote) {
        return res.status(404).json({ error: 'Quote not found' });
      }

      res.json(quote);
    } catch (error) {
      next(error);
    }
  });

  // POST /api/quotes - Add a new quote
  router.post('/', async (req, res, next) => {
    try {
      const { text, addedBy, game, context } = req.body;

      if (!text || !addedBy) {
        return res.status(400).json({ error: 'Text and addedBy are required' });
      }

      const data = await readData();
      const config = data.config || {};

      // Validate text length
      const trimmedText = text.trim();
      if (trimmedText.length < (config.minLength || 5)) {
        return res.status(400).json({
          error: `Quote must be at least ${config.minLength || 5} characters`
        });
      }
      if (trimmedText.length > (config.maxLength || 500)) {
        return res.status(400).json({
          error: `Quote must be at most ${config.maxLength || 500} characters`
        });
      }

      // Check for duplicates
      if (!config.allowDuplicates) {
        const normalizedText = trimmedText.toLowerCase();
        const duplicate = (data.quotes || []).find(
          q => q.text.toLowerCase() === normalizedText
        );
        if (duplicate) {
          return res.status(400).json({
            error: `This quote already exists as #${duplicate.id}`
          });
        }
      }

      // Check max quotes limit
      if ((data.quotes || []).length >= (config.maxQuotes || 10000)) {
        return res.status(400).json({ error: 'Maximum quote limit reached' });
      }

      const quote = {
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
      res.status(201).json({ success: true, quote });
    } catch (error) {
      next(error);
    }
  });

  // PUT /api/quotes/:id - Edit a quote
  router.put('/:id', async (req, res, next) => {
    try {
      const id = parseInt(req.params.id);
      const { text, game, context } = req.body;

      const data = await readData();
      const quoteIndex = (data.quotes || []).findIndex(q => q.id === id);

      if (quoteIndex === -1) {
        return res.status(404).json({ error: 'Quote not found' });
      }

      if (text) {
        const config = data.config || {};
        const trimmedText = text.trim();

        if (trimmedText.length < (config.minLength || 5)) {
          return res.status(400).json({
            error: `Quote must be at least ${config.minLength || 5} characters`
          });
        }
        if (trimmedText.length > (config.maxLength || 500)) {
          return res.status(400).json({
            error: `Quote must be at most ${config.maxLength || 500} characters`
          });
        }

        data.quotes[quoteIndex].text = trimmedText;
      }

      if (game !== undefined) {
        data.quotes[quoteIndex].game = game || undefined;
      }
      if (context !== undefined) {
        data.quotes[quoteIndex].context = context || undefined;
      }

      await writeData(data);
      res.json({ success: true, quote: data.quotes[quoteIndex] });
    } catch (error) {
      next(error);
    }
  });

  // DELETE /api/quotes/:id - Delete a quote
  router.delete('/:id', async (req, res, next) => {
    try {
      const id = parseInt(req.params.id);
      const data = await readData();
      const quoteIndex = (data.quotes || []).findIndex(q => q.id === id);

      if (quoteIndex === -1) {
        return res.status(404).json({ error: 'Quote not found' });
      }

      data.quotes.splice(quoteIndex, 1);
      await writeData(data);

      res.json({ success: true });
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

  // PUT /api/quotes/config - Update quotes config
  router.put('/config', async (req, res, next) => {
    try {
      const data = await readData();
      data.config = { ...data.config, ...req.body };
      await writeData(data);
      res.json({ success: true, config: data.config });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/quotes/import - Import quotes
  router.post('/import', async (req, res, next) => {
    try {
      const { quotes, merge = true } = req.body;

      if (!Array.isArray(quotes)) {
        return res.status(400).json({ error: 'Quotes must be an array' });
      }

      const data = await readData();
      let imported = 0;
      let skipped = 0;

      if (!merge) {
        data.quotes = [];
        data.nextId = 1;
      }

      for (const quote of quotes) {
        if (!quote.text) {
          skipped++;
          continue;
        }

        // Check for duplicates
        if (!data.config?.allowDuplicates) {
          const normalizedText = quote.text.toLowerCase();
          const exists = (data.quotes || []).some(
            q => q.text.toLowerCase() === normalizedText
          );
          if (exists) {
            skipped++;
            continue;
          }
        }

        data.quotes.push({
          ...quote,
          id: data.nextId++
        });
        imported++;
      }

      await writeData(data);
      res.json({ success: true, imported, skipped });
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

  return router;
};
