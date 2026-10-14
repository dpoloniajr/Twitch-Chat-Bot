/**
 * Dashboard constants: supported upload types and their magic numbers, the
 * default alert configuration, and the option lists the alert editor offers.
 */

import type { AlertConfig, SelectOption } from './types';

export const SUPPORTED_IMAGE_TYPES: string[] = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
export const SUPPORTED_VIDEO_TYPES: string[] = ['.mp4', '.webm', '.mov'];
export const SUPPORTED_AUDIO_TYPES: string[] = ['.mp3', '.ogg', '.wav', '.m4a'];

/** Leading bytes that identify each upload type (by file extension) */
export const MIME_SIGNATURES: Record<string, number[]> = {
  '.png': [0x89, 0x50, 0x4e, 0x47],
  '.jpg': [0xff, 0xd8, 0xff],
  '.jpeg': [0xff, 0xd8, 0xff],
  '.gif': [0x47, 0x49, 0x46],
  '.webp': [0x52, 0x49, 0x46, 0x46],
  '.mp4': [0x66, 0x74, 0x79, 0x70],
  '.webm': [0x1a, 0x45, 0xdf, 0xa3],
  '.mov': [0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70],
  '.mp3': [0x49, 0x44, 0x33],
  '.ogg': [0x4f, 0x67, 0x67, 0x53],
  '.wav': [0x52, 0x49, 0x46, 0x46],
  '.m4a': [0x66, 0x74, 0x79, 0x70]
};

export const DEFAULT_ALERT_CONFIG: AlertConfig = {
  global: {
    enabled: true,
    testMode: false,
    defaultVolume: 0.8,
    defaultDuration: 5,
    defaultDelay: 1,
    ttsEnabled: false,
    ttsVoice: 'en-US',
    ttsRate: 1.0,
    ttsPitch: 1.0
  },
  alertTypes: {
    follow: {
      enabled: true,
      duration: 5,
      volume: 0.8,
      enterAnimation: 'bounceIn',
      exitAnimation: 'fadeOutUp',
      layout: 'standard',
      showMessage: true,
      ttsEnabled: false,
      ttsTemplate: '{user} just followed!',
      sound: 'default',
      customSound: null,
      image: null,
      video: null,
      textColor: '#00ff7f',
      backgroundColor: 'rgba(30, 30, 30, 0.95)',
      borderColor: '#00ff7f',
      fontFamily: 'Segoe UI',
      fontSize: 28,
      messageTemplate: 'New Follower!'
    },
    subscription: {
      enabled: true,
      duration: 6,
      volume: 0.8,
      enterAnimation: 'bounceIn',
      exitAnimation: 'fadeOutUp',
      layout: 'standard',
      showMessage: true,
      ttsEnabled: false,
      ttsTemplate: '{user} just subscribed!',
      sound: 'default',
      customSound: null,
      image: null,
      video: null,
      textColor: '#ff6b9d',
      backgroundColor: 'rgba(30, 30, 30, 0.95)',
      borderColor: '#ff6b9d',
      fontFamily: 'Segoe UI',
      fontSize: 28,
      messageTemplate: 'New Subscriber!',
      variations: {
        prime: { enabled: true, sound: null, image: null, messageTemplate: 'Prime Subscriber!' },
        tier1: { enabled: true, sound: null, image: null, messageTemplate: 'Tier 1 Subscriber!' },
        tier2: { enabled: true, sound: null, image: null, messageTemplate: 'Tier 2 Subscriber!' },
        tier3: { enabled: true, sound: null, image: null, messageTemplate: 'Tier 3 Subscriber!' },
        gift: { enabled: true, sound: null, image: null, messageTemplate: 'Gifted Sub!' },
        communityGift: { enabled: true, sound: null, image: null, messageTemplate: 'Community Gift!' },
        resub: { enabled: true, sound: null, image: null, messageTemplate: 'Resubscribed!' }
      }
    },
    bits: {
      enabled: true,
      duration: 5,
      volume: 0.8,
      enterAnimation: 'bounceIn',
      exitAnimation: 'fadeOutUp',
      layout: 'standard',
      showMessage: true,
      ttsEnabled: false,
      ttsTemplate: '{user} cheered {amount} bits!',
      sound: 'default',
      customSound: null,
      image: null,
      video: null,
      textColor: '#ffbb00',
      backgroundColor: 'rgba(30, 30, 30, 0.95)',
      borderColor: '#ffbb00',
      fontFamily: 'Segoe UI',
      fontSize: 28,
      messageTemplate: 'Cheer!',
      minBits: 1,
      variations: {
        '1': { enabled: true, sound: null, image: null, messageTemplate: 'Cheer!' },
        '100': { enabled: true, sound: null, image: null, messageTemplate: 'Big Cheer!' },
        '1000': { enabled: true, sound: null, image: null, messageTemplate: 'Huge Cheer!' },
        '5000': { enabled: true, sound: null, image: null, messageTemplate: 'Massive Cheer!' },
        '10000': { enabled: true, sound: null, image: null, messageTemplate: 'Legendary Cheer!' }
      }
    },
    raid: {
      enabled: true,
      duration: 7,
      volume: 0.8,
      enterAnimation: 'bounceIn',
      exitAnimation: 'fadeOutUp',
      layout: 'standard',
      showMessage: true,
      ttsEnabled: false,
      ttsTemplate: '{user} is raiding with {viewers} viewers!',
      sound: 'default',
      customSound: null,
      image: null,
      video: null,
      textColor: '#00d4ff',
      backgroundColor: 'rgba(30, 30, 30, 0.95)',
      borderColor: '#00d4ff',
      fontFamily: 'Segoe UI',
      fontSize: 28,
      messageTemplate: 'Raid!',
      minViewers: 2,
      variations: {
        '2': { enabled: true, sound: null, image: null, messageTemplate: 'Raid!' },
        '10': { enabled: true, sound: null, image: null, messageTemplate: 'Big Raid!' },
        '50': { enabled: true, sound: null, image: null, messageTemplate: 'Huge Raid!' },
        '100': { enabled: true, sound: null, image: null, messageTemplate: 'Massive Raid!' }
      }
    },
    redemption: {
      enabled: true,
      duration: 5,
      volume: 0.8,
      enterAnimation: 'bounceIn',
      exitAnimation: 'fadeOutUp',
      layout: 'standard',
      showMessage: true,
      ttsEnabled: false,
      ttsTemplate: '{user} redeemed {reward}!',
      sound: 'default',
      customSound: null,
      image: null,
      video: null,
      textColor: '#9147ff',
      backgroundColor: 'rgba(30, 30, 30, 0.95)',
      borderColor: '#9147ff',
      fontFamily: 'Segoe UI',
      fontSize: 28,
      messageTemplate: 'Redemption!',
      customRewards: {}
    },
    first_chatter: {
      enabled: true,
      duration: 4,
      volume: 0.8,
      enterAnimation: 'bounceIn',
      exitAnimation: 'fadeOutUp',
      layout: 'standard',
      showMessage: true,
      ttsEnabled: false,
      ttsTemplate: '{user} is here for the first time!',
      sound: 'default',
      customSound: null,
      image: null,
      video: null,
      textColor: '#00d4aa',
      backgroundColor: 'rgba(30, 30, 30, 0.95)',
      borderColor: '#00d4aa',
      fontFamily: 'Segoe UI',
      fontSize: 28,
      messageTemplate: 'First time in chat!'
    }
  }
};

export const ANIMATIONS: { enter: SelectOption[]; exit: SelectOption[] } = {
  enter: [
    { value: 'fadeIn', label: 'Fade In' },
    { value: 'fadeInUp', label: 'Fade In Up' },
    { value: 'fadeInDown', label: 'Fade In Down' },
    { value: 'slideInLeft', label: 'Slide In Left' },
    { value: 'slideInRight', label: 'Slide In Right' },
    { value: 'scaleIn', label: 'Scale In' },
    { value: 'bounceIn', label: 'Bounce In' },
    { value: 'rotateIn', label: 'Rotate In' }
  ],
  exit: [
    { value: 'fadeOut', label: 'Fade Out' },
    { value: 'fadeOutUp', label: 'Fade Out Up' },
    { value: 'fadeOutDown', label: 'Fade Out Down' },
    { value: 'slideOutLeft', label: 'Slide Out Left' },
    { value: 'slideOutRight', label: 'Slide Out Right' },
    { value: 'scaleOut', label: 'Scale Out' }
  ]
};

export const TTS_VOICES: SelectOption[] = [
  { value: 'en-US', label: 'English (US)' },
  { value: 'en-GB', label: 'English (UK)' },
  { value: 'en-AU', label: 'English (Australia)' },
  { value: 'es-ES', label: 'Spanish (Spain)' },
  { value: 'es-MX', label: 'Spanish (Mexico)' },
  { value: 'fr-FR', label: 'French' },
  { value: 'de-DE', label: 'German' },
  { value: 'it-IT', label: 'Italian' },
  { value: 'pt-BR', label: 'Portuguese (Brazil)' },
  { value: 'ja-JP', label: 'Japanese' },
  { value: 'ko-KR', label: 'Korean' }
];

/** Upload rate limit: at most UPLOAD_LIMIT_COUNT uploads per IP per window (ms) */
export const UPLOAD_LIMIT_WINDOW = 60000;
export const UPLOAD_LIMIT_COUNT = 10;

/** An entry in builtinCommands.json */
export interface BuiltinCommandEntry {
  name: string;
  cooldownSeconds: number;
  description: string;
  permission: string;
  [key: string]: unknown;
}

/**
 * The built-in commands a fresh install's builtinCommands.json lists. Existing
 * installs get any missing entry added by the dashboard's startup migration.
 */
export const DEFAULT_BUILTIN_COMMANDS: readonly BuiltinCommandEntry[] = [
  { name: '!clip', cooldownSeconds: 60, description: 'Create a clip of the current stream', permission: 'Everyone' },
  { name: '!followage', cooldownSeconds: 0, description: 'Check how long you have been following the channel', permission: 'Everyone' },
  { name: '!8ball', cooldownSeconds: 5, description: 'Ask the magic 8ball a yes/no question', permission: 'Everyone' },
  { name: '!dice', cooldownSeconds: 5, description: 'Roll a die (default 6 sides, e.g. !dice 20)', permission: 'Everyone' },
  { name: '!coinflip', cooldownSeconds: 5, description: 'Flip a coin — heads or tails', permission: 'Everyone' },
  { name: '!balance', cooldownSeconds: 5, description: 'Check your loyalty points (optional: check another user)', permission: 'Everyone' },
  { name: '!leaderboard', cooldownSeconds: 10, description: 'Show top 5 users by loyalty points', permission: 'Everyone' },
  { name: '!gamba', cooldownSeconds: 10, description: 'Gamble points: !gamba <amount> or !gamba all (50% win = 2x)', permission: 'Everyone' },
  { name: '!duel', cooldownSeconds: 15, description: 'Duel another user for points: !duel @user [stake]', permission: 'Everyone' },
  { name: '!quote', cooldownSeconds: 5, description: 'Display a random quote', permission: 'Everyone' },
  { name: '!counter', cooldownSeconds: 5, description: 'Check a counter value (e.g., !counter deaths)', permission: 'Everyone' },
  { name: '!tts', cooldownSeconds: 30, description: 'Speak a message using Text-to-Speech', permission: 'Everyone' },
  { name: '!shoutout', cooldownSeconds: 0, description: 'Give a shoutout to another streamer', permission: 'Moderator' },
  { name: '!so', cooldownSeconds: 0, description: 'Give a shoutout to another streamer', permission: 'Moderator' },
  { name: '!poll', cooldownSeconds: 0, description: 'Start or manage a poll', permission: 'Moderator' },
  { name: '!prediction', cooldownSeconds: 0, description: 'Start or manage a prediction', permission: 'Moderator' },
  { name: '!title', cooldownSeconds: 0, description: 'Update the stream title', permission: 'Moderator' },
  { name: '!game', cooldownSeconds: 0, description: 'Update the stream category', permission: 'Moderator' },
  { name: '!commands', cooldownSeconds: 0, description: 'List available commands', permission: 'Everyone' },
  { name: '!addfilter', cooldownSeconds: 0, description: 'Add a word to the chat filter', permission: 'Moderator' },
  { name: '!removefilter', cooldownSeconds: 0, description: 'Remove a word from the chat filter', permission: 'Moderator' },
  { name: '!filters', cooldownSeconds: 0, description: 'Show active chat filters', permission: 'Moderator' },
  { name: '!song', cooldownSeconds: 10, description: 'Show the currently playing song and next up', permission: 'Everyone' },
  { name: '!currentsong', cooldownSeconds: 10, description: 'Show the currently playing song and next up', permission: 'Everyone' },
  { name: '!queue', cooldownSeconds: 10, description: 'Show song queue statistics and next songs', permission: 'Everyone' },
  { name: '!sr', cooldownSeconds: 30, description: 'Request a YouTube song by URL or search query', permission: 'Everyone' },
  { name: '!songrequest', cooldownSeconds: 30, description: 'Request a YouTube song by URL or search query', permission: 'Everyone' },
  { name: '!skip', cooldownSeconds: 0, description: 'Skip the current song (no points refund)', permission: 'Moderator' },
  { name: '!skipsong', cooldownSeconds: 0, description: 'Skip the current song (no points refund)', permission: 'Moderator' },
  { name: '!removesong', cooldownSeconds: 0, description: 'Remove a song by position or keyword (refunds points)', permission: 'Moderator' },
  { name: '!clearqueue', cooldownSeconds: 0, description: 'Clear the entire song queue (refunds all points)', permission: 'Moderator' },
  { name: '!blocksong', cooldownSeconds: 0, description: 'Block a video, channel, or keyword from the queue', permission: 'Moderator' },
  { name: '!unblocksong', cooldownSeconds: 0, description: 'Remove an entry from the song blocklist', permission: 'Moderator' },
  { name: '!hype', cooldownSeconds: 15, description: 'Chat energy: messages in last 60s and hype threshold. Mods: !hype set N, !hype cooldown N, !hype toggle', permission: 'Everyone' }
];
