/**
 * Tests for Moderation Commands Module
 */

import { ModerationManager, ModerationApiClient } from '../../src/commands/moderation';
import { REQUIRED_SCOPES } from '../../src/config/constants';

describe('ModerationManager', () => {
  let manager: ModerationManager;
  let mockApiClient: jest.Mocked<ModerationApiClient>;

  beforeEach(() => {
    mockApiClient = {
      getUserByName: jest.fn(),
      banUser: jest.fn(),
      unbanUser: jest.fn(),
      timeoutUser: jest.fn(),
    };

    manager = new ModerationManager({
      apiClient: mockApiClient,
      broadcasterId: '12345',
      moderatorId: '67890',
      scopes: [REQUIRED_SCOPES.MODERATOR_MANAGE_BANNED_USERS],
      permitDurationSeconds: 60,
    });
  });

  describe('banUser', () => {
    it('should ban a user', async () => {
      mockApiClient.getUserByName.mockResolvedValue({
        id: '111',
        login: 'baduser',
        displayName: 'BadUser',
      });
      mockApiClient.banUser.mockResolvedValue({ success: true });

      const result = await manager.banUser('baduser', 'Being toxic');

      expect(result.success).toBe(true);
      expect(result.message).toContain('BadUser');
      expect(result.message).toContain('banned');
      expect(result.message).toContain('Being toxic');
      expect(mockApiClient.banUser).toHaveBeenCalledWith(
        '12345',
        '67890',
        '111',
        'Being toxic'
      );
    });

    it('should return error if user not found', async () => {
      mockApiClient.getUserByName.mockResolvedValue(null);

      const result = await manager.banUser('nonexistent');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should return error if missing scope', async () => {
      manager.updateConfig({ scopes: [] });

      const result = await manager.banUser('user');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing scope');
    });

    it('should handle API errors', async () => {
      mockApiClient.getUserByName.mockResolvedValue({
        id: '111',
        login: 'user',
        displayName: 'User',
      });
      mockApiClient.banUser.mockResolvedValue({
        success: false,
        error: 'API error',
      });

      const result = await manager.banUser('user');

      expect(result.success).toBe(false);
      expect(result.error).toBe('API error');
    });
  });

  describe('unbanUser', () => {
    it('should unban a user', async () => {
      mockApiClient.getUserByName.mockResolvedValue({
        id: '111',
        login: 'user',
        displayName: 'User',
      });
      mockApiClient.unbanUser.mockResolvedValue({ success: true });

      const result = await manager.unbanUser('user');

      expect(result.success).toBe(true);
      expect(result.message).toContain('unbanned');
      expect(mockApiClient.unbanUser).toHaveBeenCalledWith('12345', '67890', '111');
    });

    it('should return error if user not found', async () => {
      mockApiClient.getUserByName.mockResolvedValue(null);

      const result = await manager.unbanUser('nonexistent');

      expect(result.success).toBe(false);
    });
  });

  describe('timeoutUser', () => {
    it('should timeout a user', async () => {
      mockApiClient.getUserByName.mockResolvedValue({
        id: '111',
        login: 'user',
        displayName: 'User',
      });
      mockApiClient.timeoutUser.mockResolvedValue({ success: true });

      const result = await manager.timeoutUser('user', 600, 'Spamming');

      expect(result.success).toBe(true);
      expect(result.message).toContain('timed out');
      expect(result.message).toContain('10 minutes');
      expect(result.data?.duration).toBe(600);
    });

    it('should clamp duration to valid range', async () => {
      mockApiClient.getUserByName.mockResolvedValue({
        id: '111',
        login: 'user',
        displayName: 'User',
      });
      mockApiClient.timeoutUser.mockResolvedValue({ success: true });

      // Test max (2 weeks)
      await manager.timeoutUser('user', 9999999);
      expect(mockApiClient.timeoutUser).toHaveBeenLastCalledWith(
        '12345',
        '67890',
        '111',
        1209600, // 2 weeks max
        undefined
      );

      // Test min (1 second)
      await manager.timeoutUser('user', 0);
      expect(mockApiClient.timeoutUser).toHaveBeenLastCalledWith(
        '12345',
        '67890',
        '111',
        1, // 1 second min
        undefined
      );
    });

    it('should format duration correctly', async () => {
      mockApiClient.getUserByName.mockResolvedValue({
        id: '111',
        login: 'user',
        displayName: 'User',
      });
      mockApiClient.timeoutUser.mockResolvedValue({ success: true });

      // Test seconds
      let result = await manager.timeoutUser('user', 30);
      expect(result.message).toContain('30 seconds');

      // Test minutes
      result = await manager.timeoutUser('user', 300);
      expect(result.message).toContain('5 minutes');

      // Test hours
      result = await manager.timeoutUser('user', 7200);
      expect(result.message).toContain('2 hours');

      // Test days
      result = await manager.timeoutUser('user', 172800);
      expect(result.message).toContain('2 days');
    });
  });

  describe('untimeoutUser', () => {
    it('should untimeout a user (same as unban)', async () => {
      mockApiClient.getUserByName.mockResolvedValue({
        id: '111',
        login: 'user',
        displayName: 'User',
      });
      mockApiClient.unbanUser.mockResolvedValue({ success: true });

      const result = await manager.untimeoutUser('user');

      expect(result.success).toBe(true);
      expect(mockApiClient.unbanUser).toHaveBeenCalled();
    });
  });

  describe('permitUser', () => {
    it('should grant a permit', () => {
      const result = manager.permitUser('user');

      expect(result.success).toBe(true);
      expect(result.message).toContain('permitted');
      expect(manager.hasPermit('user')).toBe(true);
    });

    it('should handle @ prefix in username', () => {
      manager.permitUser('@user');

      expect(manager.hasPermit('user')).toBe(true);
    });

    it('should use custom duration', () => {
      const result = manager.permitUser('user', 120);

      expect(result.message).toContain('2 minutes');
    });

    it('should allow revoking permits to simulate expiry', () => {
      // Grant a permit
      manager.permitUser('user', 60);
      expect(manager.hasPermit('user')).toBe(true);

      // Revoke it
      manager.revokePermit('user');
      expect(manager.hasPermit('user')).toBe(false);
    });
  });

  describe('hasPermit', () => {
    it('should return true for active permit', () => {
      manager.permitUser('user', 3600);

      expect(manager.hasPermit('user')).toBe(true);
    });

    it('should return false for no permit', () => {
      expect(manager.hasPermit('nopermit')).toBe(false);
    });

    it('should be case insensitive', () => {
      manager.permitUser('User');

      expect(manager.hasPermit('USER')).toBe(true);
      expect(manager.hasPermit('user')).toBe(true);
    });
  });

  describe('revokePermit', () => {
    it('should revoke an active permit', () => {
      manager.permitUser('user');

      const result = manager.revokePermit('user');

      expect(result).toBe(true);
      expect(manager.hasPermit('user')).toBe(false);
    });

    it('should return false for non-existent permit', () => {
      const result = manager.revokePermit('nonexistent');

      expect(result).toBe(false);
    });
  });

  describe('cleanupExpiredPermits', () => {
    it('should not affect active permits during cleanup', () => {
      // Grant active permits
      manager.permitUser('user1', 3600);
      manager.permitUser('user2', 3600);

      const cleaned = manager.cleanupExpiredPermits();

      // No permits should be cleaned (both are active)
      expect(cleaned).toBe(0);
      expect(manager.hasPermit('user1')).toBe(true);
      expect(manager.hasPermit('user2')).toBe(true);
    });

    it('should return count of cleaned permits', () => {
      manager.permitUser('user1', 3600);

      // Revoke to simulate "expired" behavior
      manager.revokePermit('user1');

      // Cleanup should find nothing (already removed)
      const cleaned = manager.cleanupExpiredPermits();
      expect(cleaned).toBe(0);
    });
  });

  describe('getPermitCount', () => {
    it('should return active permit count', () => {
      manager.permitUser('user1', 3600);
      manager.permitUser('user2', 3600);

      expect(manager.getPermitCount()).toBe(2);
    });
  });

  describe('parseDuration', () => {
    it('should parse seconds', () => {
      expect(ModerationManager.parseDuration('30')).toBe(30);
      expect(ModerationManager.parseDuration('30s')).toBe(30);
    });

    it('should parse minutes', () => {
      expect(ModerationManager.parseDuration('5m')).toBe(300);
    });

    it('should parse hours', () => {
      expect(ModerationManager.parseDuration('2h')).toBe(7200);
    });

    it('should parse days', () => {
      expect(ModerationManager.parseDuration('1d')).toBe(86400);
    });

    it('should return null for invalid input', () => {
      expect(ModerationManager.parseDuration('abc')).toBeNull();
      expect(ModerationManager.parseDuration('')).toBeNull();
    });
  });

  describe('updateConfig', () => {
    it('should update configuration', () => {
      manager.updateConfig({
        broadcasterId: '99999',
        permitDurationSeconds: 120,
      });

      // The permitDuration should now be 120 seconds
      const result = manager.permitUser('user');
      expect(result.message).toContain('2 minutes');
    });
  });
});
