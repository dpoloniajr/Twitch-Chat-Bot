# Technical Specification: OBS Integration for Twitch Alerts & Overlays

## Task Overview

Build OBS integration into the Excella Twitch chat bot to provide browser source overlays for:
- Alert notifications (followers, subscribers, bits, raids)
- Latest follower/subscriber displays
- Chat-relevant information overlays
- Channel point redemption alerts

## Technical Context

### Technology Stack
- **Runtime**: Node.js (CommonJS modules)
- **Web Framework**: Express.js v5.2.1
- **Real-time Communication**: WebSocket (ws v8.19.0)
- **Twitch Integration**: Twurple libraries (v8.0.2)
  - `@twurple/api` - Twitch API interactions
  - `@twurple/auth` - Authentication
  - `@twurple/chat` - IRC chat integration
  - `@twurple/eventsub-ws` - WebSocket-based event subscriptions

### Existing Architecture
The project uses a dual-component architecture:
1. **Excella** (main bot): Handles Twitch chat, commands, and EventSub events
2. **Dashboard** (`dashboard/server.js`): Express + WebSocket server for real-time UI updates

### Current EventSub Integration
The bot already subscribes to several events:
- `onStreamOnline` / `onStreamOffline`
- `onChannelFollow` (broadcaster token)
- `onChannelRaidTo` (broadcaster token)
- `onChannelRedemptionAdd` (broadcaster token)

Events are logged via `POST /api/eventsub-events` and broadcast to WebSocket clients.

---

## Implementation Approach

### Architecture Decision

**OBS Browser Source Pattern**: Create dedicated HTML pages served by the existing Express server that connect via WebSocket and render animated alerts. This is the industry-standard approach used by StreamElements, Streamlabs, and similar services.

```
[Twitch EventSub] → [Excella Bot] → [Dashboard Server API] → [WebSocket Broadcast]
                                                                     ↓
                                              [OBS Browser Source (overlay pages)]
```

### Key Design Principles
1. **Leverage existing infrastructure** - Reuse the dashboard WebSocket server and event logging system
2. **Modular overlays** - Each overlay type is a separate HTML page for flexibility
3. **Configurable** - Alert duration, animations, sounds, and display styles via settings
4. **Queue-based alerts** - Prevent alert overlap with a queue system

---

## Source Code Structure Changes

### New Files to Create

```
obs/
├── overlays/
│   ├── alerts.html          # Combined alert overlay (follow, sub, bits, raid)
│   ├── recent-events.html   # Scrolling recent events display
│   ├── chat-box.html        # Chat overlay for OBS
│   └── goal-bar.html        # Follow/sub goal progress bar
├── css/
│   └── overlay-base.css     # Shared overlay styles and animations
├── js/
│   └── overlay-client.js    # Shared WebSocket client and alert queue logic
└── assets/
    └── sounds/              # Default alert sounds (placeholder README)
```

### Files to Modify

1. **`dashboard/server.js`**:
   - Add static file serving for `/obs/` directory
   - Add new API endpoints for OBS overlay configuration
   - Add new WebSocket message types for alert events

2. **`Excella`** (main bot file):
   - Enhance EventSub handlers to include subscriber and bits events
   - Add more detailed event payloads for alerts (tier info, amounts, messages)
   - Add subscriber event subscription (`onChannelSubscription`, `onChannelSubscriptionGift`)
   - Add bits/cheer event subscription (`onChannelCheer`)

3. **`.env`** (via upsertEnvValue):
   - Add OBS configuration options (alert duration, sound enabled, etc.)

---

## Data Model / API Changes

### New EventSub Events (Twitch → Bot)

**Requires additional broadcaster token scopes:**
- `channel:read:subscriptions` - For subscription events
- `bits:read` - For cheer/bits events

### New API Endpoints

```
GET  /obs/config                    # Get OBS overlay configuration
POST /obs/config                    # Update OBS overlay configuration
GET  /obs/recent/:type              # Get recent events by type (followers, subs, etc.)
POST /api/test-alert                # Trigger test alert (for configuration)
```

### New WebSocket Message Types

```javascript
// Alert events (for overlay consumption)
{ type: 'alert', data: { alertType: 'follow', user: '...', ... } }
{ type: 'alert', data: { alertType: 'subscription', user: '...', tier: '...', message: '...' } }
{ type: 'alert', data: { alertType: 'bits', user: '...', amount: 100, message: '...' } }
{ type: 'alert', data: { alertType: 'raid', user: '...', viewers: 50 } }
{ type: 'alert', data: { alertType: 'redemption', user: '...', reward: '...', input: '...' } }

// Recent events list update
{ type: 'recent-events', data: { followers: [...], subs: [...], ... } }
```

### OBS Configuration Schema

```javascript
{
  alertDurationMs: 5000,           // How long alerts display
  alertDelayMs: 1000,              // Delay between queued alerts
  soundEnabled: true,              // Enable/disable alert sounds
  soundVolume: 0.5,                // Sound volume (0-1)
  enabledAlerts: {
    follow: true,
    subscription: true,
    bits: true,
    raid: true,
    redemption: true
  },
  customMessages: {
    follow: '{user} just followed!',
    subscription: '{user} subscribed at Tier {tier}!',
    bits: '{user} cheered {amount} bits!',
    raid: '{user} is raiding with {viewers} viewers!'
  }
}
```

---

## Verification Approach

### Manual Testing Steps

1. **Server startup**: Verify OBS overlay pages are served at `http://localhost:3001/obs/overlays/alerts.html`
2. **WebSocket connection**: Confirm overlay connects to WebSocket and receives events
3. **Test alerts**: Use the `/api/test-alert` endpoint to trigger each alert type
4. **OBS integration**: Add browser source in OBS pointing to overlay URL and verify display
5. **Queue behavior**: Trigger multiple alerts rapidly and verify proper queuing
6. **Configuration**: Change settings via API and verify overlays update

### Lint/Build Verification
- No build step required (vanilla JS/HTML/CSS)
- Verify no console errors in browser
- Test WebSocket reconnection on server restart

---

## Implementation Plan

Given the complexity (medium-hard), breaking into the following implementation steps:

### [ ] Step 1: OBS Overlay Infrastructure
Set up the basic file structure and Express routing for OBS overlays.
- Create `/obs/` directory structure
- Add static file serving in `dashboard/server.js`
- Create base CSS with animation keyframes
- Create shared JavaScript WebSocket client module
- Verify pages load at expected URLs

### [ ] Step 2: Alert Overlay Implementation
Build the main alerts overlay with queue system.
- Create `alerts.html` with alert display container
- Implement JavaScript alert queue with configurable timing
- Add CSS animations (fade in/out, slide, etc.)
- Handle all alert types (follow, sub, bits, raid, redemption)
- Add sound support with configurable volume

### [ ] Step 3: Enhanced EventSub Events
Extend the bot to capture subscription and bits events.
- Add subscription event handlers (`onChannelSubscription`, `onChannelSubscriptionGift`)
- Add bits/cheer event handler (`onChannelCheer`)
- Update `/api/eventsub-events` payloads with detailed info
- Add new WebSocket message type `'alert'` for overlay consumption
- Document required additional scopes in token-generator

### [ ] Step 4: Additional Overlays
Build supplementary overlay pages.
- Create `recent-events.html` for scrolling latest follower/sub display
- Create `chat-box.html` for OBS chat overlay
- Create `goal-bar.html` for follow/sub goal progress
- Add API endpoint `/obs/recent/:type`

### [ ] Step 5: Configuration & Testing
Add configuration system and test alert functionality.
- Add OBS configuration storage (`dashboard/logs/obs-config.json`)
- Add `/obs/config` GET/POST endpoints
- Add `/api/test-alert` endpoint for triggering test alerts
- Add OBS settings section to dashboard UI (optional, can be follow-up)
- Test all alerts in OBS Browser Source

---

## Complexity Assessment

**Difficulty: Medium**

**Rationale:**
- Core infrastructure (WebSocket, EventSub) already exists
- Follows established patterns in the codebase
- Main complexity is in CSS animations and queue management
- May require additional Twitch scopes for subscriptions/bits
- No complex architectural decisions needed

**Risks:**
- Subscription/bits EventSub may require Twitch affiliate/partner status to test
- CSS animations need cross-browser testing
- Sound autoplay policies in browsers may require user interaction

---

## Dependencies & Prerequisites

1. **Existing scopes may need expansion**: `channel:read:subscriptions`, `bits:read`
2. **Token regeneration**: Users may need to re-authorize if missing scopes
3. **OBS installation**: Required for end-to-end testing

---

## Out of Scope (Future Enhancements)

- Custom alert images/GIFs upload
- Advanced animation customization UI
- Multiple overlay themes/presets
- Text-to-speech for alerts
- Integration with third-party alert services
