/**
 * Tests for src/dashboard/lib/settings-schema.ts: the schema itself, parsing a
 * stored .env value for display, validating values sent by the Settings page,
 * and describing settings (secrets never leak, environment-owned keys flagged).
 */

import * as fs from 'fs';
import * as path from 'path';
import { isTruthyEnvValue } from '../../../src/lib/feature-scopes';
import { readFirstChatterSettings, readHypeSettings } from '../../../src/bot/config';
import { configFromEnv } from '../../../src/lib/tts-service';
import {
  SETTINGS,
  SETTING_GROUPS,
  describeSettings,
  getSettingDefinition,
  isSetByEnvironment,
  parseSettingValue,
  serializeSettingValue,
  type SettingDefinition
} from '../../../src/dashboard/lib/settings-schema';
import { ValidationError } from '../../../src/lib/api-utils';

const def = (key: string): SettingDefinition => {
  const found = getSettingDefinition(key);
  if (!found) throw new Error(`no setting ${key}`);
  return found;
};

/** Every `env.X` / `process.env.X` read in the running code (bot, dashboard, libs) */
function envKeysReadBySource(): Set<string> {
  const keys = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) {
        const source = fs.readFileSync(full, 'utf8');
        for (const m of source.matchAll(/\b(?:process\.)?env\.([A-Z][A-Z0-9_]+)/g)) keys.add(m[1]);
      }
    }
  };
  const root = path.join(__dirname, '..', '..', '..', 'src');
  for (const dir of ['bot', 'dashboard', 'lib', 'token-generator']) walk(path.join(root, dir));
  return keys;
}

describe('settings schema', () => {
  it('has unique keys, known groups and no empty group', () => {
    const keys = SETTINGS.map(s => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    const groupIds = SETTING_GROUPS.map(g => g.id);
    for (const s of SETTINGS) expect([s.key, groupIds.includes(s.group)]).toEqual([s.key, true]);
    for (const g of groupIds) expect([g, SETTINGS.some(s => s.group === g)]).toEqual([g, true]);
  });

  it('covers every .env key the running code reads, except the ones other pages or the token generator own', () => {
    // Owned elsewhere: the Chat Filters page (CHAT_FILTER_*), the Announcements page (ANNOUNCEMENTS),
    // and paths/internal switches that are not user settings.
    const ownedElsewhere = new Set([
      'CHAT_FILTER_WORDS', 'CHAT_FILTER_URLS', 'CHAT_FILTER_ALLCAPS', 'CHAT_FILTER_REPEAT', 'CHAT_FILTER_SPAM',
      'CHAT_FILTER_ACTION', 'CHAT_FILTER_TIMEOUT_SEC', 'ANNOUNCEMENTS', 'ENV_PATH', 'BACKUP_DIR'
    ]);
    const missing = [...envKeysReadBySource()].filter(key => !ownedElsewhere.has(key) && !getSettingDefinition(key));
    expect(missing).toEqual([]);
  });

  it('keeps the network and secret-protection keys out of reach of the API', () => {
    for (const key of ['DASHBOARD_HOST', 'DASHBOARD_INTERNAL_SECRET', 'TWITCH_ACCESS_TOKEN', 'TWITCH_REFRESH_TOKEN',
      'TWITCH_BROADCASTER_ACCESS_TOKEN', 'TWITCH_BROADCASTER_REFRESH_TOKEN', 'TWITCH_SCOPES', 'TWITCH_BROADCASTER_SCOPES']) {
      expect([key, def(key).readOnly]).toEqual([key, true]);
    }
  });

  it('gives secrets no default, and every integer a range that contains its default', () => {
    for (const s of SETTINGS) {
      if (s.type === 'secret') expect([s.key, s.default]).toEqual([s.key, undefined]);
      if (s.type === 'integer') {
        expect(s.min).toBeDefined();
        expect(s.max).toBeDefined();
        if (s.default !== undefined) {
          expect(s.default as number).toBeGreaterThanOrEqual(s.min!);
          expect(s.default as number).toBeLessThanOrEqual(s.max!);
        }
      }
      if (s.type === 'enum') expect(s.options!.includes(s.default as string)).toBe(true);
    }
  });

  it('matches the bot defaults in src/bot/config.ts', () => {
    // Same values the bot falls back to; a drift here would show the wrong placeholder
    expect(def('COMMAND_REFRESH_INTERVAL').default).toBe(60);
    expect(def('HYPE_MIN_MESSAGES').default).toBe(15);
    expect(def('HYPE_MIN_MESSAGES').min).toBe(5);
    expect(def('HYPE_COOLDOWN_SEC').default).toBe(120);
    expect(def('HYPE_COOLDOWN_SEC').min).toBe(30);
    expect(def('ANNOUNCEMENT_INTERVAL_MS').default).toBe(900000);
    expect(def('ANNOUNCEMENT_INTERVAL_MS').min).toBe(60000);
    expect(def('FIRST_CHATTER_MESSAGE').default).toBe('Welcome to the chat, {user}!');
  });
});

describe('parseSettingValue', () => {
  it.each([
    ['boolean unset uses the default', 'HYPE_ENABLED', undefined, true],
    ['boolean empty uses the default', 'DISABLE_EVENTSUB', '', false],
    ['boolean "false"', 'HYPE_ENABLED', 'false', false],
    ['boolean "0"', 'HYPE_ENABLED', '0', false],
    ['boolean "OFF" (any case)', 'FIRST_CHATTER_WELCOME_ENABLED', 'OFF', false],
    ['boolean "no"', 'FIRST_CHATTER_ALERT_ENABLED', 'no', false],
    ['boolean "true"', 'DISABLE_EVENTSUB', 'true', true],
    ['DISABLE_EVENTSUB "yes" is on', 'DISABLE_EVENTSUB', 'yes', true],
    ['DISABLE_EVENTSUB " TRUE " is on (trimmed, any case)', 'DISABLE_EVENTSUB', ' TRUE ', true],
    ['DISABLE_EVENTSUB other text is off, as eventsub reads it', 'DISABLE_EVENTSUB', 'on', false],
    ['HYPE_ENABLED "off" is on (the hype detector only checks false and 0)', 'HYPE_ENABLED', 'off', true],
    ['HYPE_ENABLED "FALSE" is on (case-sensitive check)', 'HYPE_ENABLED', 'FALSE', true],
    ['TTS_CACHE_ENABLED "0" is on (the TTS service only checks false)', 'TTS_CACHE_ENABLED', '0', true],
    ['TTS_CACHE_ENABLED "false" is off', 'TTS_CACHE_ENABLED', 'false', false],
    ['FIRST_CHATTER_* other text is on', 'FIRST_CHATTER_WELCOME_ENABLED', 'maybe', true],
    ['DEBUG: any value is on', 'DEBUG', 'false', true],
    ['DEBUG: unset is off', 'DEBUG', undefined, false],
    ['integer', 'COMMAND_REFRESH_INTERVAL', '30', 30],
    ['integer garbage', 'COMMAND_REFRESH_INTERVAL', 'abc', null],
    ['integer unset', 'COMMAND_REFRESH_INTERVAL', undefined, null],
    ['comma list trims and drops blanks', 'TWITCH_CHANNELS', ' a, b ,,c ', ['a', 'b', 'c']],
    ['space list', 'TWITCH_SCOPES', 'chat:read  chat:edit', ['chat:read', 'chat:edit']],
    ['list unset', 'TWITCH_CHANNELS', undefined, []],
    ['string', 'HYPE_MESSAGE', 'Hype!', 'Hype!'],
    ['enum', 'TTS_PROVIDER', 'openai', 'openai'],
    ['secret is never parsed', 'OPENAI_API_KEY', 'sk-123', null]
  ])('%s', (_label, key, raw, expected) => {
    expect(parseSettingValue(def(key), raw)).toEqual(expected);
  });
});

describe('serializeSettingValue', () => {
  const ok = (key: string, value: unknown) => serializeSettingValue(def(key), value);
  const bad = (key: string, value: unknown) => {
    try {
      serializeSettingValue(def(key), value);
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      return (error as Error).message;
    }
    throw new Error(`${key}=${JSON.stringify(value)} was accepted`);
  };

  it('null always means "remove the key"', () => {
    for (const s of SETTINGS.filter(x => !x.readOnly)) expect([s.key, serializeSettingValue(s, null)]).toEqual([s.key, null]);
  });

  it('rejects every read-only key, whatever the value', () => {
    for (const s of SETTINGS.filter(x => x.readOnly)) {
      expect(() => serializeSettingValue(s, null)).toThrow(`${s.key} cannot be changed from the dashboard`);
      expect(() => serializeSettingValue(s, 'x')).toThrow(ValidationError);
    }
  });

  describe('boolean', () => {
    it('writes true/false', () => {
      expect(ok('HYPE_ENABLED', true)).toBe('true');
      expect(ok('HYPE_ENABLED', false)).toBe('false');
    });
    it('removes the key for false on set-means-on flags', () => {
      expect(ok('DEBUG', false)).toBeNull();
      expect(ok('DEBUG', true)).toBe('true');
    });
    it.each(['true', 1, 0, '', {}, []])('rejects %p', value => {
      expect(bad('HYPE_ENABLED', value)).toBe('Hype detector (HYPE_ENABLED) must be true or false');
    });
  });

  describe('integer', () => {
    it('accepts numbers and numeric strings within range, bounds included', () => {
      expect(ok('COMMAND_REFRESH_INTERVAL', 5)).toBe('5');
      expect(ok('COMMAND_REFRESH_INTERVAL', 3600)).toBe('3600');
      expect(ok('COMMAND_REFRESH_INTERVAL', ' 42 ')).toBe('42');
      expect(ok('TTS_CACHE_MAX_SIZE', 10737418240)).toBe('10737418240');
    });
    it('treats an empty string as "remove"', () => {
      expect(ok('COMMAND_REFRESH_INTERVAL', '')).toBeNull();
    });
    it.each([
      [4, 'must be at least 5'],
      [3601, 'must be at most 3600'],
      [10.5, 'must be a whole number'],
      ['abc', 'must be a whole number'],
      ['  ', 'must be a whole number'],
      ['1e0', 'must be at least 5'],
      [true, 'must be a whole number'],
      [Number.NaN, 'must be a whole number'],
      [Number.POSITIVE_INFINITY, 'must be a whole number'],
      [[30], 'must be a whole number']
    ])('rejects %p (%s)', (value, message) => {
      expect(bad('COMMAND_REFRESH_INTERVAL', value)).toBe(`Command refresh interval (COMMAND_REFRESH_INTERVAL) ${message}`);
    });
    it('checks ports', () => {
      expect(bad('DASHBOARD_PORT', 0)).toMatch(/at least 1/);
      expect(bad('TOKEN_GENERATOR_PORT', 65536)).toMatch(/at most 65535/);
      expect(ok('DASHBOARD_PORT', 8080)).toBe('8080');
    });
  });

  describe('enum', () => {
    it('accepts listed options and "" as remove', () => {
      expect(ok('TTS_PROVIDER', 'elevenlabs')).toBe('elevenlabs');
      expect(ok('TTS_PROVIDER', '')).toBeNull();
    });
    it.each(['ELEVENLABS', 'polly', 1, true])('rejects %p', value => {
      expect(bad('TTS_PROVIDER', value)).toBe('Provider (TTS_PROVIDER) must be one of: browser, elevenlabs, openai');
    });
  });

  describe('list', () => {
    it('accepts arrays and separated strings, trims and de-duplicates', () => {
      expect(ok('TWITCH_CHANNELS', ['a', ' b ', 'a', ''])).toBe('a,b');
      expect(ok('TWITCH_CHANNELS', 'chan_1, Chan2 ,')).toBe('chan_1,Chan2');
    });
    it('an empty list removes the key', () => {
      expect(ok('TWITCH_CHANNELS', [])).toBeNull();
      expect(ok('TWITCH_CHANNELS', ' , ')).toBeNull();
    });
    it.each([
      [['ok', 'not ok'], 'entries must be a Twitch username'],
      [['#chan'], 'entries must be a Twitch username'],
      [['a'.repeat(26)], 'entries must be a Twitch username'],
      [[1, 2], 'must be a list of text values'],
      [5, 'must be a list'],
      [{ a: 1 }, 'must be a list']
    ])('rejects %p', (value, message) => {
      expect(bad('TWITCH_CHANNELS', value)).toContain(message);
    });
    it('enforces the total length', () => {
      const many = Array.from({ length: 80 }, (_, i) => `channel_name_${i}`);
      expect(bad('TWITCH_CHANNELS', many)).toContain('must be at most 1000 characters');
    });
  });

  describe('string and secret', () => {
    it('trims, and "" removes', () => {
      expect(ok('HYPE_MESSAGE', '  Hype time!  ')).toBe('Hype time!');
      expect(ok('HYPE_MESSAGE', '   ')).toBeNull();
      expect(ok('OPENAI_API_KEY', ' sk-abc ')).toBe('sk-abc');
    });
    it('keeps unicode and symbols (quoting is the .env writer\'s job)', () => {
      expect(ok('HYPE_MESSAGE', 'Chat is #1 🔥 "hype"')).toBe('Chat is #1 🔥 "hype"');
    });
    it.each([
      ['HYPE_MESSAGE', 'a\nb', 'cannot contain line breaks'],
      ['HYPE_MESSAGE', 'a\rb', 'cannot contain line breaks'],
      ['OPENAI_API_KEY', 'sk\u0000x', 'cannot contain line breaks'],
      ['HYPE_MESSAGE', 'x'.repeat(301), 'must be at most 300 characters'],
      ['HYPE_MESSAGE', 42, 'must be text'],
      ['OPENAI_API_KEY', ['sk'], 'must be text'],
      ['TWITCH_BROADCASTER_NAME', 'has space', 'must be a Twitch username'],
      ['TWITCH_CLIENT_ID', 'abc-123', 'must contain only letters and digits'],
      ['ELEVENLABS_MODEL', 'model name', 'must contain only letters, digits']
    ])('%s rejects %p', (key, value, message) => {
      expect(bad(key, value)).toContain(message);
    });
  });
});

describe('isSetByEnvironment', () => {
  it('is false when the environment has no value, or the same value as .env', () => {
    expect(isSetByEnvironment('K', {}, {})).toBe(false);
    expect(isSetByEnvironment('K', {}, { K: '' })).toBe(false);
    expect(isSetByEnvironment('K', { K: 'v' }, { K: 'v' })).toBe(false);
  });
  it('is true when the environment sets a key .env lacks or disagrees with', () => {
    expect(isSetByEnvironment('K', {}, { K: 'v' })).toBe(true);
    expect(isSetByEnvironment('K', { K: 'file' }, { K: 'docker' })).toBe(true);
  });
});

describe('boolean settings read the way the running code reads them', () => {
  const SAMPLES = ['true', 'TRUE', '1', 'yes', ' yes ', 'on', 'false', 'FALSE', '0', 'no', 'NO', 'off', 'Off', 'maybe'];
  const readers: Record<string, (raw: string) => boolean> = {
    DISABLE_EVENTSUB: raw => isTruthyEnvValue(raw),
    DEBUG: raw => Boolean(raw),
    FIRST_CHATTER_WELCOME_ENABLED: raw => readFirstChatterSettings({ FIRST_CHATTER_WELCOME_ENABLED: raw }).welcomeEnabled,
    FIRST_CHATTER_ALERT_ENABLED: raw => readFirstChatterSettings({ FIRST_CHATTER_ALERT_ENABLED: raw }).alertEnabled,
    HYPE_ENABLED: raw => readHypeSettings({ HYPE_ENABLED: raw }).enabled,
    TTS_CACHE_ENABLED: raw => configFromEnv({ TTS_CACHE_ENABLED: raw }, '/tmp/unused').cacheEnabled
  };

  it('covers every boolean setting', () => {
    expect(SETTINGS.filter(s => s.type === 'boolean').map(s => s.key).sort()).toEqual(Object.keys(readers).sort());
  });

  it.each(Object.keys(readers))('%s', key => {
    for (const raw of SAMPLES) {
      expect([raw, parseSettingValue(def(key), raw)]).toEqual([raw, readers[key](raw)]);
    }
  });
});

describe('describeSettings', () => {
  it('reports every setting with its parsed value and never a secret value', () => {
    const fileEnv = { OPENAI_API_KEY: 'sk-SECRET', COMMAND_REFRESH_INTERVAL: '30', TWITCH_CHANNELS: 'a,b' };
    const states = describeSettings(fileEnv, { ...fileEnv });
    expect(states).toHaveLength(SETTINGS.length);
    expect(JSON.stringify(states)).not.toContain('sk-SECRET');
    const byKey = Object.fromEntries(states.map(s => [s.key, s]));
    expect(byKey.OPENAI_API_KEY).toMatchObject({ type: 'secret', value: null, isSet: true, fromEnvironment: false });
    expect(byKey.ELEVENLABS_API_KEY).toMatchObject({ value: null, isSet: false });
    expect(byKey.COMMAND_REFRESH_INTERVAL).toMatchObject({ value: 30, isSet: true, default: 60, min: 5, unit: 'seconds' });
    expect(byKey.TWITCH_CHANNELS.value).toEqual(['a', 'b']);
    expect(byKey.HYPE_ENABLED).toMatchObject({ value: true, isSet: false });
  });

  it('does not send the validation internals (patterns) to the browser', () => {
    for (const state of describeSettings({}, {})) {
      expect(state).not.toHaveProperty('pattern');
      expect(state).not.toHaveProperty('patternMessage');
      expect(state).not.toHaveProperty('falseUnsets');
      expect(state).not.toHaveProperty('isOn');
    }
  });

  it('shows the environment value and flags it when the environment overrides .env', () => {
    const states = describeSettings({ COMMAND_REFRESH_INTERVAL: '30' }, { COMMAND_REFRESH_INTERVAL: '90', TWITCH_CLIENT_ID: 'abc' });
    const byKey = Object.fromEntries(states.map(s => [s.key, s]));
    expect(byKey.COMMAND_REFRESH_INTERVAL).toMatchObject({ value: 90, fromEnvironment: true });
    expect(byKey.TWITCH_CLIENT_ID).toMatchObject({ value: 'abc', isSet: true, fromEnvironment: true });
  });

  it('a key set to "" in .env counts as unset', () => {
    const state = describeSettings({ HYPE_MESSAGE: '' }, { HYPE_MESSAGE: '' }).find(s => s.key === 'HYPE_MESSAGE')!;
    expect(state).toMatchObject({ value: null, isSet: false, fromEnvironment: false });
  });
});
