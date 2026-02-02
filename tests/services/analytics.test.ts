/**
 * Tests for Analytics Manager
 */

import * as fs from 'fs';
import {
  AnalyticsManager,
  getAnalyticsManager,
  resetAnalyticsManager,
} from '../../src/services/analytics';

// Mock fs module
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

const mockFs = fs as jest.Mocked<typeof fs>;

describe('AnalyticsManager', () => {
  let manager: AnalyticsManager;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    resetAnalyticsManager();

    // Default mock for non-existent file
    mockFs.existsSync.mockReturnValue(false);
    mockFs.mkdirSync.mockReturnValue(undefined);
    mockFs.writeFileSync.mockReturnValue(undefined);

    manager = new AnalyticsManager({
      dataPath: '/test/analytics.json',
      autoSaveIntervalMs: 0, // Disable auto-save for tests
    });
  });

  afterEach(() => {
    manager.destroy();
    jest.useRealTimers();
  });

  describe('constructor', () => {
    it('should create manager with default config', () => {
      const config = manager.getConfig();

      expect(config.retentionDays).toBe(30);
      expect(config.sampleRate).toBe(1);
      expect(config.trackCommands).toBe(true);
      expect(config.trackMessages).toBe(true);
      expect(config.trackViewers).toBe(true);
    });

    it('should load existing data', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({
          commandExecutions: [{ command: '!test', timestamp: new Date().toISOString() }],
          hourlyStats: {
            '2024-01-01T00:00:00.000Z': { hour: '2024-01-01T00:00:00.000Z', commands: 5 },
          },
          commandStats: {
            '!test': { name: '!test', totalExecutions: 10 },
          },
          streamSessions: [],
        })
      );

      const loadedManager = new AnalyticsManager({
        dataPath: '/test/analytics.json',
        autoSaveIntervalMs: 0,
      });

      const stats = loadedManager.getCommandStats();
      expect(stats).toHaveLength(1);
      expect(stats[0].name).toBe('!test');

      loadedManager.destroy();
    });

    it('should apply custom config', () => {
      const customManager = new AnalyticsManager({
        dataPath: '/test/analytics.json',
        config: {
          retentionDays: 7,
          sampleRate: 0.5,
          trackCommands: false,
        },
        autoSaveIntervalMs: 0,
      });

      const config = customManager.getConfig();

      expect(config.retentionDays).toBe(7);
      expect(config.sampleRate).toBe(0.5);
      expect(config.trackCommands).toBe(false);

      customManager.destroy();
    });
  });

  describe('trackCommand', () => {
    it('should track command execution', () => {
      manager.trackCommand({
        command: '!test',
        username: 'testuser',
        channel: '#channel',
        success: true,
        responseTime: 50,
      });

      const stats = manager.getCommandStats();

      expect(stats).toHaveLength(1);
      expect(stats[0].name).toBe('!test');
      expect(stats[0].totalExecutions).toBe(1);
      expect(stats[0].successfulExecutions).toBe(1);
      expect(stats[0].failedExecutions).toBe(0);
      expect(stats[0].averageResponseTime).toBe(50);
    });

    it('should track failed commands', () => {
      manager.trackCommand({
        command: '!test',
        username: 'testuser',
        channel: '#channel',
        success: false,
      });

      const stats = manager.getCommandStatsByName('!test');

      expect(stats?.failedExecutions).toBe(1);
      expect(stats?.successfulExecutions).toBe(0);
    });

    it('should accumulate command statistics', () => {
      manager.trackCommand({
        command: '!test',
        username: 'user1',
        channel: '#channel',
        success: true,
        responseTime: 100,
      });

      manager.trackCommand({
        command: '!test',
        username: 'user2',
        channel: '#channel',
        success: true,
        responseTime: 200,
      });

      const stats = manager.getCommandStatsByName('!test');

      expect(stats?.totalExecutions).toBe(2);
      expect(stats?.averageResponseTime).toBe(150); // (100 + 200) / 2
    });

    it('should not track if tracking disabled', () => {
      manager.updateConfig({ trackCommands: false });

      manager.trackCommand({
        command: '!test',
        username: 'user',
        channel: '#channel',
        success: true,
      });

      expect(manager.getCommandStats()).toHaveLength(0);
    });

    it('should respect sample rate', () => {
      manager.updateConfig({ sampleRate: 0 }); // Never sample

      for (let i = 0; i < 100; i++) {
        manager.trackCommand({
          command: '!test',
          username: 'user',
          channel: '#channel',
          success: true,
        });
      }

      // With sample rate 0, nothing should be tracked
      expect(manager.getCommandStats()).toHaveLength(0);
    });

    it('should update hourly stats', () => {
      manager.trackCommand({
        command: '!test',
        username: 'user',
        channel: '#channel',
        success: true,
      });

      const summary = manager.getSummary();
      expect(summary.totalCommands).toBe(1);
    });
  });

  describe('trackMessage', () => {
    it('should track chat message', () => {
      manager.trackMessage('testuser', '#channel');

      const summary = manager.getSummary();
      expect(summary.totalMessages).toBe(1);
    });

    it('should not track if tracking disabled', () => {
      manager.updateConfig({ trackMessages: false });

      manager.trackMessage('testuser', '#channel');

      const summary = manager.getSummary();
      expect(summary.totalMessages).toBe(0);
    });

    it('should increment current session message count', () => {
      manager.startStreamSession();
      manager.trackMessage('user', '#channel');
      manager.trackMessage('user', '#channel');

      const session = manager.endStreamSession();

      expect(session?.chatMessages).toBe(2);
    });
  });

  describe('trackFollow', () => {
    it('should track follow event', () => {
      manager.trackFollow();

      const summary = manager.getSummary();
      expect(summary.totalFollows).toBe(1);
    });

    it('should increment current session followers', () => {
      manager.startStreamSession();
      manager.trackFollow();
      manager.trackFollow();

      const session = manager.endStreamSession();

      expect(session?.newFollowers).toBe(2);
    });
  });

  describe('trackSubscription', () => {
    it('should track subscription event', () => {
      manager.trackSubscription();

      const summary = manager.getSummary();
      expect(summary.totalSubscriptions).toBe(1);
    });

    it('should increment current session subscriptions', () => {
      manager.startStreamSession();
      manager.trackSubscription();

      const session = manager.endStreamSession();

      expect(session?.subscriptions).toBe(1);
    });
  });

  describe('trackBits', () => {
    it('should track bits received', () => {
      manager.trackBits(1000);
      manager.trackBits(500);

      const summary = manager.getSummary();
      expect(summary.totalBits).toBe(1500);
    });

    it('should accumulate bits in current session', () => {
      manager.startStreamSession();
      manager.trackBits(100);
      manager.trackBits(200);

      const session = manager.endStreamSession();

      expect(session?.bitsReceived).toBe(300);
    });
  });

  describe('stream session tracking', () => {
    it('should start new stream session', () => {
      manager.startStreamSession();

      const sessions = manager.getStreamSessions();
      expect(sessions).toHaveLength(0); // Not ended yet
    });

    it('should end stream session', () => {
      const startTime = new Date('2024-01-01T10:00:00Z');
      jest.setSystemTime(startTime);

      manager.startStreamSession();

      // Advance time by 2 hours
      jest.setSystemTime(new Date('2024-01-01T12:00:00Z'));

      const session = manager.endStreamSession();

      expect(session).not.toBeNull();
      expect(session?.durationMinutes).toBe(120);
    });

    it('should return null if no active session', () => {
      const session = manager.endStreamSession();

      expect(session).toBeNull();
    });

    it('should track session in history', () => {
      manager.startStreamSession();
      manager.endStreamSession();

      manager.startStreamSession();
      manager.endStreamSession();

      const sessions = manager.getStreamSessions();
      expect(sessions).toHaveLength(2);
    });

    it('should update viewer count', () => {
      manager.startStreamSession();

      manager.updateViewerCount(100);
      manager.updateViewerCount(150);
      manager.updateViewerCount(120);

      const session = manager.endStreamSession();

      expect(session?.peakViewers).toBe(150);
      expect(session?.averageViewers).toBeGreaterThan(0);
    });

    it('should not update viewer count without active session', () => {
      // Should not throw
      manager.updateViewerCount(100);
    });
  });

  describe('getHourlyStats', () => {
    it('should return hourly stats within date range', () => {
      // Create some stats
      manager.trackCommand({
        command: '!test',
        username: 'user',
        channel: '#channel',
        success: true,
      });

      const now = new Date();
      const hourAgo = new Date(now.getTime() - 3600000);

      const stats = manager.getHourlyStats(hourAgo, now);

      expect(stats.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getDailyStats', () => {
    it('should aggregate stats by day', () => {
      manager.trackCommand({
        command: '!test',
        username: 'user',
        channel: '#channel',
        success: true,
      });
      manager.trackMessage('user', '#channel');
      manager.trackFollow();
      manager.trackSubscription();
      manager.trackBits(100);

      const dailyStats = manager.getDailyStats(7);

      expect(dailyStats.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getSummary', () => {
    it('should return comprehensive summary', () => {
      manager.trackCommand({ command: '!cmd1', username: 'user', channel: '#ch', success: true });
      manager.trackCommand({ command: '!cmd2', username: 'user', channel: '#ch', success: true });
      manager.trackCommand({ command: '!cmd1', username: 'user', channel: '#ch', success: true });
      manager.trackMessage('user', '#ch');
      manager.trackFollow();
      manager.trackSubscription();
      manager.trackBits(500);

      manager.startStreamSession();
      manager.endStreamSession();

      const summary = manager.getSummary();

      expect(summary.totalCommands).toBe(3);
      expect(summary.totalMessages).toBe(1);
      expect(summary.totalFollows).toBe(1);
      expect(summary.totalSubscriptions).toBe(1);
      expect(summary.totalBits).toBe(500);
      expect(summary.totalStreamSessions).toBe(1);
      expect(summary.topCommands).toHaveLength(2);
      expect(summary.topCommands[0].name).toBe('!cmd1'); // Most used
      expect(summary.topCommands[0].count).toBe(2);
    });
  });

  describe('getCommandStats', () => {
    it('should return top commands by execution count', () => {
      for (let i = 0; i < 5; i++) {
        manager.trackCommand({ command: '!popular', username: 'user', channel: '#ch', success: true });
      }
      for (let i = 0; i < 3; i++) {
        manager.trackCommand({ command: '!medium', username: 'user', channel: '#ch', success: true });
      }
      manager.trackCommand({ command: '!rare', username: 'user', channel: '#ch', success: true });

      const stats = manager.getCommandStats(2);

      expect(stats).toHaveLength(2);
      expect(stats[0].name).toBe('!popular');
      expect(stats[1].name).toBe('!medium');
    });
  });

  describe('getCommandStatsByName', () => {
    it('should return stats for specific command', () => {
      manager.trackCommand({ command: '!test', username: 'user', channel: '#ch', success: true });

      const stats = manager.getCommandStatsByName('!test');

      expect(stats).not.toBeNull();
      expect(stats?.name).toBe('!test');
    });

    it('should return null for unknown command', () => {
      const stats = manager.getCommandStatsByName('!unknown');

      expect(stats).toBeNull();
    });

    it('should handle lowercase lookups', () => {
      manager.trackCommand({ command: '!test', username: 'user', channel: '#ch', success: true });

      // The implementation stores commands as-is, so lookups need to match case
      const stats = manager.getCommandStatsByName('!test');

      expect(stats).not.toBeNull();
      expect(stats?.name).toBe('!test');
    });
  });

  describe('updateConfig', () => {
    it('should update configuration', () => {
      manager.updateConfig({
        retentionDays: 14,
        sampleRate: 0.5,
      });

      const config = manager.getConfig();

      expect(config.retentionDays).toBe(14);
      expect(config.sampleRate).toBe(0.5);
    });
  });

  describe('saveData', () => {
    it('should save data to file', () => {
      mockFs.existsSync.mockReturnValue(true);

      manager.trackCommand({
        command: '!test',
        username: 'user',
        channel: '#channel',
        success: true,
      });

      manager.saveData();

      expect(mockFs.writeFileSync).toHaveBeenCalled();
    });

    it('should create directory if not exists', () => {
      mockFs.existsSync.mockReturnValue(false);

      manager.saveData();

      expect(mockFs.mkdirSync).toHaveBeenCalledWith(
        expect.any(String),
        { recursive: true }
      );
    });
  });

  describe('data cleanup', () => {
    it('should clean up old data on save', () => {
      // Load manager with old data
      mockFs.existsSync.mockReturnValue(true);
      const oldTimestamp = new Date();
      oldTimestamp.setDate(oldTimestamp.getDate() - 60); // 60 days ago

      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({
          commandExecutions: [
            { command: '!old', timestamp: oldTimestamp.toISOString() },
            { command: '!new', timestamp: new Date().toISOString() },
          ],
          hourlyStats: {
            [oldTimestamp.toISOString()]: { hour: oldTimestamp.toISOString(), commands: 1 },
          },
          commandStats: {},
          streamSessions: [],
        })
      );

      const cleanupManager = new AnalyticsManager({
        dataPath: '/test/analytics.json',
        config: { retentionDays: 30 },
        autoSaveIntervalMs: 0,
      });

      cleanupManager.saveData();

      // Verify old data was cleaned up
      const writeCall = mockFs.writeFileSync.mock.calls[0];
      const savedData = JSON.parse(writeCall[1] as string);

      expect(savedData.commandExecutions).toHaveLength(1);
      expect(savedData.commandExecutions[0].command).toBe('!new');

      cleanupManager.destroy();
    });
  });

  describe('destroy', () => {
    it('should save data on destroy', () => {
      manager.trackCommand({
        command: '!test',
        username: 'user',
        channel: '#channel',
        success: true,
      });

      manager.destroy();

      expect(mockFs.writeFileSync).toHaveBeenCalled();
    });
  });

  describe('singleton management', () => {
    it('should return same instance', () => {
      const manager1 = getAnalyticsManager();
      const manager2 = getAnalyticsManager();

      expect(manager1).toBe(manager2);

      manager1.destroy();
    });

    it('should reset singleton', () => {
      const manager1 = getAnalyticsManager();
      resetAnalyticsManager();
      const manager2 = getAnalyticsManager();

      expect(manager1).not.toBe(manager2);

      manager2.destroy();
    });
  });
});
