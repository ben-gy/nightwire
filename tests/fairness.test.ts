/**
 * Starting balance. Nightwire's roles are asymmetric on purpose — that's the
 * game — but nothing about WHERE you sit or WHO you are may tilt the deal.
 * This is the turn-0 fairness check: inspect the opening, not just mid-game.
 */

import { describe, it, expect } from 'vitest';
import { deal, windowOf, trueReading, livingRing, ghostCountFor } from '../src/game';

const table = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, bot: false }));

describe('the deal is fair at turn 0', () => {
  it('makes every player equally likely to be a Ghost', () => {
    const N = 8;
    const SEEDS = 4000;
    const counts: Record<string, number> = {};
    for (const p of table(N)) counts[p.id] = 0;

    for (let seed = 0; seed < SEEDS; seed++) {
      for (const s of deal(seed, table(N)).seats) {
        if (s.role === 'ghost') counts[s.id]++;
      }
    }

    const expected = (SEEDS * ghostCountFor(N)) / N;
    for (const id of Object.keys(counts)) {
      // Within 15% of the fair share — a positional or ordering bias in the
      // deal would blow way past this.
      expect(Math.abs(counts[id] - expected) / expected).toBeLessThan(0.15);
    }
  });

  it('makes every SEAT POSITION equally likely to hold a Ghost', () => {
    const N = 6;
    const SEEDS = 4000;
    const byIndex = new Array(N).fill(0);
    for (let seed = 0; seed < SEEDS; seed++) {
      deal(seed, table(N)).seats.forEach((s, i) => {
        if (s.role === 'ghost') byIndex[i]++;
      });
    }
    const expected = (SEEDS * ghostCountFor(N)) / N;
    for (const c of byIndex) {
      expect(Math.abs(c - expected) / expected).toBeLessThan(0.15);
    }
  });

  it('gives no player an information edge at the opening — the ledger starts empty', () => {
    const s = deal(123, table(6));
    expect(s.ledger).toHaveLength(0);
    expect(s.ejections).toHaveLength(0);
    expect(s.cuts).toBe(0);
    expect(s.round).toBe(1);
    expect(s.seats.every((x) => x.alive && !x.gone)).toBe(true);
  });
});

describe('probe windows', () => {
  it('reads exactly 3 seats — the target and both neighbours', () => {
    const s = deal(5, table(7));
    const ring = livingRing(s);
    for (const id of ring) {
      const w = windowOf(s, id);
      expect(w).toHaveLength(3);
      expect(w[1]).toBe(id);
      expect(new Set(w).size).toBe(3);
    }
  });

  it('wraps around the ring', () => {
    const s = deal(5, table(7));
    const ring = livingRing(s);
    const w = windowOf(s, ring[0]);
    expect(w).toEqual([ring[ring.length - 1], ring[0], ring[1]]);
  });

  it('shrinks gracefully when 3 or fewer seats remain', () => {
    const s = deal(5, table(4));
    const ring = livingRing(s);
    const shrunk = { ...s, seats: s.seats.map((x) => (x.id === ring[3] ? { ...x, alive: false } : x)) };
    const w = windowOf(shrunk, livingRing(shrunk)[0]);
    expect(w).toHaveLength(3);
    expect(w).toEqual(livingRing(shrunk));
  });

  it('returns an empty window for a seat that is out', () => {
    const s = deal(5, table(6));
    const dead = { ...s, seats: s.seats.map((x, i) => (i === 2 ? { ...x, alive: false } : x)) };
    expect(windowOf(dead, s.seats[2].id)).toEqual([]);
  });

  it('reads the true number of Ghosts in the window, always', () => {
    for (let seed = 0; seed < 30; seed++) {
      const s = deal(seed, table(8));
      for (const id of livingRing(s)) {
        const w = windowOf(s, id);
        const truth = w.filter((x) => s.seats.find((y) => y.id === x)!.role === 'ghost').length;
        expect(trueReading(s, id)).toBe(truth);
        expect(trueReading(s, id)).toBeGreaterThanOrEqual(0);
        expect(trueReading(s, id)).toBeLessThanOrEqual(3);
      }
    }
  });
});
