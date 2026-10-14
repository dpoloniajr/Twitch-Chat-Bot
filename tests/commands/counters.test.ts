/**
 * Tests for Counters Commands
 */

import { createCountersCommands, registerCountersCommands } from '../../src/commands/counters';
import { CountersManager } from '../../src/services/counters';
import { CommandContext } from '../../src/types';

// Mock the counters manager
jest.mock('../../src/services/counters', () => ({
  getCountersManager: jest.fn(),
  CountersManager: jest.fn(),
}));

describe('Counters Commands', () => {
  let mockManager: {
    increment: jest.Mock;
    decrement: jest.Mock;
    reset: jest.Mock;
    setValue: jest.Mock;
    getValue: jest.Mock;
    getAllCounters: jest.Mock;
    deleteCounter: jest.Mock;
    createCounter: jest.Mock;
    getHistory: jest.Mock;
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

  const runAsMod = (name: string, args: string[] = []) =>
    commands.get(name).handler(createMockContext('moduser', args, true));

  beforeEach(() => {
    mockManager = {
      increment: jest.fn().mockReturnValue({ success: true, counter: { value: 1 } }),
      decrement: jest.fn().mockReturnValue({ success: true, counter: { value: 0 } }),
      reset: jest.fn(),
      setValue: jest.fn(),
      getValue: jest.fn().mockReturnValue(0),
      getAllCounters: jest.fn().mockReturnValue([]),
      deleteCounter: jest.fn(),
      createCounter: jest.fn().mockReturnValue({ success: true }),
      getHistory: jest.fn().mockReturnValue([]),
    };

    commands = createCountersCommands(mockManager as unknown as CountersManager);
  });

  describe.each(['deaths', 'wins', 'losses'])('!%s command', (counter) => {
    const name = `!${counter}`;

    it('should display the count without a modifier', async () => {
      await runAsMod(name);
      expect(mockManager.getValue).toHaveBeenCalledWith(counter);
    });

    it.each(['+', 'add', '++'])('should increment with "%s"', async (mod) => {
      await runAsMod(name, [mod]);
      expect(mockManager.increment).toHaveBeenCalledWith(counter, 1, 'moduser');
    });

    it.each(['-', 'remove', '--'])('should decrement with "%s"', async (mod) => {
      await runAsMod(name, [mod]);
      expect(mockManager.decrement).toHaveBeenCalledWith(counter, 1, 'moduser');
    });

    it('should reset', async () => {
      await runAsMod(name, ['reset']);
      expect(mockManager.reset).toHaveBeenCalledWith(counter, 'moduser');
    });

    it('should set a valid value', async () => {
      await runAsMod(name, ['set', '7']);
      expect(mockManager.setValue).toHaveBeenCalledWith(counter, 7, 'moduser');
    });

    it('should ignore invalid set values', async () => {
      await runAsMod(name, ['set', 'abc']);
      await runAsMod(name, ['set', '-1']);
      expect(mockManager.setValue).not.toHaveBeenCalled();
    });

    it('should fall through to display for unknown modifiers', async () => {
      await runAsMod(name, ['bogus']);
      expect(mockManager.getValue).toHaveBeenCalledWith(counter);
    });

    it('should not let non-mods modify the counter', async () => {
      await commands.get(name).handler(createMockContext('viewer', ['+']));
      expect(mockManager.increment).not.toHaveBeenCalled();
      expect(mockManager.getValue).toHaveBeenCalledWith(counter);
    });

    it('should let the broadcaster modify the counter', async () => {
      await commands.get(name).handler(createMockContext('streamer', ['+'], false, true));
      expect(mockManager.increment).toHaveBeenCalledWith(counter, 1, 'streamer');
    });
  });

  describe('!score command', () => {
    it('should read wins and losses', async () => {
      mockManager.getValue.mockImplementation((n: string) => (n === 'wins' ? 3 : 1));
      await runAsMod('!score');
      expect(mockManager.getValue).toHaveBeenCalledWith('wins');
      expect(mockManager.getValue).toHaveBeenCalledWith('losses');
    });

    it('should handle no games played', async () => {
      mockManager.getValue.mockReturnValue(null);
      await expect(runAsMod('!score')).resolves.toBeUndefined();
    });
  });

  describe('!counter command', () => {
    it('should list all counters without arguments', async () => {
      await runAsMod('!counter');
      expect(mockManager.getAllCounters).toHaveBeenCalled();
    });

    it('should display a counter by lowercase name', async () => {
      await runAsMod('!counter', ['Jumps']);
      expect(mockManager.getValue).toHaveBeenCalledWith('jumps');
    });

    it('should increment, decrement and reset a custom counter', async () => {
      await runAsMod('!counter', ['jumps', '+']);
      await runAsMod('!counter', ['jumps', '-']);
      await runAsMod('!counter', ['jumps', 'reset']);
      expect(mockManager.increment).toHaveBeenCalledWith('jumps', 1, 'moduser');
      expect(mockManager.decrement).toHaveBeenCalledWith('jumps', 1, 'moduser');
      expect(mockManager.reset).toHaveBeenCalledWith('jumps', 'moduser');
    });

    it('should set a custom counter only with a valid value', async () => {
      await runAsMod('!counter', ['jumps', 'set', 'x']);
      expect(mockManager.setValue).not.toHaveBeenCalled();
      await runAsMod('!counter', ['jumps', 'set', '12']);
      expect(mockManager.setValue).toHaveBeenCalledWith('jumps', 12, 'moduser');
    });

    it('should delete a custom counter', async () => {
      await runAsMod('!counter', ['jumps', 'delete']);
      expect(mockManager.deleteCounter).toHaveBeenCalledWith('jumps');
    });

    it('should not let non-mods delete a counter', async () => {
      await commands.get('!counter').handler(createMockContext('viewer', ['jumps', 'delete']));
      expect(mockManager.deleteCounter).not.toHaveBeenCalled();
    });
  });

  describe('!newcounter command', () => {
    it('should have mod permission', () => {
      expect(commands.get('!newcounter').perm).toBe('mod');
    });

    it('should do nothing without arguments', async () => {
      await runAsMod('!newcounter');
      expect(mockManager.createCounter).not.toHaveBeenCalled();
    });

    it('should create a counter with default value 0', async () => {
      await runAsMod('!newcounter', ['Jumps']);
      expect(mockManager.createCounter).toHaveBeenCalledWith('jumps', 'moduser', { initialValue: 0 });
    });

    it('should create a counter with an initial value', async () => {
      mockManager.createCounter.mockReturnValue({ success: false });
      await runAsMod('!newcounter', ['jumps', '5']);
      expect(mockManager.createCounter).toHaveBeenCalledWith('jumps', 'moduser', { initialValue: 5 });
    });

    it('should reject invalid initial values', async () => {
      await runAsMod('!newcounter', ['jumps', 'abc']);
      await runAsMod('!newcounter', ['jumps', '-3']);
      expect(mockManager.createCounter).not.toHaveBeenCalled();
    });
  });

  describe('!counterhistory command', () => {
    it('should do nothing without arguments', async () => {
      await runAsMod('!counterhistory');
      expect(mockManager.getHistory).not.toHaveBeenCalled();
    });

    it('should get the last 5 history entries', async () => {
      await runAsMod('!counterhistory', ['Deaths']);
      expect(mockManager.getHistory).toHaveBeenCalledWith('deaths', 5);
    });
  });

  describe('registerCountersCommands', () => {
    it('should register all commands with aliases', () => {
      const registry = { register: jest.fn() };
      registerCountersCommands(registry, mockManager as unknown as CountersManager);

      expect(registry.register).toHaveBeenCalledTimes(7);
      expect(registry.register).toHaveBeenCalledWith('!deaths', expect.any(Object), ['!death', '!d']);
      expect(registry.register).toHaveBeenCalledWith('!counter', expect.any(Object), ['!c', '!count']);
      expect(registry.register).toHaveBeenCalledWith('!newcounter', expect.any(Object), []);
    });
  });
});
