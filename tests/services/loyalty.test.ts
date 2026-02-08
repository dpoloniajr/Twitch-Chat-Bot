/**
 * Tests for Loyalty Points System
 */

import { LoyaltyManager, resetLoyaltyManager } from '../../src/services/loyalty';
import * as fs from 'fs';
import * as path from 'path';

describe('LoyaltyManager', () => {
  let manager: LoyaltyManager;
  const testDataPath = path.join(__dirname, 'test-loyalty.json');

  beforeEach(() => {
    resetLoyaltyManager();
    // Use a test-specific data path and disable auto-save
    manager = new LoyaltyManager({
      dataPath: testDataPath,
      autoSaveIntervalMs: 0,
    });
  });

  afterEach(() => {
    manager.destroy();
    // Clean up test file
    if (fs.existsSync(testDataPath)) {
      fs.unlinkSync(testDataPath);
    }
  });

  describe('basic points operations', () => {
    it('should award points to a user', () => {
      const result = manager.awardPoints('user1', 100, 'Test award');

      expect(result.newBalance).toBe(100);
      expect(result.levelUp).toBe(false);
      expect(manager.getPoints('user1')).toBe(100);
    });

    it('should track total earned points', () => {
      manager.awardPoints('user1', 100, 'Test');
      manager.awardPoints('user1', 50, 'Test');

      const data = manager.getUserData('user1');

      expect(data?.totalEarned).toBe(150);
      expect(data?.points).toBe(150);
    });

    it('should deduct points from a user', () => {
      manager.awardPoints('user1', 100, 'Test');

      const result = manager.deductPoints('user1', 30, 'Test spend');

      expect(result.success).toBe(true);
      expect(result.newBalance).toBe(70);
    });

    it('should reject deduction with insufficient points', () => {
      manager.awardPoints('user1', 50, 'Test');

      const result = manager.deductPoints('user1', 100, 'Test spend');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient');
      expect(manager.getPoints('user1')).toBe(50);
    });

    it('should track total spent points', () => {
      manager.awardPoints('user1', 100, 'Test');
      manager.deductPoints('user1', 30, 'Spend 1');
      manager.deductPoints('user1', 20, 'Spend 2');

      const data = manager.getUserData('user1');

      expect(data?.totalSpent).toBe(50);
    });
  });

  describe('leveling system', () => {
    it('should calculate level based on total earned', () => {
      manager.updateConfig({ pointsPerLevel: 100 });

      manager.awardPoints('user1', 250, 'Test');

      const data = manager.getUserData('user1');
      expect(data?.level).toBe(3); // 250/100 + 1 = 3
    });

    it('should detect level up', () => {
      manager.updateConfig({ pointsPerLevel: 100 });

      manager.awardPoints('user1', 50, 'Test');
      const result = manager.awardPoints('user1', 60, 'Test');

      expect(result.levelUp).toBe(true);
      expect(result.newLevel).toBe(2);
    });

    it('should not report level up when level stays same', () => {
      manager.updateConfig({ pointsPerLevel: 100 });

      manager.awardPoints('user1', 50, 'Test');
      const result = manager.awardPoints('user1', 10, 'Test');

      expect(result.levelUp).toBe(false);
      expect(result.newLevel).toBeUndefined();
    });
  });

  describe('watch time points', () => {
    it('should award points for watch time', () => {
      manager.updateConfig({ pointsPerMinute: 10 });

      const result = manager.awardWatchTimePoints('user1', 5);

      expect(result.pointsEarned).toBe(50);
      expect(result.newBalance).toBe(50);
    });

    it('should apply subscriber multiplier', () => {
      manager.updateConfig({ pointsPerMinute: 10, subscriberMultiplier: 2 });

      const result = manager.awardWatchTimePoints('user1', 5, true);

      expect(result.pointsEarned).toBe(100);
    });

    it('should apply VIP multiplier', () => {
      manager.updateConfig({ pointsPerMinute: 10, vipMultiplier: 1.5 });

      const result = manager.awardWatchTimePoints('user1', 10, false, true);

      expect(result.pointsEarned).toBe(150);
    });

    it('should track watch time minutes', () => {
      manager.awardWatchTimePoints('user1', 30);

      const data = manager.getUserData('user1');
      expect(data?.watchTimeMinutes).toBe(30);
    });
  });

  describe('message points', () => {
    it('should award points for messages', () => {
      manager.updateConfig({ pointsPerMessage: 5 });

      const result = manager.awardMessagePoints('user1');

      expect(result.pointsEarned).toBe(5);
      expect(result.onCooldown).toBe(false);
    });

    it('should respect message cooldown', () => {
      manager.updateConfig({ messageCooldownSeconds: 30 });

      manager.awardMessagePoints('user1');
      const result = manager.awardMessagePoints('user1');

      expect(result.pointsEarned).toBe(0);
      expect(result.onCooldown).toBe(true);
    });

    it('should track message count even on cooldown', () => {
      manager.updateConfig({ messageCooldownSeconds: 30 });

      manager.awardMessagePoints('user1');
      manager.awardMessagePoints('user1');
      manager.awardMessagePoints('user1');

      const data = manager.getUserData('user1');
      expect(data?.messageCount).toBe(3);
    });

    it('should cap message points', () => {
      manager.updateConfig({
        pointsPerMessage: 100,
        maxPointsPerMessage: 50,
        subscriberMultiplier: 2,
      });

      const result = manager.awardMessagePoints('user1', true);

      expect(result.pointsEarned).toBe(50);
    });
  });

  describe('leaderboard', () => {
    it('should return top users by points', () => {
      manager.awardPoints('user1', 100, 'Test');
      manager.awardPoints('user2', 300, 'Test');
      manager.awardPoints('user3', 200, 'Test');

      const leaderboard = manager.getLeaderboard(10);

      expect(leaderboard[0].username).toBe('user2');
      expect(leaderboard[0].rank).toBe(1);
      expect(leaderboard[1].username).toBe('user3');
      expect(leaderboard[1].rank).toBe(2);
      expect(leaderboard[2].username).toBe('user1');
      expect(leaderboard[2].rank).toBe(3);
    });

    it('should limit leaderboard size', () => {
      for (let i = 0; i < 20; i++) {
        manager.awardPoints(`user${i}`, i * 10, 'Test');
      }

      const leaderboard = manager.getLeaderboard(5);

      expect(leaderboard.length).toBe(5);
    });
  });

  describe('user rank', () => {
    it('should return correct rank', () => {
      manager.awardPoints('user1', 100, 'Test');
      manager.awardPoints('user2', 300, 'Test');
      manager.awardPoints('user3', 200, 'Test');

      expect(manager.getUserRank('user2')).toBe(1);
      expect(manager.getUserRank('user3')).toBe(2);
      expect(manager.getUserRank('user1')).toBe(3);
    });

    it('should return null for non-existent user', () => {
      expect(manager.getUserRank('nonexistent')).toBeNull();
    });
  });

  describe('point transfers', () => {
    it('should transfer points between users', () => {
      manager.awardPoints('user1', 100, 'Test');

      const result = manager.transferPoints('user1', 'user2', 30);

      expect(result.success).toBe(true);
      expect(manager.getPoints('user1')).toBe(70);
      expect(manager.getPoints('user2')).toBe(30);
    });

    it('should reject transfer with insufficient points', () => {
      manager.awardPoints('user1', 50, 'Test');

      const result = manager.transferPoints('user1', 'user2', 100);

      expect(result.success).toBe(false);
      expect(manager.getPoints('user1')).toBe(50);
    });
  });

  describe('admin operations', () => {
    it('should set points directly', () => {
      manager.awardPoints('user1', 100, 'Test');

      const newBalance = manager.setPoints('user1', 500, 'Admin set');

      expect(newBalance).toBe(500);
      expect(manager.getPoints('user1')).toBe(500);
    });

    it('should not allow negative points', () => {
      const newBalance = manager.setPoints('user1', -100, 'Admin set');

      expect(newBalance).toBe(0);
    });
  });

  describe('transactions', () => {
    it('should record transactions', () => {
      manager.awardPoints('user1', 100, 'Award 1');
      manager.awardPoints('user1', 50, 'Award 2');
      manager.deductPoints('user1', 30, 'Spend');

      const transactions = manager.getUserTransactions('user1', 10);

      expect(transactions.length).toBe(3);
      expect(transactions[0].type).toBe('spend');
      expect(transactions[0].amount).toBe(-30);
    });
  });

  describe('configuration', () => {
    it('should update configuration', () => {
      manager.updateConfig({ currencyName: 'coin', currencyNamePlural: 'coins' });

      expect(manager.getCurrencyName(1)).toBe('coin');
      expect(manager.getCurrencyName(2)).toBe('coins');
    });

    it('should disable system when enabled is false', () => {
      manager.updateConfig({ enabled: false });

      const result = manager.awardPoints('user1', 100, 'Test');

      expect(result.newBalance).toBe(0);
    });
  });

  describe('statistics', () => {
    it('should count total users', () => {
      manager.awardPoints('user1', 100, 'Test');
      manager.awardPoints('user2', 100, 'Test');
      manager.awardPoints('user3', 100, 'Test');

      expect(manager.getUserCount()).toBe(3);
    });

    it('should calculate total points in circulation', () => {
      manager.awardPoints('user1', 100, 'Test');
      manager.awardPoints('user2', 200, 'Test');
      manager.awardPoints('user3', 50, 'Test');

      expect(manager.getTotalPoints()).toBe(350);
    });
  });
});
