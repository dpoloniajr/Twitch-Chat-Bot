/**
 * Full-stack E2E for the dashboard GUI: the real index.html with app.js and
 * manage.js running in jsdom, talking over real HTTP to a real dashboard
 * (temp logs dir and .env). Requests carry the page's Origin like a browser's,
 * with DASHBOARD_INTERNAL_SECRET set, so this also proves the pages work
 * through the CSRF and bot-secret guards. Checks that what a user does on a
 * page lands in .env and the data files.
 */
jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('../../../src/lib/console-timestamp', () => ({}));

import * as dotenv from 'dotenv';
import { startDashboard, silenceConsole, httpRequest, Dash } from './helpers';
import { loadPage, flush, click, change, PageHarness } from '../../web/support/static-page-harness';

const ENV_FILE = 'TWITCH_CLIENT_ID=abc123\nOPENAI_API_KEY=sk-SECRET-VALUE\nCOMMAND_REFRESH_INTERVAL=30\n';

let d: Dash;
let h: PageHarness;

/** Load the dashboard page with fetch forwarded to the real server */
async function openDashboard(): Promise<void> {
  const origin = `http://127.0.0.1:${d.port}`;
  h = loadPage({
    html: 'dashboard/public/index.html',
    script: 'dashboard/public/app.js',
    extraScripts: ['dashboard/public/manage.js'],
    url: `${origin}/`,
    fetchImpl: async (url, init) => {
      const headers: Record<string, string> = { origin };
      let raw: string | undefined;
      if (typeof init?.body === 'string') raw = init.body;
      const res = await httpRequest(d.port, (init?.method ?? 'GET').toUpperCase(), url, { headers, raw });
      return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => JSON.parse(res.text) };
    }
  });
  await settle();
}

/** Real HTTP round trips take longer than mocked ones */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await flush(5);
    await new Promise(r => setTimeout(r, 20));
  }
}

async function show(page: string): Promise<void> {
  click(h.document.querySelector(`a[href="#${page}"]`)!);
  await settle();
}

const settingInput = (key: string) => h.$(`setting-${key}`) as HTMLInputElement;
const typeInto = (el: HTMLInputElement, value: string) => {
  el.value = value;
  el.dispatchEvent(new h.window.Event('input', { bubbles: true }));
};
const realEnv = () => jest.requireActual<typeof dotenv>('dotenv').parse(d.readEnv());

beforeEach(async () => {
  silenceConsole();
  d = await startDashboard({
    envFile: ENV_FILE,
    env: { ...jest.requireActual<typeof dotenv>('dotenv').parse(ENV_FILE), DASHBOARD_INTERNAL_SECRET: 'bot-only-secret' }
  });
  await openDashboard();
});

afterEach(async () => {
  h.window.close();
  await d.close();
});

describe('dashboard GUI against a real server', () => {
  it('Settings: shows the saved values without the secret, and saves edits to .env', async () => {
    await show('settings');
    expect(settingInput('COMMAND_REFRESH_INTERVAL').value).toBe('30');
    expect(settingInput('OPENAI_API_KEY').value).toBe('');
    expect(h.document.body.innerHTML).not.toContain('sk-SECRET-VALUE');

    typeInto(settingInput('COMMAND_REFRESH_INTERVAL'), '90');
    typeInto(settingInput('ANNOUNCEMENT_INTERVAL_MS'), '20');
    change(settingInput('HYPE_ENABLED'), false);
    typeInto(settingInput('HYPE_MESSAGE'), 'Chat is #1!');
    typeInto(settingInput('YOUTUBE_API_KEY'), 'AIza-from-gui');
    h.window.eval('mgrSaveSettings()');
    await settle();

    expect(h.$('settingsStatus').textContent).toBe('Saved 5 settings.');
    expect(h.$('settingsRestartNotice').hidden).toBe(false);
    expect(realEnv()).toMatchObject({
      COMMAND_REFRESH_INTERVAL: '90',
      ANNOUNCEMENT_INTERVAL_MS: '1200000',
      HYPE_ENABLED: 'false',
      HYPE_MESSAGE: 'Chat is #1!',
      YOUTUBE_API_KEY: 'AIza-from-gui',
      OPENAI_API_KEY: 'sk-SECRET-VALUE'
    });
    // The re-rendered form shows the saved values, still without secrets
    expect(settingInput('COMMAND_REFRESH_INTERVAL').value).toBe('90');
    expect(settingInput('ANNOUNCEMENT_INTERVAL_MS').value).toBe('20');
    expect(settingInput('YOUTUBE_API_KEY').placeholder).toContain('set; type to replace');
    expect(h.document.body.innerHTML).not.toContain('AIza-from-gui');
  });

  it('Settings: an out-of-range value is refused and .env is unchanged', async () => {
    await show('settings');
    typeInto(settingInput('COMMAND_REFRESH_INTERVAL'), '2');
    h.window.eval('mgrSaveSettings()');
    await settle();
    expect(h.$('settingsStatus').textContent).toBe('Not saved: Command refresh interval (COMMAND_REFRESH_INTERVAL) must be at least 5');
    expect(d.readEnv()).toBe(ENV_FILE);
  });

  it('Song Queue: settings, blocklist and clearing work through the bot-secret guard', async () => {
    await show('songs');
    h.$('songsCost').value = '25';
    h.$('songsMaxDuration').value = '5';
    h.$('songsPriority').value = 'vips';
    h.window.eval('mgrSaveSongConfig()');
    await settle();
    expect(h.$('songsStatus').textContent).toBe('Song request settings saved.');
    expect(d.readJson('song-queue.json').config).toMatchObject({ cost: 25, maxDuration: 300, priority: 'vips' });

    h.$('songsBlockType').value = 'keyword';
    h.$('songsBlockValue').value = 'earrape';
    h.window.eval('mgrBlockSong()');
    await settle();
    expect(d.readJson('song-blocklist.json').keywords).toEqual(['earrape']);
    expect(h.$('songsBlocklist').textContent).toContain('earrape');
    click(h.$('songsBlocklist').querySelector('.mgr-chip-remove')!);
    await settle();
    expect(d.readJson('song-blocklist.json').keywords).toEqual([]);

    h.window.eval('mgrClearQueue()');
    await settle();
    expect(h.$('songsStatus').textContent).toBe('Cleared the queue.');
  });

  it('Song Queue: the page cannot add songs (that charges points, so it stays bot-only)', async () => {
    const res = await httpRequest(d.port, 'POST', '/api/song-queue/add', {
      headers: { origin: `http://127.0.0.1:${d.port}` },
      body: { videoId: 'v', title: 't', requester: 'u' }
    });
    expect(res.status).toBe(403);
  });

  it('Loyalty: saving settings and setting a viewer\'s points', async () => {
    await show('loyalty');
    h.$('loyaltyPointsPerMessage').value = '8';
    h.$('loyaltyCurrencyNamePlural').value = 'gems';
    h.window.eval('mgrSaveLoyaltyConfig()');
    await settle();
    expect(h.$('loyaltyStatus').textContent).toBe('Points settings saved.');
    expect(d.readJson('loyalty.json').config).toMatchObject({ pointsPerMessage: 8, currencyNamePlural: 'gems' });

    h.$('loyaltyUser').value = 'Viewer_1';
    h.$('loyaltyPoints').value = '750';
    h.window.eval('mgrSetUserPoints()');
    await settle();
    expect(d.readJson('loyalty.json').users.viewer_1.points).toBe(750);
    expect(h.$('loyaltyLeaderboard').textContent).toContain('viewer_1');
    expect(h.$('loyaltyStats').textContent).toContain('gems held');
  });

  it('Quotes: add, search, edit and delete', async () => {
    await show('quotes');
    h.$('quoteText').value = 'The first quote ever';
    h.$('quoteGame').value = 'Chess';
    h.window.eval('mgrAddQuote()');
    await settle();
    expect(h.$('quotesStatus').textContent).toBe('Added quote #1.');
    expect(h.$('quotesList').textContent).toContain('The first quote ever');

    (h.window as unknown as { prompt: () => string }).prompt = () => 'An edited quote';
    click([...h.$('quotesList').querySelectorAll('button')].find(b => b.textContent === 'Edit')!);
    await settle();
    expect(d.readJson('quotes.json').quotes[0].text).toBe('An edited quote');

    h.$('quotesSearch').value = 'nothing-matches';
    h.window.eval('mgrLoadQuotes(1)');
    await settle();
    expect(h.$('quotesList').textContent).toBe('No quotes match your search.');
    h.$('quotesSearch').value = '';
    h.window.eval('mgrLoadQuotes(1)');
    await settle();

    click([...h.$('quotesList').querySelectorAll('button')].find(b => b.textContent === 'Delete')!);
    await settle();
    expect(d.readJson('quotes.json').quotes).toEqual([]);
  });

  it('Counters: create, count up and down, set and delete', async () => {
    await show('counters');
    h.$('newCounterName').value = 'falls';
    h.$('newCounterInitial').value = '2';
    h.window.eval('mgrCreateCounter()');
    await settle();
    const row = () => [...h.$('countersList').querySelectorAll('tr')].find(r => r.textContent!.startsWith('falls'))!;
    const press = async (label: string) => {
      click([...row().querySelectorAll('button')].find(b => b.textContent === label)!);
      await settle();
    };
    await press('+');
    await press('+');
    await press('−');
    expect(d.readJson('counters.json').counters.falls.value).toBe(3);
    row().querySelector('input')!.value = '40';
    await press('Set');
    expect(d.readJson('counters.json').counters.falls.value).toBe(40);
    await press('Reset');
    expect(d.readJson('counters.json').counters.falls.value).toBe(0);
    await press('Delete');
    expect(d.readJson('counters.json').counters.falls).toBeUndefined();
  });

  it('Backups: create, restore and delete', async () => {
    await show('quotes');
    h.$('quoteText').value = 'Keep me safe';
    h.window.eval('mgrAddQuote()');
    await settle();

    await show('backups');
    h.window.eval('mgrCreateBackup()');
    await settle();
    expect(h.$('backupsStatus').textContent).toMatch(/^Created backup-.*\.json\.$/);
    expect(h.$('backupsList').querySelectorAll('tr')).toHaveLength(1);

    // Lose the quote, then restore it from the backup
    d.writeJson('quotes.json', { quotes: [], config: {}, nextId: 1 });
    click([...h.$('backupsList').querySelectorAll('button')].find(b => b.textContent === 'Restore')!);
    await settle();
    expect(h.$('backupsStatus').textContent).toContain('Restored');
    expect(d.readJson('quotes.json').quotes[0].text).toBe('Keep me safe');

    click([...h.$('backupsList').querySelectorAll('button')].find(b => b.textContent === 'Delete')!);
    await settle();
    expect(h.$('backupsList').textContent).toBe('No backups yet.');
  });
});
