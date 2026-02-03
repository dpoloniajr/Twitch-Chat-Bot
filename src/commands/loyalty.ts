/**
 * Loyalty Commands Module
 * Chat commands for the loyalty points system
 */

import { CommandHandler, CommandContext } from '../types';
import { LoyaltyManager, getLoyaltyManager } from '../services/loyalty';
import { createLogger } from '../utils/logger';

const logger = createLogger('LoyaltyCommands');

/**
 * Factory function to create loyalty commands
 */
export function createLoyaltyCommands(
  loyaltyManager?: LoyaltyManager
): Map<string, CommandHandler> {
  const manager = loyaltyManager || getLoyaltyManager();
  const commands = new Map<string, CommandHandler>();

  // !points - Check your points
  commands.set('!points', {
    perm: 'everyone',
    handler: async (ctx: CommandContext): Promise<void> => {
      const { channel, username, args } = ctx;
      const targetUser = args[0]?.replace('@', '') || username;

      const userData = manager.getUserData(targetUser);
      const rank = manager.getUserRank(targetUser);
      // Response would include points, level, rank
    },
  });

  // !leaderboard - Show top point holders
  commands.set('!leaderboard', {
    perm: 'everyone',
    handler: async (ctx: CommandContext): Promise<void> => {
      const { channel, username, args } = ctx;
      const limit = Math.min(parseInt(args[0] || '5', 10), 10);

      const leaders = manager.getLeaderboard(limit);
      // Response would show top users
    },
  });

  // !gamble - Gamble your points
  commands.set('!gamble', {
    perm: 'everyone',
    handler: async (ctx: CommandContext): Promise<void> => {
      const { channel, username, args } = ctx;
      const amountArg = args[0];

      if (!amountArg) {
        return;
      }

      const userData = manager.getUserData(username);
      const currentPoints = userData?.points || 0;

      let amount: number;
      if (amountArg.toLowerCase() === 'all') {
        amount = currentPoints;
      } else {
        amount = parseInt(amountArg, 10);
      }

      if (isNaN(amount) || amount <= 0) {
        return;
      }

      if (amount > currentPoints) {
        return;
      }

      // 50% chance to win
      const won = Math.random() >= 0.5;

      if (won) {
        manager.awardPoints(username, amount, 'Gamble win', 'bonus');
      } else {
        manager.setPoints(username, Math.max(0, currentPoints - amount), 'Gamble loss');
      }
    },
  });

  // !give - Give points to another user
  commands.set('!give', {
    perm: 'everyone',
    handler: async (ctx: CommandContext): Promise<void> => {
      const { channel, username, args } = ctx;
      const targetUser = args[0]?.replace('@', '');
      const amountArg = args[1];

      if (!targetUser || !amountArg) {
        return;
      }

      if (targetUser.toLowerCase() === username.toLowerCase()) {
        return;
      }

      const amount = parseInt(amountArg, 10);
      if (isNaN(amount) || amount <= 0) {
        return;
      }

      const result = manager.transferPoints(username, targetUser, amount);
      if (result.success) {
        // Transfer successful
      }
    },
  });

  // !addpoints - Add points to a user (mod only)
  commands.set('!addpoints', {
    perm: 'mod',
    handler: async (ctx: CommandContext): Promise<void> => {
      const { channel, username, args } = ctx;
      const targetUser = args[0]?.replace('@', '');
      const amountArg = args[1];

      if (!targetUser || !amountArg) {
        return;
      }

      const amount = parseInt(amountArg, 10);
      if (isNaN(amount) || amount <= 0) {
        return;
      }

      manager.awardPoints(targetUser, amount, `Added by ${username}`, 'bonus');
      logger.info('Mod added points', { mod: username, target: targetUser, amount });
    },
  });

  // !removepoints - Remove points from a user (mod only)
  commands.set('!removepoints', {
    perm: 'mod',
    handler: async (ctx: CommandContext): Promise<void> => {
      const { channel, username, args } = ctx;
      const targetUser = args[0]?.replace('@', '');
      const amountArg = args[1];

      if (!targetUser || !amountArg) {
        return;
      }

      const amount = parseInt(amountArg, 10);
      if (isNaN(amount) || amount <= 0) {
        return;
      }

      const userData = manager.getUserData(targetUser);
      const currentPoints = userData?.points || 0;
      const newPoints = Math.max(0, currentPoints - amount);

      manager.setPoints(targetUser, newPoints, `Removed by ${username}`);
      logger.info('Mod removed points', { mod: username, target: targetUser, amount });
    },
  });

  // !setpoints - Set a user's points (mod only)
  commands.set('!setpoints', {
    perm: 'mod',
    handler: async (ctx: CommandContext): Promise<void> => {
      const { channel, username, args } = ctx;
      const targetUser = args[0]?.replace('@', '');
      const amountArg = args[1];

      if (!targetUser || !amountArg) {
        return;
      }

      const amount = parseInt(amountArg, 10);
      if (isNaN(amount) || amount < 0) {
        return;
      }

      manager.setPoints(targetUser, amount, `Set by ${username}`);
      logger.info('Mod set points', { mod: username, target: targetUser, amount });
    },
  });

  return commands;
}

/**
 * Register all loyalty commands with a registry
 */
export function registerLoyaltyCommands(
  registry: { register: (name: string, handler: CommandHandler, aliases?: string[]) => void },
  loyaltyManager?: LoyaltyManager
): void {
  const commands = createLoyaltyCommands(loyaltyManager);

  // Register with aliases
  for (const [name, handler] of commands) {
    const aliases: string[] = [];

    switch (name) {
      case '!points':
        aliases.push('!balance', '!pts');
        break;
      case '!leaderboard':
        aliases.push('!top', '!lb');
        break;
      case '!gamble':
        aliases.push('!bet');
        break;
      case '!give':
        aliases.push('!gift', '!transfer');
        break;
    }

    registry.register(name, handler, aliases);
  }

  logger.info('Registered loyalty commands', { count: commands.size });
}
