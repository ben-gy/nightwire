/**
 * reveal.test.ts — the payoff, and the secret it must keep until then.
 *
 * Nightwire's whole hook is that Ghosts publish false numbers. The ledger only
 * ever recorded what was published, so when the game ended you never learned
 * which numbers were lies — the one thing every player wants to know. The true
 * reading now rides alongside the claim.
 *
 * That makes secrecy load-bearing: a truth that leaks one round early names
 * every Ghost outright and the game is over. Both halves are tested here.
 */

import { describe, it, expect } from 'vitest';
import {
  deal,
  publicView,
  resolveNight,
  resolveDawn,
  submitProbe,
  submitClaim,
  trueReading,
  type GameState,
} from '../src/game';

const specs = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, bot: false }));

/** Deal, have everyone probe someone, and run the night through to the vote. */
function toVote(seed: number, n = 6): GameState {
  let s = deal(seed, specs(n));
  const ids = s.seats.map((x) => x.id);
  for (const id of ids) s = submitProbe(s, id, ids.find((x) => x !== id)!);
  s = resolveNight(s);
  return s;
}

describe('the ledger records the truth behind every claim', () => {
  it('stores the true reading alongside the published one', () => {
    const s = resolveDawn(toVote(1234));
    expect(s.ledger.length).toBeGreaterThan(0);
    for (const row of s.ledger) {
      if (row.dark) {
        expect(row.truth).toBeNull();
        continue;
      }
      // The host's ledger is the only place the pair exists.
      expect(row.truth).toBe(trueReading(s, row.target));
    }
  });

  it('catches a Ghost out: claim and truth disagree exactly where they lied', () => {
    let s = toVote(1234);
    const ghost = s.seats.find((x) => x.role === 'ghost' && s.readings[x.id] !== undefined)!;
    const truth = s.readings[ghost.id];
    const lie = truth === 0 ? 1 : 0;
    s = resolveDawn(submitClaim(s, ghost.id, lie));

    const row = s.ledger.find((r) => r.by === ghost.id)!;
    expect(row.claim).toBe(lie);
    expect(row.truth).toBe(truth);
    expect(row.claim).not.toBe(row.truth);

    // And an honest Crew row must never be flagged by the same comparison.
    const crew = s.ledger.find((r) => !r.dark && r.by !== ghost.id && r.truth !== null)!;
    const crewSeat = s.seats.find((x) => x.id === crew.by)!;
    if (crewSeat.role === 'crew') expect(crew.claim).toBe(crew.truth);
  });
});

describe('secrecy — the truth stays with the host until the game is over', () => {
  it('strips every true reading from the public ledger mid-game', () => {
    let s = toVote(1234);
    const ghost = s.seats.find((x) => x.role === 'ghost' && s.readings[x.id] !== undefined)!;
    s = resolveDawn(submitClaim(s, ghost.id, s.readings[ghost.id] === 0 ? 1 : 0));

    const pub = publicView(s);
    expect(pub.phase).not.toBe('over');
    expect(pub.ledger.length).toBeGreaterThan(0);
    // A single leaked truth is a free Ghost hunt: it names anyone whose
    // published number doesn't match.
    for (const row of pub.ledger) expect(row.truth).toBeNull();
    // …while the published half is public, exactly as before.
    expect(pub.ledger.map((r) => r.claim)).toEqual(s.ledger.map((r) => r.claim));
  });

  it('publishes the truth at game over, so the reveal can name the liars', () => {
    let s = toVote(1234);
    const ghost = s.seats.find((x) => x.role === 'ghost' && s.readings[x.id] !== undefined)!;
    const truth = s.readings[ghost.id];
    s = resolveDawn(submitClaim(s, ghost.id, truth === 0 ? 1 : 0));
    s = { ...s, phase: 'over', winner: 'crew' };

    const pub = publicView(s);
    const row = pub.ledger.find((r) => r.by === ghost.id)!;
    expect(row.truth).toBe(truth);
    expect(pub.ledger.some((r) => r.truth !== null && r.claim !== r.truth)).toBe(true);
  });
});
