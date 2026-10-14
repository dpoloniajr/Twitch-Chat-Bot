/**
 * Characterization tests: fun commands (!8ball, !dice, !coinflip) and the
 * per-command cooldowns configured in the dashboard's builtinCommands.json.
 */
jest.mock('axios', () => require('./harness/redirect').axiosMock());
jest.mock('ws', () => require('./harness/redirect').wsMock());
jest.mock('tmi.js', () => require('./harness/redirect').tmiMock());
jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('../../src/lib/console-timestamp', () => ({}));

import { startBot, BotHarness, BotOptions } from './harness/bot';
import { builtinCooldowns } from './harness/channel-commands-helpers';

/** No cooldowns for the fun commands (the dashboard adds its defaults for any command the file lacks) */
const NO_COOLDOWNS: BotOptions = { dashboardData: { 'builtinCommands.json': builtinCooldowns({ '!8ball': 0, '!dice': 0, '!coinflip': 0 }) } };

describe('fun commands', () => {
  let bot: BotHarness | undefined;
  const start = async (options: BotOptions = NO_COOLDOWNS) => {
    bot = await startBot(options);
    return bot;
  };

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => {
    await bot?.stop();
    bot = undefined;
  });

  describe('!8ball', () => {
    it('answers a question with the first answer when Math.random() is 0', async () => {
      const b = await start();
      jest.spyOn(Math, 'random').mockReturnValue(0);
      expect(await b.chat('viewer1', '!8ball will it work?')).toEqual(['@viewer1 It is certain.']);
    });

    it('answers with the last answer when Math.random() is close to 1', async () => {
      const b = await start();
      jest.spyOn(Math, 'random').mockReturnValue(0.9999);
      expect(await b.chat('viewer1', '!8ball will it work?')).toEqual(['@viewer1 Very doubtful.']);
    });

    it('picks answer floor(random * 20)', async () => {
      const b = await start();
      jest.spyOn(Math, 'random').mockReturnValue(0.5);
      expect(await b.chat('viewer1', '!8ball hmm')).toEqual(['@viewer1 Reply hazy, try again.']);
    });

    it('asks for a question when none is given', async () => {
      const b = await start();
      expect(await b.chat('viewer1', '!8ball')).toEqual(['@viewer1 Ask a question! Usage: !8ball <question>']);
      expect(await b.chat('viewer1', '!8ball    ')).toEqual(['@viewer1 Ask a question! Usage: !8ball <question>']);
    });

    it('is case-insensitive on the command name', async () => {
      const b = await start();
      jest.spyOn(Math, 'random').mockReturnValue(0);
      expect(await b.chat('viewer1', '!8BALL yes?')).toEqual(['@viewer1 It is certain.']);
    });

    it('does not post a command log to the dashboard', async () => {
      const b = await start();
      await b.chat('viewer1', '!8ball question');
      expect(b.dashboardCalls().filter((c) => c.route === 'POST /api/logs')).toEqual([]);
    });
  });

  describe('!dice', () => {
    it('rolls a 6-sided die by default', async () => {
      const b = await start();
      const spy = jest.spyOn(Math, 'random').mockReturnValue(0);
      expect(await b.chat('viewer1', '!dice')).toEqual(['@viewer1 rolled a 6-sided die and got 1.']);
      spy.mockReturnValue(0.9999);
      expect(await b.chat('viewer1', '!dice')).toEqual(['@viewer1 rolled a 6-sided die and got 6.']);
    });

    it('rolls a die with the given number of sides', async () => {
      const b = await start();
      jest.spyOn(Math, 'random').mockReturnValue(0.5);
      expect(await b.chat('viewer1', '!dice 20')).toEqual(['@viewer1 rolled a 20-sided die and got 11.']);
    });

    it('accepts the boundaries 2 and 1000', async () => {
      const b = await start();
      jest.spyOn(Math, 'random').mockReturnValue(0.9999);
      expect(await b.chat('viewer1', '!dice 2')).toEqual(['@viewer1 rolled a 2-sided die and got 2.']);
      expect(await b.chat('viewer1', '!dice 1000')).toEqual(['@viewer1 rolled a 1000-sided die and got 1000.']);
    });

    it.each([['0'], ['1'], ['-6'], ['1001'], ['999999999999'], ['abc'], ['d20'], ['20abc'], ['6.9'], ['+6'], ['1e2']])('rejects %s sides', async (arg) => {
      const b = await start();
      expect(await b.chat('viewer1', `!dice ${arg}`)).toEqual([
        '@viewer1 Please choose a number of sides between 2 and 1000 (e.g. !dice 20).'
      ]);
    });

    it('accepts leading zeros in a whole number', async () => {
      const b = await start();
      jest.spyOn(Math, 'random').mockReturnValue(0);
      expect(await b.chat('viewer1', '!dice 020')).toEqual(['@viewer1 rolled a 20-sided die and got 1.']);
    });

    it('ignores extra arguments', async () => {
      const b = await start();
      jest.spyOn(Math, 'random').mockReturnValue(0);
      expect(await b.chat('viewer1', '!dice 10 20')).toEqual(['@viewer1 rolled a 10-sided die and got 1.']);
    });
  });

  describe('!coinflip', () => {
    it('gets Heads when Math.random() < 0.5', async () => {
      const b = await start();
      jest.spyOn(Math, 'random').mockReturnValue(0.4999);
      expect(await b.chat('viewer1', '!coinflip')).toEqual(['@viewer1 flipped a coin and got Heads.']);
    });

    it('gets Tails when Math.random() >= 0.5', async () => {
      const b = await start();
      jest.spyOn(Math, 'random').mockReturnValue(0.5);
      expect(await b.chat('viewer1', '!coinflip')).toEqual(['@viewer1 flipped a coin and got Tails.']);
    });

    it('ignores arguments', async () => {
      const b = await start();
      jest.spyOn(Math, 'random').mockReturnValue(0);
      expect(await b.chat('viewer1', '!coinflip heads please')).toEqual(['@viewer1 flipped a coin and got Heads.']);
    });
  });
});

describe('fun command cooldowns (getCommandCooldown)', () => {
  let bot: BotHarness | undefined;

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => {
    await bot?.stop();
    bot = undefined;
  });

  it('dashboard defaults give !8ball, !dice and !coinflip a 5s cooldown', async () => {
    bot = await startBot();
    const defaults = bot.readData<Array<{ name: string; cooldownSeconds: number }>>('builtinCommands.json');
    const cd = (name: string) => defaults.find((c) => c.name === name)?.cooldownSeconds;
    expect([cd('!8ball'), cd('!dice'), cd('!coinflip'), cd('!clip'), cd('!followage')]).toEqual([5, 5, 5, 60, 0]);

    jest.spyOn(Math, 'random').mockReturnValue(0);
    expect(await bot.chat('viewer1', '!coinflip')).toEqual(['@viewer1 flipped a coin and got Heads.']);
    expect(await bot.chat('viewer1', '!coinflip')).toEqual(['@viewer1 !coinflip is on cooldown. Try again in 5s.']);
    expect(await bot.chat('viewer1', '!dice')).toEqual(['@viewer1 rolled a 6-sided die and got 1.']);
    expect(await bot.chat('viewer1', '!dice')).toEqual(['@viewer1 !dice is on cooldown. Try again in 5s.']);
    expect(await bot.chat('viewer1', '!8ball q')).toEqual(['@viewer1 It is certain.']);
    expect(await bot.chat('viewer1', '!8ball q')).toEqual(['@viewer1 !8ball is on cooldown. Try again in 5s.']);
  });

  it('counts down the remaining seconds (rounded up) and expires exactly at the cooldown', async () => {
    bot = await startBot({ dashboardData: { 'builtinCommands.json': builtinCooldowns({ '!coinflip': 10 }) } });
    jest.spyOn(Math, 'random').mockReturnValue(0);
    expect(await bot.chat('viewer1', '!coinflip')).toEqual(['@viewer1 flipped a coin and got Heads.']);
    await bot.advance(2500);
    expect(await bot.chat('viewer1', '!coinflip')).toEqual(['@viewer1 !coinflip is on cooldown. Try again in 8s.']);
    await bot.advance(7499);
    expect(await bot.chat('viewer1', '!coinflip')).toEqual(['@viewer1 !coinflip is on cooldown. Try again in 1s.']);
    await bot.advance(1);
    expect(await bot.chat('viewer1', '!coinflip')).toEqual(['@viewer1 flipped a coin and got Heads.']);
  });

  it('is a global cooldown shared by all users, mods and the broadcaster', async () => {
    bot = await startBot({ dashboardData: { 'builtinCommands.json': builtinCooldowns({ '!dice': 30 }) } });
    jest.spyOn(Math, 'random').mockReturnValue(0);
    expect(await bot.chat('viewer1', '!dice')).toEqual(['@viewer1 rolled a 6-sided die and got 1.']);
    expect(await bot.chat('viewer2', '!dice')).toEqual(['@viewer2 !dice is on cooldown. Try again in 30s.']);
    expect(await bot.chat('modguy', '!dice', { mod: true })).toEqual(['@modguy !dice is on cooldown. Try again in 30s.']);
    expect(await bot.chat('caster', '!dice', { broadcaster: true })).toEqual(['@caster !dice is on cooldown. Try again in 30s.']);
  });

  it('cooldowns are per command: one command on cooldown does not block another', async () => {
    bot = await startBot({ dashboardData: { 'builtinCommands.json': builtinCooldowns({ '!dice': 30, '!coinflip': 30 }) } });
    jest.spyOn(Math, 'random').mockReturnValue(0);
    await bot.chat('viewer1', '!dice');
    expect(await bot.chat('viewer1', '!coinflip')).toEqual(['@viewer1 flipped a coin and got Heads.']);
  });

  it('commands with cooldownSeconds 0 have no cooldown', async () => {
    bot = await startBot({ dashboardData: { 'builtinCommands.json': builtinCooldowns({ '!dice': 0, '!coinflip': 0 }) } });
    jest.spyOn(Math, 'random').mockReturnValue(0);
    for (let i = 0; i < 3; i++) {
      expect(await bot.chat('viewer1', '!dice')).toEqual(['@viewer1 rolled a 6-sided die and got 1.']);
      expect(await bot.chat('viewer1', '!coinflip')).toEqual(['@viewer1 flipped a coin and got Heads.']);
    }
  });

  it('a failed invocation (bad args / no question) does not start the cooldown', async () => {
    bot = await startBot({ dashboardData: { 'builtinCommands.json': builtinCooldowns({ '!dice': 5, '!8ball': 5 }) } });
    jest.spyOn(Math, 'random').mockReturnValue(0);
    expect(await bot.chat('viewer1', '!dice 0')).toEqual(['@viewer1 Please choose a number of sides between 2 and 1000 (e.g. !dice 20).']);
    expect(await bot.chat('viewer1', '!dice 6')).toEqual(['@viewer1 rolled a 6-sided die and got 1.']);
    expect(await bot.chat('viewer1', '!dice 6')).toEqual(['@viewer1 !dice is on cooldown. Try again in 5s.']);
    expect(await bot.chat('viewer1', '!8ball')).toEqual(['@viewer1 Ask a question! Usage: !8ball <question>']);
    expect(await bot.chat('viewer1', '!8ball why?')).toEqual(['@viewer1 It is certain.']);
    expect(await bot.chat('viewer1', '!8ball why?')).toEqual(['@viewer1 !8ball is on cooldown. Try again in 5s.']);
  });

  it('dashboard cooldown edits apply on the next command refresh (60s), without a restart', async () => {
    bot = await startBot({ dashboardData: { 'builtinCommands.json': builtinCooldowns({ '!coinflip': 0 }) } });
    jest.spyOn(Math, 'random').mockReturnValue(0);
    bot.writeData('builtinCommands.json', builtinCooldowns({ '!coinflip': 60 }));
    expect(await bot.chat('viewer1', '!coinflip')).toEqual(['@viewer1 flipped a coin and got Heads.']);
    expect(await bot.chat('viewer1', '!coinflip')).toEqual(['@viewer1 flipped a coin and got Heads.']);
    await bot.advance(60_000);
    expect(await bot.chat('viewer1', '!coinflip')).toEqual(['@viewer1 flipped a coin and got Heads.']);
    expect(await bot.chat('viewer1', '!coinflip')).toEqual(['@viewer1 !coinflip is on cooldown. Try again in 60s.']);
  });

  it('!reloadcommands reloads the cooldown config immediately', async () => {
    bot = await startBot({ dashboardData: { 'builtinCommands.json': builtinCooldowns({ '!coinflip': 0 }) } });
    jest.spyOn(Math, 'random').mockReturnValue(0);
    bot.writeData('builtinCommands.json', builtinCooldowns({ '!coinflip': 30 }));
    await bot.chat('modguy', '!reloadcommands', { mod: true });
    expect(await bot.chat('viewer1', '!coinflip')).toEqual(['@viewer1 flipped a coin and got Heads.']);
    expect(await bot.chat('viewer1', '!coinflip')).toEqual(['@viewer1 !coinflip is on cooldown. Try again in 30s.']);
  });

  it('keeps the loaded cooldowns when a refresh cannot read the config', async () => {
    bot = await startBot({ dashboardData: { 'builtinCommands.json': builtinCooldowns({ '!coinflip': 30 }) } });
    jest.spyOn(Math, 'random').mockReturnValue(0);
    require('fs').writeFileSync(require('path').join(bot.logsDir, 'builtinCommands.json'), '{ broken');
    await bot.advance(60_000);
    expect(await bot.chat('viewer1', '!coinflip')).toEqual(['@viewer1 flipped a coin and got Heads.']);
    expect(await bot.chat('viewer1', '!coinflip')).toEqual(['@viewer1 !coinflip is on cooldown. Try again in 30s.']);
  });

  it('GETs /api/builtin-commands again on every command refresh', async () => {
    bot = await startBot(NO_COOLDOWNS);
    const gets = () => bot!.dashboardCalls().filter((c) => c.route === 'GET /api/builtin-commands').length;
    const atStart = gets();
    for (let i = 0; i < 3; i++) await bot.advance(60_000);
    expect(gets()).toBe(atStart + 3);
  });
});
