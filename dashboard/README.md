# Dashboard Server

Node.js Express + WebSocket server for the Twitch Bot Dashboard.

## Setup

Install dependencies (at the project root):

```bash
npm install
```

## Running

Start the dashboard server (runs on port 3001 by default):

```bash
node dashboard/server.js
```

Or set a custom port via `.env`:

```
DASHBOARD_PORT=3001
```

## API Endpoints

- `GET /health` — Health check
- `GET /api/status` — Get bot state (connection, channels, commands)
- `POST /api/update-state` — Update bot state (called by bot)

Logs
- `GET /api/logs` — Get command logs
- `POST /api/logs` — Add command log
- `DELETE /api/logs` — Clear all logs

Stats
- `GET /api/stats` — Get user statistics
- `POST /api/stats/:username` — Update user stats

Custom Commands
- `GET /api/custom-commands` — List custom commands
- `POST /api/custom-commands` — Create/update a command
- `DELETE /api/custom-commands/:name` — Delete a command by name

Announcements (persists to `.env`)
- `GET /api/announcements` — Get announcements array
- `POST /api/announcements` — Save announcements array and upsert `ANNOUNCEMENTS` in `.env`

Channel Points Redemptions
- `GET /api/redemptions` — Get redemption log (latest 100)
- `POST /api/redemptions` — Append redemption (called by bot)

EventSub Events
- `GET /api/eventsub-events` — Get EventSub event log (latest 100)
- `POST /api/eventsub-events` — Append EventSub event (called by bot)

## WebSocket

Broadcasts real-time data to connected clients:
- `state` — Bot state
- `log` — New command execution
- `stats` — Updated user stats
- `chat` — Chat messages (if forwarded)
- `customCommands` — Custom command set updated
- `announcements` — Announcements updated
- `redemption` — Channel points redemption logged
- `eventsub-event` — EventSub event logged

## Features

- **Dashboard** — Bot status, channels, commands executed
- **Command Tester** — Test commands and broadcast results
- **Chat Monitor** — Live chat feed (if forwarded via `/api/chat`)
- **Announcements** — CRUD announcements; persists to `.env` (`ANNOUNCEMENTS` pipe-separated)
- **Redemptions** — View recent channel point redemptions
- **EventSub** — View recent EventSub events
- **Custom Commands** — Manage bot custom commands
- **Logs** — View and clear command execution logs
- **Stats** — Per-user command statistics

### Announcements Persistence

- Saves to `dashboard/logs/announcements.json`
- Upserts `ANNOUNCEMENTS` in root `.env` as a pipe-separated list

Example payload:

```json
{
	"announcements": [
		"Remember to follow!",
		"Join our Discord: https://discord.gg/example"
	]
}
```

### Try-It Commands

```bash
# Save announcements
curl -X POST http://localhost:3001/api/announcements \
	-H "Content-Type: application/json" \
	-d '{"announcements":["Hello chat!","New video is live!"]}'

# Append a redemption
curl -X POST http://localhost:3001/api/redemptions \
	-H "Content-Type: application/json" \
	-d '{"user":"viewer1","reward":"Highlight","input":"Make me VIP"}'

# Append an EventSub event
curl -X POST http://localhost:3001/api/eventsub-events \
	-H "Content-Type: application/json" \
	-d '{"type":"channel.follow","user":"new_follower"}'
```
