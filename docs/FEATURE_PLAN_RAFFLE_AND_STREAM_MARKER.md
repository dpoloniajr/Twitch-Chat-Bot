# Feature Plan: Raffle (Random Viewer Picker) & Stream Marker

**Status:** Planning  
**Target:** Excella (Twitch Chat Bot)  
**Last updated:** 2025-02-04

---

## 1. Research: Popular Twitch Bot Features

From current bot platforms (Streamer.bot, Nightbot, Moobot, open-source bots) and community demand, the most requested features are:

| Category | Feature | Excella today |
|----------|---------|----------------|
| **Community** | **Raffle / random viewer picker** | ❌ Not implemented |
| **Community** | Polls & predictions | ✅ Already have |
| **Community** | Song requests (YouTube/Spotify) | ❌ Not implemented (high complexity) |
| **Stream tools** | **Stream markers from chat** | ❌ Not implemented |
| **Stream tools** | Title/game/category | ✅ Already have |
| **Moderation** | Custom commands, filters, shoutouts | ✅ Already have |
| **Engagement** | Channel points, clips, followage | ✅ Partial (redemptions logged, clip, followage) |

**Gap chosen for this plan:**  
- **Primary:** **Raffle (random viewer picker)** — very popular, fits existing command/mod pattern, uses one new Helix endpoint.  
- **Secondary:** **Stream marker from chat** — quick win, one Helix endpoint, no new scopes if broadcaster token already has `channel:manage:broadcast`.

---

## 2. Proposed Features

### 2.1 Raffle (Random Viewer Picker) — Primary

**Idea:** Mods run a raffle by typing a command. The bot fetches current chatters via Helix, optionally applies filters (e.g. exclude mods/bots), picks one or more random winners, and announces in chat.

**Commands (mod-only):**

- `!raffle` or `!raffle 1` — Pick 1 random chatter, announce winner.
- `!raffle 3` — Pick 3 random chatters (no duplicate winners).
- `!raffle 1 viewers` — Optional: restrict to “viewers” role only (exclude mods/VIPs; depends on Helix chatters API role).

**Behavior:**

- Use **Twitch Helix “Get Chatters”** to get users in the channel.
- Require scope: **`moderator:read:chatters`** (already in token-generator scope list).
- Paginate if needed (Helix returns up to 1000 per request, pagination for more).
- Optional: exclude broadcaster, moderators, or VIPs (config or command flag).
- Cooldown to avoid spam (e.g. 30–60 s) and optional “raffle in progress” lock.
- Reply in chat: e.g. `Winner(s): @user1, @user2` or `No chatters to pick from.`

**API:**

- Endpoint: `GET https://api.twitch.tv/helix/chat/chatters`
- Params: `broadcaster_id`, `moderator_id` (bot or mod user id), `first` (max 1000), `after` (cursor).
- Docs: [Get Chatters](https://dev.twitch.tv/docs/api/reference#get-chatters)

**Implementation outline:**

1. **Helix client** (`lib/twitch-helix-api.js`): add `getChatters(broadcasterId, moderatorId, options)` with pagination.
2. **Excella** (`Excella.js`):
   - Add `handleRaffle(channel, username, args)`.
   - Validate `moderator:read:chatters`; get broadcaster id and moderator id (from token or message).
   - Call `getChatters`, optionally filter by role, pick N random, send result to chat.
   - Register `!raffle` in `commandRegistry` (perm: `mod`), with cooldown.
3. **Dashboard**: optional — show last raffle winner in “Recent” or a small “Raffle” section; can be Phase 2.
4. **Docs**: add to CLAUDE.md built-in commands table; mention new scope in token generator / account setup.

**Out of scope for MVP:**

- Loyalty/points (no “tickets” or “bad luck protection”).
- Sub-only or follower-only (can be a later option: filter chatters by role only if Helix provides it).

---

### 2.2 Stream Marker — Secondary (Quick Win)

**Idea:** Mods/broadcaster add a stream marker (timestamp in the VOD) from chat so they can find moments later.

**Command (mod/broadcaster):**

- `!marker` — Create a marker with no description.
- `!marker Clip the fight` — Create a marker with description “Clip the fight” (max 140 chars).

**Behavior:**

- Use **Twitch Helix “Create Stream Marker”**: `POST /streams/markers` with `broadcaster_id` and optional `description`.
- Require scope: **`channel:manage:broadcast`** (broadcaster token; already in scope list).
- Only works when the channel is **live**; Twitch returns an error otherwise.
- Reply in chat: “Stream marker added.” or “Could not add marker: [reason]” (e.g. not live, VOD storage disabled).

**API:**

- Endpoint: `POST https://api.twitch.tv/helix/streams/markers`
- Body: `{ "user_id": "<broadcaster_id>", "description": "optional" }`
- Docs: [Create Stream Marker](https://dev.twitch.tv/docs/api/reference#create-stream-marker)

**Implementation outline:**

1. **Helix client** (`lib/twitch-helix-api.js`): add `createStreamMarker(broadcasterId, description)` (use broadcaster token).
2. **Excella** (`Excella.js`):
   - Add `handleMarker(channel, username, args)`.
   - Use **broadcaster** API client (stream markers require broadcaster token).
   - Check scope `channel:manage:broadcast`; if not live, return friendly message.
   - Register `!marker` in `commandRegistry` (perm: `mod`), with short cooldown (e.g. 10–30 s).
3. **Docs**: add to CLAUDE.md.

---

## 3. Scope Summary

| Feature      | New scope(s)                  | Token        | Notes                                      |
|-------------|-------------------------------|-------------|--------------------------------------------|
| Raffle      | `moderator:read:chatters`     | Bot token   | Already in token-generator scope list      |
| Stream marker | `channel:manage:broadcast`  | Broadcaster | Already in scope list; use broadcaster client |

No new env vars required; existing bot/broadcaster token setup is enough.

---

## 4. File Change Checklist

- [ ] **lib/twitch-helix-api.js**
  - [ ] `getChatters(broadcasterId, moderatorId, { first, after })` with pagination
  - [ ] `createStreamMarker(broadcasterId, description)` (broadcaster token)
- [ ] **Excella.js**
  - [ ] `handleRaffle(channel, username, args)` + `!raffle` in commandRegistry (mod, cooldown)
  - [ ] `handleMarker(channel, username, args)` + `!marker` in commandRegistry (mod, cooldown)
  - [ ] `handleCommands` / builtin list: add !raffle, !marker
- [ ] **token-generator / scope-routes**
  - No code change; document in setup that raffle needs `moderator:read:chatters`, marker needs broadcaster with `channel:manage:broadcast`
- [ ] **CLAUDE.md**
  - [ ] Built-in commands table: add !raffle, !marker and required scopes
- [ ] **dashboard** (optional Phase 2)
  - [ ] Optional: last raffle winner in dashboard or “Raffle” section

---

## 5. Testing Ideas

- **Raffle:** In a test channel with few chatters, run `!raffle` and `!raffle 2`; confirm winner(s) are in the chatters list and message is correct. Test with 0 chatters (e.g. wrong channel). Test cooldown.
- **Stream marker:** While live, run `!marker` and `!marker Test description`; confirm markers appear in Twitch dashboard (Stream Manager → Markers). When not live, confirm friendly error.

---

## 6. References

- [Twitch API – Get Chatters](https://dev.twitch.tv/docs/api/reference#get-chatters)
- [Twitch API – Create Stream Marker](https://dev.twitch.tv/docs/api/reference#create-stream-marker)
- CLAUDE.md (project patterns, command registry, scope validation)
- token-generator-api/scope-routes.js (moderator:read:chatters, channel:manage:broadcast)
