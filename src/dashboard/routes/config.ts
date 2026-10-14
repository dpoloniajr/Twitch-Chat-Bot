/**
 * Settings routes (mounted at /api/config): read and edit the .env settings
 * listed in lib/settings-schema.ts.
 *
 *   GET /api/config  -> { groups, settings }  (secrets report only isSet)
 *   PUT /api/config  { values: { KEY: value | null } }
 *                    -> { success, changed, restart: ['bot', ...], settings }
 *
 * A PUT is all-or-nothing: every key is validated before .env is touched, and
 * unknown, read-only or environment-owned keys reject the whole request.
 */

import { Router } from 'express';
import { asyncHandler, readEnvFileSync, updateEnvValues, ValidationError } from '../lib/utils';
import {
  SETTING_GROUPS,
  describeSettings,
  getSettingDefinition,
  isSetByEnvironment,
  serializeSettingValue,
  type SettingApplies
} from '../lib/settings-schema';

export interface ConfigRouterOptions {
  /** Environment to report and keep in step with .env (default process.env) */
  env?: NodeJS.ProcessEnv;
  /**
   * Keys the system environment set before .env was loaded. When given, these
   * (and only these) count as environment-owned; otherwise that is inferred
   * from process.env disagreeing with .env (see isSetByEnvironment).
   */
  environmentKeys?: string[];
  /** Called after a save with the changed keys (the dashboard reloads TTS here) */
  onChange?: (changedKeys: string[]) => void;
}

/** Most keys one PUT may change (the schema has fewer; this only bounds bad input) */
const MAX_KEYS_PER_PUT = 100;

/**
 * Create the /api/config router editing the .env file at `envPath`.
 */
export function createConfigRouter(envPath: string, options: ConfigRouterOptions = {}): Router {
  const router = Router();
  const env = options.env ?? process.env;

  const knownEnvironmentKeys = options.environmentKeys ? new Set(options.environmentKeys) : null;
  const fromEnvironment = (key: string, fileEnv: Record<string, string>): boolean =>
    knownEnvironmentKeys ? knownEnvironmentKeys.has(key) : isSetByEnvironment(key, fileEnv, env);

  const snapshot = () => describeSettings(readEnvFileSync(envPath), env, fromEnvironment);

  router.get('/', (req, res) => {
    res.json({ groups: SETTING_GROUPS, settings: snapshot() });
  });

  router.put('/', asyncHandler(async (req, res) => {
    const values = (req.body as { values?: unknown }).values;
    if (typeof values !== 'object' || values === null || Array.isArray(values)) {
      throw new ValidationError('values must be an object of setting keys');
    }
    const entries = Object.entries(values as Record<string, unknown>);
    if (entries.length === 0) throw new ValidationError('values must contain at least one setting');
    if (entries.length > MAX_KEYS_PER_PUT) throw new ValidationError('too many settings in one request');

    // Validate everything first, so one bad value leaves .env untouched
    const fileEnv = readEnvFileSync(envPath);
    const updates: Record<string, string | null> = {};
    const restart = new Set<SettingApplies>();
    for (const [key, value] of entries) {
      const def = getSettingDefinition(key);
      if (!def) throw new ValidationError(`Unknown setting: ${key}`);
      if (fromEnvironment(key, fileEnv)) {
        throw new ValidationError(`${key} is set by the system environment (for example docker-compose), so .env changes would be ignored. Change it there.`);
      }
      updates[key] = serializeSettingValue(def, value);
    }

    // Only keys whose stored value actually changes are written and reported
    const changed = Object.keys(updates).filter(key => {
      const before = Object.prototype.hasOwnProperty.call(fileEnv, key) ? fileEnv[key] : null;
      return before !== updates[key];
    });
    if (changed.length > 0) {
      await updateEnvValues(envPath, Object.fromEntries(changed.map(key => [key, updates[key]])));
      for (const key of changed) {
        const value = updates[key];
        if (value === null) delete env[key];
        else env[key] = value;
        const applies = getSettingDefinition(key)!.applies;
        if (applies !== 'live') restart.add(applies);
      }
      options.onChange?.(changed);
    }

    res.json({ success: true, changed, restart: [...restart], settings: snapshot() });
  }));

  return router;
}
