/**
 * P2P-sync determinism. Two peers construct their RNG from the same broadcast
 * seed; if these ever diverge, every multiplayer table desyncs.
 */

import { describe, it, expect } from 'vitest';
import { makeRng, hashSeed, shuffle, randInt, pick } from '../src/engine/rng';
import { deal, ghostCountFor, blackoutFor } from '../src/game';

const table = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, bot: false }));

describe('rng determinism', () => {
  it('produces an identical stream for the same seed', () => {
    const a = makeRng(12345);
    const b = makeRng(12345);
    const as = Array.from({ length: 200 }, () => a());
    const bs = Array.from({ length: 200 }, () => b());
    expect(as).toEqual(bs);
  });

  it('produces a different stream for a different seed', () => {
    const a = Array.from({ length: 50 }, makeRng(1));
    const b = Array.from({ length: 50 }, makeRng(2));
    expect(a).not.toEqual(b);
  });

  it('stays in [0,1)', () => {
    const r = makeRng('nightwire');
    for (let i = 0; i < 500; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('hashes strings to a stable 32-bit seed', () => {
    expect(hashSeed('nightwire')).toBe(hashSeed('nightwire'));
    expect(hashSeed('nightwire')).not.toBe(hashSeed('nightwir3'));
    expect(hashSeed('x')).toBeGreaterThanOrEqual(0);
  });

  it('shuffles identically for peers with the same seed, without mutating input', () => {
    const src = ['a', 'b', 'c', 'd', 'e', 'f'];
    const one = shuffle(makeRng(99), src);
    const two = shuffle(makeRng(99), src);
    expect(one).toEqual(two);
    expect(src).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('agrees on randInt and pick across peers', () => {
    const a = makeRng(7);
    const b = makeRng(7);
    for (let i = 0; i < 20; i++) expect(randInt(a, 0, 9)).toBe(randInt(b, 0, 9));
    const c = makeRng(8);
    const d = makeRng(8);
    expect(pick(c, ['x', 'y', 'z'])).toBe(pick(d, ['x', 'y', 'z']));
  });
});

describe('deal determinism (the invariant every P2P table rests on)', () => {
  it('deals an identical table — seating AND roles — from the same seed', () => {
    for (const seed of [1, 42, 9999, 0xdeadbe]) {
      const a = deal(seed, table(7));
      const b = deal(seed, table(7));
      expect(a.seats).toEqual(b.seats);
      expect(a.blackoutAt).toBe(b.blackoutAt);
      expect(a.ghostCount).toBe(b.ghostCount);
    }
  });

  it('deals a different table for a different seed', () => {
    const a = deal(1, table(8));
    const b = deal(2, table(8));
    const roleStr = (s: typeof a) => s.seats.map((x) => `${x.id}:${x.role}`).join(',');
    expect(roleStr(a)).not.toBe(roleStr(b));
  });

  it('always deals exactly the scheduled number of Ghosts', () => {
    for (let n = 4; n <= 10; n++) {
      for (let seed = 0; seed < 40; seed++) {
        const s = deal(seed, table(n));
        expect(s.seats.filter((x) => x.role === 'ghost')).toHaveLength(ghostCountFor(n));
        expect(s.seats).toHaveLength(n);
        expect(s.blackoutAt).toBe(blackoutFor(ghostCountFor(n)));
      }
    }
  });

  it('rejects tables outside 4–10 seats', () => {
    expect(() => deal(1, table(3))).toThrow();
    expect(() => deal(1, table(11))).toThrow();
  });
});
