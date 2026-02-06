/**
 * EventSub Event Handlers
 * Integrates EventSub events with analytics, Discord notifications, and other services
 */

import { createLogger } from '../utils/logger';
import { getAnalyticsManager, AnalyticsManager } from '../services/analytics';
import { getLoyaltyManager, LoyaltyManager } from '../services/loyalty';
import { getSchedulerManager, SchedulerManager } from '../services/scheduler';
import { getDiscordWebhook, DiscordWebhook } from './discord';

const logger = createLogger('EventSubHandlers');

/**
 * EventSub event types we handle
 */
export type EventSubEventType =
  | 'stream.online'
  | 'stream.offline'
  | 'channel.follow'
  | 'channel.subscribe'
  | 'channel.subscription.gift'
  | 'channel.subscription.message'
  | 'channel.cheer'
  | 'channel.raid'
  | 'channel.ban'
  | 'channel.unban'
  | 'channel.channel_points_custom_reward_redemption.add';

/**
 * Base event data
 */
export interface BaseEventData {
  broadcaster_user_id: string;
  broadcaster_user_login: string;
  broadcaster_user_name: string;
}

/**
 * Stream online event data
 */
export interface StreamOnlineEvent extends BaseEventData {
  id: string;
  type: 'live' | 'playlist' | 'watch_party' | 'premiere' | 'rerun';
  started_at: string;
}

/**
 * Stream offline event data
 */
export interface StreamOfflineEvent extends BaseEventData {}

/**
 * Follow event data
 */
export interface FollowEvent extends BaseEventData {
  user_id: string;
  user_login: string;
  user_name: string;
  followed_at: string;
}

/**
 * Subscribe event data
 */
export interface SubscribeEvent extends BaseEventData {
  user_id: string;
  user_login: string;
  user_name: string;
  tier: '1000' | '2000' | '3000';
  is_gift: boolean;
}

/**
 * Subscription message event data
 */
export interface SubscriptionMessageEvent extends BaseEventData {
  user_id: string;
  user_login: string;
  user_name: string;
  tier: '1000' | '2000' | '3000';
  message: {
    text: string;
    emotes: Array<{ begin: number; end: number; id: string }>;
  };
  cumulative_months: number;
  streak_months: number | null;
  duration_months: number;
  is_gift?: boolean;
}

/**
 * Gift subscription event data
 */
export interface GiftSubscriptionEvent extends BaseEventData {
  user_id: string;
  user_login: string;
  user_name: string;
  tier: '1000' | '2000' | '3000';
  total: number;
  cumulative_total: number | null;
  is_anonymous: boolean;
}

/**
 * Cheer event data
 */
export interface CheerEvent extends BaseEventData {
  user_id: string | null;
  user_login: string | null;
  user_name: string | null;
  is_anonymous: boolean;
  message: string;
  bits: number;
}

/**
 * Raid event data
 */
export interface RaidEvent extends BaseEventData {
  from_broadcaster_user_id: string;
  from_broadcaster_user_login: string;
  from_broadcaster_user_name: string;
  viewers: number;
}

/**
 * Channel points redemption event data
 */
export interface ChannelPointsRedemptionEvent extends BaseEventData {
  id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  user_input: string;
  status: 'unfulfilled' | 'fulfilled' | 'canceled';
  reward: {
    id: string;
    title: string;
    cost: number;
    prompt: string;
  };
  redeemed_at: string;
}

/**
 * EventSub handlers configuration
 */
export interface EventSubHandlersConfig {
  /** Enable analytics tracking */
  enableAnalytics: boolean;
  /** Enable Discord notifications */
  enableDiscord: boolean;
  /** Enable loyalty point bonuses */
  enableLoyaltyBonuses: boolean;
  /** Bonus points for follows */
  followBonusPoints: number;
  /** Bonus points for subscriptions (multiplied by tier) */
  subscriptionBonusPoints: number;
  /** Bonus points for bits (per 100 bits) */
  bitsBonusPointsPer100: number;
}

const DEFAULT_CONFIG: EventSubHandlersConfig = {
  enableAnalytics: true,
  enableDiscord: true,
  enableLoyaltyBonuses: true,
  followBonusPoints: 100,
  subscriptionBonusPoints: 500,
  bitsBonusPointsPer100: 50,
};

/**
 * EventSub handlers manager
 */
export class EventSubHandlersManager {
  private config: EventSubHandlersConfig;
  private analytics: AnalyticsManager | null = null;
  private loyalty: LoyaltyManager | null = null;
  private scheduler: SchedulerManager | null = null;
  private discord: DiscordWebhook | null = null;
  private streamStartTime: Date | null = null;

  constructor(options?: {
    config?: Partial<EventSubHandlersConfig>;
    analytics?: AnalyticsManager;
    loyalty?: LoyaltyManager;
    scheduler?: SchedulerManager;
    discord?: DiscordWebhook;
  }) {
    this.config = { ...DEFAULT_CONFIG, ...options?.config };

    // Initialize service references
    this.analytics = options?.analytics || null;
    this.loyalty = options?.loyalty || null;
    this.scheduler = options?.scheduler || null;
    this.discord = options?.discord || null;
  }

  /**
   * Initialize services (lazy loading)
   */
  private getAnalytics(): AnalyticsManager | null {
    if (!this.config.enableAnalytics) return null;
    if (!this.analytics) {
      try {
        this.analytics = getAnalyticsManager();
      } catch {
        logger.warn('Analytics manager not available');
      }
    }
    return this.analytics;
  }

  private getLoyalty(): LoyaltyManager | null {
    if (!this.config.enableLoyaltyBonuses) return null;
    if (!this.loyalty) {
      try {
        this.loyalty = getLoyaltyManager();
      } catch {
        logger.warn('Loyalty manager not available');
      }
    }
    return this.loyalty;
  }

  private getDiscord(): DiscordWebhook | null {
    if (!this.config.enableDiscord) return null;
    if (!this.discord) {
      this.discord = getDiscordWebhook();
    }
    return this.discord;
  }

  private getScheduler(): SchedulerManager | null {
    if (!this.scheduler) {
      try {
        this.scheduler = getSchedulerManager();
      } catch {
        logger.warn('Scheduler manager not available');
      }
    }
    return this.scheduler;
  }

  // ==================== Event Handlers ====================

  /**
   * Handle stream online event
   */
  async handleStreamOnline(event: StreamOnlineEvent): Promise<void> {
    logger.info('Stream went online', {
      channel: event.broadcaster_user_name,
      type: event.type,
    });

    this.streamStartTime = new Date(event.started_at);

    // Start analytics session
    const analytics = this.getAnalytics();
    if (analytics) {
      analytics.startStreamSession();
    }

    // Update scheduler
    const scheduler = this.getScheduler();
    if (scheduler) {
      scheduler.setStreamStatus(true);
    }

    // Send Discord notification
    const discord = this.getDiscord();
    if (discord) {
      await discord.notifyStreamOnline({
        channelName: event.broadcaster_user_name,
        title: 'Stream is live!', // Would need additional API call to get actual title
        game: 'Gaming', // Would need additional API call to get actual game
        streamUrl: `https://twitch.tv/${event.broadcaster_user_login}`,
        thumbnailUrl: `https://static-cdn.jtvnw.net/previews-ttv/live_user_${event.broadcaster_user_login}-320x180.jpg`,
      });
    }
  }

  /**
   * Handle stream offline event
   */
  async handleStreamOffline(event: StreamOfflineEvent): Promise<void> {
    logger.info('Stream went offline', {
      channel: event.broadcaster_user_name,
    });

    // Calculate duration
    let duration = 'unknown';
    if (this.streamStartTime) {
      const durationMs = Date.now() - this.streamStartTime.getTime();
      const hours = Math.floor(durationMs / 3600000);
      const minutes = Math.floor((durationMs % 3600000) / 60000);
      duration = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
    }

    // End analytics session
    const analytics = this.getAnalytics();
    if (analytics) {
      analytics.endStreamSession();
    }

    // Update scheduler
    const scheduler = this.getScheduler();
    if (scheduler) {
      scheduler.setStreamStatus(false);
    }

    // Send Discord notification
    const discord = this.getDiscord();
    if (discord) {
      await discord.notifyStreamOffline({
        channelName: event.broadcaster_user_name,
        duration,
      });
    }

    this.streamStartTime = null;
  }

  /**
   * Handle follow event
   */
  async handleFollow(event: FollowEvent): Promise<void> {
    logger.info('New follower', {
      channel: event.broadcaster_user_name,
      follower: event.user_name,
    });

    // Track in analytics
    const analytics = this.getAnalytics();
    if (analytics) {
      analytics.trackFollow();
    }

    // Award loyalty points
    const loyalty = this.getLoyalty();
    if (loyalty && this.config.followBonusPoints > 0) {
      loyalty.awardPoints(event.user_login, this.config.followBonusPoints, 'Follow bonus', 'bonus');
    }

    // Send Discord notification
    const discord = this.getDiscord();
    if (discord) {
      await discord.notifyFollow({
        channelName: event.broadcaster_user_name,
        followerName: event.user_login,
        followerDisplayName: event.user_name,
      });
    }
  }

  /**
   * Handle subscription event
   */
  async handleSubscription(event: SubscribeEvent | SubscriptionMessageEvent): Promise<void> {
    const isResub = 'cumulative_months' in event;
    logger.info(isResub ? 'Resubscription' : 'New subscription', {
      channel: event.broadcaster_user_name,
      subscriber: event.user_name,
      tier: event.tier,
    });

    // Track in analytics
    const analytics = this.getAnalytics();
    if (analytics) {
      analytics.trackSubscription();
    }

    // Award loyalty points (scaled by tier)
    const loyalty = this.getLoyalty();
    if (loyalty && this.config.subscriptionBonusPoints > 0) {
      const tierMultiplier = parseInt(event.tier) / 1000;
      const points = this.config.subscriptionBonusPoints * tierMultiplier;
      loyalty.awardPoints(event.user_login, points, 'Subscription bonus', 'bonus');
    }

    // Send Discord notification
    const discord = this.getDiscord();
    if (discord) {
      const message = isResub ? (event as SubscriptionMessageEvent).message?.text : undefined;
      const months = isResub ? (event as SubscriptionMessageEvent).cumulative_months : undefined;

      await discord.notifySubscription({
        channelName: event.broadcaster_user_name,
        subscriberName: event.user_login,
        subscriberDisplayName: event.user_name,
        tier: event.tier,
        cumulativeMonths: months,
        message,
        isGift: event.is_gift,
      });
    }
  }

  /**
   * Handle gift subscription event
   */
  async handleGiftSubscription(event: GiftSubscriptionEvent): Promise<void> {
    logger.info('Gift subscriptions', {
      channel: event.broadcaster_user_name,
      gifter: event.is_anonymous ? 'Anonymous' : event.user_name,
      count: event.total,
    });

    // Track in analytics (count each gift)
    const analytics = this.getAnalytics();
    if (analytics) {
      for (let i = 0; i < event.total; i++) {
        analytics.trackSubscription();
      }
    }

    // Award loyalty points to gifter
    const loyalty = this.getLoyalty();
    if (loyalty && !event.is_anonymous && this.config.subscriptionBonusPoints > 0) {
      const tierMultiplier = parseInt(event.tier) / 1000;
      const points = this.config.subscriptionBonusPoints * tierMultiplier * event.total;
      loyalty.awardPoints(event.user_login, points, 'Gift sub bonus', 'bonus');
    }

    // Send Discord notification
    const discord = this.getDiscord();
    if (discord) {
      await discord.notifySubscription({
        channelName: event.broadcaster_user_name,
        subscriberName: event.is_anonymous ? 'Anonymous' : event.user_login,
        subscriberDisplayName: event.is_anonymous ? 'Anonymous' : event.user_name,
        tier: event.tier,
        isGift: true,
        gifterName: event.is_anonymous ? undefined : event.user_name,
      });
    }
  }

  /**
   * Handle cheer (bits) event
   */
  async handleCheer(event: CheerEvent): Promise<void> {
    logger.info('Bits received', {
      channel: event.broadcaster_user_name,
      cheerer: event.is_anonymous ? 'Anonymous' : event.user_name,
      bits: event.bits,
    });

    // Track in analytics
    const analytics = this.getAnalytics();
    if (analytics) {
      analytics.trackBits(event.bits);
    }

    // Award loyalty points
    const loyalty = this.getLoyalty();
    if (loyalty && !event.is_anonymous && this.config.bitsBonusPointsPer100 > 0) {
      const points = Math.floor(event.bits / 100) * this.config.bitsBonusPointsPer100;
      if (points > 0 && event.user_login) {
        loyalty.awardPoints(event.user_login, points, 'Bits bonus', 'bonus');
      }
    }

    // Send Discord notification
    const discord = this.getDiscord();
    if (discord) {
      await discord.notifyBits({
        channelName: event.broadcaster_user_name,
        userName: event.is_anonymous ? 'Anonymous' : (event.user_name || 'Anonymous'),
        bits: event.bits,
        message: event.message,
      });
    }
  }

  /**
   * Handle raid event
   */
  async handleRaid(event: RaidEvent): Promise<void> {
    logger.info('Incoming raid', {
      channel: event.broadcaster_user_name,
      raider: event.from_broadcaster_user_name,
      viewers: event.viewers,
    });

    // Send Discord notification
    const discord = this.getDiscord();
    if (discord) {
      await discord.notifyRaid({
        channelName: event.broadcaster_user_name,
        raiderName: event.from_broadcaster_user_login,
        raiderDisplayName: event.from_broadcaster_user_name,
        viewers: event.viewers,
      });
    }
  }

  /**
   * Handle channel points redemption
   */
  async handleChannelPointsRedemption(event: ChannelPointsRedemptionEvent): Promise<void> {
    logger.info('Channel points redemption', {
      channel: event.broadcaster_user_name,
      user: event.user_name,
      reward: event.reward.title,
      cost: event.reward.cost,
    });

    // This could trigger custom actions based on the reward
    // For now, just log it
  }

  // ==================== Configuration ====================

  /**
   * Get configuration
   */
  getConfig(): EventSubHandlersConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<EventSubHandlersConfig>): void {
    this.config = { ...this.config, ...updates };
    logger.info('EventSub handlers config updated');
  }
}

// Singleton
let defaultManager: EventSubHandlersManager | null = null;

export function getEventSubHandlersManager(): EventSubHandlersManager {
  if (!defaultManager) {
    defaultManager = new EventSubHandlersManager();
  }
  return defaultManager;
}

export function initEventSubHandlersManager(
  options?: ConstructorParameters<typeof EventSubHandlersManager>[0]
): EventSubHandlersManager {
  defaultManager = new EventSubHandlersManager(options);
  return defaultManager;
}

export function resetEventSubHandlersManager(): void {
  defaultManager = null;
}
