const WebSocket = require('ws');

let wss = null;

let botState = {
  isConnected: false,
  channels: [],
  broadcasterName: '',
  uptime: 0,
  commandsExecuted: 0,
  lastCommand: null,
  commands: [
    { name: '!clip', description: 'Create a clip of the stream' },
    { name: '!followage [username]', description: 'Check how long someone has been following' },
    { name: '!shoutout [username]', description: 'Shout out another streamer (mods only)' },
    { name: '!commands', description: 'Show available commands' }
  ]
};

let chatFilters = {
  blacklistWords: [],
  filterUrls: false,
  filterAllCaps: false,
  filterRepeatChars: false,
  filterSpam: false,
  timeoutDurationSeconds: 60,
  filterAction: 'warn'
};

function init(webSocketServer) {
  wss = webSocketServer;
}

function broadcastState(data) {
  if (!wss) return;
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

function updateBotState(updates) {
  botState = { ...botState, ...updates };
  broadcastState({ type: 'state', data: botState });
  return botState;
}

function updateChatFilters(updates) {
  chatFilters = { ...chatFilters, ...updates };
  broadcastState({ type: 'filters', data: chatFilters });
  return chatFilters;
}

function getBotState() {
  return botState;
}

function getChatFilters() {
  return chatFilters;
}

module.exports = {
  init,
  broadcastState,
  updateBotState,
  updateChatFilters,
  getBotState,
  getChatFilters
};
