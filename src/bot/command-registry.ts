/**
 * Command registry for cleaner routing and centralized permissions:
 * maps each built-in command to its permission level and handler, applying
 * the dashboard-configured cooldowns.
 */

import { checkModPermission, type BotContext, type ChatMessage } from './context';
import type { ChannelCommands } from './channel-commands';
import type { ChatFilter, FilterWordResult } from './chat-filter';
import type { ChatHype } from './chat-hype';
import type { Cooldowns } from './cooldowns';
import type { CustomCommands } from './custom-commands';
import type { FunCommands } from './fun-commands';
import type { LoyaltyCommands } from './loyalty-commands';
import type { PollCommands } from './polls';
import type { SongCommands } from './song-requests';
import type { TTS } from './tts';

export interface CommandInvocation {
  channel: string;
  username: string;
  displayName: string;
  raw: string;
  args: string[];
  msg: ChatMessage;
}

export interface RegisteredCommand {
  perm: 'everyone' | 'mod';
  handler: (invocation: CommandInvocation) => Promise<void>;
}

export interface CommandModules {
  cooldowns: Cooldowns;
  channelCommands: ChannelCommands;
  polls: PollCommands;
  fun: FunCommands;
  loyalty: LoyaltyCommands;
  filter: ChatFilter;
  hype: ChatHype;
  tts: TTS;
  songs: SongCommands;
  customCommands: CustomCommands;
}

export const COMMANDS_HELP = 'Commands: !commands | !clip | !followage [user] | !tts <message> | !sr <URL or query> | !song | !queue | !8ball | !dice [sides] | !coinflip | !balance [user] | !leaderboard | !gamba <amount|all> | !duel @user [stake] | !quote | !counter <name> | !hype | !shoutout [user] / !so [user] (mods) | !poll | !prediction | !title (mods) | !game (mods) | !addfilter (mods) | !removefilter (mods) | !filters (mods)';

/** Chat replies for !addfilter / !removefilter outcomes */
const FILTER_EDIT_REPLIES: Record<'add' | 'remove', Record<FilterWordResult, (word: string) => string>> = {
  add: {
    saved: (w) => `Word "${w}" added to blacklist.`,
    unsaved: (w) => `Word "${w}" added to blacklist, but it could not be saved to the dashboard and will be lost on restart.`,
    missing: (w) => `Word "${w}" added to blacklist.`,
    invalid: () => 'Usage: !addfilter <word>'
  },
  remove: {
    saved: (w) => `Word "${w}" removed from blacklist.`,
    unsaved: (w) => `Word "${w}" removed from blacklist, but the change could not be saved to the dashboard and will be undone on restart.`,
    missing: (w) => `Word "${w}" is not in the blacklist.`,
    invalid: () => 'Usage: !removefilter <word>'
  }
};

export function createCommandRegistry(ctx: BotContext, m: CommandModules): Map<string, RegisteredCommand> {
  const { sendChatMessage } = ctx;
  const { cooldowns } = m;

  // Reload the built-in command config (cooldowns) whenever custom commands are refreshed,
  // so dashboard cooldown edits apply without a restart
  m.customCommands.onRefresh(cooldowns.loadBuiltinCommands);

  async function handleCommands(channel: string): Promise<void> {
    sendChatMessage(channel, COMMANDS_HELP);
  }

  /**
   * Run `run` unless `key` is on the cooldown configured for `configName`; then
   * start the cooldown unless `run` returned false (invalid input or a failed call).
   * Cooldowns are channel-wide: one viewer's use blocks the command for everyone.
   */
  async function withCooldown(
    { channel, username }: CommandInvocation,
    configName: string,
    key: string,
    label: string,
    run: () => Promise<boolean | void>
  ): Promise<void> {
    const cooldownSeconds = cooldowns.getCommandCooldown(configName);
    if (cooldowns.isOnCooldown(key, cooldownSeconds)) {
      const remainingSec = cooldowns.remainingSeconds(key, cooldownSeconds);
      sendChatMessage(channel, `@${username} ${label} is on cooldown. Try again in ${remainingSec}s.`);
      return;
    }
    const shouldCooldown = await run();
    if (shouldCooldown !== false && cooldownSeconds > 0) cooldowns.setCooldown(key);
  }

  const songRequest = async ({ channel, username, args, msg }: CommandInvocation): Promise<void> => {
    // Check if this is a config command: !sr config <setting> <value>
    if (args.length > 0 && args[0].toLowerCase() === 'config') {
      await m.songs.handleSongRequestConfig(channel, username, msg, args.slice(1));
    } else {
      await m.songs.handleSongRequest(channel, username, msg, args);
    }
  };

  return new Map<string, RegisteredCommand>([
    ['!clip', { perm: 'everyone', handler: async ({ channel, username }) => {
      await m.channelCommands.handleClip(channel, username);
    }}],
    ['!followage', { perm: 'everyone', handler: (inv) =>
      withCooldown(inv, '!followage', 'followage', '!followage', () => m.channelCommands.handleFollowage(inv.channel, inv.username, inv.args[0]))
    }],
    ['!8ball', { perm: 'everyone', handler: (inv) =>
      withCooldown(inv, '!8ball', '8ball', '!8ball', () => m.fun.handle8ball(inv.channel, inv.username, inv.args))
    }],
    ['!dice', { perm: 'everyone', handler: (inv) =>
      withCooldown(inv, '!dice', 'dice', '!dice', () => m.fun.handleDice(inv.channel, inv.username, inv.args))
    }],
    ['!coinflip', { perm: 'everyone', handler: (inv) =>
      withCooldown(inv, '!coinflip', 'coinflip', '!coinflip', () => m.fun.handleCoinflip(inv.channel, inv.username))
    }],
    ['!shoutout', { perm: 'mod', handler: (inv) =>
      withCooldown(inv, '!shoutout', 'shoutout', '!shoutout', () => m.channelCommands.handleShoutout(inv.channel, inv.username, inv.args[0]))
    }],
    ['!so', { perm: 'mod', handler: (inv) =>
      withCooldown(inv, '!so', 'so', '!so', () => m.channelCommands.handleShoutout(inv.channel, inv.username, inv.args[0]))
    }],
    ['!poll', { perm: 'mod', handler: (inv) =>
      withCooldown(inv, '!poll', 'poll', '!poll', () => m.polls.handlePoll(inv.channel, inv.username, inv.args))
    }],
    ['!prediction', { perm: 'mod', handler: (inv) =>
      withCooldown(inv, '!prediction', 'prediction', '!prediction', () => m.polls.handlePrediction(inv.channel, inv.username, inv.args))
    }],
    ['!title', { perm: 'mod', handler: (inv) =>
      withCooldown(inv, '!title', 'title', '!title', () => m.channelCommands.handleTitle(inv.channel, inv.username, inv.args.join(' ')))
    }],
    ['!game', { perm: 'mod', handler: (inv) =>
      withCooldown(inv, '!game', 'game', '!game', () => m.channelCommands.handleGame(inv.channel, inv.username, inv.args.join(' ')))
    }],
    ['!commands', { perm: 'everyone', handler: async ({ channel }) => {
      const cooldownSeconds = cooldowns.getCommandCooldown('!commands');
      if (cooldowns.isOnCooldown('commands', cooldownSeconds)) {
        return; // Silently fail on cooldown for !commands
      }
      await handleCommands(channel);
      if (cooldownSeconds > 0) cooldowns.setCooldown('commands');
    }}],
    ['!addfilter', { perm: 'mod', handler: async ({ channel, username, args }) => {
      if (!args[0]) {
        sendChatMessage(channel, `@${username} Usage: !addfilter <word>`);
        return;
      }
      const result = await m.filter.addFilterWord(args[0]);
      sendChatMessage(channel, FILTER_EDIT_REPLIES.add[result](args[0]));
    }}],
    ['!removefilter', { perm: 'mod', handler: async ({ channel, username, args }) => {
      if (!args[0]) {
        sendChatMessage(channel, `@${username} Usage: !removefilter <word>`);
        return;
      }
      const result = await m.filter.removeFilterWord(args[0]);
      sendChatMessage(channel, FILTER_EDIT_REPLIES.remove[result](args[0]));
    }}],
    ['!filters', { perm: 'mod', handler: async ({ channel }) => {
      sendChatMessage(channel, `Filters: ${JSON.stringify(m.filter.getFilterStatus())}`);
    }}],
    ['!balance', { perm: 'everyone', handler: (inv) =>
      withCooldown(inv, '!balance', 'balance', '!balance', () => m.loyalty.handleBalance(inv.channel, inv.username, inv.args))
    }],
    ['!leaderboard', { perm: 'everyone', handler: (inv) =>
      withCooldown(inv, '!leaderboard', 'leaderboard', '!leaderboard', () => m.loyalty.handleLeaderboard(inv.channel, inv.username))
    }],
    ['!gamba', { perm: 'everyone', handler: (inv) =>
      withCooldown(inv, '!gamba', 'gamba', '!gamba', () => m.loyalty.handleGamba(inv.channel, inv.username, inv.args))
    }],
    ['!duel', { perm: 'everyone', handler: async (inv) => {
      // Answering a challenge is not limited by the cooldown that issuing one started
      const answer = (inv.args[0] || '').toLowerCase();
      if (answer === 'accept' || answer === 'decline') {
        await m.loyalty.handleDuelResponse(inv.channel, inv.username, answer === 'accept');
        return;
      }
      await withCooldown(inv, '!duel', 'duel', '!duel', () => m.loyalty.handleDuel(inv.channel, inv.username, inv.args));
    }}],
    ['!quote', { perm: 'everyone', handler: (inv) =>
      withCooldown(inv, '!quote', 'quote', '!quote', () => m.loyalty.handleQuote(inv.channel, inv.username))
    }],
    ['!counter', { perm: 'everyone', handler: (inv) =>
      withCooldown(inv, '!counter', 'counter', '!counter', () => m.loyalty.handleCounter(inv.channel, inv.username, inv.args))
    }],
    ['!hype', { perm: 'everyone', handler: async (inv) => {
      // Mods bypass the cooldown and do not start it
      const isMod = checkModPermission(inv.msg, inv.channel, inv.username);
      const run = async () => m.hype.handleHype(inv.channel, inv.username, inv.args, isMod);
      if (isMod) {
        await run();
        return;
      }
      await withCooldown(inv, '!hype', 'hype', '!hype', run);
    }}],
    ['!tts', { perm: 'everyone', handler: async ({ channel, username, args, msg }) => {
      await m.tts.handleTTS(channel, username, args, msg, false);
    }}],
    ['!sr', { perm: 'everyone', handler: songRequest }],
    ['!songrequest', { perm: 'everyone', handler: songRequest }],
    ['!song', { perm: 'everyone', handler: (inv) =>
      withCooldown(inv, '!song', 'song', '!song', () => m.songs.handleCurrentSong(inv.channel, inv.username))
    }],
    ['!currentsong', { perm: 'everyone', handler: (inv) =>
      withCooldown(inv, '!currentsong', 'song', '!currentsong', () => m.songs.handleCurrentSong(inv.channel, inv.username))
    }],
    ['!queue', { perm: 'everyone', handler: (inv) =>
      withCooldown(inv, '!queue', 'queue', '!queue', () => m.songs.handleQueueInfo(inv.channel, inv.username))
    }],
    ['!skip', { perm: 'mod', handler: async ({ channel, username, msg }) => {
      await m.songs.handleSkipSong(channel, username, msg);
    }}],
    ['!skipsong', { perm: 'mod', handler: async ({ channel, username, msg }) => {
      await m.songs.handleSkipSong(channel, username, msg);
    }}],
    ['!removesong', { perm: 'mod', handler: async ({ channel, username, args, msg }) => {
      await m.songs.handleRemoveSong(channel, username, args, msg);
    }}],
    ['!clearqueue', { perm: 'mod', handler: async ({ channel, username, msg }) => {
      await m.songs.handleClearQueue(channel, username, msg);
    }}],
    ['!blocksong', { perm: 'mod', handler: async ({ channel, username, args }) => {
      await m.songs.handleBlockSong(channel, username, args);
    }}],
    ['!unblocksong', { perm: 'mod', handler: async ({ channel, username, args }) => {
      await m.songs.handleUnblockSong(channel, username, args);
    }}],
    ['!reloadcommands', { perm: 'mod', handler: async ({ channel, username }) => {
      const prevCount = ctx.state.customCommands.length;
      if (await m.customCommands.reloadCustomCommands()) {
        sendChatMessage(channel, `@${username} Reloaded custom commands (${prevCount} → ${ctx.state.customCommands.length})`);
      } else {
        sendChatMessage(channel, `@${username} Could not reload custom commands from the dashboard; keeping the ${prevCount} loaded.`);
      }
    }}]
  ]);
}
