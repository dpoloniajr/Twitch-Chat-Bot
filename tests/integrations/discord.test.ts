/**
 * Tests for Discord Webhook Integration
 */

import {
  DiscordWebhook,
  DISCORD_COLORS,
  initDiscordWebhook,
  getDiscordWebhook,
  resetDiscordWebhook,
} from '../../src/integrations/discord';

// Mock the http/https modules
jest.mock('https', () => ({
  request: jest.fn(),
}));

jest.mock('http', () => ({
  request: jest.fn(),
}));

import * as https from 'https';

const VALID_WEBHOOK_URL = 'https://discord.com/api/webhooks/123456/abcdef';
const INVALID_WEBHOOK_URL = 'https://example.com/webhook';

describe('DiscordWebhook', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetDiscordWebhook();
  });

  describe('constructor', () => {
    it('should create webhook with valid URL', () => {
      const webhook = new DiscordWebhook({ url: VALID_WEBHOOK_URL });
      expect(webhook).toBeDefined();
    });

    it('should accept discordapp.com URLs', () => {
      const webhook = new DiscordWebhook({
        url: 'https://discordapp.com/api/webhooks/123456/abcdef',
      });
      expect(webhook).toBeDefined();
    });

    it('should throw error for invalid URL', () => {
      expect(() => {
        new DiscordWebhook({ url: INVALID_WEBHOOK_URL });
      }).toThrow('Invalid Discord webhook URL');
    });

    it('should throw error for malformed URL', () => {
      expect(() => {
        new DiscordWebhook({ url: 'not-a-url' });
      }).toThrow('Invalid Discord webhook URL');
    });

    it('should apply default configuration', () => {
      const webhook = new DiscordWebhook({ url: VALID_WEBHOOK_URL });
      const config = webhook.getConfig();

      expect(config.rateLimit).toBe(30);
      expect(config.embedColor).toBe(DISCORD_COLORS.TWITCH_PURPLE);
      expect(config.enabledTypes).toContain('stream_online');
      expect(config.enabledTypes).toContain('follow');
    });

    it('should allow custom configuration', () => {
      const webhook = new DiscordWebhook({
        url: VALID_WEBHOOK_URL,
        username: 'Test Bot',
        avatarUrl: 'https://example.com/avatar.png',
        embedColor: DISCORD_COLORS.SUCCESS,
        rateLimit: 10,
        enabledTypes: ['stream_online', 'follow'],
      });

      const config = webhook.getConfig();
      expect(config.username).toBe('Test Bot');
      expect(config.avatarUrl).toBe('https://example.com/avatar.png');
      expect(config.embedColor).toBe(DISCORD_COLORS.SUCCESS);
      expect(config.rateLimit).toBe(10);
    });
  });

  describe('isTypeEnabled', () => {
    it('should return true for enabled types', () => {
      const webhook = new DiscordWebhook({
        url: VALID_WEBHOOK_URL,
        enabledTypes: ['stream_online', 'follow'],
      });

      expect(webhook.isTypeEnabled('stream_online')).toBe(true);
      expect(webhook.isTypeEnabled('follow')).toBe(true);
    });

    it('should return false for disabled types', () => {
      const webhook = new DiscordWebhook({
        url: VALID_WEBHOOK_URL,
        enabledTypes: ['stream_online'],
      });

      expect(webhook.isTypeEnabled('subscription')).toBe(false);
      expect(webhook.isTypeEnabled('bits')).toBe(false);
    });
  });

  describe('updateConfig', () => {
    it('should update configuration', () => {
      const webhook = new DiscordWebhook({ url: VALID_WEBHOOK_URL });

      webhook.updateConfig({
        username: 'Updated Bot',
        embedColor: DISCORD_COLORS.ERROR,
      });

      const config = webhook.getConfig();
      expect(config.username).toBe('Updated Bot');
      expect(config.embedColor).toBe(DISCORD_COLORS.ERROR);
    });

    it('should throw error for invalid webhook URL update', () => {
      const webhook = new DiscordWebhook({ url: VALID_WEBHOOK_URL });

      expect(() => {
        webhook.updateConfig({ url: INVALID_WEBHOOK_URL });
      }).toThrow('Invalid Discord webhook URL');
    });
  });

  describe('getConfig', () => {
    it('should return config without sensitive URL', () => {
      const webhook = new DiscordWebhook({
        url: VALID_WEBHOOK_URL,
        username: 'Test Bot',
      });

      const config = webhook.getConfig();
      expect(config.urlConfigured).toBe(true);
      expect((config as unknown as { url: string }).url).toBeUndefined();
    });
  });

  describe('send', () => {
    it('should send webhook message', async () => {
      const mockResponse = {
        statusCode: 204,
        on: jest.fn((event, callback) => {
          if (event === 'data') return;
          if (event === 'end') callback();
        }),
      };

      const mockRequest = {
        on: jest.fn(),
        setTimeout: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
      };

      (https.request as jest.Mock).mockImplementation((options, callback) => {
        callback(mockResponse);
        return mockRequest;
      });

      const webhook = new DiscordWebhook({ url: VALID_WEBHOOK_URL });
      const result = await webhook.send({ content: 'Test message' });

      expect(result.success).toBe(true);
      expect(mockRequest.write).toHaveBeenCalled();
      expect(mockRequest.end).toHaveBeenCalled();
    });

    it('should handle HTTP errors', async () => {
      const mockResponse = {
        statusCode: 400,
        on: jest.fn((event, callback) => {
          if (event === 'data') callback('Bad Request');
          if (event === 'end') callback();
        }),
      };

      const mockRequest = {
        on: jest.fn(),
        setTimeout: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
      };

      (https.request as jest.Mock).mockImplementation((options, callback) => {
        callback(mockResponse);
        return mockRequest;
      });

      const webhook = new DiscordWebhook({ url: VALID_WEBHOOK_URL });
      const result = await webhook.send({ content: 'Test' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('400');
    });

    it('should handle request errors', async () => {
      const mockRequest = {
        on: jest.fn((event, callback) => {
          if (event === 'error') {
            callback(new Error('Network error'));
          }
        }),
        setTimeout: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
      };

      (https.request as jest.Mock).mockReturnValue(mockRequest);

      const webhook = new DiscordWebhook({ url: VALID_WEBHOOK_URL });
      const result = await webhook.send({ content: 'Test' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Network error');
    });

    it('should enforce rate limits', async () => {
      const webhook = new DiscordWebhook({
        url: VALID_WEBHOOK_URL,
        rateLimit: 2,
      });

      // Mock successful requests
      const mockResponse = {
        statusCode: 204,
        on: jest.fn((event, callback) => {
          if (event === 'end') callback();
        }),
      };

      const mockRequest = {
        on: jest.fn(),
        setTimeout: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
      };

      (https.request as jest.Mock).mockImplementation((options, callback) => {
        callback(mockResponse);
        return mockRequest;
      });

      // First two should succeed
      await webhook.send({ content: 'Test 1' });
      await webhook.send({ content: 'Test 2' });

      // Third should be rate limited
      const result = await webhook.send({ content: 'Test 3' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Rate limit');
    });
  });

  describe('sendMessage', () => {
    it('should send simple text message', async () => {
      const mockResponse = {
        statusCode: 204,
        on: jest.fn((event, callback) => {
          if (event === 'end') callback();
        }),
      };

      const mockRequest = {
        on: jest.fn(),
        setTimeout: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
      };

      (https.request as jest.Mock).mockImplementation((options, callback) => {
        callback(mockResponse);
        return mockRequest;
      });

      const webhook = new DiscordWebhook({ url: VALID_WEBHOOK_URL });
      const result = await webhook.sendMessage('Hello, Discord!');

      expect(result.success).toBe(true);
      expect(mockRequest.write).toHaveBeenCalledWith(
        expect.stringContaining('Hello, Discord!')
      );
    });
  });

  describe('sendEmbed', () => {
    it('should send embed with default color and timestamp', async () => {
      const mockResponse = {
        statusCode: 204,
        on: jest.fn((event, callback) => {
          if (event === 'end') callback();
        }),
      };

      const mockRequest = {
        on: jest.fn(),
        setTimeout: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
      };

      (https.request as jest.Mock).mockImplementation((options, callback) => {
        callback(mockResponse);
        return mockRequest;
      });

      const webhook = new DiscordWebhook({ url: VALID_WEBHOOK_URL });
      const result = await webhook.sendEmbed({
        title: 'Test Embed',
        description: 'Test Description',
      });

      expect(result.success).toBe(true);

      const writeCall = mockRequest.write.mock.calls[0][0];
      const payload = JSON.parse(writeCall);

      expect(payload.embeds).toHaveLength(1);
      expect(payload.embeds[0].title).toBe('Test Embed');
      expect(payload.embeds[0].color).toBe(DISCORD_COLORS.TWITCH_PURPLE);
      expect(payload.embeds[0].timestamp).toBeDefined();
    });
  });

  describe('notification methods', () => {
    let webhook: DiscordWebhook;
    let mockRequest: ReturnType<typeof jest.fn>;

    beforeEach(() => {
      const mockResponse = {
        statusCode: 204,
        on: jest.fn((event, callback) => {
          if (event === 'end') callback();
        }),
      };

      mockRequest = {
        on: jest.fn(),
        setTimeout: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
      };

      (https.request as jest.Mock).mockImplementation((options, callback) => {
        callback(mockResponse);
        return mockRequest;
      });

      webhook = new DiscordWebhook({ url: VALID_WEBHOOK_URL });
    });

    it('should send stream online notification', async () => {
      const result = await webhook.notifyStreamOnline({
        channelName: 'testchannel',
        title: 'Playing Games!',
        game: 'Minecraft',
      });

      expect(result.success).toBe(true);

      const writeCall = mockRequest.write.mock.calls[0][0];
      const payload = JSON.parse(writeCall);

      expect(payload.embeds[0].title).toContain('LIVE');
      expect(payload.embeds[0].description).toBe('Playing Games!');
    });

    it('should skip notification if type disabled', async () => {
      const limitedWebhook = new DiscordWebhook({
        url: VALID_WEBHOOK_URL,
        enabledTypes: ['follow'], // stream_online not enabled
      });

      const result = await limitedWebhook.notifyStreamOnline({
        channelName: 'test',
        title: 'Test',
        game: 'Test',
      });

      expect(result.success).toBe(true);
      expect(mockRequest.write).not.toHaveBeenCalled();
    });

    it('should send stream offline notification', async () => {
      const result = await webhook.notifyStreamOffline({
        channelName: 'testchannel',
        duration: '2 hours 30 minutes',
      });

      expect(result.success).toBe(true);

      const writeCall = mockRequest.write.mock.calls[0][0];
      const payload = JSON.parse(writeCall);

      expect(payload.embeds[0].title).toContain('offline');
    });

    it('should send follow notification', async () => {
      const result = await webhook.notifyFollow({
        channelName: 'testchannel',
        followerName: 'newfollower',
        followerDisplayName: 'NewFollower',
      });

      expect(result.success).toBe(true);

      const writeCall = mockRequest.write.mock.calls[0][0];
      const payload = JSON.parse(writeCall);

      expect(payload.embeds[0].title).toContain('Follower');
      expect(payload.embeds[0].description).toContain('NewFollower');
    });

    it('should send subscription notification', async () => {
      const result = await webhook.notifySubscription({
        channelName: 'testchannel',
        subscriberName: 'subscriber',
        subscriberDisplayName: 'Subscriber',
        tier: '2000',
        cumulativeMonths: 12,
      });

      expect(result.success).toBe(true);

      const writeCall = mockRequest.write.mock.calls[0][0];
      const payload = JSON.parse(writeCall);

      expect(payload.embeds[0].title).toContain('Subscription');
      expect(payload.embeds[0].fields).toBeDefined();
    });

    it('should send gift subscription notification', async () => {
      const result = await webhook.notifySubscription({
        channelName: 'testchannel',
        subscriberName: 'recipient',
        tier: '1000',
        isGift: true,
        gifterName: 'GiftGiver',
      });

      expect(result.success).toBe(true);

      const writeCall = mockRequest.write.mock.calls[0][0];
      const payload = JSON.parse(writeCall);

      expect(payload.embeds[0].title).toContain('Gift');
      expect(payload.embeds[0].description).toContain('GiftGiver');
    });

    it('should send bits notification', async () => {
      const result = await webhook.notifyBits({
        channelName: 'testchannel',
        userName: 'cheerer',
        bits: 1000,
        message: 'Great stream!',
      });

      expect(result.success).toBe(true);

      const writeCall = mockRequest.write.mock.calls[0][0];
      const payload = JSON.parse(writeCall);

      expect(payload.embeds[0].title).toContain('Bits');
      expect(payload.embeds[0].description).toContain('1000');
    });

    it('should send raid notification', async () => {
      const result = await webhook.notifyRaid({
        channelName: 'testchannel',
        raiderName: 'raider',
        raiderDisplayName: 'Raider',
        viewers: 250,
      });

      expect(result.success).toBe(true);

      const writeCall = mockRequest.write.mock.calls[0][0];
      const payload = JSON.parse(writeCall);

      expect(payload.embeds[0].title).toContain('Raid');
      expect(payload.embeds[0].description).toContain('250');
    });
  });

  describe('singleton management', () => {
    it('should initialize and retrieve default webhook', () => {
      const webhook = initDiscordWebhook({ url: VALID_WEBHOOK_URL });
      expect(webhook).toBeDefined();

      const retrieved = getDiscordWebhook();
      expect(retrieved).toBe(webhook);
    });

    it('should return null before initialization', () => {
      resetDiscordWebhook();
      expect(getDiscordWebhook()).toBeNull();
    });

    it('should reset default webhook', () => {
      initDiscordWebhook({ url: VALID_WEBHOOK_URL });
      expect(getDiscordWebhook()).not.toBeNull();

      resetDiscordWebhook();
      expect(getDiscordWebhook()).toBeNull();
    });
  });
});

describe('DISCORD_COLORS', () => {
  it('should have expected color values', () => {
    expect(DISCORD_COLORS.TWITCH_PURPLE).toBe(0x9146ff);
    expect(DISCORD_COLORS.SUCCESS).toBe(0x00ff00);
    expect(DISCORD_COLORS.ERROR).toBe(0xff0000);
    expect(DISCORD_COLORS.FOLLOW).toBe(0x00ff7f);
    expect(DISCORD_COLORS.SUBSCRIPTION).toBe(0xffd700);
    expect(DISCORD_COLORS.BITS).toBe(0xff69b4);
    expect(DISCORD_COLORS.RAID).toBe(0xff4500);
  });
});
