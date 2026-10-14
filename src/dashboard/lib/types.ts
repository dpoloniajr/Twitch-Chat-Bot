/**
 * Shared types for the dashboard's JSON data files and in-memory state.
 *
 * The files are written by the dashboard and by the bot (src/services/loyalty.ts),
 * and edited by hand, so every field read back from disk is treated as optional:
 * the dashboard code always falls back (`userData.points || 0`, `config.x ?? default`).
 */

import type { FilterStatus } from '../../types';
import type { LoyaltyConfig, LoyaltyTransaction, UserLoyaltyData } from '../../services/loyalty';

// ==================== loyalty.json ====================

/** A user entry in loyalty.json (bot fields plus the dashboard's award bookkeeping) */
export interface LoyaltyUserRecord extends Partial<UserLoyaltyData> {
  /** When chat-message points were last awarded: epoch ms (dashboard) or ISO string */
  lastMessagePointsAt?: number | string | null;
  /** When watch-time points were last awarded: epoch ms (dashboard) or ISO string (hand-edited) */
  lastWatchTimeAwardedAt?: number | string | null;
  /** Remembered from the last awarded chat message; drives watch-time multipliers */
  isSubscriber?: boolean;
  isVip?: boolean;
}

/** Transaction types the dashboard writes ('refund' is dashboard-only) */
export type LoyaltyTransactionType = LoyaltyTransaction['type'] | 'refund';

/** One loyalty.json transaction history entry */
export interface LoyaltyTransactionRecord extends Omit<LoyaltyTransaction, 'type'> {
  type: LoyaltyTransactionType;
}

/** Transaction fields before appendTransaction stamps the timestamp */
export type LoyaltyTransactionInput = Omit<LoyaltyTransactionRecord, 'timestamp'>;

/** loyalty.json config block (any field may be missing) */
export type LoyaltyConfigRecord = Partial<LoyaltyConfig>;

/** Shape of loyalty.json */
export interface LoyaltyData {
  users?: Record<string, LoyaltyUserRecord>;
  config?: LoyaltyConfigRecord;
  transactions?: LoyaltyTransactionRecord[];
  savedAt?: string;
  [key: string]: unknown;
}

/** Error codes the loyalty store returns */
export type LoyaltyErrorCode =
  | 'USER_NOT_FOUND'
  | 'INSUFFICIENT_POINTS'
  | 'CHALLENGER_INSUFFICIENT'
  | 'OPPONENT_INSUFFICIENT';

/** Fields every loyalty-store result may carry (routes inspect them generically) */
export interface LoyaltyOpResult {
  success: boolean;
  /** loyalty.json does not exist yet */
  notConfigured?: boolean;
  code?: LoyaltyErrorCode;
  error?: string;
  /** Current balance, reported with INSUFFICIENT_POINTS */
  balance?: number;
}

export interface DeductPointsResult extends LoyaltyOpResult {
  newBalance?: number;
}

export interface AddPointsResult extends LoyaltyOpResult {
  newBalance?: number;
}

export interface SetPointsResult extends LoyaltyOpResult {
  user?: LoyaltyUserRecord;
}

export interface AwardMessageResult extends LoyaltyOpResult {
  pointsEarned: number;
  newBalance?: number;
  onCooldown?: boolean;
}

export interface WatchTimeResult extends LoyaltyOpResult {
  /** Number of users awarded in this pass */
  awarded: number;
}

export interface GambaResult extends LoyaltyOpResult {
  won?: boolean;
  oldBalance?: number;
  newBalance?: number;
  amountBet?: number;
  winnings?: number;
}

export interface DuelResult extends LoyaltyOpResult {
  winner?: string;
  challengerBalance?: number;
  opponentBalance?: number;
}

// ==================== alert-config.json ====================

/** Per-variation override (sub tier, bits threshold, raid size) */
export interface AlertVariation {
  enabled: boolean;
  sound: string | null;
  image: string | null;
  messageTemplate: string;
  [key: string]: unknown;
}

/** Settings for one alert type (follow, subscription, bits, ...) */
export interface AlertTypeConfig {
  enabled: boolean;
  /** Seconds */
  duration: number;
  volume: number;
  enterAnimation: string;
  exitAnimation: string;
  layout: string;
  showMessage: boolean;
  ttsEnabled: boolean;
  ttsTemplate: string;
  sound: string;
  customSound: string | null;
  image: string | null;
  video: string | null;
  textColor: string;
  backgroundColor: string;
  borderColor: string;
  fontFamily: string;
  fontSize: number;
  messageTemplate: string;
  minBits?: number;
  minViewers?: number;
  variations?: Record<string, AlertVariation>;
  customRewards?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Settings shared by every alert type */
export interface AlertGlobalConfig {
  enabled: boolean;
  testMode: boolean;
  defaultVolume: number;
  defaultDuration: number;
  defaultDelay: number;
  ttsEnabled: boolean;
  ttsVoice: string;
  ttsRate: number;
  ttsPitch: number;
  [key: string]: unknown;
}

/** Shape of alert-config.json */
export interface AlertConfig {
  global: AlertGlobalConfig;
  alertTypes: Record<string, AlertTypeConfig>;
  [key: string]: unknown;
}

/** A value/label pair for the dashboard's select boxes */
export interface SelectOption {
  value: string;
  label: string;
}

// ==================== In-memory dashboard state ====================

/** An entry in commands.json (as posted to POST /api/logs) */
export interface DashboardCommandLog {
  timestamp: string;
  user: string;
  command: string;
  channel?: string;
  success: boolean;
}

/** Bot status shown by the dashboard; the bot may POST any extra fields */
export interface DashboardBotState {
  isConnected: boolean;
  channels: string[];
  broadcasterName: string;
  uptime: number;
  commandsExecuted: number;
  lastCommand: DashboardCommandLog | null;
  commands: Array<{ name: string; description: string }>;
  [key: string]: unknown;
}

/** Chat filter settings mirrored from the bot (same shape the bot reports) */
export type DashboardChatFilters = FilterStatus;

/** A message pushed to every connected dashboard WebSocket client */
export interface BroadcastMessage {
  type: string;
  data?: unknown;
  [key: string]: unknown;
}
