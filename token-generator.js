require('./lib/console-timestamp');
const express = require('express');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { withCrossProcessLock } = require('./lib/file-lock');
const { asyncHandler } = require('./lib/api-utils');
const { errorHandler } = require('./dashboard/lib/middleware');
const Logger = require('./lib/logger');
const EnvManager = require('./lib/env-manager');
const AccountManager = require('./account-manager');

require('dotenv').config();

const logger = new Logger('TokenGenerator');
const envManager = new EnvManager(process.env.ENV_PATH || '.env', process.env.BACKUP_DIR || 'backups');
const accountManager = new AccountManager();

const app = express();
const PORT = process.env.TOKEN_GENERATOR_PORT || 3000;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

app.use(express.json());

// Serve static files from the new public directory
app.use(express.static(path.join(__dirname, 'public', 'token-generator')));

// API Routes
app.use('/api/env', require('./token-generator-api/env-routes'));
app.use('/api/accounts', require('./token-generator-api/account-routes'));
app.use('/api/scope-presets', (req, res) => res.redirect('/api/scopes/presets'));
app.use('/api/scopes', require('./token-generator-api/scope-routes'));
app.use('/', require('./token-generator-api/auth-routes'));

// Custom endpoints for frontend compatibility
app.get('/api/current-tokens', asyncHandler(async (req, res) => {
    const env = await envManager.getEnv();
    res.json({
        botToken: env.TWITCH_ACCESS_TOKEN || null,
        botScopes: (env.TWITCH_SCOPES || '').split(' ').filter(Boolean),
        broadcasterToken: env.TWITCH_BROADCASTER_ACCESS_TOKEN || null,
        broadcasterScopes: (env.TWITCH_BROADCASTER_SCOPES || '').split(' ').filter(Boolean)
    });
}));

// Callback handler (Integrated for simplicity of redirect logic)
app.get('/callback', async (req, res) => {
    const { code, error, error_description, state } = req.query;
    
    let accountName = null;
    let accountType = 'bot';
    
    if (state && state.includes('_')) {
        const parts = state.split('_');
        accountType = parts[parts.length - 1];
        accountName = parts.slice(0, -1).join('_');
    } else if (state) {
        accountName = state === 'bot' || state === 'broadcaster' ? null : state;
        accountType = state === 'broadcaster' ? 'broadcaster' : 'bot';
    }

    if (error) {
        logger.error(`Auth error: ${error}`, { error_description });
        return res.status(400).send(`<h1>Auth Error</h1><p>${error_description}</p><a href="/">Back</a>`);
    }

    if (!code) return res.status(400).send('<h1>Error: No code received</h1>');

    try {
        const env = await envManager.getEnv();
        const clientId = env.TWITCH_CLIENT_ID;
        const clientSecret = env.TWITCH_CLIENT_SECRET;

        const response = await axios.post('https://id.twitch.tv/oauth2/token', null, {
            params: {
                client_id: clientId,
                client_secret: clientSecret,
                code: code,
                grant_type: 'authorization_code',
                redirect_uri: REDIRECT_URI
            }
        });

        const { access_token, refresh_token, expires_in, scope } = response.data;
        const scopeArray = Array.isArray(scope) ? scope : (scope ? scope.split(' ') : []);
        const scopeString = scopeArray.join(' ');

        logger.info(`Token exchange successful for ${accountType}`, { accountName });

        // Auto-backup before updating credentials
        try {
            const backupName = await envManager.createBackup();
            logger.info(`Automatic backup created before token update: ${backupName}`);
        } catch (backupErr) {
            logger.warn(`Failed to create automatic backup: ${backupErr.message}`);
        }

        if (accountName) {
            // Save to Account Manager
            const updates = accountType === 'broadcaster' ? {
                broadcasterAccessToken: access_token,
                broadcasterRefreshToken: refresh_token,
                broadcasterScopes: scopeArray,
                broadcasterExpiresIn: expires_in
            } : {
                accessToken: access_token,
                refreshToken: refresh_token,
                scopes: scopeArray,
                expiresIn: expires_in
            };
            accountManager.updateTokens(accountName, updates);
            logger.info(`Tokens saved to account: ${accountName}`);
        } else {
            // Save directly to .env
            const updates = accountType === 'broadcaster' ? {
                TWITCH_BROADCASTER_ACCESS_TOKEN: access_token,
                TWITCH_BROADCASTER_REFRESH_TOKEN: refresh_token,
                TWITCH_BROADCASTER_SCOPES: scopeString
            } : {
                TWITCH_ACCESS_TOKEN: access_token,
                TWITCH_REFRESH_TOKEN: refresh_token,
                TWITCH_SCOPES: scopeString
            };
            await envManager.updateEnv(updates);
            logger.info(`Tokens saved to .env`);
        }

        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Success!</title>
                <style>
                    body { font-family: sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
                    .card { background: white; padding: 30px; border-radius: 8px; display: inline-block; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                    .success { color: #4caf50; font-size: 24px; margin-bottom: 20px; }
                </style>
            </head>
            <body>
                <div class="card">
                    <div class="success">Success! 🎉</div>
                    <p>Tokens for <strong>${accountType}</strong> have been saved.</p>
                    <p>Account: ${accountName || '.env file'}</p>
                    <p><a href="/">Back to Dashboard</a></p>
                    <script>setTimeout(() => window.close(), 5000);</script>
                </div>
            </body>
            </html>
        `);
    } catch (err) {
        logger.error('Token exchange failed', { error: err.response?.data || err.message });
        res.status(500).send(`<h1>Exchange Failed</h1><pre>${err.message}</pre>`);
    }
});

app.use(errorHandler);

if (require.main === module) {
    app.listen(PORT, () => {
        logger.info(`Token Generator Server running at http://localhost:${PORT}`);
    });
}

module.exports = app;
