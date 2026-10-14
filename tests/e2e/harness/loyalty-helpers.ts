/**
 * Helpers for the chat pipeline / loyalty E2E suites.
 *
 * Every chat message makes the bot POST /api/loyalty/award-message, which takes the
 * cross-process lock on loyalty.json. A loyalty command in the same message (!gamba,
 * !duel) then usually finds the lock held and waits on `setTimeout(retryDelay = 100ms)`
 * (lib/file-lock.js). Under jest fake timers that wait never ends unless the clock moves,
 * so `bot.chat` alone stalls. `chatPumped` sends the message and, whenever a file-lock
 * retry timer is pending, advances the fake clock by exactly that retry delay.
 */

import { setTimeout as realSleep } from 'timers/promises';
import { startBot, BotHarness, BotOptions, ChatTags } from './bot';

/**
 * startBot, then wait until the bot has finished starting (custom commands loaded, chat connected).
 * Under CPU load the harness' own settle can return while init() is still talking to fake Twitch,
 * and a chat message sent then is lost.
 */
export async function startReadyBot(options: BotOptions = {}): Promise<BotHarness> {
  const bot = await startBot(options);
  const loaded = () => bot.dashboardCalls().some((c) => c.route === 'GET /api/custom-commands');
  for (let i = 0; i < 300 && !loaded(); i++) {
    await realSleep(10);
    await bot.settle();
  }
  await bot.settle();
  return bot;
}

/**
 * bot.chat plus a second settle. Under load the harness' settle can end while a bot request is
 * still on the wire (not yet counted as pending), so collect anything said after that too.
 */
export async function talk(bot: BotHarness, user: string, text: string, tags: ChatTags = {}): Promise<string[]> {
  const out = await bot.chat(user, text, tags);
  return out.concat(await settleAgain(bot));
}

async function settleAgain(bot: BotHarness): Promise<string[]> {
  await realSleep(10);
  await bot.settle();
  return bot.take();
}

export async function chatPumped(
  bot: BotHarness,
  user: string,
  text: string,
  tags: ChatTags = {}
): Promise<string[]> {
  const fakeSetTimeout = global.setTimeout;
  // Pending file-lock timers: id -> delay (ms)
  const lockWaits = new Map<number, number>();
  let nextId = 0;
  const tracking = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    if (!/file-lock/.test(String(new Error().stack))) return fakeSetTimeout(fn, ms, ...rest);
    const id = nextId++;
    lockWaits.set(id, Math.max(0, ms ?? 0));
    return fakeSetTimeout((...a: unknown[]) => {
      lockWaits.delete(id);
      fn(...a);
    }, ms, ...rest);
  }) as unknown as typeof setTimeout;
  global.setTimeout = tracking;
  try {
    let done = false;
    const reply = bot.chat(user, text, tags).finally(() => { done = true; });
    while (!done) {
      await realSleep(2);
      if (!done && lockWaits.size > 0) {
        const shortest = Math.min(...lockWaits.values());
        await jest.advanceTimersByTimeAsync(shortest);
      }
    }
    return (await reply).concat(await settleAgain(bot));
  } finally {
    if (global.setTimeout === tracking) global.setTimeout = fakeSetTimeout;
  }
}

export interface LoyaltyUserSeed {
  points: number;
  [key: string]: unknown;
}

/** loyalty.json content; message points are off so chat never races the command under test */
export function loyaltyFile(
  users: Record<string, LoyaltyUserSeed>,
  config: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    users,
    config: {
      pointsPerMinute: 10,
      pointsPerMessage: 0,
      subscriberMultiplier: 2,
      vipMultiplier: 1.5,
      maxPointsPerMessage: 50,
      messageCooldownSeconds: 30,
      currencyName: 'coin',
      currencyNamePlural: 'coins',
      pointsPerLevel: 1000,
      enabled: true,
      ...config
    },
    transactions: []
  };
}

/** Silence the bot and dashboard console output for one test */
export function silenceConsole(): void {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
}
