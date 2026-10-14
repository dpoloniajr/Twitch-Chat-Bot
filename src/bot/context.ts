/**
 * Shared bot state and dependencies.
 *
 * Excella.js kept these as module-level variables; here they live on one
 * context object that every bot module receives, so a bot can be created,
 * started and inspected without load-time side effects.
 */

import type { AxiosInstance, AxiosStatic } from 'axios';
import type { TwitchHelixAPI } from '../lib/twitch-helix-api';
import type { TwitchIRCClient, ChatMessage } from '../lib/twitch-irc-client';
import type { TwitchEventSubWS, TwitchEventSubWSOptions } from '../lib/twitch-eventsub-ws';
import type { TokenManager, TokenCache, AccountType } from '../lib/token-manager';
import type { BotConfig, Env } from './config';

export type { ChatMessage };

/** Raw axios for calls that must not carry the dashboard secret header */
export type RawHttp = Pick<AxiosStatic, 'get' | 'patch'>;

/** A custom command as stored by the dashboard */
export interface CustomCommand {
  name: string;
  response?: string;
  fetchEnabled?: boolean;
  fetchUrl?: string;
  [key: string]: unknown;
}

/** A built-in command's dashboard configuration */
export interface BuiltinCommandConfig {
  name: string;
  cooldownSeconds?: number;
  [key: string]: unknown;
}

/** Error shape thrown by axios (and plain Errors, which simply lack `response`) */
export interface HttpError {
  message: string;
  response?: { status?: number; data?: any };
  toString(): string;
}

export interface BotDeps {
  /** Environment to read settings from and write refreshed tokens/scopes into (process.env in production) */
  env: Env;
  /** Validated Twitch configuration */
  config: BotConfig;
  /** Axios instance for dashboard and Helix calls (carries the dashboard secret header) */
  http: AxiosInstance;
  /** Plain axios, used where Excella.js called axios directly */
  rawHttp: RawHttp;
  tokenManager: TokenManager;
  /** Helix client for the bot token */
  apiClient: TwitchHelixAPI;
  /** Helix client for the broadcaster token, when one is configured */
  broadcasterApiClient: TwitchHelixAPI | null;
  chatClient: TwitchIRCClient;
  /** Build a Helix client for a broadcaster token (used when one first appears via refresh) */
  createBroadcasterApiClient: (accessToken: string) => TwitchHelixAPI;
  createEventSub: (options: TwitchEventSubWSOptions) => TwitchEventSubWS;
  /** Absolute path of dashboard/logs/restart.flag */
  restartFlagPath: string;
  /** Ends the process (process.exit in production) */
  exit: (code: number) => never;
  /** Filesystem calls used by the restart watcher */
  fs: { existsSync: (p: string) => boolean; unlinkSync: (p: string) => void };
}

export interface BotState {
  broadcasterId: string | null;
  broadcasterUserId: string | null;
  tokenUserId: string | null;
  botStartTime: number;
  initComplete: boolean;
  customCommands: CustomCommand[];
  builtinCommands: BuiltinCommandConfig[];
  eventSub: TwitchEventSubWS | null;
  broadcasterEventSub: TwitchEventSubWS | null;
  broadcasterApiClient: TwitchHelixAPI | null;
}

export interface BotContext extends Omit<BotDeps, 'broadcasterApiClient'> {
  state: BotState;
  dashboardBaseUrl: string;
  /** Live token validation results (scopes, expiry), kept up to date by tokenManager */
  cachedTokenValidation: Record<AccountType, TokenCache>;
  /** Send chat message with consistent formatting */
  sendChatMessage: (channel: string, message: unknown) => void;
}

export function createContext(deps: BotDeps, dashboardBaseUrl: string): BotContext {
  const { broadcasterApiClient, ...rest } = deps;
  const ctx: BotContext = {
    ...rest,
    state: {
      broadcasterId: null,
      broadcasterUserId: null,
      tokenUserId: null,
      botStartTime: Date.now(),
      initComplete: false,
      customCommands: [],
      builtinCommands: [],
      eventSub: null,
      broadcasterEventSub: null,
      broadcasterApiClient
    },
    dashboardBaseUrl,
    cachedTokenValidation: deps.tokenManager.cache,
    sendChatMessage(channel, message) {
      try {
        const msgStr = String(message || '').trim();
        if (!msgStr) return;
        ctx.chatClient.say(channel, msgStr);
      } catch (error) {
        console.error(`Failed to send message to ${channel}:`, (error as Error).message);
      }
    }
  };
  return ctx;
}

// Check if user has moderator or broadcaster permissions
export function checkModPermission(msg: ChatMessage, channel: string, username: string): boolean {
  const isMod = msg.userInfo.isMod;
  const isBroadcaster = msg.userInfo.isBroadcaster;
  return isMod || isBroadcaster;
}
