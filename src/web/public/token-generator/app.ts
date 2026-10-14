/*
 * Token generator setup page script (served as public/token-generator/app.js).
 *
 * Plain global script (module "none"): every top-level function stays a
 * global so the inline on* handlers in index.html can call it. HTML built
 * here escapes every value with tokGenEscape, and anything that carries data
 * (account names, backup names, tokens, preset keys) is wired up with
 * addEventListener instead of an inline handler. Type and helper names are
 * prefixed with `TokGen` / `tokGen` to avoid clashing with the other browser
 * scripts compiled in the same program.
 */

// ---- Shapes of the API responses this page reads ----

/** Scopes a feature needs, per account */
interface TokGenFeatureScopeSet {
    bot?: string[];
    broadcaster?: string[];
}

/** /api/scopes/required (fields used here) */
interface TokGenRequiredScopes {
    featureScopes?: Record<string, TokGenFeatureScopeSet>;
    activeFeatures?: { id: string }[];
}

/** /api/scopes/presets values */
interface TokGenPreset {
    name: string;
    description: string;
    scopes: string[];
}

/** /api/scopes/categories values */
interface TokGenScopeInfo {
    scope: string;
    description: string;
}

/** /api/current-tokens */
interface TokGenCurrentTokens {
    botToken?: string;
    broadcasterToken?: string;
    botScopes?: string[];
    broadcasterScopes?: string[];
}

/** /api/generate-auth-url */
interface TokGenAuthUrlResponse {
    authUrl?: string;
    error?: string;
}

/** /api/validate-token */
interface TokGenValidation {
    valid: boolean;
    expiresIn: number;
    username: string;
    scopes: string[];
    error?: string;
}

/** /api/test-connection */
interface TokGenConnectionTest {
    success: boolean;
    data: { display_name: string; id: string; type?: string };
    error?: string;
}

interface TokGenAccountSummary {
    name: string;
    tokenStatus: string;
    broadcasterName: string;
}

interface TokGenBackup {
    filename: string;
    createdAt: string | number;
    size: number;
}

/** Generic { success, error } result of the account / backup endpoints */
interface TokGenResult {
    success: boolean;
    error?: string;
    backupName?: string;
}

interface TokGenFeature {
    id: string;
    label: string;
    required?: boolean;
}

let currentWizardStep = 1;
let GLOBAL_FEATURE_SCOPES: Record<string, TokGenFeatureScopeSet> = {}; // Store feature-to-scope mapping from backend
let selectedFeatures: Record<string, boolean> = {
    chat: true, clips: true, shoutouts: true, followage: true,
    polls: true, predictions: true, announcements: true,
    eventsub: true, redemptions: true, song_requests: false,
    moderation: true, delete_messages: true, automod: false, shield_mode: false, warnings: false,
    vip_management: false, moderator_management: false,
    channel_updates: false, schedule_management: false, ads_management: false,
    hype_trains: false, bits: false, subscriptions: false, follows_read: false,
    user_email: false, extensions: false, analytics: false, charity: false, goals: false,
    guest_star: false, unban_requests: false, whispers: false
};

const FEATURES: TokGenFeature[] = [
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

/** Escape a value for insertion into HTML text or a quoted attribute */
function tokGenEscape(value: unknown): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Call `handler(item)` when an element matching `selector` inside `container`
 * is clicked; the i-th match belongs to items[i]. Used instead of inline
 * onclick handlers so data never has to be written into JavaScript source.
 */
function tokGenBindClicks<T>(container: Element, selector: string, items: T[], handler: (item: T, element: Element) => void) {
    container.querySelectorAll(selector).forEach((element, i) => {
        element.addEventListener('click', () => handler(items[i], element));
    });
}

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
        const data: TokGenRequiredScopes = await response.json();

        if (data.featureScopes) {
            GLOBAL_FEATURE_SCOPES = data.featureScopes;
        }

        if (data.activeFeatures) {
            data.activeFeatures.forEach(feat => {
                if (selectedFeatures.hasOwnProperty(feat.id)) {
                    selectedFeatures[feat.id] = true;
                }
            });

            renderFeatures();
            console.log('Auto-selected features based on environment:', data.activeFeatures.map(f => f.id));
        }
    } catch (error) {
        console.error('Failed to auto-select features:', error);
    }
}

function renderFeatures() {
    const container = document.getElementById('wizard-features')!;
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
        const presets: Record<string, TokGenPreset> = await response.json();
        const container = document.getElementById('scope-presets')!;
        const entries = Object.entries(presets);
        container.innerHTML = entries.map(([, preset]) => `
            <div class="preset-card">
                <h4>${tokGenEscape(preset.name)}</h4>
                <p>${tokGenEscape(preset.description)}</p>
                <div class="scope-count">${preset.scopes.length} scopes</div>
            </div>
        `).join('');
        tokGenBindClicks(container, '.preset-card', entries, ([key]) => applyPreset(key));
    } catch (error) {
        console.error('Failed to load presets:', error);
    }
}

async function loadScopeCategories() {
    try {
        const response = await fetch('/api/scopes/categories');
        const categories: Record<string, TokGenScopeInfo[]> = await response.json();
        const container = document.getElementById('scope-categories')!;

        container.innerHTML = Object.entries(categories).map(([category, scopes]) => `
            <div class="scope-category">
                <div class="scope-category-header" onclick="toggleCategory(this)">
                    ${tokGenEscape(category)}
                    <span class="selected-count" id="${tokGenEscape(category.replace(/\s+/g, '-'))}-count">0</span>
                </div>
                <div class="scope-category-content">
                    ${scopes.map(s => `
                        <div class="scope-item">
                            <input type="checkbox" id="scope-${tokGenEscape(s.scope.replace(/:/g, '-'))}" class="scope-checkbox" onchange="updateScopeCounter()">
                            <label for="scope-${tokGenEscape(s.scope.replace(/:/g, '-'))}">
                                <strong>${tokGenEscape(s.scope)}</strong><br>
                                <span style="font-size: 12px; color: #999;">${tokGenEscape(s.description)}</span>
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

/** `e` is the click event, or a stand-in carrying just the tab element (see wizardComplete) */
function switchTab(e: { target: EventTarget | null }, tabName: string) {
    document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));

    (e.target as Element).classList.add('active');
    document.getElementById(tabName + '-tab')!.classList.add('active');

    if (tabName === 'backup') loadBackups();
}

function toggleFeature(feature: string, element: Element) {
    if (feature === 'chat') return;
    const checkbox = document.getElementById('feat-' + feature) as HTMLInputElement;
    checkbox.checked = !checkbox.checked;
    selectedFeatures[feature] = checkbox.checked;
    element.classList.toggle('selected', checkbox.checked);
}

function toggleCategory(header: Element) {
    const content = header.nextElementSibling!;
    content.classList.toggle('collapsed');
}

function wizardNext(step: number) {
    document.getElementById('wizard-step-' + step)!.classList.remove('active');
    document.getElementById('step' + step)!.classList.add('completed');
    document.getElementById('step' + step)!.classList.remove('active');

    currentWizardStep = step + 1;

    document.getElementById('wizard-step-' + currentWizardStep)!.classList.add('active');
    document.getElementById('step' + currentWizardStep)!.classList.add('active');

    if (currentWizardStep === 2) updateWizardScopeSummary();
    if (currentWizardStep === 3) updateWizardAuthButtons();
}

function wizardPrev(step: number) {
    document.getElementById('wizard-step-' + step)!.classList.remove('active');
    document.getElementById('step' + step)!.classList.remove('active', 'completed');

    currentWizardStep = step - 1;

    document.getElementById('wizard-step-' + currentWizardStep)!.classList.add('active');
    document.getElementById('step' + currentWizardStep)!.classList.add('active');
}

function updateWizardScopeSummary() {
    let botScopes = new Set<string>();
    let broadcasterScopes = new Set<string>();
    const isSingleAccount = (document.getElementById('single-account-mode') as HTMLInputElement | null)?.checked;

    // Calculate required scopes based on user selected features
    Object.keys(selectedFeatures).forEach(featId => {
        if (selectedFeatures[featId]) {
            const featData = GLOBAL_FEATURE_SCOPES[featId];
            if (featData) {
                if (featData.bot) featData.bot.forEach(s => botScopes.add(s));
                if (featData.broadcaster) {
                    if (isSingleAccount) {
                        featData.broadcaster.forEach(s => botScopes.add(s));
                    } else {
                        featData.broadcaster.forEach(s => broadcasterScopes.add(s));
                    }
                }
            }
        }
    });

    const botScopesArr = Array.from(botScopes).sort();
    const broadcasterScopesArr = Array.from(broadcasterScopes).sort();

    const html = `
        <div style="margin-bottom: 20px; padding: 15px; background: #e3f2fd; border-radius: 8px; border-left: 4px solid #2196f3;">
            <label style="display: flex; align-items: center; cursor: pointer; font-weight: bold;">
                <input type="checkbox" id="single-account-mode" style="width: 20px; height: 20px; margin-right: 10px;" onchange="updateWizardScopeSummary()" ${isSingleAccount ? 'checked' : ''}>
                Single Account Mode (Use bot account for broadcaster features)
            </label>
            <p style="margin: 5px 0 0 30px; font-size: 13px; color: #555;">
                Enable this if you are NOT using a separate bot account. The bot token will include all required scopes for alerts and events.
            </p>
        </div>
        <div style="display: grid; grid-template-columns: 1fr ${broadcasterScopesArr.length > 0 ? '1fr' : ''}; gap: 20px;">
            <div id="wizard-bot-scopes-container">
                <h4>${isSingleAccount ? 'Combined Bot & Broadcaster' : 'Bot Account'} (${botScopesArr.length} scopes)</h4>
                <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px;">
                    ${botScopesArr.map(s => `<span class="scope-badge">${tokGenEscape(s)}</span>`).join('')}
                </div>
            </div>
            ${broadcasterScopesArr.length > 0 ? `
                <div id="wizard-broadcaster-scopes-container">
                    <h4>Broadcaster Account (${broadcasterScopesArr.length} scopes)</h4>
                    <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px;">
                        ${broadcasterScopesArr.map(s => `<span class="scope-badge">${tokGenEscape(s)}</span>`).join('')}
                    </div>
                </div>
            ` : ''}
        </div>
    `;
    document.getElementById('wizard-scope-summary')!.innerHTML = html;
}

async function updateWizardAuthButtons() {
    const botScopes = Array.from(document.querySelectorAll<HTMLElement>('#wizard-bot-scopes-container .scope-badge')).map(s => s.innerText);
    const broadcasterScopes = Array.from(document.querySelectorAll<HTMLElement>('#wizard-broadcaster-scopes-container .scope-badge')).map(s => s.innerText);

    const container = document.getElementById('wizard-auth-buttons')!;
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

async function authorizeWizard(type: string, scopes: string[] | null | undefined) {
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

        const data: TokGenAuthUrlResponse = await response.json();

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
        alert('Failed to generate auth URL: ' + (error as Error).message);
    }
}

function wizardComplete() {
    alert('Setup complete! Your tokens have been saved. Restart the bot to apply changes.');
    switchTab({ target: document.querySelectorAll('.tab')[2] }, 'validate');
    validateTokens();
}

async function applyPreset(presetKey: string) {
    try {
        const response = await fetch('/api/scopes/presets');
        const presets: Record<string, TokGenPreset> = await response.json();
        const preset = presets[presetKey];

        document.querySelectorAll<HTMLInputElement>('.scope-checkbox').forEach(cb => cb.checked = false);
        preset.scopes.forEach(scope => {
            const checkbox = document.getElementById('scope-' + scope.replace(/:/g, '-')) as HTMLInputElement | null;
            if (checkbox) checkbox.checked = true;
        });

        updateScopeCounter();
    } catch (error) {
        console.error('Failed to apply preset:', error);
    }
}

function selectAll() {
    document.querySelectorAll<HTMLInputElement>('.scope-checkbox').forEach(cb => cb.checked = true);
    updateScopeCounter();
}

function clearAll() {
    document.querySelectorAll<HTMLInputElement>('.scope-checkbox').forEach(cb => cb.checked = false);
    updateScopeCounter();
}

function updateScopeCounter() {
    const count = document.querySelectorAll('.scope-checkbox:checked').length;
    document.getElementById('scope-counter')!.innerText = count + ' selected';
}

function updateAccountContext() {
    const type = (document.getElementById('accountType') as HTMLSelectElement).value;
    const ctx = document.getElementById('account-context')!;
    if (type === 'bot') ctx.innerText = '💡 Bot account needs scopes for chat, commands, and moderation.';
    else ctx.innerText = '💡 Broadcaster account needs scopes for EventSub (follows, subs, bits, redemptions).';
    loadCurrentScopes();
}

async function loadCurrentScopes() {
    try {
        const response = await fetch('/api/current-tokens');
        const tokens: TokGenCurrentTokens = await response.json();
        const type = (document.getElementById('accountType') as HTMLSelectElement).value;
        const scopes = type === 'bot' ? tokens.botScopes : tokens.broadcasterScopes;

        document.querySelectorAll<HTMLInputElement>('.scope-checkbox').forEach(cb => cb.checked = false);
        if (scopes) {
            scopes.forEach(s => {
                const cb = document.getElementById('scope-' + s.replace(/:/g, '-')) as HTMLInputElement | null;
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
    const type = (document.getElementById('accountType') as HTMLSelectElement).value;

    if (scopes.length === 0) return alert('Please select at least one scope');

    try {
        const response = await fetch('/api/generate-auth-url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scopes, accountType: type })
        });

        const data: TokGenAuthUrlResponse = await response.json();

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
        alert('Error: ' + (error as Error).message);
    }
}

async function validateTokens() {
    const container = document.getElementById('token-validation')!;
    container.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 20px;">🔍 Validating tokens...</div>';

    try {
        const tokensResponse = await fetch('/api/current-tokens');
        const tokens: TokGenCurrentTokens = await tokensResponse.json();

        const cards = [
            { token: tokens.botToken, title: 'Bot Account' },
            { token: tokens.broadcasterToken, title: 'Broadcaster Account' }
        ];
        const results: string[] = [];
        for (const card of cards) results.push(await validateToken(card.token, card.title));

        container.innerHTML = results.join('');
        // Each valid card has a Test Connection button; the token stays in this closure, not the page
        container.querySelectorAll('.token-card').forEach((cardElement, i) => {
            const button = cardElement.querySelector('.test-connection');
            const { token, title } = cards[i];
            if (button && token) button.addEventListener('click', () => testConnection(token, title));
        });
    } catch (error) {
        container.innerHTML = `<div class="token-card invalid"><h4>Error</h4><p>${tokGenEscape((error as Error).message)}</p></div>`;
    }
}

async function validateToken(token: string | undefined, title: string): Promise<string> {
    if (!token) {
        return `<div class="token-card invalid"><h4>${title} <span class="status-badge invalid">Not Found</span></h4><p>No token configured in .env</p></div>`;
    }

    try {
        const response = await fetch(`/api/validate-token?token=${encodeURIComponent(token)}`);
        const data: TokGenValidation = await response.json();

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
                        <div><strong>Username:</strong> ${tokGenEscape(data.username)}</div>
                        <div><strong>Expires In:</strong> ${hours} hours</div>
                        <div style="margin-top:10px"><strong>Token Scopes:</strong></div>
                        <div style="max-height: 100px; overflow-y: auto; background: #eee; padding: 5px; font-size: 11px;">
                            ${data.scopes.map(s => `<span style="display:inline-block; margin:2px; padding:2px 5px; background:#ddd; border-radius:3px">${tokGenEscape(s)}</span>`).join('')}
                        </div>
                        ${missingScopes.length > 0 ? `
                            <div style="color: #ff9800; font-size: 12px; margin-top: 10px;">
                                ⚠️ Missing recommended scopes: ${tokGenEscape(missingScopes.join(', '))}
                            </div>
                        ` : `
                            <div style="color: #4caf50; font-size: 12px; margin-top: 10px;">
                                ✅ All recommended scopes present
                            </div>
                        `}
                    </div>
                    <button class="btn btn-secondary test-connection" style="width:100%; margin-top:10px; padding:8px">🧪 Test Connection</button>
                </div>
            `;
        } else {
            return `<div class="token-card invalid"><h4>${title} <span class="status-badge invalid">✗ Invalid</span></h4><p>${tokGenEscape(data.error)}</p></div>`;
        }
    } catch (error) {
        return `<div class="token-card invalid"><h4>${title} <span class="status-badge invalid">Error</span></h4><p>${tokGenEscape((error as Error).message)}</p></div>`;
    }
}

async function testConnection(token: string, title: string) {
    try {
        const response = await fetch('/api/test-connection', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, type: title.includes('Bot') ? 'bot' : 'broadcaster' })
        });
        const data: TokGenConnectionTest = await response.json();

        if (data.success) {
            alert(`✅ Connection Test Successful for ${title}!\n\nUser: ${data.data.display_name}\nID: ${data.data.id}\nType: ${data.data.type || 'Normal'}`);
        } else {
            alert(`❌ Connection Test Failed for ${title}:\n\n${data.error}`);
        }
    } catch (error) {
        alert(`❌ Error testing connection: ${(error as Error).message}`);
    }
}

// Account Manager Functions
async function loadAccounts() {
    const container = document.getElementById('accounts-list')!;
    container.innerHTML = '<p style="text-align: center; padding: 20px;">Loading...</p>';

    try {
        const response = await fetch('/api/accounts');
        const data: { accounts?: TokGenAccountSummary[] } = await response.json();
        const accounts = data.accounts || [];

        if (accounts.length === 0) {
            container.innerHTML = '<p style="color: #999; text-align: center; padding: 20px;">No accounts yet.</p>';
            return;
        }

        container.innerHTML = '<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 15px;">' +
            accounts.map(a => `
                <div class="preset-card">
                    <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                        <h4 style="margin:0">${tokGenEscape(a.name)}</h4>
                        <span class="status-badge ${a.tokenStatus === 'valid' ? 'valid' : 'invalid'}" style="font-size:10px">${tokGenEscape(a.tokenStatus)}</span>
                    </div>
                    <p style="margin: 10px 0; font-size: 13px;">Broadcaster: ${tokGenEscape(a.broadcasterName)}</p>
                    <div class="btn-group" style="margin-top: 10px; font-size: 12px;">
                        <button class="btn btn-primary auth-bot" style="padding: 5px 10px; font-size: 11px;">🤖 Auth Bot</button>
                        <button class="btn btn-secondary auth-broadcaster" style="padding: 5px 10px; font-size: 11px;">📺 Auth Broadcaster</button>
                    </div>
                </div>
            `).join('') + '</div>';
        tokGenBindClicks(container, '.auth-bot', accounts, a => authorizeAccount(a.name, 'bot'));
        tokGenBindClicks(container, '.auth-broadcaster', accounts, a => authorizeAccount(a.name, 'broadcaster'));
    } catch (error) {
        container.innerHTML = `<p style="color: red;">Error: ${tokGenEscape((error as Error).message)}</p>`;
    }
}

async function createNewAccount() {
    const name = (document.getElementById('new-account-name') as HTMLInputElement).value.trim();
    const broadcasterName = (document.getElementById('new-broadcaster-name') as HTMLInputElement).value.trim();
    const clientId = (document.getElementById('new-client-id') as HTMLInputElement).value.trim();
    const clientSecret = (document.getElementById('new-client-secret') as HTMLInputElement).value.trim();
    const channels = (document.getElementById('new-channels') as HTMLInputElement).value.split(',').map(s => s.trim()).filter(Boolean);

    if (!name || !clientId || !clientSecret || !broadcasterName) return alert('Please fill in required fields');

    try {
        const response = await fetch('/api/accounts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accountName: name, clientId, clientSecret, broadcasterName, channels })
        });
        const data: TokGenResult = await response.json();
        if (data.success) {
            alert('Account created!');
            loadAccounts();
        } else alert('Error: ' + data.error);
    } catch (error) {
        alert('Error: ' + (error as Error).message);
    }
}

async function authorizeAccount(name: string, type: string) {
    try {
        const response = await fetch(`/api/accounts/${encodeURIComponent(name)}`);
        const data: { account: { clientId: string } } = await response.json();
        const acc = data.account;

        let scopes = new Set<string>();

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
        const params = new URLSearchParams({
            client_id: acc.clientId,
            redirect_uri: location.origin + '/callback',
            response_type: 'code',
            scope: scopeArray.join(' '),
            state: `${name}_${type}`
        });
        const authUrl = `https://id.twitch.tv/oauth2/authorize?${params}`;
        window.open(authUrl, '_blank');
    } catch (error) {
        alert('Error: ' + (error as Error).message);
    }
}

async function importFromEnv() {
    const name = (document.getElementById('import-account-name') as HTMLInputElement).value.trim();
    const content = (document.getElementById('import-env-content') as HTMLTextAreaElement).value.trim();
    if (!name || !content) return alert('Fields required');

    try {
        const response = await fetch('/api/accounts/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accountName: name, envContent: content })
        });
        const data: TokGenResult = await response.json();
        if (data.success) {
            alert('Imported!');
            loadAccounts();
        } else alert('Error: ' + data.error);
    } catch (error) {
        alert('Error: ' + (error as Error).message);
    }
}

// Backup & Recovery Functions
async function loadBackups() {
    const container = document.getElementById('backups-list')!;
    container.innerHTML = '<p>Loading backups...</p>';

    try {
        const response = await fetch('/api/env/backups');
        const data: { backups?: TokGenBackup[] } = await response.json();
        const backups = data.backups || [];

        if (backups.length === 0) {
            container.innerHTML = '<p style="color: #999;">No backups found.</p>';
            return;
        }

        container.innerHTML = backups.map(b => `
            <div class="backup-item">
                <div class="backup-info">
                    <h4>${tokGenEscape(b.filename)}</h4>
                    <p>Created: ${tokGenEscape(new Date(b.createdAt).toLocaleString())} | Size: ${(b.size / 1024).toFixed(2)} KB</p>
                </div>
                <div class="btn-group" style="margin:0">
                    <button class="btn btn-primary restore-backup" style="padding:8px 15px;">⏪ Restore</button>
                </div>
            </div>
        `).join('');
        tokGenBindClicks(container, '.restore-backup', backups, b => restoreBackup(b.filename));
    } catch (error) {
        container.innerHTML = `<p style="color:red">Error: ${tokGenEscape((error as Error).message)}</p>`;
    }
}

async function createBackup() {
    try {
        const response = await fetch('/api/env/backup', { method: 'POST' });
        const data: TokGenResult = await response.json();
        if (data.success) {
            alert('Backup created: ' + data.backupName);
            loadBackups();
        } else alert('Error: ' + data.error);
    } catch (error) {
        alert('Error: ' + (error as Error).message);
    }
}

async function restoreBackup(filename: string) {
    if (!confirm('⚠️ Restore configuration from ' + filename + '? This will overwrite your current .env file.')) return;

    try {
        const response = await fetch('/api/env/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ backupName: filename })
        });
        const data: TokGenResult = await response.json();
        if (data.success) {
            alert('✓ Configuration restored successfully!');
            location.reload();
        } else alert('Error: ' + data.error);
    } catch (error) {
        alert('Error: ' + (error as Error).message);
    }
}

initPage();
loadAccounts();
