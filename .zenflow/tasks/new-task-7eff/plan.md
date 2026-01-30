# Spec and build

## Configuration
- **Artifacts Path**: {@artifacts_path} → `.zenflow/tasks/{task_id}`

---

## Agent Instructions

Ask the user questions when anything is unclear or needs their input. This includes:
- Ambiguous or incomplete requirements
- Technical decisions that affect architecture or user experience
- Trade-offs that require business context

Do not make assumptions on important decisions — get clarification first.

---

## Workflow Steps

### [x] Step: Technical Specification
<!-- chat-id: 7e457a16-195a-4da3-a2c3-83d3a4cf7e4d -->

**Completed**: Created `spec.md` with full technical specification including:
- Assessed complexity as **Medium**
- Documented architecture: OBS Browser Source pattern using existing WebSocket infrastructure
- Defined new file structure (`obs/overlays/`, `obs/css/`, `obs/js/`)
- Specified API changes and new WebSocket message types
- Broke implementation into 5 concrete steps below

---

### [x] Step: OBS Overlay Infrastructure
<!-- chat-id: 91d53e16-30d3-44de-b45c-c645cf8483b2 -->

Set up the basic file structure and Express routing for OBS overlays.

- [x] Create `/obs/` directory structure with `overlays/`, `css/`, `js/`, `assets/` folders
- [x] Add static file serving for `/obs/` in `dashboard/server.js`
- [x] Create `obs/css/overlay-base.css` with animation keyframes (fadeIn, slideIn, etc.)
- [x] Create `obs/js/overlay-client.js` with shared WebSocket client module
- [x] Verify pages load at expected URLs (e.g., `http://localhost:3001/obs/overlays/alerts.html`)

---

### [x] Step: Alert Overlay Implementation
<!-- chat-id: b5de474c-3002-4f7d-b12b-c42a66416449 -->

Build the main alerts overlay with queue system.

**Note**: Basic `alerts.html` with alert queue and styling was created in Infrastructure step. This step focuses on testing integration with actual events.

- [x] Create `obs/overlays/alerts.html` with alert display container (done in Infrastructure)
- [x] Implement JavaScript alert queue with configurable timing (done in Infrastructure)
- [x] Add CSS animations (fade in/out, slide, pulse, etc.) (done in Infrastructure)
- [x] Handle all alert types: follow, sub, bits, raid, redemption (done in Infrastructure)
- [x] Add sound support with configurable volume (done in Infrastructure)
- [x] Added `POST /api/test-alert` endpoint to server for testing alerts via API
- [x] Enhanced `alerts.html` with `testAlert()` and `testAllAlerts()` console functions for local testing
- [x] Sound files are loaded dynamically (users add their own to `/obs/assets/sounds/`)
- [x] Animation timings configurable via URL params (duration, delay, enter, exit, exitDuration, volume)

---

### [x] Step: Enhanced EventSub Events
<!-- chat-id: e373625b-1345-4ed7-8c39-b3a87a7e2320 -->

Extend the bot to capture subscription and bits events.

- [x] Add subscription event handlers (`onChannelSubscription`, `onChannelSubscriptionGift`) to `Excella`
- [x] Add bits/cheer event handler (`onChannelCheer`) to `Excella`
- [x] Update `/api/eventsub-events` payloads with detailed info (tier, amount, message)
- [x] Add new WebSocket message type `'alert'` for overlay consumption
- [x] Document required additional scopes (`channel:read:subscriptions`, `bits:read`) in token-generator

**Completed Implementation:**
- Added `sendAlert()` and `logEventSubEvent()` helper functions to Excella for broadcasting alerts
- Added `onChannelSubscription` handler for regular subscriptions with tier detection
- Added `onChannelSubscriptionMessage` handler for resubs with message
- Added `onChannelSubscriptionGift` handler for gift subs with gifter info and amount
- Added `onChannelCheer` handler for bits with amount and message
- Updated existing follow, raid, and redemption handlers to also send alerts to OBS overlays
- All events log to `/api/eventsub-events` with detailed payloads (tier, amount, message, etc.)
- All events broadcast `{ type: 'alert', data: {...} }` via WebSocket for OBS overlays
- Updated token-generator presets (`eventsub-complete`, `broadcaster-recommended`) to include new scopes
- Updated feature wizard to auto-include subscription and bits scopes when EventSub is enabled

---

### [x] Step: Additional Overlays
<!-- chat-id: ba35b456-e8ad-42cd-ba69-b6b46ac5361b -->

Build supplementary overlay pages.

- [x] Create `obs/overlays/recent-events.html` for scrolling latest follower/sub display
- [x] Create `obs/overlays/chat-box.html` for OBS chat overlay
- [x] Create `obs/overlays/goal-bar.html` for follow/sub goal progress
- [x] Add API endpoint `GET /obs/recent/:type` for recent events by type
- [x] Style all overlays with consistent theming (using overlay-base.css)

**Implementation Details:**
- `recent-events.html`: Displays scrolling list of latest events (followers, subs, bits, raids)
  - Fetches events from `/obs/recent/:type` endpoint
  - Subscribes to WebSocket alerts for real-time updates
  - Configurable via URL params: `?limit=10&type=follow&showTime=true`
  - Shows time ago for each event, icons for event types
  - Auto-refreshes every 5 seconds

- `chat-box.html`: OBS chat overlay displaying live chat messages
  - Listens for chat messages via WebSocket
  - Configurable message timeout (default 8s)
  - Optional: hide bot messages, hide commands, color by role
  - Scrolls to latest message automatically
  - Test function: `testMessage(username, text)`

- `goal-bar.html`: Progress bar for follower/subscriber goals
  - Supports follow or subscriber goal tracking
  - Increments automatically when alerts received
  - Shows current/goal/remaining stats
  - Configurable via URL params: `?type=follow&goal=1000&title=Custom`
  - Smooth progress animation with percentage display

- API Endpoint `/obs/recent/:type`:
  - Returns recent events filtered by type (follow, subscriber, bits, raid, redemption, all)
  - Defaults to last 50 events, ordered most recent first
  - Returns event count and array of events
  - Supports queries like `/obs/recent/follow` or `/obs/recent/all`

---

### [x] Step: Configuration & Testing
<!-- chat-id: 674e3879-f0f7-4cbe-b05a-c8f1f4b289d9 -->

Add configuration system and test alert functionality.

- [x] Add OBS configuration storage (`dashboard/logs/obs-config.json`)
- [x] Add `GET /obs/config` and `POST /obs/config` endpoints
- [x] Add `POST /api/test-alert` endpoint for triggering test alerts (completed in Alert Overlay Implementation step)
- [x] Test all alerts in OBS Browser Source
- [x] Write implementation report to `{@artifacts_path}/report.md`

**Completed Implementation:**
- Added `obs-config.json` initialization in `initLogs()` function with default overlay settings
- Implemented `GET /obs/config` endpoint to retrieve current configuration
- Implemented `POST /obs/config` endpoint to update full configuration
- Implemented `POST /obs/config/:overlay` endpoint to update specific overlay settings
- All configuration changes broadcast via WebSocket to connected clients
- Created comprehensive implementation report with:
  - Step-by-step completion summary
  - Testing guide with API examples
  - Troubleshooting section
  - Configuration examples
  - Known limitations and future improvements
- Report includes quick-start testing without OBS and full OBS integration instructions
- All 5 alert types verified (follow, subscription, bits, raid, redemption)
- Queue system tested for proper alert sequencing

**Additional Improvements** (Commit fab6170):
- Added comprehensive input validation to both `/obs/config` endpoints
- Numeric fields validate for correct range (volume 0-1, positive numbers)
- Overlay names validated against whitelist (alerts, recentEvents, chatBox, goalBar)
- Configuration structure validated to ensure overlays object exists
- Type coercion and auto-sanitization for backward compatibility
- Descriptive error messages with HTTP 400 for validation failures
- Created `validation-improvements.md` documenting all validation logic
- Updated `report.md` with validation matrix and error examples
