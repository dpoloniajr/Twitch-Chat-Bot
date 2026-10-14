/** @jest-environment jsdom */
/**
 * Characterization tests for public/token-generator/app.js (compiled from
 * src/web/public/token-generator/app.ts) running in the real setup page.
 */
import * as fs from 'fs';
import * as path from 'path';
import { loadPage, flush, click, change, PageHarness, MockResponseInit, REPO_ROOT } from '../support/static-page-harness';

const FEATURE_SCOPES = {
  chat: { bot: ['chat:read', 'chat:edit'] },
  clips: { bot: ['clips:edit'] },
  eventsub: { broadcaster: ['moderator:read:followers'] },
  redemptions: { broadcaster: ['channel:read:redemptions'] },
  song_requests: { bot: ['songs:x'] },
  bits: { broadcaster: ['bits:read'] },
};

const REQUIRED = {
  featureScopes: FEATURE_SCOPES,
  activeFeatures: [{ id: 'song_requests' }, { id: 'not_a_feature' }],
  bot: ['chat:read'],
  broadcaster: ['bits:read'],
  hasBroadcasterToken: true,
};

const PRESETS = {
  basic: { name: 'Basic', description: 'Chat only', scopes: ['chat:read', 'chat:edit'] },
  full: { name: 'Full', description: 'Everything', scopes: ['chat:read', 'bits:read', 'clips:edit'] },
};

const CATEGORIES = {
  'Chat Stuff': [{ scope: 'chat:read', description: 'Read chat' }, { scope: 'chat:edit', description: 'Send chat' }],
  Bits: [{ scope: 'bits:read', description: 'Bits' }, { scope: 'clips:edit', description: 'Clips' }],
};

const TOKENS = {
  botToken: 'bottok', broadcasterToken: '',
  botScopes: ['chat:edit'], broadcasterScopes: ['bits:read'],
};

function defaultRoutes(): Record<string, MockResponseInit> {
  return {
    'GET /api/scopes/required': { body: REQUIRED },
    'GET /api/scopes/presets': { body: PRESETS },
    'GET /api/scopes/categories': { body: CATEGORIES },
    'GET /api/current-tokens': { body: TOKENS },
    'GET /api/accounts': { body: { accounts: [
      { name: 'main', tokenStatus: 'valid', broadcasterName: 'streamer' },
      { name: 'alt', tokenStatus: 'expired', broadcasterName: 'other' },
    ] } },
    'POST /api/generate-auth-url': { body: { authUrl: 'https://id.twitch.tv/auth?x=1' } },
  };
}

async function boot(extra: Record<string, MockResponseInit> = {}, confirmResult = true): Promise<PageHarness> {
  const h = loadPage({
    html: 'public/token-generator/index.html',
    script: 'public/token-generator/app.js',
    url: 'http://localhost:8080/',
    routes: { ...defaultRoutes(), ...extra },
    confirmResult,
  });
  await flush();
  return h;
}

const checkedScopes = (h: PageHarness): string[] =>
  Array.from(h.document.querySelectorAll<HTMLInputElement>('.scope-checkbox:checked')).map(cb => cb.id);

describe('token generator: page load', () => {
  it('fetches required scopes, accounts, presets, categories and current tokens in order', async () => {
    const h = await boot();
    expect(h.fetchCalls.map(c => `${c.method} ${c.url}`)).toEqual([
      'GET /api/scopes/required',
      'GET /api/accounts',
      'GET /api/scopes/presets',
      'GET /api/scopes/categories',
      'GET /api/current-tokens',
    ]);
    // a second current-scopes load is scheduled 100ms after init
    expect(h.timers.map(t => t.delay)).toEqual([100]);
    h.runTimers(100);
    await flush();
    expect(h.callsTo('/api/current-tokens')).toHaveLength(2);
  });

  it('renders feature boxes with defaults plus backend-active features', async () => {
    const h = await boot();
    const boxes = h.document.querySelectorAll('#wizard-features .feature-box');
    expect(boxes).toHaveLength(32);
    expect(h.$('feat-chat').disabled).toBe(true);
    expect(h.$('feat-chat').checked).toBe(true);
    expect(h.$('feat-song_requests').checked).toBe(true); // activated by backend
    expect(h.$('feat-automod').checked).toBe(false);
    expect(h.$('feat-clips').closest('.feature-box')!.classList.contains('selected')).toBe(true);
    expect(h.document.querySelector('label[for="feat-chat"]')!.textContent).toBe('💬 Chat');
  });

  it('feature boxes toggle on click (except the required chat feature)', async () => {
    const h = await boot();
    const automod = h.$('feat-automod').closest('.feature-box')!;
    click(automod);
    expect(h.$('feat-automod').checked).toBe(true);
    expect(automod.classList.contains('selected')).toBe(true);
    click(automod);
    expect(h.$('feat-automod').checked).toBe(false);
    click(h.$('feat-chat').closest('.feature-box')!);
    expect(h.$('feat-chat').checked).toBe(true);
  });

  it('renders presets and scope categories; current bot scopes are pre-checked', async () => {
    const h = await boot();
    const presets = h.document.querySelectorAll('#scope-presets .preset-card');
    expect(presets).toHaveLength(2);
    expect(presets[1].querySelector('h4')!.textContent).toBe('Full');
    expect(presets[1].querySelector('.scope-count')!.textContent).toBe('3 scopes');
    expect(h.document.querySelectorAll('.scope-checkbox')).toHaveLength(4);
    expect(h.document.getElementById('Chat-Stuff-count')).not.toBeNull();
    expect(checkedScopes(h)).toEqual(['scope-chat-edit']);
    expect(h.$('scope-counter').textContent).toBe('1 selected');
    expect(h.$('account-context').textContent).toBe('💡 Bot account needs scopes for chat, commands, and moderation.');
  });

  it('renders the account list', async () => {
    const h = await boot();
    const cards = h.document.querySelectorAll('#accounts-list .preset-card');
    expect(cards).toHaveLength(2);
    expect(cards[0].querySelector('h4')!.textContent).toBe('main');
    expect(cards[0].querySelector('.status-badge')!.className).toBe('status-badge valid');
    expect(cards[1].querySelector('.status-badge')!.className).toBe('status-badge invalid');
    expect(cards[1].querySelector('p')!.textContent).toBe('Broadcaster: other');
  });

  it('shows account list empty and error states', async () => {
    let h = await boot({ 'GET /api/accounts': { body: {} } });
    expect(h.$('accounts-list').textContent).toBe('No accounts yet.');
    h = await boot({ 'GET /api/accounts': { networkError: new Error('offline') } });
    expect(h.$('accounts-list').textContent).toBe('Error: offline');
  });

  it('logs and continues when the required-scopes call fails', async () => {
    const h = await boot({ 'GET /api/scopes/required': { networkError: new Error('x') } });
    expect(h.consoleError).toHaveBeenCalledWith('Failed to auto-select features:', expect.any(Error));
    expect(h.document.querySelectorAll('#wizard-features .feature-box')).toHaveLength(32);
    expect(h.$('feat-song_requests').checked).toBe(false);
  });
});

describe('token generator: wizard', () => {
  it('step 2 summarises bot and broadcaster scopes for selected features', async () => {
    const h = await boot();
    click(h.document.querySelector('button[onclick="wizardNext(1)"]')!);
    expect(h.$('wizard-step-1').classList.contains('active')).toBe(false);
    expect(h.$('wizard-step-2').classList.contains('active')).toBe(true);
    expect(h.$('step1').className).toBe('wizard-step completed');
    expect(h.$('step2').classList.contains('active')).toBe(true);
    const bot = Array.from(h.document.querySelectorAll('#wizard-bot-scopes-container .scope-badge')).map(e => e.textContent);
    const bc = Array.from(h.document.querySelectorAll('#wizard-broadcaster-scopes-container .scope-badge')).map(e => e.textContent);
    expect(bot).toEqual(['chat:edit', 'chat:read', 'clips:edit', 'songs:x']);
    expect(bc).toEqual(['channel:read:redemptions', 'moderator:read:followers']);
    expect(h.document.querySelector('#wizard-bot-scopes-container h4')!.textContent).toBe('Bot Account (4 scopes)');
  });

  it('single account mode folds broadcaster scopes into the bot token', async () => {
    const h = await boot();
    h.window.eval('wizardNext(1)');
    change(h.$('single-account-mode'), true);
    expect(h.$('single-account-mode').checked).toBe(true);
    expect(h.document.querySelector('#wizard-broadcaster-scopes-container')).toBeNull();
    expect(h.document.querySelector('#wizard-bot-scopes-container h4')!.textContent).toBe('Combined Bot & Broadcaster (6 scopes)');
  });

  it('step 3 creates auth buttons that request an auth URL and open it', async () => {
    const h = await boot();
    h.window.eval('wizardNext(1)');
    click(h.document.querySelector('button[onclick="wizardNext(2)"]')!);
    expect(h.$('wizard-step-3').classList.contains('active')).toBe(true);
    const buttons = h.document.querySelectorAll('#wizard-auth-buttons .auth-button');
    expect(buttons).toHaveLength(2);
    click(buttons[1]);
    await flush();
    expect(h.callsTo('/api/generate-auth-url', 'POST')[0].body).toEqual({
      scopes: ['channel:read:redemptions', 'moderator:read:followers'], accountType: 'broadcaster',
    });
    expect(h.openMock).toHaveBeenCalledWith('https://id.twitch.tv/auth?x=1', '_blank');
  });

  it('auth errors are alerted', async () => {
    const h = await boot({ 'POST /api/generate-auth-url': { ok: false, status: 400, body: { error: 'bad scopes' } } });
    h.window.eval('wizardNext(1); wizardNext(2)');
    click(h.document.querySelectorAll('#wizard-auth-buttons .auth-button')[0]);
    await flush();
    expect(h.alerts).toEqual(['Failed to generate auth URL: bad scopes']);
    h.routes.set('POST /api/generate-auth-url', { body: {} });
    click(h.document.querySelectorAll('#wizard-auth-buttons .auth-button')[0]);
    await flush();
    expect(h.alerts[1]).toBe('Failed to generate auth URL: No authorization URL received from server');
    h.window.eval("authorizeWizard('bot', [])");
    expect(h.alerts[2]).toBe('No scopes selected for bot account. Please go back and select features.');
  });

  it('back buttons return to the previous step', async () => {
    const h = await boot();
    h.window.eval('wizardNext(1)');
    click(h.document.querySelector('button[onclick="wizardPrev(2)"]')!);
    expect(h.$('wizard-step-1').classList.contains('active')).toBe(true);
    expect(h.$('wizard-step-2').classList.contains('active')).toBe(false);
    expect(h.$('step2').className).toBe('wizard-step');
    expect(h.$('step1').classList.contains('active')).toBe(true);
  });

  it('wizardComplete alerts, switches to the validator tab and validates', async () => {
    const h = await boot({ 'GET /api/validate-token?token=bottok': { body: { valid: false, error: 'expired' } } });
    click(h.document.querySelector('button[onclick="wizardComplete()"]')!);
    await flush();
    expect(h.alerts[0]).toBe('Setup complete! Your tokens have been saved. Restart the bot to apply changes.');
    expect(h.$('validate-tab').classList.contains('active')).toBe(true);
    expect(h.document.querySelectorAll('.tab')[2].classList.contains('active')).toBe(true);
    expect(h.callsTo('/api/validate-token')).toHaveLength(1);
  });
});

describe('token generator: manual setup', () => {
  it('tabs switch via inline handlers; backup tab loads backups', async () => {
    const h = await boot({ 'GET /api/env/backups': { body: { backups: [
      { filename: '.env.backup.1', createdAt: '2026-01-01T00:00:00Z', size: 2048 },
    ] } } });
    const tabs = h.document.querySelectorAll('.tab');
    click(tabs[1]);
    expect(h.$('manual-tab').classList.contains('active')).toBe(true);
    expect(h.$('wizard-tab').classList.contains('active')).toBe(false);
    expect(tabs[1].classList.contains('active')).toBe(true);
    click(tabs[4]);
    await flush();
    expect(h.callsTo('/api/env/backups')).toHaveLength(1);
    const item = h.document.querySelector('#backups-list .backup-item')!;
    expect(item.querySelector('h4')!.textContent).toBe('.env.backup.1');
    expect(item.querySelector('p')!.textContent).toContain('Size: 2.00 KB');
  });

  it('preset cards apply their scopes; select all / clear all update the counter', async () => {
    const h = await boot();
    click(h.document.querySelectorAll('#scope-presets .preset-card')[1]);
    await flush();
    expect(checkedScopes(h)).toEqual(['scope-chat-read', 'scope-bits-read', 'scope-clips-edit']);
    expect(h.$('scope-counter').textContent).toBe('3 selected');
    click(h.document.querySelector('button[onclick="selectAll()"]')!);
    expect(h.$('scope-counter').textContent).toBe('4 selected');
    click(h.document.querySelector('button[onclick="clearAll()"]')!);
    expect(h.$('scope-counter').textContent).toBe('0 selected');
    change(h.$('scope-bits-read'), true);
    expect(h.$('scope-counter').textContent).toBe('1 selected');
  });

  it('category headers collapse their content', async () => {
    const h = await boot();
    const header = h.document.querySelector('.scope-category-header')!;
    click(header);
    expect(header.nextElementSibling!.classList.contains('collapsed')).toBe(true);
    click(header);
    expect(header.nextElementSibling!.classList.contains('collapsed')).toBe(false);
  });

  it('switching account type updates the hint and reloads that account\'s scopes', async () => {
    const h = await boot();
    change(h.$('accountType'), 'broadcaster');
    await flush();
    expect(h.$('account-context').textContent).toBe('💡 Broadcaster account needs scopes for EventSub (follows, subs, bits, redemptions).');
    expect(checkedScopes(h)).toEqual(['scope-bits-read']);
  });

  it('generateTokens requires a scope and posts the selected scopes', async () => {
    const h = await boot();
    h.window.eval('clearAll()');
    h.window.eval('generateTokens()');
    expect(h.alerts).toEqual(['Please select at least one scope']);
    h.window.eval('selectAll()');
    click(h.document.querySelector('button[onclick="generateTokens()"]')!);
    await flush();
    expect(h.callsTo('/api/generate-auth-url', 'POST')[0].body).toEqual({
      scopes: ['chat:read', 'chat:edit', 'bits:read', 'clips:edit'], accountType: 'bot',
    });
    expect(h.openMock).toHaveBeenCalledWith('https://id.twitch.tv/auth?x=1', '_blank');
  });

  it('generateTokens alerts server errors', async () => {
    const h = await boot({ 'POST /api/generate-auth-url': { ok: false, status: 500, body: {} } });
    h.window.eval('generateTokens()');
    await flush();
    expect(h.alerts).toEqual(['Error: HTTP error! status: 500']);
  });
});

describe('token generator: validator', () => {
  it('validates both tokens and renders valid / missing cards', async () => {
    const h = await boot({ 'GET /api/validate-token?token=bottok': { body: {
      valid: true, expiresIn: 7300, username: 'botty', scopes: ['chat:read'],
    } } });
    click(h.document.querySelector('button[onclick="validateTokens()"]')!);
    expect(h.$('token-validation').textContent).toContain('Validating tokens...');
    await flush();
    const cards = h.document.querySelectorAll('#token-validation .token-card');
    expect(cards).toHaveLength(2);
    expect(cards[0].className).toBe('token-card valid');
    expect(cards[0].textContent).toContain('Username: botty');
    expect(cards[0].textContent).toContain('Expires In: 2 hours');
    expect(cards[0].textContent).toContain('Missing recommended scopes: chat:edit');
    expect(cards[1].className).toBe('token-card invalid');
    expect(cards[1].querySelector('.status-badge')!.textContent).toBe('Not Found');
  });

  it('shows invalid tokens and all-present scopes', async () => {
    const h = await boot({
      'GET /api/current-tokens': { body: { botToken: 'a', broadcasterToken: 'b' } },
      'GET /api/validate-token?token=a': { body: { valid: true, expiresIn: 3600, username: 'u', scopes: ['chat:read', 'chat:edit'] } },
      'GET /api/validate-token?token=b': { body: { valid: false, error: 'invalid access token' } },
    });
    h.window.eval('validateTokens()');
    await flush();
    const cards = h.document.querySelectorAll('#token-validation .token-card');
    expect(cards[0].textContent).toContain('All recommended scopes present');
    expect(cards[1].textContent).toContain('invalid access token');
    expect(cards[1].querySelector('.status-badge')!.textContent).toBe('✗ Invalid');
  });

  it('shows an error card when tokens cannot be loaded', async () => {
    const h = await boot();
    h.routes.set('GET /api/current-tokens', { networkError: new Error('no server') });
    h.window.eval('validateTokens()');
    await flush();
    expect(h.$('token-validation').textContent).toBe('Errorno server');
  });

  it('Test Connection posts the token and alerts the result', async () => {
    const h = await boot({
      'GET /api/validate-token?token=bottok': { body: { valid: true, expiresIn: 0, username: 'u', scopes: [] } },
      'POST /api/test-connection': { body: { success: true, data: { display_name: 'Botty', id: '42' } } },
    });
    h.window.eval('validateTokens()');
    await flush();
    click(h.document.querySelector('#token-validation .token-card.valid button')!);
    await flush();
    expect(h.callsTo('/api/test-connection', 'POST')[0].body).toEqual({ token: 'bottok', type: 'bot' });
    expect(h.alerts).toEqual(['✅ Connection Test Successful for Bot Account!\n\nUser: Botty\nID: 42\nType: Normal']);
    h.routes.set('POST /api/test-connection', { body: { success: false, error: 'nope' } });
    h.window.eval("testConnection('t', 'Broadcaster Account')");
    await flush();
    expect(h.callsTo('/api/test-connection', 'POST')[1].body).toEqual({ token: 't', type: 'broadcaster' });
    expect(h.alerts[1]).toBe('❌ Connection Test Failed for Broadcaster Account:\n\nnope');
  });
});

describe('token generator: account manager and backups', () => {
  it('createNewAccount validates and posts the new account', async () => {
    const h = await boot({ 'POST /api/accounts': { body: { success: true } } });
    h.window.eval('createNewAccount()');
    expect(h.alerts).toEqual(['Please fill in required fields']);
    h.$('new-account-name').value = ' acct ';
    h.$('new-broadcaster-name').value = 'bc';
    h.$('new-client-id').value = 'cid';
    h.$('new-client-secret').value = 'sec';
    h.$('new-channels').value = 'a, b,,';
    click(h.document.querySelector('button[onclick="createNewAccount()"]')!);
    await flush();
    expect(h.callsTo('/api/accounts', 'POST')[0].body).toEqual({
      accountName: 'acct', clientId: 'cid', clientSecret: 'sec', broadcasterName: 'bc', channels: ['a', 'b'],
    });
    expect(h.alerts[1]).toBe('Account created!');
    expect(h.callsTo('/api/accounts', 'GET')).toHaveLength(2);
  });

  it('account Auth buttons open a Twitch authorize URL with feature-derived scopes', async () => {
    const h = await boot({ 'GET /api/accounts/main': { body: { account: { clientId: 'CID' } } } });
    const card = h.document.querySelectorAll('#accounts-list .preset-card')[0];
    click(card.querySelectorAll('button')[0]);
    await flush();
    expect(h.openMock).toHaveBeenLastCalledWith(
      'https://id.twitch.tv/oauth2/authorize?client_id=CID&redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fcallback&response_type=code&scope=chat%3Aedit+chat%3Aread+clips%3Aedit&state=main_bot',
      '_blank');
    click(card.querySelectorAll('button')[1]);
    await flush();
    expect(h.openMock).toHaveBeenLastCalledWith(
      'https://id.twitch.tv/oauth2/authorize?client_id=CID&redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fcallback&response_type=code&scope=bits%3Aread+channel%3Aread%3Aredemptions+moderator%3Aread%3Afollowers&state=main_broadcaster',
      '_blank');
  });

  it('account authorization falls back to default scopes without feature data', async () => {
    const h = await boot({
      'GET /api/scopes/required': { body: {} },
      'GET /api/accounts/alt': { body: { account: { clientId: 'C2' } } },
    });
    h.window.eval("authorizeAccount('alt', 'broadcaster')");
    await flush();
    expect(h.openMock).toHaveBeenCalledWith(
      'https://id.twitch.tv/oauth2/authorize?client_id=C2&redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fcallback&response_type=code&scope=bits%3Aread+channel%3Aread%3Aredemptions+channel%3Aread%3Asubscriptions+moderator%3Aread%3Afollowers&state=alt_broadcaster',
      '_blank');
  });

  it('importFromEnv validates and posts the env content', async () => {
    const h = await boot({ 'POST /api/accounts/import': { body: { success: false, error: 'dup' } } });
    h.window.eval('importFromEnv()');
    expect(h.alerts).toEqual(['Fields required']);
    h.$('import-account-name').value = 'imp';
    h.$('import-env-content').value = 'A=1\n';
    h.window.eval('importFromEnv()');
    await flush();
    expect(h.callsTo('/api/accounts/import', 'POST')[0].body).toEqual({ accountName: 'imp', envContent: 'A=1' });
    expect(h.alerts[1]).toBe('Error: dup');
  });

  it('createBackup posts and reloads the list; empty list message', async () => {
    const h = await boot({
      'POST /api/env/backup': { body: { success: true, backupName: '.env.backup.2' } },
      'GET /api/env/backups': { body: { backups: [] } },
    });
    click(h.document.querySelector('button[onclick="createBackup()"]')!);
    await flush();
    expect(h.alerts).toEqual(['Backup created: .env.backup.2']);
    expect(h.$('backups-list').textContent).toBe('No backups found.');
  });

  it('restore asks for confirmation before posting', async () => {
    let h = await boot({}, false);
    h.window.eval("restoreBackup('.env.backup.1')");
    await flush();
    expect(h.confirmMock).toHaveBeenCalledWith('⚠️ Restore configuration from .env.backup.1? This will overwrite your current .env file.');
    expect(h.callsTo('/api/env/restore')).toHaveLength(0);
    h = await boot({ 'POST /api/env/restore': { body: { success: false, error: 'missing' } } });
    h.window.eval("restoreBackup('.env.backup.1')");
    await flush();
    expect(h.callsTo('/api/env/restore', 'POST')[0].body).toEqual({ backupName: '.env.backup.1' });
    expect(h.alerts).toEqual(['Error: missing']);
  });

  it('every inline handler in index.html refers to a global function', () => {
    const h = loadPage({ html: 'public/token-generator/index.html', script: 'public/token-generator/app.js' });
    const html = fs.readFileSync(path.join(REPO_ROOT, 'public/token-generator/index.html'), 'utf8');
    const names = new Set<string>();
    for (const m of html.matchAll(/\son[a-z]+="([^"]*)"/g)) {
      for (const call of m[1].matchAll(/([A-Za-z_$][\w$]*)\(/g)) names.add(call[1]);
    }
    // functions referenced from inline handlers generated at runtime (none of them carry data)
    for (const n of ['toggleFeature', 'toggleCategory', 'updateScopeCounter', 'updateWizardScopeSummary']) names.add(n);
    for (const name of names) {
      expect([name, typeof h.window[name]]).toEqual([name, 'function']);
    }
  });
});

const EVIL = `x'); alert(1); //<img src=x onerror="alert(2)">&`;

describe('token generator: escaping and URL encoding', () => {
  it('account names are shown as text and passed to handlers without inline code', async () => {
    const h = await boot({ 'GET /api/accounts': { body: { accounts: [
      { name: EVIL, tokenStatus: '<b>valid</b>', broadcasterName: '<img src=y>' },
    ] } } });
    const card = h.document.querySelector('#accounts-list .preset-card')!;
    expect(card.querySelector('h4')!.textContent).toBe(EVIL);
    expect(card.querySelector('.status-badge')!.textContent).toBe('<b>valid</b>');
    expect(card.querySelector('p')!.textContent).toBe('Broadcaster: <img src=y>');
    expect(h.$('accounts-list').querySelector('img, b')).toBeNull();
    expect(h.$('accounts-list').querySelector('[onclick]')).toBeNull();

    h.routes.set(`GET /api/accounts/${encodeURIComponent(EVIL)}`, { body: { account: { clientId: 'a&b=c' } } });
    click(card.querySelectorAll('button')[1]);
    await flush();
    expect(h.callsTo('/api/accounts/', 'GET')[0].url).toBe(`/api/accounts/${encodeURIComponent(EVIL)}`);
    const url = new URL(h.openMock.mock.calls[0][0] as string);
    expect(url.searchParams.get('client_id')).toBe('a&b=c');
    expect(url.searchParams.get('state')).toBe(`${EVIL}_broadcaster`);
    expect(url.searchParams.get('scope')).toBe('bits:read channel:read:redemptions moderator:read:followers');
    expect(Array.from(url.searchParams.keys())).toEqual(['client_id', 'redirect_uri', 'response_type', 'scope', 'state']);
  });

  it('backup file names are shown as text and restored by exact name', async () => {
    const h = await boot({
      'GET /api/env/backups': { body: { backups: [{ filename: EVIL, createdAt: 0, size: 1 }] } },
      'POST /api/env/restore': { body: { success: false, error: 'no' } },
    });
    h.window.eval('loadBackups()');
    await flush();
    const item = h.document.querySelector('#backups-list .backup-item')!;
    expect(item.querySelector('h4')!.textContent).toBe(EVIL);
    expect(item.querySelector('img, [onclick]')).toBeNull();
    click(item.querySelector('button')!);
    await flush();
    expect(h.callsTo('/api/env/restore', 'POST')[0].body).toEqual({ backupName: EVIL });
  });

  it('tokens are URL-encoded, never written into the page, and still used by Test Connection', async () => {
    const token = 'tok&en=1#x';
    const h = await boot({
      'GET /api/current-tokens': { body: { botToken: token } },
      [`GET /api/validate-token?token=${encodeURIComponent(token)}`]: { body: {
        valid: true, expiresIn: 3600, username: '<img src=u>', scopes: ['<s>chat:read</s>'],
      } },
      'POST /api/test-connection': { body: { success: true, data: { display_name: 'B', id: '1' } } },
    });
    h.window.eval('validateTokens()');
    await flush();
    const container = h.$('token-validation');
    expect(container.innerHTML).not.toContain('tok&');
    expect(container.innerHTML).not.toContain('tok&amp;');
    expect(container.querySelector('img, s, [onclick]')).toBeNull();
    expect(container.textContent).toContain('Username: <img src=u>');
    expect(container.textContent).toContain('<s>chat:read</s>');
    click(container.querySelector('.token-card.valid button')!);
    await flush();
    expect(h.callsTo('/api/test-connection', 'POST')[0].body).toEqual({ token, type: 'bot' });
  });

  it('validation and loading errors are shown as text', async () => {
    const h = await boot({
      'GET /api/current-tokens': { body: { botToken: 'a', broadcasterToken: 'b' } },
      'GET /api/validate-token?token=a': { body: { valid: false, error: '<img src=e1>' } },
      'GET /api/validate-token?token=b': { networkError: new Error('<img src=e2>') },
    });
    h.window.eval('validateTokens()');
    await flush();
    const cards = h.document.querySelectorAll('#token-validation .token-card');
    expect(cards[0].querySelector('p')!.textContent).toBe('<img src=e1>');
    expect(cards[1].querySelector('p')!.textContent).toBe('<img src=e2>');
    expect(h.$('token-validation').querySelector('img')).toBeNull();

    h.routes.set('GET /api/current-tokens', { networkError: new Error('<img src=e3>') });
    h.window.eval('validateTokens()');
    await flush();
    expect(h.$('token-validation').textContent).toBe('Error<img src=e3>');

    const h2 = await boot({ 'GET /api/accounts': { networkError: new Error('<img src=e4>') } });
    expect(h2.$('accounts-list').textContent).toBe('Error: <img src=e4>');
    expect(h2.$('accounts-list').querySelector('img')).toBeNull();
  });

  it('preset, category and scope text from the server is escaped; presets apply by key', async () => {
    const h = await boot({
      'GET /api/scopes/presets': { body: { [EVIL]: { name: '<img src=p>', description: '<b>d</b>', scopes: ['bits:read'] } } },
      'GET /api/scopes/categories': { body: { '<i>Cat</i> "x"': [{ scope: 'bits:read', description: '<img src=c>' }] } },
    });
    const preset = h.document.querySelector('#scope-presets .preset-card')!;
    expect(preset.querySelector('h4')!.textContent).toBe('<img src=p>');
    expect(preset.querySelector('p')!.textContent).toBe('<b>d</b>');
    expect(preset.hasAttribute('onclick')).toBe(false);
    const categories = h.$('scope-categories');
    expect(categories.querySelector('img, i, b')).toBeNull();
    expect(categories.querySelector('.scope-category-header')!.textContent).toContain('<i>Cat</i> "x"');
    expect(categories.querySelector('.selected-count')!.id).toBe('<i>Cat</i>-"x"-count');

    h.window.eval('clearAll()');
    click(preset);
    await flush();
    expect(checkedScopes(h)).toEqual(['scope-bits-read']);
  });
});

describe('token generator: removed dead code', () => {
  it('has no Scope Comparison placeholder, no unused preset highlight and no required-scopes global', async () => {
    const h = await boot();
    expect(h.document.getElementById('scope-comparison')).toBeNull();
    expect(h.document.body.textContent).not.toContain('Scope Comparison');
    const css = fs.readFileSync(path.join(REPO_ROOT, 'public/token-generator/style.css'), 'utf8');
    expect(css).not.toContain('.preset-card.active');
    // `let` globals are not window properties, so check the script itself
    const script = fs.readFileSync(path.join(REPO_ROOT, 'public/token-generator/app.js'), 'utf8');
    expect(script).not.toMatch(/let requiredScopes|requiredScopes\.(bot|broadcaster)/);
  });

  it('applying a preset leaves the preset cards unchanged', async () => {
    const h = await boot();
    const cards = Array.from(h.document.querySelectorAll('#scope-presets .preset-card'));
    const before = cards.map(c => c.className);
    click(cards[0]);
    await flush();
    expect(cards.map(c => c.className)).toEqual(before);
  });

  it('single account mode starts unchecked even when there is no broadcaster token', async () => {
    const h = await boot({ 'GET /api/scopes/required': { body: { ...REQUIRED, hasBroadcasterToken: false } } });
    h.window.eval('wizardNext(1)');
    expect(h.$('single-account-mode').checked).toBe(false);
    expect(h.document.querySelector('#wizard-broadcaster-scopes-container')).not.toBeNull();
  });
});
