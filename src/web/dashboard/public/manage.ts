/*
 * Dashboard management pages (served as dashboard/public/manage.js, loaded
 * after app.js): the schema-driven Settings form and the Song Queue, Loyalty,
 * Quotes, Counters and Backups pages.
 *
 * Plain global script (module "none") like app.ts: top-level functions are
 * globals so index.html's inline handlers can call them, and app.ts calls
 * mgrOnPageShown() / mgrOnSocketMessage() when they exist. Everything built
 * from server data is created with createElement + textContent (never
 * innerHTML), so data cannot inject markup. Names are prefixed with `mgr` /
 * `Mgr` to stay clear of app.ts's globals.
 */

// ---- Shapes of the API responses this script reads ----

type MgrSettingType = 'string' | 'integer' | 'boolean' | 'enum' | 'list' | 'secret';
type MgrSettingApplies = 'live' | 'bot' | 'dashboard' | 'token-generator';
type MgrSettingValue = string | number | boolean | string[] | null;

/** One entry of GET /api/config settings */
interface MgrSetting {
  key: string;
  group: string;
  label: string;
  description?: string;
  type: MgrSettingType;
  default?: string | number | boolean;
  min?: number;
  max?: number;
  maxLength?: number;
  options?: string[];
  separator?: string;
  scale?: number;
  unit?: string;
  readOnly: boolean;
  readOnlyReason?: string;
  applies: MgrSettingApplies;
  value: MgrSettingValue;
  isSet: boolean;
  fromEnvironment: boolean;
}

interface MgrSettingGroup {
  id: string;
  title: string;
  description?: string;
}

interface MgrConfigResponse {
  groups: MgrSettingGroup[];
  settings: MgrSetting[];
}

interface MgrConfigSaveResponse extends MgrConfigResponse {
  success: boolean;
  changed: string[];
  restart: MgrSettingApplies[];
}

interface MgrSong {
  id: string;
  videoId: string;
  title: string;
  channelTitle?: string;
  requester?: string;
  requesterDisplayName?: string;
  durationFormatted?: string;
  position?: number;
  pointsCost?: number;
}

interface MgrSongConfig {
  enabled?: boolean;
  cost?: number;
  maxDuration?: number;
  maxPerUser?: number;
  allowDuplicates?: boolean;
  priority?: string;
}

interface MgrSongQueue {
  active?: MgrSong[];
  config?: MgrSongConfig;
}

interface MgrBlocklist {
  videos?: string[];
  channels?: string[];
  keywords?: string[];
}

interface MgrLoyaltyConfig {
  enabled?: boolean;
  currencyName?: string;
  currencyNamePlural?: string;
  pointsPerMinute?: number;
  pointsPerMessage?: number;
  maxPointsPerMessage?: number;
  messageCooldownSeconds?: number;
  subscriberMultiplier?: number;
  vipMultiplier?: number;
  pointsPerLevel?: number;
}

interface MgrLoyaltyStats {
  totalUsers?: number;
  totalPointsInCirculation?: number;
  totalPointsEarned?: number;
  totalPointsSpent?: number;
  averagePoints?: number;
  topLevel?: number;
}

interface MgrLeaderboardEntry {
  username: string;
  points: number;
  level?: number;
  watchTimeMinutes?: number;
  rank?: number;
}

interface MgrTransaction {
  timestamp?: string;
  username?: string;
  type?: string;
  amount?: number;
  reason?: string;
}

interface MgrQuote {
  id: number;
  text?: string;
  addedBy?: string;
  game?: string;
}

interface MgrQuotesPage {
  quotes?: MgrQuote[];
  totalQuotes?: number;
  totalPages?: number;
  currentPage?: number;
}

interface MgrQuotesConfig {
  minLength?: number;
  maxLength?: number;
  maxQuotes?: number;
  allowDuplicates?: boolean;
}

interface MgrCounter {
  name: string;
  value: number;
  description?: string;
}

interface MgrBackupEntry {
  filename: string;
  createdAt: string;
  size: number;
  includes?: string[];
}

/** A finished API call: `data` is the parsed body (null when it was not JSON) */
interface MgrResult<T> {
  ok: boolean;
  status: number;
  data: T;
}

type MgrStatusKind = 'ok' | 'error' | 'info';

// ---- Shared helpers ----

/**
 * Call the dashboard API. Network errors resolve as status 0; a 2xx answer
 * whose body says `success: false` (the song queue routes do that) counts as
 * not ok, so callers handle both failure styles the same way.
 */
async function mgrRequest<T>(method: string, url: string, body?: unknown): Promise<MgrResult<T>> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(url, init);
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    const failedInBody = typeof data === 'object' && data !== null && (data as { success?: unknown }).success === false;
    return { ok: res.ok && !failedInBody, status: res.status, data: data as T };
  } catch (error) {
    console.error(`${method} ${url} failed:`, error);
    return { ok: false, status: 0, data: null as T };
  }
}

/** The error message of a failed call */
function mgrErrorOf(result: MgrResult<unknown>): string {
  const data = result.data as { error?: unknown; message?: unknown } | null;
  if (data && typeof data.error === 'string') return data.error;
  if (data && typeof data.message === 'string') return data.message;
  return result.status === 0 ? 'Could not reach the dashboard' : `Request failed (${result.status})`;
}

function mgrEl<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

/** Show a message in a page's status line (`<page>Status`) */
function mgrStatus(page: string, message: string, kind: MgrStatusKind = 'ok'): void {
  const el = mgrEl(`${page}Status`);
  if (!el) return;
  el.textContent = message;
  el.className = `mgr-status mgr-status-${kind}`;
}

/** Report a call's outcome in the page's status line; returns result.ok */
function mgrReport(page: string, result: MgrResult<unknown>, success: string): boolean {
  if (result.ok) mgrStatus(page, success, 'ok');
  else mgrStatus(page, mgrErrorOf(result), 'error');
  return result.ok;
}

/** Create an element with text content (safe for any data) */
function mgrNode<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string | number, className?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = String(text);
  if (className) el.className = className;
  return el;
}

function mgrButton(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const button = mgrNode('button', label, `btn ${className}`);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

/** A table row of text cells, plus an optional actions cell */
function mgrRow(cells: Array<string | number>, actions?: HTMLElement[]): HTMLTableRowElement {
  const row = mgrNode('tr');
  for (const cell of cells) row.appendChild(mgrNode('td', cell));
  if (actions) {
    const td = mgrNode('td', undefined, 'mgr-row-actions');
    for (const action of actions) td.appendChild(action);
    row.appendChild(td);
  }
  return row;
}

/** Replace a table body's rows, or show `empty` across `columns` cells */
function mgrFillTable(bodyId: string, rows: HTMLTableRowElement[], empty: string, columns: number): void {
  const body = mgrEl(bodyId);
  if (!body) return;
  body.replaceChildren();
  if (rows.length === 0) {
    const row = mgrNode('tr');
    const cell = mgrNode('td', empty, 'mgr-empty');
    cell.colSpan = columns;
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }
  for (const row of rows) body.appendChild(row);
}

function mgrInput(id: string): HTMLInputElement {
  return mgrEl<HTMLInputElement>(id);
}

/** A number input's value, or null when it is empty or not a finite number */
function mgrNumber(id: string): number | null {
  const raw = mgrInput(id)?.value.trim() ?? '';
  if (raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function mgrSetValue(id: string, value: string | number | undefined | null): void {
  const el = mgrInput(id);
  if (el) el.value = value === undefined || value === null ? '' : String(value);
}

function mgrSetChecked(id: string, value: boolean | undefined): void {
  const el = mgrInput(id);
  if (el) el.checked = !!value;
}

/** Read a chosen file as text */
function mgrReadFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.readAsText(file);
  });
}

/** Read and parse the JSON file chosen in a file input; reports problems on `page` */
async function mgrReadJsonFile(inputId: string, page: string): Promise<unknown | undefined> {
  const file = mgrInput(inputId)?.files?.[0];
  if (!file) {
    mgrStatus(page, 'Choose a file first.', 'error');
    return undefined;
  }
  try {
    return JSON.parse(await mgrReadFile(file));
  } catch {
    mgrStatus(page, `${file.name} is not a valid JSON file.`, 'error');
    return undefined;
  }
}

/** Offer `data` to the browser as a JSON file download */
function mgrDownloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  if (typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(blob);
  const link = mgrNode('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function mgrFormatDate(value: string | undefined): string {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function mgrFormatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---- Page hooks (called by app.ts) ----

/** Pages loaded at least once, so socket updates only refresh what was opened */
const mgrLoadedPages = new Set<string>();

const MGR_PAGE_LOADERS: Record<string, () => unknown> = {
  settings: () => mgrLoadSettings(),
  songs: () => mgrLoadSongs(),
  loyalty: () => mgrLoadLoyalty(),
  quotes: () => mgrLoadQuotes(),
  counters: () => mgrLoadCounters(),
  backups: () => mgrLoadBackups()
};

/** app.ts showPage() calls this after switching pages */
function mgrOnPageShown(pageId: string): void {
  const loader = MGR_PAGE_LOADERS[pageId];
  if (!loader) return;
  mgrLoadedPages.add(pageId);
  loader();
}

/** app.ts forwards every WebSocket message here */
function mgrOnSocketMessage(message: { type?: string; data?: unknown }): void {
  switch (message.type) {
    case 'song-queue-update':
      if (mgrLoadedPages.has('songs')) mgrLoadSongs();
      break;
    case 'loyalty-update':
      if (mgrLoadedPages.has('loyalty')) mgrLoadLoyalty();
      break;
    case 'quote-update':
      if (mgrLoadedPages.has('quotes')) mgrLoadQuotes(mgrQuotesCurrentPage);
      break;
    case 'counter-update':
      if (mgrLoadedPages.has('counters') && Array.isArray(message.data)) mgrRenderCounters(message.data as MgrCounter[]);
      break;
  }
}

// ==================== Settings ====================

let mgrSettings: MgrSetting[] = [];
/** Unsaved edits: key -> value to send (null = reset to default / clear) */
const mgrSettingsDirty = new Map<string, unknown>();
/** Number fields holding text the browser cannot read as a number (their value reads as '') */
const mgrSettingsInvalid = new Set<string>();

const MGR_APPLIES_LABEL: Record<MgrSettingApplies, string> = {
  live: 'Applies immediately',
  bot: 'Restart bot to apply',
  dashboard: 'Restart dashboard to apply',
  'token-generator': 'Restart token generator to apply'
};

async function mgrLoadSettings(): Promise<void> {
  const result = await mgrRequest<MgrConfigResponse>('GET', '/api/config');
  if (!result.ok || !result.data) {
    mgrStatus('settings', `Could not load settings: ${mgrErrorOf(result)}`, 'error');
    return;
  }
  mgrSettingsDirty.clear();
  mgrSettingsInvalid.clear();
  mgrSettings = result.data.settings;
  mgrRenderSettings(result.data.groups, result.data.settings);
  mgrStatus('settings', '', 'info');
}

function mgrRenderSettings(groups: MgrSettingGroup[], settings: MgrSetting[]): void {
  const form = mgrEl('settingsForm');
  if (!form) return;
  form.replaceChildren();
  for (const group of groups) {
    const inGroup = settings.filter(s => s.group === group.id);
    if (inGroup.length === 0) continue;
    const section = mgrNode('section', undefined, 'settings-section');
    section.dataset.group = group.id;
    section.appendChild(mgrNode('h3', group.title));
    if (group.description) section.appendChild(mgrNode('p', group.description, 'info-text'));
    for (const setting of inGroup) section.appendChild(mgrSettingRow(setting));
    form.appendChild(section);
  }
  mgrUpdateSaveButton();
}

/** The value a setting's input should show (scaled for display) */
function mgrDisplayValue(setting: MgrSetting, value: MgrSettingValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join(setting.separator === ' ' ? ' ' : ', ');
  if (typeof value === 'number' && setting.scale) return String(value / setting.scale);
  return String(value);
}

/** Placeholder text showing the default value */
function mgrPlaceholder(setting: MgrSetting): string {
  if (setting.default === undefined || setting.type === 'boolean') return '';
  return `Default: ${mgrDisplayValue(setting, setting.default)}`;
}

function mgrMarkDirty(key: string, value: unknown): void {
  mgrSettingsDirty.set(key, value);
  const row = document.querySelector(`[data-setting="${key}"]`);
  row?.classList.add('mgr-dirty');
  mgrUpdateSaveButton();
}

function mgrUpdateSaveButton(): void {
  const button = mgrEl<HTMLButtonElement>('settingsSaveBtn');
  if (!button) return;
  button.disabled = mgrSettingsDirty.size === 0;
  button.textContent = mgrSettingsDirty.size > 0 ? `Save Changes (${mgrSettingsDirty.size})` : 'Save Changes';
}

/** Turn an integer input's (scaled) text into the stored value, or null for empty */
function mgrIntegerFromInput(setting: MgrSetting, raw: string): number | string | null {
  const text = raw.trim();
  if (text === '') return null;
  const n = Number(text);
  if (!Number.isFinite(n)) return text; // the server rejects it with a clear message
  return Math.round(n * (setting.scale ?? 1));
}

function mgrSettingInput(setting: MgrSetting, disabled: boolean): HTMLElement {
  const id = `setting-${setting.key}`;
  if (setting.type === 'boolean') {
    const input = mgrNode('input');
    input.type = 'checkbox';
    input.id = id;
    input.checked = setting.value === true;
    input.disabled = disabled;
    input.addEventListener('change', () => mgrMarkDirty(setting.key, input.checked));
    return input;
  }
  if (setting.type === 'enum') {
    const select = mgrNode('select');
    select.id = id;
    select.disabled = disabled;
    select.appendChild(new Option(`Default (${setting.default ?? 'none'})`, ''));
    for (const option of setting.options ?? []) select.appendChild(new Option(option, option));
    select.value = typeof setting.value === 'string' ? setting.value : '';
    select.addEventListener('change', () => mgrMarkDirty(setting.key, select.value === '' ? null : select.value));
    return select;
  }

  const input = mgrNode('input');
  input.id = id;
  input.disabled = disabled;
  if (setting.type === 'secret') {
    input.type = 'password';
    input.autocomplete = 'off';
    input.placeholder = setting.isSet ? '•••••••• (set; type to replace)' : 'Not set';
    input.addEventListener('input', () => {
      if (input.value === '') {
        mgrSettingsDirty.delete(setting.key);
        mgrUpdateSaveButton();
      } else {
        mgrMarkDirty(setting.key, input.value);
      }
    });
    return input;
  }

  input.type = setting.type === 'integer' ? 'number' : 'text';
  if (setting.type === 'integer') {
    input.step = 'any';
    if (setting.min !== undefined) input.min = String(setting.min / (setting.scale ?? 1));
    if (setting.max !== undefined) input.max = String(setting.max / (setting.scale ?? 1));
  }
  if (setting.maxLength !== undefined) input.maxLength = setting.maxLength;
  input.value = mgrDisplayValue(setting, setting.value);
  input.placeholder = mgrPlaceholder(setting);
  input.addEventListener('input', () => {
    // A number field with unparseable text reports value '' (indistinguishable
    // from empty, which means "use the default"), so it is flagged instead
    if (setting.type === 'integer' && input.validity?.badInput) mgrSettingsInvalid.add(setting.key);
    else mgrSettingsInvalid.delete(setting.key);
    const value = setting.type === 'integer' ? mgrIntegerFromInput(setting, input.value) : input.value;
    mgrMarkDirty(setting.key, value === '' ? null : value);
  });
  return input;
}

function mgrSettingRow(setting: MgrSetting): HTMLElement {
  const row = mgrNode('div', undefined, 'form-group mgr-setting');
  row.dataset.setting = setting.key;
  const locked = setting.readOnly || setting.fromEnvironment;

  const label = mgrNode('label', setting.label);
  label.htmlFor = `setting-${setting.key}`;
  if (setting.unit) label.appendChild(mgrNode('span', ` (${setting.unit})`, 'mgr-unit'));
  label.appendChild(mgrNode('span', MGR_APPLIES_LABEL[setting.applies], `mgr-badge mgr-badge-${setting.applies}`));
  row.appendChild(label);

  if (setting.type === 'secret' && setting.readOnly) {
    row.appendChild(mgrNode('span', setting.isSet ? 'Set' : 'Not set', setting.isSet ? 'mgr-badge mgr-badge-set' : 'mgr-badge mgr-badge-unset'));
  } else {
    const line = mgrNode('div', undefined, 'mgr-setting-line');
    line.appendChild(mgrSettingInput(setting, locked));
    if (!locked && setting.type === 'secret' && setting.isSet) {
      line.appendChild(mgrButton('Clear', 'btn-secondary btn-small', () => {
        const input = mgrInput(`setting-${setting.key}`);
        if (input) input.value = '';
        mgrMarkDirty(setting.key, null);
      }));
    } else if (!locked && setting.type !== 'secret' && setting.isSet && setting.default !== undefined) {
      line.appendChild(mgrButton('Use default', 'btn-secondary btn-small', () => mgrResetSetting(setting)));
    }
    row.appendChild(line);
  }

  if (setting.description) row.appendChild(mgrNode('small', setting.description, 'info-text'));
  if (setting.readOnly && setting.readOnlyReason) row.appendChild(mgrNode('small', setting.readOnlyReason, 'info-text'));
  if (setting.fromEnvironment) {
    row.appendChild(mgrNode('small', 'Set by the system environment (for example docker-compose). Change it there; .env edits would be ignored.', 'mgr-warning'));
  }
  return row;
}

/** Show a setting's default in its input and queue the key for removal from .env */
function mgrResetSetting(setting: MgrSetting): void {
  const el = mgrEl<HTMLInputElement>(`setting-${setting.key}`);
  if (el) {
    if (setting.type === 'boolean') el.checked = setting.default === true;
    else el.value = '';
  }
  mgrMarkDirty(setting.key, null);
}

async function mgrSaveSettings(): Promise<void> {
  if (mgrSettingsDirty.size === 0) return;
  if (mgrSettingsInvalid.size > 0) {
    const labels = mgrSettings.filter(s => mgrSettingsInvalid.has(s.key)).map(s => s.label);
    mgrStatus('settings', `Not saved: enter a number for ${labels.join(', ')}.`, 'error');
    return;
  }
  const values = Object.fromEntries(mgrSettingsDirty);
  const result = await mgrRequest<MgrConfigSaveResponse>('PUT', '/api/config', { values });
  if (!result.ok || !result.data) {
    mgrStatus('settings', `Not saved: ${mgrErrorOf(result)}`, 'error');
    return;
  }
  const { changed, restart, groups, settings } = result.data;
  mgrSettingsDirty.clear();
  mgrSettingsInvalid.clear();
  if (Array.isArray(groups) && Array.isArray(settings)) {
    mgrSettings = settings;
    mgrRenderSettings(groups, settings);
  } else {
    await mgrLoadSettings();
  }
  const changedCount = Array.isArray(changed) ? changed.length : 0;
  mgrStatus('settings', changedCount ? `Saved ${changedCount} setting${changedCount === 1 ? '' : 's'}.` : 'Nothing changed.', 'ok');
  mgrShowRestartNotice(Array.isArray(restart) ? restart : []);
}

/** Tell the user which processes must restart for saved settings to apply */
function mgrShowRestartNotice(restart: MgrSettingApplies[]): void {
  const notice = mgrEl('settingsRestartNotice');
  if (!notice || restart.length === 0) return;
  const names: Record<string, string> = { bot: 'the bot', dashboard: 'the dashboard', 'token-generator': 'the token generator' };
  const parts = restart.map(r => names[r] ?? r);
  let text = `Saved. Restart ${parts.join(' and ')} to apply.`;
  if (restart.some(r => r !== 'bot')) text += ' The dashboard and token generator restart when you stop and start npm start (or the container).';
  mgrEl('settingsRestartText').textContent = text;
  notice.hidden = false;
}

// ==================== Song Queue ====================

let mgrCurrentSongId: string | null = null;

async function mgrLoadSongs(): Promise<void> {
  const [queue, blocklist] = await Promise.all([
    mgrRequest<MgrSongQueue>('GET', '/api/song-queue'),
    mgrRequest<MgrBlocklist>('GET', '/api/song-queue/blocklist')
  ]);
  if (!queue.ok || !queue.data) {
    mgrStatus('songs', `Could not load the queue: ${mgrErrorOf(queue)}`, 'error');
    return;
  }
  mgrRenderSongs(queue.data.active ?? []);
  mgrFillSongConfig(queue.data.config ?? {});
  if (blocklist.ok && blocklist.data) mgrRenderBlocklist(blocklist.data);
}

function mgrRenderSongs(active: MgrSong[]): void {
  const current = active[0];
  mgrCurrentSongId = current ? current.id : null;
  const now = mgrEl('songsNowPlaying');
  if (now) {
    now.replaceChildren();
    if (current) {
      now.className = 'mgr-now-playing';
      now.appendChild(mgrNode('strong', current.title));
      const by = current.requesterDisplayName || current.requester || 'unknown';
      now.appendChild(mgrNode('span', ` by ${current.channelTitle ?? 'unknown'} · ${current.durationFormatted ?? '-'} · requested by ${by}`));
    } else {
      now.className = 'mgr-empty';
      now.textContent = 'Nothing is playing.';
    }
  }

  const rows = active.map((song, index) => {
    const position = song.position ?? index + 1;
    const remove = mgrButton('Remove', 'btn-danger btn-small', () => mgrRemoveSong(position, song.title));
    const row = mgrRow([
      index === 0 ? `${position} ▶` : position,
      song.title,
      song.requesterDisplayName || song.requester || '-',
      song.durationFormatted ?? '-',
      song.pointsCost ?? 0
    ], [remove]);
    return row;
  });
  mgrFillTable('songsQueueList', rows, 'The queue is empty.', 6);
}

function mgrFillSongConfig(config: MgrSongConfig): void {
  mgrSetChecked('songsEnabled', config.enabled);
  mgrSetChecked('songsAllowDuplicates', config.allowDuplicates);
  mgrSetValue('songsCost', config.cost);
  mgrSetValue('songsMaxDuration', typeof config.maxDuration === 'number' ? Math.round(config.maxDuration / 60) : '');
  mgrSetValue('songsMaxPerUser', config.maxPerUser);
  mgrSetValue('songsPriority', config.priority ?? 'everyone');
}

function mgrRenderBlocklist(blocklist: MgrBlocklist): void {
  const container = mgrEl('songsBlocklist');
  if (!container) return;
  container.replaceChildren();
  const sections: Array<[string, string[] | undefined]> = [
    ['Videos', blocklist.videos], ['Channels', blocklist.channels], ['Keywords', blocklist.keywords]
  ];
  let total = 0;
  for (const [title, items] of sections) {
    if (!items || items.length === 0) continue;
    total += items.length;
    container.appendChild(mgrNode('h4', title));
    const list = mgrNode('div', undefined, 'blacklist-words');
    for (const item of items) {
      const chip = mgrNode('span', item, 'blacklist-word');
      chip.appendChild(mgrButton('×', 'btn-small mgr-chip-remove', () => mgrUnblockSong(item)));
      list.appendChild(chip);
    }
    container.appendChild(list);
  }
  if (total === 0) container.appendChild(mgrNode('p', 'Nothing is blocked.', 'mgr-empty'));
}

async function mgrSkipSong(): Promise<void> {
  const body = mgrCurrentSongId ? { songId: mgrCurrentSongId } : {};
  const result = await mgrRequest('POST', '/api/song-queue/skip', body);
  mgrReport('songs', result, 'Skipped the current song.');
  await mgrLoadSongs();
}

async function mgrRemoveSong(position: number, title: string): Promise<void> {
  if (!confirm(`Remove "${title}" from the queue? The requester gets their points back.`)) return;
  const result = await mgrRequest('DELETE', `/api/song-queue/${position}`);
  mgrReport('songs', result, `Removed "${title}".`);
  await mgrLoadSongs();
}

async function mgrClearQueue(): Promise<void> {
  if (!confirm('Clear the whole song queue? Everyone gets their points back.')) return;
  const result = await mgrRequest('POST', '/api/song-queue/clear');
  mgrReport('songs', result, 'Cleared the queue.');
  await mgrLoadSongs();
}

async function mgrSaveSongConfig(): Promise<void> {
  const cost = mgrNumber('songsCost');
  const maxMinutes = mgrNumber('songsMaxDuration');
  const maxPerUser = mgrNumber('songsMaxPerUser');
  if (cost === null || cost < 0) return mgrStatus('songs', 'Cost must be 0 or more.', 'error');
  if (maxMinutes === null || maxMinutes <= 0) return mgrStatus('songs', 'Max length must be at least 1 minute.', 'error');
  if (maxPerUser === null || maxPerUser < 1) return mgrStatus('songs', 'Max songs per viewer must be at least 1.', 'error');
  const result = await mgrRequest('PUT', '/api/song-queue/config', {
    enabled: mgrInput('songsEnabled').checked,
    allowDuplicates: mgrInput('songsAllowDuplicates').checked,
    cost: Math.floor(cost),
    maxDuration: Math.round(maxMinutes * 60),
    maxPerUser: Math.floor(maxPerUser),
    priority: mgrEl<HTMLSelectElement>('songsPriority').value
  });
  mgrReport('songs', result, 'Song request settings saved.');
}

async function mgrBlockSong(): Promise<void> {
  const type = mgrEl<HTMLSelectElement>('songsBlockType').value;
  const value = mgrInput('songsBlockValue').value.trim();
  if (!value) return mgrStatus('songs', 'Enter what to block.', 'error');
  const result = await mgrRequest('POST', '/api/song-queue/block', { type, value });
  if (mgrReport('songs', result, `Blocked ${type} "${value}".`)) mgrSetValue('songsBlockValue', '');
  await mgrLoadSongs();
}

async function mgrUnblockSong(value: string): Promise<void> {
  const result = await mgrRequest('DELETE', `/api/song-queue/block/${encodeURIComponent(value)}`);
  mgrReport('songs', result, `Unblocked "${value}".`);
  await mgrLoadSongs();
}

// ==================== Loyalty ====================

const MGR_LOYALTY_NUMBER_FIELDS: Array<keyof MgrLoyaltyConfig> = [
  'pointsPerMinute', 'pointsPerMessage', 'maxPointsPerMessage', 'messageCooldownSeconds',
  'subscriberMultiplier', 'vipMultiplier', 'pointsPerLevel'
];

/** Element id of a loyalty config field, e.g. pointsPerMinute -> loyaltyPointsPerMinute */
function mgrLoyaltyFieldId(field: string): string {
  return `loyalty${field.charAt(0).toUpperCase()}${field.slice(1)}`;
}

async function mgrLoadLoyalty(): Promise<void> {
  const [config, stats, leaderboard, transactions] = await Promise.all([
    mgrRequest<MgrLoyaltyConfig>('GET', '/api/loyalty/config'),
    mgrRequest<MgrLoyaltyStats>('GET', '/api/loyalty/stats'),
    mgrRequest<MgrLeaderboardEntry[]>('GET', '/api/loyalty/leaderboard?limit=50'),
    mgrRequest<MgrTransaction[]>('GET', '/api/loyalty/transactions?limit=25')
  ]);
  if (!config.ok) {
    mgrStatus('loyalty', `Could not load loyalty data: ${mgrErrorOf(config)}`, 'error');
    return;
  }
  const cfg = config.data ?? {};
  mgrSetChecked('loyaltyEnabled', cfg.enabled !== false);
  mgrSetValue('loyaltyCurrencyName', cfg.currencyName);
  mgrSetValue('loyaltyCurrencyNamePlural', cfg.currencyNamePlural);
  for (const field of MGR_LOYALTY_NUMBER_FIELDS) mgrSetValue(mgrLoyaltyFieldId(field), cfg[field] as number | undefined);

  if (stats.ok && stats.data) mgrRenderLoyaltyStats(stats.data, cfg.currencyNamePlural || 'points');
  mgrRenderLeaderboard(leaderboard.ok && Array.isArray(leaderboard.data) ? leaderboard.data : []);
  mgrRenderTransactions(transactions.ok && Array.isArray(transactions.data) ? transactions.data : []);
}

function mgrRenderLoyaltyStats(stats: MgrLoyaltyStats, currency: string): void {
  const grid = mgrEl('loyaltyStats');
  if (!grid) return;
  grid.replaceChildren();
  const cards: Array<[string, number | undefined]> = [
    ['Viewers', stats.totalUsers],
    [`${currency} held`, stats.totalPointsInCirculation],
    [`${currency} earned`, stats.totalPointsEarned],
    [`${currency} spent`, stats.totalPointsSpent],
    ['Average balance', stats.averagePoints],
    ['Top level', stats.topLevel]
  ];
  for (const [title, value] of cards) {
    const card = mgrNode('div', undefined, 'status-card');
    card.appendChild(mgrNode('h3', title));
    card.appendChild(mgrNode('p', (value ?? 0).toLocaleString(), 'status-value'));
    grid.appendChild(card);
  }
}

function mgrRenderLeaderboard(entries: MgrLeaderboardEntry[]): void {
  const rows = entries.map((entry, index) => mgrRow([
    entry.rank ?? index + 1,
    entry.username,
    entry.points,
    entry.level ?? 1,
    `${entry.watchTimeMinutes ?? 0} min`
  ], [mgrButton('Edit', 'btn-secondary btn-small', () => {
    mgrSetValue('loyaltyUser', entry.username);
    mgrSetValue('loyaltyPoints', entry.points);
    mgrInput('loyaltyPoints')?.focus();
  })]));
  mgrFillTable('loyaltyLeaderboard', rows, 'No viewers have points yet.', 6);
}

function mgrRenderTransactions(transactions: MgrTransaction[]): void {
  const rows = transactions.map(t => mgrRow([
    mgrFormatDate(t.timestamp), t.username ?? '-', t.type ?? '-', t.amount ?? 0, t.reason ?? ''
  ]));
  mgrFillTable('loyaltyTransactions', rows, 'No transactions yet.', 5);
}

async function mgrSaveLoyaltyConfig(): Promise<void> {
  const config: Record<string, unknown> = { enabled: mgrInput('loyaltyEnabled').checked };
  const name = mgrInput('loyaltyCurrencyName').value.trim();
  const plural = mgrInput('loyaltyCurrencyNamePlural').value.trim();
  if (name) config.currencyName = name;
  if (plural) config.currencyNamePlural = plural;
  for (const field of MGR_LOYALTY_NUMBER_FIELDS) {
    const value = mgrNumber(mgrLoyaltyFieldId(field));
    if (value !== null) config[field] = value;
  }
  const result = await mgrRequest('PUT', '/api/loyalty/config', config);
  if (mgrReport('loyalty', result, 'Points settings saved.')) await mgrLoadLoyalty();
}

async function mgrSetUserPoints(): Promise<void> {
  const username = mgrInput('loyaltyUser').value.trim().replace(/^@/, '');
  const points = mgrNumber('loyaltyPoints');
  if (!/^[A-Za-z0-9_]{1,25}$/.test(username)) return mgrStatus('loyalty', 'Enter a valid Twitch username.', 'error');
  if (points === null || points < 0 || !Number.isInteger(points)) return mgrStatus('loyalty', 'Points must be a whole number, 0 or more.', 'error');
  const result = await mgrRequest('PUT', `/api/loyalty/user/${encodeURIComponent(username.toLowerCase())}/points`, {
    points, reason: 'Set from dashboard'
  });
  if (mgrReport('loyalty', result, `${username} now has ${points.toLocaleString()} points.`)) await mgrLoadLoyalty();
}

// ==================== Quotes ====================

let mgrQuotesCurrentPage = 1;
let mgrQuotesTotalPages = 1;

async function mgrLoadQuotes(page = 1): Promise<void> {
  const search = mgrInput('quotesSearch')?.value.trim() ?? '';
  const params = new URLSearchParams({ page: String(page), pageSize: '20' });
  if (search) params.set('search', search);
  const [list, config] = await Promise.all([
    mgrRequest<MgrQuotesPage>('GET', `/api/quotes?${params.toString()}`),
    mgrRequest<MgrQuotesConfig>('GET', '/api/quotes/config')
  ]);
  if (!list.ok || !list.data) {
    mgrStatus('quotes', `Could not load quotes: ${mgrErrorOf(list)}`, 'error');
    return;
  }
  mgrQuotesCurrentPage = list.data.currentPage ?? 1;
  mgrQuotesTotalPages = Math.max(1, list.data.totalPages ?? 1);
  const rows = (list.data.quotes ?? []).map(quote => mgrRow(
    [quote.id, quote.text ?? '', quote.addedBy ?? '-', quote.game ?? '-'],
    [
      mgrButton('Edit', 'btn-secondary btn-small', () => mgrEditQuote(quote)),
      mgrButton('Delete', 'btn-danger btn-small', () => mgrDeleteQuote(quote))
    ]
  ));
  mgrFillTable('quotesList', rows, search ? 'No quotes match your search.' : 'No quotes yet.', 5);
  mgrEl('quotesPageInfo').textContent = `Page ${mgrQuotesCurrentPage} of ${mgrQuotesTotalPages} (${list.data.totalQuotes ?? 0} quotes)`;
  mgrEl<HTMLButtonElement>('quotesPrev').disabled = mgrQuotesCurrentPage <= 1;
  mgrEl<HTMLButtonElement>('quotesNext').disabled = mgrQuotesCurrentPage >= mgrQuotesTotalPages;

  if (config.ok && config.data) {
    mgrSetValue('quotesMinLength', config.data.minLength);
    mgrSetValue('quotesMaxLength', config.data.maxLength);
    mgrSetValue('quotesMaxQuotes', config.data.maxQuotes);
    mgrSetChecked('quotesAllowDuplicates', config.data.allowDuplicates);
  }
}

function mgrQuotesPage(delta: number): void {
  const next = Math.min(mgrQuotesTotalPages, Math.max(1, mgrQuotesCurrentPage + delta));
  if (next !== mgrQuotesCurrentPage) mgrLoadQuotes(next);
}

async function mgrAddQuote(): Promise<void> {
  const text = mgrInput('quoteText').value.trim();
  const addedBy = mgrInput('quoteAddedBy').value.trim() || 'dashboard';
  const game = mgrInput('quoteGame').value.trim();
  if (!text) return mgrStatus('quotes', 'Enter the quote text.', 'error');
  const body: Record<string, string> = { text, addedBy };
  if (game) body.game = game;
  const result = await mgrRequest<{ quote?: MgrQuote }>('POST', '/api/quotes', body);
  if (mgrReport('quotes', result, `Added quote #${result.data?.quote?.id ?? ''}.`)) {
    mgrSetValue('quoteText', '');
    mgrSetValue('quoteGame', '');
    await mgrLoadQuotes(mgrQuotesCurrentPage);
  }
}

async function mgrEditQuote(quote: MgrQuote): Promise<void> {
  const text = prompt(`Edit quote #${quote.id}`, quote.text ?? '');
  if (text === null) return;
  if (!text.trim()) return mgrStatus('quotes', 'A quote cannot be empty.', 'error');
  const result = await mgrRequest('PUT', `/api/quotes/${quote.id}`, { text: text.trim() });
  if (mgrReport('quotes', result, `Updated quote #${quote.id}.`)) await mgrLoadQuotes(mgrQuotesCurrentPage);
}

async function mgrDeleteQuote(quote: MgrQuote): Promise<void> {
  if (!confirm(`Delete quote #${quote.id}?`)) return;
  const result = await mgrRequest('DELETE', `/api/quotes/${quote.id}`);
  if (mgrReport('quotes', result, `Deleted quote #${quote.id}.`)) await mgrLoadQuotes(mgrQuotesCurrentPage);
}

async function mgrSaveQuotesConfig(): Promise<void> {
  const minLength = mgrNumber('quotesMinLength');
  const maxLength = mgrNumber('quotesMaxLength');
  const maxQuotes = mgrNumber('quotesMaxQuotes');
  if (minLength === null || minLength < 1 || maxLength === null || maxLength < minLength) {
    return mgrStatus('quotes', 'Lengths must be at least 1, and the maximum at least the minimum.', 'error');
  }
  if (maxQuotes === null || maxQuotes < 1) return mgrStatus('quotes', 'Maximum quotes must be at least 1.', 'error');
  const result = await mgrRequest('PUT', '/api/quotes/config', {
    minLength: Math.floor(minLength), maxLength: Math.floor(maxLength), maxQuotes: Math.floor(maxQuotes),
    allowDuplicates: mgrInput('quotesAllowDuplicates').checked
  });
  mgrReport('quotes', result, 'Quote settings saved.');
}

async function mgrExportQuotes(): Promise<void> {
  const result = await mgrRequest<{ quotes?: MgrQuote[] }>('GET', '/api/quotes/export');
  if (!result.ok || !result.data) return mgrStatus('quotes', `Export failed: ${mgrErrorOf(result)}`, 'error');
  mgrDownloadJson(`quotes-${new Date().toISOString().slice(0, 10)}.json`, result.data);
  mgrStatus('quotes', `Exported ${result.data.quotes?.length ?? 0} quotes.`, 'ok');
}

async function mgrImportQuotes(): Promise<void> {
  const parsed = await mgrReadJsonFile('quotesImportFile', 'quotes');
  if (parsed === undefined) return;
  // Accept an export file ({ quotes: [...] }) or a bare array
  const quotes = Array.isArray(parsed) ? parsed : (parsed as { quotes?: unknown } | null)?.quotes;
  if (!Array.isArray(quotes)) return mgrStatus('quotes', 'That file has no quotes list.', 'error');
  const result = await mgrRequest<{ imported?: number; skipped?: number }>('POST', '/api/quotes/import', { quotes, merge: true });
  if (mgrReport('quotes', result, `Imported ${result.data?.imported ?? 0} quotes (${result.data?.skipped ?? 0} skipped).`)) {
    await mgrLoadQuotes(1);
  }
}

// ==================== Counters ====================

async function mgrLoadCounters(): Promise<void> {
  const result = await mgrRequest<MgrCounter[]>('GET', '/api/counters');
  if (!result.ok || !Array.isArray(result.data)) {
    mgrStatus('counters', `Could not load counters: ${mgrErrorOf(result)}`, 'error');
    return;
  }
  mgrRenderCounters(result.data);
}

function mgrRenderCounters(counters: MgrCounter[]): void {
  const sorted = [...counters].sort((a, b) => a.name.localeCompare(b.name));
  const rows = sorted.map(counter => {
    const setInput = mgrNode('input');
    setInput.type = 'number';
    setInput.step = '1';
    setInput.placeholder = 'Set to';
    setInput.className = 'mgr-inline-number';
    setInput.setAttribute('aria-label', `New value for ${counter.name}`);
    return mgrRow([counter.name, counter.description ?? '', counter.value], [
      mgrButton('−', 'btn-secondary btn-small', () => mgrCounterAction(counter.name, 'decrement')),
      mgrButton('+', 'btn-secondary btn-small', () => mgrCounterAction(counter.name, 'increment')),
      mgrButton('Reset', 'btn-secondary btn-small', () => mgrCounterAction(counter.name, 'reset')),
      setInput,
      mgrButton('Set', 'btn-secondary btn-small', () => mgrSetCounter(counter.name, setInput.value)),
      mgrButton('Delete', 'btn-danger btn-small', () => mgrDeleteCounter(counter.name))
    ]);
  });
  mgrFillTable('countersList', rows, 'No counters yet.', 4);
}

async function mgrCounterAction(name: string, action: 'increment' | 'decrement' | 'reset'): Promise<void> {
  const body = action === 'reset' ? {} : { amount: 1 };
  const result = await mgrRequest('POST', `/api/counters/${encodeURIComponent(name)}/${action}`, body);
  if (!result.ok) mgrStatus('counters', mgrErrorOf(result), 'error');
  await mgrLoadCounters();
}

async function mgrSetCounter(name: string, raw: string): Promise<void> {
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isInteger(value)) return mgrStatus('counters', 'Enter a whole number to set.', 'error');
  const result = await mgrRequest('PUT', `/api/counters/${encodeURIComponent(name)}`, { value });
  mgrReport('counters', result, `${name} set to ${value}.`);
  await mgrLoadCounters();
}

async function mgrCreateCounter(): Promise<void> {
  const name = mgrInput('newCounterName').value.trim();
  const description = mgrInput('newCounterDescription').value.trim();
  const initialValue = mgrNumber('newCounterInitial') ?? 0;
  if (!name) return mgrStatus('counters', 'Enter a counter name.', 'error');
  if (!Number.isInteger(initialValue)) return mgrStatus('counters', 'The start value must be a whole number.', 'error');
  const body: Record<string, unknown> = { name, initialValue };
  if (description) body.description = description;
  const result = await mgrRequest('POST', '/api/counters', body);
  if (mgrReport('counters', result, `Created counter "${name}".`)) {
    mgrSetValue('newCounterName', '');
    mgrSetValue('newCounterDescription', '');
    mgrSetValue('newCounterInitial', 0);
  }
  await mgrLoadCounters();
}

async function mgrDeleteCounter(name: string): Promise<void> {
  if (!confirm(`Delete the "${name}" counter?`)) return;
  const result = await mgrRequest('DELETE', `/api/counters/${encodeURIComponent(name)}`);
  mgrReport('counters', result, `Deleted "${name}".`);
  await mgrLoadCounters();
}

// ==================== Backups ====================

async function mgrLoadBackups(): Promise<void> {
  const result = await mgrRequest<MgrBackupEntry[]>('GET', '/api/backup/list');
  if (!result.ok || !Array.isArray(result.data)) {
    mgrStatus('backups', `Could not load backups: ${mgrErrorOf(result)}`, 'error');
    return;
  }
  const rows = result.data.map(backup => mgrRow(
    [mgrFormatDate(backup.createdAt), backup.filename, mgrFormatBytes(backup.size), (backup.includes ?? []).join(', ') || '-'],
    [
      mgrButton('Download', 'btn-secondary btn-small', () => mgrDownloadBackup(backup.filename)),
      mgrButton('Restore', 'btn-primary btn-small', () => mgrRestoreBackup(backup.filename)),
      mgrButton('Delete', 'btn-danger btn-small', () => mgrDeleteBackup(backup.filename))
    ]
  ));
  mgrFillTable('backupsList', rows, 'No backups yet.', 5);
}

async function mgrCreateBackup(): Promise<void> {
  const result = await mgrRequest<{ filename?: string }>('POST', '/api/backup/create', {});
  mgrReport('backups', result, `Created ${result.data?.filename ?? 'backup'}.`);
  await mgrLoadBackups();
}

async function mgrDownloadBackup(filename: string): Promise<void> {
  const result = await mgrRequest('GET', `/api/backup/${encodeURIComponent(filename)}`);
  if (!result.ok) return mgrStatus('backups', `Download failed: ${mgrErrorOf(result)}`, 'error');
  mgrDownloadJson(filename, result.data);
}

async function mgrRestoreBackup(filename: string): Promise<void> {
  if (!confirm(`Restore ${filename}? This overwrites the current commands, points, quotes, counters and alert settings with the backup's copies.`)) return;
  const backup = await mgrRequest('GET', `/api/backup/${encodeURIComponent(filename)}`);
  if (!backup.ok) return mgrStatus('backups', `Restore failed: ${mgrErrorOf(backup)}`, 'error');
  const result = await mgrRequest<{ restored?: string[]; errors?: string[] }>('POST', '/api/backup/restore', { backup: backup.data });
  if (!result.ok || !result.data) return mgrStatus('backups', `Restore failed: ${mgrErrorOf(result)}`, 'error');
  const restored = result.data.restored ?? [];
  const errors = result.data.errors ?? [];
  const message = `Restored ${restored.join(', ') || 'nothing'}.${errors.length ? ` Failed: ${errors.join(', ')}.` : ''} Restart the bot to reload them.`;
  mgrStatus('backups', message, errors.length ? 'error' : 'ok');
}

async function mgrDeleteBackup(filename: string): Promise<void> {
  if (!confirm(`Delete ${filename}? This cannot be undone.`)) return;
  const result = await mgrRequest('DELETE', `/api/backup/${encodeURIComponent(filename)}`);
  mgrReport('backups', result, `Deleted ${filename}.`);
  await mgrLoadBackups();
}

async function mgrUploadBackup(): Promise<void> {
  const backup = await mgrReadJsonFile('backupUploadFile', 'backups');
  if (backup === undefined) return;
  const result = await mgrRequest<{ filename?: string }>('POST', '/api/backup/upload', { backup });
  mgrReport('backups', result, `Uploaded as ${result.data?.filename ?? 'a new backup'}.`);
  await mgrLoadBackups();
}
