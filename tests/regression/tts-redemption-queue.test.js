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

    expect(queue.enqueue({ id: 'first' })).toEqual({ accepted: true, size: 1 });
    expect(queue.enqueue({ id: 'second' })).toEqual({ accepted: true, size: 2 });

    await queue.waitForIdle();

    expect(processed).toEqual(['first', 'second']);
    expect(sleeps).toEqual([9000]);
  });

  test('keeps queued item in place when processor asks to defer', async () => {
    const processed = [];
    let attempts = 0;
    const queue = createRedemptionTTSQueue({
      getCooldownRemainingMs: () => 0,
      processRedemption: async (item) => {
        attempts += 1;
        if (attempts === 1) {
          return 'defer';
        }
        processed.push(item.id);
      }
    });

    queue.enqueue({ id: 'same-item' });
    await queue.waitForIdle();

    expect(processed).toEqual(['same-item']);
    expect(attempts).toBe(2);
  });

  test('rejects enqueue when queue is full', async () => {
    const processed = [];
    let releaseFirst;
    const firstDone = new Promise(resolve => {
      releaseFirst = resolve;
    });

    const queue = createRedemptionTTSQueue({
      maxSize: 1,
      getCooldownRemainingMs: () => 0,
      processRedemption: async (item) => {
        await firstDone;
        processed.push(item.id);
      }
    });

    expect(queue.enqueue({ id: 'first' })).toEqual({ accepted: true, size: 1 });
    expect(queue.enqueue({ id: 'second' })).toEqual({ accepted: false, size: 1, reason: 'full' });

    releaseFirst();
    await queue.waitForIdle();

    expect(processed).toEqual(['first']);
  });
});
