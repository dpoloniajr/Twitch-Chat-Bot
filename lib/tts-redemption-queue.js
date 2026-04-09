'use strict';

function defaultSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createRedemptionTTSQueue({
  getCooldownRemainingMs,
  processRedemption,
  sleep = defaultSleep,
  logger = console,
  maxSize = 100
}) {
  if (typeof getCooldownRemainingMs !== 'function') {
    throw new Error('getCooldownRemainingMs must be a function');
  }
  if (typeof processRedemption !== 'function') {
    throw new Error('processRedemption must be a function');
  }
  if (!Number.isFinite(maxSize) || maxSize < 1) {
    throw new Error('maxSize must be a positive number');
  }

  const queue = [];
  const idleResolvers = [];
  let processing = false;

  function resolveIdleIfNeeded() {
    if (processing || queue.length > 0) return;
    while (idleResolvers.length > 0) {
      const resolve = idleResolvers.shift();
      resolve();
    }
  }

  async function drainQueue() {
    if (processing) return;
    processing = true;

    try {
      while (queue.length > 0) {
        const item = queue[0];
        if (!item) continue;

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
          logger.error('[TTS-Queue] Failed to process redemption:', error?.message || error);
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

  function enqueue(item) {
    if (queue.length >= maxSize) {
      return { accepted: false, size: queue.length, reason: 'full' };
    }

    queue.push(item);
    void drainQueue();
    return { accepted: true, size: queue.length };
  }

  function size() {
    return queue.length;
  }

  function waitForIdle() {
    if (!processing && queue.length === 0) {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      idleResolvers.push(resolve);
    });
  }

  return {
    enqueue,
    size,
    waitForIdle
  };
}

module.exports = {
  createRedemptionTTSQueue
};
