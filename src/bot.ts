/**
 * bot.ts — the solo opposition.
 *
 * These bots play the game properly rather than faking it. Nightwire's ledger is
 * a constraint system: "Crew claims are always true" means every published Crew
 * number pins down how many Ghosts sit in that window. With at most 10 seats and
 * at most 3 Ghosts there are at most C(10,3)=120 possible worlds, so a bot can
 * enumerate ALL of them exactly — no heuristics, no cheating, no peeking at
 * roles it shouldn't see.
 *
 * suspicion[p] = the fraction of surviving worlds in which p is a Ghost.
 *
 * A Ghost bot runs the same solver from the table's point of view (the
 * "observer" solver, which does NOT know its role) and picks the lie that
 * maximises the share of worlds where it still looks like Crew.
 */

import {
  publicWindow,
  publicRing,
  type PublicState,
  type LedgerRow,
  type Role,
  type PrivateView,
} from './game';
import { makeRng, type Rng } from './engine/rng';

/** Every k-sized subset of ids. */
export function combos(ids: readonly string[], k: number): string[][] {
  const out: string[][] = [];
  const cur: string[] = [];
  (function walk(start: number): void {
    if (cur.length === k) {
      out.push(cur.slice());
      return;
    }
    for (let i = start; i < ids.length; i++) {
      cur.push(ids[i]);
      walk(i + 1);
      cur.pop();
    }
  })(0);
  return out;
}

export interface SolveInput {
  seats: readonly { id: string; role: Role | null }[];
  ghostCount: number;
  ledger: readonly LedgerRow[];
  /** Pin the solver's own role — you always know what you are. */
  self?: { id: string; role: Role };
}

export interface Belief {
  /** seatId -> P(ghost), in [0,1]. */
  suspicion: Record<string, number>;
  /** How many worlds survived every constraint. */
  worlds: number;
}

/**
 * Is `world` (the set of Ghost ids) consistent with everything published?
 * A row only constrains the world if its author is CREW in that world —
 * a Ghost's number is unconstrained precisely because Ghosts may lie.
 */
export function worldFits(world: ReadonlySet<string>, input: SolveInput): boolean {
  for (const s of input.seats) {
    if (s.role === null) continue; // still secret
    if (world.has(s.id) !== (s.role === 'ghost')) return false;
  }
  if (input.self && world.has(input.self.id) !== (input.self.role === 'ghost')) return false;

  for (const row of input.ledger) {
    if (row.dark || row.claim === null) continue;
    if (world.has(row.by)) continue; // author is a Ghost here — their number proves nothing
    let n = 0;
    for (const id of row.window) if (world.has(id)) n++;
    if (n !== row.claim) return false;
  }
  return true;
}

/** Enumerate every consistent world and turn them into per-seat suspicion. */
export function solve(input: SolveInput): Belief {
  const ids = input.seats.map((s) => s.id);
  const counts: Record<string, number> = {};
  for (const id of ids) counts[id] = 0;

  let worlds = 0;
  for (const combo of combos(ids, input.ghostCount)) {
    const w = new Set(combo);
    if (!worldFits(w, input)) continue;
    worlds++;
    for (const id of combo) counts[id]++;
  }

  const suspicion: Record<string, number> = {};
  for (const id of ids) {
    // No consistent world should be impossible (the truth always fits), but if
    // it ever were, fall back to "everyone equally likely" rather than NaN.
    suspicion[id] = worlds > 0 ? counts[id] / worlds : input.ghostCount / ids.length;
  }
  return { suspicion, worlds };
}

/** The solver as the rest of the table sees it — no private role pinned. */
function observerBelief(pub: PublicState, extraRow?: LedgerRow): Belief {
  return solve({
    seats: pub.seats.map((s) => ({ id: s.id, role: s.role })),
    ghostCount: pub.ghostCount,
    ledger: extraRow ? [...pub.ledger, extraRow] : pub.ledger,
  });
}

/** The solver as this bot sees it — its own role pinned down. */
export function beliefFor(pub: PublicState, id: string, priv: PrivateView): Belief {
  return solve({
    seats: pub.seats.map((s) => ({ id: s.id, role: s.role })),
    ghostCount: pub.ghostCount,
    ledger: pub.ledger,
    self: { id, role: priv.role },
  });
}

const alive = publicRing;

/**
 * Which seat to probe. Information is worth most where the table is least sure,
 * so aim at the window with the most uncertainty (Bernoulli variance peaks at
 * p=0.5). A little seeded jitter stops every bot piling onto the same seat.
 */
export function chooseProbe(pub: PublicState, id: string, priv: PrivateView, rng: Rng): string {
  const belief = beliefFor(pub, id, priv);
  const targets = alive(pub).filter((t) => t !== id);
  let best = targets[0];
  let bestScore = -Infinity;
  for (const t of targets) {
    const win = publicWindow(pub, t);
    let score = 0;
    for (const w of win) {
      const p = belief.suspicion[w] ?? 0.5;
      score += p * (1 - p);
    }
    score += rng() * 0.05;
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

/**
 * Which console a Ghost darkens: the Crew member the table trusts most. Their
 * reading is the one most likely to be believed, so it's the one worth silencing.
 */
export function chooseCut(pub: PublicState, id: string, priv: PrivateView, rng: Rng): string {
  const belief = observerBelief(pub);
  const targets = alive(pub).filter((t) => t !== id && !priv.allies.includes(t));
  if (targets.length === 0) return alive(pub).filter((t) => t !== id)[0] ?? id;
  let best = targets[0];
  let bestScore = Infinity;
  for (const t of targets) {
    const score = (belief.suspicion[t] ?? 0.5) + rng() * 0.05;
    if (score < bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

/**
 * What number a Ghost publishes. Try every legal value; for each, ask the
 * OBSERVER solver how much of the surviving world-space still has us as Crew.
 * Ties break toward covering for allies, then toward the truth (a lie you don't
 * need is a lie that can catch you out).
 */
export function chooseClaim(pub: PublicState, id: string, priv: PrivateView, rng: Rng): number {
  const target = priv.probeTarget;
  const truth = priv.reading ?? 0;
  if (target === null) return truth;
  const win = publicWindow(pub, target);
  const row: Omit<LedgerRow, 'claim'> = {
    round: pub.round,
    by: id,
    target,
    window: win,
    // The solver reasons from the PUBLIC ledger, where the true reading is
    // stripped until game over — so a hypothetical row must not carry one.
    truth: null,
    dark: false,
  };

  let best = truth;
  let bestScore = -Infinity;
  const max = Math.min(win.length, pub.ghostCount);
  for (let v = 0; v <= max; v++) {
    const belief = observerBelief(pub, { ...row, claim: v });
    // A number no world can explain would break the ledger and convict us on
    // the spot. Never worth it. (The truth always leaves a world standing, so
    // `best` always has a legal fallback.)
    if (belief.worlds === 0) continue;
    // How innocent does this number make us look to everyone else?
    const innocence = 1 - (belief.suspicion[id] ?? 1);
    // How well does it cover the rest of the team?
    let cover = 0;
    for (const a of priv.allies) cover += 1 - (belief.suspicion[a] ?? 1);
    const honesty = v === truth ? 0.02 : 0; // nudge toward truth on a genuine tie
    const score = innocence * 2 + cover * 0.5 + honesty + rng() * 0.01;
    if (score > bestScore) {
      bestScore = score;
      best = v;
    }
  }
  return best;
}

/**
 * Who to eject. Crew vote the seat the evidence most convicts. Ghosts vote the
 * most-suspected seat that ISN'T an ally — which quietly protects the team and
 * looks exactly like earnest Crew play.
 */
export function chooseVote(pub: PublicState, id: string, priv: PrivateView, rng: Rng): string {
  const belief = beliefFor(pub, id, priv);
  let targets = alive(pub).filter((t) => t !== id);
  if (priv.role === 'ghost') {
    const notAllies = targets.filter((t) => !priv.allies.includes(t));
    if (notAllies.length > 0) targets = notAllies;
  }
  let best = targets[0];
  let bestScore = -Infinity;
  for (const t of targets) {
    const score = (belief.suspicion[t] ?? 0.5) + rng() * 0.03;
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

/** Seeded, per-bot, per-round RNG so bot play is reproducible in tests. */
export function botRng(pub: PublicState, id: string, salt: string): Rng {
  return makeRng(`${pub.seed}:${pub.round}:${id}:${salt}`);
}

/** Original callsigns — no trademarks, no real people. */
export const BOT_NAMES = [
  'Vesper',
  'Halloway',
  'Marrow',
  'Quill',
  'Ashgrove',
  'Pike',
  'Solace',
  'Bramble',
  'Corvid',
  'Tannin',
  'Wexford',
  'Ondine',
];
