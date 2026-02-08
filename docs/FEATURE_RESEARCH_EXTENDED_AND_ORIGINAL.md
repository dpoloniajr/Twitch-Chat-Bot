# Extended Feature Research + Original Ideas

**Purpose:** More researched Twitch/API features plus **original ideas** tailored to Excella’s stack (IRC tags, EventSub, dashboard, overlays).  
**Last updated:** 2025-02-04

---

## Part A — More Researched Features

### A1. Creator Goals (!goal)

**What:** Show the broadcaster’s active Creator Goal (follower or subscription goal) and progress.

- **API:** `GET https://api.twitch.tv/helix/goals?broadcaster_id=...`
- **Scope:** `channel:read:goals` (already in token-generator as “Creator Goals”).
- **Response:** type (follower, subscription), description, current_amount, target_amount, created_at.
- **Command:** `!goal` → “Current goal: 500 followers — 342/500 (68%). Keep it up!”
- EventSub also has goal progress events if you want live overlay updates later.

---

### A2. Hype Train (!hype / overlay)

**What:** Show current Hype Train level and progress, or “No hype train active.”

- **API:** `GET https://api.twitch.tv/helix/hypetrain/events` or Get Hype Train Status (newer).
- **Scope:** `channel:read:hype_train` (already in token-generator).
- **Commands:** `!hype` → “Hype train level 3 — 45% to level 4! Keep cheering/subbing/gifting.”
- **Optional:** EventSub `channel.hype_train.begin/progress/end` to drive OBS overlay (progress bar, level, sound).

---

### A3. Charity campaign (!charity)

**What:** If the broadcaster has an active charity campaign, show campaign name and total raised.

- **API:** `GET https://api.twitch.tv/helix/charity/campaigns` (broadcaster_id).
- **Scope:** `channel:read:charity`.
- **Command:** `!charity` → “Support [Campaign Name] — $X raised so far! [link if in API].”

---

### A4. Viewer count (!viewers)

**What:** Current viewer count for the stream.

- **API:** Already have `getStreamByUserId()` → `viewerCount`.
- **Command:** `!viewers` → “Currently 127 viewers. Thanks for being here!”
- **Cooldown:** 30–60 s to avoid spam.

---

### A5. First-time chatter (researched concept)

**What:** Other bots (Moobot, Streamer.bot) “recognize” a user’s first message in the channel and can send a welcome (chat message and/or OBS alert).

- **In Excella:** We **already receive** Twitch IRC tags `first-msg` and `returning-chatter` in `lib/twitch-irc-client.js` and pass them as `msg.userInfo.isFirst` and `msg.userInfo.isReturningChatter`. We don’t use them yet.
- So “first-time chatter” is a **researched concept** that we can implement with **no new API** — see Part B (original) for our take.

---

### A6. Cancel raid (!cancelraid)

**What:** Cancel a pending raid that was started (e.g. via !raid or Twitch UI) before the 90s countdown ends.

- **API:** `POST https://api.twitch.tv/helix/raids` with cancel (Twitch docs: “Cancel a raid”).
- **Scope:** Broadcaster token; same as start raid.
- **Command:** `!cancelraid` (broadcaster/mod).

---

### A7. Stream tags read (!tags)

**What:** Show current stream tags (and optionally allow mods to add/remove via Twitch API).

- **API:** Get Stream Tags, Update channel (tags in PATCH channels).
- **Command:** `!tags` → “Current tags: Just Chatting, English, Chill.” Read-only is one GET; editing needs channel:manage:broadcast.

---

### A8. Last follower / last sub (!lastfollow, !lastsub)

**What:** “Who was the last person to follow/sub?” — useful when the streamer looks away.

- **Implementation:** Store last follow/sub from EventSub (we already get follow and sub events). Keep one “last” in memory or in dashboard state; expose via `!lastfollow` / `!lastsub`. Optional: store last 5 and allow `!lastsub 3` for 3rd most recent.

---

---

## Part B — Original Ideas (Our Own)

These are tailored to Excella: they use data we already have (IRC tags, EventSub, dashboard, redemptions, overlays) or small, well-scoped additions.

---

### B1. First-time chatter welcome (using existing tags)

**Idea:** When a user’s first message in the channel is seen (`msg.userInfo.isFirst === true`), optionally:

- Send a short welcome in chat (e.g. “Welcome to the chat, @DisplayName!”).
- Trigger an OBS overlay “first chatter” alert (reuse alert pipeline: new type `first_chatter`, same as follow/raid).

**Why it’s ours:** We already have the tag; no other bot in the codebase uses it. Config: `FIRST_CHATTER_WELCOME_ENABLED`, `FIRST_CHATTER_MESSAGE`, optional “send to overlay only” to avoid chat spam.

**Implementation:** In the main message handler (before or after command handling), if `msg.userInfo.isFirst`, check config and send message and/or `sendAlert('first_chatter', { user: displayName })`. Add first_chatter to dashboard alert types if we want overlay.

---

### B2. Returning chatter recognition

**Idea:** Use `msg.userInfo.isReturningChatter` to give a different, quieter treatment than first-time (e.g. “Welcome back, @DisplayName!” once per stream, or only log for dashboard “returning chatters” list). Avoid spamming; e.g. one “welcome back” per user per stream.

**Why it’s ours:** Same IRC tags; we define the UX (optional message, throttle, dashboard stat).

---

### B3. Quote system (!quote, !addquote)

**Idea:** Mods add “quotes” (from chat or typed). Viewers use `!quote` for a random quote or `!quote 5` for quote #5. Stored in dashboard (new JSON file or existing state).

- **!addquote** &lt;text&gt; or **!addquote** &lt;username&gt; &lt;message id / recent&gt; — mod only.
- **!quote** [N] — random or by index.

**Why it’s ours:** Classic “community memory” feature; we own storage and format. Could later add “quote of the day” or overlay widget.

---

### B4. Redemption queue (!queue, !next)

**Idea:** We already log redemptions and broadcast to dashboard. Add:

- **!queue** — “Pending redemptions: 3 — SongRequest by UserA, Highlight by UserB, …” (show last N pending/fulfilled for “what’s in the queue”).
- **!next** — “Up next: SongRequest by UserA.”

**Implementation:** Dashboard already has redemptions; may need to persist “pending” status (Twitch API can return redemption status) or derive from last N redemptions. Optional: only show for certain reward titles (e.g. “Song Request”).

**Why it’s ours:** Uses our existing redemption logging and dashboard; no standard “!queue” in every bot.

---

### B5. Stream milestones (auto-announce or overlay)

**Idea:** When viewer count or follower count crosses a threshold (e.g. 100, 500, 1000 viewers or 10k followers), auto-announce in chat and/or trigger overlay (“We just hit 1000 viewers!”).

- **Data:** Viewer count from `getStreamByUserId` (poll every 1–2 min when live); follower count from Helix Get Channel Followers total or from EventSub follow events (running count).
- **Config:** `MILESTONE_VIEWERS=100,500,1000`, `MILESTONE_FOLLOWERS=10000`; only fire once per milestone per stream or per day.

**Why it’s ours:** We choose thresholds and how to combine with our alert/overlay system.

---

### B6. Lurker appreciation (opt-in, gentle)

**Idea:** Optional “thanks for lurking” style message. E.g. when a user who chatted at least once in the last 30 minutes hasn’t sent a message for 15+ minutes, optionally whisper or reply once: “Thanks for hanging out, @User.” High risk of being annoying — make it **off by default**, rate-limited (e.g. max 1 per 5 minutes globally), and configurable.

**Why it’s ours:** Most bots don’t do this; we can tune aggressiveness and use our existing user/message visibility.

---

### B7. Chat streak (!streak)

**Idea:** Track “how many streams in a row has this user chatted?” (or “consecutive days with at least one message”). Command `!streak` shows the caller’s streak. Mods might get a special message.

- **Implementation:** Persist per-user “last stream date” and “current streak” (e.g. in dashboard logs or a small JSON file). On first message per user per stream, update “last stream” and increment or reset streak. No Twitch API for this — we own the definition.

**Why it’s ours:** Loyalty metric defined by us; encourages “don’t miss a stream.”

---

### B8. Timed stream tips (!tip of the day)

**Idea:** Besides existing announcement interval, support “stream tips” that rotate on a timer: e.g. every 20 minutes post “Tip: Use !commands to see what you can do” or “!clip to clip this moment.” Tips list in config or dashboard; random or sequential.

**Why it’s ours:** Reuses announcement/timer pattern; we choose content and frequency.

---

### B9. “Who said that” / last said (!whosaid &lt;phrase&gt;)

**Idea:** “Who last said X?” — e.g. `!whosaid pog` → “Last said by UserX 2 minutes ago.”

- **Implementation:** Requires a **recent chat buffer**. Right now we POST each message to dashboard but don’t persist a searchable log. Options: (1) In-memory ring buffer in Excella (last 200 messages) and search on command; (2) Dashboard persists last N messages to a file and exposes GET /api/chat/recent?q=... or bot asks dashboard. Either way, add `!whosaid <phrase>` (mod or everyone, with cooldown).

**Why it’s ours:** Fun community feature; depends on our choice to keep a small chat history.

---

### B10. OBS “current goal” overlay

**Idea:** We have OBS overlays for alerts. Add a **goal progress** overlay that shows the current Creator Goal (from Helix Goals API) as a bar + text. Dashboard or overlay client fetches goal (or receives updates via EventSub goal progress) and renders it. Complements `!goal` in chat.

**Why it’s ours:** Uses our overlay + dashboard + Goals API in one place.

---

### B11. New subscriber “streak” or “first sub” highlight

**Idea:** From EventSub we get subs. Optionally detect “first time this user has ever subbed” (Twitch may expose this) or “first sub this stream” and trigger a special overlay or chat message (“First sub of the day — thanks @User!”). Depends on EventSub payload; if not available, “first sub this stream” is still ours (we track sub count this stream).

**Why it’s ours:** Small twist on sub alerts that many bots don’t highlight.

---

### B12. Mod-only “echo” or “say as bot” (!say)

**Idea:** `!say &lt;message&gt;` — bot posts the message to chat (with or without prefix). Useful for announcements that should look like the bot. Mod/broadcaster only; optional strip of “!say” so the message can contain other commands. Careful: no injection (sanitize, no multi-line abuse).

**Why it’s ours:** Simple mod tool; not all bots expose it.

---

## Part C — Summary Tables

### Researched (this doc)

| Feature            | Command / usage      | API / source              | Scope / token   |
|--------------------|----------------------|---------------------------|------------------|
| Creator Goals      | !goal                | GET /goals                | channel:read:goals |
| Hype Train         | !hype (+ overlay)    | GET hype train / EventSub | channel:read:hype_train |
| Charity            | !charity             | GET /charity/campaigns    | channel:read:charity |
| Viewer count       | !viewers             | getStreamByUserId         | existing         |
| First-time chatter | (see B1)             | IRC tag first-msg         | none             |
| Cancel raid        | !cancelraid          | POST /raids (cancel)      | broadcaster      |
| Stream tags        | !tags                | GET/PATCH channels/tags   | read: any; edit: channel:manage:broadcast |
| Last follow/sub    | !lastfollow, !lastsub| EventSub (store last)     | existing         |

### Original (our own)

| Feature              | Command / usage     | Main dependency              |
|----------------------|--------------------|-----------------------------|
| First-time welcome   | Config + handler   | msg.userInfo.isFirst        |
| Returning chatter    | Config + handler   | msg.userInfo.isReturningChatter |
| Quote system         | !quote, !addquote  | New storage (dashboard)      |
| Redemption queue     | !queue, !next      | Existing redemptions log    |
| Stream milestones    | Auto-announce      | getStreamByUserId + follow count |
| Lurker thanks        | Optional whisper  | Message timing logic         |
| Chat streak          | !streak            | Per-user persistence        |
| Timed stream tips    | Timer              | Announcement-style timer    |
| Who said             | !whosaid &lt;phrase&gt; | Recent chat buffer (new)   |
| Goal overlay         | OBS overlay        | Goals API + overlay client  |
| First sub highlight  | EventSub + overlay | Sub events                  |
| Mod say              | !say &lt;msg&gt;   | sendChatMessage (mod only) |

---

## Suggested implementation order (combined)

1. **Already planned:** Raffle, Stream marker.  
2. **Quick / high impact:** Uptime, Permit, First-time chatter welcome (B1), !viewers, Fun commands (8ball, dice).  
3. **Researched API features:** !goal, !hype, !charity, !tags, !lastfollow / !lastsub, Schedule, Commercial, Raid/Cancel raid.  
4. **Original engagement:** Quote system (B3), Redemption queue (B4), !streak (B7), Mod !say (B12).  
5. **Larger / optional:** Stream milestones (B5), Who said (B9) + chat buffer, Goal overlay (B10), Lurker thanks (B6), Timed tips (B8).

This keeps a mix of “expected” Twitch features and Excella-specific ideas that use the stack we already have.
