/**
 * Tests for Quotes System
 */

import { QuotesManager, resetQuotesManager } from '../../src/services/quotes';
import * as fs from 'fs';
import * as path from 'path';

describe('QuotesManager', () => {
  let manager: QuotesManager;
  const testDataPath = path.join(__dirname, 'test-quotes.json');

  beforeEach(() => {
    resetQuotesManager();
    manager = new QuotesManager({
      dataPath: testDataPath,
      autoSaveIntervalMs: 0,
    });
  });

  afterEach(() => {
    manager.destroy();
    if (fs.existsSync(testDataPath)) {
      fs.unlinkSync(testDataPath);
    }
  });

  describe('adding quotes', () => {
    it('should add a new quote', () => {
      const result = manager.addQuote('This is a test quote', 'user1');

      expect(result.success).toBe(true);
      expect(result.quote).toBeDefined();
      expect(result.quote?.text).toBe('This is a test quote');
      expect(result.quote?.addedBy).toBe('user1');
      expect(result.quote?.id).toBe(1);
    });

    it('should assign sequential IDs', () => {
      manager.addQuote('Quote 1', 'user1');
      manager.addQuote('Quote 2', 'user1');
      const result = manager.addQuote('Quote 3', 'user1');

      expect(result.quote?.id).toBe(3);
    });

    it('should reject quotes that are too short', () => {
      manager.updateConfig({ minLength: 10 });

      const result = manager.addQuote('Hi', 'user1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('at least');
    });

    it('should reject quotes that are too long', () => {
      manager.updateConfig({ maxLength: 20 });

      const result = manager.addQuote('This is a very long quote that exceeds the limit', 'user1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('at most');
    });

    it('should reject duplicate quotes by default', () => {
      manager.addQuote('Duplicate quote', 'user1');

      const result = manager.addQuote('duplicate quote', 'user2'); // case insensitive

      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });

    it('should allow duplicates when configured', () => {
      manager.updateConfig({ allowDuplicates: true });

      manager.addQuote('Same quote', 'user1');
      const result = manager.addQuote('Same quote', 'user2');

      expect(result.success).toBe(true);
    });

    it('should include game and context', () => {
      const result = manager.addQuote('Gaming quote', 'user1', {
        game: 'Minecraft',
        context: 'During boss fight',
      });

      expect(result.quote?.game).toBe('Minecraft');
      expect(result.quote?.context).toBe('During boss fight');
    });
  });

  describe('getting quotes', () => {
    beforeEach(() => {
      manager.addQuote('Quote one', 'user1');
      manager.addQuote('Quote two', 'user2');
      manager.addQuote('Quote three', 'user1');
    });

    it('should get quote by ID', () => {
      const quote = manager.getQuote(2);

      expect(quote).not.toBeNull();
      expect(quote?.text).toBe('Quote two');
    });

    it('should return null for non-existent ID', () => {
      const quote = manager.getQuote(999);

      expect(quote).toBeNull();
    });

    it('should get a random quote', () => {
      const quote = manager.getRandomQuote();

      expect(quote).not.toBeNull();
      expect(['Quote one', 'Quote two', 'Quote three']).toContain(quote?.text);
    });

    it('should return null when no quotes exist', () => {
      const emptyManager = new QuotesManager({
        dataPath: path.join(__dirname, 'empty-quotes.json'),
        autoSaveIntervalMs: 0,
      });

      const quote = emptyManager.getRandomQuote();

      expect(quote).toBeNull();

      emptyManager.destroy();
    });
  });

  describe('searching quotes', () => {
    beforeEach(() => {
      manager.addQuote('I love programming', 'user1');
      manager.addQuote('Programming is fun', 'user2');
      manager.addQuote('Games are great', 'user1');
    });

    it('should search quotes by text', () => {
      const results = manager.searchQuotes('programming');

      expect(results.length).toBe(2);
    });

    it('should be case insensitive', () => {
      const results = manager.searchQuotes('PROGRAMMING');

      expect(results.length).toBe(2);
    });

    it('should limit results', () => {
      const results = manager.searchQuotes('e', 1);

      expect(results.length).toBe(1);
    });
  });

  describe('filtering quotes', () => {
    beforeEach(() => {
      manager.addQuote('User1 quote 1', 'user1', { game: 'Game A' });
      manager.addQuote('User1 quote 2', 'user1', { game: 'Game B' });
      manager.addQuote('User2 quote 1', 'user2', { game: 'Game A' });
    });

    it('should get quotes by user', () => {
      const results = manager.getQuotesByUser('user1');

      expect(results.length).toBe(2);
      expect(results.every((q) => q.addedBy === 'user1')).toBe(true);
    });

    it('should get quotes by game', () => {
      const results = manager.getQuotesByGame('Game A');

      expect(results.length).toBe(2);
    });
  });

  describe('deleting quotes', () => {
    it('should delete a quote by ID', () => {
      manager.addQuote('To be deleted', 'user1');

      const result = manager.deleteQuote(1);

      expect(result.success).toBe(true);
      expect(manager.getQuote(1)).toBeNull();
      expect(manager.getQuoteCount()).toBe(0);
    });

    it('should return error for non-existent quote', () => {
      const result = manager.deleteQuote(999);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('editing quotes', () => {
    it('should edit a quote', () => {
      manager.addQuote('Original text', 'user1');

      const result = manager.editQuote(1, 'Updated text');

      expect(result.success).toBe(true);
      expect(result.quote?.text).toBe('Updated text');
      expect(manager.getQuote(1)?.text).toBe('Updated text');
    });

    it('should reject invalid edit', () => {
      manager.updateConfig({ minLength: 10 });
      manager.addQuote('Original long text', 'user1');

      const result = manager.editQuote(1, 'Short');

      expect(result.success).toBe(false);
    });
  });

  describe('pagination', () => {
    beforeEach(() => {
      for (let i = 1; i <= 25; i++) {
        manager.addQuote(`Quote number ${i}`, 'user1');
      }
    });

    it('should paginate quotes', () => {
      const page1 = manager.getAllQuotes(1, 10);

      expect(page1.quotes.length).toBe(10);
      expect(page1.totalQuotes).toBe(25);
      expect(page1.totalPages).toBe(3);
      expect(page1.currentPage).toBe(1);
    });

    it('should return correct page', () => {
      const page2 = manager.getAllQuotes(2, 10);

      expect(page2.currentPage).toBe(2);
      expect(page2.quotes[0].text).toBe('Quote number 11');
    });

    it('should handle page overflow', () => {
      const page = manager.getAllQuotes(100, 10);

      expect(page.currentPage).toBe(3); // Last valid page
    });
  });

  describe('formatting', () => {
    it('should format quote for display', () => {
      manager.addQuote('Test quote', 'user1', { game: 'TestGame' });

      const formatted = manager.formatQuote(manager.getQuote(1)!);

      expect(formatted).toContain('#1');
      expect(formatted).toContain('Test quote');
      expect(formatted).toContain('TestGame');
      expect(formatted).toContain('user1');
    });

    it('should format quote short version', () => {
      manager.addQuote('Test quote', 'user1');

      const formatted = manager.formatQuoteShort(manager.getQuote(1)!);

      expect(formatted).toBe('#1: "Test quote"');
    });
  });

  describe('import/export', () => {
    it('should export quotes', () => {
      manager.addQuote('Quote 1', 'user1');
      manager.addQuote('Quote 2', 'user2');

      const exported = manager.exportQuotes();

      expect(exported.length).toBe(2);
    });

    it('should import quotes with merge', () => {
      manager.addQuote('Existing', 'user1');

      const result = manager.importQuotes([
        { id: 100, text: 'Imported 1', addedBy: 'import', addedAt: new Date().toISOString() },
        { id: 101, text: 'Imported 2', addedBy: 'import', addedAt: new Date().toISOString() },
      ]);

      expect(result.imported).toBe(2);
      expect(manager.getQuoteCount()).toBe(3);
    });

    it('should skip duplicate imports', () => {
      manager.addQuote('Same text', 'user1');

      const result = manager.importQuotes([
        { id: 100, text: 'Same text', addedBy: 'import', addedAt: new Date().toISOString() },
      ]);

      expect(result.imported).toBe(0);
      expect(result.skipped).toBe(1);
    });
  });

  describe('recent quotes', () => {
    it('should get recent quotes in reverse order', () => {
      manager.addQuote('First', 'user1');
      manager.addQuote('Second', 'user1');
      manager.addQuote('Third', 'user1');

      const recent = manager.getRecentQuotes(2);

      expect(recent.length).toBe(2);
      expect(recent[0].text).toBe('Third');
      expect(recent[1].text).toBe('Second');
    });
  });
});
