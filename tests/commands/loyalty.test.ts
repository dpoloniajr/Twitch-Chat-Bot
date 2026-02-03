/**
 * Tests for Loyalty Commands
 */

import { createLoyaltyCommands, registerLoyaltyCommands } from '../../src/commands/loyalty';
import { LoyaltyManager } from '../../src/services/loyalty';
import { CommandContext } from '../../src/types';

// Mock the loyalty manager
jest.mock('../../src/services/loyalty', () => ({
  getLoyaltyManager: jest.fn(),
  LoyaltyManager: jest.fn(),
}));

describe('Loyalty Commands', () => {
  let mockManager: jest.Mocked<LoyaltyManager>;
  let commands: Map<string, any>;

  const createMockContext = (
    user: string,
    args: string[] = [],
    isMod = false,
    isBroadcaster = false
  ): CommandContext => ({
    channel: '#testchannel',
    user,
    args,
    msg: {
      userInfo: {
        isMod,
        isBroadcaster,
        userName: user,
        displayName: user,
        isBroadcaster,
        isSubscriber: false,
        isVip: false,
      },
    } as any,
  });

  beforeEach(() => {
    mockManager = {
      getUser: jest.fn(),
      addPoints: jest.fn(),
      removePoints: jest.fn(),
      setPoints: jest.fn(),
      getLevelInfo: jest.fn(),
      getLeaderboardRank: jest.fn(),
      getLeaderboard: jest.fn(),
    } as any;

    commands = createLoyaltyCommands(mockManager);
  });

  describe('!points command', () => {
    it('should show user points', async () => {
      mockManager.getUser.mockReturnValue({ points: 500, username: 'testuser' });
      mockManager.getLevelInfo.mockReturnValue({ level: 3, name: 'Regular' });
      mockManager.getLeaderboardRank.mockReturnValue(5);

      const context = createMockContext('testuser');
      const handler = commands.get('!points');
      const result = await handler.handler(context);

      expect(result.success).toBe(true);
      expect(result.message).toContain('500 points');
      expect(result.message).toContain('Level 3');
      expect(result.message).toContain('Rank #5');
    });

    it('should show 0 points for new user', async () => {
      mockManager.getUser.mockReturnValue(null);

      const context = createMockContext('newuser');
      const handler = commands.get('!points');
      const result = await handler.handler(context);

      expect(result.success).toBe(true);
      expect(result.message).toContain('0 points');
    });

    it('should show other user points', async () => {
      mockManager.getUser.mockReturnValue({ points: 1000, username: 'otheruser' });

      const context = createMockContext('testuser', ['otheruser']);
      const handler = commands.get('!points');
      const result = await handler.handler(context);

      expect(result.success).toBe(true);
      expect(result.message).toContain('otheruser has');
      expect(result.message).toContain('1000 points');
    });
  });

  describe('!leaderboard command', () => {
    it('should show top users', async () => {
      mockManager.getLeaderboard.mockReturnValue([
        { username: 'user1', points: 1000 },
        { username: 'user2', points: 800 },
        { username: 'user3', points: 600 },
      ]);

      const context = createMockContext('testuser');
      const handler = commands.get('!leaderboard');
      const result = await handler.handler(context);

      expect(result.success).toBe(true);
      expect(result.message).toContain('user1: 1000');
      expect(result.message).toContain('user2: 800');
    });

    it('should handle empty leaderboard', async () => {
      mockManager.getLeaderboard.mockReturnValue([]);

      const context = createMockContext('testuser');
      const handler = commands.get('!leaderboard');
      const result = await handler.handler(context);

      expect(result.success).toBe(true);
      expect(result.message).toContain('no one has earned points');
    });
  });

  describe('!gamble command', () => {
    it('should require amount argument', async () => {
      const context = createMockContext('testuser');
      const handler = commands.get('!gamble');
      const result = await handler.handler(context);

      expect(result.success).toBe(false);
      expect(result.message).toContain('usage');
    });

    it('should reject insufficient points', async () => {
      mockManager.getUser.mockReturnValue({ points: 50, username: 'testuser' });

      const context = createMockContext('testuser', ['100']);
      const handler = commands.get('!gamble');
      const result = await handler.handler(context);

      expect(result.success).toBe(false);
      expect(result.message).toContain("don't have enough");
    });

    it('should handle gambling (win or lose)', async () => {
      mockManager.getUser.mockReturnValue({ points: 100, username: 'testuser' });

      const context = createMockContext('testuser', ['50']);
      const handler = commands.get('!gamble');
      const result = await handler.handler(context);

      expect(result.success).toBe(true);
      expect(result.message).toMatch(/won|lost/);
    });

    it('should support "all" keyword', async () => {
      mockManager.getUser.mockReturnValue({ points: 100, username: 'testuser' });

      const context = createMockContext('testuser', ['all']);
      const handler = commands.get('!gamble');
      const result = await handler.handler(context);

      expect(result.success).toBe(true);
      // Should gamble all 100 points
      expect(mockManager.addPoints).toHaveBeenCalledWith('testuser', 100, 'gamble_win')
        || expect(mockManager.removePoints).toHaveBeenCalledWith('testuser', 100, 'gamble_loss');
    });
  });

  describe('!give command', () => {
    it('should require target and amount', async () => {
      const context = createMockContext('testuser');
      const handler = commands.get('!give');
      const result = await handler.handler(context);

      expect(result.success).toBe(false);
      expect(result.message).toContain('usage');
    });

    it('should prevent self-giving', async () => {
      const context = createMockContext('testuser', ['testuser', '100']);
      const handler = commands.get('!give');
      const result = await handler.handler(context);

      expect(result.success).toBe(false);
      expect(result.message).toContain("can't give points to yourself");
    });

    it('should transfer points', async () => {
      mockManager.getUser.mockReturnValue({ points: 500, username: 'testuser' });

      const context = createMockContext('testuser', ['@otheruser', '100']);
      const handler = commands.get('!give');
      const result = await handler.handler(context);

      expect(result.success).toBe(true);
      expect(mockManager.removePoints).toHaveBeenCalledWith('testuser', 100, 'gift_sent');
      expect(mockManager.addPoints).toHaveBeenCalledWith('otheruser', 100, 'gift_received');
    });
  });

  describe('!addpoints command (mod only)', () => {
    it('should have mod permission', () => {
      const handler = commands.get('!addpoints');
      expect(handler.perm).toBe('mod');
    });

    it('should add points to user', async () => {
      mockManager.getUser.mockReturnValue({ points: 200, username: 'targetuser' });

      const context = createMockContext('moduser', ['targetuser', '100'], true);
      const handler = commands.get('!addpoints');
      const result = await handler.handler(context);

      expect(result.success).toBe(true);
      expect(mockManager.addPoints).toHaveBeenCalledWith('targetuser', 100, 'mod_add');
    });
  });

  describe('!setpoints command (mod only)', () => {
    it('should have mod permission', () => {
      const handler = commands.get('!setpoints');
      expect(handler.perm).toBe('mod');
    });

    it('should set user points', async () => {
      const context = createMockContext('moduser', ['targetuser', '500'], true);
      const handler = commands.get('!setpoints');
      const result = await handler.handler(context);

      expect(result.success).toBe(true);
      expect(mockManager.setPoints).toHaveBeenCalledWith('targetuser', 500, 'mod_set');
    });
  });

  describe('registerLoyaltyCommands', () => {
    it('should register all commands with aliases', () => {
      const mockRegistry = {
        register: jest.fn(),
      };

      registerLoyaltyCommands(mockRegistry, mockManager);

      expect(mockRegistry.register).toHaveBeenCalledTimes(7);

      // Check that aliases are registered
      const pointsCall = mockRegistry.register.mock.calls.find(
        (call) => call[0] === '!points'
      );
      expect(pointsCall[2]).toContain('!balance');
      expect(pointsCall[2]).toContain('!pts');
    });
  });
});
