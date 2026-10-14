/**
 * MESSAGE HANDLER: chat filters, dashboard chat log and loyalty award, chat
 * hype, first-time chatter welcome, then built-in / custom command routing.
 */

import { checkModPermission, type BotContext, type ChatMessage } from './context';
import type { FirstChatterSettings } from './config';
import type { ChatFilter } from './chat-filter';
import type { ChatHype } from './chat-hype';
import type { CustomCommands } from './custom-commands';
import type { DashboardClient } from './dashboard-client';
import type { RegisteredCommand } from './command-registry';

export interface MessageHandlerModules {
  filter: ChatFilter;
  hype: ChatHype;
  customCommands: CustomCommands;
  dashboard: DashboardClient;
  commandRegistry: Map<string, RegisteredCommand>;
  firstChatterConfig: FirstChatterSettings;
}

export interface MessageHandler {
  handleChatCommand: (channel: string, user: string | undefined, message: string, msg: ChatMessage) => Promise<void>;
  onMessage: (channel: string, user: string | undefined, message: string, msg: ChatMessage) => Promise<void>;
}

export function createMessageHandler(ctx: BotContext, m: MessageHandlerModules): MessageHandler {
  const { sendChatMessage, state } = ctx;
  const { filter, hype, commandRegistry, firstChatterConfig } = m;
  const chatFilters = filter.settings;

  // Handle built-in and custom commands
  async function handleChatCommand(channel: string, user: string | undefined, message: string, msg: ChatMessage): Promise<void> {
    const username = msg.userInfo?.userName || msg.userInfo?.displayName || user || 'unknown';
    const raw = message.trim();
    const parts = raw.split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);

    try {
      // Registry-based routing
      const displayName = msg.userInfo?.displayName || username;
      const entry = commandRegistry.get(command);
      if (entry) {
        if (entry.perm === 'mod' && !checkModPermission(msg, channel, username)) {
          sendChatMessage(channel, `@${username} Only moderators can use this command.`);
          return;
        }
        await entry.handler({ channel, username, displayName, raw, args, msg });
      } else {
        // Fallback to custom commands
        await m.customCommands.handleCustomCommand(channel, username, displayName, command, args, msg);
      }
    } catch (error) {
      console.error(`Error handling command ${command}:`, (error as Error).message);
    }
  }

  // Message handler - simplified with command dispatcher
  async function onMessage(channel: string, user: string | undefined, message: string, msg: ChatMessage): Promise<void> {
    try {
      const username = msg.userInfo?.userName || msg.userInfo?.displayName || user || 'unknown';
      const raw = message.trim();
      const isMod = msg.userInfo.isMod;
      const isBroadcaster = msg.userInfo.isBroadcaster;

      // Check chat filters (skip for moderators and broadcaster)
      if (!isMod && !isBroadcaster) {
        const violations = filter.checkChatFilters(raw, username);
        if (violations.length > 0) {
          console.log(`Chat filter violation from ${username}: ${violations.join(', ')}`);
          if (chatFilters.filterAction === 'timeout') {
            const timedOut = await filter.timeoutUser(channel, username, chatFilters.timeoutDurationSeconds);
            // Only claim the timeout when Twitch confirmed it; otherwise fall back to a warning
            sendChatMessage(channel, timedOut
              ? `@${username} Your message violated chat rules and you have been timed out.`
              : `@${username} Your message violated chat rules. Please be respectful.`);
            return; // Don't log, award or run the offending message
          } else if (chatFilters.filterAction === 'warn') {
            sendChatMessage(channel, `@${username} Your message violated chat rules. Please be respectful.`);
          } else if (chatFilters.filterAction === 'delete') {
            if (!await filter.deleteMessage(msg.id)) {
              console.warn(`Could not delete the message from ${username} on Twitch`);
            }
            return; // Don't process message further
          }
        }
      }

      // Log chat to dashboard
      ctx.http.post(`${ctx.dashboardBaseUrl}/api/chat`, { channel, user: username, message }).catch(() => {});

      // Loyalty: award points for chat message (cooldown and config applied by dashboard)
      ctx.http.post(`${ctx.dashboardBaseUrl}/api/loyalty/award-message`, {
        username,
        isSubscriber: msg.userInfo?.isSubscriber ?? false,
        isVip: msg.userInfo?.isVip ?? false
      }, { timeout: 3000 }).catch(() => {});

      // Chat Hype: record message and trigger hype if threshold reached
      hype.recordChatForHype(channel);
      hype.tryTriggerHype(channel);

      // First-time chatter welcome (Twitch IRC tag first-msg; isFirst is on msg, not msg.userInfo)
      const isFirstChatter = msg.isFirst === true;
      if (isFirstChatter && (firstChatterConfig.welcomeEnabled || firstChatterConfig.alertEnabled)) {
        const displayName = msg.userInfo?.displayName || username;
        if (firstChatterConfig.welcomeEnabled && firstChatterConfig.welcomeMessage) {
          const welcomeText = firstChatterConfig.welcomeMessage.replace(/\{user\}/gi, displayName);
          sendChatMessage(channel, welcomeText);
        }
        if (firstChatterConfig.alertEnabled) {
          m.dashboard.sendAlert('first_chatter', { user: displayName });
        }
      }

      // Check if message starts with a command or matches a custom command
      const firstWord = raw.split(/\s+/)[0].toLowerCase();
      const isBuiltin = firstWord.startsWith('!');
      const isCustom = state.customCommands.some(c => c.name.toLowerCase() === firstWord);

      if (isBuiltin || isCustom) {
        await handleChatCommand(channel, user, message, msg);
      }
    } catch (error) {
      console.error('Error in message handler:', (error as Error).message);
    }
  }

  return { handleChatCommand, onMessage };
}
