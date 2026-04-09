'use strict';

function defaultSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createRedemptionTTSQueue({ getCooldownRemainingMs, processRedemption, sleep = defaultSleep, logger = console }) {
  if (typeof getCooldownRemainingMs !== 'function') {
    throw new Error('getCooldownRemainingMs must be a function');
  }
  if (typeof processRedemption !== 'function') {
    throw new Error('processRedemption must be a function');
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
        const waitMs = Math.max(0, Number(getCooldownRemainingMs()) || 0);
        if (waitMs > 0) {
          await sleep(waitMs);
        }

        const item = queue.shift();
        if (!item) continue;

        try {
          await processRedemption(item);
        } catch (error) {
          logger.error('[TTS-Queue] Failed to process redemption:', error?.message || error);
        }
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
    queue.push(item);
    void drainQueue();
    return queue.length;
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
