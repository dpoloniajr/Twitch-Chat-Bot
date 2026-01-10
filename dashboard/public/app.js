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
  commandCountEl.textContent = botState.commandsExecuted || 0;

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
        <div class="command-name">${cmd.name}</div>
        <div class="command-desc">${cmd.description}</div>
      </div>
    `).join('');
  }

  // Render custom commands if present
  if (botState.customCommands) {
    renderCustomCommands();
  }
}

// Page navigation
function showPage(pageId) {
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
  event.target.classList.add('active');
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
        <td>${log.user}</td>
        <td><code>${log.command}</code></td>
        <td>${log.channel}</td>
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
  return str
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
        <td><strong>${username}</strong></td>
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
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(cmd => `
      <tr>
        <td>${cmd.name}</td>
        <td>${cmd.response || ''}</td>
        <td>${cmd.level}</td>
        <td>${cmd.fetchEnabled ? 'Yes' : 'No'}</td>
        <td>${cmd.cooldownSeconds || 0}s</td>
        <td>
          <button class="btn btn-secondary" onclick="prefillCommand('${cmd.name.replace(/'/g, "\\'")}')">Edit</button>
          <button class="btn btn-danger" onclick="deleteCommand('${cmd.name.replace(/'/g, "\\'")}')">Delete</button>
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
   document.getElementById('ccCooldown').value = cmd.cooldownSeconds || 0;
}

async function deleteCommand(name) {
  if (!confirm(`Delete ${name}?`)) return;
  await fetch(`/api/custom-commands/${encodeURIComponent(name)}`, { method: 'DELETE' });
  loadCustomCommands();
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
});
