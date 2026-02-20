# Feature Research: New Bot Features for Stream Engagement

**Purpose:** Research and recommend new Excella features that add to the stream and drive viewer engagement.  
**Last updated:** 2025-02-20

---

## 1. Current Engagement Stack (Summary)

| Area | What Excella Has |
|------|------------------|
| **Loyalty** | Points from chat + watch time; `!balance` / `!leaderboard`; levels; only **song request** spends points today |
| **Chat** | Commands (!clip, !followage, !quote, !counter, !hype, !tts, !sr, etc.), filters, custom commands |
| **Events** | EventSub → follow, sub, bits, raid, Channel Point redemptions → dashboard + OBS alerts (e.g. TTS) |
| **Overlays** | Alerts, recent events, chat, goal bar, TTS, song player, **leaderboard**, counters, quotes |
| **Planned** | Raffle, Stream marker (see FEATURE_PLAN_RAFFLE_AND_STREAM_MARKER.md) |

**Gap:** Points are earned everywhere but **only spent on song requests**. No loyalty store, no points-based games, and no additional “reward” actions that keep people chatting and watching.

---

## 2. Engagement Features Worth Adding

Below are features that **drive engagement** (more chat, more watch time, more return visits) and fit the existing codebase.

---

### 2.1 Loyalty Store (Expand Points Usage) — **Top recommendation**

**What:** Let viewers spend loyalty points on a small set of redemptions beyond song request.

**Why it drives engagement:**
- Gives a clear reason to earn points (chat + watch time).
- Creates memorable moments (TTS, highlight, shoutout) that others see and want to try.
- Reuses existing `loyalty-store.js` (`deductPoints` / `refundPoints`) and dashboard APIs; song-queue is the reference pattern.

**Suggested store items (configurable cost in dashboard):**

| Item | Cost (example) | Effect |
|------|----------------|--------|
| **TTS message** | 100–500 | User’s message read by TTS (existing TTS pipeline). |
| **Highlight / clip request** | 200–500 | Bot posts “@user requested a highlight!” and/or triggers overlay; streamer can clip. |
| **Raffle ticket** | 50–100 | One entry into the next mod-run raffle (when raffle is implemented). |
| **Shoutout request** | 150–300 | Bot runs shoutout for a target (e.g. “!so Target” or dedicated flow). |

**Implementation outline:**
- **Dashboard:** New “Loyalty Store” page: list of items, cost, enabled/disabled. Optional: simple “transactions” view for store spends.
- **API:** New route e.g. `POST /api/loyalty/redeem` with `{ itemId, username, target? }` → validate item, `deductPoints`, then trigger action (TTS, alert, raffle entry, shoutout).
- **Bot:** New command e.g. `!redeem <item> [target]` or `!store` to list items; bot calls dashboard redeem API and replies with success/insufficient points.
- **OBS:** Reuse existing alert/TTS overlays for “store” redemptions (e.g. alert type `store_tts`, `store_highlight`).

**Complexity:** Medium (new dashboard page + one API + command); logic is similar to song-queue (deduct → action → optional refund on failure).

---

### 2.2 Viewer Duel (1v1 Points Battle)

**What:** Two viewers spend points to “duel”; winner is chosen at random (or by a simple rule, e.g. dice). Winner gets a bonus (e.g. double stake back or fixed reward); loser loses their stake.

**Why it drives engagement:**
- Creates rivalry and chat buzz (“!duel @Someone”).
- Encourages earning points to participate.
- Common in other platforms (StreamElements “Duel”); fits Twitch chat culture.

**Commands (everyone, with cooldown):**
- `!duel @opponent` — Challenge another user. Both must have enough points (e.g. 50). Bot deducts from both, picks winner randomly, pays winner (e.g. 50 + 50 → winner gets 80, 20 to “house” or back to pool), announces in chat.
- Optional: `!duel cancel` to withdraw before the other accepts (if you add an “accept” step).

**Implementation outline:**
- **Loyalty:** `deductPoints` for both users; `addPoints` for winner (and optionally small bonus). Use `loyalty-store.js` and existing dashboard loyalty file.
- **Bot:** New handler in Excella (or dashboard API that Excella calls): validate both users have balance, deduct, run “roll”, credit winner, broadcast result. Reply in chat: “@UserA wins the duel vs @UserB! 80 points awarded.”
- **Dashboard:** Optional “Duel” tab: last N duels, leaderboard of “duel wins” (would require storing duel history; can be Phase 2).
- **OBS:** Optional overlay event “duel_result” for a quick on-screen graphic.

**Complexity:** Medium. Main work: duel state (who challenged whom, accept/decline vs instant), and making sure double-spend and race conditions are avoided (single redeem/duel endpoint under lock).

---

### 2.3 First-Time Chatter Welcome (Already Researched — High Impact)

**What:** When a viewer’s first message in the channel is detected (Twitch IRC tag `first-msg`), send a short welcome in chat and/or trigger an OBS “first chatter” alert.

**Why it drives engagement:**
- Makes new viewers feel recognized; increases chance they stay and chat again.
- **No new API:** Excella already has `msg.userInfo.isFirst` (see FEATURE_RESEARCH_EXTENDED_AND_ORIGINAL.md B1).

**Implementation:** In message handler, if `msg.userInfo.isFirst`, check config (e.g. `FIRST_CHATTER_WELCOME_ENABLED`), send one welcome message and/or `sendAlert('first_chatter', { user })`. Add `first_chatter` to dashboard alert types and overlay.

**Complexity:** Low.

---

### 2.4 Raffle Tickets with Loyalty (Combine Planned Raffle + Store)

**What:** When raffle is implemented (see FEATURE_PLAN_RAFFLE_AND_STREAM_MARKER.md), allow **optional** entries by spending points: e.g. “!raffle 1” = mod picks from chatters; “!raffleticket” = viewer spends 50 points for one raffle entry. When mod runs `!raffle`, pool = chatters + ticket holders, or a separate “ticket” raffle.

**Why it drives engagement:**
- Incentivizes earning points and staying for the raffle.
- Differentiates “everyone in chat” raffle from “paid ticket” raffle (more invested audience).

**Implementation:** Store “raffle tickets” in memory or a small JSON (username, count). `!raffleticket` → deduct points, increment ticket count. When `!raffle` runs, include ticket holders in the pool (weighted by tickets or one entry per ticket). Clear tickets after each raffle or when stream ends.

**Complexity:** Medium; depends on raffle being implemented first.

---

### 2.5 “Mystery Box” / Random Reward (Spend Points)

**What:** Viewer uses `!mysterybox` or `!roll` to spend a fixed amount of points (e.g. 25). They get a random outcome: e.g. “Nothing this time!”, “TTS message!”, “50 points back”, “Shoutout next stream,” etc.

**Why it drives engagement:**
- Low friction, fun, repeatable. Encourages earning points for “one more try.”
- Reuses existing TTS/alert and loyalty deduct; outcomes are configurable in dashboard.

**Implementation:** Dashboard: list of outcomes (type + weight or probability). API: `POST /api/loyalty/mysterybox` → deduct points, pick outcome, apply (e.g. add points, trigger TTS). Bot: `!mysterybox` calls API and replies with result.

**Complexity:** Low–medium.

---

## 3. Comparison and Suggested Order

| Feature | Engagement impact | Fits current stack | Complexity | Suggested order |
|---------|-------------------|--------------------|------------|------------------|
| **Loyalty Store** | High | Yes (deduct/refund, TTS, alerts) | Medium | 1 |
| **First-time chatter welcome** | High (retention) | Yes (existing tag) | Low | 2 |
| **Viewer Duel** | High (chat buzz) | Yes (loyalty) | Medium | 3 |
| **Raffle + tickets** | High | After raffle exists | Medium | 4 |
| **Mystery box** | Medium | Yes (loyalty + alerts) | Low–Medium | 5 |

---

## 4. Recommended Next Step

1. **Implement Loyalty Store (MVP):**  
   - Add 2–3 items: e.g. **TTS message** and **Highlight request** (and optionally **Raffle ticket** once raffle exists).  
   - Dashboard: store config (item id, name, cost, enabled) + `POST /api/loyalty/redeem`.  
   - Bot: `!redeem <item> [target]` and `!store` (list items and costs).  
   This gives viewers a clear way to spend points and creates visible, shareable moments on stream.

2. **Add First-Time Chatter Welcome:**  
   - Config flag + one branch in message handler + `first_chatter` alert type.  
   Quick win that improves first-time viewer retention.

3. **Then:** Raffle + Stream marker (already planned), then Duel or Mystery box depending on preference.

---

## 5. References

- **Codebase:** `dashboard/lib/loyalty-store.js` (deductPoints, refundPoints, awardMessagePoints); `dashboard/routes/song-queue.js` (pattern for “cost + action”); `Excella.js` (commandRegistry, message handler, alerts).
- **Docs:** FEATURE_PLAN_RAFFLE_AND_STREAM_MARKER.md, FEATURE_RESEARCH_EXTENDED_AND_ORIGINAL.md, FEATURE_RESEARCH_ADDITIONAL.md.
- **External:** StreamElements Duel/Raffle/Emote Bingo; Moobot giveaways and song requests — same engagement goals, different implementations.
