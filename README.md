# Twitch Chat Bot - Excella

A feature-rich, modular Twitch chat bot built with Node.js featuring a dual-token architecture (bot + broadcaster), an OAuth token generator with setup wizard, encrypted multi-account management, a real-time web dashboard, and OBS overlay integration for stream alerts.

## Table of Contents

- [Features](#features)
- [Quick Start](#quick-start)
- [Installation](#installation)
- [Configuration](#configuration)
- [Running the Bot](#running-the-bot)
- [Commands](#commands)
- [Chat Filtering](#chat-filtering)
- [Custom Commands](#custom-commands)
- [Dashboard](#dashboard)
- [OBS Overlays](#obs-overlays)
- [EventSub Integration](#eventsub-integration)
- [Account Management](#account-management)
- [Token Management](#token-management)
- [API Reference](#api-reference)
- [Project Structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [Dependencies](#dependencies)
- [License](#license)

## Features

### Core Bot Features
- **Dual-Token Architecture** - Separate tokens for bot account and broadcaster account
- **Chat Integration** - Full IRC-based chat read/write via tmi.js
- **Custom Commands** - Create dynamic commands with URL fetching and templating
- **Chat Filtering** - Comprehensive moderation with blacklist, URL, caps, spam detection
- **Automatic Token Refresh** - Tokens are automatically refreshed when expired

### Stream Interaction
- **Clips** - Create clips via `!clip` command
- **Announcements** - Scheduled announcements with configurable intervals
- **Shoutouts** - Native Twitch shoutout API integration
- **Followage** - Check how long users have been following
- **Polls & Predictions** - Create and manage channel polls and predictions
- **Channel Management** - Update stream title and game/category

### EventSub Real-Time Events
- **Follows** - Thank new followers automatically
- **Subscriptions** - Welcome new subs, resubs, and gift subs
- **Bits/Cheers** - Acknowledge bit donations
- **Raids** - Welcome incoming raids with viewer counts
- **Channel Points** - Track and respond to redemptions
- **Stream Status** - Detect when stream goes online/offline

### Web Dashboard
- **Real-Time WebSocket** - Live updates for all events
- **Command Logs** - Track all command executions
- **User Statistics** - Per-user command usage stats
- **Custom Command Management** - CRUD interface for custom commands
- **Announcement Editor** - Manage scheduled announcements
- **Chat Filter Configuration** - Configure moderation settings
- **EventSub Event Log** - View recent stream events
- **Redemption Log** - Track channel point redemptions
- **Loyalty System** - Track user points, levels, and watch time
- **Quotes Database** - Add, manage, and display random quotes
- **Counters** - Create and manage custom counters (deaths, wins, etc.)

### OBS Integration
- **Alert Overlays** - Customizable alerts for follows, subs, bits, raids, redemptions
- **Recent Events Widget** - Display recent stream activity
- **Chat Box Overlay** - Live chat display for streams
- **Goal Bar** - Visual progress bars for follower/subscriber goals
- **Custom Animations** - Enter/exit animations for alerts
- **Text-to-Speech** - Optional TTS for alert messages
- **Media Upload** - Upload custom images, videos, and sounds

### Account Management
- **Multi-Account Support** - Manage multiple Twitch accounts
- **AES-256 Encryption** - Secure credential storage
- **Export/Import** - Export accounts to .env format
- **Token Status Tracking** - Monitor token expiration

### Token Generator
- **Setup Wizard** - Visual scope selection with 22 feature categories
- **Scope Presets** - Quick configurations for common setups
- **Dual Authorization** - Separate flows for bot and broadcaster tokens
- **Token Validator** - Inspect token owner, scopes, and expiration
- **Auto .env Updates** - Tokens automatically saved to configuration

## Quick Start

### Prerequisites

- **Node.js** v16 or higher
- **npm** v7 or higher
- **Twitch Developer Account** with a registered OAuth application

### Installation

```bash
# Clone the repository
git clone https://github.com/your-repo/Twitch-Chat-Bot.git
cd Twitch-Chat-Bot

# Install dependencies
npm install

# Create environment file
cp .env.example .env
# Edit .env with your Twitch app credentials
```

### First-Time Setup

1. **Register a Twitch Application**
   - Go to [Twitch Developer Console](https://dev.twitch.tv/console)
   - Create a new application
   - Set OAuth Redirect URL to `http://localhost:3000/callback`
   - Copy your Client ID and Client Secret

2. **Configure Environment Variables**
   ```env
   TWITCH_CLIENT_ID=your_client_id
   TWITCH_CLIENT_SECRET=your_client_secret
   TWITCH_BROADCASTER_NAME=your_twitch_username
   TWITCH_CHANNELS=channel1,channel2
   ```

3. **Generate OAuth Tokens**
   ```bash
   node token-generator.js
   ```
   Open `http://localhost:3000` in your browser and follow the setup wizard.

4. **Start the Bot**
   ```bash
   npm run dev   # Starts bot and dashboard
   ```

## Installation

### Detailed Installation Steps

1. **Clone or Download**
   ```bash
   git clone https://github.com/your-repo/Twitch-Chat-Bot.git
   cd Twitch-Chat-Bot
   ```

2. **Install Dependencies**
   ```bash
   npm install
   ```

3. **Create Configuration**
   ```bash
   cp .env.example .env
   ```

4. **Get Twitch Credentials**
   - Visit [Twitch Developer Console](https://dev.twitch.tv/console)
   - Click "Register Your Application"
   - Fill in:
     - Name: Your bot name
     - OAuth Redirect URLs: `http://localhost:3000/callback`
     - Category: Chat Bot
   - Click "Create"
   - Copy the Client ID
   - Click "New Secret" and copy the Client Secret

5. **Configure .env**
   Edit `.env` with your credentials (see [Configuration](#configuration))

6. **Generate Tokens**
   ```bash
   node token-generator.js
   ```

## Configuration

### Required Environment Variables

| Variable | Description |
|----------|-------------|
| `TWITCH_CLIENT_ID` | Your Twitch OAuth application Client ID |
| `TWITCH_CLIENT_SECRET` | Your Twitch OAuth application Client Secret |
| `TWITCH_BROADCASTER_NAME` | Your Twitch username (the channel to operate on) |
| `TWITCH_CHANNELS` | Comma-separated list of channels to join |
| `TWITCH_ACCESS_TOKEN` | Bot account OAuth token (generated by token-generator) |
| `TWITCH_REFRESH_TOKEN` | Bot account refresh token (generated by token-generator) |
| `TWITCH_SCOPES` | Space-separated list of OAuth scopes |

### Optional Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TWITCH_BROADCASTER_ACCESS_TOKEN` | - | Broadcaster account OAuth token (for EventSub) |
| `TWITCH_BROADCASTER_REFRESH_TOKEN` | - | Broadcaster account refresh token |
| `TWITCH_BROADCASTER_SCOPES` | - | Broadcaster token scopes |
| `DISABLE_EVENTSUB` | `false` | Set to `1` to disable EventSub |
| `DASHBOARD_PORT` | `3001` | Port for the dashboard server |
| `ANNOUNCEMENT_INTERVAL_MS` | `900000` | Interval for announcements (15 min) |
| `ANNOUNCEMENTS` | - | Pipe-separated list of announcements |

### Chat Filter Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CHAT_FILTER_WORDS` | - | Pipe-separated blacklist words |
| `CHAT_FILTER_URLS` | `false` | Block URLs in chat |
| `CHAT_FILTER_ALLCAPS` | `false` | Block excessive caps |
| `CHAT_FILTER_REPEAT` | `false` | Block repeated characters |
| `CHAT_FILTER_SPAM` | `false` | Block spam/duplicate messages |
| `CHAT_FILTER_ACTION` | `warn` | Action: `warn`, `timeout`, or `delete` |
| `CHAT_FILTER_TIMEOUT_SEC` | `60` | Timeout duration in seconds |

### Example .env File

```env
# Twitch Application
TWITCH_CLIENT_ID=abc123def456
TWITCH_CLIENT_SECRET=xyz789secret

# Bot Account Tokens (generated by token-generator)
TWITCH_ACCESS_TOKEN=your_access_token
TWITCH_REFRESH_TOKEN=your_refresh_token
TWITCH_SCOPES=chat:read chat:edit clips:edit moderator:read:followers

# Broadcaster Account Tokens (optional, for EventSub)
TWITCH_BROADCASTER_ACCESS_TOKEN=broadcaster_token
TWITCH_BROADCASTER_REFRESH_TOKEN=broadcaster_refresh
TWITCH_BROADCASTER_SCOPES=moderator:read:followers channel:read:redemptions

# Bot Configuration
TWITCH_BROADCASTER_NAME=your_channel
TWITCH_CHANNELS=your_channel,friend_channel

# Optional Settings
DASHBOARD_PORT=3001
DISABLE_EVENTSUB=false
ANNOUNCEMENT_INTERVAL_MS=900000
ANNOUNCEMENTS=Follow the stream!|Join our Discord!

# Chat Filtering
CHAT_FILTER_WORDS=badword1|badword2
CHAT_FILTER_URLS=true
CHAT_FILTER_ALLCAPS=true
CHAT_FILTER_REPEAT=true
CHAT_FILTER_SPAM=true
CHAT_FILTER_ACTION=warn
CHAT_FILTER_TIMEOUT_SEC=60
```

## Running the Bot

### Start Commands

```bash
# Start everything (bot + dashboard)
npm run dev

# Start only the bot
npm run bot

# Start only the dashboard
npm run dashboard

# Start the token generator
node token-generator.js
```

### Using Account Manager

Run the bot with a specific account:

```bash
node Excella --account my-account-name
```

### Expected Startup Output

```
✓ Loaded account: my-account
Starting Twitch bot...

🔍 Validating tokens...
Checking bot account token...
✓ Bot token is valid
Checking broadcaster account token...
✓ Broadcaster token is valid

Initializing... (broadcaster: your_channel)
Got broadcaster ID: 12345678
Token user ID: 87654321 (bot_username)
✓ Loaded 8 built-in command configurations
✓ Bot EventSub listener initialized successfully
✓ Connected to Twitch chat
✓ Joined channels: your_channel
Bot is ready!
Chat client connected!
```

## Commands

### Everyone Commands

| Command | Description | Required Scope | Cooldown |
|---------|-------------|----------------|----------|
| `!clip` | Create a clip of the current stream | `clips:edit` | 60s |
| `!followage [user]` | Check follow duration | `moderator:read:followers` | - |
| `!balance [user]` | Check loyalty points | - | 5s |
| `!leaderboard` | Show top 5 users by loyalty points | - | 10s |
| `!quote` | Display a random quote | - | 5s |
| `!counter <name>` | Check a counter value | - | 5s |
| `!commands` / `!help` | List available commands | - | - |

### Moderator Commands

| Command | Description | Required Scope |
|---------|-------------|----------------|
| `!shoutout <user>` / `!so <user>` | Shout out another streamer | `moderator:manage:shoutouts` |
| `!poll start/end` | Create or end a poll | `channel:manage:polls` |
| `!prediction start/resolve` | Create or resolve a prediction | `channel:manage:predictions` |
| `!title "text"` | Update stream title | `channel:manage:broadcast` |
| `!game <name>` | Update stream category | `channel:manage:broadcast` |
| `!addfilter <word>` | Add word to blacklist | - |
| `!removefilter <word>` | Remove word from blacklist | - |
| `!filters` | Show active filter settings | - |

### Command Details

#### !clip
Creates a clip of the current stream moment.
```
Usage: !clip
Response: @username Clip created! https://clips.twitch.tv/xxx
```
- 60-second cooldown per channel
- Stream must be live
- Requires `clips:edit` scope

#### !followage
Check how long a user has been following.
```
Usage: !followage @username
Usage: !followage          (checks your own)
Response: @username Following for 2 years 3 months 5 days
```
- Requires `moderator:read:followers` scope

#### !shoutout / !so
Shout out another streamer with their last played game.
```
Usage: !shoutout @username
Response: Shoutout to Username! Check out their channel: https://twitch.tv/username - They're playing Valorant!
```
- Moderator/Broadcaster only
- Sends native Twitch shoutout if target is live

#### !poll
Create and manage channel polls.
```
Start: !poll start "What should I play?" Valorant;CS2;Overwatch 120
End:   !poll end <poll_id>

Details:
  - Title must be quoted
  - 2-5 semicolon-separated options
  - Duration: 15-1800 seconds (default 300)
```

#### !prediction
Create and resolve channel predictions.
```
Start:   !prediction start "Will I win?" Yes;No 300
Resolve: !prediction resolve <prediction_id> <winning_outcome_id>

Details:
  - Title must be quoted
  - Exactly 2 semicolon-separated outcomes
  - Duration: 60-1800 seconds (default 300)
```

#### !title
Update the stream title.
```
Usage: !title "My New Stream Title"
```

#### !game
Update the stream category/game.
```
Usage: !game Valorant
Usage: !game "Just Chatting"
```

#### !balance
Check loyalty points for yourself or another user.
```
Usage: !balance                (checks your own)
Usage: !balance @username       (checks another user)
Response: @username user123 has 5000 points (Rank: #3)
```
- Shows points and rank
- 5-second cooldown
- Requires loyalty system to be configured in dashboard

#### !leaderboard
Display the top 5 users by loyalty points.
```
Usage: !leaderboard
Response: Top Loyalists: 1. user123 (50000pts) | 2. user456 (45000pts) | 3. user789 (40000pts) | 4. user101 (35000pts) | 5. user202 (30000pts)
```
- Shows top 5 users
- 10-second cooldown
- Displays rank, username, and point total

#### !quote
Display a random quote from the quote database.
```
Usage: !quote
Response: "The only way to do great work is to love what you do." — Steve Jobs (Technology)
```
- Shows quote text, author, and game context (if available)
- 5-second cooldown
- Requires quotes to be added via dashboard

#### !counter
Check the current value of a specific counter.
```
Usage: !counter deaths
Usage: !counter wins
Response: deaths: 42
```
- Shows counter name and current value
- 5-second cooldown
- Counters are managed via the dashboard
- Default counters: `deaths`, `wins`, `losses`

## Chat Filtering

The bot includes a comprehensive chat filtering system with multiple detection types.

### Filter Types

| Type | Description | Trigger |
|------|-------------|---------|
| **Blacklist Words** | Block specific words | Exact word match (case-insensitive) |
| **URL Filtering** | Block HTTP/HTTPS links | URL pattern detection |
| **All Caps** | Block excessive caps | >50% caps, minimum 5 characters |
| **Repeated Characters** | Block spam patterns | 3+ consecutive identical characters |
| **Spam Detection** | Block duplicate messages | Same message within 5 seconds |

### Filter Actions

| Action | Behavior |
|--------|----------|
| `warn` | Send a warning message to the user |
| `timeout` | Timeout the user for configured duration |
| `delete` | Silently block/delete the message |

### Managing Filters

**Via Chat Commands:**
```
!addfilter badword      # Add word to blacklist
!removefilter badword   # Remove from blacklist
!filters                # Show current filter settings
```

**Via Environment Variables:**
```env
CHAT_FILTER_WORDS=word1|word2|word3
CHAT_FILTER_URLS=true
CHAT_FILTER_ALLCAPS=true
CHAT_FILTER_REPEAT=true
CHAT_FILTER_SPAM=true
CHAT_FILTER_ACTION=warn
CHAT_FILTER_TIMEOUT_SEC=60
```

**Via Dashboard API:**
```bash
# Update filter settings
curl -X POST http://localhost:3001/api/filters \
  -H "Content-Type: application/json" \
  -d '{"filterUrls": true, "filterSpam": true}'

# Add word to blacklist
curl -X POST http://localhost:3001/api/filters/words \
  -H "Content-Type: application/json" \
  -d '{"word": "badword"}'
```

### Moderator Bypass

Moderators and the broadcaster are exempt from all filters.

## Custom Commands

Create dynamic commands with optional URL fetching and template variables.

### Creating Custom Commands

**Via Dashboard API:**
```bash
curl -X POST http://localhost:3001/api/custom-commands \
  -H "Content-Type: application/json" \
  -d '{
    "name": "!hello",
    "response": "Hello, {user}! Welcome to the stream!",
    "level": "everyone",
    "cooldownSeconds": 5
  }'
```

### Template Variables

| Variable | Description |
|----------|-------------|
| `{user}` | Username of the command sender |
| `{displayname}` | Display name of the sender |
| `{channel}` | Channel name |
| `{target}` | First argument (e.g., mentioned user) |
| `{data}` | Data from fetched URL |

### URL Fetching

Commands can fetch data from external URLs:
```json
{
  "name": "!quote",
  "response": "{data}",
  "fetchEnabled": true,
  "fetchUrl": "https://api.quotable.io/random",
  "level": "everyone"
}
```

### Permission Levels

| Level | Who Can Use |
|-------|-------------|
| `everyone` | All users |
| `mod` | Moderators and broadcaster |
| `broadcaster` | Broadcaster only |

## Dashboard

The web dashboard provides real-time monitoring and configuration.

### Accessing the Dashboard

```bash
npm run dashboard
# or
npm run dev
```

Open `http://localhost:3001` in your browser.

### Dashboard Features

- **Bot Status** - Connection status, uptime, channels
- **Command Logs** - Real-time log of all command executions
- **User Statistics** - Per-user command usage tracking
- **Custom Commands** - Create, edit, delete custom commands
- **Announcements** - Manage scheduled announcement messages
- **Chat Filters** - Configure moderation settings
- **EventSub Events** - View follows, subs, raids, bits, redemptions
- **OBS Configuration** - Configure overlay settings
- **Alert Configuration** - Customize alert appearances

### WebSocket Events

Connect to `ws://localhost:3001` to receive real-time updates:

| Event Type | Description |
|------------|-------------|
| `state` | Bot state changes |
| `log` | Command execution logs |
| `stats` | User statistics updates |
| `chat` | Chat messages |
| `customCommands` | Custom command updates |
| `announcements` | Announcement updates |
| `redemption` | Channel point redemptions |
| `eventsub-event` | EventSub events |
| `alert` | OBS overlay alerts |
| `obsConfig` | OBS configuration updates |
| `alertConfig` | Alert configuration updates |
| `filters` | Chat filter updates |

## OBS Overlays

The bot includes ready-to-use OBS browser source overlays.

### Available Overlays

| Overlay | URL | Description |
|---------|-----|-------------|
| **Alerts** | `/obs/overlays/alerts.html` | Stream alerts (follows, subs, bits, raids) |
| **Recent Events** | `/obs/overlays/recent-events.html` | List of recent stream events |
| **Chat Box** | `/obs/overlays/chat-box.html` | Live chat display |
| **Goal Bar** | `/obs/overlays/goal-bar.html` | Progress bar for follower/sub goals |

### Adding to OBS

1. In OBS, add a new **Browser Source**
2. Set the URL to: `http://localhost:3001/obs/overlays/alerts.html`
3. Set recommended dimensions:
   - Alerts: 800x600
   - Recent Events: 400x600
   - Chat Box: 400x600
   - Goal Bar: 400x100
4. Check "Refresh browser when scene becomes active"

### Alert Types

| Type | Trigger | Default Sound |
|------|---------|---------------|
| `follow` | New follower | `/obs/assets/sounds/follow.mp3` |
| `subscription` | New sub/resub/gift | `/obs/assets/sounds/subscribe.mp3` |
| `bits` | Bit cheer | `/obs/assets/sounds/bits.mp3` |
| `raid` | Incoming raid | `/obs/assets/sounds/raid.mp3` |
| `redemption` | Channel point redemption | `/obs/assets/sounds/redemption.mp3` |

### Customizing Alerts

**Via Dashboard API:**
```bash
# Update alert type configuration
curl -X POST http://localhost:3001/api/alerts/config/follow \
  -H "Content-Type: application/json" \
  -d '{
    "duration": 6,
    "volume": 0.8,
    "enterAnimation": "bounceIn",
    "exitAnimation": "fadeOutUp",
    "textColor": "#00ff7f",
    "messageTemplate": "Thanks for the follow!"
  }'
```

### Available Animations

**Enter Animations:**
- `fadeIn`, `fadeInUp`, `fadeInDown`
- `slideInLeft`, `slideInRight`
- `scaleIn`, `bounceIn`, `rotateIn`

**Exit Animations:**
- `fadeOut`, `fadeOutUp`, `fadeOutDown`
- `slideOutLeft`, `slideOutRight`
- `scaleOut`

### Testing Alerts

```bash
curl -X POST http://localhost:3001/api/test-alert \
  -H "Content-Type: application/json" \
  -d '{"alertType": "follow", "user": "TestUser"}'
```

### Media Uploads

Upload custom images, videos, and sounds for alerts:

```bash
# Upload image
curl -X POST http://localhost:3001/api/uploads/image \
  -H "Content-Type: application/json" \
  -d '{"filename": "alert.png", "data": "base64-encoded-data"}'

# Upload sound
curl -X POST http://localhost:3001/api/uploads/sound \
  -H "Content-Type: application/json" \
  -d '{"filename": "alert.mp3", "data": "base64-encoded-data"}'
```

**Supported Formats:**
- Images: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`
- Videos: `.mp4`, `.webm`, `.mov`
- Audio: `.mp3`, `.ogg`, `.wav`, `.m4a`

## EventSub Integration

EventSub provides real-time events from Twitch for stream activity.

### Required Scopes

| Event | Required Scope | Token |
|-------|----------------|-------|
| Follows | `moderator:read:followers` | Broadcaster |
| Subscriptions | `channel:read:subscriptions` | Broadcaster |
| Bits/Cheers | `bits:read` | Broadcaster |
| Raids | - | Bot or Broadcaster |
| Redemptions | `channel:read:redemptions` | Broadcaster |
| Stream Online/Offline | - | Bot |

### Enabling EventSub

1. Ensure broadcaster tokens are configured in `.env`
2. Verify `DISABLE_EVENTSUB` is not set to `1`
3. Restart the bot

### Disabling EventSub

```env
DISABLE_EVENTSUB=1
```

### EventSub Events Flow

```
Twitch EventSub WebSocket
       ↓
   Excella Bot
       ↓
   Dashboard API
       ↓
   WebSocket Broadcast
       ↓
   OBS Overlays
```

## Account Management

Manage multiple Twitch accounts with encrypted storage.

### Account Manager Features

- **Encrypted Storage** - AES-256-CBC encryption
- **Multi-Account** - Store multiple bot configurations
- **Token Tracking** - Monitor token expiration status
- **Export/Import** - Convert to/from .env format

### Using the Account Manager

**Via Token Generator UI:**
1. Run `node token-generator.js`
2. Open `http://localhost:3000`
3. Navigate to "Accounts" tab
4. Create, authorize, and manage accounts

**Via CLI:**
```bash
# Run bot with specific account
node Excella --account production-bot

# List accounts (in token-generator)
# Visit http://localhost:3000/api/accounts
```

### Account Data Structure

```javascript
{
  name: "my-bot",
  clientId: "...",
  clientSecret: "...",
  broadcasterName: "my_channel",
  channels: ["channel1", "channel2"],
  accessToken: "...",
  refreshToken: "...",
  tokenScopes: ["chat:read", "chat:edit"],
  broadcasterAccessToken: "...",
  broadcasterRefreshToken: "...",
  broadcasterScopes: ["moderator:read:followers"]
}
```

### Security Files

| File | Description |
|------|-------------|
| `accounts.encrypted.json` | Encrypted account data (gitignored) |
| `.encryption-key` | AES-256 encryption key (gitignored, chmod 600) |

## Token Management

### Token Generator

The token generator provides a web UI for OAuth authorization.

```bash
node token-generator.js
# Open http://localhost:3000
```

### Features

- **Setup Wizard** - Select features and auto-map required scopes
- **Scope Categories** - Organized scope selection
- **Dual Authorization** - Separate bot and broadcaster flows
- **Token Validator** - Verify token status and scopes
- **Scope Presets** - Quick configurations

### Scope Categories

| Category | Example Scopes |
|----------|----------------|
| Chat (IRC) | `chat:read`, `chat:edit` |
| Clips | `clips:edit` |
| Moderation | `moderator:manage:banned_users`, `moderator:read:followers` |
| Channel Management | `channel:manage:broadcast`, `channel:manage:polls` |
| Channel Points | `channel:read:redemptions`, `channel:manage:predictions` |
| Analytics | `bits:read`, `channel:read:subscriptions` |

### Refreshing Tokens

Tokens are automatically refreshed by the bot when expired. Manual refresh:

1. Run `node token-generator.js`
2. Click "Refresh Token" in the UI
3. Or re-authorize by clicking "Authorize with Selected Scopes"

### Token Expiration

- Access tokens expire after ~4 hours
- Refresh tokens are valid for 60 days of inactivity
- Bot automatically refreshes tokens before expiration

## API Reference

### Dashboard REST API

Base URL: `http://localhost:3001`

#### Status & Health

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/api/status` | Bot connection status |
| POST | `/api/update-state` | Update bot state (internal) |

#### Logs & Stats

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/logs` | Get command logs |
| POST | `/api/logs` | Add command log |
| DELETE | `/api/logs` | Clear all logs |
| GET | `/api/stats` | Get user statistics |
| POST | `/api/stats/:username` | Update user stats |

#### Custom Commands

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/custom-commands` | List custom commands |
| POST | `/api/custom-commands` | Create/update command |
| DELETE | `/api/custom-commands/:name` | Delete command |

#### Built-in Commands

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/builtin-commands` | List built-in commands config |
| PUT | `/api/builtin-commands/:name` | Update command cooldown |

#### Announcements

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/announcements` | Get announcements |
| POST | `/api/announcements` | Save announcements |

#### EventSub & Redemptions

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/redemptions` | Get redemption log |
| POST | `/api/redemptions` | Add redemption |
| GET | `/api/eventsub-events` | Get EventSub events |
| POST | `/api/eventsub-events` | Add EventSub event |

#### Chat Filters

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/filters` | Get filter configuration |
| POST | `/api/filters` | Update filter settings |
| POST | `/api/filters/words` | Add word to blacklist |
| DELETE | `/api/filters/words/:word` | Remove word from blacklist |

#### Loyalty System

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/loyalty` | Get all loyalty data |
| GET | `/api/loyalty/config` | Get loyalty configuration |
| PUT | `/api/loyalty/config` | Update loyalty configuration |
| GET | `/api/loyalty/leaderboard` | Get top users by points |
| GET | `/api/loyalty/user/:username` | Get user's loyalty data |
| PUT | `/api/loyalty/user/:username/points` | Set user points (admin) |

#### Quotes System

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/quotes` | Get all quotes (paginated) |
| GET | `/api/quotes/random` | Get a random quote |
| POST | `/api/quotes` | Add a new quote |
| PUT | `/api/quotes/:id` | Update a quote |
| DELETE | `/api/quotes/:id` | Delete a quote |

#### Counters System

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/counters` | Get all counters |
| GET | `/api/counters/:name` | Get a specific counter |
| POST | `/api/counters` | Create a new counter |
| PUT | `/api/counters/:name` | Update counter value |
| DELETE | `/api/counters/:name` | Delete a counter |

#### OBS Configuration

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/obs/config` | Get OBS config |
| POST | `/obs/config` | Update OBS config |
| POST | `/obs/config/:overlay` | Update specific overlay |
| GET | `/obs/recent` | Get recent events |
| GET | `/obs/recent/:type` | Get recent events by type |

#### Alert Configuration

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/alerts/config` | Get alert config |
| POST | `/api/alerts/config` | Update alert config |
| POST | `/api/alerts/config/:alertType` | Update specific alert |
| POST | `/api/alerts/config/reset` | Reset to defaults |
| POST | `/api/test-alert` | Send test alert |
| POST | `/api/alerts/test` | Enhanced test alert |
| GET | `/api/alerts/animations` | List available animations |

#### Media Uploads

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/uploads/image` | Upload image |
| POST | `/api/uploads/video` | Upload video |
| POST | `/api/uploads/sound` | Upload sound |
| GET | `/api/uploads/:mediaType` | List uploaded media |
| DELETE | `/api/uploads/:mediaType/:filename` | Delete media file |

## Project Structure

```
Twitch-Chat-Bot/
├── Excella                      # Main bot application
├── token-generator.js           # OAuth token generator server
├── account-manager.js           # Encrypted account storage
├── package.json                 # Dependencies and scripts
├── .env                         # Configuration (gitignored)
├── .env.example                 # Example configuration
├── accounts.encrypted.json      # Encrypted accounts (gitignored)
├── .encryption-key              # Encryption key (gitignored)
│
├── lib/
│   ├── twitch-helix-api.js      # Twitch Helix API client
│   ├── twitch-irc-client.js     # IRC/tmi.js wrapper
│   └── twitch-eventsub-ws.js    # EventSub WebSocket client
│
├── dashboard/
│   ├── server.js                # Express + WebSocket server
│   ├── README.md                # Dashboard documentation
│   ├── public/
│   │   ├── index.html           # Dashboard UI
│   │   ├── app.js               # Dashboard frontend
│   │   └── style.css            # Dashboard styles
│   ├── logs/                    # JSON data storage (gitignored)
│   └── uploads/                 # Media uploads (gitignored)
│
├── obs/
│   ├── overlays/
│   │   ├── alerts.html          # Alert overlay
│   │   ├── recent-events.html   # Recent events widget
│   │   ├── chat-box.html        # Chat display
│   │   └── goal-bar.html        # Goal progress bar
│   ├── js/
│   │   └── overlay-client.js    # WebSocket client for overlays
│   ├── css/
│   │   └── overlay-base.css     # Shared overlay styles
│   └── assets/
│       └── sounds/              # Default alert sounds
│
├── test-*.js                    # Manual test scripts
├── CLAUDE.md                    # AI assistant documentation
└── README.md                    # This file
```

## Troubleshooting

### Bot Won't Start

**"Missing required environment variables"**
- Ensure all required variables are set in `.env`
- Run `node token-generator.js` to generate missing tokens

**"Invalid token supplied"**
- Tokens have expired or are invalid
- Run `node token-generator.js` and re-authorize

**"Broadcaster not found"**
- Check `TWITCH_BROADCASTER_NAME` matches your Twitch username exactly
- Username is case-insensitive but should exist

### Commands Not Working

**Commands not responding:**
- Verify `chat:read` and `chat:edit` scopes
- Ensure bot has joined the channel (`TWITCH_CHANNELS`)
- Check bot is a moderator in the channel for mod commands

**"Missing scope" error:**
- Re-run token generator and select the missing scope
- Re-authorize with Twitch

**Cooldown issues:**
- Default cooldowns are configured in dashboard
- Use `/api/builtin-commands/:name` to modify

### EventSub Issues

**Events not triggering:**
- Ensure broadcaster tokens are configured
- Check required scopes for each event type
- Verify `DISABLE_EVENTSUB` is not set to `1`

**"EventSub disabled" message:**
- Missing broadcaster token
- Missing required scopes
- Set `DISABLE_EVENTSUB=1` intentionally

### Dashboard Issues

**Can't connect to dashboard:**
- Check `DASHBOARD_PORT` (default 3001)
- Ensure no port conflicts
- Run `npm run dashboard` first

**WebSocket disconnects:**
- Dashboard auto-reconnects after 3 seconds
- Check network connectivity

### Token Issues

**Token refresh failures:**
- Verify client ID/secret match the token's application
- Refresh token may have expired (60 days inactive)
- Re-authorize via token generator

**Scope validation errors:**
- Token may have been generated with fewer scopes
- Re-authorize with additional scopes

### OBS Overlay Issues

**Overlays not showing:**
- Verify dashboard is running on correct port
- Check browser source URL in OBS
- Enable "Refresh browser when scene becomes active"

**No sound on alerts:**
- Check volume settings in alert configuration
- Verify audio files exist in `/obs/assets/sounds/`
- Browser may require user interaction first

## Security

### Credential Storage

- **Tokens** - Stored in `.env` (gitignored)
- **Multi-account** - AES-256-CBC encrypted in `accounts.encrypted.json`
- **Encryption key** - Stored with chmod 600 in `.encryption-key`

### Security Features

- **XSS Prevention** - Input sanitization in dashboard
- **SSRF Protection** - URL validation for custom command fetches
- **Rate Limiting** - Upload rate limits (10/minute)
- **MIME Validation** - Magic number validation for uploads
- **Scope Validation** - Commands check scopes before execution

### Gitignored Files

```
.env
accounts.encrypted.json
.encryption-key
dashboard/logs/
dashboard/uploads/
node_modules/
```

### Best Practices

1. Never commit `.env` or encryption keys
2. Use separate tokens for bot and broadcaster
3. Grant minimum required scopes
4. Rotate tokens periodically
5. Monitor token expiration

## Dependencies

### Core Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `tmi.js` | ^1.8.5 | Twitch IRC client |
| `axios` | ^1.13.2 | HTTP client |
| `express` | ^5.2.1 | Web framework |
| `ws` | ^8.19.0 | WebSocket support |
| `dotenv` | ^17.2.3 | Environment variables |
| `concurrently` | ^9.2.1 | Multi-process runner |

### Built-in Node.js Modules

- `crypto` - AES-256 encryption
- `fs` / `fs/promises` - File system operations
- `path` - Path utilities
- `http` - HTTP server

## License

MIT

---

## Support

- **Twitch API Documentation:** https://dev.twitch.tv/docs
- **tmi.js Documentation:** https://tmijs.com/
- **Issues:** Report bugs via GitHub Issues
