const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const { withFileLock, ValidationError, asyncHandler } = require('../lib/utils');
const { DEFAULT_ALERT_CONFIG, ANIMATIONS, TTS_VOICES } = require('../lib/constants');
const state = require('../lib/state');

module.exports = function(alertConfigFile) {
  // Get full alert configuration (merge in any new default alert types so overlays get first_chatter etc.)
  router.get('/config', asyncHandler(async (req, res) => {
    try {
      const config = await withFileLock(alertConfigFile, async () => {
        const data = await fs.readFile(alertConfigFile, 'utf8');
        const config = JSON.parse(data);
        let hasNewTypes = false;
        if (config.alertTypes && DEFAULT_ALERT_CONFIG.alertTypes) {
          for (const key of Object.keys(DEFAULT_ALERT_CONFIG.alertTypes)) {
            if (!config.alertTypes[key]) {
              config.alertTypes[key] = DEFAULT_ALERT_CONFIG.alertTypes[key];
              hasNewTypes = true;
            }
          }
        }
        // Persist merged types to file to keep configuration up-to-date
        if (hasNewTypes) {
          await fs.writeFile(alertConfigFile, JSON.stringify(config, null, 2));
        }
        return config;
      });
      res.json(config);
    } catch (error) {
      console.error('Error loading or merging alert config:', error);
      res.json(DEFAULT_ALERT_CONFIG);
    }
  }));

  // Update full alert configuration
  router.post('/config', asyncHandler(async (req, res) => {
    const config = req.body;
    await withFileLock(alertConfigFile, async () => {
      await fs.writeFile(alertConfigFile, JSON.stringify(config, null, 2));
    });
    state.broadcastState({ type: 'alertConfig', data: config });
    res.json({ success: true, config });
  }));

  // Update specific alert type configuration
  router.post('/config/:alertType', asyncHandler(async (req, res) => {
    const alertType = req.params.alertType.toLowerCase();
    const config = await withFileLock(alertConfigFile, async () => {
      const c = JSON.parse(await fs.readFile(alertConfigFile, 'utf8'));
      c.alertTypes[alertType] = { ...c.alertTypes[alertType], ...req.body };
      await fs.writeFile(alertConfigFile, JSON.stringify(c, null, 2));
      return c;
    });
    state.broadcastState({ type: 'alertConfig', data: config });
    res.json({ success: true, config: config.alertTypes[alertType] });
  }));

  // Update global settings
  router.post('/config/global', asyncHandler(async (req, res) => {
    const config = await withFileLock(alertConfigFile, async () => {
      const c = JSON.parse(await fs.readFile(alertConfigFile, 'utf8'));
      c.global = { ...c.global, ...req.body };
      await fs.writeFile(alertConfigFile, JSON.stringify(c, null, 2));
      return c;
    });
    state.broadcastState({ type: 'alertConfig', data: config });
    res.json({ success: true, global: config.global });
  }));

  // Update alert variation
  router.post('/config/:alertType/variation/:variationKey', asyncHandler(async (req, res) => {
    let { alertType, variationKey } = req.params;
    alertType = alertType.toLowerCase();
    
    const config = await withFileLock(alertConfigFile, async () => {
      const c = JSON.parse(await fs.readFile(alertConfigFile, 'utf8'));
      if (!c.alertTypes[alertType].variations) {
        c.alertTypes[alertType].variations = {};
      }
      c.alertTypes[alertType].variations[variationKey] = {
        ...c.alertTypes[alertType].variations[variationKey],
        ...req.body
      };
      await fs.writeFile(alertConfigFile, JSON.stringify(c, null, 2));
      return c;
    });
    state.broadcastState({ type: 'alertConfig', data: config });
    res.json({ success: true, variation: config.alertTypes[alertType].variations[variationKey] });
  }));

  // Reset alert configuration
  router.post('/config/reset', asyncHandler(async (req, res) => {
    const { alertType } = req.body;
    const config = await withFileLock(alertConfigFile, async () => {
      let c;
      if (alertType && DEFAULT_ALERT_CONFIG.alertTypes[alertType]) {
        c = JSON.parse(await fs.readFile(alertConfigFile, 'utf8'));
        c.alertTypes[alertType] = JSON.parse(JSON.stringify(DEFAULT_ALERT_CONFIG.alertTypes[alertType]));
      } else {
        c = DEFAULT_ALERT_CONFIG;
      }
      await fs.writeFile(alertConfigFile, JSON.stringify(c, null, 2));
      return c;
    });
    state.broadcastState({ type: 'alertConfig', data: config });
    res.json({ success: true, config });
  }));

  // Test alert
  router.post('/test', asyncHandler(async (req, res) => {
    const { alertType = 'follow', user = 'TestUser', message, tier, amount, viewers, reward, useConfig = true } = req.body;
    
    let alertConfig = DEFAULT_ALERT_CONFIG;
    try {
      alertConfig = JSON.parse(await fs.readFile(alertConfigFile, 'utf8'));
    } catch {}

    const typeConfig = alertConfig.alertTypes[alertType];
    const globalConfig = alertConfig.global;

    const alertData = {
      alertType,
      user,
      timestamp: new Date().toISOString(),
      isTest: true,
      config: useConfig ? {
        duration: typeConfig.duration * 1000,
        volume: typeConfig.volume,
        enterAnimation: typeConfig.enterAnimation,
        exitAnimation: typeConfig.exitAnimation,
        layout: typeConfig.layout,
        showMessage: typeConfig.showMessage,
        textColor: typeConfig.textColor,
        backgroundColor: typeConfig.backgroundColor,
        borderColor: typeConfig.borderColor,
        fontFamily: typeConfig.fontFamily,
        fontSize: typeConfig.fontSize,
        messageTemplate: typeConfig.messageTemplate,
        sound: typeConfig.sound,
        customSound: typeConfig.customSound,
        image: typeConfig.image,
        video: typeConfig.video,
        ttsEnabled: typeConfig.ttsEnabled && globalConfig.ttsEnabled,
        ttsTemplate: typeConfig.ttsTemplate,
        ttsVoice: globalConfig.ttsVoice,
        ttsRate: globalConfig.ttsRate,
        ttsPitch: globalConfig.ttsPitch
      } : null
    };

    if (message) alertData.message = message;
    if (alertType === 'subscription') alertData.tier = tier || '1000';
    if (alertType === 'bits') alertData.amount = Number(amount) || 100;
    if (alertType === 'raid') alertData.viewers = Number(viewers) || 50;
    if (alertType === 'redemption') alertData.reward = reward || 'Hydrate!';

    state.broadcastState({ type: 'alert', data: alertData });
    res.json({ success: true, alert: alertData });
  }));

  router.get('/animations', (req, res) => res.json(ANIMATIONS));
  router.get('/tts/voices', (req, res) => res.json({ voices: TTS_VOICES }));

  return router;
};
