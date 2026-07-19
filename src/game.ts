/**
 * game.ts — Nightwire's pure rules core.
 *
 * No DOM, no timers, no Math.random. Every random outcome comes from the shared
 * seed via rng.ts, so the host and every peer (and every test) agree exactly.
 * All exported mutators return a NEW state; the input is never touched.
 *
 * The mechanic in one line: each night you probe a seat and learn how many
 * Ghosts sit in that 3-seat window. Crew readings publish truthfully and
 * automatically; Ghosts choose what number to publish.
 */

import { makeRng, shuffle, type Rng } from '@ben-gy/game-engine/rng';

export type Role = 'crew' | 'ghost';
export type Phase = 'night' | 'dawn' | 'vote' | 'resolve' | 'over';
export type Winner = 'crew' | 'ghosts' | null;

export interface Seat {
  id: string;
  name: string;
  role: Role;
  /** False once ejected by vote. */
  alive: boolean;
  /** True when the peer disconnected. Still seated and still ejectable — their
   *  role still counts toward the win condition — but they auto-abstain. */
  gone: boolean;
  bot: boolean;
}

export interface LedgerRow {
  round: number;
  by: string;
  target: string;
  /** The 3-seat window as it stood when the probe was taken. Public info. */
  window: string[];
  /** What was published. null when the console was cut — no reading exists. */
  claim: number | null;
  /**
   * What the console actually read. SECRET: publicView strips this until the
   * game is over, because a Ghost's lie is only a lie once you can compare the
   * two — leaking it mid-game would hand the Crew every role for free.
   *
   * null when the console was dark (no reading existed), and null for rounds a
   * promoted host inherited, since the truth died with the old host.
   */
  truth: number | null;
  dark: boolean;
}

export interface Ejection {
  id: string;
  role: Role;
  round: number;
}

export interface GameState {
  seed: number;
  seats: Seat[];
  round: number;
  phase: Phase;
  /** Wire cuts made so far. One per night, always. */
  cuts: number;
  /** Ghosts win when cuts reaches this. */
  blackoutAt: number;
  ghostCount: number;
  /** seatId -> the seat they probed this round. */
  probes: Record<string, string>;
  /** seatId -> their TRUTHFUL reading this round. Host-only knowledge. */
  readings: Record<string, number>;
  /** seatId -> the number published this round. */
  claims: Record<string, number>;
  /** ghostId -> the seat they want darkened. */
  cutVotes: Record<string, string>;
  /** The seat whose console was cut this round — they get no reading. */
  darkened: string | null;
  /** voterId -> the seat they voted to eject. */
  votes: Record<string, string>;
  ledger: LedgerRow[];
  ejections: Ejection[];
  lastEjected: Ejection | null;
  winner: Winner;
  log: string[];
}

export const MIN_SEATS = 4;
export const MAX_SEATS = 10;

/** Ghost count scales with the table so a 4-seat game isn't a coin flip. */
export function ghostCountFor(seats: number): number {
  if (seats <= 5) return 1;
  if (seats <= 8) return 2;
  return 3;
}

/** Rounds the Crew get before the lights go out. One cut lands every night. */
export function blackoutFor(ghosts: number): number {
  return ghosts + 2;
}

export interface SeatSpec {
  id: string;
  name: string;
  bot: boolean;
}

/**
 * The two numbers a mode is allowed to move: how many liars are at the table,
 * and how many nights the Crew get before the lights go out. Everything else
 * about a mode is clock, which lives in session.ts.
 *
 * Passed in rather than derived here because the HOST's mode decides the table
 * and it travels frozen with the round start — a peer deriving these from its
 * own picker would be playing a different game at the same table. modes.ts owns
 * the mapping (and the clamp that keeps the deal winnable).
 */
export interface TableRules {
  ghosts: number;
  blackoutAt: number;
}

/**
 * Deal a table. Deterministic in `seed`: two peers with the same seed produce
 * an identical seating order AND an identical role assignment.
 *
 * `rules` defaults to the standard scaling, so a caller with no modes (or a
 * test) gets the same table it always did.
 */
export function deal(seed: number, players: readonly SeatSpec[], rules?: TableRules): GameState {
  if (players.length < MIN_SEATS || players.length > MAX_SEATS) {
    throw new Error(`Nightwire needs ${MIN_SEATS}–${MAX_SEATS} seats, got ${players.length}`);
  }
  const rng = makeRng(seed);
  const ghostCount = rules?.ghosts ?? ghostCountFor(players.length);
  const blackoutAt = rules?.blackoutAt ?? blackoutFor(ghostCount);

  // Seat everyone in a shuffled ring, then choose the ghosts from a SECOND
  // independent shuffle — so ghost identity is uncorrelated with seat position.
  const seated = shuffle(rng, players);
  const ghostIdx = new Set(
    shuffle(
      rng,
      seated.map((_, i) => i),
    ).slice(0, ghostCount),
  );

  const seats: Seat[] = seated.map((p, i) => ({
    id: p.id,
    name: p.name,
    role: ghostIdx.has(i) ? 'ghost' : 'crew',
    alive: true,
    gone: false,
    bot: p.bot,
  }));

  return {
    seed,
    seats,
    round: 1,
    phase: 'night',
    cuts: 0,
    blackoutAt,
    ghostCount,
    probes: {},
    readings: {},
    claims: {},
    cutVotes: {},
    darkened: null,
    votes: {},
    ledger: [],
    ejections: [],
    lastEjected: null,
    winner: null,
    log: [`Night 1. ${ghostCount} Ghost${ghostCount === 1 ? '' : 's'} at a table of ${seats.length}.`],
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function seatOf(state: GameState, id: string): Seat | undefined {
  return state.seats.find((s) => s.id === id);
}

/** Seats still in the game, in seating order. */
export function livingRing(state: GameState): string[] {
  return state.seats.filter((s) => s.alive).map((s) => s.id);
}

/** Seats that can still act (living and connected). */
export function activeSeats(state: GameState): string[] {
  return state.seats.filter((s) => s.alive && !s.gone).map((s) => s.id);
}

/**
 * The 3-seat window a probe reads: the target plus their two living neighbours.
 * Shrinks gracefully if fewer than 3 seats remain.
 *
 * Kept ring-based (rather than state-based) so the host, a client holding only
 * the public view, and the bots all derive windows through the exact same code.
 */
export function windowInRing(ring: readonly string[], targetId: string): string[] {
  const i = ring.indexOf(targetId);
  if (i < 0) return [];
  if (ring.length <= 3) return ring.slice();
  const prev = ring[(i - 1 + ring.length) % ring.length];
  const next = ring[(i + 1) % ring.length];
  return [prev, targetId, next];
}

export function windowOf(state: GameState, targetId: string): string[] {
  return windowInRing(livingRing(state), targetId);
}

/** How many Ghosts actually sit in that window. Always the truth. */
export function trueReading(state: GameState, targetId: string): number {
  const win = windowOf(state, targetId);
  return win.filter((id) => seatOf(state, id)?.role === 'ghost').length;
}

export function aliveGhosts(state: GameState): Seat[] {
  return state.seats.filter((s) => s.alive && s.role === 'ghost');
}

export function aliveCrew(state: GameState): Seat[] {
  return state.seats.filter((s) => s.alive && s.role === 'crew');
}

/** Living Ghosts who can still act — i.e. who can still cut a wire. */
function actingGhosts(state: GameState): Seat[] {
  return state.seats.filter((s) => s.alive && !s.gone && s.role === 'ghost');
}

/** True once every connected living seat has locked in a probe (and a cut). */
export function nightComplete(state: GameState): boolean {
  const actors = activeSeats(state);
  if (!actors.every((id) => state.probes[id])) return false;
  const ghosts = actingGhosts(state);
  return ghosts.length === 0 || ghosts.every((g) => state.cutVotes[g.id]);
}

/** True once every Ghost who holds a reading has published a number. */
export function claimsComplete(state: GameState): boolean {
  return state.seats
    .filter((s) => s.alive && !s.gone && s.role === 'ghost')
    .every((g) => state.readings[g.id] === undefined || state.claims[g.id] !== undefined);
}

export function votesComplete(state: GameState): boolean {
  return activeSeats(state).every((id) => state.votes[id] !== undefined);
}

// ---------------------------------------------------------------------------
// Player actions — each validates and returns a new state (or the same one).
// ---------------------------------------------------------------------------

export function submitProbe(state: GameState, actorId: string, targetId: string): GameState {
  if (state.phase !== 'night') return state;
  const actor = seatOf(state, actorId);
  const target = seatOf(state, targetId);
  if (!actor?.alive || actor.gone) return state;
  if (!target?.alive) return state;
  if (actorId === targetId) return state; // you cannot probe your own seat
  return { ...state, probes: { ...state.probes, [actorId]: targetId } };
}

export function submitCut(state: GameState, ghostId: string, targetId: string): GameState {
  if (state.phase !== 'night') return state;
  const ghost = seatOf(state, ghostId);
  const target = seatOf(state, targetId);
  if (!ghost?.alive || ghost.gone || ghost.role !== 'ghost') return state;
  if (!target?.alive) return state;
  return { ...state, cutVotes: { ...state.cutVotes, [ghostId]: targetId } };
}

/**
 * The largest number a reading could honestly be: you can't see more Ghosts in
 * one window than exist at the whole table. Claiming beyond this wouldn't be a
 * lie so much as a nonsense the ledger could never explain, so it isn't offered
 * and isn't accepted.
 */
export function maxClaim(state: GameState, targetId: string): number {
  return Math.min(windowOf(state, targetId).length, state.ghostCount);
}

export function submitClaim(state: GameState, ghostId: string, value: number): GameState {
  if (state.phase !== 'dawn') return state;
  const ghost = seatOf(state, ghostId);
  if (!ghost?.alive || ghost.gone || ghost.role !== 'ghost') return state;
  if (state.readings[ghostId] === undefined) return state; // darkened — nothing to publish
  const max = maxClaim(state, state.probes[ghostId]);
  if (!Number.isInteger(value) || value < 0 || value > max) return state;
  return { ...state, claims: { ...state.claims, [ghostId]: value } };
}

export function submitVote(state: GameState, voterId: string, targetId: string): GameState {
  if (state.phase !== 'vote') return state;
  const voter = seatOf(state, voterId);
  const target = seatOf(state, targetId);
  if (!voter?.alive || voter.gone) return state;
  if (!target?.alive) return state;
  return { ...state, votes: { ...state.votes, [voterId]: targetId } };
}

/** Mark a peer as disconnected. They stay seated; they just stop acting. */
export function markGone(state: GameState, id: string, gone = true): GameState {
  return { ...state, seats: state.seats.map((s) => (s.id === id ? { ...s, gone } : s)) };
}

// ---------------------------------------------------------------------------
// Phase resolution — host-only (or solo). Deterministic given the seed.
// ---------------------------------------------------------------------------

/** Per-round RNG stream, so a resolution never depends on call order. */
function roundRng(state: GameState, salt: string): Rng {
  return makeRng(`${state.seed}:${state.round}:${salt}`);
}

/** Deterministic argmax over a tally — ties broken by the seeded RNG. */
function topOf(tally: Map<string, number>, rng: Rng): { id: string | null; tied: boolean } {
  let best = -1;
  for (const n of tally.values()) if (n > best) best = n;
  if (best <= 0) return { id: null, tied: false };
  const top = [...tally.entries()].filter(([, n]) => n === best).map(([id]) => id).sort();
  if (top.length === 1) return { id: top[0], tied: false };
  return { id: top[Math.floor(rng() * top.length)], tied: true };
}

/**
 * Night → dawn. Applies the cut, takes every reading, and auto-publishes the
 * Crew's readings truthfully. Ghost claims stay pending (they get to choose).
 */
export function resolveNight(state: GameState): GameState {
  if (state.phase !== 'night') return state;

  // 1. The cut. Ghosts vote; a tie is broken deterministically.
  const tally = new Map<string, number>();
  for (const g of actingGhosts(state)) {
    const t = state.cutVotes[g.id];
    if (t) tally.set(t, (tally.get(t) ?? 0) + 1);
  }
  const { id: darkened } = topOf(tally, roundRng(state, 'cut'));

  // 2. Every wire cut ticks the blackout clock, whoever it lands on.
  const cuts = state.cuts + 1;

  // 3. Readings — truthful, for everyone who probed and isn't darkened.
  const readings: Record<string, number> = {};
  const claims: Record<string, number> = {};
  for (const id of activeSeats(state)) {
    const target = state.probes[id];
    if (!target) continue;
    if (id === darkened) continue; // console is dark; no reading exists
    const r = trueReading(state, target);
    readings[id] = r;
    // Crew readings publish automatically and truthfully. That is the anchor
    // the whole deduction rests on — only Ghosts get to choose their number.
    if (seatOf(state, id)!.role === 'crew') claims[id] = r;
  }

  const log = [...state.log];
  if (darkened) {
    log.push(`A wire is cut. ${seatOf(state, darkened)!.name}'s console goes dark.`);
  } else {
    log.push('A wire is cut somewhere in the dark.');
  }

  return { ...state, phase: 'dawn', cuts, darkened, readings, claims, log };
}

/**
 * Dawn → vote. Any Ghost who didn't choose a number publishes the truth (an
 * idle/disconnected Ghost shouldn't stall the table), then the ledger is written.
 */
export function resolveDawn(state: GameState): GameState {
  if (state.phase !== 'dawn') return state;

  const claims = { ...state.claims };
  for (const s of state.seats) {
    if (!s.alive) continue;
    if (state.readings[s.id] === undefined) continue;
    if (claims[s.id] === undefined) claims[s.id] = state.readings[s.id];
  }

  const rows: LedgerRow[] = [];
  for (const id of activeSeats(state)) {
    const target = state.probes[id];
    if (!target) continue;
    const dark = id === state.darkened;
    rows.push({
      round: state.round,
      by: id,
      target,
      window: windowOf(state, target),
      claim: dark ? null : (claims[id] ?? null),
      truth: dark ? null : (state.readings[id] ?? null),
      dark,
    });
  }

  return {
    ...state,
    phase: 'vote',
    claims,
    ledger: [...state.ledger, ...rows],
    log: [...state.log, `Dawn ${state.round}. The ledger is posted — vote to eject a seat.`],
  };
}

/**
 * Vote → resolve. Plurality ejects; a tie ejects nobody and wastes the round.
 * Then the win conditions are checked.
 */
export function resolveVote(state: GameState): GameState {
  if (state.phase !== 'vote') return state;

  const tally = new Map<string, number>();
  for (const id of activeSeats(state)) {
    const t = state.votes[id];
    if (t) tally.set(t, (tally.get(t) ?? 0) + 1);
  }
  const { id: ejectId, tied } = topOf(tally, roundRng(state, 'vote'));

  let seats = state.seats;
  let lastEjected: Ejection | null = null;
  const ejections = [...state.ejections];
  const log = [...state.log];

  // A tie means the table couldn't agree — nobody goes, and the clock still ran.
  if (ejectId && !tied) {
    const s = seatOf(state, ejectId)!;
    seats = state.seats.map((x) => (x.id === ejectId ? { ...x, alive: false } : x));
    lastEjected = { id: ejectId, role: s.role, round: state.round };
    ejections.push(lastEjected);
    log.push(`${s.name} is ejected — they were ${s.role === 'ghost' ? 'a GHOST' : 'CREW'}.`);
  } else {
    log.push('The table deadlocks. Nobody is ejected.');
  }

  const next: GameState = { ...state, seats, ejections, lastEjected, phase: 'resolve', log };
  return checkWin(next);
}

/** Apply the three win conditions, in priority order. */
export function checkWin(state: GameState): GameState {
  const ghosts = aliveGhosts(state).length;
  const crew = aliveCrew(state).length;
  const log = [...state.log];

  // Crew win takes priority: ejecting the last Ghost saves the station even on
  // the very night the lights were due to go out.
  if (ghosts === 0) {
    log.push('Every Ghost is off the table. The Crew hold the station.');
    return { ...state, phase: 'over', winner: 'crew', log };
  }
  if (state.cuts >= state.blackoutAt) {
    log.push('The last wire parts. Blackout — the Ghosts take the station.');
    return { ...state, phase: 'over', winner: 'ghosts', log };
  }
  if (ghosts >= crew) {
    log.push('The Ghosts outnumber the Crew. There is no one left to stop them.');
    return { ...state, phase: 'over', winner: 'ghosts', log };
  }
  return { ...state, log };
}

/** resolve → the next night. Clears the per-round scratch state. */
export function nextRound(state: GameState): GameState {
  if (state.phase !== 'resolve') return state;
  const round = state.round + 1;
  return {
    ...state,
    round,
    phase: 'night',
    probes: {},
    readings: {},
    claims: {},
    cutVotes: {},
    darkened: null,
    votes: {},
    lastEjected: null,
    log: [...state.log, `Night ${round}. ${state.blackoutAt - state.cuts} cut${state.blackoutAt - state.cuts === 1 ? '' : 's'} from blackout.`],
  };
}

// ---------------------------------------------------------------------------
// Public view — what a client is allowed to know.
// ---------------------------------------------------------------------------

export interface PublicSeat {
  id: string;
  name: string;
  /** null while the role is still secret. Revealed on ejection / game over. */
  role: Role | null;
  alive: boolean;
  gone: boolean;
  bot: boolean;
}

export interface PublicState {
  seed: number;
  seats: PublicSeat[];
  round: number;
  phase: Phase;
  cuts: number;
  blackoutAt: number;
  ghostCount: number;
  darkened: string | null;
  votes: Record<string, string>;
  ledger: LedgerRow[];
  ejections: Ejection[];
  lastEjected: Ejection | null;
  winner: Winner;
  log: string[];
  /** Who has locked in an action — enough for a "waiting on 3 seats" HUD,
   *  without leaking WHAT anyone did. */
  acted: string[];
}

/**
 * Strip everything a client must not see. Roles are revealed only on ejection
 * or at game over; nobody ever receives another seat's secret role, which is
 * exactly why a promoted host has to ask each peer for its own role.
 */
export function publicView(state: GameState): PublicState {
  const over = state.phase === 'over';
  const revealed = new Set(state.ejections.map((e) => e.id));

  const acted: string[] = [];
  for (const id of activeSeats(state)) {
    if (state.phase === 'night' && state.probes[id]) acted.push(id);
    else if (state.phase === 'dawn' && state.claims[id] !== undefined) acted.push(id);
    else if (state.phase === 'vote' && state.votes[id] !== undefined) acted.push(id);
  }

  return {
    seed: state.seed,
    seats: state.seats.map((s) => ({
      id: s.id,
      name: s.name,
      role: over || revealed.has(s.id) ? s.role : null,
      alive: s.alive,
      gone: s.gone,
      bot: s.bot,
    })),
    round: state.round,
    phase: state.phase,
    cuts: state.cuts,
    blackoutAt: state.blackoutAt,
    ghostCount: state.ghostCount,
    darkened: state.darkened,
    votes: state.votes,
    // The true readings ride in the host's ledger but must never leave it while
    // the game is live — they'd name every Ghost outright. At game over they're
    // the payoff: the reveal shows exactly who published what, and what they saw.
    ledger: over ? state.ledger : state.ledger.map((r) => ({ ...r, truth: null })),
    ejections: state.ejections,
    lastEjected: state.lastEjected,
    winner: state.winner,
    log: state.log,
    acted,
  };
}

/** The secret half, addressed to exactly one seat. */
export interface PrivateView {
  role: Role;
  /** Your truthful reading this round, if you have one. */
  reading: number | null;
  probeTarget: string | null;
  /** The console you chose to cut this round. Ghosts only. */
  cutTarget: string | null;
  /** Your fellow Ghosts — Ghosts know each other from the first night. */
  allies: string[];
}

/** The living ring, derived from the public view. */
export function publicRing(pub: PublicState): string[] {
  return pub.seats.filter((s) => s.alive).map((s) => s.id);
}

/** The probe window, derived from the public view (clients and bots use this). */
export function publicWindow(pub: PublicState, targetId: string): string[] {
  return windowInRing(publicRing(pub), targetId);
}

/** The largest number a reading could honestly be, from the public view. */
export function publicMaxClaim(pub: PublicState, targetId: string): number {
  return Math.min(publicWindow(pub, targetId).length, pub.ghostCount);
}

export function privateView(state: GameState, id: string): PrivateView | null {
  const seat = seatOf(state, id);
  if (!seat) return null;
  return {
    role: seat.role,
    reading: state.readings[id] ?? null,
    probeTarget: state.probes[id] ?? null,
    cutTarget: seat.role === 'ghost' ? (state.cutVotes[id] ?? null) : null,
    allies:
      seat.role === 'ghost'
        ? state.seats.filter((s) => s.role === 'ghost' && s.id !== id).map((s) => s.id)
        : [],
  };
}
