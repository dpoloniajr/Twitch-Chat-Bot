/**
 * Discord Webhook Integration
 * Send notifications to Discord channels via webhooks
 */

import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { createLogger } from '../utils/logger';

const logger = createLogger('Discord');

/**
 * Discord embed field
 */
export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

/**
 * Discord embed footer
 */
export interface DiscordEmbedFooter {
  text: string;
  icon_url?: string;
}

/**
 * Discord embed author
 */
export interface DiscordEmbedAuthor {
  name: string;
  url?: string;
  icon_url?: string;
}

/**
 * Discord embed thumbnail/image
 */
export interface DiscordEmbedMedia {
  url: string;
  height?: number;
  width?: number;
}

/**
 * Discord embed structure
 */
export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  timestamp?: string;
  color?: number;
  footer?: DiscordEmbedFooter;
  author?: DiscordEmbedAuthor;
  thumbnail?: DiscordEmbedMedia;
  image?: DiscordEmbedMedia;
  fields?: DiscordEmbedField[];
}

/**
 * Discord webhook message payload
 */
export interface DiscordWebhookPayload {
  content?: string;
  username?: string;
  avatar_url?: string;
  tts?: boolean;
  embeds?: DiscordEmbed[];
}

/**
 * Discord notification type
 */
export type DiscordNotificationType =
  | 'stream_online'
  | 'stream_offline'
  | 'follow'
  | 'subscription'
  | 'bits'
  | 'raid'
  | 'custom';

/**
 * Discord webhook configuration
 */
export interface DiscordWebhookConfig {
  /** Webhook URL */
  url: string;
  /** Bot username to display */
  username?: string;
  /** Bot avatar URL */
  avatarUrl?: string;
  /** Enabled notification types */
  enabledTypes?: DiscordNotificationType[];
  /** Custom color (decimal) */
  embedColor?: number;
  /** Rate limit (requests per minute) */
  rateLimit?: number;
}

/**
 * Predefined embed colors
 */
export const DISCORD_COLORS = {
  TWITCH_PURPLE: 0x9146ff,
  SUCCESS: 0x00ff00,
  ERROR: 0xff0000,
  WARNING: 0xffff00,
  INFO: 0x0099ff,
  FOLLOW: 0x00ff7f,
  SUBSCRIPTION: 0xffd700,
  BITS: 0xff69b4,
  RAID: 0xff4500,
} as const;

/**
 * Discord webhook manager
 */
export class DiscordWebhook {
  private config: DiscordWebhookConfig;
  private requestTimes: number[] = [];
  private rateLimitWindow = 60000; // 1 minute

  constructor(config: DiscordWebhookConfig) {
    this.config = {
      rateLimit: 30,
      embedColor: DISCORD_COLORS.TWITCH_PURPLE,
      enabledTypes: ['stream_online', 'stream_offline', 'follow', 'subscription', 'bits', 'raid'],
      ...config,
    };

    // Validate webhook URL
    if (!this.isValidWebhookUrl(config.url)) {
      throw new Error('Invalid Discord webhook URL');
    }
  }

  /**
   * Validate webhook URL format
   */
  private isValidWebhookUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return (
        (parsed.hostname === 'discord.com' || parsed.hostname === 'discordapp.com') &&
        parsed.pathname.startsWith('/api/webhooks/')
      );
    } catch {
      return false;
    }
  }

  /**
   * Check rate limit
   */
  private checkRateLimit(): boolean {
    const now = Date.now();
    const windowStart = now - this.rateLimitWindow;

    // Remove old requests
    this.requestTimes = this.requestTimes.filter((t) => t > windowStart);

    if (this.requestTimes.length >= (this.config.rateLimit || 30)) {
      logger.warn('Rate limit exceeded', { requests: this.requestTimes.length });
      return false;
    }

    this.requestTimes.push(now);
    return true;
  }

  /**
   * Send a webhook message
   */
  async send(payload: DiscordWebhookPayload): Promise<{ success: boolean; error?: string }> {
    if (!this.checkRateLimit()) {
      return { success: false, error: 'Rate limit exceeded' };
    }

    const finalPayload: DiscordWebhookPayload = {
      username: this.config.username,
      avatar_url: this.config.avatarUrl,
      ...payload,
    };

    return new Promise((resolve) => {
      try {
        const url = new URL(this.config.url);
        const data = JSON.stringify(finalPayload);

        const options = {
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname + url.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
          },
        };

        const protocol = url.protocol === 'https:' ? https : http;
        const req = protocol.request(options, (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              logger.debug('Webhook sent successfully');
              resolve({ success: true });
            } else {
              logger.warn('Webhook failed', { status: res.statusCode, body });
              resolve({ success: false, error: `HTTP ${res.statusCode}: ${body}` });
            }
          });
        });

        req.on('error', (error) => {
          logger.error('Webhook request error', { error: error.message });
          resolve({ success: false, error: error.message });
        });

        req.setTimeout(10000, () => {
          req.destroy();
          resolve({ success: false, error: 'Request timeout' });
        });

        req.write(data);
        req.end();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        logger.error('Webhook error', { error: message });
        resolve({ success: false, error: message });
      }
    });
  }

  /**
   * Send a simple text message
   */
  async sendMessage(content: string): Promise<{ success: boolean; error?: string }> {
    return this.send({ content });
  }

  /**
   * Send an embed message
   */
  async sendEmbed(embed: DiscordEmbed): Promise<{ success: boolean; error?: string }> {
    const finalEmbed: DiscordEmbed = {
      color: this.config.embedColor,
      timestamp: new Date().toISOString(),
      ...embed,
    };

    return this.send({ embeds: [finalEmbed] });
  }

  /**
   * Check if notification type is enabled
   */
  isTypeEnabled(type: DiscordNotificationType): boolean {
    return this.config.enabledTypes?.includes(type) ?? true;
  }

  // ==================== Pre-built Notification Methods ====================

  /**
   * Send stream online notification
   */
  async notifyStreamOnline(options: {
    channelName: string;
    title: string;
    game: string;
    thumbnailUrl?: string;
    streamUrl?: string;
  }): Promise<{ success: boolean; error?: string }> {
    if (!this.isTypeEnabled('stream_online')) {
      return { success: true };
    }

    return this.sendEmbed({
      title: `🔴 ${options.channelName} is now LIVE!`,
      description: options.title,
      url: options.streamUrl || `https://twitch.tv/${options.channelName}`,
      color: DISCORD_COLORS.TWITCH_PURPLE,
      fields: [
        { name: 'Game', value: options.game || 'Unknown', inline: true },
      ],
      thumbnail: options.thumbnailUrl ? { url: options.thumbnailUrl } : undefined,
      footer: { text: 'Twitch Stream' },
    });
  }

  /**
   * Send stream offline notification
   */
  async notifyStreamOffline(options: {
    channelName: string;
    duration?: string;
  }): Promise<{ success: boolean; error?: string }> {
    if (!this.isTypeEnabled('stream_offline')) {
      return { success: true };
    }

    return this.sendEmbed({
      title: `⚫ ${options.channelName} has gone offline`,
      description: options.duration ? `Stream duration: ${options.duration}` : undefined,
      color: 0x808080,
      footer: { text: 'Twitch Stream' },
    });
  }

  /**
   * Send new follower notification
   */
  async notifyFollow(options: {
    channelName: string;
    followerName: string;
    followerDisplayName?: string;
  }): Promise<{ success: boolean; error?: string }> {
    if (!this.isTypeEnabled('follow')) {
      return { success: true };
    }

    const displayName = options.followerDisplayName || options.followerName;

    return this.sendEmbed({
      title: '💚 New Follower!',
      description: `**${displayName}** is now following ${options.channelName}!`,
      color: DISCORD_COLORS.FOLLOW,
      thumbnail: {
        url: `https://unavatar.io/twitch/${options.followerName}`,
      },
    });
  }

  /**
   * Send subscription notification
   */
  async notifySubscription(options: {
    channelName: string;
    subscriberName: string;
    subscriberDisplayName?: string;
    tier: '1000' | '2000' | '3000';
    isGift?: boolean;
    gifterName?: string;
    cumulativeMonths?: number;
    message?: string;
  }): Promise<{ success: boolean; error?: string }> {
    if (!this.isTypeEnabled('subscription')) {
      return { success: true };
    }

    const tierNames: Record<string, string> = {
      '1000': 'Tier 1',
      '2000': 'Tier 2',
      '3000': 'Tier 3',
    };

    const displayName = options.subscriberDisplayName || options.subscriberName;
    let title = '⭐ New Subscription!';
    let description = `**${displayName}** subscribed to ${options.channelName}!`;

    if (options.isGift && options.gifterName) {
      title = '🎁 Gift Subscription!';
      description = `**${options.gifterName}** gifted a sub to **${displayName}**!`;
    }

    const fields: DiscordEmbedField[] = [
      { name: 'Tier', value: tierNames[options.tier] || 'Tier 1', inline: true },
    ];

    if (options.cumulativeMonths && options.cumulativeMonths > 1) {
      fields.push({
        name: 'Total Months',
        value: options.cumulativeMonths.toString(),
        inline: true,
      });
    }

    return this.sendEmbed({
      title,
      description,
      color: DISCORD_COLORS.SUBSCRIPTION,
      fields,
      footer: options.message ? { text: options.message } : undefined,
    });
  }

  /**
   * Send bits/cheer notification
   */
  async notifyBits(options: {
    channelName: string;
    userName: string;
    userDisplayName?: string;
    bits: number;
    message?: string;
  }): Promise<{ success: boolean; error?: string }> {
    if (!this.isTypeEnabled('bits')) {
      return { success: true };
    }

    const displayName = options.userDisplayName || options.userName;

    return this.sendEmbed({
      title: '💎 Bits Received!',
      description: `**${displayName}** cheered **${options.bits}** bits!`,
      color: DISCORD_COLORS.BITS,
      fields: options.message
        ? [{ name: 'Message', value: options.message }]
        : undefined,
    });
  }

  /**
   * Send raid notification
   */
  async notifyRaid(options: {
    channelName: string;
    raiderName: string;
    raiderDisplayName?: string;
    viewers: number;
  }): Promise<{ success: boolean; error?: string }> {
    if (!this.isTypeEnabled('raid')) {
      return { success: true };
    }

    const displayName = options.raiderDisplayName || options.raiderName;

    return this.sendEmbed({
      title: '🚀 Incoming Raid!',
      description: `**${displayName}** is raiding with **${options.viewers}** viewers!`,
      color: DISCORD_COLORS.RAID,
      thumbnail: {
        url: `https://unavatar.io/twitch/${options.raiderName}`,
      },
    });
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<DiscordWebhookConfig>): void {
    if (updates.url && !this.isValidWebhookUrl(updates.url)) {
      throw new Error('Invalid Discord webhook URL');
    }

    this.config = { ...this.config, ...updates };
    logger.info('Discord config updated');
  }

  /**
   * Get current configuration (without sensitive URL)
   */
  getConfig(): Omit<DiscordWebhookConfig, 'url'> & { urlConfigured: boolean } {
    const { url, ...rest } = this.config;
    return { ...rest, urlConfigured: !!url };
  }
}

// ==================== Singleton Management ====================

let defaultWebhook: DiscordWebhook | null = null;

export function initDiscordWebhook(config: DiscordWebhookConfig): DiscordWebhook {
  defaultWebhook = new DiscordWebhook(config);
  return defaultWebhook;
}

export function getDiscordWebhook(): DiscordWebhook | null {
  return defaultWebhook;
}

export function resetDiscordWebhook(): void {
  defaultWebhook = null;
}
