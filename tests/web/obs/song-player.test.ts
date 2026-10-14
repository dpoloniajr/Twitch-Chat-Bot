/** @jest-environment jsdom */
/**
 * Characterization tests for obs/overlays/song-player.html + song-player.js
 * (compiled from src/web/obs/overlays/song-player.ts), with a fake YouTube IFrame API.
 */
import { loadOverlay, flush, click, OverlayHarness, LoadOverlayOptions, RouteSpec } from '../support/obs-overlay-harness';

const SONG1 = {
  id: 's1', videoId: 'vid1', title: 'First Song', channelTitle: 'Chan One',
  requester: 'req1', requesterDisplayName: 'Req One', durationFormatted: '3:20',
};
const SONG2 = { id: 's2', videoId: 'vid2', title: 'Second Song', channelTitle: 'Chan Two', requester: 'req2', durationFormatted: '1:05' };
const SONG3 = { id: 's3', thumbnail: 'https://img.example/x/mqdefault.jpg', title: 'Third', requester: 'r3' };

const STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };

class FakePlayer {
  static last: FakePlayer | null = null;
  elementId: string;
  options: any;
  state = STATE.UNSTARTED;
  current = 0;
  duration = 0;
  loadVideoById = jest.fn();
  playVideo = jest.fn();
  pauseVideo = jest.fn();
  stopVideo = jest.fn();
  seekTo = jest.fn();
  unMute = jest.fn();
  setVolume = jest.fn();
  constructor(elementId: string, options: any) {
    this.elementId = elementId;
    this.options = options;
    FakePlayer.last = this;
  }
  getPlayerState(): number {
    return this.state;
  }
  getCurrentTime(): number {
    return this.current;
  }
  getDuration(): number {
    return this.duration;
  }
  /** fire onStateChange like the IFrame API */
  setState(state: number): void {
    this.state = state;
    this.options.events.onStateChange({ target: this, data: state });
  }
}

async function load(queue: unknown[] | RouteSpec, opts: LoadOverlayOptions = {}): Promise<OverlayHarness> {
  const queueRoute: RouteSpec = Array.isArray(queue) ? { body: { active: queue, history: [], config: {} } } : queue;
  const h = loadOverlay('song-player', {
    ...opts,
    routes: { '/api/song-queue': queueRoute, 'POST /api/song-queue/skip': { body: { success: true } }, ...(opts.routes ?? {}) },
  });
  await flush();
  return h;
}

/** Install the fake YT global and fire the IFrame API ready callbacks. */
function ytReady(h: OverlayHarness): FakePlayer {
  h.window.YT = { PlayerState: STATE, Player: FakePlayer };
  h.window.onYouTubeIframeAPIReady();
  const player = FakePlayer.last as FakePlayer;
  player.options.events.onReady({ target: player });
  return player;
}

describe('obs/overlays/song-player.html', () => {
  let h: OverlayHarness;

  beforeEach(() => {
    jest.useFakeTimers();
    FakePlayer.last = null;
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    h?.window.close();
  });

  it('injects the YouTube IFrame API script and starts with disabled controls and default position/theme', async () => {
    h = await load([]);
    const yt = Array.from(h.document.querySelectorAll('script')).find(s => s.getAttribute('src') === 'https://www.youtube.com/iframe_api');
    expect(yt).toBeDefined();
    expect(h.$('player-anchor').className).toBe('player-anchor bottom-left');
    expect(h.document.body.className).toBe('');
    expect([h.$('btn-play-pause').disabled, h.$('btn-skip').disabled, h.$('btn-prev').disabled]).toEqual([true, true, true]);
    expect(h.$('card-border-wrapper').classList.contains('visible')).toBe(false);
  });

  it('applies ?position and ?theme and ignores invalid values', async () => {
    h = await load([], { query: '?position=TOP-RIGHT&theme=green' });
    expect(h.$('player-anchor').className).toBe('player-anchor top-right');
    expect(h.document.body.classList.contains('theme-green')).toBe(true);
    h.window.close();
    h = await load([], { query: '?position=middle&theme=pink' });
    expect(h.$('player-anchor').className).toBe('player-anchor bottom-left');
    expect(h.document.body.className).toBe('');
  });

  it('shows the first queued song from /api/song-queue before the player is ready, then loads it on ready', async () => {
    h = await load([SONG1, SONG2]);
    expect(h.callsTo('/api/song-queue')).toHaveLength(1);
    expect(h.$('card-border-wrapper').className).toBe('card-border-wrapper has-queue visible playing');
    expect(h.$('song-title').textContent).toBe('First Song');
    expect(h.$('song-channel').textContent).toBe('Chan One');
    expect(h.$('song-requester').textContent).toBe('Req One');
    expect(h.$('time-total').textContent).toBe('3:20');
    expect(h.$('queue-badge').textContent).toBe('+1');
    expect(h.$('song-thumbnail').getAttribute('src')).toBe('https://i.ytimg.com/vi/vid1/hqdefault.jpg');
    expect(h.$('btn-play-pause').disabled).toBe(false);
    expect(h.$('btn-skip').disabled).toBe(false);

    const player = ytReady(h);
    expect(player.elementId).toBe('yt-player');
    expect(player.options.playerVars).toEqual(expect.objectContaining({ autoplay: 1, controls: 0, origin: 'http://localhost:3001' }));
    expect(player.unMute).toHaveBeenCalled();
    expect(player.setVolume).toHaveBeenCalledWith(100);
    expect(player.loadVideoById).toHaveBeenCalledTimes(1);
    expect(player.loadVideoById).toHaveBeenCalledWith({ videoId: 'vid1', startSeconds: 0 });
  });

  it('tracks player state: icon, prev button and the 1s progress ticker', async () => {
    h = await load([SONG1]);
    const player = ytReady(h);
    player.duration = 120;
    player.current = 30;
    player.setState(STATE.PLAYING);
    expect(h.$('now-playing-card').classList.contains('playing')).toBe(true);
    expect(h.$('btn-prev').disabled).toBe(false);
    expect(h.$('btn-play-pause').getAttribute('aria-label')).toBe('Pause');
    expect(h.$('icon-play-pause').innerHTML).toContain('<rect');

    jest.advanceTimersByTime(1000);
    expect(h.$('progress-fill').style.width).toBe('25%');
    expect(h.$('progress-fill').classList.contains('active')).toBe(true);
    expect(h.$('time-current').textContent).toBe('0:30');
    expect(h.$('time-total').textContent).toBe('2:00');

    player.setState(STATE.PAUSED);
    expect(h.$('now-playing-card').classList.contains('playing')).toBe(false);
    expect(h.$('btn-play-pause').getAttribute('title')).toBe('Play');
    player.current = 60;
    jest.advanceTimersByTime(3000);
    expect(h.$('time-current').textContent).toBe('0:30');
  });

  it('play/pause and restart buttons drive the player', async () => {
    h = await load([SONG1]);
    const player = ytReady(h);
    player.setState(STATE.PLAYING);
    click(h.$('btn-play-pause'));
    expect(player.pauseVideo).toHaveBeenCalledTimes(1);
    player.state = STATE.PAUSED;
    click(h.$('btn-play-pause'));
    expect(player.playVideo).toHaveBeenCalledTimes(1);
    click(h.$('btn-prev'));
    expect(player.seekTo).toHaveBeenCalledWith(0, true);
    expect(player.playVideo).toHaveBeenCalledTimes(2);
  });

  it('when a song ends it tells the server (POST /api/song-queue/skip) and plays the next one', async () => {
    h = await load([SONG1, SONG2]);
    const player = ytReady(h);
    player.setState(STATE.ENDED);
    await flush();
    expect(h.callsTo('/api/song-queue/skip', 'POST').map(c => c.body)).toEqual([{ songId: 's1' }]);
    expect(player.loadVideoById).toHaveBeenLastCalledWith({ videoId: 'vid2', startSeconds: 0 });
    expect(h.$('song-title').textContent).toBe('Second Song');
    expect(h.$('song-requester').textContent).toBe('req2');
    expect(h.$('card-border-wrapper').classList.contains('has-queue')).toBe(false);

    player.setState(STATE.ENDED);
    await flush();
    expect(h.callsTo('/api/song-queue/skip', 'POST').map(c => c.body)).toEqual([{ songId: 's1' }, { songId: 's2' }]);
    expect(h.$('card-border-wrapper').classList.contains('visible')).toBe(false);
    expect(player.stopVideo).toHaveBeenCalled();
    expect([h.$('btn-play-pause').disabled, h.$('btn-skip').disabled, h.$('btn-prev').disabled]).toEqual([true, true, true]);
  });

  it('a player error is treated like the song ending', async () => {
    h = await load([SONG1]);
    const player = ytReady(h);
    player.options.events.onError({ target: player, data: 150 });
    await flush();
    expect(h.callsTo('/api/song-queue/skip', 'POST').map(c => c.body)).toEqual([{ songId: 's1' }]);
    expect(h.logs.warn.some(a => a[0] === '[SongPlayer] YT error code:' && a[1] === 150)).toBe(true);
  });

  it('the skip button posts the current song id once and retries a failed request after 1.5s', async () => {
    let attempts = 0;
    h = await load([SONG1, SONG2], {
      routes: { 'POST /api/song-queue/skip': () => (++attempts === 1 ? { status: 500, body: {} } : { body: { success: true } }) },
    });
    ytReady(h);
    click(h.$('btn-skip'));
    click(h.$('btn-skip'));
    await flush();
    expect(h.$('btn-skip').disabled).toBe(true);
    expect(h.callsTo('/api/song-queue/skip', 'POST')).toHaveLength(1);
    expect(h.logs.warn.some(a => a[0] === '[SongPlayer] skip API returned 500 (attempt 1)')).toBe(true);
    await jest.advanceTimersByTimeAsync(1500);
    const calls = h.callsTo('/api/song-queue/skip', 'POST');
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toEqual({ songId: 's1' });
    expect(h.window.fetch).toHaveBeenLastCalledWith('/api/song-queue/skip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ songId: 's1' }),
    });
  });

  it('song-queue-update messages: add starts playback, remove of the current song advances, skip re-enables, clear hides', async () => {
    h = await load([]);
    const player = ytReady(h);
    expect(player.loadVideoById).not.toHaveBeenCalled();

    h.ws.emit('song-queue-update', { action: 'add', active: [SONG1] });
    expect(player.loadVideoById).toHaveBeenCalledWith({ videoId: 'vid1', startSeconds: 0 });
    h.ws.emit('song-queue-update', { action: 'add', active: [SONG1, SONG2, SONG3] });
    expect(player.loadVideoById).toHaveBeenCalledTimes(1);
    expect(h.$('queue-badge').textContent).toBe('+2');

    h.ws.emit('song-queue-update', { action: 'remove', active: [SONG2, SONG3], removedSong: SONG1 });
    expect(player.loadVideoById).toHaveBeenLastCalledWith({ videoId: 'vid2', startSeconds: 0 });

    h.ws.emit('song-queue-update', { action: 'skip', active: [SONG3] });
    expect(h.$('song-title').textContent).toBe('Third');
    expect(h.$('song-thumbnail').getAttribute('src')).toBe('https://img.example/x/hqdefault.jpg');
    expect(h.$('btn-skip').disabled).toBe(false);

    h.ws.emit('song-queue-update', { action: 'clear', active: [] });
    expect(h.$('card-border-wrapper').classList.contains('visible')).toBe(false);
    expect(player.stopVideo).toHaveBeenCalled();
  });

  it('re-fetches the queue on WebSocket connect and reports state in the ?debug panel', async () => {
    h = await load({ networkError: true }, { query: '?debug=true' });
    expect(h.$('debug-panel').classList.contains('visible')).toBe(true);
    expect(h.$('dbg-status').textContent).toBe('Failed to fetch queue');
    h.routes['/api/song-queue'] = { body: [SONG1] };
    h.ws.open();
    await flush();
    expect(h.callsTo('/api/song-queue')).toHaveLength(2);
    expect(h.$('dbg-connection').textContent).toBe('Connected ✓');
    expect(h.$('dbg-status').textContent).toBe('Resuming queue from server state');
    expect(h.$('dbg-song').textContent).toBe('First Song');
    expect(h.$('dbg-queue').textContent).toBe('1');
    expect(typeof h.window.testSong).toBe('function');
  });

  it('the audio unlock button appears after 600ms and unlocks on click', async () => {
    h = await load([SONG1], { query: '?debug=true' });
    const player = ytReady(h);
    const btn = h.$('audio-unlock-btn');
    expect(btn.classList.contains('hidden')).toBe(true);
    jest.advanceTimersByTime(600);
    expect(btn.classList.contains('hidden')).toBe(false);
    player.state = STATE.CUED;
    click(btn);
    expect(btn.classList.contains('hidden')).toBe(true);
    expect(player.playVideo).toHaveBeenCalled();
    expect(h.$('dbg-audio').textContent).toBe('Unlocked ✓');
  });
});
