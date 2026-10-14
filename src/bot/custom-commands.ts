/**
 * Custom commands: loaded from the dashboard (cached, refreshed on a timer),
 * gated by their permission level and cooldown, and rendered from a response
 * template with optional fetched {data}.
 */

import { readCommandRefreshMs } from './config';
import type { BotContext, ChatMessage, CustomCommand, HttpError } from './context';
import { checkFetchUrl, createGuardedLookup, INTERNAL_URL_ERROR, refuseInternalRedirect } from './fetch-guard';

/** Resolves fetch hostnames and refuses internal addresses at connect time */
const guardedLookup = createGuardedLookup();

export interface TemplateContext {
  user?: string;
  displayName?: string;
  channel?: string;
  target?: string;
  data?: string;
}

export type RenderResult = { rendered: string; error?: undefined } | { success: false; error: string; rendered?: undefined };

export function formatResponse(template: string, ctx: TemplateContext): string {
  return template
    .replace(/\{user\}/gi, ctx.user || '')
    .replace(/\{displayname\}/gi, ctx.displayName || ctx.user || '')
    .replace(/\{channel\}/gi, ctx.channel || '')
    .replace(/\{target\}/gi, ctx.target || '')
    .replace(/\{data\}/gi, ctx.data || '')
    .trim();
}

export interface CustomCommands {
  loadCustomCommands: () => Promise<void>;
  /**
   * Fetch the commands now, ignoring the cache. On failure the loaded commands are kept.
   * @returns whether the dashboard answered
   */
  reloadCustomCommands: () => Promise<boolean>;
  /** Run `listener` after every dashboard fetch (used to reload the built-in command config too) */
  onRefresh: (listener: () => Promise<void>) => void;
  /** Drop the cache so the next load fetches fresh commands */
  invalidateCache: () => void;
  /** Re-read COMMAND_REFRESH_INTERVAL; returns the cache TTL / refresh period in ms */
  refreshCacheTtl: () => number;
  getCacheTtl: () => number;
  renderCustomCommand: (cmd: CustomCommand, context: TemplateContext) => Promise<RenderResult>;
  handleCustomCommand: (channel: string, username: string, displayName: string, command: string, args: string[], msg: ChatMessage) => Promise<void>;
}

/** Whether the sender may run a command stored with `level` ('everyone', 'mod' or 'broadcaster') */
export function hasCommandLevel(level: unknown, msg: ChatMessage): boolean {
  const { isMod, isBroadcaster } = msg.userInfo;
  if (level === 'broadcaster') return isBroadcaster;
  if (level === 'mod') return isMod || isBroadcaster;
  return true;
}

export function createCustomCommands(ctx: BotContext): CustomCommands {
  const { state, sendChatMessage } = ctx;

  // Custom command caching; a load started while another is pending is skipped
  let customCommandsCache: CustomCommand[] | null = null;
  let customCommandsCacheTime = 0;
  let customCommandsLoadPending = false;
  let CUSTOM_COMMANDS_CACHE_TTL = readCommandRefreshMs(ctx.env);
  const refreshListeners: Array<() => Promise<void>> = [];
  /** lowercased command name -> time it last ran (ms); cooldowns are channel-wide like built-ins */
  const lastUsed = new Map<string, number>();

  // Load custom commands from dashboard with caching
  async function loadCustomCommands(): Promise<void> {
    // Return cache if still valid
    if (customCommandsCache !== null && (Date.now() - customCommandsCacheTime) < CUSTOM_COMMANDS_CACHE_TTL) {
      return;
    }

    // Prevent duplicate simultaneous requests
    if (customCommandsLoadPending) {
      return;
    }

    customCommandsLoadPending = true;

    try {
      await fetchCustomCommands();
    } catch (error) {
      // Use cached value if available, even if expired
      if (customCommandsCache !== null) {
        state.customCommands = customCommandsCache;
        console.warn(`⚠️  Dashboard unreachable, using cached commands (${state.customCommands.length})`);
      } else {
        state.customCommands = [];
        console.error(`✗ Failed to load custom commands: ${(error as Error).message}`);
        console.error(`   Make sure dashboard is running: npm run dashboard`);
      }
    } finally {
      customCommandsLoadPending = false;
      await notifyRefresh();
    }
  }

  /** GET the commands from the dashboard and make them current (throws on failure) */
  async function fetchCustomCommands(): Promise<void> {
    const res = await ctx.http.get(`${ctx.dashboardBaseUrl}/api/custom-commands`, { timeout: 5000 });
    state.customCommands = res.data || [];
    customCommandsCache = state.customCommands;
    customCommandsCacheTime = Date.now();
    const customCommands = state.customCommands;
    console.log(`✓ Loaded ${customCommands.length} custom command(s)${customCommands.length > 0 ? ': ' + customCommands.map(c => c.name).join(', ') : ''}`);
  }

  async function reloadCustomCommands(): Promise<boolean> {
    try {
      await fetchCustomCommands();
      return true;
    } catch (error) {
      console.error(`✗ Failed to reload custom commands, keeping ${state.customCommands.length}: ${(error as Error).message}`);
      return false;
    } finally {
      await notifyRefresh();
    }
  }

  async function notifyRefresh(): Promise<void> {
    for (const listener of refreshListeners) {
      try {
        await listener();
      } catch (err) {
        console.error('Command refresh listener failed:', (err as Error).message);
      }
    }
  }

  function invalidateCache(): void {
    customCommandsCache = null; // Force fresh load
    customCommandsCacheTime = 0;
  }

  function refreshCacheTtl(): number {
    // Re-read interval from env (in case it was updated via dashboard)
    CUSTOM_COMMANDS_CACHE_TTL = readCommandRefreshMs(ctx.env);
    return CUSTOM_COMMANDS_CACHE_TTL;
  }

  async function renderCustomCommand(cmd: CustomCommand, context: TemplateContext): Promise<RenderResult> {
    let data = '';

    if (cmd.fetchEnabled && cmd.fetchUrl) {
      try {
        // Validate URL to prevent SSRF attacks: literal internal hosts are refused here,
        // hostnames when they resolve (guardedLookup) and redirects before they are followed
        const url = new URL(cmd.fetchUrl);
        const refused = checkFetchUrl(url);
        if (refused) {
          return { success: false, error: refused };
        }

        const resp = await ctx.rawHttp.get(cmd.fetchUrl, {
          timeout: 5000,
          lookup: guardedLookup,
          beforeRedirect: refuseInternalRedirect
        });
        data = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
      } catch (e) {
        const err = e as HttpError;
        if (err.message === INTERNAL_URL_ERROR) {
          return { success: false, error: err.message };
        }
        return { success: false, error: `Failed to fetch URL: ${err.message}` };
      }
    }

    const template = (cmd.response && cmd.response.trim().length > 0) ? cmd.response : '{data}';
    const rendered = formatResponse(template, { ...context, data });
    return { rendered };
  }

  async function handleCustomCommand(
    channel: string, username: string, displayName: string, command: string, args: string[], msg: ChatMessage
  ): Promise<void> {
    const customCommands = state.customCommands;
    const cmd = customCommands.find(c => c.name.toLowerCase() === command);
    if (!cmd) {
      console.log(`Custom command not found: ${command} (${customCommands.length} command(s) available: ${customCommands.map(c => c.name).join(', ') || 'none'})`);
      return;
    }

    if (!hasCommandLevel(cmd.level, msg)) {
      const who = cmd.level === 'broadcaster' ? 'the broadcaster' : 'moderators';
      sendChatMessage(channel, `@${username} Only ${who} can use this command.`);
      return;
    }

    // On cooldown: stay silent, since a name without "!" can match ordinary chat
    const cooldownMs = (Number(cmd.cooldownSeconds) || 0) * 1000;
    if (cooldownMs > 0 && Date.now() - (lastUsed.get(command) ?? -Infinity) < cooldownMs) {
      return;
    }

    const { rendered, error } = await renderCustomCommand(cmd, {
      user: username,
      displayName: displayName || username,
      channel,
      target: args[0] || ''
    });

    if (error) {
      // A failed run does not start the cooldown
      sendChatMessage(channel, `@${username} Error: ${error}`);
      return;
    }
    if (rendered) {
      sendChatMessage(channel, rendered);
    }
    lastUsed.set(command, Date.now());
  }

  return {
    loadCustomCommands,
    reloadCustomCommands,
    onRefresh: (listener) => { refreshListeners.push(listener); },
    invalidateCache,
    refreshCacheTtl,
    getCacheTtl: () => CUSTOM_COMMANDS_CACHE_TTL,
    renderCustomCommand,
    handleCustomCommand
  };
}
