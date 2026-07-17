/**
 * MULTIPLAYER CONTRACT GATE #1 — room entry by typed code.
 *
 * A hand-typed code and the code carried by the invite link MUST resolve to the
 * same Trystero room. If they don't, two players silently sit in different
 * rooms, each convinced the other is broken.
 */

import { describe, it, expect } from 'vitest';
import { normalizeRoomCode, mintCode } from '../src/engine/lobby';

describe('normalizeRoomCode', () => {
  it('canonicalises a hand-typed code to exactly what the link carries', () => {
    const linked = 'K7QP';
    for (const typed of ['k7qp', ' K7QP ', 'k7-qp', 'K7 Q P', 'k7qp!', '  k7Qp\n']) {
      expect(normalizeRoomCode(typed)).toBe(linked);
    }
  });

  it('upper-cases', () => {
    expect(normalizeRoomCode('abcd')).toBe('ABCD');
  });

  it('strips every non-alphanumeric character', () => {
    expect(normalizeRoomCode('a-b_c d.e')).toBe('ABCDE');
    expect(normalizeRoomCode('!!!')).toBe('');
  });

  it('caps at 8 characters', () => {
    expect(normalizeRoomCode('abcdefghijkl')).toBe('ABCDEFGH');
  });

  it('is idempotent — normalising twice changes nothing', () => {
    for (const raw of ['k7qp', 'A-b-C', 'zz99']) {
      const once = normalizeRoomCode(raw);
      expect(normalizeRoomCode(once)).toBe(once);
    }
  });

  it('leaves a freshly minted code untouched', () => {
    for (let i = 0; i < 200; i++) {
      const code = mintCode();
      expect(normalizeRoomCode(code)).toBe(code);
      expect(code).toHaveLength(4);
    }
  });

  it('mints codes without visually ambiguous characters', () => {
    for (let i = 0; i < 300; i++) {
      expect(mintCode()).not.toMatch(/[IO01L]/);
    }
  });
});
