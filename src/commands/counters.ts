/**
 * Counters Commands Module
 * Chat commands for the counter system (deaths, wins, losses, etc.)
 */

import { CommandHandler, CommandContext } from '../types';
import { CountersManager, getCountersManager } from '../services/counters';
import { createLogger } from '../utils/logger';

const logger = createLogger('CountersCommands');

/**
 * Factory function to create counter commands
 */
export function createCountersCommands(
  countersManager?: CountersManager
): Map<string, CommandHandler> {
  const manager = countersManager || getCountersManager();
  const commands = new Map<string, CommandHandler>();

  // !deaths - Get or modify death counter
  commands.set('!deaths', {
    perm: 'everyone',
    handler: async (ctx: CommandContext): Promise<void> => {
      const { username, args, msg } = ctx;
      const isMod = msg.userInfo.isMod || msg.userInfo.isBroadcaster;

      const modifier = args[0];

      if (modifier && isMod) {
        if (modifier === '+' || modifier === 'add' || modifier === '++') {
          const result = manager.increment('deaths', 1, username);
          if (result.success && result.counter) {
            // Response would go here if we had a chat client
          }
          return;
        } else if (modifier === '-' || modifier === 'remove' || modifier === '--') {
          const result = manager.decrement('deaths', 1, username);
          if (result.success && result.counter) {
            // Response would go here
          }
          return;
        } else if (modifier === 'reset') {
          manager.reset('deaths', username);
          return;
        } else if (modifier === 'set') {
          const value = parseInt(args[1], 10);
          if (!isNaN(value) && value >= 0) {
            manager.setValue('deaths', value, username);
          }
          return;
        }
      }

      // Just display the count (would be sent via chat client)
      void manager.getValue('deaths');
    },
  });

  // !wins - Get or modify win counter
  commands.set('!wins', {
    perm: 'everyone',
    handler: async (ctx: CommandContext): Promise<void> => {
      const { username, args, msg } = ctx;
      const isMod = msg.userInfo.isMod || msg.userInfo.isBroadcaster;

      const modifier = args[0];

      if (modifier && isMod) {
        if (modifier === '+' || modifier === 'add' || modifier === '++') {
          manager.increment('wins', 1, username);
          return;
        } else if (modifier === '-' || modifier === 'remove' || modifier === '--') {
          manager.decrement('wins', 1, username);
          return;
        } else if (modifier === 'reset') {
          manager.reset('wins', username);
          return;
        } else if (modifier === 'set') {
          const value = parseInt(args[1], 10);
          if (!isNaN(value) && value >= 0) {
            manager.setValue('wins', value, username);
          }
          return;
        }
      }

      void manager.getValue('wins');
    },
  });

  // !losses - Get or modify loss counter
  commands.set('!losses', {
    perm: 'everyone',
    handler: async (ctx: CommandContext): Promise<void> => {
      const { username, args, msg } = ctx;
      const isMod = msg.userInfo.isMod || msg.userInfo.isBroadcaster;

      const modifier = args[0];

      if (modifier && isMod) {
        if (modifier === '+' || modifier === 'add' || modifier === '++') {
          manager.increment('losses', 1, username);
          return;
        } else if (modifier === '-' || modifier === 'remove' || modifier === '--') {
          manager.decrement('losses', 1, username);
          return;
        } else if (modifier === 'reset') {
          manager.reset('losses', username);
          return;
        } else if (modifier === 'set') {
          const value = parseInt(args[1], 10);
          if (!isNaN(value) && value >= 0) {
            manager.setValue('losses', value, username);
          }
          return;
        }
      }

      void manager.getValue('losses');
    },
  });

  // !score - Show combined win/loss record
  commands.set('!score', {
    perm: 'everyone',
    handler: async (): Promise<void> => {
      const wins = manager.getValue('wins') || 0;
      const losses = manager.getValue('losses') || 0;
      const total = wins + losses;
      // Calculate win rate for response (would be sent via chat client)
      void (total > 0 ? ((wins / total) * 100).toFixed(1) : '0.0');
    },
  });

  // !counter - Generic counter command for custom counters
  commands.set('!counter', {
    perm: 'everyone',
    handler: async (ctx: CommandContext): Promise<void> => {
      const { username, args, msg } = ctx;
      const isMod = msg.userInfo.isMod || msg.userInfo.isBroadcaster;

      if (args.length === 0) {
        // List all counters (would be sent via chat client)
        void manager.getAllCounters();
        return;
      }

      const counterName = args[0].toLowerCase();
      const modifier = args[1];

      if (modifier && isMod) {
        if (modifier === '+' || modifier === 'add' || modifier === '++') {
          manager.increment(counterName, 1, username);
          return;
        } else if (modifier === '-' || modifier === 'remove' || modifier === '--') {
          manager.decrement(counterName, 1, username);
          return;
        } else if (modifier === 'reset') {
          manager.reset(counterName, username);
          return;
        } else if (modifier === 'set') {
          const value = parseInt(args[2], 10);
          if (!isNaN(value) && value >= 0) {
            manager.setValue(counterName, value, username);
          }
          return;
        } else if (modifier === 'delete') {
          manager.deleteCounter(counterName);
          logger.info('Counter deleted', { name: counterName, deletedBy: username });
          return;
        }
      }

      // Just display the count (would be sent via chat client)
      void manager.getValue(counterName);
    },
  });

  // !newcounter - Create a new counter (mod only)
  commands.set('!newcounter', {
    perm: 'mod',
    handler: async (ctx: CommandContext): Promise<void> => {
      const { username, args } = ctx;

      if (args.length === 0) {
        return;
      }

      const counterName = args[0].toLowerCase();
      const initialValue = args[1] ? parseInt(args[1], 10) : 0;

      if (isNaN(initialValue) || initialValue < 0) {
        return;
      }

      const result = manager.createCounter(counterName, username, { initialValue });
      if (result.success) {
        logger.info('Counter created', { name: counterName, value: initialValue, createdBy: username });
      }
    },
  });

  // !counterhistory - View counter history (mod only)
  commands.set('!counterhistory', {
    perm: 'mod',
    handler: async (ctx: CommandContext): Promise<void> => {
      const { args } = ctx;

      if (args.length === 0) {
        return;
      }

      const counterName = args[0].toLowerCase();
      // Get history (would be sent via chat client)
      void manager.getHistory(counterName, 5);
    },
  });

  return commands;
}

/**
 * Register all counter commands with a registry
 */
export function registerCountersCommands(
  registry: { register: (name: string, handler: CommandHandler, aliases?: string[]) => void },
  countersManager?: CountersManager
): void {
  const commands = createCountersCommands(countersManager);

  // Register with aliases
  for (const [name, handler] of commands) {
    const aliases: string[] = [];

    switch (name) {
      case '!deaths':
        aliases.push('!death', '!d');
        break;
      case '!wins':
        aliases.push('!win', '!w');
        break;
      case '!losses':
        aliases.push('!loss', '!l');
        break;
      case '!score':
        aliases.push('!record', '!stats');
        break;
      case '!counter':
        aliases.push('!c', '!count');
        break;
    }

    registry.register(name, handler, aliases);
  }

  logger.info('Registered counter commands', { count: commands.size });
}
