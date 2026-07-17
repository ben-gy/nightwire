/**
 * The solver. Bots must deduce from the published ledger only — never from
 * roles they were not given. These tests check the reasoning is actually sound,
 * because a bot that guesses makes the solo game pointless.
 */

import { describe, it, expect } from 'vitest';
import { combos, solve, worldFits, chooseClaim, chooseVote, chooseCut, botRng } from '../src/bot';
import { deal, publicView, privateView, type LedgerRow, type PublicState } from '../src/game';

const row = (by: string, window: string[], claim: number | null, dark = false): LedgerRow => ({
  round: 1,
  by,
  target: window[1] ?? window[0],
  window,
  claim,
  // Bots see the public ledger, where the true reading is withheld until the
  // game is over. Handing them one here would test a bot that cannot exist.
  truth: null,
  dark,
});

const seats = (ids: string[]) => ids.map((id) => ({ id, role: null }));

describe('combos', () => {
  it('enumerates every k-subset', () => {
    expect(combos(['a', 'b', 'c'], 2)).toEqual([
      ['a', 'b'],
      ['a', 'c'],
      ['b', 'c'],
    ]);
    expect(combos(['a', 'b', 'c', 'd'], 1)).toHaveLength(4);
    expect(combos(['a', 'b', 'c', 'd'], 4)).toHaveLength(1);
  });

  it('stays small enough to enumerate exhaustively at the biggest table', () => {
    expect(combos(Array.from({ length: 10 }, (_, i) => `p${i}`), 3)).toHaveLength(120);
  });
});

describe('worldFits', () => {
  const base = { seats: seats(['p0', 'p1', 'p2', 'p3']), ghostCount: 1 };

  it('accepts a world where a Crew claim tells the truth', () => {
    // p0 says "1 Ghost among p0,p1,p2". A world with p1 as the Ghost fits.
    const input = { ...base, ledger: [row('p0', ['p0', 'p1', 'p2'], 1)] };
    expect(worldFits(new Set(['p1']), input)).toBe(true);
  });

  it('rejects a world where a Crew claim would be false', () => {
    const input = { ...base, ledger: [row('p0', ['p0', 'p1', 'p2'], 1)] };
    // p3 as the Ghost means p0's window holds 0 Ghosts, contradicting "1".
    expect(worldFits(new Set(['p3']), input)).toBe(false);
  });

  it('lets a Ghost author say anything — their number constrains nothing', () => {
    const input = { ...base, ledger: [row('p0', ['p0', 'p1', 'p2'], 3)] };
    // If p0 IS the Ghost, their absurd claim is just a lie, so the world stands.
    expect(worldFits(new Set(['p0']), input)).toBe(true);
  });

  it('ignores dark rows entirely', () => {
    const input = { ...base, ledger: [row('p0', ['p0', 'p1', 'p2'], null, true)] };
    expect(worldFits(new Set(['p3']), input)).toBe(true);
  });

  it('respects revealed roles', () => {
    const input = {
      seats: [
        { id: 'p0', role: null },
        { id: 'p1', role: 'crew' as const },
        { id: 'p2', role: null },
        { id: 'p3', role: null },
      ],
      ghostCount: 1,
      ledger: [],
    };
    expect(worldFits(new Set(['p1']), input)).toBe(false);
    expect(worldFits(new Set(['p2']), input)).toBe(true);
  });

  it('respects the solver own known role', () => {
    const input = { ...base, ledger: [], self: { id: 'p0', role: 'crew' as const } };
    expect(worldFits(new Set(['p0']), input)).toBe(false);
    expect(worldFits(new Set(['p1']), input)).toBe(true);
  });
});

describe('solve', () => {
  it('convicts a seat outright when the ledger leaves no alternative', () => {
    // Everyone but p2 is proven Crew; the one Ghost must be p2.
    const input = {
      seats: [
        { id: 'p0', role: 'crew' as const },
        { id: 'p1', role: 'crew' as const },
        { id: 'p2', role: null },
        { id: 'p3', role: 'crew' as const },
      ],
      ghostCount: 1,
      ledger: [],
    };
    const b = solve(input);
    expect(b.worlds).toBe(1);
    expect(b.suspicion['p2']).toBe(1);
    expect(b.suspicion['p0']).toBe(0);
  });

  it('starts every seat at the same suspicion with an empty ledger', () => {
    const b = solve({ seats: seats(['p0', 'p1', 'p2', 'p3']), ghostCount: 1, ledger: [] });
    expect(b.worlds).toBe(4);
    for (const id of ['p0', 'p1', 'p2', 'p3']) expect(b.suspicion[id]).toBeCloseTo(0.25);
  });

  it('narrows the field as claims come in', () => {
    const open = solve({ seats: seats(['p0', 'p1', 'p2', 'p3']), ghostCount: 1, ledger: [] });
    const narrowed = solve({
      seats: seats(['p0', 'p1', 'p2', 'p3']),
      ghostCount: 1,
      ledger: [row('p0', ['p3', 'p0', 'p1'], 0)],
    });
    // "0 Ghosts near me" either clears p3/p0/p1 — or p0 is lying.
    expect(narrowed.worlds).toBeLessThan(open.worlds);
    expect(narrowed.suspicion['p2']).toBeGreaterThan(open.suspicion['p2']);
  });

  it('convicts the only seat whose story can be squared with the ledger', () => {
    // p1 says "no Ghosts around p1"; p5 says "no Ghosts around p5". Between
    // them they clear everyone except p3 — and p3's own claim of 1 is then only
    // explicable by p3 itself being the Ghost.
    const b = solve({
      seats: seats(['p0', 'p1', 'p2', 'p3', 'p4', 'p5']),
      ghostCount: 1,
      ledger: [
        row('p1', ['p0', 'p1', 'p2'], 0),
        row('p3', ['p2', 'p3', 'p4'], 1),
        row('p5', ['p4', 'p5', 'p0'], 0),
      ],
      self: { id: 'p0', role: 'crew' },
    });
    expect(b.worlds).toBe(1);
    expect(b.suspicion['p3']).toBe(1);
    expect(b.suspicion['p4']).toBe(0);
  });

  it('is never handed an unsatisfiable ledger by real play — the truth always fits', () => {
    // A Ghost can lie however it likes; the real world still explains every
    // Crew row (they are truthful by construction) and exempts the Ghost's own.
    for (const lie of [0, 1, 2, 3]) {
      const b = solve({
        seats: seats(['p0', 'p1', 'p2', 'p3', 'p4', 'p5']),
        ghostCount: 2,
        // p0 and p1 are the real Ghosts here; p0 publishes `lie`.
        ledger: [
          row('p0', ['p5', 'p0', 'p1'], lie),
          row('p2', ['p1', 'p2', 'p3'], 1),
          row('p3', ['p2', 'p3', 'p4'], 0),
        ],
      });
      expect(b.worlds).toBeGreaterThan(0);
    }
  });

  it('never returns NaN, and always spans [0,1]', () => {
    const b = solve({
      seats: seats(['p0', 'p1', 'p2', 'p3']),
      ghostCount: 1,
      ledger: [row('p0', ['p0', 'p1', 'p2'], 1), row('p1', ['p0', 'p1', 'p2'], 0)],
    });
    for (const v of Object.values(b.suspicion)) {
      expect(Number.isNaN(v)).toBe(false);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('always leaves at least one consistent world — the truth always fits', () => {
    for (let seed = 0; seed < 25; seed++) {
      const s = deal(seed, Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, bot: false })));
      const pub = publicView(s);
      const b = solve({
        seats: pub.seats.map((x) => ({ id: x.id, role: x.role })),
        ghostCount: pub.ghostCount,
        ledger: pub.ledger,
      });
      expect(b.worlds).toBeGreaterThan(0);
    }
  });
});

describe('bot decisions', () => {
  const pub = (): PublicState => ({
    seed: 5,
    seats: ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'].map((id) => ({
      id,
      name: id,
      role: null,
      alive: true,
      gone: false,
      bot: true,
    })),
    round: 1,
    phase: 'dawn',
    cuts: 0,
    blackoutAt: 4,
    ghostCount: 2,
    darkened: null,
    votes: {},
    ledger: [],
    ejections: [],
    lastEjected: null,
    winner: null,
    log: [],
    acted: [],
  });

  it('makes a Ghost publish a number that keeps them looking like Crew', () => {
    const p = pub();
    const priv = { role: 'ghost' as const, reading: 2, probeTarget: 'p1', cutTarget: null, allies: ['p2'] };
    const claim = chooseClaim(p, 'p1', priv, botRng(p, 'p1', 'claim'));
    // The truthful "2" would point straight at p1's own neighbourhood, which
    // contains p1 and its ally p2 — a good Ghost shades that number down.
    expect(claim).toBeLessThan(2);
    expect(claim).toBeGreaterThanOrEqual(0);
  });

  it('never has a Ghost vote for its own ally when anyone else is available', () => {
    const p = pub();
    const priv = { role: 'ghost' as const, reading: 1, probeTarget: 'p1', cutTarget: null, allies: ['p2'] };
    for (let i = 0; i < 20; i++) {
      const v = chooseVote(p, 'p1', priv, botRng(p, `p1-${i}`, 'vote'));
      expect(v).not.toBe('p2');
      expect(v).not.toBe('p1');
    }
  });

  it('makes a Crew bot vote for the seat the ledger convicts', () => {
    const p = pub();
    p.ghostCount = 1;
    p.ledger = [
      { round: 1, by: 'p1', target: 'p1', window: ['p0', 'p1', 'p2'], claim: 0, truth: null, dark: false },
      { round: 1, by: 'p3', target: 'p3', window: ['p2', 'p3', 'p4'], claim: 1, truth: null, dark: false },
      { round: 1, by: 'p5', target: 'p5', window: ['p4', 'p5', 'p0'], claim: 0, truth: null, dark: false },
    ];
    const priv = { role: 'crew' as const, reading: 0, probeTarget: 'p1', cutTarget: null, allies: [] };
    // Exactly one world survives, and it has p3 as the Ghost.
    expect(chooseVote(p, 'p0', priv, botRng(p, 'p0', 'vote'))).toBe('p3');
  });

  it('makes a Ghost darken someone other than itself or an ally', () => {
    const p = pub();
    const priv = { role: 'ghost' as const, reading: 1, probeTarget: 'p1', cutTarget: null, allies: ['p2'] };
    const cut = chooseCut(p, 'p1', priv, botRng(p, 'p1', 'cut'));
    expect(cut).not.toBe('p1');
    expect(cut).not.toBe('p2');
  });

  it('is deterministic — same table, same seed, same decision', () => {
    const p = pub();
    const priv = privateView(deal(3, p.seats.map((s) => ({ id: s.id, name: s.name, bot: true }))), 'p0')!;
    const a = chooseVote(p, 'p0', priv, botRng(p, 'p0', 'vote'));
    const b = chooseVote(p, 'p0', priv, botRng(p, 'p0', 'vote'));
    expect(a).toBe(b);
  });
});
