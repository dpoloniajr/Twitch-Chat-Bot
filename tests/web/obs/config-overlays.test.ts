/** @jest-environment jsdom */
/**
 * Characterization tests for the overlays configured from GET /obs/config:
 * chat-box, goal-bar and recent-events (compiled from src/web/obs/overlays/*.ts).
 */
import { loadOverlay, flush, OverlayHarness, LoadOverlayOptions } from '../support/obs-overlay-harness';

const OBS_CONFIG = {
  overlays: {
    alerts: { enabled: true, volume: 0.8, duration: 5 },
    recentEvents: { enabled: true, limit: 3, showTime: true },
    chatBox: { enabled: true, messageTimeout: 4, hideBot: false },
    goalBar: { enabled: true, type: 'follow', goal: 200 },
  },
};

function withConfig(overlays: Record<string, unknown>) {
  return { '/obs/config': { body: { overlays: { ...OBS_CONFIG.overlays, ...overlays } } } };
}

async function load(page: string, opts: LoadOverlayOptions = {}): Promise<OverlayHarness> {
  const h = loadOverlay(page, { ...opts, routes: { '/obs/config': { body: OBS_CONFIG }, ...(opts.routes ?? {}) } });
  await flush();
  return h;
}

describe('OBS overlays configured by /obs/config', () => {
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

  describe('chat-box.html', () => {
    const messages = () => Array.from(h.$('chat-messages').querySelectorAll('.chat-message'));

    it('fetches /obs/config, then connects and renders chat messages HTML-escaped', async () => {
      h = await load('chat-box');
      expect(h.fetchCalls.map(c => c.url)).toEqual(['/obs/config']);
      expect(h.sockets).toHaveLength(1);
      expect(h.window.client).toBeDefined();

      h.ws.emit('chat', { username: '<b>Eve</b>', message: '<img src=x onerror=alert(1)>', timestamp: 't1' });
      const [m] = messages();
      expect(m.className).toBe('chat-message fadeInUp');
      expect(m.querySelector('.chat-username')!.textContent).toBe('<b>Eve</b>:');
      expect(m.querySelector('.chat-text')!.textContent).toBe('<img src=x onerror=alert(1)>');
      expect(m.querySelector('img')).toBeNull();
      expect((m.querySelector('.chat-username') as HTMLElement).style.color).toBe('rgb(145, 71, 255)');
      expect(h.window.chatMessages).toHaveLength(1);
    });

    it('falls back from username to user to "Unknown"', async () => {
      h = await load('chat-box');
      h.ws.emit('chat', { user: 'plainuser', message: 'a', timestamp: '1' });
      h.ws.emit('chat', { message: 'b', timestamp: '2' });
      expect(messages().map(m => m.querySelector('.chat-username')!.textContent)).toEqual(['plainuser:', 'Unknown:']);
    });

    it('removes each message after messageTimeout (config seconds) and shows the waiting text', async () => {
      h = await load('chat-box');
      h.ws.emit('chat', { username: 'a', message: '1', timestamp: 't1' });
      jest.advanceTimersByTime(1000);
      h.ws.emit('chat', { username: 'b', message: '2', timestamp: 't2' });
      jest.advanceTimersByTime(2999);
      expect(messages()).toHaveLength(2);
      jest.advanceTimersByTime(1);
      expect(messages().map(m => m.querySelector('.chat-text')!.textContent)).toEqual(['2']);
      jest.advanceTimersByTime(1000);
      expect(messages()).toHaveLength(0);
      expect(h.$('chat-messages').textContent).toBe('Waiting for chat messages...');
    });

    it('keeps only ?limit messages; ?timeout overrides the config', async () => {
      h = await load('chat-box', { query: '?limit=2&timeout=500' });
      for (const n of ['1', '2', '3']) h.ws.emit('chat', { username: `u${n}`, message: n, timestamp: n });
      expect(messages().map(m => m.querySelector('.chat-text')!.textContent)).toEqual(['2', '3']);
      jest.advanceTimersByTime(500);
      expect(messages()).toHaveLength(0);
    });

    it('trimming a message clears its fade-out timer, so it cannot remove a later message with the same id', async () => {
      h = await load('chat-box', { query: '?limit=1&timeout=1000' });
      h.ws.emit('chat', { username: 'same', message: 'first', timestamp: 't' });
      jest.advanceTimersByTime(600);
      const timersWithOne = jest.getTimerCount();
      // same username + timestamp, so the old id-based lookup could not tell them apart
      h.ws.emit('chat', { username: 'same', message: 'second', timestamp: 't' });
      expect(messages().map(m => m.querySelector('.chat-text')!.textContent)).toEqual(['second']);
      // the trimmed message's timer was cleared: still one fade-out timer pending
      expect(jest.getTimerCount()).toBe(timersWithOne);

      jest.advanceTimersByTime(400);
      expect(messages().map(m => m.querySelector('.chat-text')!.textContent)).toEqual(['second']);
      jest.advanceTimersByTime(600);
      expect(messages()).toHaveLength(0);
      expect(jest.getTimerCount()).toBe(timersWithOne - 1);
    });

    it('two visible messages sharing an id each fade on their own timer', async () => {
      h = await load('chat-box', { query: '?timeout=1000' });
      h.ws.emit('chat', { username: 'same', message: 'a', timestamp: 't' });
      jest.advanceTimersByTime(500);
      h.ws.emit('chat', { username: 'same', message: 'b', timestamp: 't' });
      jest.advanceTimersByTime(500);
      expect(messages().map(m => m.querySelector('.chat-text')!.textContent)).toEqual(['b']);
      jest.advanceTimersByTime(500);
      expect(messages()).toHaveLength(0);
    });

    it('hideBot drops broadcaster messages from Excella; ?hideCommands drops !commands; ?colorByRole colors names', async () => {
      h = await load('chat-box', { routes: withConfig({ chatBox: { messageTimeout: 8, hideBot: true } }), query: '?hideCommands=true&colorByRole=true' });
      h.ws.emit('chat', { user: 'Excella', username: 'Excella', isBroadcaster: true, message: 'bot says', timestamp: '1' });
      h.ws.emit('chat', { username: 'viewer', message: '!so someone', timestamp: '2' });
      h.ws.emit('chat', { username: 'mod1', role: 'Moderator', message: 'hello', timestamp: '3' });
      const shown = messages();
      expect(shown).toHaveLength(1);
      expect((shown[0].querySelector('.chat-username') as HTMLElement).style.color).toBe('rgb(30, 144, 255)');
    });

    it('uses defaults when /obs/config fails and exposes testMessage()', async () => {
      h = await load('chat-box', { routes: { '/obs/config': { networkError: true } } });
      expect(h.logs.error.some(a => a[0] === 'Failed to load OBS config, using defaults:')).toBe(true);
      h.window.testMessage();
      expect(messages()[0].querySelector('.chat-text')!.textContent).toBe('Hello chat!');
      jest.advanceTimersByTime(8000);
      expect(messages()).toHaveLength(0);
    });
  });

  describe('goal-bar.html', () => {
    it('applies the goal from /obs/config and counts follow alerts and eventsub follows', async () => {
      h = await load('goal-bar');
      expect(h.$('goal-title').textContent).toBe('Follower Goal');
      expect(h.$('goal-progress').classList.contains('goal-follow')).toBe(true);
      expect(h.$('goal-text').textContent).toBe('0 / 200');
      expect(h.$('goal-target').textContent).toBe('200');
      expect(h.$('goal-remaining').textContent).toBe('200');

      h.ws.emit('alert', { alertType: 'follow', user: 'a' });
      h.ws.emit('eventsub-event', { event: 'follow' });
      h.ws.emit('alert', { alertType: 'subscription', user: 'b' });
      expect(h.$('goal-current').textContent).toBe('2');
      expect(h.$('goal-progress').style.width).toBe('1%');
      expect(h.$('goal-percentage').textContent).toBe('1%');
      expect(h.$('goal-remaining').textContent).toBe('198');
    });

    it('subscriber goals count subscriptions only; URL params override the config', async () => {
      h = await load('goal-bar', {
        routes: withConfig({ goalBar: { type: 'subscriber', goal: 50 } }),
        query: '?goal=4&current=3&title=Sub%20Train',
      });
      expect(h.$('goal-title').textContent).toBe('Sub Train');
      expect(h.$('goal-progress').classList.contains('goal-subscriber')).toBe(true);
      expect(h.$('goal-text').textContent).toBe('3 / 4');
      h.ws.emit('alert', { alertType: 'follow' });
      h.ws.emit('eventsub-event', { event: 'subscription' });
      h.ws.emit('alert', { alertType: 'subscription' });
      expect(h.$('goal-text').textContent).toBe('5 / 4');
      expect(h.$('goal-progress').style.width).toBe('100%');
      expect(h.$('goal-remaining').textContent).toBe('0');
    });

    it('exposes test helpers and formats large numbers', async () => {
      h = await load('goal-bar', { routes: withConfig({ goalBar: { type: 'follow', goal: 5000 } }) });
      h.window.testSet(1234);
      expect(h.$('goal-text').textContent).toBe('1,234 / 5,000');
      h.window.testIncrement();
      expect(h.$('goal-current').textContent).toBe('1,235');
      h.window.testDecrement();
      h.window.testDecrement();
      expect(h.$('goal-current').textContent).toBe('1,233');
      h.window.testSet(99999);
      expect(h.$('goal-current').textContent).toBe('5,000');
      expect(h.window.config.goalTarget).toBe(5000);
    });

    it('keeps the built-in defaults when /obs/config fails', async () => {
      h = await load('goal-bar', { routes: { '/obs/config': { status: 500, body: 'oops' } } });
      expect(h.logs.error.some(a => a[0] === 'Failed to load OBS config, using defaults:')).toBe(true);
      expect(h.$('goal-text').textContent).toBe('0 / 1,000');
      expect(h.sockets).toHaveLength(1);
    });
  });

  describe('recent-events.html', () => {
    const EVENTS = [
      { type: 'follow', user: 'fol', timestamp: '2026-05-01T11:58:00Z' },
      { type: 'subscription', user: 'sub', tier: '3000', timestamp: '2026-05-01T09:00:00Z' },
      { type: 'bits', user: 'bit', amount: 2500 },
      { type: 'raid', user: 'rai', viewers: 1200 },
      { type: 'redemption', user: 'red', reward: 'Hydrate' },
    ];
    const items = () => Array.from(h.$('events-list').querySelectorAll('.recent-event-item'));
    const texts = () => items().map(i => i.querySelector('.event-text')!.textContent);

    it('fetches /obs/config then /obs/recent and renders up to the configured limit', async () => {
      h = await load('recent-events', { routes: { '/obs/recent': { body: { events: EVENTS } } } });
      expect(h.fetchCalls.map(c => c.url)).toEqual(['/obs/config', '/obs/recent']);
      expect(texts()).toEqual(['fol followed', 'sub subscribed (Tier 3)', 'bit cheered 2,500 bits']);
      expect(items()[0].className).toBe('recent-event-item follow');
      expect(items()[0].querySelector('.event-icon')!.textContent).toBe('👤');
      expect(items()[0].querySelector('.event-time')!.textContent).toBe('2m ago');
      expect(items()[1].querySelector('.event-time')!.textContent).toBe('3h ago');
      expect(items()[2].querySelector('.event-time')).toBeNull();
    });

    it('renders raid / redemption / unknown types and escapes the text', async () => {
      h = await load('recent-events', {
        query: '?limit=10&showTime=false',
        routes: { '/obs/recent': { body: { events: [...EVENTS.slice(3), { type: 'hype', user: '<i>x</i>', timestamp: '2026-05-01T11:00:00Z' }] } } },
      });
      expect(texts()).toEqual(['rai raided with 1,200 viewers', 'red redeemed Hydrate', '<i>x</i> hype']);
      expect(items()[2].querySelector('.event-icon')!.textContent).toBe('•');
      expect(items()[2].querySelector('i')).toBeNull();
      expect(h.$('events-list').querySelector('.event-time')).toBeNull();
    });

    it('prepends alert and eventsub events, capped at maxEvents', async () => {
      h = await load('recent-events', { routes: { '/obs/recent': { body: { events: EVENTS.slice(0, 3) } } } });
      h.ws.emit('alert', { alertType: 'raid', user: 'newraid', viewers: 3 });
      expect(texts()).toEqual(['newraid raided with 3 viewers', 'fol followed', 'sub subscribed (Tier 3)']);
      h.ws.emit('eventsub-event', { foo: 'ignored' });
      expect(items()).toHaveLength(3);
      h.ws.emit('eventsub-event', { event: 'follow', type: 'follow', user: 'evsub' });
      expect(texts()[0]).toBe('evsub followed');
      expect(items()).toHaveLength(3);
    });

    it('re-fetches every 5 seconds and uses /obs/recent/:type for ?type', async () => {
      h = await load('recent-events', { query: '?type=follow', routes: { '/obs/recent/follow': { body: { events: [] } } } });
      expect(h.callsTo('/obs/recent/follow')).toHaveLength(1);
      expect(h.$('events-list').textContent).toBe('No events yet');
      await jest.advanceTimersByTimeAsync(5000);
      expect(h.callsTo('/obs/recent/follow')).toHaveLength(2);
    });

    it('logs and keeps the list when the events request fails', async () => {
      h = await load('recent-events', { routes: { '/obs/recent': { networkError: true } } });
      expect(h.logs.error.some(a => a[0] === '[RecentEventsOverlay] Failed to fetch events:')).toBe(true);
      expect(h.$('events-list').innerHTML).toBe('');
    });
  });
});
