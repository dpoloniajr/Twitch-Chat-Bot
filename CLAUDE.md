# CLAUDE.md - Twitch Chat Bot (Excella)

This document provides essential context for AI assistants working with this codebase.

## Project Overview

**Excella** is a feature-rich Twitch chat bot with:
- Dual-token architecture (bot + broadcaster accounts)
- Web dashboard with real-time WebSocket updates
- OBS overlay integration for stream alerts
- Encrypted multi-account management
- OAuth token generator with setup wizard

## Quick Start Commands

```bash
npm install          # Install dependencies
npm run bot          # Start only the bot
npm run dashboard    # Start only the dashboard (port 3001)
npm run dev          # Start bot and dashboard concurrently
node token-generator.js  # Start OAuth token generator (port 3000)
```

## Project Structure

```
/
├── Excella                    # Main bot application (1,865 lines)
├── token-generator.js         # OAuth server with setup wizard (2,215 lines)
├── account-manager.js         # Encrypted account storage (397 lines)
├── dashboard/
│   ├── server.js              # Express API + WebSocket server (847 lines)
│   ├── public/
│   │   ├── index.html         # Dashboard UI
│   │   ├── app.js             # Dashboard frontend logic
│   │   └── style.css          # Dashboard styles
│   └── logs/                  # JSON data storage (gitignored)
├── obs/
│   ├── overlays/              # HTML overlay pages for OBS
│   ├── js/overlay-client.js   # WebSocket client for overlays
│   ├── css/overlay-base.css   # Shared overlay styles
│   └── assets/sounds/         # Alert sound files
├── .env                       # Environment configuration (gitignored)
├── accounts.encrypted.json    # Encrypted account data (gitignored)
└── .encryption-key            # AES-256 encryption key (gitignored)
```

## Architecture

### Core Components

1. **Excella (Main Bot)** - IRC-based chat bot using tmi.js and direct Helix API
2. **Token Generator** - OAuth 2.0 server with scope management UI
3. **Account Manager** - AES-256-CBC encrypted credential storage
4. **Dashboard Server** - Express API with WebSocket for real-time updates
5. **OBS Overlays** - Browser sources for stream alerts

### Dual-Token System

The bot uses separate authentication for different capabilities:

| Token | Variable Prefix | Purpose |
|-------|-----------------|---------|
| Bot | `TWITCH_ACCESS_TOKEN` | Chat read/write, commands, moderation |
| Broadcaster | `TWITCH_BROADCASTER_ACCESS_TOKEN` | EventSub, analytics, channel management |

## Key Code Patterns

### Command Registry Pattern

Commands are registered in a Map with permission levels:

```javascript
const commandRegistry = new Map([
  ['!command', {
    perm: 'everyone' | 'mod',
    handler: async ({ channel, user, args, msg }) => {
      return { success: true, message: 'Response' };
    }
  }]
]);
```

**Location:** `Excella` lines 1651-1759

### Scope Validation Pattern

Always check for required OAuth scopes before API calls:

```javascript
if (!hasScope(config.scopes, 'required:scope')) {
  return { success: false, error: 'Missing scope: required:scope' };
}
```

### Error Response Structure

Standardized response format across the codebase:

```javascript
return {
  success: true | false,
  error: 'Error message',      // On failure
  message: 'Success message',  // On success
  data: { /* additional data */ }
};
```

### Permission Checking

```javascript
function checkModPermission(msg, channel, username) {
  return msg.userInfo.isMod || msg.userInfo.isBroadcaster;
}
```

### Caching Strategy

Multiple cache layers with TTLs:
- Token validation: 1 hour
- Custom commands: 60 seconds
- Filter status: 5 seconds
- Scope validation: cached on load

## Configuration

### Required Environment Variables

```env
# Twitch Application (from dev.twitch.tv)
TWITCH_CLIENT_ID=your_client_id
TWITCH_CLIENT_SECRET=your_client_secret

# Bot Account Tokens
TWITCH_ACCESS_TOKEN=...
TWITCH_REFRESH_TOKEN=...
TWITCH_SCOPES=chat:read chat:edit ...

# Bot Configuration
TWITCH_BROADCASTER_NAME=your_twitch_username
TWITCH_CHANNELS=channel1,channel2
```

### Optional Environment Variables

```env
# Broadcaster Account (for EventSub features)
TWITCH_BROADCASTER_ACCESS_TOKEN=...
TWITCH_BROADCASTER_REFRESH_TOKEN=...

# Feature Toggles
DISABLE_EVENTSUB=false
DASHBOARD_PORT=3001
ANNOUNCEMENT_INTERVAL_MS=900000

# Chat Filtering
CHAT_FILTER_WORDS=word1|word2
CHAT_FILTER_URLS=true
CHAT_FILTER_ALLCAPS=true
CHAT_FILTER_REPEAT=true
CHAT_FILTER_SPAM=true
CHAT_FILTER_ACTION=warn|timeout|delete
CHAT_FILTER_TIMEOUT_SEC=60
```

## Built-in Commands

### Everyone Commands
| Command | Description | Cooldown |
|---------|-------------|----------|
| `!clip` | Create a clip | 60s/channel |
| `!followage [user]` | Check follow duration | - |
| `!commands` / `!help` | List available commands | - |

### Moderator Commands
| Command | Description |
|---------|-------------|
| `!shoutout` / `!so <user>` | Shout out a streamer |
| `!poll start/end` | Manage polls |
| `!prediction start/resolve` | Manage predictions |
| `!title "text"` | Update stream title |
| `!game <name>` | Update stream category |
| `!addfilter <word>` | Add to blacklist |
| `!removefilter <word>` | Remove from blacklist |
| `!filters` | Show active filters |

## Chat Filtering System

**Location:** `Excella` lines 142-287

Filter types:
1. **Blacklist Words** - Case-insensitive matching
2. **URL Filtering** - Blocks HTTP/HTTPS links
3. **All Caps** - Messages >50% caps (min 5 chars)
4. **Repeated Characters** - 3+ consecutive identical chars
5. **Spam Detection** - Duplicate messages within 5 seconds

Moderators and broadcaster are exempt from all filters.

## Dashboard API Endpoints

**Base URL:** `http://localhost:3001`

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/health` | Health check |
| GET | `/api/status` | Bot connection status |
| GET/POST | `/api/logs` | Command execution logs |
| GET/POST | `/api/stats` | User statistics |
| GET/POST/DELETE | `/api/custom-commands` | Custom command CRUD |
| GET/POST | `/api/announcements` | Announcement management |
| GET/POST | `/api/redemptions` | Channel points log |
| GET/POST | `/api/eventsub-events` | EventSub event log |

### WebSocket Events

Connect to `ws://localhost:3001` for real-time updates:
- `state` - Bot state changes
- `log` - Command executions
- `stats` - User statistics
- `customCommands` - Custom command updates
- `redemption` - Channel points redemptions
- `eventsub-event` - EventSub events

## Dependencies

Core libraries:
- **tmi.js** - Twitch IRC chat client
- **axios** - HTTP client for direct Helix API calls
- **ws** - WebSocket support for EventSub and Dashboard
- **express** - Web framework
- **dotenv** - Environment variables
- **concurrently** - Multi-process runner

## Security Considerations

1. **Token Encryption** - AES-256-CBC with random IV per account
2. **File Permissions** - Encryption key chmod 600
3. **XSS Protection** - Input sanitization in dashboard
4. **SSRF Validation** - URL pattern validation
5. **Scope Validation** - Required scopes checked before execution

## Development Guidelines

### Adding a New Command

1. Define handler in `Excella` following the registry pattern
2. Add to `commandRegistry` Map with appropriate permission level
3. Check required scopes at handler start
4. Return standardized response object
5. Update `!commands` output if needed

### Adding EventSub Listeners

1. Check for broadcaster token availability
2. Validate required scopes
3. Register listener on `broadcasterEventSubListener`
4. Handle events and forward to dashboard via API

### Working with Account Manager

```javascript
const am = require('./account-manager');

// List accounts
const accounts = am.listAccounts();

// Load specific account
const account = am.getAccount('account-name');

// Save account
am.saveAccount('name', {
  clientId, clientSecret, broadcasterName,
  channels, accessToken, refreshToken, scopes
});

// Delete account
am.deleteAccount('name');
```

### Testing

Manual test files exist (no formal framework):
- `test-shoutout.js` - Shoutout command testing
- `test-custom-command.js` - Custom command rendering
- `test-account-manager.js` - Account manager CRUD

Run with: `node test-<name>.js`

## File Locations Reference

| Purpose | File | Key Lines |
|---------|------|-----------|
| Command handlers | `Excella` | 1321-1625 |
| Command registry | `Excella` | 1651-1759 |
| Message handler | `Excella` | 1794-1827 |
| Chat filters | `Excella` | 142-287 |
| Token management | `Excella` | 750-853 |
| EventSub setup | `Excella` | 316-597 |
| Cooldown system | `Excella` | 599-707 |
| Dashboard routes | `dashboard/server.js` | Full file |
| Account encryption | `account-manager.js` | Full file |
| OAuth flow | `token-generator.js` | Full file |

## Common Issues

### Token Refresh Failures
- Check that refresh tokens are valid
- Verify client ID/secret match the token's application
- Use token generator to create fresh tokens

### EventSub Not Working
- Ensure broadcaster token is configured
- Check `DISABLE_EVENTSUB` is not set to true
- Verify broadcaster token has required scopes

### Dashboard Connection Issues
- Check `DASHBOARD_PORT` setting
- Ensure no port conflicts
- Verify bot is running (dashboard needs bot for some features)

## Git Workflow

- Main branch: `main`
- Feature branches: `claude/<feature>-<id>`
- Commit messages should describe the change clearly
- Security-sensitive files are gitignored (.env, encryption keys, tokens)
