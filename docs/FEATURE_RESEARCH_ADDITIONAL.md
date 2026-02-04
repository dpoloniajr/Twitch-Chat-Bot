# Additional Feature Research — Twitch Bot Features to Add

**Purpose:** Expand the backlog of possible Excella features beyond Raffle and Stream Marker.  
**Last updated:** 2025-02-04

---

## Summary Table

| Feature | Category | Excella today | Complexity | API / Logic | Suggested priority |
|--------|----------|----------------|------------|-------------|--------------------|
| [Raffle](#1-raffle) | Community | ❌ | Low | Helix Get Chatters | Already planned |
| [Stream marker](#2-stream-marker) | Stream tools | ❌ | Low | Helix Create Marker | Already planned |
| [Uptime](#3-uptime) | Stream info | ❌ | Low | Existing getStreamByUserId | High |
| [Permit](#4-permit) | Moderation | ❌ | Low | Bot logic only | High |
| [Schedule / next stream](#5-schedule--next-stream) | Stream info | ❌ | Low | Helix Get Schedule | Medium |
| [Commercial](#6-commercial) | Stream tools | ❌ | Low | Helix Start Commercial | Medium (broadcaster-only) |
| [Start raid](#7-start-raid) | Community | ❌ | Low | Helix Start Raid | Medium (broadcaster-only) |
| [Bits leaderboard](#8-bits-leaderboard) | Engagement | ❌ | Low | Helix Bits Leaderboard | Low |
| [Fun commands (8ball, etc.)](#9-fun-commands) | Engagement | ❌ | Low | No API | Low |
| [Social / info commands](#10-social--info-commands) | Engagement | Partial | Low | Custom / config | Low |

---

## 1. Raffle

*(See [FEATURE_PLAN_RAFFLE_AND_STREAM_MARKER.md](./FEATURE_PLAN_RAFFLE_AND_STREAM_MARKER.md).)*

- **Commands:** `!raffle` [N] [viewers]
- **API:** Get Chatters (`moderator:read:chatters`)

---

## 2. Stream marker

*(See [FEATURE_PLAN_RAFFLE_AND_STREAM_MARKER.md](./FEATURE_PLAN_RAFFLE_AND_STREAM_MARKER.md).)*

- **Commands:** `!marker` [description]
- **API:** Create Stream Marker (`channel:manage:broadcast`, broadcaster token)

---

## 3. Uptime

**What:** Show how long the current stream has been live.

**Why:** Very common; viewers constantly ask “how long have you been live?”

**Commands:**

- `!uptime` — Reply with e.g. “Stream has been live for 2h 35m 10s” or “Channel is not live.”

**Implementation:**

- **No new API.** Use existing `apiClient.getStreamByUserId(broadcasterId)` (or equivalent with broadcaster user id). Response includes `startedAt`; compute duration as `now - startedAt`.
- **Caching:** Reuse existing stream fetch if you already cache stream state; otherwise a short TTL (e.g. 30–60 s) is enough.
- **Permission:** Everyone.
- **Cooldown:** 10–30 s to avoid spam.

**Files:** Excella.js — new `handleUptime(channel)`, register `!uptime` in commandRegistry; add to dashboard commands list.

---

## 4. Permit

**What:** Temporarily allow a user to post links without being hit by the bot’s URL filter (timeout/delete).

**Why:** Standard in Nightbot, StreamElements, etc. Lets mods say “this link is OK” without disabling link filter globally.

**Commands (mod-only):**

- `!permit <username>` — Allow link posting for default duration (e.g. 60 s).
- `!permit <username> <seconds>` — Allow for N seconds.

**Implementation:**

- **No new API.** Pure bot logic:
  - In-memory (or dashboard-backed) allowlist: `Set` or `Map` of `username_lower -> expiryTimestamp`.
  - In the existing URL-filter branch (Excella chat filters): before applying timeout/delete, check if the message’s username is on the permit list and not expired. If yes, skip action (and optionally remove from list after first use or keep until expiry).
  - Optional: `!unpermit <username>` to remove early.
- **Permission:** Mod only.
- **Scope:** None.

**Files:** Excella.js — permit allowlist, check in URL filter path; register `!permit` and optional `!unpermit` in commandRegistry.

---

## 5. Schedule / next stream

**What:** Show the broadcaster’s stream schedule or “next stream” time.

**Commands:**

- `!schedule` — Next scheduled stream (time, title, recurrence if any).
- `!nextstream` — Same or alias.

**Implementation:**

- **API:** `GET https://api.twitch.tv/helix/schedule?broadcaster_id=...`  
  Scope: **`channel:read:schedule`** (read-only; check token-generator for exact scope name).
- Response includes segments (start_time, end_time, title, is_recurring, etc.). Pick the next segment after “now” and format for chat.
- If 404 or no upcoming segments: “No upcoming scheduled streams.”
- **Permission:** Everyone. **Cooldown:** 60+ s (schedule doesn’t change every second).

**Files:** twitch-helix-api.js — `getSchedule(broadcasterId)`; Excella.js — `handleSchedule(channel)`, register `!schedule` / `!nextstream`; add scope to token generator if missing.

---

## 6. Commercial

**What:** Start an ad break from chat (30–180 s).

**Commands (broadcaster-only in practice):**

- `!commercial` — Default length (e.g. 60 s).
- `!commercial 90` — 90-second ad. Allowed: 30, 60, 90, 120, 150, 180.

**Implementation:**

- **API:** `POST https://api.twitch.tv/helix/channels/commercial`  
  Body: `broadcaster_id`, `length`.  
  Scope: **`channel:edit:commercial`**.  
  **Note:** Twitch docs state only the **broadcaster** may start a commercial (not editors/mods). Use broadcaster token; restrict command to broadcaster only (or document that only broadcaster should use it).
- Reply: “Running a 60s ad.” or “Cannot run ad: [reason]” (e.g. not live, cooldown). Twitch returns `retry_after` on cooldown — can echo “Next ad in Xs.”

**Files:** twitch-helix-api.js — `startCommercial(broadcasterId, length)`; Excella.js — `handleCommercial(channel, username, args)`, perm: broadcaster-only or mod (with doc that only broadcaster’s token works).

---

## 7. Start raid

**What:** Initiate a raid to another channel from chat.

**Commands (broadcaster-only):**

- `!raid <username>` — Start raid to the given channel. Twitch shows the usual raid UI; raid executes when broadcaster clicks “Raid Now” or after 90s.

**Implementation:**

- **API:** `POST https://api.twitch.tv/helix/raids?from_broadcaster_id=...&to_broadcaster_id=...`  
  Requires **broadcaster** user token (from_broadcaster_id must match token). No moderator-only option.
- Resolve `username` → `to_broadcaster_id` via Helix Users (getUserByName).
- Reply: “Raid initiated to @Target. Check your Twitch UI to confirm.” or “Could not start raid: [reason].”

**Files:** twitch-helix-api.js — `startRaid(fromBroadcasterId, toBroadcasterId)`; Excella.js — `handleRaid(channel, username, args)`, broadcaster-only.

---

## 8. Bits leaderboard

**What:** Show top Bits supporters (e.g. “Top 5 cheerers this month”).

**Commands:**

- `!bits` or `!cheerboard` [count] — Top N (default 5), period optional (e.g. week, month, all).  
  Scope: **`bits:read`** (broadcaster token).

**Implementation:**

- **API:** `GET https://api.twitch.tv/helix/bits/leaderboard` with `count`, `period`, optional `started_at`.
- Format: “Top cheerers (month): 1. UserA - 10,000 bits, 2. UserB - 5,000 bits…”

**Files:** twitch-helix-api.js — `getBitsLeaderboard(options)`; Excella.js — `handleBitsLeaderboard(channel, args)`; broadcaster token + scope.

---

## 9. Fun commands

**What:** Simple, stateless “fun” replies (no external API).

**Examples:**

- **!8ball** `<question>` — Random yes/no/maybe style answer from a fixed list.
- **!dice** [sides] — Roll 1–N (default 6).
- **!coinflip** — Heads or tails.

**Implementation:**

- No Helix calls. Random choice from arrays; optional cooldown per command.
- **Permission:** Everyone. Good for engagement and custom-command-style variety.

**Files:** Excella.js — small handlers + register in commandRegistry. Optional: make response lists configurable via dashboard later.

---

## 10. Social / info commands

**What:** Point viewers to socials or answer “when do you stream?” / “what’s your setup?” etc.

**Excella today:** Custom commands already allow arbitrary text and variables. So “social” can be done as custom commands (e.g. `!twitter` → “Follow me: https://…”). Optional enhancements:

- **!social** or **!links** — Single command that lists all configured links (would need dashboard/config for “social links”).
- **!discord**, **!youtube**, etc. — Either custom commands or a small set of config keys (e.g. `SOCIAL_DISCORD`, `SOCIAL_YOUTUBE`) that one built-in command reads and formats.

**Implementation:** Prefer custom commands for one-off links. If you want one “!social” that shows multiple links, add a small config section or dashboard UI for “social links” and one command that reads and formats them.

---

## Scope reference (already in token-generator or to add)

| Scope | Used by |
|-------|--------|
| `moderator:read:chatters` | Raffle |
| `channel:manage:broadcast` | Stream marker |
| `channel:read:schedule` | Schedule / next stream (verify name in Twitch docs) |
| `channel:edit:commercial` | Commercial |
| `bits:read` | Bits leaderboard |
| Raid | No extra scope; broadcaster token only |

---

## Suggested implementation order

1. **Already planned:** Raffle, Stream marker.
2. **Quick wins (no or minimal new API):** Uptime, Permit, Fun commands (8ball, dice, coinflip).
3. **Streamer QoL:** Schedule, Commercial, Start raid (broadcaster-only).
4. **Engagement:** Bits leaderboard, optional Social/links aggregation.

This order maximizes visible new features with minimal new dependencies and fits Excella’s existing patterns (command registry, scopes, cooldowns, mod/broadcaster checks).
