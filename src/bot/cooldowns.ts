/**
 * Command cooldowns and the built-in command configuration (cooldown seconds)
 * loaded from the dashboard.
 */

import type { BotContext } from './context';

export interface Cooldowns {
  /** command key -> time it was last used (ms) */
  commandCooldowns: Map<string, number>;
  loadBuiltinCommands: () => Promise<void>;
  getCommandCooldown: (commandName: string) => number;
  isOnCooldown: (cmdName: string, cooldownSeconds: number) => boolean;
  setCooldown: (cmdName: string) => void;
  /** Seconds left on `cmdName`'s cooldown, rounded up, at least 1 */
  remainingSeconds: (cmdName: string, cooldownSeconds: number) => number;
}

export function createCooldowns(ctx: BotContext): Cooldowns {
  const commandCooldowns = new Map<string, number>();

  // Load built-in command configuration (at startup and on every command refresh)
  async function loadBuiltinCommands(): Promise<void> {
    try {
      const response = await ctx.http.get(`${ctx.dashboardBaseUrl}/api/builtin-commands`);
      ctx.state.builtinCommands = response.data || [];
      console.log(`✓ Loaded ${ctx.state.builtinCommands.length} built-in command configurations`);
    } catch (err) {
      // Keep the cooldowns already loaded rather than dropping them all
      console.error(`Failed to load built-in commands config, keeping ${ctx.state.builtinCommands.length}:`, (err as Error).message);
    }
  }

  // Get cooldown for a command
  function getCommandCooldown(commandName: string): number {
    const cmd = ctx.state.builtinCommands.find(c => c.name === commandName);
    return cmd ? (cmd.cooldownSeconds || 0) : 0;
  }

  function isOnCooldown(cmdName: string, cooldownSeconds: number): boolean {
    if (!cooldownSeconds || cooldownSeconds <= 0) return false;
    const last = commandCooldowns.get(cmdName) || 0;
    return Date.now() - last < cooldownSeconds * 1000;
  }

  function setCooldown(cmdName: string): void {
    commandCooldowns.set(cmdName, Date.now());
  }

  function remainingSeconds(cmdName: string, cooldownSeconds: number): number {
    const remainingMs = cooldownSeconds * 1000 - (Date.now() - (commandCooldowns.get(cmdName) || 0));
    return Math.max(1, Math.ceil(remainingMs / 1000));
  }

  return { commandCooldowns, loadBuiltinCommands, getCommandCooldown, isOnCooldown, setCooldown, remainingSeconds };
}
