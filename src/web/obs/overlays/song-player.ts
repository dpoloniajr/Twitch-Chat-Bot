/* ─── Minimal YouTube IFrame API typings (the API is loaded at runtime) ──── */
declare namespace YT {
  const PlayerState: {
    UNSTARTED: -1;
    ENDED: 0;
    PLAYING: 1;
    PAUSED: 2;
    BUFFERING: 3;
    CUED: 5;
  };

  interface PlayerOptions {
    width?: string | number;
    height?: string | number;
    playerVars?: Record<string, string | number>;
    events?: {
      onReady?: (event: PlayerEvent) => void;
      onStateChange?: (event: OnStateChangeEvent) => void;
      onError?: (event: OnErrorEvent) => void;
    };
  }

  interface PlayerEvent {
    target: Player;
  }

  interface OnStateChangeEvent extends PlayerEvent {
    data: number;
  }

  interface OnErrorEvent extends PlayerEvent {
    data: number;
  }

  class Player {
    constructor(elementId: string, options: PlayerOptions);
    getCurrentTime(): number;
    getDuration(): number;
    getPlayerState(): number;
    playVideo(): void;
    pauseVideo(): void;
    stopVideo(): void;
    seekTo(seconds: number, allowSeekAhead: boolean): void;
    loadVideoById(options: { videoId?: string; startSeconds?: number }): void;
    mute(): void;
    unMute(): void;
    setVolume(volume: number): void;
  }
}

(function() {
  'use strict';

  /** Song entry of the dashboard song queue (fields read here). */
  interface QueuedSong {
    id?: string;
    videoId?: string;
    title?: string;
    channelTitle?: string;
    thumbnail?: string;
    requester?: string;
    requesterDisplayName?: string;
    durationSeconds?: number;
    durationFormatted?: string;
  }

  /** Payload of the `song-queue-update` WebSocket message. */
  interface SongQueueUpdate {
    action?: string;
    active?: QueuedSong[];
    removedSong?: QueuedSong;
  }

  /** Response of GET /api/song-queue (song-queue.json), or a bare array. */
  type SongQueueResponse = { active?: QueuedSong[] } | QueuedSong[];

  /** Response of POST /api/song-queue/skip (fields read here). */
  interface SongSkipResponse {
    success?: boolean;
    error?: string;
  }

  type SongPlayerWindow = Window & {
    onYouTubeIframeAPIReady?: () => void;
    obsstudio?: unknown;
    testSong?: (overrides?: Partial<QueuedSong>) => void;
  };

  /* ─── URL parameter parsing ──────────────────────────────────────────────── */
  const urlParams     = new URLSearchParams(window.location.search);
  const debugMode     = urlParams.get('debug') === 'true';
  const positionParam = (urlParams.get('position') || 'bottom-left').toLowerCase();
  const themeParam    = (urlParams.get('theme')    || 'purple').toLowerCase();

  const VALID_POSITIONS: string[] = ['bottom-left', 'bottom-right', 'top-left', 'top-right'];
  const VALID_THEMES: string[]    = ['purple', 'blue', 'green'];

  const position = VALID_POSITIONS.includes(positionParam) ? positionParam : 'bottom-left';
  const theme    = VALID_THEMES.includes(themeParam)       ? themeParam    : 'purple';

  /* Apply position and theme */
  document.getElementById('player-anchor')!.className = `player-anchor ${position}`;
  if (theme !== 'purple') document.body.classList.add(`theme-${theme}`);

  /* ─── Debug helpers ──────────────────────────────────────────────────────── */
  if (debugMode) {
    document.getElementById('debug-panel')!.classList.add('visible');
  }

  function dbg(key: string, value: string | number): void {
    if (!debugMode) return;
    const el = document.getElementById(`dbg-${key}`);
    if (el) el.textContent = value as string;
  }

  function log(...args: unknown[]): void {
    if (debugMode) console.log('[SongPlayer]', ...args);
  }

  /* ─── State ──────────────────────────────────────────────────────────────── */
  let localQueue: QueuedSong[] = [];
  let currentSong: QueuedSong | null = null;
  let ytPlayer: YT.Player | null = null;
  let ytReady            = false;
  let progressTimer: ReturnType<typeof setInterval> | null = null;
  let audioUnlocked      = false;
  let pendingPlay        = false;
  let loadingSongId: string | null | undefined = null;
  let skipNotifyInFlight = false;
  let isPlayerPaused     = false; // track manual pause state

  /* ─── DOM refs ───────────────────────────────────────────────────────────── */
  const wrapper       = document.getElementById('card-border-wrapper')!;
  const card          = document.getElementById('now-playing-card')!;
  const queueBadge    = document.getElementById('queue-badge')!;
  const thumbWrap     = document.getElementById('thumbnail-wrap')!;
  const songThumb     = document.getElementById('song-thumbnail') as HTMLImageElement;
  const songTitle     = document.getElementById('song-title')!;
  const songChannel   = document.getElementById('song-channel')!;
  const songRequester = document.getElementById('song-requester')!;
  const progressFill  = document.getElementById('progress-fill')!;
  const timeCurrent   = document.getElementById('time-current')!;
  const timeTotal     = document.getElementById('time-total')!;

  /* Control buttons */
  const btnPlayPause  = document.getElementById('btn-play-pause') as HTMLButtonElement;
  const btnSkip       = document.getElementById('btn-skip') as HTMLButtonElement;
  const btnPrev       = document.getElementById('btn-prev') as HTMLButtonElement;
  const iconPlayPause = document.getElementById('icon-play-pause')!;

  /* ─── Time formatter ─────────────────────────────────────────────────────── */
  function formatTime(seconds: number): string {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  /* ─── Play/Pause icon switcher ───────────────────────────────────────────── */
  const SVG_PLAY  = `<polygon points="5,3 19,12 5,21"/>`;
  const SVG_PAUSE = `<rect x="5" y="4" width="4" height="16" rx="1"/><rect x="15" y="4" width="4" height="16" rx="1"/>`;

  function setPlayIcon(isPlaying: boolean): void {
    iconPlayPause.innerHTML = isPlaying ? SVG_PAUSE : SVG_PLAY;
    btnPlayPause.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
    btnPlayPause.setAttribute('title', isPlaying ? 'Pause' : 'Play');
  }

  /* ─── Thumbnail helpers ──────────────────────────────────────────────────── */
  function getThumbnailUrl(song: QueuedSong): string {
    if (song.videoId) {
      return `https://i.ytimg.com/vi/${song.videoId}/hqdefault.jpg`;
    }
    if (song.thumbnail) {
      return song.thumbnail.replace(/\/(default|mqdefault|sddefault)\.jpg/, '/hqdefault.jpg');
    }
    return '';
  }

  function setupThumbnailFallback(): void {
    songThumb.onerror = function() {
      if (!currentSong) return;
      const current = this.src;
      if (current.includes('hqdefault')) {
        this.src = current.replace('hqdefault', 'mqdefault');
      } else if (current.includes('mqdefault')) {
        this.src = current.replace('mqdefault', 'default');
      }
    };
  }

  /* ─── Card UI updates ────────────────────────────────────────────────────── */
  function updateCardUI(song: QueuedSong): void {
    songTitle.textContent     = song.title       || 'Unknown Title';
    songChannel.textContent   = song.channelTitle || '';
    songRequester.textContent = song.requesterDisplayName || song.requester || 'Unknown';
    timeTotal.textContent     = song.durationFormatted || '0:00';

    /* Thumbnail */
    thumbWrap.classList.add('loading');
    const thumbUrl = getThumbnailUrl(song);
    if (thumbUrl) {
      songThumb.addEventListener('load', () => thumbWrap.classList.remove('loading'), { once: true });
      songThumb.src = thumbUrl;
    }

    /* Queue badge */
    const queued = localQueue.length - 1;
    if (queued > 0) {
      queueBadge.textContent = `+${queued}`;
      wrapper.classList.add('has-queue');
    } else {
      wrapper.classList.remove('has-queue');
    }

    dbg('song',  song.title ? song.title.substring(0, 30) : '—');
    dbg('queue', localQueue.length);
  }

  function showCard(song: QueuedSong): void {
    currentSong = song;
    updateCardUI(song);
    wrapper.classList.add('visible', 'playing');
    card.classList.add('playing');
    btnPlayPause.disabled = false;
    btnSkip.disabled      = false;
  }

  function hideCard(): void {
    wrapper.classList.remove('visible', 'playing', 'has-queue');
    card.classList.remove('playing');
    stopProgressTimer();
    currentSong    = null;
    isPlayerPaused = false;
    progressFill.style.width = '0%';
    progressFill.classList.remove('active');
    timeCurrent.textContent  = '0:00';
    timeTotal.textContent    = '0:00';
    btnPlayPause.disabled    = true;
    btnSkip.disabled         = true;
    btnPrev.disabled         = true;
    setPlayIcon(false);
  }

  /* ─── Progress bar ticker ────────────────────────────────────────────────── */
  function startProgressTimer(): void {
    stopProgressTimer();
    progressTimer = setInterval(() => {
      if (!ytPlayer || typeof ytPlayer.getCurrentTime !== 'function') return;
      try {
        const cur = ytPlayer.getCurrentTime();
        const dur = ytPlayer.getDuration();
        if (dur > 0) {
          const pct = Math.min((cur / dur) * 100, 100);
          progressFill.style.width      = `${pct}%`;
          progressFill.style.transition = 'width 1s linear';
          progressFill.classList.toggle('active', pct > 0);
          timeCurrent.textContent = formatTime(cur);
          timeTotal.textContent   = formatTime(dur);
        }
      } catch (e) {
        // YT player not ready
      }
    }, 1000);
  }

  function stopProgressTimer(): void {
    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
  }

  /* ─── Control button wiring ──────────────────────────────────────────────── */
  btnPlayPause.addEventListener('click', () => {
    if (!ytPlayer || !ytReady) return;
    const state = ytPlayer.getPlayerState();
    if (state === YT.PlayerState.PLAYING) {
      ytPlayer.pauseVideo();
      isPlayerPaused = true;
    } else {
      ytPlayer.playVideo();
      isPlayerPaused = false;
    }
  });

  btnSkip.addEventListener('click', async () => {
    if (!currentSong || btnSkip.disabled) return;
    btnSkip.disabled = true;
    await notifyServerSkip(currentSong.id);
    // The WebSocket 'skip' event will re-enable if another song is queued
  });

  btnPrev.addEventListener('click', () => {
    if (!ytPlayer || !ytReady || !currentSong) return;
    // Restart current song from beginning
    try {
      ytPlayer.seekTo(0, true);
      ytPlayer.playVideo();
      isPlayerPaused = false;
    } catch (e) {
      console.warn('[SongPlayer] Seek error:', e);
    }
  });

  /* ─── YouTube IFrame API ─────────────────────────────────────────────────── */
  (function loadYTAPI() {
    const tag   = document.createElement('script');
    tag.src     = 'https://www.youtube.com/iframe_api';
    const first = document.getElementsByTagName('script')[0];
    first.parentNode!.insertBefore(tag, first);
  })();

  (window as SongPlayerWindow).onYouTubeIframeAPIReady = function() {
    log('YouTube IFrame API ready');
    ytPlayer = new YT.Player('yt-player', {
      width:  '1',
      height: '1',
      playerVars: {
        autoplay:       1,
        controls:       0,
        disablekb:      1,
        fs:             0,
        iv_load_policy: 3,
        modestbranding: 1,
        rel:            0,
        showinfo:       0,
        origin:         window.location.origin
      },
      events: {
        onReady:       onPlayerReady,
        onStateChange: onPlayerStateChange,
        onError:       onPlayerError
      }
    });
  };

  function onPlayerReady(event: YT.PlayerEvent): void {
    log('YT player ready');
    ytReady = true;
    dbg('yt-state', 'Ready');

    event.target.unMute();
    event.target.setVolume(100);

    if (pendingPlay && localQueue.length > 0) {
      pendingPlay   = false;
      loadingSongId = null;
      playSong(localQueue[0]);
    }
  }

  const YT_STATE_NAMES: Record<string, string> = {
    '-1': 'Unstarted',
     '0': 'Ended',
     '1': 'Playing',
     '2': 'Paused',
     '3': 'Buffering',
     '5': 'Cued'
  };

  function onPlayerStateChange(event: YT.OnStateChangeEvent): void {
    const stateCode = event.data;
    dbg('yt-state', YT_STATE_NAMES[String(stateCode)] || String(stateCode));
    log('YT state:', stateCode);

    if (stateCode === YT.PlayerState.PLAYING) {
      card.classList.add('playing');
      wrapper.classList.add('playing');
      btnPrev.disabled = false;
      setPlayIcon(true);
      startProgressTimer();
    } else if (stateCode === YT.PlayerState.PAUSED) {
      card.classList.remove('playing');
      wrapper.classList.remove('playing');
      setPlayIcon(false);
      stopProgressTimer();
    } else if (stateCode === YT.PlayerState.BUFFERING) {
      // Keep play icon as playing during buffering
      card.classList.add('playing');
      wrapper.classList.add('playing');
    } else if (stateCode === YT.PlayerState.ENDED) {
      card.classList.remove('playing');
      wrapper.classList.remove('playing');
      setPlayIcon(false);
      stopProgressTimer();
      handleSongEnded();
    }
  }

  function onPlayerError(event: YT.OnErrorEvent): void {
    console.warn('[SongPlayer] YT error code:', event.data);
    dbg('yt-state', `Error: ${event.data}`);
    handleSongEnded();
  }

  /* ─── Playback control ───────────────────────────────────────────────────── */
  function playSong(song: QueuedSong | null | undefined): void {
    if (!song) return;

    if (song.id && song.id === loadingSongId) {
      log('Ignoring duplicate playSong() for already-loading queue entry:', song.id);
      return;
    }

    if (!ytReady) {
      log('YT not ready yet, queuing play for', song.title);
      pendingPlay   = true;
      loadingSongId = song.id;
      showCard(song);
      return;
    }

    log('Playing:', song.title, '(', song.videoId, ')');
    loadingSongId  = song.id;
    isPlayerPaused = false;
    showCard(song);
    setPlayIcon(true);

    try {
      ytPlayer!.loadVideoById({ videoId: song.videoId, startSeconds: 0 });
    } catch (e) {
      console.error('[SongPlayer] loadVideoById failed:', e);
      loadingSongId = null;
      handleSongEnded();
    }
  }

  async function notifyServerSkip(songId: string | null | undefined): Promise<void> {
    if (skipNotifyInFlight) {
      log('Skip notify already in flight, skipping duplicate call');
      return;
    }
    skipNotifyInFlight = true;
    dbg('status', 'Syncing skip to server…');

    const body    = JSON.stringify(songId ? { songId } : {});
    let   attempt = 0;

    while (attempt < 2) {
      attempt++;
      try {
        const res = await fetch('/api/song-queue/skip', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body
        });
        if (res.ok) {
          const json = await res.json() as SongSkipResponse;
          if (json.success === false && json.error === 'Song already skipped.') {
            log('Server: song was already skipped by another instance');
          } else {
            log('Server skip confirmed');
            dbg('status', 'Playing');
          }
          break;
        }
        console.warn(`[SongPlayer] skip API returned ${res.status} (attempt ${attempt})`);
      } catch (err) {
        console.warn(`[SongPlayer] skip API error (attempt ${attempt}):`, err);
      }
      if (attempt < 2) await new Promise(r => setTimeout(r, 1500));
    }

    skipNotifyInFlight = false;
  }

  function handleSongEnded(): void {
    log('Song ended, shifting local queue');

    const endedSong = localQueue.length > 0 ? localQueue[0] : null;

    if (localQueue.length > 0) localQueue.shift();
    loadingSongId = null;

    notifyServerSkip(endedSong ? endedSong.id : null);

    if (localQueue.length > 0) {
      playSong(localQueue[0]);
    } else {
      hideCard();
      if (ytPlayer && ytReady) ytPlayer.stopVideo();
      dbg('status', 'Queue empty – waiting');
      dbg('yt-state', 'Stopped');
    }
  }

  /* ─── Queue state management ─────────────────────────────────────────────── */
  function handleQueueUpdate(data: SongQueueUpdate): void {
    const { action, active } = data;

    log('Queue update:', action, '| active songs:', active ? active.length : '?');

    localQueue = active ? [...active] : [];
    dbg('queue', localQueue.length);

    switch (action) {
      case 'add':
        if (!currentSong && localQueue.length > 0) {
          playSong(localQueue[0]);
        } else if (currentSong) {
          updateCardUI(currentSong);
        }
        break;

      case 'skip':
        if (localQueue.length > 0) {
          playSong(localQueue[0]);
        } else {
          hideCard();
          if (ytPlayer && ytReady) ytPlayer.stopVideo();
        }
        // Re-enable skip button for next song
        btnSkip.disabled = localQueue.length === 0;
        break;

      case 'remove':
        if (currentSong && data.removedSong && data.removedSong.id === currentSong.id) {
          loadingSongId = null;
          if (localQueue.length > 0) {
            playSong(localQueue[0]);
          } else {
            hideCard();
            if (ytPlayer && ytReady) ytPlayer.stopVideo();
          }
        } else if (currentSong) {
          updateCardUI(currentSong);
        }
        break;

      case 'clear':
        localQueue    = [];
        loadingSongId = null;
        hideCard();
        if (ytPlayer && ytReady) ytPlayer.stopVideo();
        dbg('status', 'Queue cleared');
        break;

      default:
        log('Unknown action:', action);
    }
  }

  /* ─── Initial state fetch ────────────────────────────────────────────────── */
  async function fetchInitialQueue(): Promise<void> {
    try {
      const res  = await fetch('/api/song-queue');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body  = await res.json() as SongQueueResponse;
      const queue = (body as { active?: QueuedSong[] }).active || (Array.isArray(body) ? body : []);

      log('Initial queue fetched:', queue.length, 'songs');
      localQueue = [...queue];
      dbg('queue', localQueue.length);

      if (localQueue.length > 0) {
        playSong(localQueue[0]);
        dbg('status', 'Resuming queue from server state');
      } else {
        dbg('status', 'Queue empty – waiting for songs');
      }
    } catch (err) {
      console.warn('[SongPlayer] Failed to fetch initial queue:', err);
      dbg('status', 'Failed to fetch queue');
    }
  }

  /* ─── WebSocket ──────────────────────────────────────────────────────────── */
  const client = new OverlayClient();

  client.on('connected', () => {
    log('WebSocket connected');
    dbg('connection', 'Connected ✓');
    dbg('status',     'Connected – listening');
    fetchInitialQueue();
  });

  client.on('disconnected', () => {
    log('WebSocket disconnected');
    dbg('connection', 'Reconnecting…');
  });

  client.on('song-queue-update', (data: SongQueueUpdate) => {
    log('Received song-queue-update:', data);
    handleQueueUpdate(data);
  });

  /* ─── Audio unlock (OBS Chromium autoplay policy) ────────────────────────── */
  const unlockBtn = document.getElementById('audio-unlock-btn');

  function unlockAudio(): void {
    if (audioUnlocked) return;

    try {
      if (ytPlayer && ytReady) {
        ytPlayer.unMute();
        ytPlayer.setVolume(100);
        const state = ytPlayer.getPlayerState();
        if (state === YT.PlayerState.PAUSED || state === YT.PlayerState.CUED) {
          ytPlayer.playVideo();
        }
      }

      audioUnlocked = true;
      dbg('audio', 'Unlocked ✓');
      log('Audio unlocked via user interaction');

      if (unlockBtn) unlockBtn.classList.add('hidden');
    } catch (e) {
      console.warn('[SongPlayer] Audio unlock error:', e);
    }
  }

  if (unlockBtn) {
    const isOBS = typeof (window as SongPlayerWindow).obsstudio !== 'undefined';

    setTimeout(() => {
      unlockBtn.classList.remove('hidden');

      if (isOBS) {
        setTimeout(() => {
          if (!audioUnlocked) {
            unlockBtn.classList.add('hidden');
            unlockAudio();
          }
        }, 5000);
      }
    }, 600);

    unlockBtn.addEventListener('click', unlockAudio);
  }

  document.addEventListener('click',      unlockAudio);
  document.addEventListener('touchstart', unlockAudio);

  /* ─── Init ───────────────────────────────────────────────────────────────── */
  setupThumbnailFallback();
  dbg('status', 'Initialized');

  /* Buttons start disabled until a song loads */
  btnPlayPause.disabled = true;
  btnSkip.disabled      = true;
  btnPrev.disabled      = true;

  fetchInitialQueue();

  /* ─── Debug helpers exposed to console ──────────────────────────────────── */
  if (debugMode) {
    (window as SongPlayerWindow).testSong = function(overrides: Partial<QueuedSong> = {}) {
      const song: QueuedSong = {
        id:                   'test-001',
        videoId:              'dQw4w9WgXcQ',
        title:                'Never Gonna Give You Up',
        channelTitle:         'Rick Astley',
        durationSeconds:      213,
        durationFormatted:    '3:33',
        requester:            'testuser',
        requesterDisplayName: 'TestUser',
        ...overrides
      };
      localQueue = [song];
      playSong(song);
    };

    console.log('[SongPlayer] Debug mode active. Use testSong() to preview the card.');
  }
})();
