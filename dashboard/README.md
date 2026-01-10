# Dashboard Server

Node.js Express server for the Twitch Bot Dashboard.

## Setup

The dashboard requires `ws` (WebSocket) package. Install dependencies:

```bash
npm install ws
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

- `GET /health` - Health check
- `GET /api/status` - Get bot status
- `GET /api/logs` - Get command logs
- `POST /api/logs` - Add command log
- `DELETE /api/logs` - Clear all logs
- `GET /api/stats` - Get user statistics
- `POST /api/stats/:username` - Update user stats
- `POST /api/update-state` - Update bot state (called by bot)

## WebSocket

Real-time updates via WebSocket connection on the main server.

## Features

- **Dashboard** - Bot status, channels, command count
- **Command Tester** - Test commands before using in chat
- **Chat Monitor** - Live chat feed (placeholder)
- **Settings** - View current bot configuration
- **Logs** - View and clear command execution logs
- **Stats** - User statistics and command usage
