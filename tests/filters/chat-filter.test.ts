/**
 * Tests for Chat Filter Module
 */

import { ChatFilterManager, resetFilterManager } from '../../src/filters/chat-filter';

describe('ChatFilterManager', () => {
  let filterManager: ChatFilterManager;

  beforeEach(() => {
    resetFilterManager();
    filterManager = new ChatFilterManager();
  });

  describe('blacklist filtering', () => {
    it('should detect blacklisted words', () => {
      filterManager.addWord('badword');

      const violations = filterManager.checkMessage('This contains badword here', 'user1');

      expect(violations).toContain('blacklist_word');
    });

    it('should be case insensitive', () => {
      filterManager.addWord('badword');

      const violations = filterManager.checkMessage('This contains BADWORD here', 'user1');

      expect(violations).toContain('blacklist_word');
    });

    it('should not flag messages without blacklisted words', () => {
      filterManager.addWord('badword');

      const violations = filterManager.checkMessage('This is a clean message', 'user1');

      expect(violations).not.toContain('blacklist_word');
    });

    it('should handle word removal', () => {
      filterManager.addWord('badword');
      filterManager.removeWord('badword');

      const violations = filterManager.checkMessage('This contains badword', 'user1');

      expect(violations).not.toContain('blacklist_word');
    });

    it('should ignore punctuation around words', () => {
      filterManager.addWord('badword');

      const violations = filterManager.checkMessage('Look at this: badword!', 'user1');

      expect(violations).toContain('blacklist_word');
    });
  });

  describe('URL filtering', () => {
    beforeEach(() => {
      filterManager.updateConfig({ filterUrls: true });
    });

    it('should detect http URLs', () => {
      const violations = filterManager.checkMessage('Check out http://example.com', 'user1');

      expect(violations).toContain('url');
    });

    it('should detect https URLs', () => {
      const violations = filterManager.checkMessage('Check out https://example.com', 'user1');

      expect(violations).toContain('url');
    });

    it('should detect www URLs', () => {
      const violations = filterManager.checkMessage('Check out www.example.com', 'user1');

      expect(violations).toContain('url');
    });

    it('should not flag messages without URLs', () => {
      const violations = filterManager.checkMessage('No links here!', 'user1');

      expect(violations).not.toContain('url');
    });
  });

  describe('all caps filtering', () => {
    beforeEach(() => {
      filterManager.updateConfig({ filterAllCaps: true });
    });

    it('should detect messages with more than 50% caps', () => {
      const violations = filterManager.checkMessage('HELLO WORLD test', 'user1');

      expect(violations).toContain('all_caps');
    });

    it('should not flag messages under minimum length', () => {
      const violations = filterManager.checkMessage('HI', 'user1');

      expect(violations).not.toContain('all_caps');
    });

    it('should not flag messages with less than 50% caps', () => {
      const violations = filterManager.checkMessage('Hello World how are you', 'user1');

      expect(violations).not.toContain('all_caps');
    });
  });

  describe('repeated character filtering', () => {
    beforeEach(() => {
      filterManager.updateConfig({ filterRepeatChars: true });
    });

    it('should detect 3+ repeated characters', () => {
      const violations = filterManager.checkMessage('Hellooooo', 'user1');

      expect(violations).toContain('repeat_chars');
    });

    it('should not flag 2 repeated characters', () => {
      const violations = filterManager.checkMessage('Hello', 'user1');

      expect(violations).not.toContain('repeat_chars');
    });

    it('should detect repeated special characters', () => {
      const violations = filterManager.checkMessage('What???', 'user1');

      expect(violations).toContain('repeat_chars');
    });
  });

  describe('spam filtering', () => {
    beforeEach(() => {
      filterManager.updateConfig({ filterSpam: true });
    });

    it('should detect duplicate messages from same user', () => {
      filterManager.checkMessage('Hello world', 'user1');
      const violations = filterManager.checkMessage('Hello world', 'user1');

      expect(violations).toContain('spam');
    });

    it('should not flag duplicate messages from different users', () => {
      filterManager.checkMessage('Hello world', 'user1');
      const violations = filterManager.checkMessage('Hello world', 'user2');

      expect(violations).not.toContain('spam');
    });

    it('should not flag different messages from same user', () => {
      filterManager.checkMessage('Hello world', 'user1');
      const violations = filterManager.checkMessage('Goodbye world', 'user1');

      expect(violations).not.toContain('spam');
    });
  });

  describe('multiple violations', () => {
    beforeEach(() => {
      filterManager.addWord('badword');
      filterManager.updateConfig({
        filterUrls: true,
        filterAllCaps: true,
        filterRepeatChars: true,
      });
    });

    it('should detect multiple violation types', () => {
      // Test with a message that has multiple violation types
      // Note: all_caps requires >50% of message to be caps, so we test separately
      const violations1 = filterManager.checkMessage(
        'badword http://spam.com testtttt',
        'user1'
      );

      expect(violations1).toContain('blacklist_word');
      expect(violations1).toContain('url');
      expect(violations1).toContain('repeat_chars');

      // Test all_caps separately with a mostly-caps message
      const violations2 = filterManager.checkMessage(
        'THIS IS ALL CAPS MESSAGE',
        'user2'
      );
      expect(violations2).toContain('all_caps');
    });
  });

  describe('getStatus', () => {
    it('should return current filter status', () => {
      filterManager.addWord('test');
      filterManager.updateConfig({
        filterUrls: true,
        filterAction: 'timeout',
        timeoutDurationSeconds: 120,
      });

      const status = filterManager.getStatus();

      expect(status.blacklistWords).toContain('test');
      expect(status.filterUrls).toBe(true);
      expect(status.filterAction).toBe('timeout');
      expect(status.timeoutDurationSeconds).toBe(120);
    });

    it('should cache status', () => {
      const status1 = filterManager.getStatus();
      const status2 = filterManager.getStatus();

      expect(status1).toBe(status2);
    });

    it('should invalidate cache on config change', () => {
      const status1 = filterManager.getStatus();
      filterManager.addWord('newword');
      const status2 = filterManager.getStatus();

      expect(status1).not.toBe(status2);
      expect(status2.blacklistWords).toContain('newword');
    });
  });

  describe('addWord and removeWord', () => {
    it('should return true when adding valid word', () => {
      const result = filterManager.addWord('test');
      expect(result).toBe(true);
    });

    it('should return false when adding empty word', () => {
      const result = filterManager.addWord('');
      expect(result).toBe(false);
    });

    it('should return true when removing existing word', () => {
      filterManager.addWord('test');
      const result = filterManager.removeWord('test');
      expect(result).toBe(true);
    });

    it('should return false when removing non-existing word', () => {
      const result = filterManager.removeWord('nonexistent');
      expect(result).toBe(false);
    });

    it('should normalize words to lowercase', () => {
      filterManager.addWord('TEST');
      const status = filterManager.getStatus();
      expect(status.blacklistWords).toContain('test');
    });
  });

  describe('setBlacklistWords', () => {
    it('should replace all blacklist words', () => {
      filterManager.addWord('old');
      filterManager.setBlacklistWords(['new1', 'new2', 'new3']);

      const status = filterManager.getStatus();

      expect(status.blacklistWords).not.toContain('old');
      expect(status.blacklistWords).toContain('new1');
      expect(status.blacklistWords).toContain('new2');
      expect(status.blacklistWords).toContain('new3');
    });
  });
});
