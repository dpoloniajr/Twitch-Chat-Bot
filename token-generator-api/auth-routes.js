const express = require('express');
const router = express.Router();
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const EnvManager = require('../lib/env-manager');
const envManager = new EnvManager();
const AccountManager = require('../account-manager');
const accountManager = new AccountManager();

const PORT = process.env.TOKEN_GENERATOR_PORT || 3000;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

// Helper to get Twitch credentials from .env
async function getTwitchCredentials() {
    const env = await envManager.getEnv();
    return {
        clientId: env.TWITCH_CLIENT_ID,
        clientSecret: env.TWITCH_CLIENT_SECRET
    };
}

// Generate auth URL
router.post('/generate-auth-url', async (req, res) => {
    const { scopes, accountType } = req.body;
    const { clientId } = await getTwitchCredentials();

    if (!clientId) {
        return res.status(400).json({ error: 'TWITCH_CLIENT_ID not found in .env' });
    }

    if (!scopes || !Array.isArray(scopes) || scopes.length === 0) {
        return res.status(400).json({ error: 'No scopes provided' });
    }

    const scopeString = scopes.join(' ');
    const state = accountType || 'bot';
    const authUrl = `https://id.twitch.tv/oauth2/authorize?` +
        `client_id=${clientId}&` +
        `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
        `response_type=code&` +
        `scope=${encodeURIComponent(scopeString)}&` +
        `state=${state}`;

    res.json({ authUrl });
});

// Validate token
router.get('/validate-token', async (req, res) => {
    const { token } = req.query;
    const { clientId } = await getTwitchCredentials();

    if (!token) return res.status(400).json({ error: 'No token provided' });

    try {
        const tokenInfoResponse = await axios.get('https://id.twitch.tv/oauth2/validate', {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const userResponse = await axios.get('https://api.twitch.tv/helix/users', {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Client-ID': clientId
            }
        });

        const user = userResponse.data.data[0];
        res.json({
            success: true,
            valid: true,
            username: user.display_name,
            userId: user.id,
            scopes: tokenInfoResponse.data.scopes || [],
            expiresIn: tokenInfoResponse.data.expires_in
        });
    } catch (error) {
        res.status(401).json({ success: false, valid: false, error: error.response?.data?.message || error.message });
    }
});

// Test connection
router.post('/api/test-connection', async (req, res) => {
    const { token, type } = req.body;
    if (!token) return res.status(400).json({ success: false, error: 'No token provided' });

    try {
        const env = await envManager.getEnv();
        const clientId = env.TWITCH_CLIENT_ID;

        const userResponse = await axios.get('https://api.twitch.tv/helix/users', {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Client-ID': clientId
            }
        });

        res.json({
            success: true,
            message: `Connection test successful for ${type}`,
            data: userResponse.data.data[0]
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.response?.data?.message || error.message
        });
    }
});

module.exports = router;
