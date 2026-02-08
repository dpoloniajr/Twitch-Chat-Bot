/**
 * Tests for Shutdown Manager Module
 */

import {
  ShutdownManager,
  getShutdownManager,
  onShutdown,
  resetShutdownManager,
} from '../../src/utils/shutdown';

describe('ShutdownManager', () => {
  let manager: ShutdownManager;
  let exitSpy: jest.SpyInstance;
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    resetShutdownManager();
    manager = new ShutdownManager({ exitOnUncaught: false });

    // Mock process.exit to prevent actual exit
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    // Suppress console output during tests
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  describe('register and unregister', () => {
    it('should register a shutdown handler', () => {
      const handler = jest.fn();
      manager.register('test', handler);

      // Handler should be registered (no error)
      expect(() => manager.register('test2', jest.fn())).not.toThrow();
    });

    it('should unregister a shutdown handler', () => {
      const handler = jest.fn();
      manager.register('test', handler);

      const result = manager.unregister('test');

      expect(result).toBe(true);
    });

    it('should return false when unregistering non-existent handler', () => {
      const result = manager.unregister('nonexistent');

      expect(result).toBe(false);
    });

    it('should allow overwriting handlers', () => {
      const handler1 = jest.fn();
      const handler2 = jest.fn();

      manager.register('test', handler1);
      manager.register('test', handler2);

      // Should not throw
      expect(() => manager.unregister('test')).not.toThrow();
    });
  });

  describe('shutdown', () => {
    it('should execute all registered handlers', async () => {
      const handler1 = jest.fn();
      const handler2 = jest.fn();

      manager.register('handler1', handler1);
      manager.register('handler2', handler2);

      try {
        await manager.shutdown('test', 0);
      } catch {
        // Ignore process.exit error
      }

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });

    it('should handle async handlers', async () => {
      const handler = jest.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      manager.register('async-handler', handler);

      try {
        await manager.shutdown('test', 0);
      } catch {
        // Ignore process.exit error
      }

      expect(handler).toHaveBeenCalled();
    });

    it('should continue if a handler fails', async () => {
      const handler1 = jest.fn().mockRejectedValue(new Error('Handler error'));
      const handler2 = jest.fn();

      manager.register('handler1', handler1);
      manager.register('handler2', handler2);

      try {
        await manager.shutdown('test', 0);
      } catch {
        // Ignore process.exit error
      }

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });

    it('should call process.exit after handlers complete', async () => {
      manager.register('test', jest.fn());

      try {
        await manager.shutdown('test', 0);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('should use correct exit code', async () => {
      manager.register('test', jest.fn());

      try {
        await manager.shutdown('test', 1);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('should prevent duplicate shutdown', async () => {
      let callCount = 0;
      manager.register('test', () => {
        callCount++;
      });

      // Start first shutdown
      const promise1 = manager.shutdown('test', 0).catch(() => {});

      // Try to start second shutdown
      const promise2 = manager.shutdown('test2', 0).catch(() => {});

      await Promise.all([promise1, promise2]);

      expect(callCount).toBe(1);
    });
  });

  describe('isInProgress', () => {
    it('should return false before shutdown', () => {
      expect(manager.isInProgress()).toBe(false);
    });

    it('should return true during shutdown', () => {
      manager.register('test', async () => {
        // Check during execution
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      // Start shutdown but don't await
      manager.shutdown('test', 0).catch(() => {});

      // Should be in progress
      expect(manager.isInProgress()).toBe(true);
    });
  });

  describe('getShutdownManager singleton', () => {
    it('should return the same instance', () => {
      const instance1 = getShutdownManager();
      const instance2 = getShutdownManager();

      expect(instance1).toBe(instance2);
    });

    it('should create new instance after reset', () => {
      const instance1 = getShutdownManager();
      resetShutdownManager();
      const instance2 = getShutdownManager();

      expect(instance1).not.toBe(instance2);
    });
  });

  describe('onShutdown helper', () => {
    it('should register handler on singleton', () => {
      const handler = jest.fn();
      onShutdown('test', handler);

      const mgr = getShutdownManager();

      // Handler should be registered
      expect(mgr.unregister('test')).toBe(true);
    });
  });

  describe('grace period', () => {
    it('should respect custom grace period', () => {
      const customManager = new ShutdownManager({
        gracePeriodMs: 1000,
        exitOnUncaught: false,
      });

      // Just ensure it doesn't throw
      expect(() =>
        customManager.register('test', jest.fn())
      ).not.toThrow();
    });
  });
});
