/**
 * Polls and predictions: !poll start/end and !prediction start/resolve.
 * Both call Helix with the broadcaster token.
 */

import * as featureScopes from '../lib/feature-scopes';
import type { TwitchHelixAPI } from '../lib/twitch-helix-api';
import { getBroadcasterScopes } from './auth';
import type { BotContext, HttpError } from './context';
import type { DashboardClient } from './dashboard-client';

/** Handlers resolve to true on success, which is when the command's cooldown starts */
export interface PollCommands {
  handlePoll: (channel: string, username: string, args: string[]) => Promise<boolean>;
  handlePrediction: (channel: string, username: string, args: string[]) => Promise<boolean>;
}

export function createPollCommands(ctx: BotContext, dashboard: DashboardClient): PollCommands {
  const { state, sendChatMessage } = ctx;
  const { logCommandExecution } = dashboard;

  /**
   * Helix client for the broadcaster token, falling back to the bot token (single-account setup).
   * It sends only Twitch headers, never the dashboard secret that ctx.http carries.
   */
  function broadcasterApi(): TwitchHelixAPI {
    return state.broadcasterApiClient || ctx.apiClient;
  }

  /** Report a failed poll/prediction call in chat and the command log */
  function reportFailure(channel: string, username: string, label: string, command: string, args: string[], message: string): false {
    sendChatMessage(channel, `@${username} ${label} error: ${message}`);
    logCommandExecution(username, command, args, 'failed');
    return false;
  }

  async function handlePoll(channel: string, username: string, args: string[]): Promise<boolean> {
    try {
      if (!args[0]) {
        sendChatMessage(channel, `@${username} Usage: !poll start "Title" option1;option2;... [duration]`);
        return false;
      }

      const action = args[0].toLowerCase();

      if (action === 'start') {
        // Parse: !poll start "Title" opt1;opt2;opt3 [duration]
        const rawMessage = args.slice(1).join(' ');
        const titleMatch = rawMessage.match(/^"([^"]+)"/);
        if (!titleMatch) {
          sendChatMessage(channel, `@${username} Poll title must be quoted: "Your Title"`);
          return false;
        }

        const title = titleMatch[1];
        const rest = rawMessage.substring(titleMatch[0].length).trim();
        const parts = rest.split(/\s+/);
        const optionsStr = parts[0];
        const durationStr = parts[1];

        if (!optionsStr) {
          sendChatMessage(channel, `@${username} Provide options: option1;option2;...`);
          return false;
        }

        const options = optionsStr.split(';').map(o => o.trim()).filter(Boolean);
        if (options.length < 2 || options.length > 5) {
          sendChatMessage(channel, `@${username} Polls require 2-5 options.`);
          return false;
        }

        const parsedDuration = parseInt(durationStr, 10);
        const duration = Math.max(15, Math.min(1800,
          Number.isFinite(parsedDuration) ? parsedDuration : 300
        )); // 15s-30m, default 5m

        // Check scope against the broadcaster token's scopes (the token used for this call)
        if (!featureScopes.hasRequiredScopes('polls', getBroadcasterScopes(ctx), 'broadcaster')) {
          sendChatMessage(channel, `@${username} Missing scope: channel:manage:polls`);
          return false;
        }

        if (!state.initComplete || !state.broadcasterId) {
          sendChatMessage(channel, `@${username} Bot not initialized yet.`);
          return false;
        }

        // Create poll via Helix API (requires broadcaster token)
        const pollRes = await broadcasterApi().createPoll({
          broadcaster_id: state.broadcasterId,
          title,
          choices: options.map(o => ({ title: o })),
          duration,
          channel_points_voting: { is_enabled: false }
        });
        if (!pollRes.success) {
          return reportFailure(channel, username, 'Poll', '!poll', args, pollRes.error);
        }

        const poll = pollRes.poll;
        if (!poll) {
          sendChatMessage(channel, `@${username} Failed to create poll.`);
          logCommandExecution(username, '!poll start', [title], 'failed');
          return false;
        }

        sendChatMessage(channel, `✓ Poll started: "${title}" (${duration}s) - Vote with reactions!`);
        logCommandExecution(username, '!poll start', [title, ...options], 'success');
        return true;
      } else if (action === 'end') {
        // Parse: !poll end <pollId>
        const pollId = args[1];
        if (!pollId) {
          sendChatMessage(channel, `@${username} Usage: !poll end <poll_id>`);
          return false;
        }

        if (!featureScopes.hasRequiredScopes('polls', getBroadcasterScopes(ctx), 'broadcaster')) {
          sendChatMessage(channel, `@${username} Missing scope: channel:manage:polls`);
          return false;
        }

        if (!state.initComplete || !state.broadcasterId) {
          sendChatMessage(channel, `@${username} Bot not initialized yet.`);
          return false;
        }

        // End poll via Helix API (requires broadcaster token)
        const endRes = await broadcasterApi().endPoll(state.broadcasterId, pollId, 'TERMINATED');
        if (!endRes.success) {
          return reportFailure(channel, username, 'Poll', '!poll', args, endRes.error);
        }

        sendChatMessage(channel, `✓ Poll ended.`);
        logCommandExecution(username, '!poll end', [pollId], 'success');
        return true;
      } else {
        sendChatMessage(channel, `@${username} Usage: !poll start "Title" options [duration] or !poll end <id>`);
        return false;
      }
    } catch (e) {
      const error = e as HttpError;
      console.error('Poll command error:', error.message);
      return reportFailure(channel, username, 'Poll', '!poll', args, error?.response?.data?.message || error.message);
    }
  }

  async function handlePrediction(channel: string, username: string, args: string[]): Promise<boolean> {
    try {
      if (!args[0]) {
        sendChatMessage(channel, `@${username} Usage: !prediction start "Title" outcome1;outcome2 [duration]`);
        return false;
      }

      const action = args[0].toLowerCase();

      if (action === 'start') {
        // Parse: !prediction start "Title" outcome1;outcome2 [duration]
        const rawMessage = args.slice(1).join(' ');
        const titleMatch = rawMessage.match(/^"([^"]+)"/);
        if (!titleMatch) {
          sendChatMessage(channel, `@${username} Prediction title must be quoted: "Your Title"`);
          return false;
        }

        const title = titleMatch[1];
        const rest = rawMessage.substring(titleMatch[0].length).trim();
        const parts = rest.split(/\s+/);
        const outcomesStr = parts[0];
        const durationStr = parts[1];

        if (!outcomesStr) {
          sendChatMessage(channel, `@${username} Provide outcomes: outcome1;outcome2`);
          return false;
        }

        const outcomes = outcomesStr.split(';').map(o => o.trim()).filter(Boolean);
        if (outcomes.length !== 2) {
          sendChatMessage(channel, `@${username} Predictions require exactly 2 outcomes.`);
          return false;
        }

        const parsedDuration = parseInt(durationStr, 10);
        const duration = Math.max(60, Math.min(1800,
          Number.isFinite(parsedDuration) ? parsedDuration : 300
        )); // 1m-30m, default 5m

        // Check scope against the broadcaster token's scopes (the token used for this call)
        if (!featureScopes.hasRequiredScopes('predictions', getBroadcasterScopes(ctx), 'broadcaster')) {
          sendChatMessage(channel, `@${username} Missing scope: channel:manage:predictions`);
          return false;
        }

        if (!state.initComplete || !state.broadcasterId) {
          sendChatMessage(channel, `@${username} Bot not initialized yet.`);
          return false;
        }

        // Create prediction via Helix API (requires broadcaster token)
        const predRes = await broadcasterApi().createPrediction({
          broadcaster_id: state.broadcasterId,
          title,
          outcomes: outcomes.map(o => ({ title: o })),
          prediction_window: duration
        });
        if (!predRes.success) {
          return reportFailure(channel, username, 'Prediction', '!prediction', args, predRes.error);
        }

        const pred = predRes.prediction;
        if (!pred) {
          sendChatMessage(channel, `@${username} Failed to create prediction.`);
          logCommandExecution(username, '!prediction start', [title], 'failed');
          return false;
        }

        sendChatMessage(channel, `✓ Prediction started: "${title}" (${duration}s) - Viewers can place points!`);
        logCommandExecution(username, '!prediction start', [title, ...outcomes], 'success');
        return true;
      } else if (action === 'resolve') {
        // Parse: !prediction resolve <predId> <winning_outcome_id>
        const predId = args[1];
        const winningId = args[2];

        if (!predId || !winningId) {
          sendChatMessage(channel, `@${username} Usage: !prediction resolve <id> <outcome_id>`);
          return false;
        }

        if (!featureScopes.hasRequiredScopes('predictions', getBroadcasterScopes(ctx), 'broadcaster')) {
          sendChatMessage(channel, `@${username} Missing scope: channel:manage:predictions`);
          return false;
        }

        if (!state.initComplete || !state.broadcasterId) {
          sendChatMessage(channel, `@${username} Bot not initialized yet.`);
          return false;
        }

        // Resolve prediction via Helix API (requires broadcaster token)
        const resolveRes = await broadcasterApi().resolvePrediction(state.broadcasterId, predId, 'RESOLVED', winningId);
        if (!resolveRes.success) {
          return reportFailure(channel, username, 'Prediction', '!prediction', args, resolveRes.error);
        }

        sendChatMessage(channel, `✓ Prediction resolved.`);
        logCommandExecution(username, '!prediction resolve', [predId, winningId], 'success');
        return true;
      } else {
        sendChatMessage(channel, `@${username} Usage: !prediction start "Title" outcome1;outcome2 [duration] or !prediction resolve <id> <outcome_id>`);
        return false;
      }
    } catch (e) {
      const error = e as HttpError;
      console.error('Prediction command error:', error.message);
      return reportFailure(channel, username, 'Prediction', '!prediction', args, error?.response?.data?.message || error.message);
    }
  }

  return { handlePoll, handlePrediction };
}
