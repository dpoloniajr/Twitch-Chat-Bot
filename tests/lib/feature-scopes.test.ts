/**
 * Tests for src/lib/feature-scopes.ts (also loaded through the lib/feature-scopes.js shim)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  FEATURE_SCOPES,
  getActiveFeatures,
  getRequiredScopes,
  hasRequiredScopes,
  isTruthyEnvValue,
  syncGrantedScopes,
  validateScopes
} from '../../src/lib/feature-scopes';

const STANDARD = ['clips', 'shoutouts', 'followage', 'polls', 'predictions', 'announcements', 'moderation', 'delete_messages'];

describe('feature-scopes', () => {
  it('describes every feature with a name, description and both scope lists', () => {
    for (const [key, info] of Object.entries(FEATURE_SCOPES)) {
      expect(typeof info.name).toBe('string');
      expect(typeof info.description).toBe('string');
      expect(Array.isArray(info.bot)).toBe(true);
      expect(Array.isArray(info.broadcaster)).toBe(true);
      expect(key).toMatch(/^[a-z_]+$/);
    }
    expect(Object.keys(FEATURE_SCOPES)).toHaveLength(32);
  });

  describe('getActiveFeatures', () => {
    it('turns on chat, EventSub and the standard features by default', () => {
      expect(getActiveFeatures({})).toEqual(['chat', 'eventsub', 'subscriptions', 'bits', ...orderOf(STANDARD)]);
    });

    it('adds song requests and redemptions when a YouTube key is set', () => {
      const active = getActiveFeatures({ YOUTUBE_API_KEY: 'k' });
      expect(active.slice(0, 3)).toEqual(['chat', 'song_requests', 'redemptions']);
      expect(active.filter((f) => f === 'redemptions')).toHaveLength(1);
    });

    it.each(['true', '1', 'yes', 'TRUE', ' Yes '])('drops EventSub, subscriptions and bits when DISABLE_EVENTSUB=%s', (value) => {
      const active = getActiveFeatures({ DISABLE_EVENTSUB: value });
      expect(active).not.toEqual(expect.arrayContaining(['eventsub']));
      expect(active).not.toContain('subscriptions');
      expect(active).not.toContain('bits');
    });

    it.each(['false', '0', 'no', 'off', '', 'y'])('keeps EventSub for DISABLE_EVENTSUB=%p', (value) => {
      expect(getActiveFeatures({ DISABLE_EVENTSUB: value })).toContain('eventsub');
    });

    it.each(['true', '1', 'yes'])('turns a standard feature off with DISABLE_X=%s', (value) => {
      expect(getActiveFeatures({ DISABLE_POLLS: value })).not.toContain('polls');
      expect(getActiveFeatures({ DISABLE_POLLS: 'false' })).toContain('polls');
    });

    it.each(['true', '1', 'yes', 'TRUE'])('turns an opt-in feature on with ENABLE_X=%s', (value) => {
      expect(getActiveFeatures({ ENABLE_WHISPERS: value })).toContain('whispers');
      expect(getActiveFeatures({ ENABLE_WHISPERS: 'false' })).not.toContain('whispers');
    });

    it('ignores ENABLE_/DISABLE_ for the auto-detected features', () => {
      const active = getActiveFeatures({ DISABLE_CHAT: 'true', ENABLE_SONG_REQUESTS: 'true', DISABLE_BITS: 'true' });
      expect(active).toContain('chat');
      expect(active).not.toContain('song_requests');
      expect(active).toContain('bits');
    });

    it('reads process.env when no env is given', () => {
      const saved = process.env.ENABLE_GOALS;
      process.env.ENABLE_GOALS = 'true';
      try {
        expect(getActiveFeatures()).toContain('goals');
      } finally {
        if (saved === undefined) delete process.env.ENABLE_GOALS; else process.env.ENABLE_GOALS = saved;
      }
    });
  });

  describe('hasRequiredScopes', () => {
    it('is true when every required scope is held', () => {
      expect(hasRequiredScopes('clips', ['clips:edit', 'other'])).toBe(true);
      expect(hasRequiredScopes('clips', ['chat:read'])).toBe(false);
    });

    it('defaults to the bot account and checks the broadcaster list when asked', () => {
      expect(hasRequiredScopes('bits', [])).toBe(true); // bot needs nothing
      expect(hasRequiredScopes('bits', [], 'broadcaster')).toBe(false);
      expect(hasRequiredScopes('bits', ['bits:read'], 'broadcaster')).toBe(true);
    });

    it('treats unknown features and empty requirements as satisfied', () => {
      expect(hasRequiredScopes('nope', [])).toBe(true);
      expect(hasRequiredScopes('redemptions', null)).toBe(true);
    });

    it('treats missing current scopes as none', () => {
      expect(hasRequiredScopes('clips', undefined)).toBe(false);
    });
  });

  describe('getRequiredScopes', () => {
    it('returns the sorted union for the account type, skipping unknown features', () => {
      expect(getRequiredScopes(['followage', 'polls', 'nope', 'polls'], 'broadcaster')).toEqual([
        'channel:manage:polls', 'moderator:read:followers'
      ]);
      expect(getRequiredScopes([], 'bot')).toEqual([]);
    });
  });

  describe('validateScopes', () => {
    it('lists missing scopes in required order', () => {
      expect(validateScopes(['a'], ['c', 'a', 'b'])).toEqual({ hasAll: false, missing: ['c', 'b'] });
      expect(validateScopes(null, [])).toEqual({ hasAll: true, missing: [] });
    });
  });

  describe('isTruthyEnvValue', () => {
    it('accepts true, 1 and yes in any case, ignoring surrounding spaces', () => {
      for (const v of ['true', 'TRUE', '1', 'yes', 'Yes', ' true ']) expect(isTruthyEnvValue(v)).toBe(true);
      for (const v of [undefined, '', 'false', '0', 'no', 'on', 'y', '2']) expect(isTruthyEnvValue(v)).toBe(false);
    });
  });

  describe('syncGrantedScopes', () => {
    let dir: string;
    let envPath: string;
    const savedBackup = process.env.BACKUP_DIR;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scopes-'));
      envPath = path.join(dir, '.env');
      process.env.BACKUP_DIR = path.join(dir, 'backups');
    });
    afterEach(() => {
      if (savedBackup === undefined) delete process.env.BACKUP_DIR; else process.env.BACKUP_DIR = savedBackup;
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const line = (key: string) => fs.readFileSync(envPath, 'utf8').split('\n').find((l) => l.startsWith(`${key}=`));

    it('writes exactly the granted scopes, sorted, reporting what was added and removed', async () => {
      fs.writeFileSync(envPath, 'TWITCH_SCOPES=chat:read clips:edit\nOTHER=1\n');
      const result = await syncGrantedScopes(envPath, { bot: ['user:bot', 'chat:read'] });
      expect(result).toEqual({
        updated: true, botAdded: ['user:bot'], botRemoved: ['clips:edit'], broadcasterAdded: [], broadcasterRemoved: []
      });
      expect(line('TWITCH_SCOPES')).toBe('TWITCH_SCOPES=chat:read user:bot');
      expect(line('OTHER')).toBe('OTHER=1');
    });

    it('never adds scopes the token was not granted, whatever features are enabled', async () => {
      fs.writeFileSync(envPath, 'ENABLE_WHISPERS=true\nTWITCH_SCOPES=chat:read\n');
      const result = await syncGrantedScopes(envPath, { bot: ['chat:read'] });
      expect(result.updated).toBe(false);
      expect(line('TWITCH_SCOPES')).toBe('TWITCH_SCOPES=chat:read');
    });

    it('leaves an account alone when its granted list is empty or missing (unknown)', async () => {
      const content = 'TWITCH_SCOPES=chat:read\n';
      fs.writeFileSync(envPath, content);
      await expect(syncGrantedScopes(envPath, { bot: [], broadcaster: undefined })).resolves.toMatchObject({ updated: false });
      expect(fs.readFileSync(envPath, 'utf8')).toBe(content);
      expect(line('TWITCH_BROADCASTER_SCOPES')).toBeUndefined();
    });

    it('changes nothing when .env already lists the granted scopes, in any order', async () => {
      const content = 'TWITCH_SCOPES=chat:edit chat:read\nTWITCH_BROADCASTER_SCOPES=bits:read\n';
      fs.writeFileSync(envPath, content);
      await expect(syncGrantedScopes(envPath, { bot: ['chat:read', 'chat:edit'], broadcaster: ['bits:read'] }))
        .resolves.toEqual({ updated: false, botAdded: [], botRemoved: [], broadcasterAdded: [], broadcasterRemoved: [] });
      expect(fs.readFileSync(envPath, 'utf8')).toBe(content);
    });

    it('syncs the broadcaster line independently', async () => {
      fs.writeFileSync(envPath, 'TWITCH_SCOPES=chat:read\n');
      const result = await syncGrantedScopes(envPath, { bot: ['chat:read'], broadcaster: ['channel:read:subscriptions', 'bits:read'] });
      expect(result.broadcasterAdded).toEqual(['channel:read:subscriptions', 'bits:read']);
      expect(line('TWITCH_BROADCASTER_SCOPES')).toBe('TWITCH_BROADCASTER_SCOPES=bits:read channel:read:subscriptions');
      expect(line('TWITCH_SCOPES')).toBe('TWITCH_SCOPES=chat:read');
    });

    it('creates the file when it does not exist', async () => {
      const result = await syncGrantedScopes(envPath, { bot: ['chat:read'] });
      expect(result.updated).toBe(true);
      expect(line('TWITCH_SCOPES')).toBe('TWITCH_SCOPES=chat:read');
    });
  });
});

/** Standard features in FEATURE_SCOPES key order, as getActiveFeatures adds them */
function orderOf(features: string[]): string[] {
  return Object.keys(FEATURE_SCOPES).filter((k) => features.includes(k));
}
