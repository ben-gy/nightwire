# Game Plan: Nightwire

## Overview
- **Name:** Nightwire
- **Repo name:** nightwire
- **Tagline:** Some of the numbers are lying — find the Ghosts at the table before the lights go out.
- **Genre (directory category):** party

## Idea Source
IDEAS.md: *"Deduction Table — social hidden-role deduction game (Werewolf/Mafia-style) for 4–10 players in a P2P room with a rotating narrator."*

**Deviations from the brief (deliberate, noted for review):**
1. **The narrator is automated, not rotating.** A human narrator would make the game unplayable solo (violating principle #1) and adds a role with nothing to do. The engine narrates every beat.
2. **Deduction is structured, not free-form chat.** Chat-based Mafia is only playable with a full table of humans and cannot be played solo against bots, nor tested. Nightwire replaces "argue about vibes" with a *legible information mechanic* (below) that is deducible, testable, and bot-playable — while keeping the hidden-role social core (lying, voting, betrayal).

## Core Loop
Seats sit in a ring. Each seat is secretly **Crew** or **Ghost**.

Every round:
1. **Night — probe.** Everyone picks another seat to probe. Your reading = **how many Ghosts sit in that 3-seat window** (the target and their two living neighbours). It is always a truthful 0–3.
2. **Night — cut.** The Ghosts pick one seat to *darken*: that player gets **no reading** this dawn. The blackout counter ticks up by one every night regardless.
3. **Dawn — claims.** Every reading is published on the ledger. **Crew readings publish automatically and truthfully. Ghosts choose what number to publish.** That asymmetry is the whole game: the ledger is a Minesweeper board where some of the numbers are lying.
4. **Day — vote.** Everyone votes to eject a seat. Majority ejects; a tie ejects nobody (and wastes a round). The ejected seat's role is revealed.

**Crew win** by ejecting every Ghost. **Ghosts win** at blackout (rounds run out) or when Ghosts ≥ Crew.

The tension: each claim is a constraint. Truthful claims must all fit one consistent world; a Ghost's fabricated number is a crack in that world — but only if you can find it before the lights go out. Nobody is eliminated at night, so a 4-player game never collapses to two people watching.

**Why it's fun in 5 seconds solo:** you get one number, someone else's number contradicts it, and you already have a suspect.

## Controls
- **Desktop:** click/tap seats to probe, claim, and vote. Full keyboard: Tab/arrow to move focus around the ring, Enter/Space to select.
- **Mobile:** tap targets on the seat ring (≥44px), large claim/vote buttons. No virtual D-pad needed (turn-based DOM game — `input.ts` not required).

## Multiplayer
- **Mode:** live P2P (4–10 humans) **and** solo vs bots (the default; a full table of bots, so the game is complete with zero peers).
- **No bots in P2P rooms** (so the minimum really is 4 humans). Bot roles live only in the host's memory, and a promoted host cannot recover them — a peer can only ever attest for *itself*. Deriving bot roles from the shared seed would let every player compute which bots are Ghosts. Rather than break the host-transfer contract or the secrecy model, bots stay solo-only.
- **Topology:** host-authoritative star. The host owns the deal, resolves votes, and runs the clock.
- **Channels (≤12 bytes):** `snap` (host → all: public state), `priv` (host → one peer: your role + your reading), `act` (peer → host: probe / claim / cut / vote), `rq` (new host → all: role re-attest request), `rl` (peer → new host: my own role).
- **Room entry:** `createRoomEntry` — Create a room **or type a code**. Deep `?room=` links skip the entry screen once, then subsequent "Play with friends" shows it again.
- **Late joiner:** the table is dealt at start; a peer arriving mid-game sees the public ledger but holds no seat, and is seated on the next game.
- **Peer leave:** the seat is **revealed and removed from the game** — like an ejection, but no vote is spent and the blackout clock doesn't tick. This is deliberate: a secret role that no one can ever attest to would corrupt the win condition *and* leave a promoted host unable to rebuild the table. Revealing is honest, keeps the Ghost count sound, and stops the round waiting on someone who closed their laptop. All phase deadlines are host `setInterval` timers, not rAF.
- **Host leaves — the takeover:** `net.ts` re-elects the smallest remaining peer id and fires `onHostChange` → `Session.setHost(true)`. The promoted peer:
  1. adopts its last received snapshot as canonical,
  2. broadcasts `rq`; **every peer replies `rl` with its own role** (each peer only ever knows its own), so the new host reassembles the role table without any peer ever having held another's secret,
  3. resumes host-only `setInterval` timers and re-broadcasts, so the game keeps advancing and **can still reach game-over**.
  Peers that don't reply before a 4s timeout are revealed and dropped; any Ghosts left unaccounted for are inferred onto the silent seats so the Ghost count stays honest (defaulting them to Crew would erase a Ghost and hand the Crew a win they never earned).
  **The round's secret state can't survive the old host** (probes and readings were only ever in its memory), so a night/dawn in flight rewinds to the top of that same round — un-ticking the cut if one had landed, so the blackout clock stays honest. A vote in flight survives intact, because the ledger and the votes are already public.
  The UI flashes "the host left — you're the host now. You hold the deal".

**Secrecy trust model (disclosed in About + lobby):** the host's browser deals the roles, so a host who opens devtools could see them — exactly like a friend who deals the cards face-down. No non-host ever holds another player's role. Making this cryptographically host-proof needs a mental-poker commit/reveal shuffle; that's a **non-goal** this run and is stated plainly to players rather than hidden.

## Juice Plan
- **Sound (`sound.ts`, extended patches):** `probe` (soft sonar ping), `cut` (wire snap), `claim` (paper blip), `vote` (thunk), `eject` (airlock whoosh), `reveal-ghost` (dissonant sting), `reveal-crew` (sad tone), `win`, `lose`, `tick` (last 5s of the vote clock).
- **Screen shake** on ejection reveal and on each wire cut (skipped under `prefers-reduced-motion`).
- **Particles:** ember burst from an ejected seat; a travelling spark along the wire when a console is cut.
- **Tweens:** seats orbit into place on deal; the ledger numbers flip-in; the blackout meter drains with eased motion; the ring dims one notch per cut.
- **Feedback:** suspicion glow on seats you've voted for, a live vote-tally ring, a "contradiction!" flash when the ledger becomes unsatisfiable, night→dawn colour wash.

## Style Direction
**Vibe:** neon-noir control room at 3am.
**Palette:** deep ink `#0b0e17` ground, `#f2f4ff` text, teal `#3fd0c9` (Crew/safe), amber `#ffb347` (warning/blackout), violet `#a882ff` (Ghost/night), rose `#ff6b8a` (ejection). Teal/amber/violet/rose are distinguishable under deuteranopia and protanopia (they differ in lightness as well as hue), and every role is **always paired with a text label + icon**, never colour alone.
**Theme:** dark (it is literally a game about night).
**Reference feel:** the quiet dread of a late-night radio drama; the crisp legibility of a good Minesweeper.

## Technical Architecture
- **Stack:** Vanilla TypeScript + Vite. No React — the UI is a handful of screens over one state object.
- **Render:** **DOM/CSS** for the seat ring, ledger, and voting (crisp text, big tap targets, accessible by default, trivial responsive layout), with a small `<canvas>` **behind** the ring purely for particles/wire sparks.
- **Engine modules copied from patterns/:** `net.ts`, `lobby.ts` (both from the evolved hexbloom copies — they carry `createRoomEntry`/`normalizeRoomCode` and the trystero `makeAction` cast), `rng.ts`, `sound.ts`, `storage.ts`. Not `input.ts` (no d-pad) and not `loop.ts` (no fixed-timestep sim; timers + CSS transitions).
- **Core purity:** `src/game.ts` is a pure reducer — `(state, action) → state`, no DOM, no clock, no `Math.random` (all randomness from the seeded `rng.ts`). This is what makes the solver, the determinism tests, and the host-takeover test possible without a network.
- **Bots (`src/bot.ts`):** a real solver, not a fake. Enumerate every ghost-assignment consistent with (a) published claims under "Crew claims are true", (b) revealed roles of ejected seats, (c) the fixed ghost count, (d) the bot's own role. With ≤10 seats and ≤3 ghosts that's ≤120 worlds — trivial to enumerate exactly. `suspicion[p]` = fraction of consistent worlds where p is a Ghost. Crew bots vote the most suspicious; Ghost bots fabricate the claim that maximises worlds in which they look like Crew, and vote to eject credible Crew.
- **Persistence:** `storage.ts` — mute, player name, how-to-play seen, and a solo record (wins as Crew / wins as Ghost).

## Non-Goals
- Cryptographic (host-proof) role secrecy — disclosed instead. See trust model above.
- Free-form text chat. (Voice/Discord alongside is the intended social layer; a text box invites abuse and needs moderation we cannot do with no backend.)
- Night eliminations — cutting a console replaces them, so nobody sits out watching.
- More than 10 seats; ranked/matchmaking; accounts; persistent cross-device stats.

## How To Play (player-facing copy)
**You're at a table. Some of you are Ghosts.**
Each night you probe a seat and learn **how many Ghosts sit in that 3-seat window** — the seat you picked and its two neighbours.
**Crew readings are published automatically and truthfully. Ghosts choose what number to publish.** So every claim is a clue, and some of the clues are lies.
Each day, vote to eject one seat. Crew win by ejecting every Ghost — before the wire cuts run out and the lights go out for good.
