/**
 * createBot: wires the bot's modules around injected clients and returns
 * start/stop. Nothing connects or schedules timers until start() is called.
 */

import { createAnnouncements } from './announcements';
import { applyRefreshedTokens, checkRequiredScopes, validateAndRefreshTokens } from './auth';
import { createChannelCommands } from './channel-commands';
import { createChatFilter } from './chat-filter';
import { createChatHype } from './chat-hype';
import { createCommandRegistry } from './command-registry';
import {
  readAnnouncementSettings,
  readChatFilterSettings,
  readDashboardBaseUrl,
  readFirstChatterSettings,
  readHypeSettings,
  readHypeWindowMs
} from './config';
import { createContext, type BotContext, type BotDeps } from './context';
import { createCooldowns } from './cooldowns';
import { createCustomCommands } from './custom-commands';
import { createDashboardClient } from './dashboard-client';
import { createEventSubSetup } from './eventsub';
import { createFunCommands } from './fun-commands';
import { createLoyaltyCommands } from './loyalty-commands';
import { createMessageHandler } from './message-handler';
import { createPollCommands } from './polls';
import { createSongCommands } from './song-requests';
import { createTTS } from './tts';
import { createYouTubeClient } from './youtube';
import { RESTART_EXIT_CODE } from './restart';

export interface Bot {
  ctx: BotContext;
  /** Starts the restart watcher, then validates tokens, initializes, loads commands and connects to chat */
  start: () => Promise<void>;
  /** Stops timers and EventSub listeners and disconnects from chat */
  stop: () => Promise<void>;
  /** Exposed for tests and tooling */
  modules: ReturnType<typeof createModules>;
}

function createModules(ctx: BotContext) {
  const { env } = ctx;
  const dashboard = createDashboardClient(ctx);
  const cooldowns = createCooldowns(ctx);
  const filter = createChatFilter(ctx, readChatFilterSettings(env));
  const firstChatterConfig = readFirstChatterSettings(env);
  const hype = createChatHype(ctx, readHypeSettings(env), readHypeWindowMs(env));
  const announcements = createAnnouncements(ctx, readAnnouncementSettings(env));
  const tts = createTTS(ctx, filter, dashboard);
  const eventSub = createEventSubSetup(ctx, dashboard, tts);
  const channelCommands = createChannelCommands(ctx, cooldowns, dashboard);
  const polls = createPollCommands(ctx, dashboard);
  const fun = createFunCommands(ctx);
  const loyalty = createLoyaltyCommands(ctx, dashboard);
  const youtube = createYouTubeClient(ctx.http, env.YOUTUBE_API_KEY || '');
  const songs = createSongCommands(ctx, cooldowns, dashboard, youtube);
  const customCommands = createCustomCommands(ctx);
  const commandRegistry = createCommandRegistry(ctx, {
    cooldowns, channelCommands, polls, fun, loyalty, filter, hype, tts, songs, customCommands
  });
  const messageHandler = createMessageHandler(ctx, {
    filter, hype, customCommands, dashboard, commandRegistry, firstChatterConfig
  });
  return {
    dashboard, cooldowns, filter, hype, announcements, tts, eventSub, channelCommands, polls, fun,
    loyalty, youtube, songs, customCommands, commandRegistry, messageHandler
  };
}

export function createBot(deps: BotDeps): Bot {
  const ctx = createContext(deps, readDashboardBaseUrl(deps.env));
  const { state, config, chatClient } = ctx;
  const modules = createModules(ctx);
  const { dashboard, cooldowns, announcements, eventSub, customCommands, messageHandler } = modules;

  // Push refreshed tokens into config, env and every client that holds a copy
  applyRefreshedTokens(ctx);

  chatClient.onMessage(messageHandler.onMessage);

  let restartTimer: ReturnType<typeof setInterval> | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  // Restart watcher
  function watchForRestart(): void {
    if (ctx.fs.existsSync(ctx.restartFlagPath)) {
      console.log('🔄 Restart flag detected. Restarting bot...');
      try {
        ctx.fs.unlinkSync(ctx.restartFlagPath);
      } catch (e) {
        // Exiting with the flag still there would restart straight into another
        // exit, forever. Keep running; the watcher tries again on its next tick.
        console.error('Failed to remove restart flag, not restarting:', (e as Error).message);
        return;
      }
      ctx.exit(RESTART_EXIT_CODE);
    }
  }

  chatClient.onConnect(() => {
    console.log('Chat client connected!');
  });

  chatClient.onDisconnect((manually, reason) => {
    console.log(`Disconnected: ${reason ? reason.message : 'Unknown reason'}`);
  });

  // Get broadcaster ID
  async function init(): Promise<void> {
    try {
      console.log(`Initializing... (broadcaster: ${config.broadcasterName})`);

      // Parallelize API calls for faster initialization
      let [tokenInfo, user] = await Promise.all([
        ctx.apiClient.getTokenInfo(),
        ctx.apiClient.getUserByName(config.broadcasterName)
      ]);

      // Token may be expired at startup — try refreshing once before giving up
      if (!tokenInfo) {
        console.log('⚠️  Bot token appears expired at startup. Attempting to refresh...');
        const refreshed = await ctx.tokenManager.refresh('bot');
        if (refreshed) {
          tokenInfo = await ctx.apiClient.getTokenInfo();
          console.log('✓ Bot token refreshed successfully at startup');
        }
      }

      state.tokenUserId = tokenInfo?.userId || null;
      if (!state.tokenUserId) {
        throw new Error('OAuth token missing userId; ensure the token is tied to a user account.');
      }
      // Log in to chat as the account the bot token belongs to
      if (tokenInfo?.login) {
        chatClient.username = tokenInfo.login;
      }

      if (!user) {
        throw new Error(`Broadcaster "${config.broadcasterName}" not found. Check your .env TWITCH_BROADCASTER_NAME`);
      }

      const tokenUser = await ctx.apiClient.getUserById(state.tokenUserId);

      state.broadcasterId = String(user.id);
      state.broadcasterUserId = String(user.id);
      if (!/^\d+$/.test(state.broadcasterId)) {
        throw new Error(`Resolved broadcasterId is non-numeric: ${state.broadcasterId}`);
      }
      console.log(`Got broadcaster ID: ${state.broadcasterId}`);
      console.log(`Token user ID: ${state.tokenUserId} (${tokenUser?.name || tokenUser?.login || 'unknown'})`);
      console.log(`Ensure ${tokenUser?.name || tokenUser?.login || state.tokenUserId} is a moderator in the channel!`);

      // Load built-in command configuration
      await cooldowns.loadBuiltinCommands();

      // Update dashboard
      dashboard.updateDashboard();
      state.initComplete = true;
      await eventSub.setupEventSub();
      await eventSub.setupBroadcasterEventSub();
      announcements.startAnnouncements();
    } catch (error) {
      console.error('Failed to initialize bot:', (error as Error).message);
      state.broadcasterId = null;
      state.initComplete = true;
    }
  }

  // Start the bot
  async function run(): Promise<void> {
    console.log('Starting Twitch bot...');

    // Validate and refresh tokens before initializing
    await validateAndRefreshTokens(ctx);

    // Check if all required scopes for enabled features are present
    await checkRequiredScopes(ctx);

    if (!state.broadcasterId) {
      await init();
      if (!state.broadcasterId) {
        // Nothing can run without the broadcaster: exit instead of idling without chat or EventSub
        console.error('✗ Failed to initialize broadcaster ID. Check TWITCH_BROADCASTER_NAME and the bot token, then restart the bot.');
        ctx.exit(1);
      }
    }

    await customCommands.loadCustomCommands();

    // Periodic refresh logic
    const refreshCommands = async () => {
      try {
        // Load with the TTL this timer was scheduled for, so a changed interval
        // cannot make the cache look fresh and skip this cycle
        await customCommands.loadCustomCommands();
      } catch (err) {
        console.error('Failed to refresh custom commands:', (err as Error).message);
      } finally {
        // Re-read interval from env (in case it was updated via dashboard) for the next cycle
        customCommands.refreshCacheTtl();
        if (!stopped) refreshTimer = setTimeout(refreshCommands, customCommands.getCacheTtl());
      }
    };
    refreshTimer = setTimeout(refreshCommands, customCommands.getCacheTtl());

    await chatClient.connect();

    console.log('✓ Connected to Twitch chat');
    console.log(`✓ Joined channels: ${config.channels.join(', ')}`);
    console.log('Bot is ready!');
  }

  function start(): Promise<void> {
    stopped = false;
    restartTimer = setInterval(watchForRestart, 5000);
    return run();
  }

  async function stop(): Promise<void> {
    stopped = true;
    if (restartTimer) clearInterval(restartTimer);
    if (refreshTimer) clearTimeout(refreshTimer);
    restartTimer = null;
    refreshTimer = null;
    announcements.stopAnnouncements();
    ctx.tokenManager.stop();
    state.eventSub?.stop();
    state.broadcasterEventSub?.stop();
    await chatClient.disconnect();
  }

  return { ctx, start, stop, modules };
}
