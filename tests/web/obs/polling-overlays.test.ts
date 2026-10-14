/** @jest-environment jsdom */
/**
 * Characterization tests for the URL-parameter driven polling overlays:
 * counter-display, leaderboard and quote-display (compiled from src/web/obs/overlays/*.ts).
 */
import { loadOverlay, flush, OverlayHarness, LoadOverlayOptions } from '../support/obs-overlay-harness';

async function load(page: string, opts: LoadOverlayOptions = {}): Promise<OverlayHarness> {
  const h = loadOverlay(page, opts);
  await flush();
  return h;
}

describe('OBS polling overlays', () => {
  let h: OverlayHarness;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-01T12:00:00Z'));
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    h?.window.close();
  });

  describe('counter-display.html', () => {
    it('single mode: shows the named counter from /api/counters and highlights changes', async () => {
      let deaths = 1234;
      h = await load('counter-display', { routes: { '/api/counters': () => ({ body: { counters: { deaths } } }) } });
      expect(h.fetchCalls.map(c => c.url)).toEqual(['/api/counters']);
      expect(h.$('single-counter').classList.contains('hidden')).toBe(false);
      expect(h.$('counter-label').textContent).toBe('Deaths');
      expect(h.$('counter-value').textContent).toBe('1,234');
      expect(h.$('main-counter').classList.contains('highlight')).toBe(true);
      jest.advanceTimersByTime(2000);
      expect(h.$('main-counter').classList.contains('highlight')).toBe(false);

      deaths = 1000;
      await jest.advanceTimersByTimeAsync(5000 - 2000);
      expect(h.fetchCalls).toHaveLength(2);
      expect(h.$('counter-value').textContent).toBe('1,000');
      expect(h.$('main-counter').className).toBe('counter-item highlight decrease');
    });

    it('reads the real /api/counters array response (one object per counter)', async () => {
      h = await load('counter-display', { routes: { '/api/counters': { body: [{ name: 'wins', value: 2 }, { name: 'deaths', value: 7 }] } } });
      expect(h.$('counter-value').textContent).toBe('7');
    });

    it('updates live from counter-update broadcasts (the GET /api/counters array) and keeps polling', async () => {
      let counters = [{ name: 'deaths', value: 1 }];
      h = await load('counter-display', {
        query: '?mode=multi&counters=deaths,wins&poll=10000',
        routes: { '/api/counters': () => ({ body: counters }) },
      });
      expect(h.$('value-deaths').textContent).toBe('1');

      h.ws.emit('counter-update', [{ name: 'deaths', value: 1 }, { name: 'wins', value: 1500 }]);
      expect(h.$('value-wins').textContent).toBe('1,500');
      expect(h.$('counter-wins').classList.contains('highlight')).toBe(true);
      expect(h.fetchCalls).toHaveLength(1);

      // a deleted counter is missing from the array and falls back to 0
      h.ws.emit('counter-update', [{ name: 'wins', value: 1500 }]);
      expect(h.$('value-deaths').textContent).toBe('0');

      // payloads without counter data are ignored
      h.ws.emit('counter-update', null);
      h.ws.emit('counter-update', 'nope');
      expect(h.$('value-wins').textContent).toBe('1,500');

      // polling remains as a fallback for missed messages
      counters = [{ name: 'deaths', value: 4 }, { name: 'wins', value: 9 }];
      await jest.advanceTimersByTimeAsync(10000);
      expect(h.fetchCalls).toHaveLength(2);
      expect(h.$('value-deaths').textContent).toBe('4');
      expect(h.$('value-wins').textContent).toBe('9');
    });

    it('score mode reads wins/losses from the array shape', async () => {
      h = await load('counter-display', { query: '?mode=score', routes: { '/api/counters': { body: [] } } });
      h.ws.emit('counter-update', [{ name: 'wins', value: 1 }, { name: 'losses', value: 3 }]);
      expect(h.$('winrate-value').textContent).toBe('25.0% Win Rate');
    });

    it('multi mode builds one item per ?counters entry; counter-update WS messages update it', async () => {
      h = await load('counter-display', {
        query: '?mode=multi&counters=wins,kills&poll=60000&api=/custom',
        routes: { '/custom': { body: { wins: 3 } } },
      });
      expect(h.fetchCalls.map(c => c.url)).toEqual(['/custom']);
      expect(h.$('multi-counter').classList.contains('hidden')).toBe(false);
      expect(h.$('counter-wins').querySelector('.counter-label')!.textContent).toBe('Wins');
      expect(h.$('value-wins').textContent).toBe('3');
      expect(h.$('value-kills').textContent).toBe('0');
      expect(h.$('counter-wins').classList.contains('highlight')).toBe(true);

      h.ws.emit('counter-update', { counters: { wins: 3, kills: 2500 } });
      expect(h.$('value-kills').textContent).toBe('2,500');
    });

    it('multi mode renders ?counters names as text, not markup', async () => {
      const evil = '<img src=x onerror="window.pwned=1">';
      h = await load('counter-display', {
        query: `?mode=multi&counters=${encodeURIComponent(evil)},wins`,
        routes: { '/api/counters': { body: [{ name: evil, value: 4 }, { name: 'wins', value: 1 }] } },
      });
      expect(h.$('multi-counter').querySelector('img')).toBeNull();
      expect(h.$(`counter-${evil}`).querySelector('.counter-label')!.textContent).toBe(evil);
      expect(h.$(`value-${evil}`).textContent).toBe('4');
      expect(h.$('value-wins').textContent).toBe('1');
      expect(h.window.pwned).toBeUndefined();
    });

    it('score mode shows wins, losses and the win rate', async () => {
      h = await load('counter-display', { query: '?mode=score', routes: { '/api/counters': { body: { wins: 3, losses: 1 } } } });
      expect(h.$('score-display').classList.contains('hidden')).toBe(false);
      expect(h.$('wins-value').textContent).toBe('3');
      expect(h.$('losses-value').textContent).toBe('1');
      expect(h.$('winrate-value').textContent).toBe('75.0% Win Rate');
      h.ws.emit('counter-update', { wins: 0, losses: 0 });
      expect(h.$('winrate-value').textContent).toBe('0.0% Win Rate');
    });

    it('logs fetch failures', async () => {
      h = await load('counter-display', { routes: { '/api/counters': { networkError: true } } });
      expect(h.logs.error.some(a => a[0] === '[Counter] Failed to fetch:')).toBe(true);
    });
  });

  describe('leaderboard.html', () => {
    const rows = () => Array.from(h.$('leaderboard-list').querySelectorAll('.leaderboard-item'));

    it('fetches the leaderboard with ?limit, renders medals, escaped names and formatted points', async () => {
      h = await load('leaderboard', {
        routes: {
          '/api/loyalty/leaderboard?limit=5': { body: { leaderboard: [
            { username: 'gold<script>', points: 12345, level: { name: 'Legend' } },
            { username: 'silver', points: 900, level: { level: 4 } },
            { username: 'bronze', points: 10 },
            { username: 'fourth', points: 1 },
          ] } },
        },
      });
      expect(h.fetchCalls.map(c => c.url)).toEqual(['/api/loyalty/leaderboard?limit=5']);
      expect(rows().map(r => r.querySelector('.leaderboard-rank')!.textContent)).toEqual(['🥇', '🥈', '🥉', '#4']);
      expect(rows()[0].querySelector('.leaderboard-username')!.textContent).toBe('gold<script>');
      expect(rows()[0].querySelector('.leaderboard-points-value')!.textContent).toBe('12,345');
      expect(rows()[0].querySelector('.leaderboard-level')!.textContent).toBe('Legend');
      expect(rows()[1].querySelector('.leaderboard-level')!.textContent).toBe('Level 4');
      expect(rows()[2].querySelector('.leaderboard-level')).toBeNull();
      expect(h.$('update-time').textContent).toMatch(/^Updated /);
      expect(h.document.querySelector('.leaderboard-title')!.textContent).toBe('Top Chatters');
    });

    it('renders the numeric level the API sends as "Level N"', async () => {
      h = await load('leaderboard', {
        routes: { '/api/loyalty/leaderboard?limit=5': { body: [
          { username: 'a', points: 5, level: 2, rank: 1 },
          { username: 'b', points: 4, level: 0, rank: 2 },
          { username: 'c', points: 3, level: { name: '<b>Boss</b>' }, rank: 3 },
          { username: 'd', points: 2, level: {}, rank: 4 },
        ] } },
      });
      const levels = rows().map(r => r.querySelector('.leaderboard-level')?.textContent ?? null);
      expect(levels).toEqual(['Level 2', 'Level 0', '<b>Boss</b>', null]);
      expect(h.$('leaderboard-list').querySelector('b')).toBeNull();
      expect(h.$('leaderboard-list').textContent).not.toContain('undefined');
    });

    it('updates live from loyalty-update broadcasts (top-100 array), trimmed to ?limit, and keeps polling', async () => {
      let board = [{ username: 'polled', points: 1, level: 1, rank: 1 }];
      h = await load('leaderboard', {
        query: '?limit=2&poll=10000',
        routes: { '/api/loyalty/leaderboard?limit=2': () => ({ body: board }) },
      });
      expect(rows()).toHaveLength(1);

      const broadcast = Array.from({ length: 100 }, (_, i) => ({ username: `u${i}`, points: 1000 - i, level: 3, rank: i + 1 }));
      h.ws.emit('loyalty-update', broadcast);
      expect(rows().map(r => r.querySelector('.leaderboard-username')!.textContent)).toEqual(['u0', 'u1']);
      expect(rows()[0].querySelector('.leaderboard-level')!.textContent).toBe('Level 3');
      expect(h.fetchCalls).toHaveLength(1);

      // the polling fallback still runs
      board = [{ username: 'later', points: 2, level: 1, rank: 1 }];
      await jest.advanceTimersByTimeAsync(10000);
      expect(h.fetchCalls).toHaveLength(2);
      expect(rows().map(r => r.querySelector('.leaderboard-username')!.textContent)).toEqual(['later']);
    });

    it('a ?limit above the broadcast size re-fetches on loyalty-update instead of truncating', async () => {
      h = await load('leaderboard', {
        query: '?limit=150&poll=600000',
        routes: { '/api/loyalty/leaderboard?limit=150': { body: [] } },
      });
      h.ws.emit('loyalty-update', [{ username: 'x', points: 1 }]);
      await flush();
      expect(h.callsTo('/api/loyalty/leaderboard?limit=150')).toHaveLength(2);
      h.ws.emit('loyalty-update', { unrelated: true });
      await flush();
      expect(h.callsTo('/api/loyalty/leaderboard?limit=150')).toHaveLength(2);
    });

    it('shows rank changes between polls and honours ?level=false, ?title, ?poll, ?api', async () => {
      let board = [{ username: 'a', points: 3 }, { username: 'b', points: 2 }];
      h = await load('leaderboard', {
        query: '?limit=2&poll=1000&api=/lb&level=false&title=Whales',
        routes: { '/lb?limit=2': () => ({ body: board }) },
      });
      expect(h.document.querySelector('.leaderboard-title')!.textContent).toBe('Whales');
      board = [{ username: 'b', points: 5 }, { username: 'a', points: 3 }];
      await jest.advanceTimersByTimeAsync(1000);
      expect(rows()[0].querySelector('.rank-change')!.className).toBe('rank-change rank-up');
      expect(rows()[0].querySelector('.rank-change')!.textContent).toBe('▲1');
      expect(rows()[1].querySelector('.rank-change')!.textContent).toBe('▼1');
    });

    it('shows "No data yet" for an empty board; loyalty-update WS messages re-render', async () => {
      h = await load('leaderboard', { routes: { '/api/loyalty/leaderboard?limit=5': { body: [] } } });
      expect(h.$('leaderboard-list').innerHTML).toBe('<li class="empty">No data yet</li>');
      h.ws.emit('loyalty-update', { other: true });
      expect(h.$('leaderboard-list').innerHTML).toBe('<li class="empty">No data yet</li>');
      h.ws.emit('loyalty-update', { leaderboard: [{ username: 'ws', points: 1 }] });
      expect(rows()).toHaveLength(1);
    });

    it('logs fetch failures', async () => {
      h = await load('leaderboard', { routes: { '/api/loyalty/leaderboard?limit=5': { networkError: true } } });
      expect(h.logs.error.some(a => a[0] === '[Leaderboard] Failed to fetch:')).toBe(true);
      expect(h.$('update-time').textContent).toBe('Loading...');
    });
  });

  describe('quote-display.html', () => {
    const QUOTE = { id: 7, text: 'To be or not', author: 'Will', game: 'Hamlet', addedAt: '2026-01-02T12:00:00Z' };

    it('fetches a random quote and shows text, id, author, game and date', async () => {
      h = await load('quote-display', { routes: { '/api/quotes/random': { body: QUOTE } } });
      expect(h.fetchCalls.map(c => c.url)).toEqual(['/api/quotes/random']);
      expect(h.$('quote-text').textContent).toBe('To be or not');
      expect(h.$('quote-id').textContent).toBe('#7');
      expect(h.$('quote-author').textContent).toBe('— Will');
      expect(h.$('quote-game').textContent).toBe('Hamlet');
      expect(h.$('quote-date').textContent).toBe(` • ${new Date(QUOTE.addedAt).toLocaleDateString()}`);
      expect(h.$('quote-container').className).toBe('quote-container show');
    });

    it('?author/game/date=false hide fields; ?mode adds a class; ?duration auto-hides', async () => {
      h = await load('quote-display', {
        query: '?author=false&game=false&date=false&mode=compact&duration=3000',
        routes: { '/api/quotes/random': { body: { quote: QUOTE } } },
      });
      expect(h.$('quote-container').classList.contains('compact')).toBe(true);
      expect(h.$('quote-author').style.display).toBe('none');
      expect(h.$('quote-game').style.display).toBe('none');
      expect(h.$('quote-date').textContent).toBe('');
      jest.advanceTimersByTime(3000);
      expect(h.$('quote-container').className).toBe('quote-container compact hide');
      jest.advanceTimersByTime(500);
      expect(h.$('quote-container').classList.contains('hidden')).toBe(true);
    });

    it('quote-display / quote-command show a quote; quote-hide hides it', async () => {
      h = await load('quote-display', { routes: { '/api/quotes/random': { status: 404, body: { error: 'No quotes available' } } } });
      expect(h.$('quote-container').classList.contains('hidden')).toBe(true);
      h.ws.emit('quote-display', { quote: { id: 1, text: 'From WS' } });
      expect(h.$('quote-text').textContent).toBe('From WS');
      expect(h.$('quote-author').style.display).toBe('none');
      h.ws.emit('quote-hide');
      jest.advanceTimersByTime(500);
      expect(h.$('quote-container').classList.contains('hidden')).toBe(true);
      h.ws.emit('quote-command', { quote: { id: 2, text: 'From chat' } });
      expect(h.$('quote-text').textContent).toBe('From chat');
      expect(h.$('quote-container').className).toBe('quote-container show');
    });

    describe('quote-update broadcasts', () => {
      it('an edit of the quote on screen updates it in place without re-showing it', async () => {
        h = await load('quote-display', { query: '?duration=3000', routes: { '/api/quotes/random': { body: QUOTE } } });
        await jest.advanceTimersByTimeAsync(3500);
        expect(h.$('quote-container').classList.contains('hidden')).toBe(true);

        h.ws.emit('quote-update', { ...QUOTE, id: '7', text: 'Edited', author: 'Bill' });
        expect(h.$('quote-text').textContent).toBe('Edited');
        expect(h.$('quote-author').textContent).toBe('— Bill');
        expect(h.$('quote-container').classList.contains('hidden')).toBe(true);
      });

      it('updates to other quotes leave the display alone', async () => {
        h = await load('quote-display', { routes: { '/api/quotes/random': { body: QUOTE } } });
        h.ws.emit('quote-update', { id: 8, text: 'Another one' });
        h.ws.emit('quote-update', { id: 8, deleted: true });
        h.ws.emit('quote-update', { imported: 3 });
        h.ws.emit('quote-update', { config: {} });
        h.ws.emit('quote-update', null);
        await flush();
        expect(h.$('quote-text').textContent).toBe('To be or not');
        expect(h.callsTo('/api/quotes/random')).toHaveLength(1);
      });

      it('deleting the quote on screen swaps in another random quote', async () => {
        let next: object = QUOTE;
        h = await load('quote-display', { routes: { '/api/quotes/random': () => ({ body: next }) } });
        next = { id: 9, text: 'Replacement' };
        h.ws.emit('quote-update', { id: 7, deleted: true });
        await flush();
        expect(h.$('quote-text').textContent).toBe('Replacement');
        jest.advanceTimersByTime(1000);
        expect(h.$('quote-container').className).toBe('quote-container show');
      });

      it('deleting the last quote hides the display', async () => {
        let random: { status?: number; body: object } = { body: QUOTE };
        h = await load('quote-display', { routes: { '/api/quotes/random': () => random } });
        random = { status: 404, body: { error: 'No quotes available' } };
        h.ws.emit('quote-update', { id: 7, deleted: true });
        await flush();
        jest.advanceTimersByTime(500);
        expect(h.$('quote-container').classList.contains('hidden')).toBe(true);
      });

      it('with nothing on screen, a new quote is shown and an import triggers a fetch', async () => {
        h = await load('quote-display', { routes: { '/api/quotes/random': { status: 404, body: { error: 'No quotes available' } } } });
        h.ws.emit('quote-update', { imported: 2 });
        await flush();
        expect(h.callsTo('/api/quotes/random')).toHaveLength(2);

        h.ws.emit('quote-update', { id: 1, text: 'First quote' });
        expect(h.$('quote-text').textContent).toBe('First quote');
        expect(h.$('quote-container').className).toBe('quote-container show');
      });
    });

    it('?rotate=true re-fetches every ?interval', async () => {
      h = await load('quote-display', { query: '?rotate=true&interval=10000', routes: { '/api/quotes/random': { body: QUOTE } } });
      await jest.advanceTimersByTimeAsync(20000);
      expect(h.callsTo('/api/quotes/random')).toHaveLength(3);
    });

    it('logs fetch failures', async () => {
      h = await load('quote-display', { routes: { '/api/quotes/random': { networkError: true } } });
      expect(h.logs.error.some(a => a[0] === '[Quote] Failed to fetch:')).toBe(true);
      expect(h.$('quote-text').textContent).toBe('Loading...');
    });
  });
});
