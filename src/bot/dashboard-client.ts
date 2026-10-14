/**
 * Fire-and-forget calls the bot makes to the dashboard API (command log,
 * OBS alerts, EventSub event log, bot state).
 */

import type { BotContext } from './context';

export interface DashboardClient {
  logCommandExecution: (username: string, command: string, args: unknown, success: boolean | string) => void;
  sendAlert: (alertType: string, alertData: Record<string, unknown>) => void;
  logEventSubEvent: (eventType: string, eventData: Record<string, unknown>) => void;
  updateDashboard: () => Promise<void>;
}

export function createDashboardClient(ctx: BotContext): DashboardClient {
  const { http, dashboardBaseUrl } = ctx;

  // Log command execution to dashboard
  function logCommandExecution(username: string, command: string, args: unknown, success: boolean | string): void {
    http.post(`${dashboardBaseUrl}/api/logs`, {
      timestamp: new Date().toISOString(),
      user: username,
      command,
      args: Array.isArray(args) ? args.join(' ') : '',
      success: success === true || success === 'success'
    }).catch((err: Error) => {
      console.error('[Logging] Failed to post command log:', err.message);
    });
  }

  // Send alert to OBS overlays via dashboard WebSocket
  function sendAlert(alertType: string, alertData: Record<string, unknown>): void {
    http.post(`${dashboardBaseUrl}/api/test-alert`, {
      alertType,
      ...alertData
    }).catch((err: Error) => {
      console.error('[Alert] Failed to send alert:', err.message);
    });
  }

  // Log EventSub event to dashboard
  function logEventSubEvent(eventType: string, eventData: Record<string, unknown>): void {
    http.post(`${dashboardBaseUrl}/api/eventsub-events`, {
      type: eventType,
      ...eventData
    }).catch((err: Error) => {
      console.error('[EventSub] Failed to log event:', err.message);
    });
  }

  // Update dashboard with bot state
  async function updateDashboard(): Promise<void> {
    try {
      await http.post(`${dashboardBaseUrl}/api/update-state`, {
        isConnected: true,
        channels: ctx.config.channels,
        broadcasterName: ctx.config.broadcasterName,
        uptime: Date.now() - ctx.state.botStartTime,
        scopes: ctx.config.scopes,
        commands: [
          { name: '!clip', description: 'Create a clip of the stream' },
          { name: '!followage [username]', description: 'Check how long someone has been following' },
          { name: '!8ball <question>', description: 'Ask the magic 8ball a yes/no question' },
          { name: '!dice [sides]', description: 'Roll a die (default 6, e.g. !dice 20 for d20)' },
          { name: '!coinflip', description: 'Flip a coin — heads or tails' },
          { name: '!shoutout [username] / !so [username]', description: 'Shout out another streamer (mods only)' },
          { name: '!poll', description: 'Manage channel polls' },
          { name: '!prediction', description: 'Manage channel predictions' },
          { name: '!title "new title"', description: 'Update stream title (mods/broadcaster)' },
          { name: '!game <name>', description: 'Update stream game/category (mods/broadcaster)' },
          { name: '!commands', description: 'Show available commands' }
        ]
      });
    } catch (error) {
      // Dashboard may not be running, silently fail
    }
  }

  return { logCommandExecution, sendAlert, logEventSubEvent, updateDashboard };
}
