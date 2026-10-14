/**
 * Regression test for message handler and Chat Hype feature
 *
 * Previously: recordChatForHype and tryTriggerHype were called but not defined,
 * causing ReferenceError. They were commented out with a TODO.
 *
 * Now: Chat Hype is fully implemented. This test verifies:
 * 1. recordChatForHype and tryTriggerHype are defined in the bot source (src/bot/*.ts)
 * 2. They are called (not commented out) in the message handler
 */

const fs = require('fs');
const path = require('path');

// The bot moved from Excella.js to src/bot/*.ts; check all of its modules
const botDir = path.join(__dirname, '../../src/bot');

describe('Message Handler - Regression Tests', () => {
  let excellaContent: string;

  beforeAll(() => {
    excellaContent = fs.readdirSync(botDir)
      .filter((f: string) => f.endsWith('.ts'))
      .map((f: string) => fs.readFileSync(path.join(botDir, f), 'utf-8'))
      .join('\n');
  });

  describe('Chat Hype - full implementation', () => {
    it('should define recordChatForHype', () => {
      // Function must be defined (not only referenced in comments)
      expect(excellaContent).toMatch(/\bfunction\s+recordChatForHype\s*\(/);
    });

    it('should define tryTriggerHype', () => {
      expect(excellaContent).toMatch(/\bfunction\s+tryTriggerHype\s*\(/);
    });

    it('should call recordChatForHype(channel) in message handler (not commented)', () => {
      const lines = excellaContent.split('\n');
      const callLine = lines.find(
        (line) => line.includes('recordChatForHype(channel)') && !line.trim().startsWith('//')
      );
      expect(callLine).toBeDefined();
      expect(callLine!.trim()).toContain('recordChatForHype(channel)');
    });

    it('should call tryTriggerHype(channel) in message handler (not commented)', () => {
      const lines = excellaContent.split('\n');
      const callLine = lines.find(
        (line) => line.includes('tryTriggerHype(channel)') && !line.trim().startsWith('//')
      );
      expect(callLine).toBeDefined();
      expect(callLine!.trim()).toContain('tryTriggerHype(channel)');
    });

    it('should not have TODO for incomplete hype feature', () => {
      expect(excellaContent).not.toContain('TODO: Incomplete feature - function implementations missing');
    });
  });
});
