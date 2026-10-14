/**
 * Tests for src/lib/tts-redemption-queue.ts. The original scenarios are in
 * tests/regression/tts-redemption-queue.test.ts.
 */

import { createRedemptionTTSQueue, RedemptionQueueOptions } from '../../src/lib/tts-redemption-queue';

type Item = { id: string } | null | 0 | '';

function make(overrides: Partial<RedemptionQueueOptions<Item>> = {}) {
  const processed: Item[] = [];
  const sleeps: number[] = [];
  const logger = { error: jest.fn() };
  const queue = createRedemptionTTSQueue<Item>({
    getCooldownRemainingMs: () => 0,
    processRedemption: async (item) => { processed.push(item); },
    sleep: async (ms) => { sleeps.push(ms); },
    logger,
    ...overrides
  });
  return { queue, processed, sleeps, logger };
}

describe('createRedemptionTTSQueue', () => {
  describe('options', () => {
    const ok = { getCooldownRemainingMs: () => 0, processRedemption: () => undefined };

    it('requires the two callbacks', () => {
      expect(() => createRedemptionTTSQueue({ ...ok, getCooldownRemainingMs: undefined as never }))
        .toThrow('getCooldownRemainingMs must be a function');
      expect(() => createRedemptionTTSQueue({ ...ok, processRedemption: 'x' as never }))
        .toThrow('processRedemption must be a function');
    });

    it.each([0, -1, NaN, Infinity])('rejects maxSize %p', (maxSize) => {
      expect(() => createRedemptionTTSQueue({ ...ok, maxSize })).toThrow('maxSize must be a positive number');
    });

    it('accepts a fractional maxSize of at least 1', () => {
      const q = createRedemptionTTSQueue({ ...ok, maxSize: 1.5, sleep: async () => {} });
      expect(q.enqueue('a').accepted).toBe(true);
    });
  });

  it('processes items in order, one at a time', async () => {
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const { queue } = make({
      processRedemption: async (item) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 1));
        order.push((item as { id: string }).id);
        active -= 1;
      }
    });
    ['a', 'b', 'c'].forEach((id) => queue.enqueue({ id }));
    await queue.waitForIdle();
    expect(order).toEqual(['a', 'b', 'c']);
    expect(maxActive).toBe(1);
    expect(queue.size()).toBe(0);
  });

  it('reports the size including the item being processed', () => {
    const { queue } = make({ processRedemption: () => new Promise(() => {}) });
    expect(queue.enqueue({ id: 'a' })).toEqual({ accepted: true, size: 1 });
    expect(queue.enqueue({ id: 'b' })).toEqual({ accepted: true, size: 2 });
    expect(queue.size()).toBe(2);
  });

  it('refuses items once full, counting the one in progress', () => {
    const { queue } = make({ maxSize: 2, processRedemption: () => new Promise(() => {}) });
    queue.enqueue({ id: 'a' });
    queue.enqueue({ id: 'b' });
    expect(queue.enqueue({ id: 'c' })).toEqual({ accepted: false, size: 2, reason: 'full' });
  });

  it('waits out the cooldown before each item and ignores non-numeric or negative values', async () => {
    const values: unknown[] = [1500, -5, 'abc', '250'];
    const { queue, sleeps } = make({ getCooldownRemainingMs: () => values.shift() as number });
    ['a', 'b', 'c', 'd'].forEach((id) => queue.enqueue({ id }));
    await queue.waitForIdle();
    expect(sleeps).toEqual([1500, 250]);
  });

  it('logs a failed item and moves on to the next', async () => {
    const { queue, processed, logger } = make({
      processRedemption: async (item) => {
        if ((item as { id: string }).id === 'bad') throw new Error('tts down');
        processed.push(item);
      }
    });
    queue.enqueue({ id: 'bad' });
    queue.enqueue({ id: 'good' });
    await queue.waitForIdle();
    expect(processed).toEqual([{ id: 'good' }]);
    expect(logger.error).toHaveBeenCalledWith('[TTS-Queue] Failed to process redemption:', 'tts down');
  });

  it('logs non-Error throws as they are', async () => {
    const { queue, logger } = make({ processRedemption: () => { throw 'plain'; } });
    queue.enqueue({ id: 'a' });
    await queue.waitForIdle();
    expect(logger.error).toHaveBeenCalledWith('[TTS-Queue] Failed to process redemption:', 'plain');
  });

  it('retries a deferred item after another cooldown wait', async () => {
    let attempts = 0;
    const waits = [0, 3000, 0];
    const { queue, sleeps } = make({
      getCooldownRemainingMs: () => waits.shift() ?? 0,
      processRedemption: async () => (++attempts === 1 ? 'defer' : undefined)
    });
    queue.enqueue({ id: 'a' });
    await queue.waitForIdle();
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([3000]);
  });

  // Changed in the migration: the JS version skipped falsy items with `continue`
  // without removing them, which spun forever and froze the bot.
  it.each([null, 0, ''])('processes a falsy item (%p) instead of spinning', async (item) => {
    const { queue, processed } = make();
    queue.enqueue(item as Item);
    queue.enqueue({ id: 'after' });
    await queue.waitForIdle();
    expect(processed).toEqual([item, { id: 'after' }]);
  });

  it('resolves waitForIdle immediately when idle and for every waiter when drained', async () => {
    const { queue } = make();
    await expect(queue.waitForIdle()).resolves.toBeUndefined();

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const q2 = make({ processRedemption: () => gate }).queue;
    q2.enqueue({ id: 'a' });
    const done = jest.fn();
    q2.waitForIdle().then(done);
    q2.waitForIdle().then(done);
    await new Promise(setImmediate);
    expect(done).not.toHaveBeenCalled();
    release();
    await q2.waitForIdle();
    expect(done).toHaveBeenCalledTimes(2);
  });

  it('picks up items added while it was finishing', async () => {
    const { queue, processed } = make({
      processRedemption: async (item) => {
        processed.push(item);
        if ((item as { id: string }).id === 'a') queue.enqueue({ id: 'b' });
      }
    });
    queue.enqueue({ id: 'a' });
    await queue.waitForIdle();
    expect(processed).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('uses a real timer for the cooldown by default', async () => {
    jest.useFakeTimers();
    try {
      const processed: string[] = [];
      let first = true;
      const queue = createRedemptionTTSQueue<string>({
        getCooldownRemainingMs: () => (first ? ((first = false), 1000) : 0),
        processRedemption: (item) => { processed.push(item); }
      });
      queue.enqueue('a');
      await jest.advanceTimersByTimeAsync(999);
      expect(processed).toEqual([]);
      await jest.advanceTimersByTimeAsync(1);
      expect(processed).toEqual(['a']);
    } finally {
      jest.useRealTimers();
    }
  });
});
