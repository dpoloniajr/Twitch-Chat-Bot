/**
 * Queue for channel point TTS redemptions. Items are processed one at a time,
 * waiting out the global TTS cooldown before each, so redemptions made during
 * a cooldown are delayed instead of dropped.
 */

/** Return 'defer' to keep the item at the head of the queue and try it again after the cooldown */
export type RedemptionResult = 'defer' | void | unknown;

export interface RedemptionQueueOptions<T> {
  /** Milliseconds until the next item may play (0 or less means now) */
  getCooldownRemainingMs: () => number;
  processRedemption: (item: T) => Promise<RedemptionResult> | RedemptionResult;
  sleep?: (ms: number) => Promise<void>;
  logger?: Pick<Console, 'error'>;
  maxSize?: number;
}

export type EnqueueResult =
  | { accepted: true; size: number }
  | { accepted: false; size: number; reason: 'full' };

export interface RedemptionQueue<T> {
  enqueue: (item: T) => EnqueueResult;
  size: () => number;
  /** Resolves once the queue is empty and nothing is being processed */
  waitForIdle: () => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createRedemptionTTSQueue<T>({
  getCooldownRemainingMs,
  processRedemption,
  sleep = defaultSleep,
  logger = console,
  maxSize = 100
}: RedemptionQueueOptions<T>): RedemptionQueue<T> {
  if (typeof getCooldownRemainingMs !== 'function') {
    throw new Error('getCooldownRemainingMs must be a function');
  }
  if (typeof processRedemption !== 'function') {
    throw new Error('processRedemption must be a function');
  }
  if (!Number.isFinite(maxSize) || maxSize < 1) {
    throw new Error('maxSize must be a positive number');
  }

  const queue: T[] = [];
  const idleResolvers: Array<() => void> = [];
  let processing = false;

  function resolveIdleIfNeeded(): void {
    if (processing || queue.length > 0) return;
    while (idleResolvers.length > 0) {
      const resolve = idleResolvers.shift()!;
      resolve();
    }
  }

  async function drainQueue(): Promise<void> {
    if (processing) return;
    processing = true;

    try {
      while (queue.length > 0) {
        const item = queue[0];

        const waitMs = Math.max(0, Number(getCooldownRemainingMs()) || 0);
        if (waitMs > 0) {
          await sleep(waitMs);
        }

        try {
          const result = await processRedemption(item);
          if (result === 'defer') {
            continue;
          }
        } catch (error) {
          logger.error('[TTS-Queue] Failed to process redemption:', (error as Error)?.message || error);
        }

        queue.shift();
      }
    } finally {
      processing = false;
      resolveIdleIfNeeded();

      if (queue.length > 0) {
        void drainQueue();
      }
    }
  }

  function enqueue(item: T): EnqueueResult {
    if (queue.length >= maxSize) {
      return { accepted: false, size: queue.length, reason: 'full' };
    }

    queue.push(item);
    void drainQueue();
    return { accepted: true, size: queue.length };
  }

  function size(): number {
    return queue.length;
  }

  function waitForIdle(): Promise<void> {
    if (!processing && queue.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      idleResolvers.push(resolve);
    });
  }

  return { enqueue, size, waitForIdle };
}
