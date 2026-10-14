/**
 * Fun commands: 8ball, dice, coinflip
 */

import type { BotContext } from './context';

export const EIGHTBALL_ANSWERS = [
  'It is certain.', 'It is decidedly so.', 'Without a doubt.', 'Yes — definitely.', 'You may rely on it.',
  'As I see it, yes.', 'Most likely.', 'Outlook good.', 'Yes.', 'Signs point to yes.',
  'Reply hazy, try again.', 'Ask again later.', 'Better not tell you now.', 'Cannot predict now.', 'Concentrate and ask again.',
  "Don't count on it.", 'My reply is no.', 'My sources say no.', 'Outlook not so good.', 'Very doubtful.'
];

/** Handlers resolve to true on success, which is when the command's cooldown starts */
export interface FunCommands {
  handle8ball: (channel: string, username: string, args: string[]) => Promise<boolean>;
  handleDice: (channel: string, username: string, args: string[]) => Promise<boolean>;
  handleCoinflip: (channel: string, username: string) => Promise<boolean>;
}

/** Parse a whole positive decimal number ("20"); anything else ("20abc", "6.9", "-1") gives NaN */
export function parseWholeNumber(text: string): number {
  return /^\d+$/.test(text.trim()) ? Number(text.trim()) : NaN;
}

export function createFunCommands(ctx: BotContext): FunCommands {
  const { sendChatMessage } = ctx;

  async function handle8ball(channel: string, username: string, args: string[]): Promise<boolean> {
    const question = args.join(' ').trim();
    if (!question) {
      sendChatMessage(channel, `@${username} Ask a question! Usage: !8ball <question>`);
      return false;
    }
    const answer = EIGHTBALL_ANSWERS[Math.floor(Math.random() * EIGHTBALL_ANSWERS.length)];
    sendChatMessage(channel, `@${username} ${answer}`);
    return true;
  }

  async function handleDice(channel: string, username: string, args: string[]): Promise<boolean> {
    let sides = 6;
    if (args[0]) {
      const n = parseWholeNumber(args[0]);
      if (Number.isNaN(n) || n < 2 || n > 1000) {
        sendChatMessage(channel, `@${username} Please choose a number of sides between 2 and 1000 (e.g. !dice 20).`);
        return false;
      }
      sides = n;
    }
    const roll = Math.floor(Math.random() * sides) + 1;
    sendChatMessage(channel, `@${username} rolled a ${sides}-sided die and got ${roll}.`);
    return true;
  }

  async function handleCoinflip(channel: string, username: string): Promise<boolean> {
    const result = Math.random() < 0.5 ? 'Heads' : 'Tails';
    sendChatMessage(channel, `@${username} flipped a coin and got ${result}.`);
    return true;
  }

  return { handle8ball, handleDice, handleCoinflip };
}
