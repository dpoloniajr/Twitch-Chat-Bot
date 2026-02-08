let botState = {};
let ws = null;

// Initialize WebSocket connection
function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}`);
  
  ws.onopen = () => {
    console.log('Connected to dashboard server');
  };
  
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    
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
  const statusEl = document.getElementById('botStatus');
  const indicatorEl = document.getElementById('statusIndicator');
  const channelsEl = document.getElementById('channelsList');
  const commandCountEl = document.getElementById('commandCount');
  const lastCommandEl = document.getElementById('lastCommand');
  const lastCommandTimeEl = document.getElementById('lastCommandTime');
  const commandsListEl = document.getElementById('commandsList');

  // Update status
  statusEl.textContent = botState.isConnected ? 'Connected' : 'Disconnected';
  indicatorEl.className = `status-indicator ${botState.isConnected ? 'connected' : 'disconnected'}`;

  // Update channels
  channelsEl.textContent = botState.channels?.length > 0 ? botState.channels.join(', ') : '-';

  // Update command count
  commandCountEl.textContent = botState.commandsExecuted ?? 0;

  // Update last command
  if (botState.lastCommand) {
    lastCommandEl.textContent = `${botState.lastCommand.user}: ${botState.lastCommand.command}`;
    lastCommandTimeEl.textContent = new Date(botState.lastCommand.timestamp).toLocaleString();
  } else {
    lastCommandEl.textContent = 'None';
    lastCommandTimeEl.textContent = '';
  }

  // Update settings page
  document.getElementById('broadcasterName').value = botState.broadcasterName || '-';
  document.getElementById('channels').value = botState.channels?.join(', ') || '-';
  document.getElementById('scopes').value = botState.scopes?.join(' ') || '-';

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
function showPage(pageId, eventObj) {
  // Hide all pages
  document.querySelectorAll('.page').forEach(page => {
    page.classList.remove('active');
  });

  // Remove active state from nav links
  document.querySelectorAll('.nav-link').forEach(link => {
    link.classList.remove('active');
  });

  // Show selected page
  document.getElementById(pageId).classList.add('active');
  if (eventObj && eventObj.target) {
    eventObj.target.classList.add('active');
  }

  // Load page-specific data
  if (pageId === 'settings') {
    loadBotSettings();
  }
}

// Command tester
function testCommand() {
  const username = document.getElementById('testerUsername').value;
  const command = document.getElementById('testerCommand').value;
  const args = document.getElementById('testerArgs').value;
  const resultEl = document.getElementById('testerResult');

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

function showResult(message, type) {
  const resultEl = document.getElementById('testerResult');
  resultEl.textContent = message;
  resultEl.className = `result-box ${type}`;
  resultEl.style.display = 'block';
}

// Logs management
async function refreshLogs() {
  try {
    const response = await fetch('/api/logs');
    const logs = await response.json();
    
    const logsListEl = document.getElementById('logsList');
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

function addChatLog(log) {
  const logsListEl = document.getElementById('logsList');
  const newRow = `
    <tr>
      <td>${new Date(log.timestamp).toLocaleString()}</td>
      <td>${log.user}</td>
      <td><code>${log.command}</code></td>
      <td>${log.channel}</td>
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
function addChatMessage(chat) {
  const feed = document.getElementById('chatFeed');
  const time = new Date(chat.timestamp).toLocaleTimeString();
  const html = `
    <div class="chat-message">
      <div class="chat-user">${chat.user} <span class="chat-time">${time} • #${chat.channel}</span></div>
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

function escapeHtml(str) {
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
    const stats = await response.json();
    
    const statsListEl = document.getElementById('statsList');
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
    const cmds = await res.json();
    botState.customCommands = cmds;
    renderCustomCommands();
  } catch (error) {
    console.error('Failed to load custom commands:', error);
  }
}

function renderCustomCommands() {
  const listEl = document.getElementById('customCommandsList');
  if (!listEl || !botState.customCommands) return;

  listEl.innerHTML = botState.customCommands
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    .map(cmd => `
      <tr>
        <td>${escapeHtml(cmd.name)}</td>
        <td>${escapeHtml(cmd.response || '')}</td>
        <td>${escapeHtml(cmd.level || 'everyone')}</td>
        <td>${cmd.fetchEnabled ? 'Yes' : 'No'}</td>
        <td>${cmd.cooldownSeconds || 0}s</td>
        <td>
          <button class="btn btn-secondary" onclick="prefillCommand('${(cmd.name || '').replace(/'/g, "\\'")}')">Edit</button>
          <button class="btn btn-danger" onclick="deleteCommand('${(cmd.name || '').replace(/'/g, "\\'")}')">Delete</button>
        </td>
      </tr>
    `).join('');
}

async function saveCommand() {
  const name = document.getElementById('ccName').value.trim();
  const response = document.getElementById('ccResponse').value.trim();
  const level = document.getElementById('ccLevel').value;
  const fetchUrl = document.getElementById('ccFetchUrl').value.trim();
  const fetchEnabled = document.getElementById('ccFetchEnabled').value === 'true';
  const cooldownSeconds = Number(document.getElementById('ccCooldown').value) || 0;

  if (!name || !response) {
    alert('Command name and response are required (response can be blank if fetch is enabled with {data}).');
    return;
  }

  await fetch('/api/custom-commands', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, response, level, fetchUrl, fetchEnabled, cooldownSeconds })
  });

  document.getElementById('ccName').value = '';
  document.getElementById('ccResponse').value = '';
  document.getElementById('ccLevel').value = 'everyone';
  document.getElementById('ccFetchUrl').value = '';
  document.getElementById('ccFetchEnabled').value = 'false';
  document.getElementById('ccCooldown').value = '0';
  loadCustomCommands();
}

function prefillCommand(name) {
  const cmd = botState.customCommands?.find(c => c.name === name);
  if (!cmd) return;
  document.getElementById('ccName').value = cmd.name;
  document.getElementById('ccResponse').value = cmd.response;
  document.getElementById('ccLevel').value = cmd.level || 'everyone';
   document.getElementById('ccFetchUrl').value = cmd.fetchUrl || '';
   document.getElementById('ccFetchEnabled').value = cmd.fetchEnabled ? 'true' : 'false';
   document.getElementById('ccCooldown').value = cmd.cooldownSeconds ?? 0;
}

async function deleteCommand(name) {
  if (!confirm(`Delete ${name}?`)) return;
  await fetch(`/api/custom-commands/${encodeURIComponent(name)}`, { method: 'DELETE' });
  loadCustomCommands();
}

// Built-in commands configuration
async function loadBuiltinCommands() {
  try {
    const res = await fetch('/api/builtin-commands');
    const commands = await res.json();
    renderBuiltinCommands(commands);
  } catch (error) {
    console.error('Failed to load built-in commands:', error);
  }
}

function renderBuiltinCommands(commands) {
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
                 id="cooldown-${safeName}"
                 value="${cmd.cooldownSeconds || 0}"
                 min="0"
                 style="width: 80px; padding: 5px;">
        </td>
        <td>
          <button class="btn btn-primary" onclick="updateBuiltinCommandCooldown('${cmd.name}')">Update</button>
        </td>
      </tr>
    `;
  }).join('');
}

async function updateBuiltinCommandCooldown(commandName) {
  const inputId = `cooldown-${commandName.replace('!', '')}`;
  const cooldownSeconds = Number(document.getElementById(inputId).value) || 0;

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
      const error = await res.json();
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
    const data = await res.json();
    const announcements = Array.isArray(data) ? data : [];
    document.getElementById('announcementsList').value = announcements.join('\n');
  } catch (error) {
    console.error('Failed to load announcements:', error);
  }
}

async function saveAnnouncements() {
  const text = document.getElementById('announcementsList').value;
  const announcements = text.split('\n').map(a => a.trim()).filter(Boolean);
  try {
    await fetch('/api/announcements', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ announcements })
    });
    alert('Announcements saved. Restart bot to apply changes.');
  } catch (error) {
    alert('Error saving announcements: ' + error.message);
  }
}

// Polls
async function createPoll() {
  const title = document.getElementById('pollTitle').value;
  const optionsText = document.getElementById('pollOptions').value;
  const duration = parseInt(document.getElementById('pollDuration').value) || 60;
  
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
    const result = await res.json();
    document.getElementById('pollResult').innerHTML = `<div style="color:#0f0;">Poll created: ${title}</div>`;
    setTimeout(() => {
      document.getElementById('pollTitle').value = '';
      document.getElementById('pollOptions').value = '';
      document.getElementById('pollResult').innerHTML = '';
    }, 3000);
  } catch (error) {
    document.getElementById('pollResult').innerHTML = `<div style="color:#f00;">Error: ${error.message}</div>`;
  }
}

// Predictions
async function createPrediction() {
  const title = document.getElementById('predTitle').value;
  const outcomesText = document.getElementById('predOutcomes').value;
  const duration = parseInt(document.getElementById('predDuration').value) || 120;
  
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
    const result = await res.json();
    document.getElementById('predResult').innerHTML = `<div style="color:#0f0;">Prediction created: ${title}</div>`;
    setTimeout(() => {
      document.getElementById('predTitle').value = '';
      document.getElementById('predOutcomes').value = '';
      document.getElementById('predResult').innerHTML = '';
    }, 3000);
  } catch (error) {
    document.getElementById('predResult').innerHTML = `<div style="color:#f00;">Error: ${error.message}</div>`;
  }
}

// Redemptions
async function loadRedemptions() {
  try {
    const res = await fetch('/api/redemptions');
    const redemptions = await res.json();
    const list = document.getElementById('redemptionsList');
    
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
    const events = await res.json();
    const list = document.getElementById('eventSubEventsList');
    
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
    const config = await res.json();

    // Update UI with config values
    document.getElementById('alertsDuration').value = config.overlays.alerts.duration ?? 5;
    document.getElementById('alertsVolume').value = config.overlays.alerts.volume ?? 0.8;
    document.getElementById('alertsEnabled').checked = config.overlays.alerts.enabled !== false;

    document.getElementById('recentEventsLimit').value = config.overlays.recentEvents.limit ?? 10;
    document.getElementById('recentEventsShowTime').checked = config.overlays.recentEvents.showTime !== false;
    document.getElementById('recentEventsEnabled').checked = config.overlays.recentEvents.enabled !== false;

    document.getElementById('chatBoxMessageTimeout').value = config.overlays.chatBox.messageTimeout ?? 8;
    document.getElementById('chatBoxHideBot').checked = config.overlays.chatBox.hideBot === true;
    document.getElementById('chatBoxEnabled').checked = config.overlays.chatBox.enabled !== false;

    document.getElementById('goalBarType').value = config.overlays.goalBar.type || 'follow';
    document.getElementById('goalBarGoal').value = config.overlays.goalBar.goal ?? 1000;
    document.getElementById('goalBarEnabled').checked = config.overlays.goalBar.enabled !== false;

    updateOverlayUrls();
  } catch (error) {
    console.error('Failed to load OBS config:', error);
  }
}

function updateOverlayUrls() {
  const baseUrl = window.location.origin;

  // Helper to safely parse number and return undefined if NaN
  function parseNum(value, defaultValue = undefined) {
    const num = parseFloat(value);
    return Number.isFinite(num) ? num : defaultValue;
  }

  // Helper to safely parse integer and return undefined if NaN
  function parseIntSafe(value, defaultValue = undefined) {
    const num = parseInt(value);
    return Number.isFinite(num) ? num : defaultValue;
  }

  // Helper to build URL with query parameters (filters out undefined/null/NaN)
  function buildUrl(overlay, params) {
    const url = new URL(`${baseUrl}/obs/overlays/${overlay}.html`);
    Object.keys(params).forEach(key => {
      const value = params[key];
      if (value !== undefined && value !== null && value !== '' && !Number.isNaN(value)) {
        url.searchParams.set(key, value);
      }
    });
    return url.toString();
  }

  // Alerts overlay
  const alertsDuration = parseIntSafe(document.getElementById('alertsDuration')?.value);
  const alertsParams = {
    duration: alertsDuration ? alertsDuration * 1000 : undefined, // Convert seconds to ms
    volume: parseNum(document.getElementById('alertsVolume')?.value)
  };
  document.getElementById('alertsUrl').value = buildUrl('alerts', alertsParams);

  // Recent Events overlay
  const recentEventsParams = {
    limit: parseIntSafe(document.getElementById('recentEventsLimit')?.value),
    showTime: document.getElementById('recentEventsShowTime')?.checked
  };
  document.getElementById('recentEventsUrl').value = buildUrl('recent-events', recentEventsParams);

  // Chat Box overlay
  const chatBoxTimeout = parseIntSafe(document.getElementById('chatBoxMessageTimeout')?.value);
  const chatBoxParams = {
    timeout: chatBoxTimeout ? chatBoxTimeout * 1000 : undefined, // Convert to ms
    hideBot: document.getElementById('chatBoxHideBot')?.checked || undefined
  };
  document.getElementById('chatBoxUrl').value = buildUrl('chat-box', chatBoxParams);

  // Goal Bar overlay
  const goalBarParams = {
    goal: parseIntSafe(document.getElementById('goalBarGoal')?.value),
    type: document.getElementById('goalBarType')?.value
  };
  document.getElementById('goalBarUrl').value = buildUrl('goal-bar', goalBarParams);

  // TTS Display overlay
  const ttsDuration = parseIntSafe(document.getElementById('ttsDuration')?.value);
  const ttsParams = {
    voice: document.getElementById('ttsVoice')?.value || undefined,
    rate: parseNum(document.getElementById('ttsRate')?.value),
    pitch: parseNum(document.getElementById('ttsPitch')?.value),
    volume: parseNum(document.getElementById('ttsVolume')?.value),
    duration: ttsDuration ? ttsDuration * 1000 : undefined // Convert to ms
  };
  if (document.getElementById('ttsUrl')) {
    document.getElementById('ttsUrl').value = buildUrl('tts-display', ttsParams);
  }

  // Leaderboard overlay
  const leaderboardPoll = parseIntSafe(document.getElementById('leaderboardPoll')?.value);
  const leaderboardParams = {
    limit: parseIntSafe(document.getElementById('leaderboardLimit')?.value),
    poll: leaderboardPoll ? leaderboardPoll * 1000 : undefined, // Convert to ms
    title: document.getElementById('leaderboardTitle')?.value || undefined
  };
  if (document.getElementById('leaderboardUrl')) {
    document.getElementById('leaderboardUrl').value = buildUrl('leaderboard', leaderboardParams);
  }

  // Counter Display overlay
  const counterPoll = parseIntSafe(document.getElementById('counterPoll')?.value);
  const counterParams = {
    mode: document.getElementById('counterMode')?.value,
    counter: document.getElementById('counterName')?.value || undefined,
    poll: counterPoll ? counterPoll * 1000 : undefined // Convert to ms
  };
  if (document.getElementById('counterUrl')) {
    document.getElementById('counterUrl').value = buildUrl('counter-display', counterParams);
  }

  // Quote Display overlay
  const quoteInterval = parseIntSafe(document.getElementById('quoteInterval')?.value);
  const quoteDuration = parseIntSafe(document.getElementById('quoteDuration')?.value);
  const quoteParams = {
    mode: document.getElementById('quoteMode')?.value,
    rotate: document.getElementById('quoteRotate')?.checked || undefined,
    interval: quoteInterval ? quoteInterval * 1000 : undefined, // Convert to ms
    duration: quoteDuration ? quoteDuration * 1000 : undefined // Convert to ms
  };
  if (document.getElementById('quoteUrl')) {
    document.getElementById('quoteUrl').value = buildUrl('quote-display', quoteParams);
  }
}

async function updateOverlayConfig(overlay, setting, value) {
  try {
    const payload = {};

    // Validate numeric settings
    if (setting === 'volume') {
      const vol = parseFloat(value);
      if (isNaN(vol) || vol < 0 || vol > 1) {
        alert('Volume must be a number between 0 and 1');
        return;
      }
      payload[setting] = vol;
    } else if (setting === 'duration') {
      const dur = parseInt(value);
      if (isNaN(dur) || dur < 1) {
        alert('Duration must be a positive number');
        return;
      }
      payload[setting] = dur;
    } else if (setting === 'limit') {
      const limit = parseInt(value);
      if (isNaN(limit) || limit < 1) {
        alert('Max events must be a positive number');
        return;
      }
      payload[setting] = limit;
    } else if (setting === 'messageTimeout') {
      const timeout = parseInt(value);
      if (isNaN(timeout) || timeout < 1) {
        alert('Message timeout must be a positive number');
        return;
      }
      payload[setting] = timeout;
    } else if (setting === 'goal') {
      const goal = parseInt(value);
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
      const error = await res.json();
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

function copyToClipboard(elementId, button) {
  const element = document.getElementById(elementId);
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

function testOverlay(overlayName) {
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
          duration: parseInt(document.getElementById('ttsDuration')?.value || 5) * 1000
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
    .then(data => {
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
    .then(filters => {
      document.getElementById('filterUrls').checked = filters.filterUrls;
      document.getElementById('filterAllCaps').checked = filters.filterAllCaps;
      document.getElementById('filterRepeatChars').checked = filters.filterRepeatChars;
      document.getElementById('filterSpam').checked = filters.filterSpam;
      document.getElementById('filterAction').value = filters.filterAction;
      document.getElementById('timeoutDuration').value = filters.timeoutDurationSeconds;
      renderBlacklist(filters.blacklistWords);
    })
    .catch(err => console.error('Failed to load filters:', err));
}

function updateFilterSetting(setting, value) {
  const payload = {};
  
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
    .then(data => {
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
  const input = document.getElementById('newWord');
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
    .then(data => {
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

function removeFilterWord(word) {
  if (!confirm(`Remove "${word}" from filter?`)) return;
  
  fetch(`/api/filters/words/${encodeURIComponent(word)}`, {
    method: 'DELETE'
  })
    .then(res => res.json())
    .then(data => {
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

function renderBlacklist(words) {
  const container = document.getElementById('blacklistContainer');

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

let alertConfig = null;

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
  document.getElementById('globalEnabled').checked = global.enabled !== false;
  document.getElementById('globalVolume').value = global.defaultVolume ?? 0.8;
  document.getElementById('globalVolumeDisplay').textContent = global.defaultVolume ?? 0.8;
  document.getElementById('globalDuration').value = global.defaultDuration ?? 5;
  document.getElementById('globalDelay').value = global.defaultDelay ?? 1;
  document.getElementById('globalTtsEnabled').checked = global.ttsEnabled === true;
  document.getElementById('globalTtsVoice').value = global.ttsVoice || 'en-US';
  document.getElementById('globalTtsRate').value = global.ttsRate ?? 1;
  document.getElementById('globalTtsRateDisplay').textContent = global.ttsRate ?? 1;
  document.getElementById('globalTtsPitch').value = global.ttsPitch ?? 1;
  document.getElementById('globalTtsPitchDisplay').textContent = global.ttsPitch ?? 1;

  // Per-alert-type settings
  const alertTypes = ['follow', 'subscription', 'bits', 'raid', 'redemption', 'first_chatter'];
  alertTypes.forEach(type => {
    const config = types[type];
    if (!config) return;

    // Basic settings
    const enabledEl = document.getElementById(`${type}-enabled`);
    if (enabledEl) enabledEl.checked = config.enabled !== false;

    const durationEl = document.getElementById(`${type}-duration`);
    if (durationEl) durationEl.value = config.duration ?? 5;

    const volumeEl = document.getElementById(`${type}-volume`);
    if (volumeEl) {
      volumeEl.value = config.volume ?? 0.8;
      const displayEl = document.getElementById(`${type}-volume-display`);
      if (displayEl) displayEl.textContent = config.volume ?? 0.8;
    }

    const messageEl = document.getElementById(`${type}-messageTemplate`);
    if (messageEl) messageEl.value = config.messageTemplate || '';

    // Animation settings
    const enterEl = document.getElementById(`${type}-enterAnimation`);
    if (enterEl) enterEl.value = config.enterAnimation || 'bounceIn';

    const exitEl = document.getElementById(`${type}-exitAnimation`);
    if (exitEl) exitEl.value = config.exitAnimation || 'fadeOutUp';

    // Style settings
    const textColorEl = document.getElementById(`${type}-textColor`);
    if (textColorEl) textColorEl.value = config.textColor || '#ffffff';

    const borderColorEl = document.getElementById(`${type}-borderColor`);
    if (borderColorEl) borderColorEl.value = config.borderColor || '#9147ff';

    const fontSizeEl = document.getElementById(`${type}-fontSize`);
    if (fontSizeEl) fontSizeEl.value = config.fontSize ?? 28;

    // Media settings
    const soundEl = document.getElementById(`${type}-sound`);
    if (soundEl) {
      soundEl.value = config.sound || 'default';
      toggleCustomSoundInput(type, config.sound);
    }

    // Show media filenames if set
    if (config.image) {
      const imgNameEl = document.getElementById(`${type}-image-name`);
      if (imgNameEl) imgNameEl.textContent = config.image.split('/').pop();
      const imgClearEl = document.getElementById(`${type}-image-clear`);
      if (imgClearEl) imgClearEl.style.display = 'inline-block';
    }
    if (config.video) {
      const vidNameEl = document.getElementById(`${type}-video-name`);
      if (vidNameEl) vidNameEl.textContent = config.video.split('/').pop();
      const vidClearEl = document.getElementById(`${type}-video-clear`);
      if (vidClearEl) vidClearEl.style.display = 'inline-block';
    }
    if (config.customSound) {
      const sndNameEl = document.getElementById(`${type}-customSound-name`);
      if (sndNameEl) sndNameEl.textContent = config.customSound.split('/').pop();
    }

    // TTS settings
    const ttsEnabledEl = document.getElementById(`${type}-ttsEnabled`);
    if (ttsEnabledEl) ttsEnabledEl.checked = config.ttsEnabled === true;

    const ttsTemplateEl = document.getElementById(`${type}-ttsTemplate`);
    if (ttsTemplateEl) ttsTemplateEl.value = config.ttsTemplate || '';

    // Type-specific settings
    if (type === 'bits') {
      const minBitsEl = document.getElementById('bits-minBits');
      if (minBitsEl) minBitsEl.value = config.minBits || 1;
    }
    if (type === 'raid') {
      const minViewersEl = document.getElementById('raid-minViewers');
      if (minViewersEl) minViewersEl.value = config.minViewers || 2;
    }
  });
}

// Update alert type setting
async function updateAlertSetting(alertType, setting, value) {
  try {
    const res = await fetch(`/api/alerts/config/${alertType}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [setting]: value })
    });
    if (res.ok) {
      const result = await res.json();
      if (alertConfig) alertConfig.alertTypes[alertType] = result.config;
      console.log(`[AlertConfig] Updated ${alertType}.${setting}:`, value);

      // Update display elements for volume
      if (setting === 'volume') {
        const displayEl = document.getElementById(`${alertType}-volume-display`);
        if (displayEl) displayEl.textContent = value;
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
function updateGlobalSetting(setting, value) {
  if (!alertConfig) return;
  alertConfig.global[setting] = value;

  // Update display elements
  if (setting === 'defaultVolume') {
    document.getElementById('globalVolumeDisplay').textContent = value;
  } else if (setting === 'ttsRate') {
    document.getElementById('globalTtsRateDisplay').textContent = value;
  } else if (setting === 'ttsPitch') {
    document.getElementById('globalTtsPitchDisplay').textContent = value;
  }

  // Persist to server
  fetch('/api/alerts/config/global', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [setting]: value })
  }).catch(err => console.error('Failed to update global setting:', err));
}

// Show alert type config section
function showAlertTypeConfig(alertType, event) {
  document.querySelectorAll('.alert-type-config').forEach(el => {
    el.classList.remove('active');
  });

  document.querySelectorAll('.alert-tab').forEach(el => {
    el.classList.remove('active');
  });

  const configEl = document.getElementById(`${alertType}-config`);
  if (configEl) configEl.classList.add('active');

  if (event && event.currentTarget) {
    event.currentTarget.classList.add('active');
  }
}

// Toggle section collapse
function toggleSection(sectionId) {
  const section = document.getElementById(sectionId);
  const header = section.previousElementSibling;

  if (section.classList.contains('collapsed')) {
    section.classList.remove('collapsed');
    header.classList.remove('collapsed');
  } else {
    section.classList.add('collapsed');
    header.classList.add('collapsed');
  }
}

// Update variation settings
function updateVariation(alertType, variationKey, setting, value) {
  if (!alertConfig || !alertConfig.alertTypes[alertType]) return;

  if (!alertConfig.alertTypes[alertType].variations) {
    alertConfig.alertTypes[alertType].variations = {};
  }
  if (!alertConfig.alertTypes[alertType].variations[variationKey]) {
    alertConfig.alertTypes[alertType].variations[variationKey] = {};
  }

  alertConfig.alertTypes[alertType].variations[variationKey][setting] = value;

  fetch(`/api/alerts/config/${alertType}/variation/${variationKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [setting]: value })
  }).catch(err => console.error('Failed to update variation:', err));
}

// Upload media for alert
async function uploadAlertMedia(alertType, mediaType, inputEl) {
  const file = inputEl.files[0];
  if (!file) return;

  let endpoint;
  if (mediaType === 'image') endpoint = '/api/uploads/image';
  else if (mediaType === 'video') endpoint = '/api/uploads/video';
  else if (mediaType === 'customSound') endpoint = '/api/uploads/sound';
  else return;

  try {
    const reader = new FileReader();
    reader.onload = async function(e) {
      const base64Data = e.target.result;

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: base64Data, filename: file.name })
      });

      if (res.ok) {
        const result = await res.json();
        const settingName = mediaType === 'customSound' ? 'customSound' : mediaType;
        await updateAlertSetting(alertType, settingName, result.path);

        const nameEl = document.getElementById(`${alertType}-${mediaType}-name`);
        if (nameEl) nameEl.textContent = file.name;

        const clearEl = document.getElementById(`${alertType}-${mediaType}-clear`);
        if (clearEl) clearEl.style.display = 'inline-block';

        console.log(`[AlertConfig] Uploaded ${mediaType} for ${alertType}:`, result.path);
      } else {
        const error = await res.json();
        alert('Upload failed: ' + error.error);
      }
    };
    reader.readAsDataURL(file);
  } catch (error) {
    console.error('Upload error:', error);
    alert('Upload failed: ' + error.message);
  }
}

// Clear uploaded media
async function clearAlertMedia(alertType, mediaType) {
  await updateAlertSetting(alertType, mediaType, null);

  const nameEl = document.getElementById(`${alertType}-${mediaType}-name`);
  if (nameEl) nameEl.textContent = '';

  const clearEl = document.getElementById(`${alertType}-${mediaType}-clear`);
  if (clearEl) clearEl.style.display = 'none';
}

// Reset alert type to defaults
async function resetAlertType(alertType) {
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
  const alertType = document.getElementById('testAlertType').value;
  const user = document.getElementById('testAlertUser').value || 'TestUser';
  const message = document.getElementById('testAlertMessage').value || '';

  const testData = {
    alertType,
    user,
    message: message || undefined,
    useConfig: true
  };

  if (alertType === 'subscription') {
    testData.tier = document.getElementById('testAlertTier').value;
  } else if (alertType === 'bits') {
    testData.amount = parseInt(document.getElementById('testAlertBits').value) || 100;
  } else if (alertType === 'raid') {
    testData.viewers = parseInt(document.getElementById('testAlertViewers').value) || 50;
  } else if (alertType === 'redemption') {
    testData.reward = document.getElementById('testAlertReward').value || 'Test Reward';
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
function toggleCustomSoundInput(alertType, soundValue) {
  const groupEl = document.getElementById(`${alertType}-customSound-group`);
  if (groupEl) {
    groupEl.style.display = soundValue === 'custom' ? 'block' : 'none';
  }
}

// Test specific alert type
async function testAlertType(alertType) {
  const testData = {
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
  const alertType = document.getElementById('testAlertType').value;

  document.getElementById('testTierGroup').style.display = alertType === 'subscription' ? 'block' : 'none';
  document.getElementById('testBitsGroup').style.display = alertType === 'bits' ? 'block' : 'none';
  document.getElementById('testViewersGroup').style.display = alertType === 'raid' ? 'block' : 'none';
  document.getElementById('testRewardGroup').style.display = alertType === 'redemption' ? 'block' : 'none';
}

// Bot Settings
async function loadBotSettings() {
  try {
    const response = await fetch('/api/settings');
    const settings = await response.json();
    document.getElementById('commandRefreshInterval').value = settings.commandRefreshInterval;
  } catch (error) {
    console.error('Failed to load bot settings:', error);
  }
}

async function saveBotSettings() {
  const commandRefreshInterval = parseInt(document.getElementById('commandRefreshInterval').value);
  
  if (isNaN(commandRefreshInterval) || commandRefreshInterval < 5) {
    alert('Refresh interval must be at least 5 seconds');
    return;
  }

  try {
    const response = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commandRefreshInterval })
    });

    if (response.ok) {
      alert('Settings saved successfully');
    } else {
      const error = await response.json();
      alert(`Failed to save settings: ${error.error || 'Unknown error'}`);
    }
  } catch (error) {
    console.error('Failed to save bot settings:', error);
    alert('Failed to save settings');
  }
}

async function restartBot() {
  if (!confirm('Are you sure you want to restart the bot? It will take a few seconds to reconnect.')) {
    return;
  }

  try {
    const response = await fetch('/api/bot/restart', {
      method: 'POST'
    });

    if (response.ok) {
      alert('Restart signal sent to bot. The bot will exit and should be restarted by your process manager.');
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
