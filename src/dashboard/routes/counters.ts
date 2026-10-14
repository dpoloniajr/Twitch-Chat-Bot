/**
 * Dashboard API Routes for Counters System
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import * as path from 'path';
import { createJsonStore } from '../lib/utils';
import type { Counter, CounterHistoryEntry, CountersConfig } from '../../services/counters';
import type { BroadcastMessage } from '../lib/types';

/** Shape of counters.json (shared with the bot; any field may be missing) */
export interface CountersData {
  counters?: Record<string, Counter>;
  history?: CounterHistoryEntry[];
  config?: Partial<CountersConfig>;
  savedAt?: string;
  [key: string]: unknown;
}

/** Default value bounds when counters.json has none configured */
const DEFAULT_MIN_VALUE = -999999;
const DEFAULT_MAX_VALUE = 999999;

/** Clamp `value` into the configured [minValue, maxValue] (a configured 0 is a real bound) */
function clampToConfig(value: number, config: Partial<CountersConfig>): number {
  const min = typeof config.minValue === 'number' ? config.minValue : DEFAULT_MIN_VALUE;
  const max = typeof config.maxValue === 'number' ? config.maxValue : DEFAULT_MAX_VALUE;
  return Math.max(min, Math.min(max, value));
}

/**
 * Create the /api/counters router, storing counters in `<logsDir>/counters.json`.
 * After every successful write, `broadcast` (if given) receives a
 * 'counter-update' message whose data is the GET /api/counters list.
 */
export function createCountersRouter(logsDir: string, broadcast?: (message: BroadcastMessage) => void): Router {
  const router = Router();
  const countersFile = path.join(logsDir, 'counters.json');

  // Push the current counter list (same JSON as GET /) to the dashboard and overlays
  const publish = (data: CountersData): void => {
    broadcast?.({ type: 'counter-update', data: Object.values(data.counters || {}) });
  };

  // Counters data, created with default counters on first read
  const { read: readData, write: writeData, locked } = createJsonStore<CountersData>(countersFile, () => {
    const now = new Date().toISOString();
    const counter = (name: string, description: string): Counter => ({ name, value: 0, createdAt: now, createdBy: 'system', lastModifiedAt: now, lastModifiedBy: 'system', description });
    return {
      counters: {
        deaths: counter('deaths', 'Death counter'),
        wins: counter('wins', 'Win counter'),
        losses: counter('losses', 'Loss counter')
      },
      history: [],
      config: {
        maxCounters: 100,
        maxValue: 999999,
        minValue: -999999,
        keepHistory: true,
        maxHistoryEntries: 100
      }
    };
  });

  // GET /api/counters - Get all counters
  router.get('/', async (req, res, next) => {
    try {
      const data = await readData();
      const counters = Object.values(data.counters || {});
      res.json(counters);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/counters/config - Get config
  // (Registered before GET /:name, which would otherwise treat "config" as a counter name)
  router.get('/config', async (req, res, next) => {
    try {
      const data = await readData();
      res.json(data.config || {});
    } catch (error) {
      next(error);
    }
  });

  // GET /api/counters/:name - Get a specific counter
  router.get('/:name', async (req, res, next) => {
    try {
      const name = req.params.name as string;
      const normalizedName = name.toLowerCase().trim().replace(/\s+/g, '_');
      const data = await readData();
      const counter = data.counters?.[normalizedName];

      if (!counter) {
        res.status(404).json({ error: 'Counter not found' });
        return;
      }

      res.json(counter);
    } catch (error) {
      next(error);
    }
  });

  // POST /api/counters - Create a new counter
  router.post('/', locked(async (req, res, next) => {
    try {
      const { name, initialValue = 0, description, createdBy = 'dashboard' } = req.body;

      if (!name) {
        res.status(400).json({ error: 'Name is required' });
        return;
      }

      const normalizedName = (name as string).toLowerCase().trim().replace(/\s+/g, '_');
      const startValue = Number(initialValue);

      if (initialValue === null || initialValue === '' || typeof initialValue === 'boolean' || !Number.isFinite(startValue)) {
        res.status(400).json({ error: 'initialValue must be a number' });
        return;
      }

      if (normalizedName.length < 1 || normalizedName.length > 50) {
        res.status(400).json({ error: 'Counter name must be 1-50 characters' });
        return;
      }

      // GET /config serves the counters config, so no counter can be read under that name
      if (normalizedName === 'config') {
        res.status(400).json({ error: 'Counter name "config" is reserved' });
        return;
      }

      const data = await readData();
      const config = data.config || {};

      if (data.counters?.[normalizedName]) {
        res.status(400).json({ error: `Counter "${normalizedName}" already exists` });
        return;
      }

      const counterCount = Object.keys(data.counters || {}).length;
      if (counterCount >= (config.maxCounters || 100)) {
        res.status(400).json({ error: 'Maximum counter limit reached' });
        return;
      }

      const clampedValue = clampToConfig(startValue, config);

      const counter: Counter = {
        name: normalizedName,
        value: clampedValue,
        createdAt: new Date().toISOString(),
        createdBy: createdBy.toLowerCase(),
        lastModifiedAt: new Date().toISOString(),
        lastModifiedBy: createdBy.toLowerCase(),
        description: description || undefined
      };

      if (!data.counters) data.counters = {};
      data.counters[normalizedName] = counter;

      await writeData(data);
      publish(data);
      res.status(201).json({ success: true, counter });
    } catch (error) {
      next(error);
    }
  }));

  /**
   * Shared by PUT, increment, decrement and reset: set a counter to the value
   * computeValue(currentValue) returns, clamp it and record history.
   * Runs inside the route's file lock, so the read and write are one step.
   */
  const updateCounterValue = async (
    req: Request,
    res: Response,
    computeValue: (current: number) => number,
    defaultReason: string | undefined
  ): Promise<void> => {
    const { modifiedBy = 'dashboard', reason } = req.body || {};
    const normalizedName = (req.params.name as string).toLowerCase().trim().replace(/\s+/g, '_');

    const data = await readData();
    const counter = data.counters?.[normalizedName];

    if (!counter) {
      res.status(404).json({ error: 'Counter not found' });
      return;
    }

    const config = data.config || {};
    const previousValue = counter.value;
    const clampedValue = clampToConfig(computeValue(previousValue), config);

    counter.value = clampedValue;
    counter.lastModifiedAt = new Date().toISOString();
    counter.lastModifiedBy = modifiedBy.toLowerCase();

    // Record history
    if (config.keepHistory !== false) {
      if (!data.history) data.history = [];
      data.history.push({
        counterName: normalizedName,
        previousValue,
        newValue: clampedValue,
        change: clampedValue - previousValue,
        modifiedBy: modifiedBy.toLowerCase(),
        timestamp: new Date().toISOString(),
        reason: reason || defaultReason
      });

      // Trim history
      const maxHistory = (config.maxHistoryEntries || 100) * Object.keys(data.counters!).length;
      if (data.history.length > maxHistory * 2) {
        data.history = data.history.slice(-maxHistory);
      }
    }

    await writeData(data);
    publish(data);
    res.json({ success: true, counter });
  };

  // Validates the optional `amount` for increment/decrement (default 1)
  const readAmount = (req: Request, res: Response): number | null => {
    const { amount = 1 } = req.body || {};
    if (typeof amount !== 'number' || !Number.isFinite(amount)) {
      res.status(400).json({ error: 'Amount must be a number' });
      return null;
    }
    return amount;
  };

  // PUT /api/counters/:name - Update counter value
  router.put('/:name', locked(async (req, res, next) => {
    try {
      const { value } = req.body || {};

      if (typeof value !== 'number') {
        res.status(400).json({ error: 'Value must be a number' });
        return;
      }

      await updateCounterValue(req, res, () => value, undefined);
    } catch (error) {
      next(error);
    }
  }));

  // POST /api/counters/:name/increment - Increment counter
  router.post('/:name/increment', locked(async (req, res, next) => {
    try {
      const amount = readAmount(req, res);
      if (amount === null) return;

      await updateCounterValue(req, res, (current) => current + amount, `+${amount}`);
    } catch (error) {
      next(error);
    }
  }));

  // POST /api/counters/:name/decrement - Decrement counter
  router.post('/:name/decrement', locked(async (req, res, next) => {
    try {
      const amount = readAmount(req, res);
      if (amount === null) return;

      await updateCounterValue(req, res, (current) => current - amount, `-${amount}`);
    } catch (error) {
      next(error);
    }
  }));

  // POST /api/counters/:name/reset - Reset counter to zero
  router.post('/:name/reset', locked(async (req, res, next) => {
    try {
      await updateCounterValue(req, res, () => 0, 'Reset');
    } catch (error) {
      next(error);
    }
  }));

  // DELETE /api/counters/:name - Delete a counter
  router.delete('/:name', locked(async (req, res, next) => {
    try {
      const name = req.params.name as string;
      const normalizedName = name.toLowerCase().trim().replace(/\s+/g, '_');

      const data = await readData();

      if (!data.counters?.[normalizedName]) {
        res.status(404).json({ error: 'Counter not found' });
        return;
      }

      delete data.counters[normalizedName];

      // Remove history for this counter
      if (data.history) {
        data.history = data.history.filter(h => h.counterName !== normalizedName);
      }

      await writeData(data);
      publish(data);
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }));

  // GET /api/counters/:name/history - Get counter history
  router.get('/:name/history', async (req, res, next) => {
    try {
      const name = req.params.name as string;
      const limit = parseInt(req.query.limit as string) || 20;
      const normalizedName = name.toLowerCase().trim().replace(/\s+/g, '_');

      const data = await readData();
      const history = (data.history || [])
        .filter(h => h.counterName === normalizedName)
        .slice(-limit)
        .reverse();

      res.json(history);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
