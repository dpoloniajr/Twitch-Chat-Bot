const assert = require('assert');
const { createRedemptionTTSQueue } = require('./lib/tts-redemption-queue');

async function run() {
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

  queue.enqueue({ id: 'first' });
  queue.enqueue({ id: 'second' });

  await queue.waitForIdle();

  assert.deepStrictEqual(processed, ['first', 'second'], 'Queue should process both redemptions in order');
  assert.deepStrictEqual(sleeps, [9000], 'Queue should wait for global cooldown before second redemption');
}

run()
  .then(() => {
    console.log('PASS test-tts-redemption-queue');
  })
  .catch((error) => {
    console.error('FAIL test-tts-redemption-queue:', error.message);
    process.exit(1);
  });
