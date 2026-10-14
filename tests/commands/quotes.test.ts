/**
 * Tests for Quotes Commands
 */

import { createQuotesCommands, registerQuotesCommands } from '../../src/commands/quotes';
import { QuotesManager } from '../../src/services/quotes';
import { CommandContext } from '../../src/types';

// Mock the quotes manager
jest.mock('../../src/services/quotes', () => ({
  getQuotesManager: jest.fn(),
  QuotesManager: jest.fn(),
}));

describe('Quotes Commands', () => {
  let mockManager: {
    getQuote: jest.Mock;
    getRandomQuote: jest.Mock;
    searchQuotes: jest.Mock;
    addQuote: jest.Mock;
    editQuote: jest.Mock;
    deleteQuote: jest.Mock;
    getQuoteCount: jest.Mock;
  };
  let commands: Map<string, any>;

  const createMockContext = (user: string, args: string[] = []): CommandContext => ({
    channel: '#testchannel',
    username: user,
    displayName: user,
    raw: `!command ${args.join(' ')}`,
    args,
    msg: {
      userInfo: {
        isMod: true,
        isBroadcaster: false,
        userName: user,
        displayName: user,
        isSubscriber: false,
        isVip: false,
      },
    } as any,
  });

  const run = (name: string, args: string[] = []) =>
    commands.get(name).handler(createMockContext('moduser', args));

  beforeEach(() => {
    mockManager = {
      getQuote: jest.fn(),
      getRandomQuote: jest.fn(),
      searchQuotes: jest.fn().mockReturnValue([]),
      addQuote: jest.fn().mockReturnValue({ success: false }),
      editQuote: jest.fn().mockReturnValue({ success: false }),
      deleteQuote: jest.fn().mockReturnValue({ success: false }),
      getQuoteCount: jest.fn().mockReturnValue(0),
    };

    commands = createQuotesCommands(mockManager as unknown as QuotesManager);
  });

  describe('!quote command', () => {
    it('should get a random quote without arguments', async () => {
      mockManager.getRandomQuote.mockReturnValue({ id: 1, text: 'hi' });
      await run('!quote');
      expect(mockManager.getRandomQuote).toHaveBeenCalled();
      expect(mockManager.getQuote).not.toHaveBeenCalled();
    });

    it('should handle no quotes existing', async () => {
      mockManager.getRandomQuote.mockReturnValue(null);
      await expect(run('!quote')).resolves.toBeUndefined();
    });

    it('should look up a quote by numeric ID', async () => {
      mockManager.getQuote.mockReturnValue({ id: 5, text: 'hi' });
      await run('!quote', ['5']);
      expect(mockManager.getQuote).toHaveBeenCalledWith(5);
    });

    it('should handle a missing quote ID', async () => {
      mockManager.getQuote.mockReturnValue(null);
      await run('!quote', ['99']);
      expect(mockManager.getQuote).toHaveBeenCalledWith(99);
    });

    it('should search by keyword for non-numeric argument', async () => {
      mockManager.searchQuotes.mockReturnValue([{ id: 2, text: 'funny' }]);
      await run('!quote', ['funny']);
      expect(mockManager.searchQuotes).toHaveBeenCalledWith('funny', 1);
    });

    it('should handle keyword search with no results', async () => {
      await run('!quote', ['nothing']);
      expect(mockManager.searchQuotes).toHaveBeenCalledWith('nothing', 1);
    });
  });

  describe('!addquote command', () => {
    it('should have mod permission', () => {
      expect(commands.get('!addquote').perm).toBe('mod');
    });

    it('should do nothing without arguments', async () => {
      await run('!addquote');
      expect(mockManager.addQuote).not.toHaveBeenCalled();
    });

    it('should add a quote', async () => {
      mockManager.addQuote.mockReturnValue({ success: true, quote: { id: 1 } });
      await run('!addquote', ['hello', 'world']);
      expect(mockManager.addQuote).toHaveBeenCalledWith('hello world', 'moduser');
    });

    it('should strip the author part after |', async () => {
      await run('!addquote', ['hello', '|', 'someone']);
      expect(mockManager.addQuote).toHaveBeenCalledWith('hello', 'moduser');
    });

    it('should do nothing when text before | is empty', async () => {
      await run('!addquote', ['|', 'someone']);
      expect(mockManager.addQuote).not.toHaveBeenCalled();
    });
  });

  describe('!editquote command', () => {
    it('should do nothing with fewer than 2 arguments', async () => {
      await run('!editquote', ['1']);
      expect(mockManager.editQuote).not.toHaveBeenCalled();
    });

    it('should do nothing with non-numeric ID', async () => {
      await run('!editquote', ['abc', 'text']);
      expect(mockManager.editQuote).not.toHaveBeenCalled();
    });

    it('should edit a quote', async () => {
      mockManager.editQuote.mockReturnValue({ success: true });
      await run('!editquote', ['3', 'new', 'text']);
      expect(mockManager.editQuote).toHaveBeenCalledWith(3, 'new text');
    });

    it('should do nothing when new text is empty', async () => {
      await run('!editquote', ['3', '']);
      expect(mockManager.editQuote).not.toHaveBeenCalled();
    });
  });

  describe('!delquote command', () => {
    it('should do nothing without arguments', async () => {
      await run('!delquote');
      expect(mockManager.deleteQuote).not.toHaveBeenCalled();
    });

    it('should do nothing with non-numeric ID', async () => {
      await run('!delquote', ['abc']);
      expect(mockManager.deleteQuote).not.toHaveBeenCalled();
    });

    it('should delete a quote', async () => {
      mockManager.deleteQuote.mockReturnValue({ success: true });
      await run('!delquote', ['4']);
      expect(mockManager.deleteQuote).toHaveBeenCalledWith(4);
    });

    it('should handle a failed delete', async () => {
      await run('!delquote', ['4']);
      expect(mockManager.deleteQuote).toHaveBeenCalledWith(4);
    });
  });

  describe('!searchquotes command', () => {
    it('should do nothing without arguments', async () => {
      await run('!searchquotes');
      expect(mockManager.searchQuotes).not.toHaveBeenCalled();
    });

    it('should search with up to 3 results', async () => {
      await run('!searchquotes', ['some', 'words']);
      expect(mockManager.searchQuotes).toHaveBeenCalledWith('some words', 3);
    });
  });

  describe('!quotecount and !lastquote commands', () => {
    it('should get the quote count', async () => {
      await run('!quotecount');
      expect(mockManager.getQuoteCount).toHaveBeenCalled();
    });

    it('should look up the last quote', async () => {
      mockManager.searchQuotes.mockReturnValue([{ id: 1 }]);
      await run('!lastquote');
      expect(mockManager.searchQuotes).toHaveBeenCalledWith('', 1);
    });

    it('should handle no quotes for !lastquote', async () => {
      await expect(run('!lastquote')).resolves.toBeUndefined();
    });
  });

  describe('registerQuotesCommands', () => {
    it('should register all commands with aliases', () => {
      const registry = { register: jest.fn() };
      registerQuotesCommands(registry, mockManager as unknown as QuotesManager);

      expect(registry.register).toHaveBeenCalledTimes(7);
      expect(registry.register).toHaveBeenCalledWith('!quote', expect.any(Object), ['!q']);
      expect(registry.register).toHaveBeenCalledWith('!delquote', expect.any(Object), [
        '!dq',
        '!removequote',
        '!rmquote',
      ]);
      expect(registry.register).toHaveBeenCalledWith('!lastquote', expect.any(Object), []);
    });
  });
});
