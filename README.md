# Excella - Twitch Chat Bot

A modular Twitch chat bot written in TypeScript. It uses two Twitch tokens (a bot account and a broadcaster account), and comes with a web dashboard that edits every setting, OBS overlays for alerts and widgets, YouTube song requests, text-to-speech, a loyalty points system, and an OAuth token generator with a setup wizard.

## Table of Contents

- [Features](#features)
- [Quick Start](#quick-start)
- [Running](#running)
- [Configuration](#configuration)
- [Commands](#commands)
- [Chat Filtering](#chat-filtering)
- [Custom Commands](#custom-commands)
- [Song Requests](#song-requests)
- [Text-to-Speech](#text-to-speech)
- [Dashboard](#dashboard)
- [OBS Overlays](#obs-overlays)
- [EventSub](#eventsub)
- [Tokens and Accounts](#tokens-and-accounts)
- [API Reference](#api-reference)
- [Project Structure](#project-structure)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [License](#license)

## Features

**Chat**
- Built-in commands for clips, followage, shoutouts, polls, predictions, title and category changes
- Custom commands with templates and optional URL fetching, managed from the dashboard
- Chat filters (blacklist, links, caps, repeated characters, spam) with warn, timeout or delete actions
- Welcome message for first-time chatters, a hype detector, rotating announcements
- Fun commands: `!8ball`, `!dice`, `!coinflip`

**Loyalty**
- Points for watch time and chat messages, levels and a leaderboard
- `!gamba` and `!duel` (the challenged viewer must accept)
- Quotes and counters (deaths, wins, ...) with chat commands and overlays

**Song requests**
- `!sr` by YouTube URL or search, with queue rules, a blocklist, subscriber/VIP restrictions and optional points cost
- A song player overlay that plays the queue in OBS

**Text-to-speech**
- `!tts` and channel point redemptions read aloud through an OBS overlay
- Browser voices for free, or ElevenLabs / OpenAI voices with local audio caching

**EventSub**
- Real-time follows, subs, gift subs, bits, raids, redemptions, and stream online/offline
- Events feed the dashboard and OBS alert overlays

**Dashboard** (`http://localhost:3001`)
- Live status, command logs, user stats and event logs over WebSocket
- Settings page for every `.env` setting (secrets are write-only)
- Pages for custom and built-in commands, announcements, chat filters, alerts, OBS, song queue, loyalty, quotes, counters and backups
- A **Restart Bot** button that restarts the bot with the new settings

**Token generator** (`http://localhost:3000`)
- Setup wizard that picks OAuth scopes by feature, plus scope presets
- Separate bot and broadcaster authorization, token validator, and automatic `.env` updates
- Encrypted multi-account storage (AES-256-CBC)

## Quick Start

### Prerequisites

- Node.js 18 or higher
- A Twitch application from the [Twitch Developer Console](https://dev.twitch.tv/console)

### 1. Install

```bash
git clone https://github.com/dpoloniajr/Twitch-Chat-Bot.git
cd Twitch-Chat-Bot
npm install
cp .env.example .env
```

### 2. Register a Twitch application

In the [Twitch Developer Console](https://dev.twitch.tv/console), register an application:
- **OAuth Redirect URL:** `http://localhost:3000/callback` (use your port if you set `TOKEN_GENERATOR_PORT`)
- **Category:** Chat Bot

Copy the Client ID, create a Client Secret, and put both in `.env` along with your channel:

```env
TWITCH_CLIENT_ID=your_client_id
TWITCH_CLIENT_SECRET=your_client_secret
TWITCH_BROADCASTER_NAME=your_twitch_username
TWITCH_CHANNELS=your_twitch_username
```

### 3. Generate tokens

```bash
npm run token-generator
```

Open `http://localhost:3000` and follow the setup wizard. Authorize once with the bot account and once with the broadcaster account; the tokens and scopes are written to `.env`.

### 4. Start the bot and dashboard

```bash
npm run dev
```

The bot joins your channels and the dashboard is at `http://localhost:3001`. Everything else can be configured from the dashboard's Settings page.

## Running

| Command | What it does |
|---------|--------------|
| `npm run dev` | Build, then start the bot and dashboard |
| `npm start` | Start the bot and dashboard from an existing build in `dist/` |
| `npm run bot` | Build, then start only the bot |
| `npm run dashboard` | Build, then start only the dashboard |
| `npm run token-generator` | Build, then start the token generator on port 3000 |
| `npm run build` | Compile the server code to `dist/` and the browser code next to its pages |

The token generator is not started by `npm start` or `npm run dev`; run it when you need new tokens.

`npm start` and `npm run bot` run the bot under a small supervisor (`dist/bot/supervisor.js`). When you press **Restart Bot** on the dashboard, the bot exits with code 75 and the supervisor starts it again. Any other exit stops it.

The bot loads custom commands and loyalty, quotes and counters data from the dashboard, so run both (which `npm run dev` and `npm start` do).

### Using a stored account

To run with an account saved in the token generator's account manager instead of the tokens in `.env`:

```bash
npm run bot -- --account my-account-name
```

### Docker

The multi-stage `Dockerfile` compiles the TypeScript and runs `npm start`. `docker-compose.yml` publishes the dashboard on `DASHBOARD_PORT` (default 3001), sets `DASHBOARD_HOST=0.0.0.0`, keeps `dashboard/logs` and `dashboard/uploads` in volumes, and mounts `.env` so refreshed tokens are saved.

```bash
docker-compose up -d                                  # bot + dashboard
docker-compose --profile tools up token-generator     # token generator on port 3000
```

The `token-generator` service bind-mounts `.env`, `accounts.encrypted.json` and `.encryption-key`, so all three must already exist as files that the container's user (UID 1001) can read and write. Docker creates a missing one as a directory, and the token generator then fails to start. If you don't have account files yet, it is simpler to run `npm run token-generator` on the host.

Settings passed in by `docker-compose.yml` show as locked on the dashboard's Settings page, because `.env` cannot override them.

## Configuration

All settings live in `.env`. Most of them can be edited on the dashboard's Settings page, which validates them and says whether each one applies immediately or after a restart. `.env.example` lists the common ones.

### Required

| Variable | Description |
|----------|-------------|
| `TWITCH_CLIENT_ID` | Client ID of your Twitch application |
| `TWITCH_CLIENT_SECRET` | Client Secret of your Twitch application |
| `TWITCH_ACCESS_TOKEN` | Bot account token (written by the token generator) |
| `TWITCH_REFRESH_TOKEN` | Bot account refresh token (written by the token generator) |
| `TWITCH_BROADCASTER_NAME` | Your channel name |
| `TWITCH_CHANNELS` | Comma-separated channels to join |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `TWITCH_SCOPES` | `chat:read chat:edit` | Bot token scopes (written by the token generator) |
| `TWITCH_BROADCASTER_ACCESS_TOKEN` / `_REFRESH_TOKEN` / `_SCOPES` | - | Broadcaster token, needed for EventSub and broadcaster-only API calls |
| `YOUTUBE_API_KEY` | - | YouTube Data API v3 key, needed for song requests |
| `DISABLE_EVENTSUB` | `false` | `true`, `1` or `yes` turns EventSub off |
| `COMMAND_REFRESH_INTERVAL` | `60` | Seconds between custom command reloads from the dashboard |
| `DEBUG` | `false` | Extra debug logging |
| `ANNOUNCEMENTS` | - | Pipe-separated announcement messages (edited on the Announcements page) |
| `ANNOUNCEMENT_INTERVAL_MS` | `900000` | Time between announcements (15 minutes; at least 1 minute) |
| `FIRST_CHATTER_WELCOME_ENABLED` | `true` | Welcome first-time chatters in chat |
| `FIRST_CHATTER_MESSAGE` | `Welcome to the chat, {user}!` | Welcome message |
| `FIRST_CHATTER_ALERT_ENABLED` | `true` | Show an overlay alert for first-time chatters |
| `HYPE_ENABLED` | `true` | Hype detector on or off |
| `HYPE_MIN_MESSAGES` / `HYPE_WINDOW_SEC` | `15` / `60` | Messages within the window that count as hype |
| `HYPE_COOLDOWN_SEC` | `120` | Minimum time between hype messages |
| `HYPE_MESSAGE` | `Chat is HYPED! 🔥` | Message posted when chat is hyped |
| `DASHBOARD_PORT` | `3001` | Dashboard port |
| `DASHBOARD_HOST` | `127.0.0.1` | Dashboard listen address (Docker uses `0.0.0.0`) |
| `DASHBOARD_INTERNAL_SECRET` | - | Shared secret for bot-only dashboard writes (recommended; see [Security](#security)) |
| `TOKEN_GENERATOR_PORT` | `3000` | Token generator port; also changes the OAuth redirect URL |

TTS settings (`TTS_PROVIDER`, `TTS_REWARD_TITLE`, `ELEVENLABS_*`, `OPENAI_*`, `TTS_CACHE_*`) are described in [Text-to-Speech](#text-to-speech).

Chat filter settings (`CHAT_FILTER_*`) are described in [Chat Filtering](#chat-filtering).

## Commands

Cooldowns below are defaults; change them on the dashboard's Built-in Commands page. A command that fails does not start its cooldown. Moderators and the broadcaster can use every command.

### Everyone

| Command | Description | Cooldown |
|---------|-------------|----------|
| `!commands` | List available commands | - |
| `!clip` | Create a clip (stream must be live; `clips:edit`) | 60s |
| `!followage [user]` | How long you (or a user) have followed | - |
| `!8ball <question>` | Ask the magic 8-ball | 5s |
| `!dice [sides]` | Roll a die (2-1000 sides, default 6) | 5s |
| `!coinflip` | Flip a coin | 5s |
| `!balance [user]` | Loyalty points and rank | 5s |
| `!leaderboard` | Top 5 by points | 10s |
| `!gamba <amount\|all>` | Bet points: 50% chance to double | 10s |
| `!duel @user [stake]` | Challenge someone (default stake 50); they reply `!duel accept` or `!duel decline` within 60s | 15s |
| `!quote` | Random quote | 5s |
| `!counter <name>` | Show a counter, e.g. `!counter deaths` | 5s |
| `!hype` | Chat energy over the last minute | 15s |
| `!tts <message>` | Read a message aloud (max 200 chars) | 30s per user, 10s global |
| `!sr <url\|search>` / `!songrequest` | Request a YouTube song | 30s |
| `!song` / `!currentsong` | Current and next song | 10s |
| `!queue` | Queue stats and the next 3 songs | 10s |

### Moderators

| Command | Description |
|---------|-------------|
| `!shoutout <user>` / `!so <user>` | Shout out a streamer (native Twitch shoutout when possible) |
| `!poll start "Title" A;B;C [seconds]` | Start a poll (2-5 options, 15-1800s, default 300) |
| `!poll end <poll_id>` | End a poll |
| `!prediction start "Title" Yes;No [seconds]` | Start a prediction (2 outcomes, 60-1800s, default 300) |
| `!prediction resolve <prediction_id> <outcome_id>` | Resolve a prediction |
| `!title "New title"` | Change the stream title |
| `!game <name>` | Change the stream category |
| `!addfilter <word>` / `!removefilter <word>` | Edit the blacklist |
| `!filters` | Show active filters |
| `!hype set <5-200>` / `!hype cooldown <30-600>` / `!hype toggle` | Tune the hype detector |
| `!skip` / `!skipsong` | Skip the current song (no refund) |
| `!removesong <position\|keyword>` | Remove a song (refunds points) |
| `!clearqueue` | Clear the queue (refunds points) |
| `!sr config <setting> <value>` | Song request settings (see [Song Requests](#song-requests)) |
| `!blocksong <url\|keyword>` / `!unblocksong <id\|keyword>` | Edit the song blocklist |
| `!reloadcommands` | Reload custom commands from the dashboard now |

## Chat Filtering

| Filter | Triggers on | Setting |
|--------|-------------|---------|
| Blacklist | A listed word (case-insensitive) | `CHAT_FILTER_WORDS=word1\|word2` |
| Links | HTTP/HTTPS URLs | `CHAT_FILTER_URLS=true` |
| All caps | More than 50% capitals (5+ letters) | `CHAT_FILTER_ALLCAPS=true` |
| Repeated characters | 3+ identical characters in a row | `CHAT_FILTER_REPEAT=true` |
| Spam | The same message within 5 seconds | `CHAT_FILTER_SPAM=true` |

`CHAT_FILTER_ACTION` is `warn` (default), `timeout` or `delete`, and `CHAT_FILTER_TIMEOUT_SEC` sets the timeout length (default 60). Filters are off unless enabled. Moderators and the broadcaster are exempt.

Change filters on the dashboard's Chat Filters page, with `!addfilter` / `!removefilter`, or through `POST /api/filters` and `POST /api/filters/words`. Changes are saved to `.env`.

## Custom Commands

Create custom commands on the dashboard, or with the API:

```bash
curl -X POST http://localhost:3001/api/custom-commands \
  -H "Content-Type: application/json" \
  -d '{"name": "!hello", "response": "Hello, {user}!", "level": "everyone", "cooldownSeconds": 5}'
```

| Field | Description |
|-------|-------------|
| `level` | `everyone`, `mod` (moderators and broadcaster) or `broadcaster` |
| `cooldownSeconds` | Channel-wide cooldown |
| `fetchEnabled` / `fetchUrl` | Fetch text from a URL and insert it as `{data}` (private and local addresses are refused) |

Template variables: `{user}`, `{displayname}`, `{channel}`, `{target}` (the first argument) and `{data}`.

The bot reloads custom commands every `COMMAND_REFRESH_INTERVAL` seconds, or right away with `!reloadcommands`.

## Song Requests

Song requests need a YouTube Data API v3 key:

1. In [Google Cloud Console](https://console.cloud.google.com/), create or pick a project
2. Enable **YouTube Data API v3** and create an API key
3. Set `YOUTUBE_API_KEY` in `.env` (or on the Settings page)

The free quota is 10,000 units a day. A search costs 100 units and a URL lookup costs 1, so requests by URL save quota.

Moderators configure requests in chat or on the Song Queue page:

```
!sr config enabled on|off
!sr config cost <points>              # points per request (default 0)
!sr config maxduration <minutes>      # default 10
!sr config maxperuser <n>             # default 3
!sr config duplicates on|off          # default off
!sr config priority everyone|subs|vips
```

Points are charged when a song is added and refunded by `!removesong` and `!clearqueue`, but not by `!skip`. Moderators bypass the priority and per-user limits. The queue and blocklist are stored in `dashboard/logs/song-queue.json` and `dashboard/logs/song-blocklist.json`.

Add `http://localhost:3001/obs/overlays/song-player.html` as a browser source to play the queue. It accepts `?position=bottom-left|bottom-right|top-left|top-right`, `?theme=purple|blue|green` and `?debug=true`.

## Text-to-Speech

`!tts <message>` and channel point redemptions are read aloud by the TTS overlay. A redemption counts as TTS when its reward title contains the word `TTS` ("TTS Message" matches), or, if `TTS_REWARD_TITLE` is set, when the title equals it exactly (ignoring case). Messages pass through the chat filters (except spam). Redemptions skip the per-user cooldown.

Add `http://localhost:3001/obs/overlays/tts-display.html` as a browser source. It accepts `?voice=en-US`, `?rate=1.0`, `?pitch=1.0`, `?volume=1.0`, `?duration=5000` and `?debug=true`.

| Setting | Default | Description |
|---------|---------|-------------|
| `TTS_PROVIDER` | `browser` | `browser`, `elevenlabs` or `openai` |
| `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID` / `ELEVENLABS_MODEL` | - / `EXAVITQu4vr4xnSDxMaL` / `eleven_monolingual_v1` | ElevenLabs voice |
| `OPENAI_API_KEY` / `OPENAI_TTS_VOICE` / `OPENAI_TTS_MODEL` | - / `alloy` / `tts-1` | OpenAI voice |
| `TTS_CACHE_ENABLED` / `TTS_CACHE_MAX_AGE` / `TTS_CACHE_MAX_SIZE` | `true` / 24h / 100MB | Audio cache in `dashboard/cache/tts/` |

If the AI provider fails, the overlay falls back to browser speech. Voice, model, API key and cache-limit changes saved on the Settings page apply immediately. Switching `TTS_PROVIDER` between `browser` and an AI provider, or changing `TTS_REWARD_TITLE`, needs **Restart Bot**; changing `TTS_CACHE_ENABLED` needs a dashboard restart. See [TTS_README.md](TTS_README.md) for details.

## Dashboard

Open `http://localhost:3001`. The dashboard only listens on `127.0.0.1` unless `DASHBOARD_HOST` is set.

| Page | What you can do |
|------|-----------------|
| Dashboard | Bot status, uptime and channels |
| Command Tester / Chat Monitor | Try commands and watch chat live |
| Announcements | Rotating announcement messages |
| Polls/Predictions, Redemptions | Recent EventSub events and channel point redemptions |
| Chat Filters | Filter switches, action and blacklist |
| Built-in Commands / Custom Commands | Cooldowns for built-ins; create, edit and delete custom commands |
| Logs / Stats | Command log and per-user usage |
| Settings | Every `.env` setting in grouped panels |
| Alert Config / OBS Overlays | Alert look, sounds, animations, media uploads and test alerts; overlay URLs and settings |
| Song Queue | Now playing, queue, skip/remove/clear, request rules and blocklist |
| Loyalty | Points settings, stats, leaderboard, transactions, and setting a viewer's points |
| Quotes | Add, search, edit, delete, import/export, and quote rules |
| Counters | Create, count up/down, set, reset and delete |
| Backups | Create, upload, download, restore and delete backups (never includes `.env`) |

### Settings page

The Settings page reads and writes `.env` through `GET/PUT /api/config`. One schema, `src/dashboard/lib/settings-schema.ts`, defines every setting's type, range, default and group.

- Secrets (API keys, client secret, tokens) show only "set" or "not set". You can replace or clear them but never read them back.
- Tokens and scopes are read-only; use the token generator. `DASHBOARD_HOST` and `DASHBOARD_INTERNAL_SECRET` are read-only too, because they protect the dashboard.
- Each setting says when it applies. Most need **Restart Bot**; some TTS settings apply immediately (see [Text-to-Speech](#text-to-speech) for the exceptions); `DASHBOARD_PORT` needs a restart of `npm start`, and `TOKEN_GENERATOR_PORT` a restart of `npm run token-generator`.
- Settings set by the system environment (for example `docker-compose.yml`) are shown but locked.

### WebSocket events

Connect to `ws://localhost:3001` for live updates:

| Event | Sent when |
|-------|-----------|
| `state` | Bot state changes |
| `log`, `stats` | A command runs |
| `chat` | A chat message arrives |
| `customCommands`, `builtinCommands`, `announcements`, `filters` | Those settings change |
| `redemption`, `eventsub-event` | A channel point redemption or EventSub event arrives |
| `alert`, `hype` | An overlay alert or hype moment fires |
| `obsConfig`, `alertConfig` | Overlay or alert settings change |
| `song-queue-update`, `song-queue-config-update`, `song-queue-blocklist-update` | The song queue, its rules or the blocklist change |
| `loyalty-update`, `quote-update`, `counter-update` | Points, quotes or counters change (overlays update live) |

## OBS Overlays

Add any of these as a **Browser Source** in OBS, using `http://localhost:3001` plus the path. Overlays update live over the dashboard's WebSocket.

| Overlay | Path | URL parameters |
|---------|------|----------------|
| Alerts | `/obs/overlays/alerts.html` | `debug` |
| Recent events | `/obs/overlays/recent-events.html` | `limit`, `showTime`, `type` |
| Chat box | `/obs/overlays/chat-box.html` | `limit`, `timeout`, `hideBot`, `hideCommands`, `colorByRole` |
| Goal bar | `/obs/overlays/goal-bar.html` | `type`, `goal`, `current`, `title` |
| Counter | `/obs/overlays/counter-display.html` | `mode` (`single`, `multi`, `score`), `counter`, `counters` |
| Leaderboard | `/obs/overlays/leaderboard.html` | `limit`, `title`, `level` |
| Quote | `/obs/overlays/quote-display.html` | `mode`, `rotate`, `interval`, `duration`, `author`, `game`, `date` |
| Song player | `/obs/overlays/song-player.html` | `position`, `theme`, `debug` |
| TTS | `/obs/overlays/tts-display.html` | `voice`, `rate`, `pitch`, `volume`, `duration`, `debug` |

Alert types are `follow`, `subscription` (with prime, gift, community gift and resub variations), `bits`, `raid` and `redemption`. Customize them on the Alert Config page, including enter/exit animations (`fadeIn`, `slideInLeft`, `bounceIn`, ...), sounds, images and message templates. Uploaded media must be an image (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`), video (`.mp4`, `.webm`, `.mov`) or sound (`.mp3`, `.ogg`, `.wav`, `.m4a`) of at most 10MB.

Send a test alert:

```bash
curl -X POST http://localhost:3001/api/alerts/test \
  -H "Content-Type: application/json" \
  -d '{"alertType": "follow", "user": "TestUser"}'
```

## EventSub

EventSub needs the broadcaster token. Each event is subscribed only when the token has its scope:

| Event | Scope |
|-------|-------|
| Follows | `moderator:read:followers` |
| Subscriptions, resubs, gift subs | `channel:read:subscriptions` |
| Bits | `bits:read` |
| Channel point redemptions | `channel:read:redemptions` (`channel:manage:redemptions` to refund failed TTS redemptions) |
| Raids | none |
| Stream online/offline | none (bot token) |

The bot logs which subscriptions it skipped and why. Set `DISABLE_EVENTSUB=true` to turn EventSub off. The client reconnects with backoff and follows Twitch's reconnect messages.

## Tokens and Accounts

### Token generator

`npm run token-generator` serves `http://localhost:3000` (or `TOKEN_GENERATOR_PORT`). Its tabs are:

- **Setup Wizard**: pick features and get the scopes they need
- **Manual Setup**: choose scopes yourself or from a preset
- **Token Validator**: show a token's owner, scopes and expiry
- **Account Manager**: store several bot configurations encrypted
- **Backup & Recovery**: back up and restore `.env`

Authorizing writes the tokens and scopes to `.env`.

### Token refresh

Access tokens last about 4 hours. The bot validates both tokens at startup, refreshes them before they expire or after a 401, and saves the new tokens to `.env`. If a refresh token stops working (for example after 60 days unused, or when the client secret changes), authorize again in the token generator.

### Accounts

The Account Manager stores accounts in `accounts.encrypted.json`, encrypted with AES-256-CBC using the key in `.encryption-key` (created with mode 600). Both files are gitignored. Run the bot with a stored account with `npm run bot -- --account <name>`.

## API Reference

The dashboard API is served at `http://localhost:3001`. Responses are JSON. Writes from other websites are refused (see [Security](#security)).

| Area | Endpoints |
|------|-----------|
| Health and status | `GET /health`, `GET /api/status`, `POST /api/update-state`*, `POST /api/bot/restart` |
| Settings | `GET/PUT /api/config`, `GET/POST /api/settings` |
| Logs and stats | `GET/POST/DELETE /api/logs`, `GET /api/stats`, `POST /api/stats/:username`, `POST /api/chat` |
| Commands | `GET/POST /api/custom-commands`, `DELETE /api/custom-commands/:name`, `GET /api/builtin-commands`, `PUT /api/builtin-commands/:name` |
| Announcements | `GET/POST /api/announcements` |
| Events | `GET /api/redemptions`, `POST /api/redemptions`*, `GET /api/eventsub-events`, `POST /api/eventsub-events`*, `POST /api/hype/trigger`* |
| Chat filters | `GET/POST /api/filters`, `POST /api/filters/words`, `DELETE /api/filters/words/:word` |
| Alerts | `GET/POST /api/alerts/config`, `POST /api/alerts/config/global`, `POST /api/alerts/config/reset`, `POST /api/alerts/config/:alertType`, `POST /api/alerts/config/:alertType/variation/:key`, `POST /api/alerts/test`, `POST /api/test-alert`, `GET /api/alerts/animations`, `GET /api/alerts/tts/voices` |
| OBS | `GET/POST /obs/config`, `GET /obs/recent`, `GET /obs/recent/:type` |
| Uploads | `POST /api/uploads/image`, `/video`, `/sound` (JSON `{filename, data}` with base64 data), `GET /api/uploads/:mediaType`, `DELETE /api/uploads/:mediaType/:filename` |
| TTS | `GET /api/tts/config`, `POST /api/tts/generate`*, `GET /api/tts/audio/:filename` |
| Loyalty | `GET /api/loyalty`, `GET/PUT /api/loyalty/config`, `GET /api/loyalty/leaderboard`, `GET /api/loyalty/user/:username`, `PUT /api/loyalty/user/:username/points`, `GET /api/loyalty/transactions`, `GET /api/loyalty/stats`, `POST /api/loyalty/add`*, `/deduct`*, `/award-message`*, `/gamba`*, `/duel`* |
| Quotes | `GET/POST /api/quotes`, `GET /api/quotes/random`, `GET/PUT /api/quotes/config`, `GET /api/quotes/export`, `POST /api/quotes/import`, `GET/PUT/DELETE /api/quotes/:id` |
| Counters | `GET/POST /api/counters`, `GET /api/counters/config`, `GET/PUT/DELETE /api/counters/:name`, `POST /api/counters/:name/increment`, `/decrement`, `/reset`, `GET /api/counters/:name/history` |
| Song queue | `GET /api/song-queue`, `GET/PUT /api/song-queue/config`, `GET /api/song-queue/blocklist`, `POST /api/song-queue/add`*, `POST /api/song-queue/skip`, `POST /api/song-queue/clear`, `DELETE /api/song-queue/:target`, `POST /api/song-queue/block`, `DELETE /api/song-queue/block/:id` |
| Backups | `GET /api/backup/list`, `POST /api/backup/create`, `POST /api/backup/upload`, `POST /api/backup/restore`, `GET/DELETE /api/backup/:filename` |

\* Bot-only: when `DASHBOARD_INTERNAL_SECRET` is set, these need the `x-bot-secret` header. The other loyalty and song queue writes accept either that header or a request from the dashboard pages.

## Project Structure

```
Twitch-Chat-Bot/
├── src/
│   ├── bot/                  # The bot: create-bot.ts, main.ts, supervisor.ts, one module per feature
│   ├── dashboard/            # Dashboard server: server.ts, routes/, lib/ (incl. settings-schema.ts), main.ts
│   ├── token-generator/      # OAuth token generator: server.ts, routes/, main.ts
│   ├── lib/                  # Shared: Helix, IRC and EventSub clients, token/account/env managers, TTS, file lock
│   ├── web/                  # Browser TypeScript, compiled next to the pages below
│   ├── utils/project-root.ts # Finds the project root from src/ or dist/
│   └── commands/, services/, integrations/, filters/, config/
│                             # Standalone modules (Discord, analytics, scheduler, ...) that the bot
│                             # does not load yet; exported from src/index.ts
├── dist/                     # Compiled server code (gitignored)
├── dashboard/
│   ├── public/               # Dashboard UI (index.html, style.css; app.js and manage.js are compiled)
│   ├── logs/                 # JSON data: logs, loyalty, quotes, counters, song queue, ... (gitignored)
│   ├── uploads/              # Uploaded alert media
│   └── cache/tts/            # Cached TTS audio (gitignored)
├── obs/
│   ├── overlays/             # Overlay pages (their .js is compiled)
│   ├── js/                   # overlay-client.js (compiled)
│   ├── css/overlay-base.css
│   └── assets/sounds/        # Default alert sounds
├── public/token-generator/   # Token generator UI
├── tests/                    # Jest suites: unit (mirroring src/), e2e/, regression/, web/
├── docs/                     # Feature research and plans
├── Dockerfile, docker-compose.yml
├── .env.example
└── tsconfig.json, tsconfig.web.json, jest.config.ts
```

Compiled browser `.js` files are gitignored; edit the `.ts` sources in `src/web/`.

## Development

```bash
npm run build       # Compile server code (tsc) and browser code (tsconfig.web.json)
npm run typecheck   # Type-check without emitting
npm test            # Jest (compiles browser code first)
npm run test:watch
npm run test:coverage
```

Tests live in `tests/`: unit tests mirror `src/`, `tests/e2e/` drives the real bot, dashboard and token generator against fakes, `tests/regression/` pins fixed bugs, and `tests/web/` covers the browser code. All tests must pass after every change.

To add a built-in command, write the handler in the matching `src/bot/` module, register it in `src/bot/command-registry.ts`, and add its default cooldown to `DEFAULT_BUILTIN_COMMANDS` in `src/dashboard/lib/constants.ts`. To add a `.env` setting, add it to `src/dashboard/lib/settings-schema.ts`; a test fails if the code reads a key the schema does not list.

## Troubleshooting

**"Missing required environment variables"**: set the [required variables](#required), and run the token generator for the tokens.

**"Invalid token" or refresh failures**: check that the client ID and secret belong to the application the token was created with, then authorize again in the token generator.

**A command says a scope is missing**: authorize again in the token generator with that feature selected. Mod-only commands also need the bot to be a moderator in the channel.

**Custom commands, loyalty, quotes or counters don't work**: the dashboard is not running or not reachable on `DASHBOARD_PORT`. `npm run dev` starts both.

**EventSub events don't arrive**: set the broadcaster token, check the startup log for skipped subscriptions and missing scopes, and check that `DISABLE_EVENTSUB` is not on.

**Dashboard writes fail with 403**: the request came from another origin, or `DASHBOARD_INTERNAL_SECRET` is set and the call needs the `x-bot-secret` header.

**Can't reach the dashboard from another machine**: set `DASHBOARD_HOST=0.0.0.0` (Docker does this already). The dashboard has no login, so only do this on a network you trust (see [Security](#security)).

**Overlays show nothing or play no sound**: check the browser source URL and port, and enable "Refresh browser when scene becomes active". Browsers may block sound until the page has been interacted with; use the OBS browser source's audio controls.

## Security

- `.env`, `accounts.encrypted.json`, `.encryption-key` and `dashboard/logs/` are gitignored. Never commit them.
- The dashboard has no login. Anyone who can reach its port can change settings, restore backups and control the bot, even with `DASHBOARD_INTERNAL_SECRET` set (the secret only protects the bot-only routes, and requests without an `Origin` header pass the CSRF check). It listens on `127.0.0.1` by default; if you expose it with `DASHBOARD_HOST=0.0.0.0` or Docker, limit access with a firewall or put it behind an authenticating reverse proxy.
- State-changing dashboard requests from another website's origin are refused (CSRF check), so a page you visit can't change your bot.
- With `DASHBOARD_INTERNAL_SECRET` set, bot-only writes (points, events, adding songs) need the `x-bot-secret` header, which the bot sends. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
- The Settings page never returns secret values.
- Custom command fetches refuse private and local addresses, uploads are checked by file signature and rate-limited, and dashboard input is escaped before display.
- Each command checks its OAuth scopes before calling Twitch. Grant only the scopes you need, and keep bot and broadcaster tokens separate.

## License

ISC (as declared in `package.json`).

## Links

- [Twitch API documentation](https://dev.twitch.tv/docs)
- [tmi.js documentation](https://tmijs.com/)
- [Issues](https://github.com/dpoloniajr/Twitch-Chat-Bot/issues)
