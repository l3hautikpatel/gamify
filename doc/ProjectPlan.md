# Online Mafia (Werewolf) — Build Spec

A browser-based version of offline Mafia, playable by a remote team, hosted **entirely as static files on GitHub Pages**. Real-time sync is peer-to-peer via WebRTC (using PeerJS's free public broker only for the initial handshake — no server you run, no account you create). Fully mobile-responsive, since players will likely join from phones while on a video call at their desk or on the go. Works across completely different networks — home, office, mobile data — not just same-WiFi.

---

## 0. Design Decisions (read this first)

**1. Voice chat is NOT built into the app.**
Mafia depends on people talking, accusing, bluffing out loud. Rebuilding voice/video over WebRTC on top of a game-state layer is a lot of extra complexity and a lot more that can break on office networks. Instead: the team keeps their normal Zoom/Meet/Teams call open for talking, and this app runs *alongside* it purely to handle secret roles, night actions, timers, and voting. This is the single biggest scope-reducer in this spec — keep it this way unless you specifically want to build video.

**2. The Host's browser is the authoritative server.**
Just like offline Mafia, the host already knows everyone's role. So instead of a mesh network where every peer talks to every peer, every player connects *only* to the host. The host's browser holds the real game state and pushes each player a personalized view (a mafia member sees their teammates; a villager sees nothing extra). This avoids the hardest part of P2P games (state consistency across many peers) entirely.

**3. Trust model.**
Because the host's own browser computes and knows everything, a technically savvy host *could* open devtools and cheat. This is unavoidable in a pure client-side P2P game with no server — it's the same trust assumption as the offline game (the host is trusted not to cheat). Section 8 adds a lightweight fairness signal (a commitment hash) that doesn't fully solve this but is a cheap trust-building addition. A real fix would mean adding a backend later (Firebase, etc.) — stretch goal, not in scope now.

**4. Known risk: some networks may block direct WebRTC, and how it's mitigated.**
WebRTC first tries a direct connection (via STUN, which just helps two browsers discover each other's public address). This works on the large majority of home and office networks, and across completely different networks — that's the normal case, not an edge case. On the rare corporate firewall that blocks direct peer traffic, WebRTC falls back to a **TURN relay** — a public server that just forwards encrypted traffic between the two browsers, usually over the same port HTTPS uses (443), which is almost never blocked. This spec includes a free TURN fallback from the start (Section 4 and Phase 1) so you don't have to circle back to it later if the plain version doesn't work for someone.

**5. Mobile responsiveness is a first-class requirement, not an afterthought.**
People will very likely join from a phone while the discussion happens over a laptop's video call, or vice versa. Every screen needs to work at phone width without horizontal scrolling, with tap targets big enough for thumbs. Details in Section 9.

**6. Reconnection is a first-class requirement.**
Tabs get closed, laptops sleep, phones lock. Anyone (host or player) should be able to reopen the link and land back exactly where they left off, without restarting the game. Full mechanics in Section 7.

**7. The game must never silently stall.**
If a mafia member, doctor, investigator, or voter simply doesn't act, the game moves on with a sensible default rather than freezing everyone else's screen. Full details in Section 8.

---

## 1. Tech Stack

| Piece | Choice | Why |
|---|---|---|
| Hosting | GitHub Pages | Free static hosting, exactly what was asked for |
| Real-time transport | [PeerJS](https://peerjs.com/) (wraps WebRTC DataChannels) | No backend to run; uses PeerJS's free public signaling broker only to exchange connection info, then goes fully peer-to-peer |
| NAT traversal fallback | Free public TURN servers (e.g. Open Relay Project, or metered.ca's free tier) | Keeps connections working even when direct P2P is blocked |
| Frontend | Plain HTML/CSS/JS — no build step required | Keep it framework-light so `git push` = deploy; simplest possible mobile-responsive CSS with plain media queries |
| State | In-memory JS object on the host's tab, mirrored into `localStorage` for recovery, synced to players via JSON messages over PeerJS data connections | No database needed |
| Repo structure | Single repo, root as Pages source | Standard GitHub Pages setup |

No npm build pipeline is required if you go plain JS — you can literally open `index.html` locally to test, and `git push` to deploy. If you'd rather use React for the UI, that's fine too, just add a build step and publish the `dist/` folder to Pages — mention if you want that version of this spec instead.

---

## 2. Roles

| Role | Assignment | Notes |
|---|---|---|
| **Mafia** | Host sets a count (e.g. 1–3) | Sees teammates' identities during night phase; picks one victim together (host resolves ties/majority) |
| **Villager** | Auto-fills everyone not otherwise assigned | No special action |
| **Doctor** (toggle) | 1 if enabled | Each night, chooses one player to protect from the mafia kill (decide up front: can they self-protect, and every night or just once) |
| **Investigator / Detective** (toggle) | 1 if enabled | Each night, chooses one player to check; learns "Mafia" or "Not Mafia" |

Host settings screen controls: total player count (auto-detected from lobby), number of mafia, doctor on/off, investigator on/off, night phase duration, day/discussion duration, voting duration.

### Assignment algorithm (detailed)
1. Take the list of connected, non-host players, each with their stable `playerId`.
2. Shuffle with Fisher–Yates (unbiased, standard array shuffle — don't use `Array.sort(() => Math.random() - 0.5)`, it's statistically biased).
3. Slice the first N entries as Mafia (N = host setting, validated so N < total players / 2, roughly — a common rule of thumb is 1 mafia per 3–4 players; see Section 8 for enforcing this in the UI).
4. If Doctor is enabled, take the next unassigned entry as Doctor.
5. If Investigator is enabled, take the next unassigned entry as Investigator.
6. Every remaining entry = Villager.
7. Send each player **only their own role** via a private message — never broadcast the full assignment map to any non-host client. Mafia players additionally receive the list of `playerId`s (and display names) of their teammates.
8. Store the full assignment map only in host memory + host's own `localStorage` mirror (Section 7) — this is the "god view."

### Optional fairness signal: commitment hash
Right after generating the assignment (step 6, before revealing anything), the host can hash the full assignment map (e.g. `SHA-256(JSON.stringify(assignmentMap) + a random salt)`) using the browser's built-in `crypto.subtle.digest`, and broadcast just that hash string to everyone immediately — not the assignment itself, just its fingerprint. At `GAME_OVER`, when the full roles are revealed anyway, the host also reveals the salt, and anyone who wants to can recompute the hash client-side and confirm it matches what was committed at the start of the round. This doesn't stop a determined cheater from also faking the hash, but it's a cheap, visible trust signal for very little extra code, and mirrors how "provably fair" shuffles work in other online games.

### Role metadata structure (for `roles.js`)
Each role should be a small config object so adding new roles later (Jester, Vigilante, Mayor, etc.) is just adding an entry:
```js
{
  id: "doctor",
  displayName: "Doctor",
  team: "village",
  nightAction: true,           // does this role act at night?
  actionLabel: "Choose someone to protect",
  actionTargetFilter: (players) => players.filter(p => p.alive),
  resolvePriority: 1,           // doctor resolves before mafia kill is finalized
  timeoutDefault: "none"        // what happens if the timer runs out with no action — see Section 8
}
```

---

## 3. Game Phase State Machine

```
LOBBY → ROLE_REVEAL → NIGHT → NIGHT_RESOLVE → DAY_DISCUSSION → DAY_VOTE → VOTE_RESOLVE → (check win) →
  ├─ back to NIGHT (repeat)
  └─ GAME_OVER
```

**LOBBY**
- Host creates room, gets a shareable room code/link.
- Players join by opening the link (or typing the code on the home page) and entering a name.
- Host sees a live player list, updating in real time as people connect/disconnect.
- Host clicks "Start Game" once enough players joined and settings are valid for that player count (Section 8 covers the guardrails).

**ROLE_REVEAL**
- Each player's screen privately shows: "You are the [Role]" with a one-line description and role icon.
- Mafia players additionally see their teammates listed.
- A tap-to-reveal-then-hide pattern works well on mobile (avoids someone glancing over a shoulder — tap and hold to reveal, release to hide).
- Host sees a readiness checklist (who has acknowledged their role).

**NIGHT**
- Host-controlled timer starts (e.g. 60–90s), synced via a shared end-timestamp (Section 6) so all clients count down in agreement regardless of small network lag.
- Mafia players (only) get a "choose a victim" screen listing alive players; simple majority-submit model recommended for v1.
- Doctor (if enabled) gets a "choose someone to protect" screen.
- Investigator (if enabled) gets a "choose someone to investigate" screen.
- Villagers see a simple "It's night, the town is asleep..." waiting screen with the countdown, and an "eliminated but spectating" version for dead players (Section 8).
- If the timer runs out with no action submitted from a role, apply that role's default (Section 8) rather than waiting indefinitely.
- All other players see nothing of these choices — host only ever relays *results*, never raw choices, to anyone but the actor themselves.

**NIGHT_RESOLVE** (host computes; briefly shown before day starts, e.g. 3-5s "dawn breaks" transition screen)
- If mafia victim == doctor's protected player → no death.
- Otherwise, victim is eliminated; their role becomes public.
- Investigator privately receives their one result (only they see it).
- Host broadcasts only the public outcome: who died (or "no one died") — never who did what, to preserve the mystery.

**DAY_DISCUSSION**
- Timer starts (e.g. 3–5 min). Everyone talks over the voice call; the app just shows a countdown and the list of alive/dead players (with dead players' revealed roles).
- Optional lightweight in-app text log for accusations (stretch goal, Section 11).
- Host has a "skip to vote" override button in case discussion wraps early.

**DAY_VOTE**
- Each alive player privately submits one vote (or "abstain") for who to eliminate.
- Live vote count (just a number, e.g. "4 of 7 votes cast") without revealing who voted for whom, unless public voting is turned on as a settings toggle.
- If the vote timer runs out before everyone has voted, missing votes are counted as abstain and the host tallies whatever was submitted — voting never blocks on stragglers.
- Host tallies; majority (or plurality — decide up front) is eliminated and their role is revealed publicly.
- Tie-handling rule should be decided up front (e.g. no elimination on a tie, or a 1-minute runoff between tied players).

**Win check** after every death:
- Mafia count == 0 → Villagers win.
- Mafia count ≥ remaining non-mafia (mafia reach parity/majority) → Mafia win.
- Otherwise loop back to NIGHT.

**GAME_OVER**
- Reveal the full role list to everyone, plus the salt for the commitment hash (if implemented) so anyone can verify fairness.
- Host gets a "New Game" button to reshuffle roles and restart with the same lobby (no need to re-join).

---

## 4. Networking Model (PeerJS specifics, with TURN fallback)

- Host calls `new Peer(customId, config)` — using a **custom, predictable ID** (derived from the room code, e.g. `mafia-ABC123-host`) rather than letting PeerJS assign a random one. This matters for reconnection (Section 7): if the host refreshes, a random ID would strand every already-connected player.
- Each player calls `new Peer()` (random ID is fine for players) then `peer.connect(hostId)` to open a DataConnection to the host.
- **TURN fallback config** — pass this into the `Peer` constructor's `config.iceServers` so that if direct P2P fails, it automatically relays instead:
  ```js
  const peer = new Peer(customId, {
    config: {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" }, // free public STUN, tries direct connection first
        {
          urls: "turn:relay.metered.ca:80",        // example free TURN relay
          username: "YOUR_FREE_USERNAME",
          credential: "YOUR_FREE_CREDENTIAL"
        }
      ]
    }
  });
  ```
  (Sign up for a free TURN credential set from a provider like metered.ca or Open Relay Project — a few minutes of setup, no cost at this scale. This does not violate "GitHub only" for hosting — you're not running or paying for a server, just using a public relay the same way STUN is public.)
- All game messages are small JSON objects, e.g.:
  ```json
  { "type": "NIGHT_ACTION", "action": "kill", "targetId": "player-7" }
  { "type": "STATE_UPDATE", "phase": "DAY_VOTE", "alive": [...], "phaseEndsAt": 1732999999999 }
  ```
- Host keeps a `Map<peerId, playerInfo>` and, on every state change, sends each connected player a **personalized** payload (never the shared "god view" object) — the host's own screen renders the full god view for host controls.
- **Timers are synced by absolute timestamp, not a countdown number.** Send `phaseEndsAt` (an absolute `Date.now() + duration`) once, and let each client compute its own local countdown from that. This avoids drift/jitter from relying on repeated "tick" messages over a potentially laggy connection, and self-corrects automatically if a phone tab was backgrounded and its JS timer got throttled (Section 8).

---

## 5. Screens / Pages

1. **Home / Join** — "Create a game" (becomes host) or "Join a game" (enter room code + name). Auto-fills room code if opened via a `?room=CODE` link.
2. **Lobby** — player list, host-only settings panel (mafia count, doctor toggle, investigator toggle, timers), validated "Start Game" button.
3. **Role Reveal** — private role card, tap-to-reveal pattern.
4. **Night Action** — role-specific action screen, waiting screen for villagers, spectator screen for eliminated players.
5. **Day / Discussion** — countdown timer, alive/dead list with revealed roles for the dead, optional chat.
6. **Voting** — list of alive players to vote against, live "X of Y votes cast" counter.
7. **Results / Elimination reveal** — who died and their role, with a short "dawn/night" transition animation.
8. **Game Over** — full reveal + fairness-hash verification (if implemented) + play again.
9. **How to Play (guide)** — static rules page: role descriptions, phase order, win conditions, tips for hosts.
10. **Reconnecting** — a brief transitional screen shown while a returning player's session is being restored (Section 7).

---

## 6. Real-Time Sync Details

- **Source of truth**: host's in-memory state object. Every mutation (join, role assignment, night action received, phase change) goes through one function that updates state, mirrors it to `localStorage`, and re-broadcasts personalized updates to all connected peers.
- **Message envelope**: every message should carry a `type`, a `payload`, and a monotonically increasing `seq` number per connection, so a client can detect and ignore duplicate/out-of-order messages if PeerJS redelivers anything.
- **Heartbeat / presence**: host pings each connection every ~5s; if a player misses 3 heartbeats, mark them "disconnected" in the UI (not removed — see reconnection) so the host and other players know someone dropped without ending the game.
- **Host handoff (optional, advanced)**: if the host disconnects entirely with no reconnection, the game effectively pauses. A "promote another player to host" feature is possible but nontrivial (that player would need to have been receiving full god-view state all along as a silent backup) — call this a stretch goal, not v1 scope.

---

## 7. Persistence & Reconnection (localStorage)

**Key point: `localStorage` is per-browser, not shared.** It can't act as a shared database between host and players — each person only has access to their own device's storage. What it's for here is letting **each individual person recover their own session** after a refresh, tab close, sleep, or lock screen — not for syncing game data between people (that's what the live PeerJS connection does).

### What each player's browser stores
```js
// localStorage key: "mafia_session"
{
  "roomCode": "ABC123",
  "playerId": "p_9f3a1c",      // random UUID generated once on first join, NOT the display name
  "displayName": "Alex",
  "isHost": false,
  "lastKnownPhase": "NIGHT",
  "lastKnownRole": "villager"   // just for instant UI paint on reload; host is always re-asked for the authoritative state right after reconnecting
}
```

### What the host's browser additionally stores
```js
// localStorage key: "mafia_host_state"
{
  "roomCode": "ABC123",
  "hostPeerId": "mafia-ABC123-host",   // the custom, predictable peer ID (see Section 4)
  "settings": { "mafiaCount": 2, "doctor": true, "investigator": true, ... },
  "players": [ { "playerId": "p_9f3a1c", "name": "Alex", "role": "villager", "alive": true }, ... ],
  "phase": "NIGHT",
  "phaseEndsAt": 1732999999999,
  "nightActionsThisRound": { ... },
  "history": [ ... ]   // optional log of past rounds, useful for the end-game reveal
}
```

### Reconnection flow
1. On page load, check `localStorage` for a `mafia_session` (or `mafia_host_state` if this browser was the host).
2. If found, skip the Home screen and immediately attempt to reconnect:
   - **Player**: `peer.connect(hostPeerId)` using the stored `roomCode` to reconstruct the expected host peer ID (`mafia-{roomCode}-host`), then send a `REJOIN` message with their stored `playerId`.
   - **Host**: re-create `new Peer(hostPeerId, config)` using the same custom ID as before, and restore `players`/`phase`/`settings` from `mafia_host_state` immediately (no need to wait for anyone) — the game state was never actually lost, it was just sitting in this browser's storage.
3. Host receives a `REJOIN` message, matches `playerId` against its known player list (not the display name, in case two people share a name), marks them "connected" again, and immediately sends back a fresh personalized `STATE_UPDATE` so their screen repaints to whatever phase the game is actually in.
4. If a player's `playerId` isn't found in the host's player list at all (e.g. host's browser data was cleared, or it's actually a new game with the same room code reused), show a friendly "This game session has ended, start a new one" screen rather than a silent failure.
5. Clear the relevant `localStorage` key on explicit "Leave Game" / "End Game" actions so stale sessions don't auto-rejoin a game that's intentionally over.

### Why the custom host Peer ID matters here
This is the one piece that makes host-side reconnection actually work: PeerJS's default behavior is to hand back a **new random ID** every time `new Peer()` is called with no argument. If the host's tab refreshes mid-game and gets a new random ID, every player's stored `hostPeerId` (implicitly reconstructed from the room code) would now point to a dead address. Using a deterministic ID derived from the room code (`mafia-{roomCode}-host`) means the host can always reconnect to *the same address*, and players can always find them again without needing to re-share a link.

---

## 8. Robustness & Edge Cases

These are the things that don't show up in a happy-path demo but will absolutely come up in a real game with real people on real phones.

### 8.1 Timeouts must always resolve, never stall
Without an explicit default, the whole game freezes waiting on one person who got distracted. Every timed action needs a defined fallback:
- **Mafia doesn't submit a kill in time** → default to "no kill this round" (simpler and safer than a random target, though a random-target mode is a reasonable house-rule toggle if your group prefers higher stakes).
- **Doctor doesn't submit a protect in time** → default to "no one protected" (or auto-protect themselves, if that's your house rule).
- **Investigator doesn't submit a check in time** → default to "no check performed"; they simply get no information that round.
- **A voter doesn't vote in time** → counted as an explicit abstain, not an error state.
- Implementation-wise: the host already knows `phaseEndsAt` (Section 4/6). When that timestamp passes, the host applies whichever actions *were* received and fills in the default for whichever weren't, then advances the phase — regardless of whether every expected message arrived. The phase transition should never be conditional on "everyone responded," only on "the timer elapsed or everyone responded, whichever comes first."

### 8.2 Backgrounded phone tabs
Your core use case — phone for the game, laptop for the call — means people will frequently switch away from the game tab. Mobile browsers throttle or suspend JS timers on backgrounded tabs, and can occasionally drop the WebRTC connection during extended backgrounding.
- Because timers already sync via the absolute `phaseEndsAt` timestamp rather than repeated ticks (Section 6), the countdown self-corrects the instant someone switches back — no special fix needed there.
- Add a noticeable cue for "it's your turn to act": a tab title change (e.g. prefixing the title with "🔪 Your turn!"), a browser Notification (with permission requested up front at Lobby join, not sprung on someone mid-game), and/or `navigator.vibrate()` on supporting devices — so people actually notice and switch back instead of quietly timing out every single round.
- On reconnect after a dropped background connection, route through the exact same reconnection flow as Section 7 (it's the same "browser lost its live connection, needs to resync" situation whether caused by a closed tab or a backgrounded one).

### 8.3 Settings validation guardrails
Prevent the host from starting a game that's structurally broken:
- Block "Start Game" (with an inline explanation, not just a disabled button) if mafia count is too high relative to player count — a reasonable default rule is mafia count must be less than roughly a third of total players, adjustable but not skippable.
- Warn (but don't hard-block, since it can still be fun) if total players is below ~5.
- If Doctor and/or Investigator are enabled, make sure there are enough non-mafia players left to fill those slots without eating into the minimum needed villager count — validate this the moment a toggle changes, not only at "Start Game."

### 8.4 Spectator mode for eliminated players (moved into v1 scope)
Rather than eliminated players just watching a static screen, they should keep receiving the same public state updates everyone gets (phase changes, who's alive, timers) and see a clearly-marked "You're eliminated — spectating" banner. This is cheap to add since the data's already flowing to them anyway, and meaningfully improves the experience for what can be a third or more of the group in later rounds. Eliminated players should not be able to submit night actions or votes even if their old UI is still technically reachable — the host should reject any action message from a `playerId` marked not-alive, as a server-side (host-side) guard, not just a client-side one.

---

## 9. Mobile Responsiveness

This isn't optional polish — assume the majority of players will be on a phone at some point in the game.

- **Viewport meta tag** in every HTML file: `<meta name="viewport" content="width=device-width, initial-scale=1.0">`.
- **Layout approach**: single-column, stacked layout by default (mobile-first CSS), then widen out into a slightly more spacious layout at larger breakpoints using `min-width` media queries — not the reverse. Roughly:
  - `< 480px` (phones): single column, full-width buttons, large tap targets.
  - `480–768px` (large phones / small tablets): same layout, slightly more padding.
  - `> 768px` (laptop/desktop): host settings panel and player list can sit side-by-side if useful, but every screen should still work fine at narrow widths since some players will genuinely be on a phone the whole game.
- **Tap targets**: minimum ~44×44px for any button or player-selection row (the standard accessibility guideline for thumbs), with enough spacing between adjacent targets to avoid mis-taps — this matters a lot for the night-action and voting screens where tapping the wrong player is a real (and funny, but frustrating) risk.
- **No hover-dependent interactions**: phones don't have hover, so nothing critical (like "hover to see role tooltip") should depend on it — use tap-and-hold or an explicit info icon instead.
- **Text size**: base font size no smaller than 16px on inputs specifically (smaller than that causes iOS Safari to auto-zoom into the field, which is a jarring experience mid-game).
- **Orientation**: design for portrait as the primary case (that's how people hold phones during a call), but don't break if someone rotates to landscape.
- **Timers/countdowns**: keep them visually prominent (large, high-contrast) since people will be glancing at their phone while mostly looking at the video call on a separate device.
- **Test devices**: at minimum, test in actual mobile Safari (iOS) and Chrome (Android) — not just a resized desktop browser window — since real mobile browsers have quirks (viewport units, input zoom, PeerJS/WebRTC support differences, background-tab throttling per Section 8.2) that don't show up in desktop dev tools' device emulation alone.

---

## 10. Build Phases & Tasks

### Phase 1 — Connectivity Proof of Concept
- [ ] Set up repo, enable GitHub Pages.
- [ ] Add PeerJS via CDN script tag.
- [ ] Implement the custom host Peer ID pattern (Section 4) from the start, not as a later refactor.
- [ ] Wire up the TURN fallback config (Section 4) from the start.
- [ ] Build a minimal "host creates room ID, one player connects and they exchange a text message" test.
- [ ] Test this across genuinely different networks (e.g. your home WiFi and a phone on mobile data), and from a real phone browser — not just two tabs on the same laptop — before building anything else.

### Phase 2 — Lobby & Room Join
- [ ] Home screen (mobile-responsive from the start): Create Game / Join Game with room code input, auto-filled from `?room=` URL param if present.
- [ ] Host screen shows live-updating player list as people connect.
- [ ] Players see a "waiting for host to start" screen.
- [ ] Implement `localStorage` session-writing on join (Section 7) even before reconnection logic exists, so the data is there when Phase 7 builds on top of it.
- [ ] Handle disconnect gracefully — mark players "disconnected," don't remove them or crash the room.

### Phase 3 — Host Settings Panel
- [ ] Mafia count selector, with live validation against current player count (Section 8.3).
- [ ] Doctor on/off toggle, Investigator on/off toggle, each re-validating role-count feasibility on change.
- [ ] Night/day/vote timer length inputs.
- [ ] "Start Game" disabled with an inline explanation (not a silent disable) until settings are valid.

### Phase 4 — Role Assignment Engine
- [ ] Fisher–Yates shuffle + assign logic (Section 2).
- [ ] Role metadata config (`roles.js`) so new roles are easy to add later, including each role's `timeoutDefault`.
- [ ] Send personalized role payloads to each connected peer (never the full map).
- [ ] Optional: generate and broadcast the commitment hash (Section 2) right after assignment, before reveal.
- [ ] Role Reveal screen per player, tap-to-reveal pattern for privacy.

### Phase 5 — Night Phase
- [ ] Timer implementation using the absolute `phaseEndsAt` timestamp pattern (Section 6), not repeated tick messages.
- [ ] Mafia kill-selection UI (only rendered for mafia peers).
- [ ] Doctor protect UI (only for doctor).
- [ ] Investigator check UI + private result delivery.
- [ ] Villager waiting screen, and spectator waiting screen for eliminated players (Section 8.4).
- [ ] Timeout defaults implemented per role (Section 8.1) — phase always advances once the timer elapses, regardless of who did or didn't act.
- [ ] Night resolution logic (kill vs. save vs. no-op) on host, with host-side rejection of any action from a not-alive `playerId`.

### Phase 6 — Day Phase & Voting
- [ ] Discussion timer + alive/dead list display (with revealed roles for the dead).
- [ ] Voting UI, vote tally logic, tie-break rule, missing votes counted as abstain on timeout (Section 8.1).
- [ ] Elimination reveal with transition screen.
- [ ] Win-condition check after every elimination.

### Phase 7 — Persistence & Reconnection
- [ ] Implement full `mafia_session` / `mafia_host_state` localStorage schema (Section 7).
- [ ] On page load, check for existing session and attempt silent reconnect before showing the Home screen.
- [ ] `REJOIN` message handling on host: match by `playerId`, restore connection, resend current state.
- [ ] "Session ended" friendly screen for stale/invalid sessions.
- [ ] Notification/tab-title/vibration cue for "your turn to act" to counter backgrounded-tab drift (Section 8.2).
- [ ] Test explicitly: close tab mid-night-phase, reopen, confirm correct screen and role are restored; also test backgrounding a phone tab for a couple minutes mid-round.

### Phase 8 — Guide Page & Polish
- [ ] `guide.html`: role descriptions, phase flow, host tips.
- [ ] Full responsive styling pass on every screen, tested on real phones (Section 9).
- [ ] Sound/visual cue for phase transitions (optional).
- [ ] "New Game" / rematch flow that keeps the same lobby without re-joining.
- [ ] Fairness-hash verification UI at Game Over, if implemented (Section 2).

### Phase 9 — Playtest
- [ ] Run a full game with 5+ people, ideally from mixed networks (some on office WiFi, some on home WiFi, some on mobile data) and mixed devices (at least one phone).
- [ ] Deliberately kill a tab mid-game on one device to confirm reconnection actually works, not just in theory.
- [ ] Deliberately let a night-action timer expire without acting, on purpose, to confirm the game still advances correctly.
- [ ] Deliberately background a phone tab for a couple minutes mid-round to confirm the "your turn" notification and timer resync both work.
- [ ] Fix any desync bugs (host state and player-perceived state disagreeing).
- [ ] Confirm mafia/doctor/investigator info never leaks to the wrong player — open devtools network/console on a villager's tab mid-game as a manual security check.

---

## 11. Stretch Goals (not required for v1)
- In-app text chat log alongside the voice call.
- Cross-device persisted stats across games (would need actual shared storage — breaks "GitHub only," this is where Firebase would come back into consideration later).
- More roles (Jester, Mayor, Vigilante, etc.) — the state machine and `roles.js` config pattern above are built to make this mostly additive.
- Host-handoff if the original host disconnects permanently mid-game.
- Public vs. private voting as a settings toggle.
- Random-target (rather than no-op) mafia default on timeout, as an optional house-rule toggle.

---

## 12. Deployment Checklist
1. `git init`, push to a new GitHub repo.
2. Repo Settings → Pages → Source: `main` branch, root (or `/docs` if you prefer).
3. Site will be live at `https://<username>.github.io/<repo-name>/`.
4. Share that link + tell people to append `?room=CODE` when joining, or just paste the code into the Join screen.
5. No further hosting steps — every future update is just `git push`.