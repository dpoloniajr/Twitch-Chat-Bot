/**
 * Tests that the bot's data managers merge their changes into the shared
 * JSON files instead of overwriting what the dashboard wrote.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LoyaltyManager } from '../../src/services/loyalty';
import { QuotesManager } from '../../src/services/quotes';
import { CountersManager } from '../../src/services/counters';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-on-save-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf-8'));

/** Simulate a dashboard write: read, change, write back */
function externalEdit(file: string, change: (data: any) => void): void {
  const data = readJson(file);
  change(data);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

describe('LoyaltyManager merge on save', () => {
  let file: string;
  let managers: LoyaltyManager[];

  const create = () => {
    const manager = new LoyaltyManager({ dataPath: file, autoSaveIntervalMs: 0 });
    managers.push(manager);
    return manager;
  };

  beforeEach(() => {
    file = path.join(dir, 'loyalty.json');
    managers = [];
  });

  afterEach(() => {
    managers.forEach((m) => m.destroy());
  });

  it('keeps dashboard changes made since the last save', () => {
    const bot = create();
    bot.awardPoints('alice', 100, 'seed');
    bot.saveData();

    // Dashboard deducts for a song request and a new viewer shows up
    externalEdit(file, (data) => {
      data.users.alice.points -= 30;
      data.users.alice.totalSpent += 30;
      data.users.bob = { ...data.users.alice, points: 5, totalEarned: 5, totalSpent: 0 };
    });

    bot.awardPoints('alice', 10, 'chat');
    bot.saveData();

    const users = readJson(file).users;
    expect(users.alice.points).toBe(80);
    expect(users.alice.totalSpent).toBe(30);
    expect(users.alice.totalEarned).toBe(110);
    expect(users.bob.points).toBe(5);
    expect(bot.getPoints('alice')).toBe(80);
    expect(bot.getPoints('bob')).toBe(5);
  });

  it('adds up changes from two writers that loaded the same file', () => {
    create().saveData();
    const a = create();
    const b = create();

    a.awardPoints('alice', 50, 'a');
    b.awardPoints('alice', 20, 'b');
    a.saveData();
    b.saveData();

    expect(readJson(file).users.alice.points).toBe(70);
  });

  it('treats an admin setPoints as absolute', () => {
    const bot = create();
    bot.awardPoints('alice', 100, 'seed');
    bot.saveData();
    externalEdit(file, (data) => {
      data.users.alice.points = 40;
    });

    bot.setPoints('alice', 500);
    bot.saveData();

    expect(readJson(file).users.alice.points).toBe(500);
  });

  it('keeps fields the dashboard adds to users', () => {
    const bot = create();
    bot.awardPoints('alice', 10, 'seed');
    bot.saveData();
    externalEdit(file, (data) => {
      data.users.alice.isSubscriber = true;
    });

    bot.awardPoints('alice', 10, 'chat');
    bot.saveData();

    expect(readJson(file).users.alice.isSubscriber).toBe(true);
  });

  it('keeps the dashboard config unless the bot changed it', () => {
    const bot = create();
    bot.saveData();
    externalEdit(file, (data) => {
      data.config.pointsPerMessage = 99;
    });

    bot.awardPoints('alice', 1, 'chat');
    bot.saveData();

    expect(readJson(file).config.pointsPerMessage).toBe(99);
    expect(bot.getConfig().pointsPerMessage).toBe(99);
  });

  it('appends its transactions to the ones on disk', () => {
    const bot = create();
    bot.awardPoints('alice', 1, 'first');
    bot.saveData();
    externalEdit(file, (data) => {
      data.transactions.push({ username: 'alice', amount: -1, type: 'spend', reason: 'dashboard', timestamp: '', balance: 0 });
    });

    bot.awardPoints('alice', 2, 'second');
    bot.saveData();

    expect(readJson(file).transactions.map((t: any) => t.reason)).toEqual(['first', 'dashboard', 'second']);
  });

  it('never overwrites a file it cannot parse', () => {
    const corrupt = '{"users": {"alice": {"points": 6303331';
    fs.writeFileSync(file, corrupt);
    const bot = create();

    bot.awardPoints('newviewer', 5, 'chat');
    bot.saveData();
    expect(fs.readFileSync(file, 'utf-8')).toBe(corrupt);

    // Once the file is readable again, the pending change is merged into it
    fs.writeFileSync(file, JSON.stringify({ users: { alice: { points: 6303331, totalEarned: 0, totalSpent: 0, watchTimeMinutes: 0, messageCount: 0, lastSeen: '', firstSeen: '', level: 1 } } }));
    bot.saveData();

    const users = readJson(file).users;
    expect(users.alice.points).toBe(6303331);
    expect(users.newviewer.points).toBe(5);
  });

  it('reloads external changes when it has nothing to save', () => {
    const bot = create();
    bot.awardPoints('alice', 10, 'seed');
    bot.saveData();

    externalEdit(file, (data) => {
      data.users.alice.points = 3;
    });
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);

    (bot as any).saveIfDirty();
    expect(bot.getPoints('alice')).toBe(3);
  });
});

describe('QuotesManager merge on save', () => {
  let file: string;
  let bot: QuotesManager;

  beforeEach(() => {
    file = path.join(dir, 'quotes.json');
    bot = new QuotesManager({ dataPath: file, autoSaveIntervalMs: 0 });
    bot.addQuote('The first quote', 'alice');
    bot.addQuote('The second quote', 'alice');
    bot.saveData();
  });

  afterEach(() => bot.destroy());

  it('renumbers a bot quote whose id the dashboard took', () => {
    // Dashboard adds quote #3 while the bot also adds what it thinks is #3
    externalEdit(file, (data) => {
      data.quotes.push({ id: 3, text: 'Added on the dashboard', addedBy: 'mod', addedAt: '' });
      data.nextId = 4;
    });
    const added = bot.addQuote('Added in chat', 'viewer');
    expect(added.quote!.id).toBe(3);

    bot.saveData();

    const saved = readJson(file);
    expect(saved.quotes.map((q: any) => [q.id, q.text])).toEqual([
      [1, 'The first quote'],
      [2, 'The second quote'],
      [3, 'Added on the dashboard'],
      [4, 'Added in chat'],
    ]);
    expect(saved.nextId).toBe(5);
    expect(bot.getQuote(4)!.text).toBe('Added in chat');
  });

  it('applies bot edits and deletes without undoing dashboard ones', () => {
    externalEdit(file, (data) => {
      data.quotes = data.quotes.filter((q: any) => q.id !== 1);
      data.quotes.push({ id: 3, text: 'Added on the dashboard', addedBy: 'mod', addedAt: '' });
    });

    bot.editQuote(2, 'The second quote, edited');
    bot.saveData();

    expect(readJson(file).quotes.map((q: any) => [q.id, q.text])).toEqual([
      [2, 'The second quote, edited'],
      [3, 'Added on the dashboard'],
    ]);

    bot.deleteQuote(3);
    bot.saveData();
    expect(readJson(file).quotes.map((q: any) => q.id)).toEqual([2]);
  });

  it('replaces everything on a non-merge import', () => {
    externalEdit(file, (data) => {
      data.quotes.push({ id: 3, text: 'Added on the dashboard', addedBy: 'mod', addedAt: '' });
    });

    bot.importQuotes([{ id: 9, text: 'Only quote', addedBy: 'x', addedAt: '' }], false);
    bot.saveData();

    expect(readJson(file).quotes.map((q: any) => [q.id, q.text])).toEqual([[1, 'Only quote']]);
  });
});

describe('CountersManager merge on save', () => {
  let file: string;
  let bot: CountersManager;

  beforeEach(() => {
    file = path.join(dir, 'counters.json');
    bot = new CountersManager({ dataPath: file, autoSaveIntervalMs: 0 });
    bot.saveData();
  });

  afterEach(() => bot.destroy());

  it('merges increments from both sides', () => {
    externalEdit(file, (data) => {
      data.counters.deaths.value = 5;
    });

    bot.increment('deaths', 2, 'viewer');
    bot.saveData();

    expect(readJson(file).counters.deaths.value).toBe(7);
    expect(bot.getValue('deaths')).toBe(7);
  });

  it('treats set and reset as absolute', () => {
    externalEdit(file, (data) => {
      data.counters.deaths.value = 5;
      data.counters.wins.value = 3;
    });

    bot.reset('deaths', 'mod');
    bot.setValue('wins', 10, 'mod');
    bot.saveData();

    const counters = readJson(file).counters;
    expect(counters.deaths.value).toBe(0);
    expect(counters.wins.value).toBe(10);
  });

  it('keeps dashboard-created counters and applies bot deletes', () => {
    externalEdit(file, (data) => {
      data.counters.jumps = { ...data.counters.deaths, name: 'jumps', value: 4 };
    });

    bot.deleteCounter('losses');
    bot.saveData();

    const counters = readJson(file).counters;
    expect(Object.keys(counters).sort()).toEqual(['deaths', 'jumps', 'wins']);
    expect(counters.jumps.value).toBe(4);
  });

  it('appends its history to the history on disk', () => {
    externalEdit(file, (data) => {
      data.history.push({ counterName: 'wins', previousValue: 0, newValue: 1, change: 1, modifiedBy: 'dashboard', timestamp: '' });
    });

    bot.increment('deaths', 1, 'viewer');
    bot.saveData();

    expect(readJson(file).history.map((h: any) => h.modifiedBy)).toEqual(['dashboard', 'viewer']);
  });
});
