const express = require('express');
const router = express.Router();
const EnvManager = require('../lib/env-manager');
const envManager = new EnvManager();

// Get current token status
router.get('/status', async (req, res) => {
    try {
        const env = await envManager.getEnv();
        res.json({
            success: true,
            botToken: !!env.TWITCH_ACCESS_TOKEN,
            broadcasterToken: !!env.TWITCH_BROADCASTER_ACCESS_TOKEN,
            clientId: !!env.TWITCH_CLIENT_ID,
            clientSecret: !!env.TWITCH_CLIENT_SECRET
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// List backups
router.get('/backups', (req, res) => {
    try {
        const backups = envManager.listBackups();
        res.json({ success: true, backups });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Create backup
router.post('/backup', async (req, res) => {
    try {
        const backupName = await envManager.createBackup();
        res.json({ success: true, backupName });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Restore backup
router.post('/restore', async (req, res) => {
    const { backupName } = req.body;
    if (!backupName) return res.status(400).json({ success: false, error: 'backupName is required' });
    
    try {
        await envManager.restoreBackup(backupName);
        res.json({ success: true, message: 'Restore successful' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
