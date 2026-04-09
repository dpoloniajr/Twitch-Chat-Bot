const { createRedemptionTTSQueue } = require('../../lib/tts-redemption-queue');

describe('TTS redemption queue', () => {
  test('defers later redemptions instead of dropping them during global cooldown', async () => {
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

    expect(processed).toEqual(['first', 'second']);
    expect(sleeps).toEqual([9000]);
  });
});
