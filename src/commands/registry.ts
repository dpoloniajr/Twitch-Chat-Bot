/**
 * Command Registry Module
 * Centralized command registration and dispatch
 */

import {
  CommandHandler,
  CommandContext,
  CommandPermission,
  CommandResult,
  BuiltinCommand,
} from '../types';
import { createLogger } from '../utils/logger';

const logger = createLogger('CommandRegistry');

/**
 * Command registry for managing bot commands
 */
export class CommandRegistry {
  private commands: Map<string, CommandHandler> = new Map();
  private aliases: Map<string, string> = new Map();
  private cooldowns: Map<string, number> = new Map();
  private builtinConfig: Map<string, BuiltinCommand> = new Map();

  /**
   * Register a command
   */
  register(
    name: string,
    handler: CommandHandler,
    aliases: string[] = []
  ): void {
    const normalizedName = name.toLowerCase();

    if (this.commands.has(normalizedName)) {
      logger.warn('Overwriting existing command', { name: normalizedName });
    }

    this.commands.set(normalizedName, handler);

    // Register aliases
    for (const alias of aliases) {
      const normalizedAlias = alias.toLowerCase();
      this.aliases.set(normalizedAlias, normalizedName);
    }

    logger.debug('Registered command', {
      name: normalizedName,
      aliases,
      permission: handler.perm,
    });
  }

  /**
   * Unregister a command
   */
  unregister(name: string): boolean {
    const normalizedName = name.toLowerCase();
    const removed = this.commands.delete(normalizedName);

    if (removed) {
      // Remove associated aliases
      for (const [alias, target] of this.aliases.entries()) {
        if (target === normalizedName) {
          this.aliases.delete(alias);
        }
      }
      logger.debug('Unregistered command', { name: normalizedName });
    }

    return removed;
  }

  /**
   * Get a command by name or alias
   */
  get(name: string): CommandHandler | undefined {
    const normalizedName = name.toLowerCase();

    // Check direct command
    const command = this.commands.get(normalizedName);
    if (command) return command;

    // Check aliases
    const targetName = this.aliases.get(normalizedName);
    if (targetName) {
      return this.commands.get(targetName);
    }

    return undefined;
  }

  /**
   * Check if a command exists
   */
  has(name: string): boolean {
    const normalizedName = name.toLowerCase();
    return (
      this.commands.has(normalizedName) || this.aliases.has(normalizedName)
    );
  }

  /**
   * Get the canonical name for a command or alias
   */
  getCanonicalName(name: string): string | undefined {
    const normalizedName = name.toLowerCase();

    if (this.commands.has(normalizedName)) {
      return normalizedName;
    }

    return this.aliases.get(normalizedName);
  }

  /**
   * Set cooldown for a command
   */
  setCooldown(name: string, timestampMs: number): void {
    const canonicalName = this.getCanonicalName(name);
    if (canonicalName) {
      this.cooldowns.set(canonicalName, timestampMs);
    }
  }

  /**
   * Check if a command is on cooldown
   */
  isOnCooldown(name: string, cooldownSeconds: number): boolean {
    if (!cooldownSeconds || cooldownSeconds <= 0) return false;

    const canonicalName = this.getCanonicalName(name);
    if (!canonicalName) return false;

    const lastUsed = this.cooldowns.get(canonicalName) || 0;
    return Date.now() - lastUsed < cooldownSeconds * 1000;
  }

  /**
   * Get remaining cooldown time in seconds
   */
  getRemainingCooldown(name: string, cooldownSeconds: number): number {
    if (!cooldownSeconds || cooldownSeconds <= 0) return 0;

    const canonicalName = this.getCanonicalName(name);
    if (!canonicalName) return 0;

    const lastUsed = this.cooldowns.get(canonicalName) || 0;
    const remainingMs = cooldownSeconds * 1000 - (Date.now() - lastUsed);
    return Math.max(0, Math.ceil(remainingMs / 1000));
  }

  /**
   * Load built-in command configuration
   */
  loadBuiltinConfig(configs: BuiltinCommand[]): void {
    this.builtinConfig.clear();
    for (const config of configs) {
      this.builtinConfig.set(config.name.toLowerCase(), config);
    }
    logger.info('Loaded builtin command config', { count: configs.length });
  }

  /**
   * Get cooldown for a command from builtin config
   */
  getConfiguredCooldown(name: string): number {
    const canonicalName = this.getCanonicalName(name) || name.toLowerCase();
    const config = this.builtinConfig.get(canonicalName);
    return config?.cooldownSeconds || 0;
  }

  /**
   * Check if a command is enabled
   */
  isEnabled(name: string): boolean {
    const canonicalName = this.getCanonicalName(name) || name.toLowerCase();
    const config = this.builtinConfig.get(canonicalName);
    return config?.enabled !== false;
  }

  /**
   * Check if user has permission for a command
   */
  checkPermission(
    name: string,
    isMod: boolean,
    isBroadcaster: boolean
  ): boolean {
    const handler = this.get(name);
    if (!handler) return false;

    switch (handler.perm) {
      case 'everyone':
        return true;
      case 'mod':
        return isMod || isBroadcaster;
      case 'broadcaster':
        return isBroadcaster;
      default:
        return false;
    }
  }

  /**
   * Execute a command
   */
  async execute(name: string, context: CommandContext): Promise<CommandResult> {
    const handler = this.get(name);

    if (!handler) {
      return { success: false, error: 'Command not found' };
    }

    // Check if command is enabled
    if (!this.isEnabled(name)) {
      return { success: false, error: 'Command is disabled' };
    }

    // Check permission
    const isMod = context.msg.userInfo.isMod;
    const isBroadcaster = context.msg.userInfo.isBroadcaster;

    if (!this.checkPermission(name, isMod, isBroadcaster)) {
      return {
        success: false,
        error: 'You do not have permission to use this command',
      };
    }

    // Check cooldown
    const cooldown = this.getConfiguredCooldown(name);
    if (this.isOnCooldown(name, cooldown)) {
      const remaining = this.getRemainingCooldown(name, cooldown);
      return {
        success: false,
        error: `Command is on cooldown. Try again in ${remaining}s`,
      };
    }

    try {
      await handler.handler(context);

      // Set cooldown after successful execution
      if (cooldown > 0) {
        this.setCooldown(name, Date.now());
      }

      return { success: true };
    } catch (error) {
      const err = error as Error;
      logger.error('Command execution failed', {
        command: name,
        error: err.message,
      });
      return { success: false, error: err.message };
    }
  }

  /**
   * Get all registered command names
   */
  getCommandNames(): string[] {
    return Array.from(this.commands.keys());
  }

  /**
   * Get all aliases for a command
   */
  getAliases(name: string): string[] {
    const canonicalName = this.getCanonicalName(name);
    if (!canonicalName) return [];

    const aliases: string[] = [];
    for (const [alias, target] of this.aliases.entries()) {
      if (target === canonicalName) {
        aliases.push(alias);
      }
    }
    return aliases;
  }

  /**
   * Get command info for display
   */
  getCommandInfo(): Array<{
    name: string;
    permission: CommandPermission;
    aliases: string[];
    cooldown: number;
    enabled: boolean;
  }> {
    return Array.from(this.commands.entries()).map(([name, handler]) => ({
      name,
      permission: handler.perm,
      aliases: this.getAliases(name),
      cooldown: this.getConfiguredCooldown(name),
      enabled: this.isEnabled(name),
    }));
  }

  /**
   * Clear all commands
   */
  clear(): void {
    this.commands.clear();
    this.aliases.clear();
    this.cooldowns.clear();
    logger.debug('Cleared all commands');
  }
}

// Singleton instance
let defaultRegistry: CommandRegistry | null = null;

/**
 * Get the default command registry
 */
export function getCommandRegistry(): CommandRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new CommandRegistry();
  }
  return defaultRegistry;
}

/**
 * Reset the command registry (for testing)
 */
export function resetCommandRegistry(): void {
  defaultRegistry = null;
}
