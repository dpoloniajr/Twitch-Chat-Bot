const express = require('express');
const router = express.Router();
const { upsertEnvValue } = require('../lib/utils');
const state = require('../lib/state');

module.exports = function(envPath) {
  // Get current filter configuration
  router.get('/', (req, res) => {
    res.json(state.getChatFilters());
  });

  // Update filter settings
  router.post('/', async (req, res) => {
    try {
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
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Add word to filter blacklist
  router.post('/words', async (req, res) => {
    try {
      const { word } = req.body;
      if (!word || typeof word !== 'string' || word.trim().length === 0) {
        return res.status(400).json({ error: 'Word must be a non-empty string' });
      }

      const chatFilters = state.getChatFilters();
      const normalized = word.trim().toLowerCase();
      if (!chatFilters.blacklistWords.includes(normalized)) {
        const newWords = [...chatFilters.blacklistWords, normalized];
        state.updateChatFilters({ blacklistWords: newWords });
        await upsertEnvValue(envPath, 'CHAT_FILTER_WORDS', newWords.join('|'));
      }

      res.json({ success: true, words: state.getChatFilters().blacklistWords });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Remove word from filter blacklist
  router.delete('/words/:word', async (req, res) => {
    try {
      const wordToRemove = decodeURIComponent(req.params.word).toLowerCase();
      const chatFilters = state.getChatFilters();
      const newWords = chatFilters.blacklistWords.filter(w => w !== wordToRemove);
      
      state.updateChatFilters({ blacklistWords: newWords });
      await upsertEnvValue(envPath, 'CHAT_FILTER_WORDS', newWords.join('|'));

      res.json({ success: true, words: newWords });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
};
