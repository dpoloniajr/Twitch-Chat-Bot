/**
 * Core type definitions for the Twitch Chat Bot
 */

// ==================== Configuration Types ====================

export interface BotConfig {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  channels: string[];
  broadcasterName: string;
  scopes: string[];
}

export interface TokenData {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  obtainmentTimestamp: number;
}

export interface TokenValidationCache {
  lastCheck: number;
  isValid: boolean;
  expiresAt: number;
}

// ==================== Command Types ====================

export type CommandPermission = 'everyone' | 'mod' | 'broadcaster';

export interface CommandContext {
  channel: string;
  username: string;
  displayName: string;
  raw: string;
  args: string[];
  msg: ChatMessage;
}

export interface CommandHandler {
  perm: CommandPermission;
  handler: (ctx: CommandContext) => Promise<void>;
}

export interface CommandResult {
  success: boolean;
  message?: string;
  error?: string;
  data?: Record<string, unknown>;
}

export interface CustomCommand {
  name: string;
  response: string;
  permission?: CommandPermission;
  cooldownSeconds?: number;
  fetchEnabled?: boolean;
  fetchUrl?: string;
  enabled?: boolean;
}

export interface BuiltinCommand {
  name: string;
  description?: string;
  cooldownSeconds?: number;
  enabled?: boolean;
}

// ==================== Chat Filter Types ====================

export type FilterAction = 'warn' | 'timeout' | 'delete';

export type FilterViolation =
  | 'blacklist_word'
  | 'url'
  | 'all_caps'
  | 'repeat_chars'
  | 'spam';

export interface ChatFilterConfig {
  blacklistWords: Set<string>;
  filterUrls: boolean;
  filterAllCaps: boolean;
  filterRepeatChars: boolean;
  filterSpam: boolean;
  timeoutDurationSeconds: number;
  filterAction: FilterAction;
}

export interface FilterStatus {
  blacklistWords: string[];
  filterUrls: boolean;
  filterAllCaps: boolean;
  filterRepeatChars: boolean;
  filterSpam: boolean;
  timeoutDurationSeconds: number;
  filterAction: FilterAction;
}

export interface MessageHistoryEntry {
  text: string;
  time: number;
}

// ==================== User Info Types ====================

export interface UserInfo {
  userId?: string;
  userName?: string;
  displayName?: string;
  isMod: boolean;
  isBroadcaster: boolean;
  isSubscriber?: boolean;
  isVip?: boolean;
  badges?: Map<string, string>;
  color?: string;
}

export interface ChatMessage {
  userInfo: UserInfo;
  text?: string;
  id?: string;
  channelId?: string;
  isAction?: boolean;
  emotes?: Map<string, string[]>;
}

// ==================== API Response Types ====================

export interface TwitchUser {
  id: string;
  login: string;
  name?: string;
  displayName?: string;
  description?: string;
  profileImageUrl?: string;
  offlineImageUrl?: string;
  createdAt?: string;
}

export interface TwitchStream {
  id: string;
  userId: string;
  userLogin: string;
  userName: string;
  gameId: string;
  gameName: string;
  title: string;
  viewerCount: number;
  startedAt: string;
  language: string;
  thumbnailUrl: string;
  isMature: boolean;
}

export interface TwitchChannel {
  broadcasterId: string;
  broadcasterLogin: string;
  broadcasterName: string;
  broadcasterLanguage: string;
  gameId: string;
  gameName: string;
  title: string;
  delay: number;
}

export interface ChannelFollower {
  userId: string;
  userLogin: string;
  userName: string;
  followedAt?: string;
  followDate?: string;
}

export interface PaginatedResult<T> {
  data: T[];
  total?: number;
  cursor?: string;
}

// ==================== EventSub Types ====================

export interface EventSubEvent {
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export interface FollowEvent {
  userId: string;
  userName: string;
  userDisplayName?: string;
  followedAt: string;
}

export interface SubscriptionEvent {
  userId: string;
  userName: string;
  userDisplayName?: string;
  tier: '1000' | '2000' | '3000';
  isGift: boolean;
  cumulativeMonths?: number;
  message?: string;
}

export interface RaidEvent {
  raidingBroadcasterId: string;
  raidingBroadcasterName: string;
  raidingBroadcasterDisplayName?: string;
  viewers: number;
}

export interface CheerEvent {
  userId: string;
  userName: string;
  userDisplayName?: string;
  bits: number;
  message?: string;
  isAnonymous: boolean;
}

export interface RedemptionEvent {
  id: string;
  rewardId: string;
  rewardTitle: string;
  rewardCost: number;
  userId: string;
  userName: string;
  userDisplayName?: string;
  userInput?: string;
  status: string;
  redeemedAt: string;
}

// ==================== Alert Types ====================

export type AlertType = 'follow' | 'subscription' | 'bits' | 'raid' | 'redemption';

export interface AlertData {
  alertType: AlertType;
  user?: string;
  message?: string;
  tier?: string;
  amount?: number;
  viewers?: number;
  reward?: string;
}

// ==================== Logger Types ====================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: string;
  data?: Record<string, unknown>;
}

export interface LoggerOptions {
  level?: LogLevel;
  context?: string;
  enableConsole?: boolean;
  enableFile?: boolean;
  filePath?: string;
}

// ==================== Dashboard Types ====================

export interface CommandLog {
  timestamp: string;
  user: string;
  command: string;
  args: string;
  result: 'success' | 'failed';
}

export interface UserStats {
  [username: string]: {
    commandCount: number;
    lastSeen: string;
    firstSeen: string;
  };
}

export interface BotState {
  isConnected: boolean;
  channels: string[];
  broadcasterName: string;
  uptime: number;
  scopes: string[];
  commands: Array<{
    name: string;
    description: string;
  }>;
}
