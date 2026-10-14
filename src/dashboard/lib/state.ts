/**
 * In-memory dashboard state (bot status and chat filter settings) and the
 * WebSocket broadcast that pushes updates to every connected dashboard page.
 * Module-level singleton: one dashboard per process.
 */

import WebSocket from 'ws';
import type { BroadcastMessage, DashboardBotState, DashboardChatFilters } from './types';

let wss: WebSocket.Server | null = null;

let botState: DashboardBotState = {
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

let chatFilters: DashboardChatFilters = {
  blacklistWords: [],
  filterUrls: false,
  filterAllCaps: false,
  filterRepeatChars: false,
  filterSpam: false,
  timeoutDurationSeconds: 60,
  filterAction: 'warn'
};

export function init(webSocketServer: WebSocket.Server): void {
  wss = webSocketServer;
}

export function broadcastState(data: BroadcastMessage): void {
  if (!wss) return;
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

export function updateBotState(updates: Partial<DashboardBotState>): DashboardBotState {
  botState = { ...botState, ...updates };
  broadcastState({ type: 'state', data: botState });
  return botState;
}

export function updateChatFilters(updates: Partial<DashboardChatFilters>): DashboardChatFilters {
  chatFilters = { ...chatFilters, ...updates };
  broadcastState({ type: 'filters', data: chatFilters });
  return chatFilters;
}

export function getBotState(): DashboardBotState {
  return botState;
}

export function getChatFilters(): DashboardChatFilters {
  return chatFilters;
}
