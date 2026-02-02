const express = require('express');
const router = express.Router();
const { upsertEnvValue, asyncHandler, validateRequest } = require('../lib/utils');
const state = require('../lib/state');

module.exports = function(envPath) {
  // Get current filter configuration
  router.get('/', (req, res) => {
    res.json(state.getChatFilters());
  });

  // Update filter settings
  router.post('/', asyncHandler(async (req, res) => {
    const { filterUrls, filterAllCaps, filterRepeatChars, filterSpam, filterAction, timeoutDurationSeconds } = req.body;
    const chatFilters = state.getChatFilters();
    const updates = {};

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
      updates.filterAction = filterAction;
      await upsertEnvValue(envPath, 'CHAT_FILTER_ACTION', filterAction);
    }
    if (timeoutDurationSeconds !== undefined) {
      const seconds = Math.max(10, Math.min(3600, Number(timeoutDurationSeconds)));
      updates.timeoutDurationSeconds = seconds;
      await upsertEnvValue(envPath, 'CHAT_FILTER_TIMEOUT_SEC', String(seconds));
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
    const normalized = word.trim().toLowerCase();
    
    if (normalized.length === 0) {
      throw new Error('Word must be a non-empty string');
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
    const wordToRemove = decodeURIComponent(req.params.word).toLowerCase();
    const chatFilters = state.getChatFilters();
    const newWords = chatFilters.blacklistWords.filter(w => w !== wordToRemove);
    
    state.updateChatFilters({ blacklistWords: newWords });
    await upsertEnvValue(envPath, 'CHAT_FILTER_WORDS', newWords.join('|'));

    res.json({ success: true, words: newWords });
  }));

  return router;
};
