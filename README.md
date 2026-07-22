# Nightwire

**Some of the numbers are lying — find the Ghosts at the table before the lights go out.**

🎮 Play: https://nightwire.benrichardson.dev

## What it is

Nightwire is a hidden-role deduction game where the evidence is **numbers instead of arguments**. Every night you probe a seat and learn exactly how many Ghosts sit in that **3-seat window** — the seat you picked and its two neighbours. Every reading is then published on the ledger for the whole table to see.

Here's the twist the whole game turns on: **Crew readings publish automatically and truthfully. Ghosts choose what number to publish.** So the ledger is a Minesweeper board where some of the numbers are lying, and your job is to find the ones that can't be squared with the rest. Each day the table votes to eject a seat, and the ejected player's role is revealed. Crew win by ejecting every Ghost; the Ghosts win when the wire cuts run out and the lights go out for good — one wire is cut every single night, so the clock never stops.

Because the evidence is structured rather than conversational, it's genuinely playable **alone**. The solo bots aren't faking it: they enumerate every possible assignment of Ghosts consistent with the published claims (at most 120 of them) and reason from what survives. Ghost bots run the same solver from the table's point of view and pick the lie that keeps them looking innocent. Play with 4–10 friends over a shared link when you want the real thing — nobody is eliminated at night, so a small table never collapses into two people watching.

## How to play

- **Night** — tap a seat to probe it. You learn how many Ghosts sit in that 3-seat window. If you're a Ghost, you also pick one console to *darken*: that player gets no reading at dawn.
- **Dawn** — every reading is published. Crew numbers post automatically and truthfully; as a Ghost you choose yours.
- **Day** — vote to eject a seat. Majority ejects; a tie ejects nobody and wastes the round.
- **Goal** — Crew: eject every Ghost. Ghosts: run out the blackout clock, or reach parity with the Crew.

**Controls:** tap or click seats on both desktop and mobile — every seat is a real button, so full keyboard navigation (Tab / Enter) works too. Tap any seat to highlight the window it reads.

## Multiplayer

**Live peer-to-peer, 4–10 players, host-authoritative.** Create a room and share the link, or read the 4-character code aloud and have friends type it in. There is no game server: players connect directly to each other over WebRTC, and a free public signaling relay only brokers the initial handshake. No game data is stored on any server.

If the host leaves, the game does **not** end. The remaining peers re-elect a host, and the new host rebuilds the table by asking each survivor to attest their own role — no peer ever holds anyone else's secret. Play continues and can still reach a real ending.

**Who deals the cards:** the host's browser holds the deal, much like the friend dealing cards face-down could peek at the deck. Making this host-proof would require a full mental-poker protocol; we'd rather say so plainly than pretend otherwise. Play with people you'd hand a deck of cards.

Bots are solo-only — a promoted host can't recover a bot's secret role, and deriving bot roles from the shared seed would let everyone compute them.

## Tech

- Vite 6 + vanilla TypeScript
- DOM rendering for the seat ring and ledger (crisp text, big tap targets, accessible by default), with a small canvas behind it for particles
- Shared engine: Trystero P2P netcode, drop-in lobby, seeded deterministic RNG, procedural audio
- A pure `game.ts` reducer — no DOM, no clock, no `Math.random` — which is what makes the solver, the determinism tests and the host-takeover test possible without a network
- Vitest: 93 tests covering the rules, the solver, P2P-sync determinism, turn-0 fairness, room-code normalisation and host transfer
- GitHub Pages hosting

Respects `prefers-reduced-motion`; roles are always labelled with text and icons, never colour alone. No cookies, no fingerprinting, no third-party fonts. Anonymous, cookie-less page-view counts via Cloudflare Web Analytics.

## Local dev

```bash
npm install
npm run dev
npm test
npm run build
npm run preview
```

## license

[GNU Affero General Public License v3.0 or later](./LICENSE), with an attribution
requirement added under section 7(b) — see
[ADDITIONAL-TERMS.md](./ADDITIONAL-TERMS.md).

In short: you may run, modify, redistribute and even sell this, but if you
distribute it — or run a modified version where other people can reach it — you
have to publish your source under the same licence and keep the attribution. A
separate commercial licence without those obligations is available on request:
<hi@ben.gy>.

Third-party components keep their own licences — see
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).
