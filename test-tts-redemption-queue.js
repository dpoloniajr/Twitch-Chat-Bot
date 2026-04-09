const assert = require('assert');
const { createRedemptionTTSQueue } = require('./lib/tts-redemption-queue');

async function run() {
  // 1) Baseline cooldown deferral
  {
    const processed = [];
    const sleeps = [];
    const cooldownSequence = [0, 9000, 0];
    let cooldownIndex = 0;

    const queue = createRedemptionTTSQueue({
      getCooldownRemainingMs: () => {
        const value = cooldownSequence[cooldownIndex] ?? 0;
        cooldownIndex += 1;
        return value;
      },
      processRedemption: async (item) => {
        processed.push(item.id);
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      }
    });

    assert.deepStrictEqual(queue.enqueue({ id: 'first' }), { accepted: true, size: 1 });
    assert.deepStrictEqual(queue.enqueue({ id: 'second' }), { accepted: true, size: 2 });
    await queue.waitForIdle();

    assert.deepStrictEqual(processed, ['first', 'second'], 'Queue should process both redemptions in order');
    assert.deepStrictEqual(sleeps, [9000], 'Queue should wait for global cooldown before second redemption');
  }

  // 2) Defer should not requeue item to the tail
  {
    const processed = [];
    let attempts = 0;
    const queue = createRedemptionTTSQueue({
      getCooldownRemainingMs: () => 0,
      processRedemption: async (item) => {
        attempts += 1;
        if (attempts === 1) return 'defer';
        processed.push(item.id);
      }
    });

    queue.enqueue({ id: 'same-item' });
    await queue.waitForIdle();

    assert.deepStrictEqual(processed, ['same-item'], 'Deferred item should be retried in place');
    assert.strictEqual(attempts, 2, 'Deferred item should be retried exactly once in this test');
  }

  // 3) Full queue should reject new redemptions
  {
    let releaseFirst;
    const firstDone = new Promise(resolve => {
      releaseFirst = resolve;
    });
    const processed = [];

    const queue = createRedemptionTTSQueue({
      maxSize: 1,
      getCooldownRemainingMs: () => 0,
      processRedemption: async (item) => {
        await firstDone;
        processed.push(item.id);
      }
    });

    assert.deepStrictEqual(queue.enqueue({ id: 'first' }), { accepted: true, size: 1 });
    assert.deepStrictEqual(queue.enqueue({ id: 'second' }), { accepted: false, size: 1, reason: 'full' });
    releaseFirst();
    await queue.waitForIdle();
    assert.deepStrictEqual(processed, ['first'], 'Only first item should be processed when queue is full');
  }
}

run()
  .then(() => {
    console.log('PASS test-tts-redemption-queue');
  })
  .catch((error) => {
    console.error('FAIL test-tts-redemption-queue:', error.message);
    process.exit(1);
  });
