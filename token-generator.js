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

// All available Twitch OAuth scopes grouped by category
const SCOPE_CATEGORIES = {
  'Chat (IRC)': [
    { scope: 'chat:read', description: 'Read chat messages' },
    { scope: 'chat:edit', description: 'Send chat messages' }
  ],
  'Chat (Bot/User)': [
    { scope: 'channel:bot', description: 'Join chat as a bot and perform chat actions' },
    { scope: 'user:bot', description: 'Join chat as a user and appear as a bot' },
    { scope: 'user:write:chat', description: 'Send chat messages as user' },
    { scope: 'user:read:chat', description: 'Receive chatroom messages' },
    { scope: 'moderator:manage:announcements', description: 'Send announcements in chat' }
  ],
  'Clips': [
    { scope: 'clips:edit', description: 'Create and manage clips' },
    { scope: 'channel:manage:clips', description: 'Manage clips for a channel' },
    { scope: 'editor:manage:clips', description: 'Create clips as an editor' }
  ],
  'Moderation': [
    { scope: 'moderation:read', description: 'View channel moderation data' },
    { scope: 'moderator:read:banned_users', description: 'View banned users' },
    { scope: 'moderator:manage:banned_users', description: 'Ban and unban users' },
    { scope: 'moderator:read:followers', description: 'Read followers list' },
    { scope: 'moderator:read:moderators', description: 'Read moderators list' },
    { scope: 'moderator:manage:moderators', description: 'Add/remove moderators' },
    { scope: 'moderator:manage:chat_messages', description: 'Delete chat messages' },
    { scope: 'moderator:read:chat_messages', description: 'Read deleted chat messages' },
    { scope: 'moderator:read:automod_settings', description: 'View AutoMod settings' },
    { scope: 'moderator:manage:automod_settings', description: 'Manage AutoMod settings' },
    { scope: 'moderator:manage:automod', description: 'Manage held AutoMod messages' },
    { scope: 'moderator:read:blocked_terms', description: 'View blocked terms' },
    { scope: 'moderator:manage:blocked_terms', description: 'Manage blocked terms' },
    { scope: 'moderator:read:chat_settings', description: 'View chat settings' },
    { scope: 'moderator:manage:chat_settings', description: 'Manage chat settings' },
    { scope: 'moderator:read:chatters', description: 'View chatters in chatroom' },
    { scope: 'moderator:read:shoutouts', description: 'View shoutouts' },
    { scope: 'moderator:manage:shoutouts', description: 'Send shoutouts' }
  ],
  'Channel Management': [
    { scope: 'channel:manage:broadcast', description: 'Manage broadcast settings' },
    { scope: 'channel:read:ads', description: 'Read ads schedule' },
    { scope: 'channel:manage:ads', description: 'Manage ads schedule' },
    { scope: 'channel:edit:commercial', description: 'Run commercials' },
    { scope: 'channel:read:stream_key', description: 'View stream key' },
    { scope: 'channel:manage:schedule', description: 'Manage stream schedule' },
    { scope: 'channel:manage:videos', description: 'Manage videos' },
    { scope: 'channel:read:editors', description: 'View channel editors' }
  ],
  'Followers & Subscriptions': [
    { scope: 'channel:read:subscriptions', description: 'View channel subscriptions' },
    { scope: 'user:read:follows', description: 'View channels you follow' }
  ],
  'VIPs': [
    { scope: 'channel:read:vips', description: 'View VIPs in channel' },
    { scope: 'channel:manage:vips', description: 'Manage VIPs' },
    { scope: 'moderator:read:vips', description: 'View VIPs (moderator view)' }
  ],
  'Channel Points': [
    { scope: 'channel:read:redemptions', description: 'View Channel Points redemptions' },
    { scope: 'channel:manage:redemptions', description: 'Manage Channel Points redemptions' },
    { scope: 'channel:read:predictions', description: 'View predictions' },
    { scope: 'channel:manage:predictions', description: 'Manage predictions' },
    { scope: 'channel:read:polls', description: 'View polls' },
    { scope: 'channel:manage:polls', description: 'Manage polls' }
  ],
  'User Account': [
    { scope: 'user:edit', description: 'Manage user object' },
    { scope: 'user:read:email', description: 'View email address' },
    { scope: 'user:read:emotes', description: 'View emotes available' },
    { scope: 'user:manage:chat_color', description: 'Update chat color' }
  ],
  'Extensions & Analytics': [
    { scope: 'analytics:read:extensions', description: 'View extension analytics' },
    { scope: 'analytics:read:games', description: 'View game analytics' },
    { scope: 'channel:manage:extensions', description: 'Manage extensions' },
    { scope: 'channel:read:extensions', description: 'View extensions (if scope exists)' },
    { scope: 'user:read:broadcast', description: 'View broadcast config' },
    { scope: 'user:edit:broadcast', description: 'Edit broadcast config' }
  ],
  'Bits': [
    { scope: 'bits:read', description: 'View Bits information' }
  ],
  'Guest Star': [
    { scope: 'channel:read:guest_star', description: 'View Guest Star details' },
    { scope: 'channel:manage:guest_star', description: 'Manage Guest Star' },
    { scope: 'moderator:read:guest_star', description: 'View Guest Star (moderator)' },
    { scope: 'moderator:manage:guest_star', description: 'Manage Guest Star (moderator)' }
  ],
  'Other': [
    { scope: 'channel:read:charity', description: 'View charity campaign details' },
    { scope: 'channel:read:goals', description: 'View Creator Goals' },
    { scope: 'channel:read:hype_train', description: 'View Hype Train info' },
    { scope: 'user:read:blocked_users', description: 'View block list' },
    { scope: 'user:manage:blocked_users', description: 'Manage block list' },
    { scope: 'user:read:subscriptions', description: 'View subscriptions' },
    { scope: 'user:read:moderated_channels', description: 'View moderated channels' },
    { scope: 'user:read:whispers', description: 'Receive whispers' },
    { scope: 'user:manage:whispers', description: 'Send whispers' },
    { scope: 'whispers:read', description: 'Receive whispers (PubSub)' },
    { scope: 'moderator:read:suspicious_users', description: 'View suspicious users' },
    { scope: 'moderator:read:unban_requests', description: 'View unban requests' },
    { scope: 'moderator:manage:unban_requests', description: 'Manage unban requests' },
    { scope: 'moderator:read:warnings', description: 'View warnings' },
    { scope: 'moderator:manage:warnings', description: 'Warn users' },
    { scope: 'channel:moderate', description: 'Perform moderation actions' },
    { scope: 'moderator:read:shield_mode', description: 'View Shield Mode' },
    { scope: 'moderator:manage:shield_mode', description: 'Manage Shield Mode' }
  ]
};

// Flatten all scopes
const ALL_SCOPES = Object.values(SCOPE_CATEGORIES).flatMap(cat => cat.map(s => s.scope));

// Recommended default scopes for this bot
const DEFAULT_SCOPES = [
  'chat:read',
  'chat:edit',
  'clips:edit',
  'channel:read:redemptions',
  'channel:manage:redemptions',
  'channel:manage:polls',
  'channel:manage:predictions',
  'moderator:manage:announcements',
  'channel:moderate'
];

// Home page - show scope selection and authorization link
app.get('/', (req, res) => {
  console.log('Home page requested');

  const accountType = req.query.account || 'bot';

  // Read current scopes from .env if they exist
  let currentScopes = [];
  try {
    const envContent = fs.readFileSync('.env', 'utf8');
    const scopeKey = accountType === 'broadcaster' ? 'TWITCH_BROADCASTER_SCOPES' : 'TWITCH_SCOPES';
    const scopesMatch = envContent.match(new RegExp(`${scopeKey}=(.+)`));
    if (scopesMatch && scopesMatch[1]) {
      currentScopes = scopesMatch[1].trim().split(' ').filter(s => s);
    }
  } catch (err) {
    // .env might not exist yet, that's okay
  }

  console.log(`Current scopes in .env for ${accountType}:`, currentScopes);

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Twitch Bot Token Generator</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
          padding: 20px;
        }
        .container { 
          max-width: 900px; 
          margin: 0 auto; 
          background: white;
          border-radius: 10px;
          box-shadow: 0 20px 60px rgba(0,0,0,0.3);
          overflow: hidden;
        }
        .header {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          padding: 30px;
          text-align: center;
        }
        .header h1 { font-size: 28px; margin-bottom: 10px; }
        .header p { font-size: 14px; opacity: 0.9; }
        .content { padding: 30px; }
        .section { margin-bottom: 30px; }
        .section-title {
          font-size: 16px;
          font-weight: 600;
          color: #333;
          margin-bottom: 15px;
          padding-bottom: 10px;
          border-bottom: 2px solid #667eea;
        }
        .scope-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
          gap: 12px;
          margin-bottom: 20px;
        }
        .scope-item {
          padding: 12px;
          border: 2px solid #e0e0e0;
          border-radius: 6px;
          cursor: pointer;
          transition: all 0.2s ease;
          background: white;
        }
        .scope-item:hover {
          border-color: #667eea;
          background: #f5f7ff;
        }
        .scope-item input[type="checkbox"] {
          margin-right: 10px;
          cursor: pointer;
          width: 18px;
          height: 18px;
        }
        .scope-item input[type="checkbox"]:checked + .scope-text {
          color: #667eea;
        }
        .scope-item label {
          cursor: pointer;
          display: flex;
          align-items: flex-start;
          gap: 10px;
        }
        .scope-text {
          flex: 1;
        }
        .scope-name {
          font-weight: 600;
          color: #333;
          font-size: 13px;
          font-family: 'Courier New', monospace;
          color: #764ba2;
        }
        .scope-desc {
          font-size: 12px;
          color: #666;
          margin-top: 4px;
        }
        .button-group {
          display: flex;
          gap: 10px;
          margin-top: 20px;
          justify-content: center;
        }
        button {
          padding: 12px 24px;
          font-size: 14px;
          border: none;
          border-radius: 6px;
          cursor: pointer;
          font-weight: 600;
          transition: all 0.2s ease;
        }
        .btn-select-all {
          background: #667eea;
          color: white;
        }
        .btn-select-all:hover {
          background: #5568d3;
        }
        .btn-clear {
          background: #f0f0f0;
          color: #333;
        }
        .btn-clear:hover {
          background: #e0e0e0;
        }
        .btn-authorize {
          background: #00a86b;
          color: white;
          padding: 14px 40px;
          font-size: 16px;
          width: 100%;
          margin-top: 20px;
        }
        .btn-authorize:hover {
          background: #008c5a;
        }
        .btn-authorize:disabled {
          background: #ccc;
          cursor: not-allowed;
        }
        .selected-count {
          text-align: center;
          padding: 15px;
          background: #f5f7ff;
          border-radius: 6px;
          font-size: 14px;
          color: #667eea;
          margin-bottom: 20px;
          font-weight: 600;
        }
        .note {
          background: #fff3cd;
          border: 1px solid #ffc107;
          border-radius: 6px;
          padding: 12px;
          margin-top: 20px;
          font-size: 13px;
          color: #856404;
          line-height: 1.5;
        }
        .info-box {
          background: #d1ecf1;
          border: 1px solid #bee5eb;
          border-radius: 6px;
          padding: 12px;
          margin-bottom: 20px;
          font-size: 13px;
          color: #0c5460;
          line-height: 1.5;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>🤖 Twitch Bot Token Generator</h1>
          <p>Select the scopes your bot needs and authorize</p>
        </div>
        <div class="content">
          <div class="info-box" style="margin-bottom: 20px;">
            <strong>🔐 Account Type:</strong> 
            <select id="accountTypeSelect" style="padding: 6px 12px; border-radius: 4px; border: 1px solid #bee5eb; margin-left: 10px;" onchange="window.location.href='/?account=' + this.value">
              <option value="bot" ${accountType === 'bot' ? 'selected' : ''}>Bot Account (mistressexcella)</option>
              <option value="broadcaster" ${accountType === 'broadcaster' ? 'selected' : ''}>Broadcaster Account (ronin_style)</option>
            </select>
            <div style="margin-top: 10px; font-size: 12px;">
              ${accountType === 'bot' 
                ? '✅ Bot Account: For chat commands, clips, and moderation actions' 
                : '✅ Broadcaster Account: For EventSub (follows, raids, redemptions, etc.)'}
            </div>
          </div>
          <form id="scopeForm">
            <input type="hidden" id="accountType" value="${accountType}">
            <div class="selected-count">
              Scopes selected: <span id="selectedCount">0</span> / ${ALL_SCOPES.length}
            </div>

            <div class="info-box">
              ℹ️ <strong>Currently authorized scopes:</strong> <span id="currentScopes">${currentScopes.length > 0 ? currentScopes.join(', ') : 'None'}</span>
            </div>

            <div style="display: flex; gap: 10px; margin-bottom: 30px;">
              <button type="button" class="btn-select-all" onclick="selectAllScopes()">Select All</button>
              <button type="button" class="btn-clear" onclick="clearAllScopes()">Clear All</button>
            </div>

            ${Object.entries(SCOPE_CATEGORIES).map(([category, scopes]) => `
              <div class="section">
                <div class="section-title">${category}</div>
                <div class="scope-grid">
                  ${scopes.map(s => `
                    <div class="scope-item">
                      <label>
                        <input type="checkbox" name="scope" value="${s.scope}" class="scope-checkbox" onchange="updateCount()" ${currentScopes.includes(s.scope) ? 'checked' : ''}>
                        <div class="scope-text">
                          <div class="scope-name">${s.scope}</div>
                          <div class="scope-desc">${s.description}</div>
                        </div>
                      </label>
                    </div>
                  `).join('')}
                </div>
              </div>
            `).join('')}

            <button type="submit" class="btn-authorize">Authorize with Selected Scopes →</button>
            <div class="note">
              💡 <strong>Note:</strong> Select only the scopes your bot actually needs. Requesting excessive scopes may result in app suspension. You can easily add or remove scopes anytime by coming back here.
            </div>
          </form>
        </div>
      </div>

      <script>
        function updateCount() {
          const checked = document.querySelectorAll('.scope-checkbox:checked').length;
          document.getElementById('selectedCount').textContent = checked;
        }

        function selectAllScopes() {
          document.querySelectorAll('.scope-checkbox').forEach(cb => cb.checked = true);
          updateCount();
        }

        function clearAllScopes() {
          document.querySelectorAll('.scope-checkbox').forEach(cb => cb.checked = false);
          updateCount();
        }

        document.getElementById('scopeForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          
          const selectedScopes = Array.from(document.querySelectorAll('.scope-checkbox:checked'))
            .map(cb => cb.value);
          
          const accountType = document.getElementById('accountType').value;

          if (selectedScopes.length === 0) {
            alert('Please select at least one scope');
            return;
          }

          // Send selected scopes to server
          const response = await fetch('/generate-auth-url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scopes: selectedScopes, accountType })
          });

          const data = await response.json();
          if (data.authUrl) {
            window.location.href = data.authUrl;
          } else {
            alert('Error generating authorization URL');
          }
        });

        // Preselect recommended scopes if not present
        (function preselectRecommended() {
          const existing = ${JSON.stringify(DEFAULT_SCOPES)};
          existing.forEach(scope => {
            const checkbox = document.querySelector('input.scope-checkbox[value="' + scope + '"]');
            if (checkbox && !checkbox.checked) {
              checkbox.checked = true;
            }
          });
          updateCount();
        })();

        updateCount();
      </script>
    </body>
    </html>
  `);
});

// Generate authorization URL with selected scopes
app.post('/generate-auth-url', (req, res) => {
  const { scopes, accountType } = req.body;

  if (!scopes || !Array.isArray(scopes) || scopes.length === 0) {
    return res.status(400).json({ error: 'No scopes provided' });
  }

  const scopeString = scopes.join(' ');
  const state = accountType || 'bot'; // Pass account type in state parameter
  const authUrl = `https://id.twitch.tv/oauth2/authorize?` +
    `client_id=${CLIENT_ID}&` +
    `redirect_uri=http://localhost:${PORT}/callback&` +
    `response_type=code&` +
    `scope=${encodeURIComponent(scopeString)}&` +
    `state=${state}`;

  console.log(`Generated auth URL with scopes for ${accountType}:`, scopes.join(', '));

  res.json({ authUrl });
});

// Callback handler
app.get('/callback', async (req, res) => {
  console.log('Callback received with query:', req.query);

  const { code, error, error_description, state } = req.query;
  const accountType = state || 'bot'; // Get account type from state parameter

  if (error) {
    console.log('Authorization error:', error, error_description);
    return res.send(`
      <h1>Authorization Error</h1>
      <p><strong>Error:</strong> ${error}</p>
      <p><strong>Description:</strong> ${error_description}</p>
      <a href="/">Try again</a>
    `);
  }

  if (!code) {
    console.log('No code received in callback');
    return res.send('<h1>Error: No authorization code received</h1>');
  }

  console.log(`Received authorization code for ${accountType} account, exchanging for tokens...`);

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

    // Update the .env file with tokens and scopes
    // Ensure scopes are space-separated, not comma-separated
    const scopeString = Array.isArray(scope) ? scope.join(' ') : (scope || '');
    
    // Determine which keys to update based on account type
    let updatedEnv;
    if (accountType === 'broadcaster') {
      console.log('Updating broadcaster account tokens in .env');
      updatedEnv = envContent
        .replace(/TWITCH_BROADCASTER_ACCESS_TOKEN=.*/, `TWITCH_BROADCASTER_ACCESS_TOKEN=${access_token}`)
        .replace(/TWITCH_BROADCASTER_REFRESH_TOKEN=.*/, `TWITCH_BROADCASTER_REFRESH_TOKEN=${refresh_token}`)
        .replace(/TWITCH_BROADCASTER_SCOPES=.*/, `TWITCH_BROADCASTER_SCOPES=${scopeString}`);
      
      // If keys don't exist, append them
      if (!envContent.includes('TWITCH_BROADCASTER_ACCESS_TOKEN=')) {
        updatedEnv += `\nTWITCH_BROADCASTER_ACCESS_TOKEN=${access_token}`;
      }
      if (!envContent.includes('TWITCH_BROADCASTER_REFRESH_TOKEN=')) {
        updatedEnv += `\nTWITCH_BROADCASTER_REFRESH_TOKEN=${refresh_token}`;
      }
      if (!envContent.includes('TWITCH_BROADCASTER_SCOPES=')) {
        updatedEnv += `\nTWITCH_BROADCASTER_SCOPES=${scopeString}`;
      }
    } else {
      console.log('Updating bot account tokens in .env');
      updatedEnv = envContent
        .replace(/TWITCH_ACCESS_TOKEN=.*/, `TWITCH_ACCESS_TOKEN=${access_token}`)
        .replace(/TWITCH_REFRESH_TOKEN=.*/, `TWITCH_REFRESH_TOKEN=${refresh_token}`)
        .replace(/TWITCH_SCOPES=.*/, `TWITCH_SCOPES=${scopeString}`);
    }

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
        <p>Your <strong>${accountType}</strong> account tokens have been saved to the .env file.</p>
        <p><strong>Access Token:</strong> ${access_token.substring(0, 20)}...</p>
        <p><strong>Refresh Token:</strong> ${refresh_token.substring(0, 20)}...</p>
        <p><strong>Granted Scopes:</strong></p>
        <p style="word-break: break-all; font-size: 12px;">${grantedScopes}</p>
        <p>${accountType === 'broadcaster' 
          ? '✅ EventSub is now ready! Remove <code>DISABLE_EVENTSUB=1</code> from .env and restart the bot.' 
          : '✅ Bot account configured! Now generate tokens for the broadcaster account to enable EventSub.'}</p>
        <p>You can now close this window and start your bot!</p>
        <script>setTimeout(() => window.close(), 8000);</script>
      </body>
      </html>
    `);

  } catch (error) {
    console.error('Token exchange failed:', error.response?.data || error.message);
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