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

### [ ] Step: Enhanced EventSub Events

Extend the bot to capture subscription and bits events.

- [ ] Add subscription event handlers (`onChannelSubscription`, `onChannelSubscriptionGift`) to `Excella`
- [ ] Add bits/cheer event handler (`onChannelCheer`) to `Excella`
- [ ] Update `/api/eventsub-events` payloads with detailed info (tier, amount, message)
- [ ] Add new WebSocket message type `'alert'` for overlay consumption
- [ ] Document required additional scopes (`channel:read:subscriptions`, `bits:read`) in token-generator

---

### [ ] Step: Additional Overlays

Build supplementary overlay pages.

- [ ] Create `obs/overlays/recent-events.html` for scrolling latest follower/sub display
- [ ] Create `obs/overlays/chat-box.html` for OBS chat overlay
- [ ] Create `obs/overlays/goal-bar.html` for follow/sub goal progress
- [ ] Add API endpoint `GET /obs/recent/:type` for recent events by type
- [ ] Style all overlays with consistent theming

---

### [ ] Step: Configuration & Testing

Add configuration system and test alert functionality.

- [ ] Add OBS configuration storage (`dashboard/logs/obs-config.json`)
- [ ] Add `GET /obs/config` and `POST /obs/config` endpoints
- [x] Add `POST /api/test-alert` endpoint for triggering test alerts (completed in Alert Overlay Implementation step)
- [ ] Test all alerts in OBS Browser Source
- [ ] Write implementation report to `{@artifacts_path}/report.md`
