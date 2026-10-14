(function() {
  'use strict';

  /**
   * Leaderboard entry as this overlay reads it.
   * GET /api/loyalty/leaderboard sends `level` as a plain number; a
   * `{ name, level }` object is also accepted for custom ?api endpoints.
   */
  interface LeaderboardEntry {
    username: string;
    points: number;
    level?: number | { name?: string; level?: number };
  }

  /**
   * Leaderboard data accepted from the API and from WebSocket messages:
   *   - GET /api/loyalty/leaderboard?limit=N returns `LeaderboardEntry[]`,
   *     sorted by points (highest first), each with a `rank`;
   *   - the `loyalty-update` WebSocket message carries that same array as its
   *     `data` (the top LOYALTY_BROADCAST_SIZE users), broadcast by the
   *     dashboard after every loyalty write; this overlay shows the first ?limit;
   *   - `{ leaderboard: [...] }` is still accepted. Anything else is ignored.
   */
  type LeaderboardPayload = LeaderboardEntry[] | { leaderboard?: LeaderboardEntry[] };

  /** Number of entries in a `loyalty-update` broadcast (the dashboard sends limit=100). */
  const LOYALTY_BROADCAST_SIZE = 100;

  // Configuration from URL parameters
  const config = {
    limit: parseInt(OverlayUtils.getQueryParam('limit') || '5', 10),
    pollInterval: parseInt(OverlayUtils.getQueryParam('poll') || '30000', 10),
    apiUrl: OverlayUtils.getQueryParam('api') || '/api/loyalty/leaderboard',
    showLevel: OverlayUtils.getQueryParam('level') !== 'false',
    title: OverlayUtils.getQueryParam('title') || 'Top Chatters'
  };

  // State
  let previousRanks: Record<string, number> = {};

  // Elements
  const listElement = document.getElementById('leaderboard-list')!;
  const updateTimeElement = document.getElementById('update-time')!;
  const titleElement = document.querySelector('.leaderboard-title')!;

  // Set custom title
  if (config.title) {
    titleElement.textContent = config.title;
  }

  /**
   * Extract the entry list from any accepted payload (null if there is none)
   */
  function toEntries(data: LeaderboardPayload | null | undefined): LeaderboardEntry[] | null {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.leaderboard)) return data.leaderboard;
    return null;
  }

  /**
   * Render a leaderboard payload, trimmed to ?limit
   */
  function applyLeaderboard(data: LeaderboardPayload | null | undefined): void {
    const entries = toEntries(data);
    if (!entries) return;
    updateLeaderboard(entries.slice(0, config.limit));
    updateTimeElement.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  }

  /**
   * Fetch leaderboard data
   */
  async function fetchLeaderboard(): Promise<void> {
    try {
      const response = await fetch(`${config.apiUrl}?limit=${config.limit}`);
      applyLeaderboard(await response.json() as LeaderboardPayload);
    } catch (err) {
      console.error('[Leaderboard] Failed to fetch:', err);
    }
  }

  /**
   * Update leaderboard display
   */
  function updateLeaderboard(users: LeaderboardEntry[]): void {
    if (!users || users.length === 0) {
      listElement.innerHTML = '<li class="empty">No data yet</li>';
      return;
    }

    listElement.innerHTML = users.map((user, index) => {
      const rank = index + 1;
      const prevRank = previousRanks[user.username];
      let rankChange = '';

      if (prevRank !== undefined && prevRank !== rank) {
        if (prevRank > rank) {
          rankChange = `<span class="rank-change rank-up">▲${prevRank - rank}</span>`;
        } else {
          rankChange = `<span class="rank-change rank-down">▼${rank - prevRank}</span>`;
        }
      }

      previousRanks[user.username] = rank;

      const levelLabel = config.showLevel ? formatLevel(user.level) : '';
      const levelText = levelLabel
        ? `<div class="leaderboard-level">${OverlayUtils.escapeHtml(levelLabel)}</div>`
        : '';

      return `
            <li class="leaderboard-item">
              <div class="leaderboard-rank">${getRankSymbol(rank)}${rankChange}</div>
              <div class="leaderboard-user">
                <div class="leaderboard-username">${OverlayUtils.escapeHtml(user.username)}</div>
                ${levelText}
              </div>
              <div class="leaderboard-points">
                <div class="leaderboard-points-value">${OverlayUtils.formatNumber(user.points)}</div>
                <div class="leaderboard-points-label">points</div>
              </div>
            </li>
          `;
    }).join('');
  }

  /**
   * Level label: "Level 3" for a numeric level, or the level object's name.
   * Returns '' when there is nothing to show.
   */
  function formatLevel(level: LeaderboardEntry['level']): string {
    if (typeof level === 'number') return `Level ${level}`;
    if (!level) return '';
    if (level.name) return level.name;
    return level.level !== undefined ? `Level ${level.level}` : '';
  }

  /**
   * Get rank display symbol
   */
  function getRankSymbol(rank: number): string {
    switch (rank) {
      case 1: return '🥇';
      case 2: return '🥈';
      case 3: return '🥉';
      default: return `#${rank}`;
    }
  }

  // Initialize
  fetchLeaderboard();

  // Poll for updates (fallback for missed WebSocket messages)
  setInterval(fetchLeaderboard, config.pollInterval);

  // Live updates: the dashboard broadcasts `loyalty-update` after every loyalty write
  const client = new OverlayClient();
  client.on('loyalty-update', (data: LeaderboardPayload) => {
    if (!toEntries(data)) return;
    if (config.limit > LOYALTY_BROADCAST_SIZE) {
      // The broadcast is shorter than this board: use it as a signal and re-fetch
      fetchLeaderboard();
      return;
    }
    applyLeaderboard(data);
  });
})();
