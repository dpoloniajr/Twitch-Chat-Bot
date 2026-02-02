/**
 * Tests for Command Registry Module
 */

import { CommandRegistry, resetCommandRegistry } from '../../src/commands/registry';
import { CommandContext, ChatMessage, UserInfo } from '../../src/types';

describe('CommandRegistry', () => {
  let registry: CommandRegistry;

  // Helper to create mock context
  const createContext = (
    overrides: Partial<{
      username: string;
      isMod: boolean;
      isBroadcaster: boolean;
      args: string[];
    }> = {}
  ): CommandContext => {
    const userInfo: UserInfo = {
      userName: overrides.username || 'testuser',
      displayName: overrides.username || 'TestUser',
      isMod: overrides.isMod ?? false,
      isBroadcaster: overrides.isBroadcaster ?? false,
    };

    const msg: ChatMessage = { userInfo };

    return {
      channel: '#testchannel',
      username: overrides.username || 'testuser',
      displayName: overrides.username || 'TestUser',
      raw: '!test arg1 arg2',
      args: overrides.args || ['arg1', 'arg2'],
      msg,
    };
  };

  beforeEach(() => {
    resetCommandRegistry();
    registry = new CommandRegistry();
  });

  describe('register and get', () => {
    it('should register and retrieve a command', () => {
      const handler = { perm: 'everyone' as const, handler: jest.fn() };
      registry.register('!test', handler);

      expect(registry.get('!test')).toBe(handler);
    });

    it('should be case insensitive', () => {
      const handler = { perm: 'everyone' as const, handler: jest.fn() };
      registry.register('!Test', handler);

      expect(registry.get('!TEST')).toBe(handler);
      expect(registry.get('!test')).toBe(handler);
    });

    it('should handle aliases', () => {
      const handler = { perm: 'everyone' as const, handler: jest.fn() };
      registry.register('!shoutout', handler, ['!so']);

      expect(registry.get('!shoutout')).toBe(handler);
      expect(registry.get('!so')).toBe(handler);
    });

    it('should return undefined for non-existent command', () => {
      expect(registry.get('!nonexistent')).toBeUndefined();
    });
  });

  describe('unregister', () => {
    it('should remove a command', () => {
      const handler = { perm: 'everyone' as const, handler: jest.fn() };
      registry.register('!test', handler);

      const result = registry.unregister('!test');

      expect(result).toBe(true);
      expect(registry.get('!test')).toBeUndefined();
    });

    it('should remove associated aliases', () => {
      const handler = { perm: 'everyone' as const, handler: jest.fn() };
      registry.register('!test', handler, ['!t']);

      registry.unregister('!test');

      expect(registry.get('!t')).toBeUndefined();
    });

    it('should return false for non-existent command', () => {
      const result = registry.unregister('!nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('has', () => {
    it('should return true for existing command', () => {
      registry.register('!test', { perm: 'everyone', handler: jest.fn() });
      expect(registry.has('!test')).toBe(true);
    });

    it('should return true for alias', () => {
      registry.register('!test', { perm: 'everyone', handler: jest.fn() }, ['!t']);
      expect(registry.has('!t')).toBe(true);
    });

    it('should return false for non-existent command', () => {
      expect(registry.has('!nonexistent')).toBe(false);
    });
  });

  describe('permission checking', () => {
    it('should allow everyone for "everyone" permission', () => {
      registry.register('!test', { perm: 'everyone', handler: jest.fn() });

      expect(registry.checkPermission('!test', false, false)).toBe(true);
      expect(registry.checkPermission('!test', true, false)).toBe(true);
      expect(registry.checkPermission('!test', false, true)).toBe(true);
    });

    it('should only allow mods and broadcaster for "mod" permission', () => {
      registry.register('!test', { perm: 'mod', handler: jest.fn() });

      expect(registry.checkPermission('!test', false, false)).toBe(false);
      expect(registry.checkPermission('!test', true, false)).toBe(true);
      expect(registry.checkPermission('!test', false, true)).toBe(true);
    });

    it('should only allow broadcaster for "broadcaster" permission', () => {
      registry.register('!test', { perm: 'broadcaster', handler: jest.fn() });

      expect(registry.checkPermission('!test', false, false)).toBe(false);
      expect(registry.checkPermission('!test', true, false)).toBe(false);
      expect(registry.checkPermission('!test', false, true)).toBe(true);
    });
  });

  describe('cooldowns', () => {
    it('should track cooldowns', () => {
      registry.register('!test', { perm: 'everyone', handler: jest.fn() });
      registry.loadBuiltinConfig([{ name: '!test', cooldownSeconds: 60 }]);

      registry.setCooldown('!test', Date.now());

      expect(registry.isOnCooldown('!test', 60)).toBe(true);
    });

    it('should return false for expired cooldown', () => {
      registry.register('!test', { perm: 'everyone', handler: jest.fn() });
      registry.loadBuiltinConfig([{ name: '!test', cooldownSeconds: 60 }]);

      // Set cooldown 61 seconds ago
      registry.setCooldown('!test', Date.now() - 61000);

      expect(registry.isOnCooldown('!test', 60)).toBe(false);
    });

    it('should return remaining cooldown time', () => {
      registry.register('!test', { perm: 'everyone', handler: jest.fn() });
      registry.loadBuiltinConfig([{ name: '!test', cooldownSeconds: 60 }]);

      // Set cooldown 30 seconds ago
      registry.setCooldown('!test', Date.now() - 30000);

      const remaining = registry.getRemainingCooldown('!test', 60);
      expect(remaining).toBeGreaterThan(25);
      expect(remaining).toBeLessThanOrEqual(30);
    });
  });

  describe('execute', () => {
    it('should execute command handler', async () => {
      const handlerFn = jest.fn();
      registry.register('!test', { perm: 'everyone', handler: handlerFn });

      const context = createContext();
      const result = await registry.execute('!test', context);

      expect(result.success).toBe(true);
      expect(handlerFn).toHaveBeenCalledWith(context);
    });

    it('should reject execution without permission', async () => {
      registry.register('!test', { perm: 'mod', handler: jest.fn() });

      const context = createContext({ isMod: false, isBroadcaster: false });
      const result = await registry.execute('!test', context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('permission');
    });

    it('should reject execution on cooldown', async () => {
      registry.register('!test', { perm: 'everyone', handler: jest.fn() });
      registry.loadBuiltinConfig([{ name: '!test', cooldownSeconds: 60 }]);
      registry.setCooldown('!test', Date.now());

      const context = createContext();
      const result = await registry.execute('!test', context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('cooldown');
    });

    it('should handle handler errors gracefully', async () => {
      registry.register('!test', {
        perm: 'everyone',
        handler: () => {
          throw new Error('Handler error');
        },
      });

      const context = createContext();
      const result = await registry.execute('!test', context);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Handler error');
    });

    it('should return error for non-existent command', async () => {
      const context = createContext();
      const result = await registry.execute('!nonexistent', context);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Command not found');
    });
  });

  describe('getCommandNames', () => {
    it('should return all registered command names', () => {
      registry.register('!test1', { perm: 'everyone', handler: jest.fn() });
      registry.register('!test2', { perm: 'everyone', handler: jest.fn() });
      registry.register('!test3', { perm: 'everyone', handler: jest.fn() });

      const names = registry.getCommandNames();

      expect(names).toHaveLength(3);
      expect(names).toContain('!test1');
      expect(names).toContain('!test2');
      expect(names).toContain('!test3');
    });
  });

  describe('getAliases', () => {
    it('should return aliases for a command', () => {
      registry.register('!test', { perm: 'everyone', handler: jest.fn() }, [
        '!t',
        '!tst',
      ]);

      const aliases = registry.getAliases('!test');

      expect(aliases).toHaveLength(2);
      expect(aliases).toContain('!t');
      expect(aliases).toContain('!tst');
    });

    it('should return empty array for command without aliases', () => {
      registry.register('!test', { perm: 'everyone', handler: jest.fn() });

      const aliases = registry.getAliases('!test');

      expect(aliases).toHaveLength(0);
    });
  });

  describe('getCommandInfo', () => {
    it('should return command info for display', () => {
      registry.register('!test', { perm: 'mod', handler: jest.fn() }, ['!t']);
      registry.loadBuiltinConfig([{ name: '!test', cooldownSeconds: 30 }]);

      const info = registry.getCommandInfo();

      expect(info).toHaveLength(1);
      expect(info[0]).toMatchObject({
        name: '!test',
        permission: 'mod',
        aliases: ['!t'],
        cooldown: 30,
      });
    });
  });

  describe('clear', () => {
    it('should remove all commands', () => {
      registry.register('!test1', { perm: 'everyone', handler: jest.fn() });
      registry.register('!test2', { perm: 'everyone', handler: jest.fn() });

      registry.clear();

      expect(registry.getCommandNames()).toHaveLength(0);
    });
  });
});
