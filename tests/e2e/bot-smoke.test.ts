/**
 * E2E smoke test for the harness: the bot starts, connects, and answers chat.
 */
jest.mock('axios', () => require('./harness/redirect').axiosMock());
jest.mock('ws', () => require('./harness/redirect').wsMock());
jest.mock('tmi.js', () => require('./harness/redirect').tmiMock());
jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('../../src/lib/console-timestamp', () => ({}));

import { startBot, BotHarness } from './harness/bot';

describe('bot smoke', () => {
  let bot: BotHarness;
  beforeEach(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    bot = await startBot();
  });
  afterEach(async () => {
    await bot.stop();
  });

  it('answers !coinflip', async () => {
    const out = await bot.chat('viewer1', '!coinflip');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^@viewer1 flipped a coin and got (Heads|Tails)\.$/);
  });
});
