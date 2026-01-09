const express = require('express');
const axios = require('axios');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = 3000;

// Middleware to parse JSON
app.use(express.json());

// Your Twitch app credentials
const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;

// Scopes needed for the bot
const SCOPES = [
  'chat:read',
  'chat:edit',
  'clips:edit',
  'moderator:read:followers'
].join(' ');

// Store pending scope upgrades
const pendingUpgrades = new Map();

// Home page - show authorization link
app.get('/', (req, res) => {
  console.log('Home page requested');

  const authUrl = `https://id.twitch.tv/oauth2/authorize?` +
    `client_id=${CLIENT_ID}&` +
    `redirect_uri=http://localhost:${PORT}/callback&` +
    `response_type=code&` +
    `scope=${encodeURIComponent(SCOPES)}`;

  console.log('Generated auth URL:', authUrl);

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Twitch Bot Token Generator</title>
      <style>
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
        .auth-link { background: #9146FF; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; display: inline-block; margin: 20px 0; }
        .auth-link:hover { background: #772CE8; }
      </style>
    </head>
    <body>
      <h1>Twitch Bot Token Generator</h1>
      <p>Click the button below to authorize your bot:</p>
      <a href="${authUrl}" class="auth-link" target="_blank">Authorize Bot on Twitch</a>
      <p><small>After authorization, you'll be redirected back here automatically.</small></p>
    </body>
    </html>
  `);
});

// Callback handler
app.get('/callback', async (req, res) => {
  console.log('Callback received with query:', req.query);

  const { code, state, error, error_description } = req.query;

  // Check if this is a scope upgrade callback
  const isUpgrade = state && state.startsWith('upgrade_');
  const upgradeId = isUpgrade ? state : null;

  if (error) {
    console.log('Authorization error:', error, error_description);

    // If it's an upgrade, mark it as failed
    if (isUpgrade && upgradeId) {
      const upgrade = pendingUpgrades.get(upgradeId);
      if (upgrade) {
        upgrade.status = 'error';
        upgrade.error = { error, error_description };
      }
    }

    return res.send(`
      <h1>Authorization Error</h1>
      <p><strong>Error:</strong> ${error}</p>
      <p><strong>Description:</strong> ${error_description}</p>
      <a href="/">Try again</a>
    `);
  }

  if (!code) {
    console.log('No code received in callback');

    // If it's an upgrade, mark it as failed
    if (isUpgrade && upgradeId) {
      const upgrade = pendingUpgrades.get(upgradeId);
      if (upgrade) {
        upgrade.status = 'error';
        upgrade.error = 'No authorization code received';
      }
    }

    return res.send('<h1>Error: No authorization code received</h1>');
  }

  console.log('Received authorization code, exchanging for tokens...');

  try {
    const response = await axios.post('https://id.twitch.tv/oauth2/token', null, {
      params: {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code: code,
        grant_type: 'authorization_code',
        redirect_uri: `http://localhost:${PORT}/callback`
      }
    });

    const { access_token, refresh_token, expires_in, scope } = response.data;
    console.log('Token exchange successful!');
    
    // Handle scope information (can be string or array)
    let grantedScopes = 'No scope info';
    if (scope) {
      if (typeof scope === 'string') {
        grantedScopes = scope.split(' ').join(', ');
      } else if (Array.isArray(scope)) {
        grantedScopes = scope.join(', ');
      }
    }
    console.log('Granted scopes:', grantedScopes);

    // Read current .env file
    let envContent;
    try {
      envContent = fs.readFileSync('.env', 'utf8');
      console.log('Read .env file successfully');
    } catch (readError) {
      console.error('Error reading .env file:', readError.message);
      return res.send(`
        <h1>Error reading .env file</h1>
        <p>${readError.message}</p>
        <p>Make sure the .env file exists in the same directory as this script.</p>
      `);
    }

    // Update the .env file
    const updatedEnv = envContent
      .replace(/TWITCH_ACCESS_TOKEN=.*/, `TWITCH_ACCESS_TOKEN=${access_token}`)
      .replace(/TWITCH_REFRESH_TOKEN=.*/, `TWITCH_REFRESH_TOKEN=${refresh_token}`);

    try {
      fs.writeFileSync('.env', updatedEnv);
      console.log('Tokens saved to .env file successfully');
    } catch (writeError) {
      console.error('Error writing to .env file:', writeError.message);
      return res.send(`
        <h1>Error saving tokens</h1>
        <p>${writeError.message}</p>
        <p>Access Token: ${access_token}</p>
        <p>Refresh Token: ${refresh_token}</p>
        <p>Please manually copy these to your .env file.</p>
      `);
    }

    // If this is a scope upgrade, mark it as completed
    if (isUpgrade && upgradeId) {
      const upgrade = pendingUpgrades.get(upgradeId);
      if (upgrade) {
        upgrade.status = 'completed';
        upgrade.tokens = { access_token, refresh_token, expires_in };
        upgrade.grantedScopes = grantedScopes;
        console.log('✅ Scope upgrade completed successfully!');
      }
    }

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Success!</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; text-align: center; }
          .success { color: #00A82D; font-size: 2em; margin: 20px 0; }
        </style>
      </head>
      <body>
        <h1 class="success">Success! 🎉</h1>
        <p>Your tokens have been saved to the .env file.</p>
        <p><strong>Access Token:</strong> ${access_token.substring(0, 20)}...</p>
        <p><strong>Refresh Token:</strong> ${refresh_token.substring(0, 20)}...</p>
        <p>You can now close this window and start your bot!</p>
        <script>setTimeout(() => window.close(), 5000);</script>
      </body>
      </html>
    `);

  } catch (error) {
    console.error('Token exchange failed:', error.response?.data || error.message);

    // If it's an upgrade, mark it as failed
    if (isUpgrade && upgradeId) {
      const upgrade = pendingUpgrades.get(upgradeId);
      if (upgrade) {
        upgrade.status = 'error';
        upgrade.error = error.response?.data || error.message;
      }
    }

    res.send(`
      <h1>Error exchanging tokens</h1>
      <pre>${JSON.stringify(error.response?.data || error.message, null, 2)}</pre>
      <a href="/">Try again</a>
    `);
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 Token Generator Server running at http://localhost:${PORT}`);
  console.log('📱 Open this URL in your browser to generate tokens\n');
});

// Scope upgrade routes
app.post('/upgrade-scopes', (req, res) => {
  const { missingScopes, userId } = req.body;

  if (!missingScopes || !Array.isArray(missingScopes)) {
    return res.status(400).json({ error: 'Missing or invalid missingScopes parameter' });
  }

  const upgradeId = `upgrade_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  // Generate authorization URL with all required scopes
  const allScopes = [...SCOPES.split(' '), ...missingScopes];
  const uniqueScopes = [...new Set(allScopes)]; // Remove duplicates

  const authUrl = `https://id.twitch.tv/oauth2/authorize?` +
    `client_id=${CLIENT_ID}&` +
    `redirect_uri=http://localhost:${PORT}/callback&` +
    `response_type=code&` +
    `scope=${encodeURIComponent(uniqueScopes.join(' '))}&` +
    `state=${upgradeId}`;

  // Store the upgrade request
  pendingUpgrades.set(upgradeId, {
    missingScopes,
    userId: userId || 'default',
    authUrl,
    timestamp: Date.now(),
    status: 'pending'
  });

  console.log(`🔄 Scope upgrade initiated: ${upgradeId} for scopes: ${missingScopes.join(', ')}`);

  res.json({
    upgradeId,
    authUrl,
    message: 'Scope upgrade initiated. Please complete authorization.'
  });
});

app.get('/upgrade-status/:upgradeId', (req, res) => {
  const { upgradeId } = req.params;
  const upgrade = pendingUpgrades.get(upgradeId);

  if (!upgrade) {
    return res.status(404).json({ error: 'Upgrade not found' });
  }

  res.json({
    upgradeId,
    status: upgrade.status,
    missingScopes: upgrade.missingScopes,
    userId: upgrade.userId,
    authUrl: upgrade.authUrl
  });
});
// Cleanup old upgrades every hour
setInterval(() => {
  const now = Date.now();
  for (const [key, upgrade] of pendingUpgrades.entries()) {
    if (now - upgrade.timestamp > 3600000) { // 1 hour
      pendingUpgrades.delete(key);
    }
  }
}, 3600000);