/**
 * Quotes Commands Module
 * Chat commands for the quotes system
 */

import { CommandHandler, CommandContext } from '../types';
import { QuotesManager, getQuotesManager } from '../services/quotes';
import { createLogger } from '../utils/logger';

const logger = createLogger('QuotesCommands');

/**
 * Factory function to create quotes commands
 */
export function createQuotesCommands(
  quotesManager?: QuotesManager
): Map<string, CommandHandler> {
  const manager = quotesManager || getQuotesManager();
  const commands = new Map<string, CommandHandler>();

  // !quote - Get a random quote or specific quote by ID
  commands.set('!quote', {
    perm: 'everyone',
    handler: async (ctx: CommandContext): Promise<void> => {
      const { channel, username, args } = ctx;
      const arg = args[0];

      let quote;

      if (arg) {
        // Check if it's a number (quote ID)
        const quoteId = parseInt(arg, 10);
        if (!isNaN(quoteId)) {
          quote = manager.getQuote(quoteId);
          if (!quote) {
            // Quote not found - response would go here
            return;
          }
        } else {
          // Search by keyword
          const searchResults = manager.searchQuotes(arg, 1);
          if (searchResults.length === 0) {
            // No quotes found - response would go here
            return;
          }
          quote = searchResults[0];
        }
      } else {
        // Get random quote
        quote = manager.getRandomQuote();
        if (!quote) {
          // No quotes yet - response would go here
          return;
        }
      }

      // Quote found - response would include quote text, author, date, etc.
    },
  });

  // !addquote - Add a new quote
  commands.set('!addquote', {
    perm: 'mod',
    handler: async (ctx: CommandContext): Promise<void> => {
      const { channel, username, args } = ctx;

      if (args.length === 0) {
        return;
      }

      const fullText = args.join(' ');

      // Parse author if provided with |
      let text = fullText;
      let author: string | undefined;

      if (fullText.includes('|')) {
        const parts = fullText.split('|');
        text = parts[0].trim();
        author = parts[1]?.trim();
      }

      if (!text) {
        return;
      }

      const result = manager.addQuote(text, username);

      if (result.success && result.quote) {
        logger.info('Quote added', { id: result.quote.id, addedBy: username });
      }
    },
  });

  // !editquote - Edit an existing quote
  commands.set('!editquote', {
    perm: 'mod',
    handler: async (ctx: CommandContext): Promise<void> => {
      const { channel, username, args } = ctx;

      if (args.length < 2) {
        return;
      }

      const quoteId = parseInt(args[0], 10);
      if (isNaN(quoteId)) {
        return;
      }

      const newText = args.slice(1).join(' ');
      if (!newText) {
        return;
      }

      const result = manager.editQuote(quoteId, newText);
      if (result.success) {
        logger.info('Quote edited', { id: quoteId, editedBy: username });
      }
    },
  });

  // !delquote - Delete a quote
  commands.set('!delquote', {
    perm: 'mod',
    handler: async (ctx: CommandContext): Promise<void> => {
      const { channel, username, args } = ctx;

      if (args.length === 0) {
        return;
      }

      const quoteId = parseInt(args[0], 10);
      if (isNaN(quoteId)) {
        return;
      }

      const result = manager.deleteQuote(quoteId);
      if (result.success) {
        logger.info('Quote deleted', { id: quoteId, deletedBy: username });
      }
    },
  });

  // !searchquotes - Search for quotes
  commands.set('!searchquotes', {
    perm: 'everyone',
    handler: async (ctx: CommandContext): Promise<void> => {
      const { channel, username, args } = ctx;

      if (args.length === 0) {
        return;
      }

      const query = args.join(' ');
      const results = manager.searchQuotes(query, 3);

      // Response would show quote IDs found
    },
  });

  // !quotecount - Get the total number of quotes
  commands.set('!quotecount', {
    perm: 'everyone',
    handler: async (ctx: CommandContext): Promise<void> => {
      const count = manager.getQuoteCount();
      // Response would show count
    },
  });

  // !lastquote - Get the most recently added quote
  commands.set('!lastquote', {
    perm: 'everyone',
    handler: async (ctx: CommandContext): Promise<void> => {
      // Get all quotes sorted by date and get the last one
      const allQuotes = manager.searchQuotes('', 1);
      if (allQuotes.length === 0) {
        return;
      }
      // Response would show the last quote
    },
  });

  return commands;
}

/**
 * Register all quotes commands with a registry
 */
export function registerQuotesCommands(
  registry: { register: (name: string, handler: CommandHandler, aliases?: string[]) => void },
  quotesManager?: QuotesManager
): void {
  const commands = createQuotesCommands(quotesManager);

  // Register with aliases
  for (const [name, handler] of commands) {
    const aliases: string[] = [];

    switch (name) {
      case '!quote':
        aliases.push('!q');
        break;
      case '!addquote':
        aliases.push('!aq', '!newquote');
        break;
      case '!delquote':
        aliases.push('!dq', '!removequote', '!rmquote');
        break;
      case '!editquote':
        aliases.push('!eq', '!modquote');
        break;
      case '!searchquotes':
        aliases.push('!sq', '!findquote');
        break;
      case '!quotecount':
        aliases.push('!qc', '!numquotes');
        break;
    }

    registry.register(name, handler, aliases);
  }

  logger.info('Registered quotes commands', { count: commands.size });
}
