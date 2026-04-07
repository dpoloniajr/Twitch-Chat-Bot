let currentWizardStep = 1;
let requiredScopes = { bot: [], broadcaster: [] };
let GLOBAL_FEATURE_SCOPES = {}; // Store feature-to-scope mapping from backend
let selectedFeatures = {
    chat: true, clips: true, shoutouts: true, followage: true,
    polls: true, predictions: true, announcements: true,
    eventsub: true, redemptions: true, song_requests: false,
    moderation: false, delete_messages: false, automod: false, shield_mode: false, warnings: false,
    vip_management: false, moderator_management: false,
    channel_updates: false, schedule_management: false, ads_management: false,
    hype_trains: false, bits: false, subscriptions: false, follows_read: false,
    user_email: false, extensions: false, analytics: false, charity: false, goals: false,
    guest_star: false, unban_requests: false, whispers: false
};

const FEATURES = [
    { id: 'chat', label: '💬 Chat', required: true },
    { id: 'clips', label: '🎬 Clips' },
    { id: 'shoutouts', label: '📢 Shoutouts' },
    { id: 'followage', label: '👥 Followage' },
    { id: 'polls', label: '📊 Polls' },
    { id: 'predictions', label: '🎲 Predictions' },
    { id: 'announcements', label: '📣 Announcements' },
    { id: 'eventsub', label: '🔔 EventSub' },
    { id: 'redemptions', label: '⭐ Channel Points' },
    { id: 'song_requests', label: '🎵 Song Requests' },
    { id: 'moderation', label: '🚫 Moderation (Ban/Timeout)' },
    { id: 'delete_messages', label: '🗑️ Delete Messages' },
    { id: 'automod', label: '⚙️ AutoMod Control' },
    { id: 'shield_mode', label: '🛡️ Shield Mode' },
    { id: 'warnings', label: '⚠️ User Warnings' },
    { id: 'vip_management', label: '👑 VIP Management' },
    { id: 'moderator_management', label: '🔧 Moderator Mgmt' },
    { id: 'channel_updates', label: '📝 Update Title/Game' },
    { id: 'schedule_management', label: '📅 Stream Schedule' },
    { id: 'ads_management', label: '📺 Ads Management' },
    { id: 'hype_trains', label: '🚂 Hype Trains' },
    { id: 'bits', label: '💎 Bits Info' },
    { id: 'subscriptions', label: '📬 Subscriptions' },
    { id: 'follows_read', label: '👀 Read Followers' },
    { id: 'guest_star', label: '⭐ Guest Star' },
    { id: 'unban_requests', label: '✋ Unban Requests' },
    { id: 'whispers', label: '💬 Whispers' },
    { id: 'user_email', label: '📧 User Email' },
    { id: 'extensions', label: '🧩 Extensions' },
    { id: 'analytics', label: '📊 Analytics' },
    { id: 'charity', label: '❤️ Charity' },
    { id: 'goals', label: '🏅 Creator Goals' }
];

async function initPage() {
    await autoSelectFeatures();
    renderFeatures();
    await loadPresets();
    await loadScopeCategories();
    updateAccountContext();
    setTimeout(loadCurrentScopes, 100);
}

async function autoSelectFeatures() {
    try {
        const response = await fetch('/api/scopes/required');
        const data = await response.json();
        
        if (data.featureScopes) {
            GLOBAL_FEATURE_SCOPES = data.featureScopes;
        }

        if (data.activeFeatures) {
            // Store required scopes from backend for validation
            requiredScopes.bot = data.bot || [];
            requiredScopes.broadcaster = data.broadcaster || [];
            
            data.activeFeatures.forEach(feat => {
                if (selectedFeatures.hasOwnProperty(feat.id)) {
                    selectedFeatures[feat.id] = true;
                }
            });
            
            console.log('Auto-selected features based on environment:', data.activeFeatures.map(f => f.id));
        }
    } catch (error) {
        console.error('Failed to auto-select features:', error);
    }
}

function renderFeatures() {
    const container = document.getElementById('wizard-features');
    container.innerHTML = FEATURES.map(f => `
        <div class="feature-box ${selectedFeatures[f.id] ? 'selected' : ''}" onclick="toggleFeature('${f.id}', this)">
            <input type="checkbox" id="feat-${f.id}" ${selectedFeatures[f.id] ? 'checked' : ''} ${f.required ? 'disabled' : ''}>
            <label for="feat-${f.id}">${f.label}</label>
        </div>
    `).join('');
}

async function loadPresets() {
    try {
        const response = await fetch('/api/scopes/presets');
        const presets = await response.json();
        const container = document.getElementById('scope-presets');
        container.innerHTML = Object.entries(presets).map(([key, preset]) => `
            <div class="preset-card" onclick="applyPreset('${key}')">
                <h4>${preset.name}</h4>
                <p>${preset.description}</p>
                <div class="scope-count">${preset.scopes.length} scopes</div>
            </div>
        `).join('');
    } catch (error) {
        console.error('Failed to load presets:', error);
    }
}

async function loadScopeCategories() {
    try {
        const response = await fetch('/api/scopes/categories');
        const categories = await response.json();
        const container = document.getElementById('scope-categories');
        
        container.innerHTML = Object.entries(categories).map(([category, scopes]) => `
            <div class="scope-category">
                <div class="scope-category-header" onclick="toggleCategory(this)">
                    ${category}
                    <span class="selected-count" id="${category.replace(/\s+/g, '-')}-count">0</span>
                </div>
                <div class="scope-category-content">
                    ${scopes.map(s => `
                        <div class="scope-item">
                            <input type="checkbox" id="scope-${s.scope.replace(/:/g, '-')}" class="scope-checkbox" onchange="updateScopeCounter()">
                            <label for="scope-${s.scope.replace(/:/g, '-')}">
                                <strong>${s.scope}</strong><br>
                                <span style="font-size: 12px; color: #999;">${s.description}</span>
                            </label>
                        </div>
                    `).join('')}
                </div>
            </div>
        `).join('');
    } catch (error) {
        console.error('Failed to load categories:', error);
    }
}

function switchTab(e, tabName) {
    document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    
    e.target.classList.add('active');
    document.getElementById(tabName + '-tab').classList.add('active');
    
    if (tabName === 'backup') loadBackups();
}

function toggleFeature(feature, element) {
    if (feature === 'chat') return;
    const checkbox = document.getElementById('feat-' + feature);
    checkbox.checked = !checkbox.checked;
    selectedFeatures[feature] = checkbox.checked;
    element.classList.toggle('selected', checkbox.checked);
}

function toggleCategory(header) {
    const content = header.nextElementSibling;
    content.classList.toggle('collapsed');
}

function wizardNext(step) {
    document.getElementById('wizard-step-' + step).classList.remove('active');
    document.getElementById('step' + step).classList.add('completed');
    document.getElementById('step' + step).classList.remove('active');
    
    currentWizardStep = step + 1;
    
    document.getElementById('wizard-step-' + currentWizardStep).classList.add('active');
    document.getElementById('step' + currentWizardStep).classList.add('active');
    
    if (currentWizardStep === 2) updateWizardScopeSummary();
    if (currentWizardStep === 3) updateWizardAuthButtons();
}

function wizardPrev(step) {
    document.getElementById('wizard-step-' + step).classList.remove('active');
    document.getElementById('step' + step).classList.remove('active', 'completed');
    
    currentWizardStep = step - 1;
    
    document.getElementById('wizard-step-' + currentWizardStep).classList.add('active');
    document.getElementById('step' + currentWizardStep).classList.add('active');
}

function updateWizardScopeSummary() {
    let botScopes = new Set();
    let broadcasterScopes = new Set();
    
    // Calculate required scopes based on user selected features
    Object.keys(selectedFeatures).forEach(featId => {
        if (selectedFeatures[featId]) {
            const featData = GLOBAL_FEATURE_SCOPES[featId];
            if (featData) {
                if (featData.bot) featData.bot.forEach(s => botScopes.add(s));
                if (featData.broadcaster) featData.broadcaster.forEach(s => broadcasterScopes.add(s));
            }
        }
    });

    // Special handling for hardcoded mappings not yet in lib/feature-scopes.js
    // We should migrate these to lib/feature-scopes.js eventually
    if (selectedFeatures.delete_messages) botScopes.add('moderator:manage:chat_messages');
    if (selectedFeatures.shield_mode) botScopes.add('moderator:manage:shield_mode');
    if (selectedFeatures.warnings) botScopes.add('moderator:manage:warnings');
    if (selectedFeatures.unban_requests) botScopes.add('moderator:manage:unban_requests');
    if (selectedFeatures.moderator_management) {
        botScopes.add('moderation:read');
        botScopes.add('moderator:manage:moderators');
    }
    if (selectedFeatures.schedule_management) botScopes.add('channel:manage:schedule');
    if (selectedFeatures.ads_management) botScopes.add('channel:manage:ads');
    if (selectedFeatures.guest_star) botScopes.add('channel:manage:guest_star');
    if (selectedFeatures.user_email) botScopes.add('user:read:email');
    if (selectedFeatures.extensions) botScopes.add('channel:manage:extensions');
    if (selectedFeatures.hype_trains) broadcasterScopes.add('channel:read:hype_train');
    if (selectedFeatures.follows_read) broadcasterScopes.add('user:read:follows');
    if (selectedFeatures.analytics) broadcasterScopes.add('analytics:read:games');
    if (selectedFeatures.charity) broadcasterScopes.add('channel:read:charity');
    if (selectedFeatures.goals) broadcasterScopes.add('channel:read:goals');

    const botScopesArr = Array.from(botScopes).sort();
    const broadcasterScopesArr = Array.from(broadcasterScopes).sort();

    const html = `
        <div style="display: grid; grid-template-columns: 1fr ${broadcasterScopesArr.length > 0 ? '1fr' : ''}; gap: 20px;">
            <div id="wizard-bot-scopes-container">
                <h4>Bot Account (${botScopesArr.length} scopes)</h4>
                <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px;">
                    ${botScopesArr.map(s => `<span class="scope-badge">${s}</span>`).join('')}
                </div>
            </div>
            ${broadcasterScopesArr.length > 0 ? `
                <div id="wizard-broadcaster-scopes-container">
                    <h4>Broadcaster Account (${broadcasterScopesArr.length} scopes)</h4>
                    <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px;">
                        ${broadcasterScopesArr.map(s => `<span class="scope-badge">${s}</span>`).join('')}
                    </div>
                </div>
            ` : ''}
        </div>
    `;
    document.getElementById('wizard-scope-summary').innerHTML = html;
}

async function updateWizardAuthButtons() {
    const botScopes = Array.from(document.querySelectorAll('#wizard-bot-scopes-container .scope-badge')).map(s => s.innerText);
    const broadcasterScopes = Array.from(document.querySelectorAll('#wizard-broadcaster-scopes-container .scope-badge')).map(s => s.innerText);
    
    const container = document.getElementById('wizard-auth-buttons');
    container.innerHTML = ''; // Clear existing
    
    // Create Bot Auth Button
    const botBtn = document.createElement('button');
    botBtn.className = 'auth-button';
    botBtn.innerHTML = `
        <div class="auth-button-text">
            <h4>🤖 Bot Account</h4>
            <p>Authorize the account that will handle chat actions</p>
        </div>
        <div class="auth-button-arrow">→</div>
    `;
    botBtn.addEventListener('click', () => authorizeWizard('bot', botScopes));
    container.appendChild(botBtn);
    
    // Create Broadcaster Auth Button if needed
    if (broadcasterScopes.length > 0) {
        const broadcasterBtn = document.createElement('button');
        broadcasterBtn.className = 'auth-button';
        broadcasterBtn.innerHTML = `
            <div class="auth-button-text">
                <h4>📺 Broadcaster Account</h4>
                <p>Authorize the primary streaming account (for EventSub)</p>
            </div>
            <div class="auth-button-arrow">→</div>
        `;
        broadcasterBtn.addEventListener('click', () => authorizeWizard('broadcaster', broadcasterScopes));
        container.appendChild(broadcasterBtn);
    }
}

async function authorizeWizard(type, scopes) {
    if (!scopes || scopes.length === 0) {
        alert(`No scopes selected for ${type} account. Please go back and select features.`);
        return;
    }
    
    try {
        const response = await fetch('/api/generate-auth-url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scopes, accountType: type })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.error || `HTTP error! status: ${response.status}`);
        }
        
        if (data.authUrl) {
            window.open(data.authUrl, '_blank');
        } else {
            throw new Error('No authorization URL received from server');
        }
    } catch (error) {
        console.error('Auth error:', error);
        alert('Failed to generate auth URL: ' + error.message);
    }
}

function wizardComplete() {
    alert('Setup complete! Your tokens have been saved. Restart the bot to apply changes.');
    switchTab({ target: document.querySelectorAll('.tab')[2] }, 'validate');
    validateTokens();
}

async function applyPreset(presetKey) {
    try {
        const response = await fetch('/api/scopes/presets');
        const presets = await response.json();
        const preset = presets[presetKey];
        
        document.querySelectorAll('.scope-checkbox').forEach(cb => cb.checked = false);
        preset.scopes.forEach(scope => {
            const checkbox = document.getElementById('scope-' + scope.replace(/:/g, '-'));
            if (checkbox) checkbox.checked = true;
        });
        
        updateScopeCounter();
        document.querySelectorAll('.preset-card').forEach(card => card.classList.remove('active'));
    } catch (error) {
        console.error('Failed to apply preset:', error);
    }
}

function selectAll() {
    document.querySelectorAll('.scope-checkbox').forEach(cb => cb.checked = true);
    updateScopeCounter();
}

function clearAll() {
    document.querySelectorAll('.scope-checkbox').forEach(cb => cb.checked = false);
    updateScopeCounter();
}

function updateScopeCounter() {
    const count = document.querySelectorAll('.scope-checkbox:checked').length;
    document.getElementById('scope-counter').innerText = count + ' selected';
}

function updateAccountContext() {
    const type = document.getElementById('accountType').value;
    const ctx = document.getElementById('account-context');
    if (type === 'bot') ctx.innerText = '💡 Bot account needs scopes for chat, commands, and moderation.';
    else ctx.innerText = '💡 Broadcaster account needs scopes for EventSub (follows, subs, bits, redemptions).';
    loadCurrentScopes();
}

async function loadCurrentScopes() {
    try {
        const response = await fetch('/api/current-tokens');
        const tokens = await response.json();
        const type = document.getElementById('accountType').value;
        const scopes = type === 'bot' ? tokens.botScopes : tokens.broadcasterScopes;
        
        document.querySelectorAll('.scope-checkbox').forEach(cb => cb.checked = false);
        if (scopes) {
            scopes.forEach(s => {
                const cb = document.getElementById('scope-' + s.replace(/:/g, '-'));
                if (cb) cb.checked = true;
            });
        }
        updateScopeCounter();
    } catch (error) {
        console.error('Failed to load current scopes:', error);
    }
}

async function generateTokens() {
    const scopes = Array.from(document.querySelectorAll('.scope-checkbox:checked')).map(cb => cb.id.replace('scope-', '').replace(/-/g, ':'));
    const type = document.getElementById('accountType').value;
    
    if (scopes.length === 0) return alert('Please select at least one scope');
    
    try {
        const response = await fetch('/api/generate-auth-url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scopes, accountType: type })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.error || `HTTP error! status: ${response.status}`);
        }
        
        if (data.authUrl) {
            window.open(data.authUrl, '_blank');
        } else {
            throw new Error('No authorization URL received from server');
        }
    } catch (error) {
        console.error('Auth error:', error);
        alert('Error: ' + error.message);
    }
}

async function validateTokens() {
    const container = document.getElementById('token-validation');
    container.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 20px;">🔍 Validating tokens...</div>';
    
    try {
        const tokensResponse = await fetch('/api/current-tokens');
        const tokens = await tokensResponse.json();
        
        let html = '';
        const botResult = await validateToken(tokens.botToken, 'Bot Account');
        const broadcasterResult = await validateToken(tokens.broadcasterToken, 'Broadcaster Account');
        
        container.innerHTML = botResult + broadcasterResult;
    } catch (error) {
        container.innerHTML = `<div class="token-card invalid"><h4>Error</h4><p>${error.message}</p></div>`;
    }
}

async function validateToken(token, title) {
    if (!token) {
        return `<div class="token-card invalid"><h4>${title} <span class="status-badge invalid">Not Found</span></h4><p>No token configured in .env</p></div>`;
    }
    
    try {
        const response = await fetch(`/api/validate-token?token=${token}`);
        const data = await response.json();
        
        if (data.valid) {
            const hours = Math.floor(data.expiresIn / 3600);
            const isBot = title.includes('Bot');
            const requiredScopes = isBot ? 
                ['chat:read', 'chat:edit'] : 
                ['moderator:read:followers', 'channel:read:redemptions'];
            
            const missingScopes = requiredScopes.filter(s => !data.scopes.includes(s));
            
            return `
                <div class="token-card valid">
                    <h4>${title} <span class="status-badge valid">✓ Valid</span></h4>
                    <div class="token-info">
                        <div><strong>Username:</strong> ${data.username}</div>
                        <div><strong>Expires In:</strong> ${hours} hours</div>
                        <div style="margin-top:10px"><strong>Token Scopes:</strong></div>
                        <div style="max-height: 100px; overflow-y: auto; background: #eee; padding: 5px; font-size: 11px;">
                            ${data.scopes.map(s => `<span style="display:inline-block; margin:2px; padding:2px 5px; background:#ddd; border-radius:3px">${s}</span>`).join('')}
                        </div>
                        ${missingScopes.length > 0 ? `
                            <div style="color: #ff9800; font-size: 12px; margin-top: 10px;">
                                ⚠️ Missing recommended scopes: ${missingScopes.join(', ')}
                            </div>
                        ` : `
                            <div style="color: #4caf50; font-size: 12px; margin-top: 10px;">
                                ✅ All recommended scopes present
                            </div>
                        `}
                    </div>
                    <button class="btn btn-secondary" style="width:100%; margin-top:10px; padding:8px" onclick="testConnection('${token}', '${title}')">🧪 Test Connection</button>
                </div>
            `;
        } else {
            return `<div class="token-card invalid"><h4>${title} <span class="status-badge invalid">✗ Invalid</span></h4><p>${data.error}</p></div>`;
        }
    } catch (error) {
        return `<div class="token-card invalid"><h4>${title} <span class="status-badge invalid">Error</span></h4><p>${error.message}</p></div>`;
    }
}

async function testConnection(token, title) {
    try {
        const response = await fetch('/api/test-connection', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, type: title.includes('Bot') ? 'bot' : 'broadcaster' })
        });
        const data = await response.json();
        
        if (data.success) {
            alert(`✅ Connection Test Successful for ${title}!\n\nUser: ${data.data.display_name}\nID: ${data.data.id}\nType: ${data.data.type || 'Normal'}`);
        } else {
            alert(`❌ Connection Test Failed for ${title}:\n\n${data.error}`);
        }
    } catch (error) {
        alert(`❌ Error testing connection: ${error.message}`);
    }
}

// Account Manager Functions
async function loadAccounts() {
    const container = document.getElementById('accounts-list');
    container.innerHTML = '<p style="text-align: center; padding: 20px;">Loading...</p>';
    
    try {
        const response = await fetch('/api/accounts');
        const data = await response.json();
        const accounts = data.accounts || [];
        
        if (accounts.length === 0) {
            container.innerHTML = '<p style="color: #999; text-align: center; padding: 20px;">No accounts yet.</p>';
            return;
        }
        
        container.innerHTML = '<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 15px;">' + 
            accounts.map(a => `
                <div class="preset-card">
                    <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                        <h4 style="margin:0">${a.name}</h4>
                        <span class="status-badge ${a.tokenStatus === 'valid' ? 'valid' : 'invalid'}" style="font-size:10px">${a.tokenStatus}</span>
                    </div>
                    <p style="margin: 10px 0; font-size: 13px;">Broadcaster: ${a.broadcasterName}</p>
                    <div class="btn-group" style="margin-top: 10px; font-size: 12px;">
                        <button class="btn btn-primary" style="padding: 5px 10px; font-size: 11px;" onclick="authorizeAccount('${a.name}', 'bot')">🤖 Auth Bot</button>
                        <button class="btn btn-secondary" style="padding: 5px 10px; font-size: 11px;" onclick="authorizeAccount('${a.name}', 'broadcaster')">📺 Auth Broadcaster</button>
                    </div>
                </div>
            `).join('') + '</div>';
    } catch (error) {
        container.innerHTML = `<p style="color: red;">Error: ${error.message}</p>`;
    }
}

async function createNewAccount() {
    const name = document.getElementById('new-account-name').value.trim();
    const broadcasterName = document.getElementById('new-broadcaster-name').value.trim();
    const clientId = document.getElementById('new-client-id').value.trim();
    const clientSecret = document.getElementById('new-client-secret').value.trim();
    const channels = document.getElementById('new-channels').value.split(',').map(s => s.trim()).filter(Boolean);
    
    if (!name || !clientId || !clientSecret || !broadcasterName) return alert('Please fill in required fields');
    
    try {
        const response = await fetch('/api/accounts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accountName: name, clientId, clientSecret, broadcasterName, channels })
        });
        const data = await response.json();
        if (data.success) {
            alert('Account created!');
            loadAccounts();
        } else alert('Error: ' + data.error);
    } catch (error) {
        alert('Error: ' + error.message);
    }
}

async function authorizeAccount(name, type) {
    try {
        const response = await fetch(`/api/accounts/${name}`);
        const data = await response.json();
        const acc = data.account;
        
        let scopes = new Set();
        
        // If we have GLOBAL_FEATURE_SCOPES, use it to determine recommended scopes
        if (Object.keys(GLOBAL_FEATURE_SCOPES).length > 0) {
            // Recommendation: include basic bot features or eventsub features
            Object.keys(GLOBAL_FEATURE_SCOPES).forEach(featId => {
                const feat = GLOBAL_FEATURE_SCOPES[featId];
                if (type === 'bot' && feat.bot) {
                    // For bot auth, include features that are typically enabled
                    const botDefaults = ['chat', 'clips', 'announcements', 'shoutouts', 'polls', 'predictions', 'moderation'];
                    if (botDefaults.includes(featId)) {
                        feat.bot.forEach(s => scopes.add(s));
                    }
                } else if (type === 'broadcaster' && feat.broadcaster) {
                    // For broadcaster auth, include EventSub related features
                    const broadcasterDefaults = ['eventsub', 'redemptions', 'bits', 'subscriptions'];
                    if (broadcasterDefaults.includes(featId)) {
                        feat.broadcaster.forEach(s => scopes.add(s));
                    }
                }
            });
        }
        
        // Fallback/Ensure basic scopes if Set is empty
        if (scopes.size === 0) {
            if (type === 'bot') {
                ['chat:read', 'chat:edit', 'clips:edit', 'moderator:manage:shoutouts', 'channel:manage:polls', 'channel:manage:predictions', 'moderator:manage:announcements'].forEach(s => scopes.add(s));
            } else {
                ['moderator:read:followers', 'channel:read:redemptions', 'channel:read:subscriptions', 'bits:read'].forEach(s => scopes.add(s));
            }
        }
        
        const scopeArray = Array.from(scopes).sort();
        const authUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${acc.clientId}&redirect_uri=${encodeURIComponent(location.origin + '/callback')}&response_type=code&scope=${scopeArray.join('+')}&state=${name}_${type}`;
        window.open(authUrl, '_blank');
    } catch (error) {
        alert('Error: ' + error.message);
    }
}

async function importFromEnv() {
    const name = document.getElementById('import-account-name').value.trim();
    const content = document.getElementById('import-env-content').value.trim();
    if (!name || !content) return alert('Fields required');
    
    try {
        const response = await fetch('/api/accounts/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accountName: name, envContent: content })
        });
        const data = await response.json();
        if (data.success) {
            alert('Imported!');
            loadAccounts();
        } else alert('Error: ' + data.error);
    } catch (error) {
        alert('Error: ' + error.message);
    }
}

// Backup & Recovery Functions
async function loadBackups() {
    const container = document.getElementById('backups-list');
    container.innerHTML = '<p>Loading backups...</p>';
    
    try {
        const response = await fetch('/api/env/backups');
        const data = await response.json();
        const backups = data.backups || [];
        
        if (backups.length === 0) {
            container.innerHTML = '<p style="color: #999;">No backups found.</p>';
            return;
        }
        
        container.innerHTML = backups.map(b => `
            <div class="backup-item">
                <div class="backup-info">
                    <h4>${b.filename}</h4>
                    <p>Created: ${new Date(b.createdAt).toLocaleString()} | Size: ${(b.size / 1024).toFixed(2)} KB</p>
                </div>
                <div class="btn-group" style="margin:0">
                    <button class="btn btn-primary" style="padding:8px 15px;" onclick="restoreBackup('${b.filename}')">⏪ Restore</button>
                </div>
            </div>
        `).join('');
    } catch (error) {
        container.innerHTML = `<p style="color:red">Error: ${error.message}</p>`;
    }
}

async function createBackup() {
    try {
        const response = await fetch('/api/env/backup', { method: 'POST' });
        const data = await response.json();
        if (data.success) {
            alert('Backup created: ' + data.backupName);
            loadBackups();
        } else alert('Error: ' + data.error);
    } catch (error) {
        alert('Error: ' + error.message);
    }
}

async function restoreBackup(filename) {
    if (!confirm('⚠️ Restore configuration from ' + filename + '? This will overwrite your current .env file.')) return;
    
    try {
        const response = await fetch('/api/env/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ backupName: filename })
        });
        const data = await response.json();
        if (data.success) {
            alert('✓ Configuration restored successfully!');
            location.reload();
        } else alert('Error: ' + data.error);
    } catch (error) {
        alert('Error: ' + error.message);
    }
}

initPage();
loadAccounts();
