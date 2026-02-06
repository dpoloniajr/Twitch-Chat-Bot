/**
 * Tests for Rate Limiter
 */

import {
  RateLimiter,
  MultiTierRateLimiter,
  CommandRateLimiter,
  SpamDetector,
  getCommandRateLimiter,
  getSpamDetector,
  resetRateLimiters,
} from '../../src/utils/rate-limiter';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({
      maxRequests: 5,
      windowMs: 1000,
    });
  });

  afterEach(() => {
    limiter.destroy();
  });

  describe('check', () => {
    it('should allow requests within limit', () => {
      const result = limiter.check('test-key');

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4); // 5 - 1 = 4 remaining after check
    });

    it('should track remaining capacity correctly', () => {
      for (let i = 0; i < 4; i++) {
        limiter.consume('test-key');
      }

      const result = limiter.check('test-key');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(0);
    });
  });

  describe('consume', () => {
    it('should consume tokens', () => {
      limiter.consume('test-key');
      limiter.consume('test-key');
      limiter.consume('test-key');

      expect(limiter.getRemaining('test-key')).toBe(2);
    });

    it('should reject when limit exceeded', () => {
      // Consume all tokens
      for (let i = 0; i < 5; i++) {
        limiter.consume('test-key');
      }

      const result = limiter.consume('test-key');
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfterMs).toBeGreaterThan(0);
    });
  });

  describe('penalty', () => {
    let penaltyLimiter: RateLimiter;

    beforeEach(() => {
      penaltyLimiter = new RateLimiter({
        maxRequests: 2,
        windowMs: 1000,
        penaltyMs: 5000,
      });
    });

    afterEach(() => {
      penaltyLimiter.destroy();
    });

    it('should apply penalty when limit exceeded', () => {
      // Consume all tokens
      penaltyLimiter.consume('test-key');
      penaltyLimiter.consume('test-key');
      penaltyLimiter.consume('test-key'); // This should trigger penalty

      const result = penaltyLimiter.check('test-key');
      expect(result.allowed).toBe(false);
      expect(result.penalized).toBe(true);
    });

    it('should respect penalty duration', () => {
      penaltyLimiter.consume('test-key');
      penaltyLimiter.consume('test-key');
      penaltyLimiter.consume('test-key');

      const result = penaltyLimiter.check('test-key');
      expect(result.retryAfterMs).toBeGreaterThan(4000);
      expect(result.retryAfterMs).toBeLessThanOrEqual(5000);
    });

    it('should clear penalty', () => {
      penaltyLimiter.consume('test-key');
      penaltyLimiter.consume('test-key');
      penaltyLimiter.consume('test-key');

      penaltyLimiter.clearPenalty('test-key');

      // Still at limit, but no penalty
      const result = penaltyLimiter.check('test-key');
      expect(result.penalized).toBeUndefined();
    });
  });

  describe('reset', () => {
    it('should reset limit for key', () => {
      for (let i = 0; i < 5; i++) {
        limiter.consume('test-key');
      }

      expect(limiter.getRemaining('test-key')).toBe(0);

      limiter.reset('test-key');

      expect(limiter.getRemaining('test-key')).toBe(5);
    });
  });

  describe('getRemaining', () => {
    it('should return max requests for new key', () => {
      expect(limiter.getRemaining('new-key')).toBe(5);
    });

    it('should return correct remaining after consumption', () => {
      limiter.consume('test-key');
      limiter.consume('test-key');

      expect(limiter.getRemaining('test-key')).toBe(3);
    });
  });
});

describe('MultiTierRateLimiter', () => {
  let limiter: MultiTierRateLimiter;

  beforeEach(() => {
    limiter = new MultiTierRateLimiter({
      user: { maxRequests: 10, windowMs: 1000 },
      channel: { maxRequests: 50, windowMs: 1000 },
      global: { maxRequests: 100, windowMs: 1000 },
    });
  });

  afterEach(() => {
    limiter.destroy();
  });

  describe('check', () => {
    it('should check all tiers', () => {
      const result = limiter.check({
        user: 'user1',
        channel: '#channel1',
        global: 'global',
      });

      expect(result.allowed).toBe(true);
    });

    it('should fail if any tier is exceeded', () => {
      // Exhaust user tier
      for (let i = 0; i < 10; i++) {
        limiter.consume({
          user: 'user1',
          channel: '#channel1',
          global: 'global',
        });
      }

      const result = limiter.check({
        user: 'user1',
        channel: '#channel1',
        global: 'global',
      });

      expect(result.allowed).toBe(false);
    });
  });

  describe('consume', () => {
    it('should consume from all tiers', () => {
      limiter.consume({
        user: 'user1',
        channel: '#channel1',
        global: 'global',
      });

      // Check that consumption happened across tiers
      const result = limiter.check({
        user: 'user1',
        channel: '#channel1',
        global: 'global',
      });

      expect(result.remaining).toBeLessThan(10); // User tier has lowest limit
    });
  });

  describe('reset', () => {
    it('should reset specific tier', () => {
      for (let i = 0; i < 10; i++) {
        limiter.consume({
          user: 'user1',
          channel: '#channel1',
          global: 'global',
        });
      }

      limiter.reset('user', 'user1');

      const result = limiter.check({
        user: 'user1',
        channel: '#channel1',
        global: 'global',
      });

      expect(result.allowed).toBe(true);
    });
  });
});

describe('CommandRateLimiter', () => {
  let limiter: CommandRateLimiter;

  beforeEach(() => {
    limiter = new CommandRateLimiter({
      userLimitPerMinute: 5,
      channelLimitPerMinute: 20,
      globalLimitPerSecond: 10,
    });
  });

  afterEach(() => {
    limiter.destroy();
  });

  describe('checkCommand', () => {
    it('should allow commands within limit', () => {
      const result = limiter.checkCommand('!test', 'user1', '#channel1');

      expect(result.allowed).toBe(true);
    });

    it('should block when user limit exceeded', () => {
      for (let i = 0; i < 5; i++) {
        limiter.consumeCommand('!test', 'user1', '#channel1');
      }

      const result = limiter.checkCommand('!test', 'user1', '#channel1');
      expect(result.allowed).toBe(false);
    });
  });

  describe('exempt users', () => {
    it('should bypass limits for exempt users', () => {
      limiter.addExemptUser('moduser');

      // Consume way more than limit
      for (let i = 0; i < 100; i++) {
        const result = limiter.consumeCommand('!test', 'moduser', '#channel1');
        expect(result.allowed).toBe(true);
      }
    });

    it('should remove exempt status', () => {
      limiter.addExemptUser('moduser');
      limiter.removeExemptUser('moduser');

      // Now should be rate limited
      for (let i = 0; i < 6; i++) {
        limiter.consumeCommand('!test', 'moduser', '#channel1');
      }

      const result = limiter.checkCommand('!test', 'moduser', '#channel1');
      expect(result.allowed).toBe(false);
    });
  });

  describe('custom cooldowns', () => {
    it('should set and get command cooldown', () => {
      limiter.setCommandCooldown('!special', 10000);

      expect(limiter.getCommandCooldown('!special')).toBe(10000);
      expect(limiter.getCommandCooldown('!other')).toBe(3000); // Default
    });
  });
});

describe('SpamDetector', () => {
  let detector: SpamDetector;

  beforeEach(() => {
    detector = new SpamDetector({
      maxDuplicates: 2,
      duplicateWindowMs: 5000,
      maxMessagesPerWindow: 5,
      messageWindowMs: 3000,
      maxCapsPercentage: 70,
      minCapsLength: 5,
      maxRepeatedChars: 3,
    });
  });

  describe('duplicate detection', () => {
    it('should detect duplicate messages', () => {
      detector.checkMessage('user1', 'Hello world');
      detector.checkMessage('user1', 'Hello world');
      const result = detector.checkMessage('user1', 'Hello world');

      expect(result.isSpam).toBe(true);
      expect(result.reasons).toContain('duplicate_message');
    });

    it('should be case insensitive', () => {
      detector.checkMessage('user1', 'Hello World');
      detector.checkMessage('user1', 'hello world');
      const result = detector.checkMessage('user1', 'HELLO WORLD');

      expect(result.isSpam).toBe(true);
      expect(result.reasons).toContain('duplicate_message');
    });
  });

  describe('message rate detection', () => {
    it('should detect high message rate', () => {
      for (let i = 0; i < 5; i++) {
        detector.checkMessage('user1', `Message ${i}`);
      }

      const result = detector.checkMessage('user1', 'One more message');

      expect(result.isSpam).toBe(true);
      expect(result.reasons).toContain('message_rate');
    });
  });

  describe('caps detection', () => {
    it('should detect excessive caps', () => {
      const result = detector.checkMessage('user1', 'THIS IS ALL CAPS MESSAGE');

      expect(result.isSpam).toBe(true);
      expect(result.reasons).toContain('excessive_caps');
    });

    it('should ignore short messages', () => {
      const result = detector.checkMessage('user1', 'OK');

      expect(result.isSpam).toBe(false);
    });

    it('should allow normal caps usage', () => {
      const result = detector.checkMessage('user1', 'Hello World, this is normal');

      expect(result.isSpam).toBe(false);
    });
  });

  describe('repeated characters detection', () => {
    it('should detect repeated characters', () => {
      const result = detector.checkMessage('user1', 'Helloooooo');

      expect(result.isSpam).toBe(true);
      expect(result.reasons).toContain('repeated_characters');
    });

    it('should allow normal repeated chars', () => {
      const result = detector.checkMessage('user1', 'Helloo');

      expect(result.isSpam).toBe(false);
    });
  });

  describe('clearHistory', () => {
    it('should clear user history', () => {
      detector.checkMessage('user1', 'Test message');
      detector.checkMessage('user1', 'Test message');

      detector.clearHistory('user1');

      const result = detector.checkMessage('user1', 'Test message');
      expect(result.isSpam).toBe(false);
    });
  });

  describe('updateConfig', () => {
    it('should update configuration', () => {
      detector.updateConfig({ maxDuplicates: 5 });

      // maxDuplicates=5 means 5 duplicate messages (after the first) trigger spam
      // So we need 5 messages before it triggers on the 6th
      for (let i = 0; i < 5; i++) {
        detector.checkMessage('user1', 'Same message');
      }

      const result = detector.checkMessage('user1', 'Same message');
      expect(result.isSpam).toBe(true);
    });
  });
});

describe('Singleton functions', () => {
  afterEach(() => {
    resetRateLimiters();
  });

  it('should return same CommandRateLimiter instance', () => {
    const limiter1 = getCommandRateLimiter();
    const limiter2 = getCommandRateLimiter();

    expect(limiter1).toBe(limiter2);
  });

  it('should return same SpamDetector instance', () => {
    const detector1 = getSpamDetector();
    const detector2 = getSpamDetector();

    expect(detector1).toBe(detector2);
  });

  it('should create new instances after reset', () => {
    const limiter1 = getCommandRateLimiter();
    const detector1 = getSpamDetector();

    resetRateLimiters();

    const limiter2 = getCommandRateLimiter();
    const detector2 = getSpamDetector();

    expect(limiter1).not.toBe(limiter2);
    expect(detector1).not.toBe(detector2);
  });
});
