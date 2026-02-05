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
  let mockManager: {
    getUserData: jest.Mock;
    getUserRank: jest.Mock;
    awardPoints: jest.Mock;
    setPoints: jest.Mock;
    getLeaderboard: jest.Mock;
    transferPoints: jest.Mock;
  };
  let commands: Map<string, any>;

  const createMockContext = (
    user: string,
    args: string[] = [],
    isMod = false,
    isBroadcaster = false
  ): CommandContext => ({
    channel: '#testchannel',
    username: user,
    displayName: user,
    raw: `!command ${args.join(' ')}`,
    args,
    msg: {
      userInfo: {
        isMod,
        isBroadcaster,
        userName: user,
        displayName: user,
        isSubscriber: false,
        isVip: false,
      },
    } as any,
  });

  beforeEach(() => {
    mockManager = {
      getUserData: jest.fn(),
      getUserRank: jest.fn(),
      awardPoints: jest.fn(),
      setPoints: jest.fn(),
      getLeaderboard: jest.fn(),
      transferPoints: jest.fn(),
    } as any;

    commands = createLoyaltyCommands(mockManager as unknown as LoyaltyManager);
  });

  describe('!points command', () => {
    it('should call getUserData and getUserRank', async () => {
      mockManager.getUserData.mockReturnValue({ points: 500, username: 'testuser' } as any);
      mockManager.getUserRank.mockReturnValue(5);

      const context = createMockContext('testuser');
      const handler = commands.get('!points');
      await handler.handler(context);

      expect(mockManager.getUserData).toHaveBeenCalledWith('testuser');
      expect(mockManager.getUserRank).toHaveBeenCalledWith('testuser');
    });

    it('should look up other user when username provided', async () => {
      mockManager.getUserData.mockReturnValue({ points: 1000, username: 'otheruser' } as any);
      mockManager.getUserRank.mockReturnValue(3);

      const context = createMockContext('testuser', ['otheruser']);
      const handler = commands.get('!points');
      await handler.handler(context);

      expect(mockManager.getUserData).toHaveBeenCalledWith('otheruser');
      expect(mockManager.getUserRank).toHaveBeenCalledWith('otheruser');
    });

    it('should strip @ from username', async () => {
      mockManager.getUserData.mockReturnValue(null);
      mockManager.getUserRank.mockReturnValue(null);

      const context = createMockContext('testuser', ['@otheruser']);
      const handler = commands.get('!points');
      await handler.handler(context);

      expect(mockManager.getUserData).toHaveBeenCalledWith('otheruser');
    });
  });

  describe('!leaderboard command', () => {
    it('should get leaderboard with default limit', async () => {
      mockManager.getLeaderboard.mockReturnValue([]);

      const context = createMockContext('testuser');
      const handler = commands.get('!leaderboard');
      await handler.handler(context);

      expect(mockManager.getLeaderboard).toHaveBeenCalledWith(5);
    });

    it('should respect custom limit up to 10', async () => {
      mockManager.getLeaderboard.mockReturnValue([]);

      const context = createMockContext('testuser', ['8']);
      const handler = commands.get('!leaderboard');
      await handler.handler(context);

      expect(mockManager.getLeaderboard).toHaveBeenCalledWith(8);
    });

    it('should cap limit at 10', async () => {
      mockManager.getLeaderboard.mockReturnValue([]);

      const context = createMockContext('testuser', ['50']);
      const handler = commands.get('!leaderboard');
      await handler.handler(context);

      expect(mockManager.getLeaderboard).toHaveBeenCalledWith(10);
    });
  });

  describe('!gamble command', () => {
    it('should do nothing without amount argument', async () => {
      const context = createMockContext('testuser');
      const handler = commands.get('!gamble');
      await handler.handler(context);

      expect(mockManager.getUserData).not.toHaveBeenCalled();
    });

    it('should do nothing with invalid amount', async () => {
      mockManager.getUserData.mockReturnValue({ points: 100 } as any);

      const context = createMockContext('testuser', ['invalid']);
      const handler = commands.get('!gamble');
      await handler.handler(context);

      expect(mockManager.awardPoints).not.toHaveBeenCalled();
      expect(mockManager.setPoints).not.toHaveBeenCalled();
    });

    it('should do nothing with insufficient points', async () => {
      mockManager.getUserData.mockReturnValue({ points: 50 } as any);

      const context = createMockContext('testuser', ['100']);
      const handler = commands.get('!gamble');
      await handler.handler(context);

      expect(mockManager.awardPoints).not.toHaveBeenCalled();
      expect(mockManager.setPoints).not.toHaveBeenCalled();
    });

    it('should gamble with valid amount', async () => {
      mockManager.getUserData.mockReturnValue({ points: 100 } as any);

      const context = createMockContext('testuser', ['50']);
      const handler = commands.get('!gamble');

      // Run multiple times to ensure both win and loss paths work
      for (let i = 0; i < 10; i++) {
        await handler.handler(context);
      }

      // Either awardPoints or setPoints should have been called
      const totalCalls = (mockManager.awardPoints as jest.Mock).mock.calls.length +
                        (mockManager.setPoints as jest.Mock).mock.calls.length;
      expect(totalCalls).toBeGreaterThan(0);
    });

    it('should support "all" keyword', async () => {
      mockManager.getUserData.mockReturnValue({ points: 100 } as any);

      const context = createMockContext('testuser', ['all']);
      const handler = commands.get('!gamble');
      await handler.handler(context);

      // Should have tried to gamble all 100 points
      const awardCalls = (mockManager.awardPoints as jest.Mock).mock.calls;
      const setCalls = (mockManager.setPoints as jest.Mock).mock.calls;

      if (awardCalls.length > 0) {
        expect(awardCalls[0][1]).toBe(100); // Award 100 points on win
      } else if (setCalls.length > 0) {
        expect(setCalls[0][1]).toBe(0); // Set to 0 on loss (100 - 100 = 0)
      }
    });
  });

  describe('!give command', () => {
    it('should do nothing without target and amount', async () => {
      const context = createMockContext('testuser');
      const handler = commands.get('!give');
      await handler.handler(context);

      expect(mockManager.transferPoints).not.toHaveBeenCalled();
    });

    it('should do nothing when giving to self', async () => {
      const context = createMockContext('testuser', ['testuser', '100']);
      const handler = commands.get('!give');
      await handler.handler(context);

      expect(mockManager.transferPoints).not.toHaveBeenCalled();
    });

    it('should transfer points to another user', async () => {
      mockManager.transferPoints.mockReturnValue({ success: true } as any);

      const context = createMockContext('testuser', ['otheruser', '100']);
      const handler = commands.get('!give');
      await handler.handler(context);

      expect(mockManager.transferPoints).toHaveBeenCalledWith('testuser', 'otheruser', 100);
    });

    it('should strip @ from target username', async () => {
      mockManager.transferPoints.mockReturnValue({ success: true } as any);

      const context = createMockContext('testuser', ['@otheruser', '100']);
      const handler = commands.get('!give');
      await handler.handler(context);

      expect(mockManager.transferPoints).toHaveBeenCalledWith('testuser', 'otheruser', 100);
    });
  });

  describe('!addpoints command (mod only)', () => {
    it('should have mod permission', () => {
      const handler = commands.get('!addpoints');
      expect(handler.perm).toBe('mod');
    });

    it('should add points to user', async () => {
      const context = createMockContext('moduser', ['targetuser', '100'], true);
      const handler = commands.get('!addpoints');
      await handler.handler(context);

      expect(mockManager.awardPoints).toHaveBeenCalledWith(
        'targetuser',
        100,
        'Added by moduser',
        'bonus'
      );
    });

    it('should do nothing without target or amount', async () => {
      const context = createMockContext('moduser', [], true);
      const handler = commands.get('!addpoints');
      await handler.handler(context);

      expect(mockManager.awardPoints).not.toHaveBeenCalled();
    });
  });

  describe('!removepoints command (mod only)', () => {
    it('should have mod permission', () => {
      const handler = commands.get('!removepoints');
      expect(handler.perm).toBe('mod');
    });

    it('should remove points from user', async () => {
      mockManager.getUserData.mockReturnValue({ points: 500 } as any);

      const context = createMockContext('moduser', ['targetuser', '100'], true);
      const handler = commands.get('!removepoints');
      await handler.handler(context);

      expect(mockManager.setPoints).toHaveBeenCalledWith(
        'targetuser',
        400,
        'Removed by moduser'
      );
    });

    it('should not set points below 0', async () => {
      mockManager.getUserData.mockReturnValue({ points: 50 } as any);

      const context = createMockContext('moduser', ['targetuser', '100'], true);
      const handler = commands.get('!removepoints');
      await handler.handler(context);

      expect(mockManager.setPoints).toHaveBeenCalledWith(
        'targetuser',
        0,
        'Removed by moduser'
      );
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
      await handler.handler(context);

      expect(mockManager.setPoints).toHaveBeenCalledWith(
        'targetuser',
        500,
        'Set by moduser'
      );
    });

    it('should allow setting to 0', async () => {
      const context = createMockContext('moduser', ['targetuser', '0'], true);
      const handler = commands.get('!setpoints');
      await handler.handler(context);

      expect(mockManager.setPoints).toHaveBeenCalledWith(
        'targetuser',
        0,
        'Set by moduser'
      );
    });

    it('should reject negative values', async () => {
      const context = createMockContext('moduser', ['targetuser', '-100'], true);
      const handler = commands.get('!setpoints');
      await handler.handler(context);

      expect(mockManager.setPoints).not.toHaveBeenCalled();
    });
  });

  describe('registerLoyaltyCommands', () => {
    it('should register all commands with aliases', () => {
      const mockRegistry = {
        register: jest.fn(),
      };

      registerLoyaltyCommands(mockRegistry, mockManager as unknown as LoyaltyManager);

      expect(mockRegistry.register).toHaveBeenCalledTimes(7);

      // Check that aliases are registered
      const pointsCall = mockRegistry.register.mock.calls.find(
        (call: any[]) => call[0] === '!points'
      );
      expect(pointsCall[2]).toContain('!balance');
      expect(pointsCall[2]).toContain('!pts');
    });
  });
});
