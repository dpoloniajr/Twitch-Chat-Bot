/**
 * Chat filter routes (mounted at /api/filters): read and update the filter
 * settings and the word blacklist, persisting each change to the .env file.
 */

import { Router } from 'express';
import { upsertEnvValue, asyncHandler, validateRequest, ValidationError, readEnvFileSync } from '../lib/utils';
import * as state from '../lib/state';
import type { DashboardChatFilters } from '../lib/types';
import type { FilterAction } from '../../types';

/**
 * Read the chat filter settings saved in a .env file (the CHAT_FILTER_* keys the
 * bot reads at startup). Only keys present in the file are returned, parsed the
 * way the bot parses them (src/bot/config.ts).
 */
export function readChatFiltersFromEnv(envPath: string): Partial<DashboardChatFilters> {
  const env = readEnvFileSync(envPath);
  const flag = (value: string): boolean => value === 'true' || value === '1';
  const filters: Partial<DashboardChatFilters> = {};

  if (env.CHAT_FILTER_WORDS !== undefined) {
    filters.blacklistWords = [...new Set(env.CHAT_FILTER_WORDS.split('|').map(w => w.trim().toLowerCase()).filter(Boolean))];
  }
  if (env.CHAT_FILTER_URLS !== undefined) filters.filterUrls = flag(env.CHAT_FILTER_URLS);
  if (env.CHAT_FILTER_ALLCAPS !== undefined) filters.filterAllCaps = flag(env.CHAT_FILTER_ALLCAPS);
  if (env.CHAT_FILTER_REPEAT !== undefined) filters.filterRepeatChars = flag(env.CHAT_FILTER_REPEAT);
  if (env.CHAT_FILTER_SPAM !== undefined) filters.filterSpam = flag(env.CHAT_FILTER_SPAM);
  const timeout = Number(env.CHAT_FILTER_TIMEOUT_SEC);
  if (env.CHAT_FILTER_TIMEOUT_SEC && Number.isFinite(timeout)) filters.timeoutDurationSeconds = timeout;
  if (['warn', 'timeout', 'delete'].includes(env.CHAT_FILTER_ACTION)) {
    filters.filterAction = env.CHAT_FILTER_ACTION as FilterAction;
  }
  return filters;
}

/**
 * Create the /api/filters router. Each call returns a new router that edits `envPath`.
 */
export function createFiltersRouter(envPath: string): Router {
  const router = Router();

  // Get current filter configuration
  router.get('/', (req, res) => {
    res.json(state.getChatFilters());
  });

  // Update filter settings
  router.post('/', asyncHandler(async (req, res) => {
    const { filterUrls, filterAllCaps, filterRepeatChars, filterSpam, filterAction, timeoutDurationSeconds } = req.body;
    const updates: Partial<DashboardChatFilters> = {};

    // Validate before writing anything, so a bad field leaves .env untouched
    let timeoutSeconds: number | undefined;
    if (timeoutDurationSeconds !== undefined) {
      const requested = Number(timeoutDurationSeconds);
      if (timeoutDurationSeconds === null || timeoutDurationSeconds === '' || !Number.isFinite(requested)) {
        throw new ValidationError('timeoutDurationSeconds must be a number');
      }
      timeoutSeconds = Math.max(10, Math.min(3600, requested));
    }

    if (filterUrls !== undefined) {
      updates.filterUrls = !!filterUrls;
      await upsertEnvValue(envPath, 'CHAT_FILTER_URLS', updates.filterUrls ? 'true' : 'false');
    }
    if (filterAllCaps !== undefined) {
      updates.filterAllCaps = !!filterAllCaps;
      await upsertEnvValue(envPath, 'CHAT_FILTER_ALLCAPS', updates.filterAllCaps ? 'true' : 'false');
    }
    if (filterRepeatChars !== undefined) {
      updates.filterRepeatChars = !!filterRepeatChars;
      await upsertEnvValue(envPath, 'CHAT_FILTER_REPEAT', updates.filterRepeatChars ? 'true' : 'false');
    }
    if (filterSpam !== undefined) {
      updates.filterSpam = !!filterSpam;
      await upsertEnvValue(envPath, 'CHAT_FILTER_SPAM', updates.filterSpam ? 'true' : 'false');
    }
    if (filterAction !== undefined && ['warn', 'timeout', 'delete'].includes(filterAction)) {
      updates.filterAction = filterAction as FilterAction;
      await upsertEnvValue(envPath, 'CHAT_FILTER_ACTION', filterAction);
    }
    if (timeoutSeconds !== undefined) {
      updates.timeoutDurationSeconds = timeoutSeconds;
      await upsertEnvValue(envPath, 'CHAT_FILTER_TIMEOUT_SEC', String(timeoutSeconds));
    }

    const finalFilters = state.updateChatFilters(updates);
    res.json({ success: true, filters: finalFilters });
  }));

  // Add word to filter blacklist
  router.post('/words', validateRequest({
    word: { required: true, type: 'string' }
  }), asyncHandler(async (req, res) => {
    const { word } = req.body;
    const chatFilters = state.getChatFilters();
    const normalized = (word as string).trim().toLowerCase();

    if (normalized.length === 0) {
      throw new ValidationError('Word must be a non-empty string');
    }

    if (!chatFilters.blacklistWords.includes(normalized)) {
      const newWords = [...chatFilters.blacklistWords, normalized];
      state.updateChatFilters({ blacklistWords: newWords });
      await upsertEnvValue(envPath, 'CHAT_FILTER_WORDS', newWords.join('|'));
    }

    res.json({ success: true, words: state.getChatFilters().blacklistWords });
  }));

  // Remove word from filter blacklist
  router.delete('/words/:word', asyncHandler(async (req, res) => {
    // Express has already URL-decoded the param (decoding again breaks words containing "%")
    const wordToRemove = (req.params.word as string).toLowerCase();
    const chatFilters = state.getChatFilters();
    const newWords = chatFilters.blacklistWords.filter(w => w !== wordToRemove);

    state.updateChatFilters({ blacklistWords: newWords });
    await upsertEnvValue(envPath, 'CHAT_FILTER_WORDS', newWords.join('|'));

    res.json({ success: true, words: newWords });
  }));

  return router;
}
