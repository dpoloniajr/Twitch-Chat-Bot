/*
 * Dashboard page script (served as dashboard/public/app.js).
 *
 * Plain global script (module "none"): every top-level function stays a
 * global so the inline on* handlers in index.html can call it. Markup built
 * from data goes through escapeHtml() and gets its listeners attached with
 * addEventListener, never through generated inline handlers. Type names are prefixed with `Dash` to
 * avoid clashing with the other browser scripts compiled in the same program.
 */

// ---- Shapes of the API responses / WebSocket payloads this page reads ----

interface DashLastCommand {
  user: string;
  command: string;
  timestamp: string | number;
}

interface DashCommandInfo {
  name: string;
  description?: string;
}

interface DashCustomCommand {
  name?: string;
  response?: string;
  level?: string;
  fetchUrl?: string;
  fetchEnabled?: boolean;
  cooldownSeconds?: number;
}

interface DashBuiltinCommand {
  name?: string;
  description?: string;
  permission?: string;
  perm?: string;
  cooldownSeconds?: number;
}

/** /api/status and the WebSocket 'state' message */
interface DashBotState {
  isConnected?: boolean;
  channels?: string[];
  commandsExecuted?: number;
  lastCommand?: DashLastCommand | null;
  broadcasterName?: string;
  scopes?: string[];
  commands?: DashCommandInfo[];
  customCommands?: DashCustomCommand[];
}

/** /api/logs entries and the WebSocket 'log' message */
interface DashLogEntry {
  timestamp: string | number;
  user: string;
  command: string;
  channel: string;
  success: boolean;
}

/** WebSocket 'chat' message */
interface DashChatMessage {
  timestamp: string | number;
  user: string;
  channel: string;
  message: string;
}

/** /api/stats values (keyed by username) */
interface DashUserStats {
  commands: number;
  firstSeen: string | number;
  lastCommand: string | number;
}

interface DashRedemption {
  user?: string;
  reward?: string;
  input?: string;
  timestamp: string | number;
}

interface DashEventSubEvent {
  type?: string;
  details?: string;
  timestamp: string | number;
}

interface DashObsOverlayConfig {
  overlays: {
    alerts: { duration?: number; volume?: number; enabled?: boolean };
    recentEvents: { limit?: number; showTime?: boolean; enabled?: boolean };
    chatBox: { messageTimeout?: number; hideBot?: boolean; enabled?: boolean };
    goalBar: { type?: string; goal?: number; enabled?: boolean };
  };
}

interface DashFilters {
  filterUrls: boolean;
  filterAllCaps: boolean;
  filterRepeatChars: boolean;
  filterSpam: boolean;
  filterAction: string;
  timeoutDurationSeconds: number;
  blacklistWords?: string[];
}

/** Responses of the filter endpoints */
interface DashFilterResult {
  success: boolean;
  error?: string;
  words?: string[];
}

/** Error body returned by the dashboard API on non-2xx responses */
interface DashApiError {
  error?: string;
}

/** Values the alert config UI sends (checkbox, number, text/select, cleared media) */
type DashAlertSettingValue = string | number | boolean | null;

interface DashAlertTypeConfig {
  enabled?: boolean;
  duration?: number;
  volume?: number;
  messageTemplate?: string;
  enterAnimation?: string;
  exitAnimation?: string;
  textColor?: string;
  borderColor?: string;
  fontSize?: number;
  sound?: string;
  image?: string | null;
  video?: string | null;
  customSound?: string | null;
  ttsEnabled?: boolean;
  ttsTemplate?: string;
  minBits?: number;
  minViewers?: number;
  variations?: Record<string, Record<string, DashAlertSettingValue>>;
  [setting: string]: unknown;
}

interface DashAlertGlobalConfig {
  enabled?: boolean;
  defaultVolume?: number;
  defaultDuration?: number;
  defaultDelay?: number;
  ttsEnabled?: boolean;
  ttsVoice?: string;
  ttsRate?: number;
  ttsPitch?: number;
  [setting: string]: unknown;
}

/** /api/alerts/config */
interface DashAlertConfig {
  global: DashAlertGlobalConfig;
  alertTypes: Record<string, DashAlertTypeConfig>;
}

/** Payload for /api/alerts/test */
interface DashTestAlertData {
  alertType: string;
  user: string;
  message?: string;
  useConfig: boolean;
  tier?: string;
  amount?: number;
  viewers?: number;
  reward?: string;
}

/** Messages pushed by the dashboard server over the WebSocket */
type DashWsMessage =
  | { type: 'state'; data: DashBotState }
  | { type: 'log'; data: DashLogEntry }
  | { type: 'stats' }
  | { type: 'chat'; data: DashChatMessage }
  | { type: 'customCommands'; data: DashCustomCommand[] }
  | { type: 'builtinCommands'; data: DashBuiltinCommand[] }
  | { type: 'redemption' }
  | { type: 'eventsub-event' }
  | { type: 'announcements' }
  | { type: 'filters' };

let botState: DashBotState = {};
let ws: WebSocket | null = null;

// Initialize WebSocket connection
function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}`);

  ws.onopen = () => {
    console.log('Connected to dashboard server');
  };

  ws.onmessage = (event) => {
    const message = JSON.parse(event.data) as DashWsMessage;

    if (message.type === 'state') {
      botState = message.data;
      updateDashboard();
    } else if (message.type === 'log') {
      addChatLog(message.data);
    } else if (message.type === 'stats') {
      refreshStats();
    } else if (message.type === 'chat') {
      addChatMessage(message.data);
    } else if (message.type === 'customCommands') {
      botState.customCommands = message.data;
      renderCustomCommands();
    } else if (message.type === 'builtinCommands') {
      renderBuiltinCommands(message.data);
    } else if (message.type === 'redemption') {
      loadRedemptions();
    } else if (message.type === 'eventsub-event') {
      loadEventSubEvents();
    } else if (message.type === 'announcements') {
      loadAnnouncements();
    } else if (message.type === 'filters') {
      loadFilters();
    }

    // Song queue, loyalty, quote and counter updates for manage.ts's pages
    if (typeof mgrOnSocketMessage === 'function') {
      mgrOnSocketMessage(message as { type?: string; data?: unknown });
    }
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
  };

  ws.onclose = () => {
    console.log('Disconnected from dashboard server');
    setTimeout(initWebSocket, 3000);
  };
}

// Update dashboard display
function updateDashboard() {
  const statusEl = document.getElementById('botStatus')!;
  const indicatorEl = document.getElementById('statusIndicator')!;
  const channelsEl = document.getElementById('channelsList')!;
  const commandCountEl = document.getElementById('commandCount')!;
  const lastCommandEl = document.getElementById('lastCommand')!;
  const lastCommandTimeEl = document.getElementById('lastCommandTime')!;
  const commandsListEl = document.getElementById('commandsList')!;

  // Update status
  statusEl.textContent = botState.isConnected ? 'Connected' : 'Disconnected';
  indicatorEl.className = `status-indicator ${botState.isConnected ? 'connected' : 'disconnected'}`;

  // Update channels
  channelsEl.textContent = botState.channels?.length! > 0 ? botState.channels!.join(', ') : '-';

  // Update command count
  commandCountEl.textContent = String(botState.commandsExecuted ?? 0);

  // Update last command
  if (botState.lastCommand) {
    lastCommandEl.textContent = `${botState.lastCommand.user}: ${botState.lastCommand.command}`;
    lastCommandTimeEl.textContent = new Date(botState.lastCommand.timestamp).toLocaleString();
  } else {
    lastCommandEl.textContent = 'None';
    lastCommandTimeEl.textContent = '';
  }

  // Update settings page
  (document.getElementById('broadcasterName') as HTMLInputElement).value = botState.broadcasterName || '-';
  (document.getElementById('channels') as HTMLInputElement).value = botState.channels?.join(', ') || '-';
  (document.getElementById('scopes') as HTMLInputElement).value = botState.scopes?.join(' ') || '-';

  // Update commands list
  if (botState.commands && botState.commands.length > 0) {
    commandsListEl.innerHTML = botState.commands.map(cmd => `
      <div class="command-item">
        <div class="command-name">${escapeHtml(cmd.name)}</div>
        <div class="command-desc">${escapeHtml(cmd.description)}</div>
      </div>
    `).join('');
  }

  // Render custom commands if present
  if (botState.customCommands) {
    renderCustomCommands();
  }
}

// Page navigation
function showPage(pageId: string, eventObj?: Event) {
  // Hide all pages
  document.querySelectorAll('.page').forEach(page => {
    page.classList.remove('active');
  });

  // Remove active state from nav links
  document.querySelectorAll('.nav-link').forEach(link => {
    link.classList.remove('active');
  });

  // Show selected page
  document.getElementById(pageId)!.classList.add('active');
  if (eventObj && eventObj.target) {
    (eventObj.target as Element).classList.add('active');
  }

  // Pages owned by manage.ts (Settings, Song Queue, Loyalty, ...) load their data
  if (typeof mgrOnPageShown === 'function') {
    mgrOnPageShown(pageId);
  }
}

// Command tester
function testCommand() {
  const username = (document.getElementById('testerUsername') as HTMLInputElement).value;
  const command = (document.getElementById('testerCommand') as HTMLSelectElement).value;
  const args = (document.getElementById('testerArgs') as HTMLInputElement).value;

  if (!username.trim()) {
    showResult('Please enter a username', 'error');
    return;
  }

  const fullCommand = args ? `${command} ${args}` : command;

  // Simulate command execution
  showResult(`Command executed: ${fullCommand}\nUser: ${username}\n\nNote: Command tester is for preview. Commands execute in chat.`, 'success');

  // Log the test
  fetch('/api/logs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user: username,
      command: fullCommand,
      channel: botState.channels?.[0] || 'unknown',
      success: true
    })
  });
}

function showResult(message: string, type: string) {
  const resultEl = document.getElementById('testerResult')!;
  resultEl.textContent = message;
  resultEl.className = `result-box ${type}`;
  resultEl.style.display = 'block';
}

// Logs management
async function refreshLogs() {
  try {
    const response = await fetch('/api/logs');
    const logs: DashLogEntry[] = await response.json();

    const logsListEl = document.getElementById('logsList')!;
    logsListEl.innerHTML = logs.reverse().map(log => `
      <tr>
        <td>${new Date(log.timestamp).toLocaleString()}</td>
        <td>${escapeHtml(log.user)}</td>
        <td><code>${escapeHtml(log.command)}</code></td>
        <td>${escapeHtml(log.channel)}</td>
        <td class="${log.success ? 'status-success' : 'status-error'}">
          ${log.success ? '✓ Success' : '✗ Failed'}
        </td>
      </tr>
    `).join('');
  } catch (error) {
    console.error('Failed to load logs:', error);
  }
}

async function clearLogs() {
  if (confirm('Are you sure? This will permanently delete all command logs.')) {
    try {
      await fetch('/api/logs', { method: 'DELETE' });
      refreshLogs();
    } catch (error) {
      console.error('Failed to clear logs:', error);
    }
  }
}

function addChatLog(log: DashLogEntry) {
  const logsListEl = document.getElementById('logsList')!;
  const newRow = `
    <tr>
      <td>${new Date(log.timestamp).toLocaleString()}</td>
      <td>${escapeHtml(log.user)}</td>
      <td><code>${escapeHtml(log.command)}</code></td>
      <td>${escapeHtml(log.channel)}</td>
      <td class="${log.success ? 'status-success' : 'status-error'}">
        ${log.success ? '✓ Success' : '✗ Failed'}
      </td>
    </tr>
  `;

  logsListEl.insertAdjacentHTML('afterbegin', newRow);

  // Keep only last 100 visible
  const rows = logsListEl.querySelectorAll('tr');
  if (rows.length > 100) {
    rows[rows.length - 1].remove();
  }
}

// Chat feed
function addChatMessage(chat: DashChatMessage) {
  const feed = document.getElementById('chatFeed')!;
  const time = new Date(chat.timestamp).toLocaleTimeString();
  const html = `
    <div class="chat-message">
      <div class="chat-user">${escapeHtml(chat.user)} <span class="chat-time">${time} • #${escapeHtml(chat.channel)}</span></div>
      <div class="chat-text">${escapeHtml(chat.message)}</div>
    </div>
  `;
  feed.insertAdjacentHTML('afterbegin', html);

  // Keep only last 200 messages
  const messages = feed.querySelectorAll('.chat-message');
  if (messages.length > 200) {
    messages[messages.length - 1].remove();
  }
}

function escapeHtml(str: unknown): string {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Stats management
async function refreshStats() {
  try {
    const response = await fetch('/api/stats');
    const stats: Record<string, DashUserStats> = await response.json();

    const statsListEl = document.getElementById('statsList')!;
    const sorted = Object.entries(stats).sort((a, b) => b[1].commands - a[1].commands);

    statsListEl.innerHTML = sorted.map(([username, data]) => `
      <tr>
        <td><strong>${escapeHtml(username)}</strong></td>
        <td>${data.commands}</td>
        <td>${new Date(data.firstSeen).toLocaleDateString()}</td>
        <td>${new Date(data.lastCommand).toLocaleString()}</td>
      </tr>
    `).join('');
  } catch (error) {
    console.error('Failed to load stats:', error);
  }
}

// Custom commands
async function loadCustomCommands() {
  try {
    const res = await fetch('/api/custom-commands');
    const cmds: DashCustomCommand[] = await res.json();
    botState.customCommands = cmds;
    renderCustomCommands();
  } catch (error) {
    console.error('Failed to load custom commands:', error);
  }
}

function renderCustomCommands() {
  const listEl = document.getElementById('customCommandsList');
  if (!listEl || !botState.customCommands) return;

  const commands = botState.customCommands
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  listEl.innerHTML = commands
    .map(cmd => `
      <tr>
        <td>${escapeHtml(cmd.name)}</td>
        <td>${escapeHtml(cmd.response || '')}</td>
        <td>${escapeHtml(cmd.level || 'everyone')}</td>
        <td>${cmd.fetchEnabled ? 'Yes' : 'No'}</td>
        <td>${cmd.cooldownSeconds || 0}s</td>
        <td>
          <button class="btn btn-secondary edit-command-btn">Edit</button>
          <button class="btn btn-danger delete-command-btn">Delete</button>
        </td>
      </tr>
    `).join('');

  // Attach handlers by row index so command names never end up inside markup or script
  listEl.querySelectorAll('.edit-command-btn').forEach((btn, index) => {
    btn.addEventListener('click', () => prefillCommand(commands[index].name || ''));
  });
  listEl.querySelectorAll('.delete-command-btn').forEach((btn, index) => {
    btn.addEventListener('click', () => deleteCommand(commands[index].name || ''));
  });
}

async function saveCommand() {
  const name = (document.getElementById('ccName') as HTMLInputElement).value.trim();
  const response = (document.getElementById('ccResponse') as HTMLTextAreaElement).value.trim();
  const level = (document.getElementById('ccLevel') as HTMLSelectElement).value;
  const fetchUrl = (document.getElementById('ccFetchUrl') as HTMLInputElement).value.trim();
  const fetchEnabled = (document.getElementById('ccFetchEnabled') as HTMLSelectElement).value === 'true';
  const cooldownSeconds = Number((document.getElementById('ccCooldown') as HTMLInputElement).value) || 0;

  if (!name || !response) {
    alert('Command name and response are required (response can be blank if fetch is enabled with {data}).');
    return;
  }

  await fetch('/api/custom-commands', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, response, level, fetchUrl, fetchEnabled, cooldownSeconds })
  });

  (document.getElementById('ccName') as HTMLInputElement).value = '';
  (document.getElementById('ccResponse') as HTMLTextAreaElement).value = '';
  (document.getElementById('ccLevel') as HTMLSelectElement).value = 'everyone';
  (document.getElementById('ccFetchUrl') as HTMLInputElement).value = '';
  (document.getElementById('ccFetchEnabled') as HTMLSelectElement).value = 'false';
  (document.getElementById('ccCooldown') as HTMLInputElement).value = '0';
  loadCustomCommands();
}

function prefillCommand(name: string) {
  const cmd = botState.customCommands?.find(c => c.name === name);
  if (!cmd) return;
  (document.getElementById('ccName') as HTMLInputElement).value = cmd.name as string;
  (document.getElementById('ccResponse') as HTMLTextAreaElement).value = cmd.response as string;
  (document.getElementById('ccLevel') as HTMLSelectElement).value = cmd.level || 'everyone';
   (document.getElementById('ccFetchUrl') as HTMLInputElement).value = cmd.fetchUrl || '';
   (document.getElementById('ccFetchEnabled') as HTMLSelectElement).value = cmd.fetchEnabled ? 'true' : 'false';
   (document.getElementById('ccCooldown') as HTMLInputElement).value = String(cmd.cooldownSeconds ?? 0);
}

async function deleteCommand(name: string) {
  if (!confirm(`Delete ${name}?`)) return;
  await fetch(`/api/custom-commands/${encodeURIComponent(name)}`, { method: 'DELETE' });
  loadCustomCommands();
}

// Built-in commands configuration
async function loadBuiltinCommands() {
  try {
    const res = await fetch('/api/builtin-commands');
    const commands: DashBuiltinCommand[] = await res.json();
    renderBuiltinCommands(commands);
  } catch (error) {
    console.error('Failed to load built-in commands:', error);
  }
}

function renderBuiltinCommands(commands: DashBuiltinCommand[] | null | undefined) {
  const tbody = document.getElementById('builtinCommandsList');
  if (!tbody || !commands) return;

  tbody.innerHTML = commands.map(cmd => {
    const safeName = (cmd.name || '').replace('!', '');
    return `
      <tr>
        <td><strong>${escapeHtml(cmd.name)}</strong></td>
        <td>${escapeHtml(cmd.description || 'Built-in command')}</td>
        <td>${escapeHtml(cmd.permission || (cmd.perm === 'mod' ? 'Moderator' : 'Everyone'))}</td>
        <td>
          <input type="number"
                 id="cooldown-${escapeHtml(safeName)}"
                 value="${cmd.cooldownSeconds || 0}"
                 min="0"
                 style="width: 80px; padding: 5px;">
        </td>
        <td>
          <button class="btn btn-primary update-cooldown-btn">Update</button>
        </td>
      </tr>
    `;
  }).join('');

  // Attach handlers by row index so command names never end up inside script
  tbody.querySelectorAll('.update-cooldown-btn').forEach((btn, index) => {
    btn.addEventListener('click', () => updateBuiltinCommandCooldown(commands[index].name || ''));
  });
}

async function updateBuiltinCommandCooldown(commandName: string) {
  const inputId = `cooldown-${commandName.replace('!', '')}`;
  const cooldownSeconds = Number((document.getElementById(inputId) as HTMLInputElement).value) || 0;

  try {
    const res = await fetch(`/api/builtin-commands/${encodeURIComponent(commandName)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cooldownSeconds })
    });

    if (res.ok) {
      alert(`${commandName} cooldown updated to ${cooldownSeconds}s`);
      loadBuiltinCommands();
    } else {
      const error: DashApiError = await res.json();
      alert(`Failed to update: ${error.error}`);
    }
  } catch (error) {
    console.error('Failed to update built-in command:', error);
    alert('Failed to update cooldown');
  }
}

// Announcements
async function loadAnnouncements() {
  try {
    const res = await fetch('/api/announcements');
    const data: unknown = await res.json();
    const announcements = Array.isArray(data) ? data : [];
    (document.getElementById('announcementsList') as HTMLTextAreaElement).value = announcements.join('\n');
  } catch (error) {
    console.error('Failed to load announcements:', error);
  }
}

async function saveAnnouncements() {
  const text = (document.getElementById('announcementsList') as HTMLTextAreaElement).value;
  const announcements = text.split('\n').map(a => a.trim()).filter(Boolean);
  try {
    await fetch('/api/announcements', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ announcements })
    });
    alert('Announcements saved. Restart bot to apply changes.');
  } catch (error) {
    alert('Error saving announcements: ' + (error as Error).message);
  }
}

// Polls
async function createPoll() {
  const title = (document.getElementById('pollTitle') as HTMLInputElement).value;
  const optionsText = (document.getElementById('pollOptions') as HTMLInputElement).value;
  const duration = parseInt((document.getElementById('pollDuration') as HTMLInputElement).value) || 60;

  if (!title) {
    alert('Poll title required');
    return;
  }

  const options = optionsText.split(',').map(o => o.trim()).filter(Boolean).slice(0, 5);
  if (options.length < 2) {
    alert('At least 2 options required');
    return;
  }

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: `!poll start "${title}" ${options.join(';')} ${duration}`
      })
    });
    await res.json();
    document.getElementById('pollResult')!.innerHTML = `<div style="color:#0f0;">Poll created: ${escapeHtml(title)}</div>`;
    setTimeout(() => {
      (document.getElementById('pollTitle') as HTMLInputElement).value = '';
      (document.getElementById('pollOptions') as HTMLInputElement).value = '';
      document.getElementById('pollResult')!.innerHTML = '';
    }, 3000);
  } catch (error) {
    document.getElementById('pollResult')!.innerHTML = `<div style="color:#f00;">Error: ${escapeHtml((error as Error).message)}</div>`;
  }
}

// Predictions
async function createPrediction() {
  const title = (document.getElementById('predTitle') as HTMLInputElement).value;
  const outcomesText = (document.getElementById('predOutcomes') as HTMLInputElement).value;
  const duration = parseInt((document.getElementById('predDuration') as HTMLInputElement).value) || 120;

  if (!title) {
    alert('Prediction title required');
    return;
  }

  const outcomes = outcomesText.split(',').map(o => o.trim()).filter(Boolean).slice(0, 2);
  if (outcomes.length < 2) {
    alert('Exactly 2 outcomes required');
    return;
  }

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: `!prediction start "${title}" ${outcomes.join(';')} ${duration}`
      })
    });
    await res.json();
    document.getElementById('predResult')!.innerHTML = `<div style="color:#0f0;">Prediction created: ${escapeHtml(title)}</div>`;
    setTimeout(() => {
      (document.getElementById('predTitle') as HTMLInputElement).value = '';
      (document.getElementById('predOutcomes') as HTMLInputElement).value = '';
      document.getElementById('predResult')!.innerHTML = '';
    }, 3000);
  } catch (error) {
    document.getElementById('predResult')!.innerHTML = `<div style="color:#f00;">Error: ${escapeHtml((error as Error).message)}</div>`;
  }
}

// Redemptions
async function loadRedemptions() {
  try {
    const res = await fetch('/api/redemptions');
    const redemptions: DashRedemption[] | null = await res.json();
    const list = document.getElementById('redemptionsList')!;

    if (!redemptions || redemptions.length === 0) {
      list.innerHTML = '<div class="event-item">No redemptions yet</div>';
      return;
    }

    list.innerHTML = redemptions.reverse().slice(0, 20).map(r => `
      <div class="event-item">
        <div class="event-item-type">Channel Points</div>
        <div><strong>${escapeHtml(r.user || 'Unknown')}</strong> redeemed <strong>${escapeHtml(r.reward || 'Reward')}</strong></div>
        ${r.input ? `<div><em>${escapeHtml(r.input)}</em></div>` : ''}
        <div class="event-item-time">${new Date(r.timestamp).toLocaleString()}</div>
      </div>
    `).join('');
  } catch (error) {
    console.error('Failed to load redemptions:', error);
  }
}

// EventSub Events
async function loadEventSubEvents() {
  try {
    const res = await fetch('/api/eventsub-events');
    const events: DashEventSubEvent[] | null = await res.json();
    const list = document.getElementById('eventSubEventsList')!;

    if (!events || events.length === 0) {
      list.innerHTML = '<div class="event-item">No events yet (enable EventSub in .env)</div>';
      return;
    }

    list.innerHTML = events.reverse().slice(0, 20).map(e => `
      <div class="event-item">
        <div class="event-item-type">${escapeHtml(e.type || 'Event')}</div>
        <div>${escapeHtml(e.details || '')}</div>
        <div class="event-item-time">${new Date(e.timestamp).toLocaleString()}</div>
      </div>
    `).join('');
  } catch (error) {
    console.error('Failed to load EventSub events:', error);
  }
}

// OBS Overlays Configuration
async function loadObsOverlayConfig() {
  try {
    const res = await fetch('/obs/config');
    const config: DashObsOverlayConfig = await res.json();

    // Update UI with config values
    (document.getElementById('alertsDuration') as HTMLInputElement).value = String(config.overlays.alerts.duration ?? 5);
    (document.getElementById('alertsVolume') as HTMLInputElement).value = String(config.overlays.alerts.volume ?? 0.8);
    (document.getElementById('alertsEnabled') as HTMLInputElement).checked = config.overlays.alerts.enabled !== false;

    (document.getElementById('recentEventsLimit') as HTMLInputElement).value = String(config.overlays.recentEvents.limit ?? 10);
    (document.getElementById('recentEventsShowTime') as HTMLInputElement).checked = config.overlays.recentEvents.showTime !== false;
    (document.getElementById('recentEventsEnabled') as HTMLInputElement).checked = config.overlays.recentEvents.enabled !== false;

    (document.getElementById('chatBoxMessageTimeout') as HTMLInputElement).value = String(config.overlays.chatBox.messageTimeout ?? 8);
    (document.getElementById('chatBoxHideBot') as HTMLInputElement).checked = config.overlays.chatBox.hideBot === true;
    (document.getElementById('chatBoxEnabled') as HTMLInputElement).checked = config.overlays.chatBox.enabled !== false;

    (document.getElementById('goalBarType') as HTMLSelectElement).value = config.overlays.goalBar.type || 'follow';
    (document.getElementById('goalBarGoal') as HTMLInputElement).value = String(config.overlays.goalBar.goal ?? 1000);
    (document.getElementById('goalBarEnabled') as HTMLInputElement).checked = config.overlays.goalBar.enabled !== false;

    updateOverlayUrls();
  } catch (error) {
    console.error('Failed to load OBS config:', error);
  }
}

function updateOverlayUrls() {
  const baseUrl = window.location.origin;

  /** Look up a form control by id (absent controls yield null) */
  const field = (id: string) => document.getElementById(id) as HTMLInputElement | null;

  // Helper to safely parse number and return undefined if NaN
  function parseNum(value: string | undefined, defaultValue: number | undefined = undefined) {
    const num = parseFloat(value!);
    return Number.isFinite(num) ? num : defaultValue;
  }

  // Helper to safely parse integer and return undefined if NaN
  function parseIntSafe(value: string | undefined, defaultValue: number | undefined = undefined) {
    const num = parseInt(value!);
    return Number.isFinite(num) ? num : defaultValue;
  }

  // Helper to build URL with query parameters (filters out undefined/null/NaN)
  function buildUrl(overlay: string, params: Record<string, string | number | boolean | null | undefined>) {
    const url = new URL(`${baseUrl}/obs/overlays/${overlay}.html`);
    Object.keys(params).forEach(key => {
      const value = params[key];
      if (value !== undefined && value !== null && value !== '' && !Number.isNaN(value)) {
        url.searchParams.set(key, String(value));
      }
    });
    return url.toString();
  }

  // Alerts overlay
  const alertsDuration = parseIntSafe(field('alertsDuration')?.value);
  const alertsParams = {
    duration: alertsDuration ? alertsDuration * 1000 : undefined, // Convert seconds to ms
    volume: parseNum(field('alertsVolume')?.value)
  };
  field('alertsUrl')!.value = buildUrl('alerts', alertsParams);

  // Recent Events overlay
  const recentEventsParams = {
    limit: parseIntSafe(field('recentEventsLimit')?.value),
    showTime: field('recentEventsShowTime')?.checked
  };
  field('recentEventsUrl')!.value = buildUrl('recent-events', recentEventsParams);

  // Chat Box overlay
  const chatBoxTimeout = parseIntSafe(field('chatBoxMessageTimeout')?.value);
  const chatBoxParams = {
    timeout: chatBoxTimeout ? chatBoxTimeout * 1000 : undefined, // Convert to ms
    hideBot: field('chatBoxHideBot')?.checked || undefined
  };
  field('chatBoxUrl')!.value = buildUrl('chat-box', chatBoxParams);

  // Goal Bar overlay
  const goalBarParams = {
    goal: parseIntSafe(field('goalBarGoal')?.value),
    type: field('goalBarType')?.value
  };
  field('goalBarUrl')!.value = buildUrl('goal-bar', goalBarParams);

  // TTS Display overlay
  const ttsDuration = parseIntSafe(field('ttsDuration')?.value);
  const ttsParams = {
    voice: field('ttsVoice')?.value || undefined,
    rate: parseNum(field('ttsRate')?.value),
    pitch: parseNum(field('ttsPitch')?.value),
    volume: parseNum(field('ttsVolume')?.value),
    duration: ttsDuration ? ttsDuration * 1000 : undefined // Convert to ms
  };
  if (field('ttsUrl')) {
    field('ttsUrl')!.value = buildUrl('tts-display', ttsParams);
  }

  // Leaderboard overlay
  const leaderboardPoll = parseIntSafe(field('leaderboardPoll')?.value);
  const leaderboardParams = {
    limit: parseIntSafe(field('leaderboardLimit')?.value),
    poll: leaderboardPoll ? leaderboardPoll * 1000 : undefined, // Convert to ms
    title: field('leaderboardTitle')?.value || undefined
  };
  if (field('leaderboardUrl')) {
    field('leaderboardUrl')!.value = buildUrl('leaderboard', leaderboardParams);
  }

  // Counter Display overlay
  const counterPoll = parseIntSafe(field('counterPoll')?.value);
  const counterParams = {
    mode: field('counterMode')?.value,
    counter: field('counterName')?.value || undefined,
    poll: counterPoll ? counterPoll * 1000 : undefined // Convert to ms
  };
  if (field('counterUrl')) {
    field('counterUrl')!.value = buildUrl('counter-display', counterParams);
  }

  // Quote Display overlay
  const quoteInterval = parseIntSafe(field('quoteInterval')?.value);
  const quoteDuration = parseIntSafe(field('quoteDuration')?.value);
  const quoteParams = {
    mode: field('quoteMode')?.value,
    rotate: field('quoteRotate')?.checked || undefined,
    interval: quoteInterval ? quoteInterval * 1000 : undefined, // Convert to ms
    duration: quoteDuration ? quoteDuration * 1000 : undefined // Convert to ms
  };
  if (field('quoteUrl')) {
    field('quoteUrl')!.value = buildUrl('quote-display', quoteParams);
  }
}

async function updateOverlayConfig(overlay: string, setting: string, value: string | boolean) {
  try {
    const payload: Record<string, string | number | boolean> = {};

    // Validate numeric settings
    if (setting === 'volume') {
      const vol = parseFloat(value as string);
      if (isNaN(vol) || vol < 0 || vol > 1) {
        alert('Volume must be a number between 0 and 1');
        return;
      }
      payload[setting] = vol;
    } else if (setting === 'duration') {
      const dur = parseInt(value as string);
      if (isNaN(dur) || dur < 1) {
        alert('Duration must be a positive number');
        return;
      }
      payload[setting] = dur;
    } else if (setting === 'limit') {
      const limit = parseInt(value as string);
      if (isNaN(limit) || limit < 1) {
        alert('Max events must be a positive number');
        return;
      }
      payload[setting] = limit;
    } else if (setting === 'messageTimeout') {
      const timeout = parseInt(value as string);
      if (isNaN(timeout) || timeout < 1) {
        alert('Message timeout must be a positive number');
        return;
      }
      payload[setting] = timeout;
    } else if (setting === 'goal') {
      const goal = parseInt(value as string);
      if (isNaN(goal) || goal < 1) {
        alert('Goal must be a positive number');
        return;
      }
      payload[setting] = goal;
    } else {
      // Boolean and string values
      payload[setting] = value;
    }

    const res = await fetch(`/obs/config/${overlay}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const error: DashApiError = await res.json();
      alert(`Failed to update ${overlay}: ${error.error}`);
      // Revert the input to the server state by reloading config
      loadObsOverlayConfig();
    } else {
      // Show brief success message
      console.log(`[OBS Config] Updated ${overlay}.${setting}`);
    }
  } catch (error) {
    console.error(`Failed to update overlay config:`, error);
    alert('Failed to update overlay configuration');
    // Revert the input to the server state by reloading config
    loadObsOverlayConfig();
  }
}

function copyToClipboard(elementId: string, button: HTMLElement | null) {
  const element = document.getElementById(elementId) as HTMLInputElement | null;
  if (!element || !button) return;

  element.select();
  document.execCommand('copy');

  // Show visual feedback on the button
  const originalText = button.textContent;
  button.textContent = 'Copied!';
  button.style.backgroundColor = '#00cc66';

  setTimeout(() => {
    button.textContent = originalText;
    button.style.backgroundColor = '';
  }, 2000);
}

function testOverlay(overlayName: string) {
  if (overlayName === 'alerts') {
    fetch('/api/test-alert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        alertType: 'follow',
        user: 'TestUser',
        message: 'This is a test alert'
      })
    }).catch(err => console.error('Failed to send test alert:', err));
    alert('Test alert sent! Check your alerts overlay.');
  } else if (overlayName === 'recentEvents') {
    window.open(`${window.location.origin}/obs/overlays/recent-events.html`, '_blank');
  } else if (overlayName === 'tts') {
    fetch('/api/test-alert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        alertType: 'tts',
        user: 'TestUser',
        message: 'This is a test TTS message. Welcome to the stream!',
        config: {
          duration: parseInt(String((document.getElementById('ttsDuration') as HTMLInputElement | null)?.value || 5)) * 1000
        }
      })
    }).catch(err => console.error('Failed to send test TTS:', err));
    alert('Test TTS sent! Check your TTS display overlay.');
  }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  initWebSocket();

  // Fetch initial data
  fetch('/api/status')
    .then(res => res.json())
    .then((data: DashBotState) => {
      botState = data;
      updateDashboard();
    });

  // Refresh logs and stats on page load
  refreshLogs();
  refreshStats();
  loadCustomCommands();
  loadBuiltinCommands();
  loadAnnouncements();
  loadRedemptions();
  loadEventSubEvents();
  loadFilters();
  loadObsOverlayConfig();
});

// Chat Filters Functions

function loadFilters() {
  fetch('/api/filters')
    .then(res => res.json())
    .then((filters: DashFilters) => {
      (document.getElementById('filterUrls') as HTMLInputElement).checked = filters.filterUrls;
      (document.getElementById('filterAllCaps') as HTMLInputElement).checked = filters.filterAllCaps;
      (document.getElementById('filterRepeatChars') as HTMLInputElement).checked = filters.filterRepeatChars;
      (document.getElementById('filterSpam') as HTMLInputElement).checked = filters.filterSpam;
      (document.getElementById('filterAction') as HTMLSelectElement).value = filters.filterAction;
      // number assigned as-is; the DOM stringifies it
      (document.getElementById('timeoutDuration') as HTMLInputElement).value = filters.timeoutDurationSeconds as unknown as string;
      renderBlacklist(filters.blacklistWords);
    })
    .catch(err => console.error('Failed to load filters:', err));
}

function updateFilterSetting(setting: string, value: string | boolean) {
  const payload: Record<string, string | boolean> = {};

  // Map setting names
  if (setting === 'filterUrls') payload.filterUrls = value;
  else if (setting === 'filterAllCaps') payload.filterAllCaps = value;
  else if (setting === 'filterRepeatChars') payload.filterRepeatChars = value;
  else if (setting === 'filterSpam') payload.filterSpam = value;
  else if (setting === 'filterAction') payload.filterAction = value;
  else if (setting === 'timeoutDurationSeconds') payload.timeoutDurationSeconds = value;

  fetch('/api/filters', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
    .then(res => res.json())
    .then((data: DashFilterResult) => {
      if (data.success) {
        console.log('Filter setting updated:', setting, value);
      } else {
        console.error('Failed to update filter:', data.error);
        loadFilters(); // Reload to show actual state
      }
    })
    .catch(err => {
      console.error('Error updating filter:', err);
      loadFilters();
    });
}

function addFilterWord() {
  const input = document.getElementById('newWord') as HTMLInputElement;
  const word = input.value.trim();

  if (!word) {
    alert('Please enter a word to filter');
    return;
  }

  fetch('/api/filters/words', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ word })
  })
    .then(res => res.json())
    .then((data: DashFilterResult) => {
      if (data.success) {
        input.value = '';
        renderBlacklist(data.words);
      } else {
        alert('Error adding word: ' + data.error);
      }
    })
    .catch(err => {
      console.error('Error adding word:', err);
      alert('Failed to add word');
    });
}

function removeFilterWord(word: string) {
  if (!confirm(`Remove "${word}" from filter?`)) return;

  fetch(`/api/filters/words/${encodeURIComponent(word)}`, {
    method: 'DELETE'
  })
    .then(res => res.json())
    .then((data: DashFilterResult) => {
      if (data.success) {
        renderBlacklist(data.words);
      } else {
        alert('Error removing word: ' + data.error);
      }
    })
    .catch(err => {
      console.error('Error removing word:', err);
      alert('Failed to remove word');
    });
}

function renderBlacklist(words: string[] | undefined) {
  const container = document.getElementById('blacklistContainer')!;

  if (!words || words.length === 0) {
    container.innerHTML = '<p class="info-text">No words in blacklist yet.</p>';
    return;
  }

  container.innerHTML = words
    .map((word, index) => `
      <div class="blacklist-word">
        <span>${escapeHtml(word)}</span>
        <button class="btn btn-small btn-danger remove-filter-btn" data-word-index="${index}">Remove</button>
      </div>
    `)
    .join('');

  // Add event listeners to remove buttons
  container.querySelectorAll('.remove-filter-btn').forEach((btn, index) => {
    btn.addEventListener('click', () => {
      const word = words[index];
      removeFilterWord(word);
    });
  });
}

// ============================================
// ALERT CONFIGURATION FUNCTIONS
// ============================================

let alertConfig: DashAlertConfig | null = null;

// Load alert configuration
async function loadAlertConfig() {
  try {
    const res = await fetch('/api/alerts/config');
    alertConfig = await res.json();
    populateAlertConfigUI();
  } catch (error) {
    console.error('Failed to load alert config:', error);
  }
}

// Populate UI with alert config values
function populateAlertConfigUI() {
  if (!alertConfig) return;

  const global = alertConfig.global;
  const types = alertConfig.alertTypes;

  // Global settings
  (document.getElementById('globalEnabled') as HTMLInputElement).checked = global.enabled !== false;
  (document.getElementById('globalVolume') as HTMLInputElement).value = String(global.defaultVolume ?? 0.8);
  document.getElementById('globalVolumeDisplay')!.textContent = String(global.defaultVolume ?? 0.8);
  (document.getElementById('globalDuration') as HTMLInputElement).value = String(global.defaultDuration ?? 5);
  (document.getElementById('globalDelay') as HTMLInputElement).value = String(global.defaultDelay ?? 1);
  (document.getElementById('globalTtsEnabled') as HTMLInputElement).checked = global.ttsEnabled === true;
  (document.getElementById('globalTtsVoice') as HTMLSelectElement).value = global.ttsVoice || 'en-US';
  (document.getElementById('globalTtsRate') as HTMLInputElement).value = String(global.ttsRate ?? 1);
  document.getElementById('globalTtsRateDisplay')!.textContent = String(global.ttsRate ?? 1);
  (document.getElementById('globalTtsPitch') as HTMLInputElement).value = String(global.ttsPitch ?? 1);
  document.getElementById('globalTtsPitchDisplay')!.textContent = String(global.ttsPitch ?? 1);

  // Per-alert-type settings
  const alertTypes = ['follow', 'subscription', 'bits', 'raid', 'redemption', 'first_chatter'];
  alertTypes.forEach(type => {
    const config = types[type];
    if (!config) return;

    // Basic settings
    const enabledEl = document.getElementById(`${type}-enabled`) as HTMLInputElement | null;
    if (enabledEl) enabledEl.checked = config.enabled !== false;

    const durationEl = document.getElementById(`${type}-duration`) as HTMLInputElement | null;
    if (durationEl) durationEl.value = String(config.duration ?? 5);

    const volumeEl = document.getElementById(`${type}-volume`) as HTMLInputElement | null;
    if (volumeEl) {
      volumeEl.value = String(config.volume ?? 0.8);
      const displayEl = document.getElementById(`${type}-volume-display`);
      if (displayEl) displayEl.textContent = String(config.volume ?? 0.8);
    }

    const messageEl = document.getElementById(`${type}-messageTemplate`) as HTMLInputElement | null;
    if (messageEl) messageEl.value = config.messageTemplate || '';

    // Animation settings
    const enterEl = document.getElementById(`${type}-enterAnimation`) as HTMLSelectElement | null;
    if (enterEl) enterEl.value = config.enterAnimation || 'bounceIn';

    const exitEl = document.getElementById(`${type}-exitAnimation`) as HTMLSelectElement | null;
    if (exitEl) exitEl.value = config.exitAnimation || 'fadeOutUp';

    // Style settings
    const textColorEl = document.getElementById(`${type}-textColor`) as HTMLInputElement | null;
    if (textColorEl) textColorEl.value = config.textColor || '#ffffff';

    const borderColorEl = document.getElementById(`${type}-borderColor`) as HTMLInputElement | null;
    if (borderColorEl) borderColorEl.value = config.borderColor || '#9147ff';

    const fontSizeEl = document.getElementById(`${type}-fontSize`) as HTMLInputElement | null;
    if (fontSizeEl) fontSizeEl.value = String(config.fontSize ?? 28);

    // Media settings
    const soundEl = document.getElementById(`${type}-sound`) as HTMLSelectElement | null;
    if (soundEl) {
      soundEl.value = config.sound || 'default';
      toggleCustomSoundInput(type, config.sound);
    }

    // Show media filenames if set
    if (config.image) {
      const imgNameEl = document.getElementById(`${type}-image-name`);
      if (imgNameEl) imgNameEl.textContent = config.image.split('/').pop()!;
      const imgClearEl = document.getElementById(`${type}-image-clear`);
      if (imgClearEl) imgClearEl.style.display = 'inline-block';
    }
    if (config.video) {
      const vidNameEl = document.getElementById(`${type}-video-name`);
      if (vidNameEl) vidNameEl.textContent = config.video.split('/').pop()!;
      const vidClearEl = document.getElementById(`${type}-video-clear`);
      if (vidClearEl) vidClearEl.style.display = 'inline-block';
    }
    if (config.customSound) {
      const sndNameEl = document.getElementById(`${type}-customSound-name`);
      if (sndNameEl) sndNameEl.textContent = config.customSound.split('/').pop()!;
    }

    // TTS settings
    const ttsEnabledEl = document.getElementById(`${type}-ttsEnabled`) as HTMLInputElement | null;
    if (ttsEnabledEl) ttsEnabledEl.checked = config.ttsEnabled === true;

    const ttsTemplateEl = document.getElementById(`${type}-ttsTemplate`) as HTMLInputElement | null;
    if (ttsTemplateEl) ttsTemplateEl.value = config.ttsTemplate || '';

    // Type-specific settings
    if (type === 'bits') {
      const minBitsEl = document.getElementById('bits-minBits') as HTMLInputElement | null;
      if (minBitsEl) minBitsEl.value = String(config.minBits || 1);
    }
    if (type === 'raid') {
      const minViewersEl = document.getElementById('raid-minViewers') as HTMLInputElement | null;
      if (minViewersEl) minViewersEl.value = String(config.minViewers || 2);
    }
  });
}

// Update alert type setting
async function updateAlertSetting(alertType: string, setting: string, value: DashAlertSettingValue) {
  try {
    const res = await fetch(`/api/alerts/config/${alertType}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [setting]: value })
    });
    if (res.ok) {
      const result: { config: DashAlertTypeConfig } = await res.json();
      if (alertConfig) alertConfig.alertTypes[alertType] = result.config;
      console.log(`[AlertConfig] Updated ${alertType}.${setting}:`, value);

      // Update display elements for volume
      if (setting === 'volume') {
        const displayEl = document.getElementById(`${alertType}-volume-display`);
        // value assigned as-is; the DOM stringifies it
        if (displayEl) displayEl.textContent = value as string;
      }

      // Handle sound selection
      if (setting === 'sound') {
        toggleCustomSoundInput(alertType, value);
      }
    }
  } catch (error) {
    console.error('Failed to update alert setting:', error);
  }
}

// Update global alert settings
function updateGlobalSetting(setting: string, value: DashAlertSettingValue) {
  if (!alertConfig) return;
  alertConfig.global[setting] = value;

  // Update display elements (value assigned as-is; the DOM stringifies it)
  if (setting === 'defaultVolume') {
    document.getElementById('globalVolumeDisplay')!.textContent = value as string;
  } else if (setting === 'ttsRate') {
    document.getElementById('globalTtsRateDisplay')!.textContent = value as string;
  } else if (setting === 'ttsPitch') {
    document.getElementById('globalTtsPitchDisplay')!.textContent = value as string;
  }

  // Persist to server
  fetch('/api/alerts/config/global', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [setting]: value })
  }).catch(err => console.error('Failed to update global setting:', err));
}

// Show alert type config section
function showAlertTypeConfig(alertType: string, event?: Event) {
  document.querySelectorAll('.alert-type-config').forEach(el => {
    el.classList.remove('active');
  });

  document.querySelectorAll('.alert-tab').forEach(el => {
    el.classList.remove('active');
  });

  const configEl = document.getElementById(`${alertType}-config`);
  if (configEl) configEl.classList.add('active');

  if (event && event.currentTarget) {
    (event.currentTarget as Element).classList.add('active');
  }
}

// Toggle section collapse
function toggleSection(sectionId: string) {
  const section = document.getElementById(sectionId)!;
  const header = section.previousElementSibling!;

  if (section.classList.contains('collapsed')) {
    section.classList.remove('collapsed');
    header.classList.remove('collapsed');
  } else {
    section.classList.add('collapsed');
    header.classList.add('collapsed');
  }
}

// Update variation settings
function updateVariation(alertType: string, variationKey: string, setting: string, value: DashAlertSettingValue) {
  if (!alertConfig || !alertConfig.alertTypes[alertType]) return;

  if (!alertConfig.alertTypes[alertType].variations) {
    alertConfig.alertTypes[alertType].variations = {};
  }
  if (!alertConfig.alertTypes[alertType].variations![variationKey]) {
    alertConfig.alertTypes[alertType].variations![variationKey] = {};
  }

  alertConfig.alertTypes[alertType].variations![variationKey][setting] = value;

  fetch(`/api/alerts/config/${alertType}/variation/${variationKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [setting]: value })
  }).catch(err => console.error('Failed to update variation:', err));
}

// Upload media for alert
async function uploadAlertMedia(alertType: string, mediaType: string, inputEl: HTMLInputElement) {
  const file = inputEl.files![0];
  if (!file) return;

  let endpoint: string;
  if (mediaType === 'image') endpoint = '/api/uploads/image';
  else if (mediaType === 'video') endpoint = '/api/uploads/video';
  else if (mediaType === 'customSound') endpoint = '/api/uploads/sound';
  else return;

  try {
    const reader = new FileReader();
    reader.onload = async function(e) {
      const base64Data = e.target!.result;

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: base64Data, filename: file.name })
      });

      if (res.ok) {
        const result: { path: string } = await res.json();
        const settingName = mediaType === 'customSound' ? 'customSound' : mediaType;
        await updateAlertSetting(alertType, settingName, result.path);

        const nameEl = document.getElementById(`${alertType}-${mediaType}-name`);
        if (nameEl) nameEl.textContent = file.name;

        const clearEl = document.getElementById(`${alertType}-${mediaType}-clear`);
        if (clearEl) clearEl.style.display = 'inline-block';

        console.log(`[AlertConfig] Uploaded ${mediaType} for ${alertType}:`, result.path);
      } else {
        const error: DashApiError = await res.json();
        alert('Upload failed: ' + error.error);
      }
    };
    reader.readAsDataURL(file);
  } catch (error) {
    console.error('Upload error:', error);
    alert('Upload failed: ' + (error as Error).message);
  }
}

// Clear uploaded media
async function clearAlertMedia(alertType: string, mediaType: string) {
  await updateAlertSetting(alertType, mediaType, null);

  const nameEl = document.getElementById(`${alertType}-${mediaType}-name`);
  if (nameEl) nameEl.textContent = '';

  const clearEl = document.getElementById(`${alertType}-${mediaType}-clear`);
  if (clearEl) clearEl.style.display = 'none';
}

// Reset alert type to defaults
async function resetAlertType(alertType: string) {
  if (!confirm(`Reset ${alertType} alert settings to defaults?`)) return;

  try {
    const res = await fetch('/api/alerts/config/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertType })
    });
    if (res.ok) {
      await loadAlertConfig();
      alert(`${alertType} alert settings reset to defaults`);
    }
  } catch (error) {
    console.error('Failed to reset alert type:', error);
  }
}

// Send test alert
async function sendTestAlert() {
  const alertType = (document.getElementById('testAlertType') as HTMLSelectElement).value;
  const user = (document.getElementById('testAlertUser') as HTMLInputElement).value || 'TestUser';
  const message = (document.getElementById('testAlertMessage') as HTMLInputElement).value || '';

  const testData: DashTestAlertData = {
    alertType,
    user,
    message: message || undefined,
    useConfig: true
  };

  if (alertType === 'subscription') {
    testData.tier = (document.getElementById('testAlertTier') as HTMLSelectElement).value;
  } else if (alertType === 'bits') {
    testData.amount = parseInt((document.getElementById('testAlertBits') as HTMLInputElement).value) || 100;
  } else if (alertType === 'raid') {
    testData.viewers = parseInt((document.getElementById('testAlertViewers') as HTMLInputElement).value) || 50;
  } else if (alertType === 'redemption') {
    testData.reward = (document.getElementById('testAlertReward') as HTMLInputElement).value || 'Test Reward';
  }

  try {
    const res = await fetch('/api/alerts/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testData)
    });
    if (res.ok) {
      console.log('[AlertConfig] Test alert sent:', testData);
    }
  } catch (error) {
    console.error('Failed to send test alert:', error);
  }
}

// Test all alert types in sequence
async function testAllAlertTypes() {
  const types = ['follow', 'subscription', 'bits', 'raid', 'redemption', 'first_chatter'];
  for (const type of types) {
    await testAlertType(type);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

// Toggle custom sound input visibility
function toggleCustomSoundInput(alertType: string, soundValue: unknown) {
  const groupEl = document.getElementById(`${alertType}-customSound-group`);
  if (groupEl) {
    groupEl.style.display = soundValue === 'custom' ? 'block' : 'none';
  }
}

// Test specific alert type
async function testAlertType(alertType: string) {
  const testData: DashTestAlertData = {
    alertType,
    user: 'TestUser',
    useConfig: true
  };

  // Add type-specific test data
  if (alertType === 'subscription') {
    testData.tier = '1000';
    testData.message = 'Test subscription message!';
  } else if (alertType === 'bits') {
    testData.amount = 100;
    testData.message = 'Test bits message!';
  } else if (alertType === 'raid') {
    testData.viewers = 50;
  } else if (alertType === 'redemption') {
    testData.reward = 'Test Reward';
    testData.message = 'Test redemption message!';
  }

  try {
    const res = await fetch('/api/alerts/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testData)
    });
    if (res.ok) {
      console.log(`[AlertConfig] Test ${alertType} alert sent`);
    }
  } catch (error) {
    console.error('Failed to send test alert:', error);
  }
}

// Update test panel fields based on alert type
function updateTestPanelFields() {
  const alertType = (document.getElementById('testAlertType') as HTMLSelectElement).value;

  document.getElementById('testTierGroup')!.style.display = alertType === 'subscription' ? 'block' : 'none';
  document.getElementById('testBitsGroup')!.style.display = alertType === 'bits' ? 'block' : 'none';
  document.getElementById('testViewersGroup')!.style.display = alertType === 'raid' ? 'block' : 'none';
  document.getElementById('testRewardGroup')!.style.display = alertType === 'redemption' ? 'block' : 'none';
}

// Bot control (the Settings form itself lives in manage.ts)
async function restartBot() {
  if (!confirm('Are you sure you want to restart the bot? It will take a few seconds to reconnect.')) {
    return;
  }

  try {
    const response = await fetch('/api/bot/restart', {
      method: 'POST'
    });

    if (response.ok) {
      alert('Restart signal sent. The bot restarts within a few seconds and picks up saved settings.');
    } else {
      alert('Failed to send restart signal');
    }
  } catch (error) {
    console.error('Failed to restart bot:', error);
    alert('Failed to restart bot');
  }
}

// Add event listener for test panel alert type change
document.addEventListener('DOMContentLoaded', () => {
  const testAlertTypeEl = document.getElementById('testAlertType');
  if (testAlertTypeEl) {
    testAlertTypeEl.addEventListener('change', updateTestPanelFields);
  }

  // Load alert config
  loadAlertConfig();
});
