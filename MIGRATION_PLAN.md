# TypeScript Migration Plan — Excella (Twitch Chat Bot)

## Executive Summary

The project already has a solid TypeScript foundation: 27 source files (~8,100 lines) covering
types, config, commands, filters, services, utilities, and integrations — all with tests. However,
the entire **running application** is still plain JavaScript and never touches those modules.

This plan migrates the remaining ~11,200 lines of JavaScript into TypeScript across 7 phases,
keeping the bot fully functional throughout. Each phase is independently shippable.

---

## Accurate Scope

### Already done (src/)

| Module group | Files | Lines |
|---|---|---|
| Types & constants | 2 | 492 |
| Commands (registry + handlers) | 6 | 1,393 |
| Chat filter | 2 | 280 |
| Services (loyalty, quotes, counters, analytics, backup, stream-utils, scheduler) | 8 | 4,220 |
| Utilities (logger, rate-limiter, shutdown) | 4 | 998 |
| Integrations (discord, eventsub-handlers) | 3 | 1,040 |
| **Total** | **27** | **~8,100** |

### Still to migrate (JavaScript)

| File / Group | Lines | Notes |
|---|---|---|
| `Excella.js` | 3,652 | Core bot — biggest single file |
| `lib/twitch-helix-api.js` | 658 | Helix REST client |
| `lib/twitch-eventsub-ws.js` | 616 | EventSub WebSocket client |
| `dashboard/routes/song-queue.js` | 778 | Song request API |
| `dashboard/routes/backup.js` | 489 | Backup/restore API |
| `dashboard/lib/loyalty-store.js` | 609 | Loyalty persistence layer |
| `dashboard/routes/api.js` | 344 | General dashboard API |
| `dashboard/routes/loyalty.js` | 338 | Loyalty API |
| `dashboard/routes/quotes.js` | 331 | Quotes API |
| `dashboard/routes/counters.js` | 308 | Counters API |
| `lib/twitch-irc-client.js` | 279 | tmi.js IRC wrapper |
| `dashboard/lib/constants.js` | 237 | Dashboard defaults |
| `dashboard/server.js` | 220 | Express + WebSocket server |
| `tts-service.js` | 410 | ElevenLabs/OpenAI/browser TTS |
| `account-manager.js` | 402 | AES-256-CBC account storage |
| `dashboard/routes/alerts.js` | 167 | Alerts API |
| `token-generator.js` | 164 | OAuth setup server |
| `lib/env-manager.js` | 140 | .env file manager |
| `dashboard/lib/utils.js` | 99 | Dashboard utilities |
| `lib/file-lock.js` | 99 | Cross-process file locking |
| `dashboard/routes/uploads.js` | 111 | File upload API |
| `dashboard/routes/filters.js` | 82 | Filter words API |
| `lib/api-utils.js` | 52 | Express error helpers |
| `dashboard/lib/state.js` | 70 | WebSocket state |
| `dashboard/routes/obs.js` | 69 | OBS config API |
| `token-generator-api/scope-routes.js` | 179 | OAuth scope management |
| `token-generator-api/auth-routes.js` | 110 | OAuth flow |
| `token-generator-api/account-routes.js` | 68 | Account API |
| `token-generator-api/env-routes.js` | 55 | Env API |
| `lib/logger.js` | 39 | Simple logger (replace with src/utils/logger.ts) |
| `lib/console-timestamp.js` | 33 | Timestamp patching |
| `dashboard/lib/middleware.js` | 22 | Express middleware |
| **Total** | **~11,200** | |

**Grand total when complete:** ~19,300 lines of TypeScript across ~60 files.

---

## Prerequisites

Complete these before any phase begins.

### 1. Install missing `@types` package

`@types/tmi.js` exists on npm and covers the IRC client.

```bash
npm install --save-dev @types/tmi.js
```

### 2. Extend tsconfig.json to cover lib/ and dashboard/

The current `tsconfig.json` only includes `src/**/*`. Extend it:

```json
{
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.test.ts", "**/*.spec.ts"]
}
```

This stays the same for now — migrated files will live under `src/` so no tsconfig change is
needed per phase.

### 3. Verify the build pipeline works end-to-end

```bash
npm run build      # should produce dist/ with no errors
npm run typecheck  # should pass cleanly
npm test           # all 16 existing test files should pass
```

Fix any existing compilation errors before starting phase work.

### 4. Add a dev entry point script

Add to `package.json` so the bot can be run from compiled output alongside the existing JS run:

```json
"scripts": {
  "bot:ts": "node dist/bot.js",
  "bot":    "node Excella.js"
}
```

Both scripts coexist during migration; `bot` stays unchanged until Phase 7.

---

## Phase 1 — Infrastructure: Small Utility Libraries

**Goal:** Migrate the lowest-level utility files. Everything else depends on these, so getting
them typed first unlocks downstream work with no risk of breaking the running bot.

**Files to create:**

| Target | Source | Lines |
|---|---|---|
| `src/lib/file-lock.ts` | `lib/file-lock.js` | 99 |
| `src/lib/api-utils.ts` | `lib/api-utils.js` | 52 |
| `src/lib/console-timestamp.ts` | `lib/console-timestamp.js` | 33 |
| `src/lib/env-manager.ts` | `lib/env-manager.js` | 140 |

**Integration:** These are pure utilities. The JS originals stay in place and continue to be
`require()`-ed by the running bot. The TS versions are compiled to `dist/lib/` and will be
imported by later TypeScript phases.

**Key typing work:**
- `file-lock.ts`: Type the `withCrossProcessLock<T>(path, fn: () => Promise<T>): Promise<T>`
  signature and the sync variant.
- `env-manager.ts`: Type the parsed `.env` object as `Record<string, string>` with specific
  known keys where possible.
- `api-utils.ts`: Type the Express `asyncHandler` wrapper using `@types/express`
  `RequestHandler`.

**Tests to write:** `tests/lib/file-lock.test.ts`, `tests/lib/env-manager.test.ts`

**Definition of done:**
- `npm run build` succeeds with new files included
- `npm run typecheck` passes
- Original JS files still work (`npm run bot` unchanged)

---

## Phase 2 — Twitch Client Libraries

**Goal:** Migrate the three Twitch client wrappers. These are the most important untyped
modules — they underpin every API call, chat message, and EventSub event in the bot.

**Files to create:**

| Target | Source | Lines | Dependency |
|---|---|---|---|
| `src/lib/twitch-helix-api.ts` | `lib/twitch-helix-api.js` | 658 | axios |
| `src/lib/twitch-irc-client.ts` | `lib/twitch-irc-client.js` | 279 | tmi.js + `@types/tmi.js` |
| `src/lib/twitch-eventsub-ws.ts` | `lib/twitch-eventsub-ws.js` | 616 | ws + `@types/ws` |

**Key typing work:**

`twitch-helix-api.ts` — type every Helix response. Lean on the existing types already defined
in `src/types/index.ts`: `TwitchUser`, `TwitchStream`, `TwitchChannel`, `ChannelFollower`,
`PaginatedResult`. Add any missing types (polls, predictions, clips) directly to
`src/types/index.ts`.

```typescript
// Example: typed method signature
async getUser(login: string): Promise<TwitchUser | null>
async updateStreamTitle(broadcasterId: string, title: string): Promise<void>
async createPoll(broadcasterId: string, opts: CreatePollOptions): Promise<Poll>
```

`twitch-irc-client.ts` — wrap the `tmi.Client` with typed event callbacks:

```typescript
onMessage(handler: (channel: string, user: UserInfo, message: string, msg: ChatMessage) => void): void
sendMessage(channel: string, message: string): Promise<void>
```

`twitch-eventsub-ws.ts` — type WebSocket message payloads using the EventSub types already
in `src/types/index.ts`.

**Existing test to update:** `tests/lib/twitch-helix-api.test.ts` already exists — update its
import path to point to the new TS file.

**Tests to write:** `tests/lib/twitch-irc-client.test.ts`, `tests/lib/twitch-eventsub-ws.test.ts`

**Definition of done:**
- All three clients compile without `any` casts except where tmi.js internals require it
- Helix API response types match `src/types/index.ts`
- Existing Helix API tests pass against new TS implementation

---

## Phase 3 — Standalone Services: Account Manager & TTS

**Goal:** Migrate the two self-contained services that have clear interfaces and no dependencies
on other JS files being migrated.

**Files to create:**

| Target | Source | Lines |
|---|---|---|
| `src/lib/account-manager.ts` | `account-manager.js` | 402 |
| `src/services/tts.ts` | `tts-service.js` | 410 |

**Key typing work:**

`account-manager.ts` — define `AccountData` and `AccountCredentials` types:

```typescript
interface AccountCredentials {
  clientId: string;
  clientSecret: string;
  broadcasterName: string;
  channels: string[];
  accessToken: string;
  refreshToken: string;
  scopes: string[];
  broadcasterAccessToken?: string;
  broadcasterRefreshToken?: string;
  broadcasterScopes?: string[];
}

class AccountManager {
  listAccounts(): string[]
  getAccount(name: string): AccountCredentials | null
  saveAccount(name: string, data: AccountCredentials): void
  deleteAccount(name: string): void
  toEnvObject(name: string): Record<string, string>
}
```

`tts.ts` — define the provider union type and cache metadata:

```typescript
type TTSProvider = 'browser' | 'elevenlabs' | 'openai';

interface TTSOptions {
  provider?: TTSProvider;
  voice?: string;
  text: string;
}

interface TTSResult {
  provider: TTSProvider;
  audioUrl?: string;  // undefined = use browser TTS
  text: string;
}

async function generateTTS(opts: TTSOptions): Promise<TTSResult>
```

**Tests to write:** `tests/lib/account-manager.test.ts`, `tests/services/tts.test.ts`

**Definition of done:**
- AES-256-CBC encryption/decryption round-trips verified in tests
- TTS cache logic (LRU eviction, hash keying) fully typed
- No `any` in public API surface

---

## Phase 4 — Wire Existing src/ Modules into the Bot

**Goal:** Without rewriting Excella.js, replace its inline implementations with calls to the
already-written, already-tested TypeScript modules. This delivers immediate value from the
existing `src/` work and validates that those modules behave identically to the JS originals.

This phase requires modifying `Excella.js` (still a JS file) to `require()` from `dist/`.

**Substitutions to make in Excella.js:**

| Excella.js section | Replace with | Lines affected |
|---|---|---|
| `checkChatFilters()` / `checkChatFiltersWithoutSideEffects()` (347–455) | `ChatFilterManager` from `dist/filters/chat-filter.js` | ~110 lines removed |
| Inline cooldown state (`isOnCooldown`, `setCooldown`) (920–929) | `CommandRateLimiter` from `dist/utils/rate-limiter.js` | ~20 lines removed |
| `console.log` / `console.error` calls throughout | `Logger` from `dist/utils/logger.js` | ~50 callsites |
| `startAnnouncements()` (456–504) | `SchedulerManager` from `dist/services/scheduler.js` | ~50 lines removed |
| `handleBalance` / `handleLeaderboard` (1961–2005) | `LoyaltyManager` from `dist/services/loyalty.js` | ~45 lines removed |
| `handleQuote` (2006–2021) | `QuotesManager` from `dist/services/quotes.js` | ~15 lines removed |
| `handleCounter` (2022–2058) | `CountersManager` from `dist/services/counters.js` | ~35 lines removed |
| `logCommandExecution` (247–259) | `AnalyticsManager.trackCommand()` from `dist/services/analytics.js` | ~15 lines |

**Integration pattern:**

```javascript
// Excella.js — require compiled TS output
const { getFilterManager } = require('./dist/filters/chat-filter');
const filterManager = getFilterManager();

// Replace inline checkChatFilters() call:
const violation = filterManager.checkMessage(message, username);
if (violation) { /* ... */ }
```

**Tests to write:** `tests/regression/filter-parity.test.ts` — run the same messages through
both the old inline filter and `ChatFilterManager`, assert identical results.

**Definition of done:**
- `npm run bot` still works with no behavior change observable in chat
- All substituted module calls covered by parity tests
- `npm test` still passes

---

## Phase 5 — Migrate Excella.js

**Goal:** Decompose the 3,652-line monolith into typed TypeScript modules. This is the largest
phase; it is broken into independently-committable sub-steps (5a–5j).

### 5a — Token Management

**Target:** `src/auth/token-manager.ts`
**Source:** Excella.js lines 970–1297
**Lines:** ~330

Exports:
```typescript
class TokenManager {
  hasScope(scopes: string, target: string): boolean
  hasScopeList(scopes: string, targets: string[]): boolean
  async validateTokenCached(token: string, accountType?: 'bot' | 'broadcaster'): Promise<boolean>
  async refreshToken(accessToken: string, refreshToken: string, accountType: 'bot' | 'broadcaster'): Promise<TokenData>
  async validateAndRefreshTokens(): Promise<void>
  scheduleProactiveRefresh(): void
}
```

Tests: `tests/auth/token-manager.test.ts`

### 5b — EventSub Setup

**Target:** `src/eventsub/setup.ts`
**Source:** Excella.js lines 505–815
**Lines:** ~310

This module wires together:
- `TwitchEventSubWS` (from Phase 2)
- `EventSubHandlersManager` (already in `src/integrations/eventsub-handlers.ts`)
- The `setupEventSub()` and `setupBroadcasterEventSub()` logic

Exports:
```typescript
async function setupEventSub(config: BotConfig): Promise<void>
async function setupBroadcasterEventSub(config: BotConfig): Promise<void>
```

Tests: `tests/eventsub/setup.test.ts` (mock the WS client)

### 5c — Channel API Command Handlers

**Target:** `src/commands/channel.ts`
**Source:** Excella.js lines 1359–1570, 1636–1689, 1911–1945
**Lines:** ~350

Handlers: `handleClip`, `handleFollowage`, `handleShoutout`, `handleTitle`, `handleGame`

These all follow the same pattern — call Helix API, post response to chat. Type the
`TwitchHelixAPI` client (Phase 2) as a dependency injected via constructor or parameter.

Tests: `tests/commands/channel.test.ts`

### 5d — Fun Commands

**Target:** `src/commands/fun.ts`
**Source:** Excella.js lines 2059–2170
**Lines:** ~115

Handlers: `handle8ball`, `handleDice`, `handleCoinflip`, `handleGamba`, `handleDuel`, `handleHype`

Pure logic with no external API calls — the easiest handlers to migrate.

Tests: `tests/commands/fun.test.ts`

### 5e — Poll & Prediction Handlers

**Target:** `src/commands/polls.ts`
**Source:** Excella.js lines 1690–1910
**Lines:** ~220

Handlers: `handlePoll` (start, end, list), `handlePrediction` (start, resolve, cancel)

Requires typed poll/prediction types — add `CreatePollOptions`, `Poll`, `Prediction` to
`src/types/index.ts`.

Tests: `tests/commands/polls.test.ts`

### 5f — TTS Handler

**Target:** `src/commands/tts-handler.ts`
**Source:** Excella.js lines 2171–2301
**Lines:** ~130

The `handleTTS` function calls `generateTTS()` from Phase 3's `src/services/tts.ts` and
broadcasts via WebSocket. Depends on `TTS_CONFIG` constants already in `src/config/constants.ts`.

Tests: `tests/commands/tts-handler.test.ts`

### 5g — YouTube Utilities

**Target:** `src/services/youtube.ts`
**Source:** Excella.js lines 2302–2469
**Lines:** ~170

Exports:
```typescript
function extractVideoId(input: string): string | null
function isYouTubeUrl(input: string): boolean
function parseIsoDuration(duration: string): number  // seconds
function formatDuration(seconds: number): string
async function getYouTubeMetadata(videoId: string): Promise<YouTubeVideo>
async function searchYouTube(query: string, maxResults?: number): Promise<YouTubeVideo[]>

interface YouTubeVideo {
  id: string;
  title: string;
  channelTitle: string;
  durationSeconds: number;
  thumbnailUrl: string;
}
```

Tests: `tests/services/youtube.test.ts` (mock axios)

### 5h — Song Request Handlers

**Target:** `src/commands/song-request.ts`
**Source:** Excella.js lines 2470–3127
**Lines:** ~660

Handlers: `handleSongRequest`, `handleCurrentSong`, `handleQueueInfo`, `handleSkipSong`,
`handleRemoveSong`, `handleClearQueue`, `handleBlockSong`, `handleUnblockSong`,
`handleSongRequestConfig`

Depends on `src/services/youtube.ts` (Phase 5g) and the Helix client (Phase 2) for loyalty
points deduction. Define `SongQueueEntry`, `SongQueueConfig`, `SongBlocklistEntry` in
`src/types/index.ts`.

Tests: `tests/commands/song-request.test.ts`

### 5i — Custom Command System

**Target:** `src/commands/custom.ts`
**Source:** Excella.js lines 881–969, 3168–3491
**Lines:** ~415

The template renderer (`formatResponse`, `renderCustomCommand`) and the full
`handleCustomCommand` routing logic. Type the template variable context:

```typescript
interface CommandTemplateContext {
  user: string;
  channel: string;
  args: string[];
  count?: number;
  uptime?: string;
  game?: string;
}
```

Tests: `tests/commands/custom.test.ts`

### 5j — Bot Entry Point

**Target:** `src/bot.ts`
**Source:** Excella.js lines 1–172, 1298–1358, 3492–3652
**Lines:** ~395

The bot's `init()`, `start()`, and `handleChatCommand()` functions wired to all the typed
modules from 5a–5i. This file becomes the new application entry point.

```typescript
// src/bot.ts
import { TokenManager } from './auth/token-manager';
import { getCommandRegistry } from './commands/registry';
import { TwitchIRCClient } from './lib/twitch-irc-client';
// ...

async function init(): Promise<void> { /* ... */ }
async function start(): Promise<void> { /* ... */ }
```

**Definition of done for Phase 5:**
- `node dist/bot.js` starts the bot and connects to Twitch
- All commands respond identically to the old Excella.js
- `npm run bot` (old JS) and `npm run bot:ts` (new TS) both work during transition
- Regression test suite passes: `tests/regression/message-handler.test.ts`

---

## Phase 6 — Dashboard Migration

**Goal:** Migrate the Express API server and all routes. The dashboard can be migrated
independently of the bot (Phases 1–5) since it communicates with Excella.js via HTTP and
WebSocket, not direct imports.

**Files to create:**

| Target | Source | Lines |
|---|---|---|
| `src/dashboard/lib/state.ts` | `dashboard/lib/state.js` | 70 |
| `src/dashboard/lib/middleware.ts` | `dashboard/lib/middleware.js` | 22 |
| `src/dashboard/lib/utils.ts` | `dashboard/lib/utils.js` | 99 |
| `src/dashboard/lib/constants.ts` | `dashboard/lib/constants.js` | 237 |
| `src/dashboard/lib/loyalty-store.ts` | `dashboard/lib/loyalty-store.js` | 609 |
| `src/dashboard/routes/filters.ts` | `dashboard/routes/filters.js` | 82 |
| `src/dashboard/routes/obs.ts` | `dashboard/routes/obs.js` | 69 |
| `src/dashboard/routes/uploads.ts` | `dashboard/routes/uploads.js` | 111 |
| `src/dashboard/routes/alerts.ts` | `dashboard/routes/alerts.js` | 167 |
| `src/dashboard/routes/api.ts` | `dashboard/routes/api.js` | 344 |
| `src/dashboard/routes/counters.ts` | `dashboard/routes/counters.js` | 308 |
| `src/dashboard/routes/quotes.ts` | `dashboard/routes/quotes.js` | 331 |
| `src/dashboard/routes/loyalty.ts` | `dashboard/routes/loyalty.js` | 338 |
| `src/dashboard/routes/backup.ts` | `dashboard/routes/backup.js` | 489 |
| `src/dashboard/routes/song-queue.ts` | `dashboard/routes/song-queue.js` | 778 |
| `src/dashboard/server.ts` | `dashboard/server.js` | 220 |

**Integration:** The route files for loyalty, quotes, counters, and backup should import
directly from the corresponding `src/services/` managers rather than duplicating persistence
logic. This is the key architectural improvement this phase enables:

```typescript
// src/dashboard/routes/loyalty.ts
import { getLoyaltyManager } from '../../services/loyalty';

router.get('/api/loyalty/leaderboard', async (req, res) => {
  const manager = getLoyaltyManager();
  const entries = await manager.getLeaderboard(10);
  res.json(entries);
});
```

**WebSocket types:** Add typed WebSocket event payloads to `src/types/index.ts`:

```typescript
interface WebSocketEvent {
  type: 'state' | 'log' | 'stats' | 'song-queue-update' | 'redemption' | 'eventsub-event';
  data: unknown;
}
```

**Tests to write:** `tests/dashboard/routes/loyalty.test.ts` (and others using supertest)

**Definition of done:**
- `node dist/dashboard/server.js` starts the dashboard
- All API endpoints return identical responses to the old JS dashboard
- WebSocket events broadcast correctly to connected overlays

---

## Phase 7 — Final Integration & Cleanup

**Goal:** Cut over the package entry points to the compiled TypeScript, remove redundant JS
files, and clean up.

### 7a — Update package.json entry points

```json
{
  "main": "dist/bot.js",
  "scripts": {
    "bot":       "node dist/bot.js",
    "dashboard": "node dist/dashboard/server.js",
    "dev":       "concurrently \"npm run bot\" \"npm run dashboard\"",
    "build":     "tsc",
    "build:watch": "tsc --watch",
    "start":     "npm run build && npm run dev"
  }
}
```

### 7b — Remove redundant JavaScript files

Only delete after confirming the TS equivalents are stable:

```
Excella.js
tts-service.js
account-manager.js
lib/twitch-helix-api.js
lib/twitch-irc-client.js
lib/twitch-eventsub-ws.js
lib/env-manager.js
lib/file-lock.js
lib/api-utils.js
lib/logger.js
lib/console-timestamp.js
dashboard/server.js
dashboard/routes/*.js
dashboard/lib/*.js
token-generator-api/*.js
```

Keep `token-generator.js` and its API routes until tested in production — the OAuth flow
is infrequently used but critical.

### 7c — Update tsconfig.json

Remove `"allowJs": true` since all files are now TypeScript:

```json
{
  "compilerOptions": {
    "allowJs": false,
    "checkJs": false
  }
}
```

### 7d — Update CLAUDE.md

Revise the project structure section, update Quick Start commands, and remove references to
JS file locations.

**Definition of done:**
- `npm install && npm run build && npm run dev` starts both services from scratch
- All OBS overlays connect and receive events
- `npm test` passes with ≥50% coverage thresholds met
- No `.js` files remain in root or `lib/` (except config/overlay files)

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `tmi.js` types missing or wrong | Low | High | `@types/tmi.js` exists; add custom overrides to `src/types/tmi.d.ts` if needed |
| Dual-token logic type confusion (bot vs. broadcaster) | Medium | High | Use branded types: `type BotToken = string & { _brand: 'bot' }` to make swapping impossible |
| Song request system regression (778 + 660 lines) | High | Medium | Write thorough unit tests in Phase 5g/5h before cutting over; keep JS version as fallback |
| Dashboard WebSocket clients losing events during switchover | Medium | Medium | Phase 6 keeps old JS dashboard running until new one is validated in parallel |
| Breaking `dist/` import paths in Phase 4 | Medium | Low | All Phase 4 imports use `./dist/...` explicitly; revert is a single-line change |
| Loyalty point data corruption during service migration | Low | High | `BackupManager` already implemented — take a backup before Phase 4 substitution |
| `token-generator-api/` OAuth flow regression | Low | High | Leave as JS until explicitly tested; OAuth flow is rarely run |

---

## Incremental Safety Model

After each phase, both execution paths remain valid:

```
Phase 0-3:  npm run bot  →  Excella.js  (100% JS, unchanged)
Phase 4:    npm run bot  →  Excella.js  (JS + dist/ service modules)
Phase 5:    npm run bot  →  Excella.js  (fallback)
            npm run bot:ts →  dist/bot.js  (new TS bot, run in parallel for testing)
Phase 6:    npm run dashboard →  dashboard/server.js  (fallback)
            npm run dash:ts  →  dist/dashboard/server.js  (new, test in parallel)
Phase 7:    npm run bot  →  dist/bot.js  (only TS remains)
```

No phase requires a big-bang cutover. Each phase can be reviewed, tested, and rolled back
independently by reverting a small number of files.

---

## Summary by Phase

| Phase | Files created | Lines migrated | Bot affected? |
|---|---|---|---|
| Prerequisites | 0 | 0 | No |
| 1 — Utility libs | 4 | ~325 | No |
| 2 — Twitch clients | 3 | ~1,553 | No |
| 3 — Account + TTS | 2 | ~812 | No |
| 4 — Wire src/ into bot | 0 new (modify Excella.js) | ~350 removed | Yes (transparent) |
| 5 — Migrate Excella.js | 10 | ~2,885 | Yes (new entry point) |
| 6 — Dashboard | 16 | ~4,075 | No |
| 7 — Cleanup | 0 new (delete old JS) | — | Yes (final cutover) |
| **Total** | **35** | **~9,650** | |
