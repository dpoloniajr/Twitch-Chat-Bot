/**
 * OBS routes (mounted at /obs): overlay configuration and the recent-events
 * feed the overlays poll.
 */

import { Router } from 'express';
import type { Response } from 'express';
import { promises as fs } from 'fs';
import { withFileLock, asyncHandler, validateRequest, ValidationError } from '../lib/utils';
import * as state from '../lib/state';

/** Data files the OBS routes read and write */
export interface ObsPaths {
  obsConfigFile: string;
  eventSubEventsFile: string;
  [key: string]: string;
}

/** An entry in eventsub-events.json (bot-written, so every field is optional) */
interface StoredEvent {
  event?: string;
  alertType?: string;
  user?: string;
  userName?: string;
  username?: string;
  timestamp?: string;
  [key: string]: unknown;
}

/**
 * Create the /obs router. Each call returns a new router bound to `paths`.
 */
export function createObsRouter(paths: ObsPaths): Router {
  const router = Router();
  const { obsConfigFile, eventSubEventsFile } = paths;

  // Respond with the 50 newest events of `eventType` ('all' or a typeMap key)
  const recentEvents = async (res: Response, eventType: string): Promise<void> => {
    const finalEventType = eventType.toLowerCase();

    const typeMap: Record<string, string> = {
      follow: 'follow',
      subscriber: 'subscription',
      subscription: 'subscription',
      bits: 'bits',
      cheer: 'bits',
      raid: 'raid',
      redemption: 'redemption'
    };

    // Validate the type before reading the file ('all' means no filter)
    const targetType = finalEventType === 'all' ? null : Object.prototype.hasOwnProperty.call(typeMap, finalEventType) ? typeMap[finalEventType] : undefined;
    if (targetType === undefined) {
      throw new ValidationError('Invalid event type');
    }

    const events: StoredEvent[] = JSON.parse(await fs.readFile(eventSubEventsFile, 'utf8'));
    let filtered = events;
    if (targetType) {
      filtered = events.filter(e => {
        const eType = e.event || e.alertType;
        return targetType === 'subscription' ? (eType === 'subscription' || eType === 'subscriber') : eType === targetType;
      });
    }

    filtered = filtered.reverse().slice(0, 50);
    const recent = filtered.map(e => ({
      type: e.event || e.alertType,
      user: e.user || e.userName || e.username,
      timestamp: e.timestamp,
      ...e
    }));

    res.json({ type: finalEventType, count: recent.length, events: recent });
  };

  router.get('/config', asyncHandler(async (req, res) => {
    const data = await fs.readFile(obsConfigFile, 'utf8');
    res.json(JSON.parse(data));
  }));

  router.post('/config', validateRequest({
    overlays: { required: true, type: 'object' }
  }), asyncHandler(async (req, res) => {
    const config = req.body;

    await withFileLock(obsConfigFile, async () => {
      await fs.writeFile(obsConfigFile, JSON.stringify(config, null, 2));
    });
    state.broadcastState({ type: 'obsConfig', data: config });
    res.json({ success: true, config });
  }));

  router.get('/recent', asyncHandler((req, res) => recentEvents(res, 'all')));
  router.get('/recent/:type', asyncHandler((req, res) => recentEvents(res, req.params.type as string)));

  return router;
}
