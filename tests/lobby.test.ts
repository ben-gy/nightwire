/**
 * MULTIPLAYER CONTRACT GATE #1 — room entry by typed code.
 *
 * A hand-typed code and the code carried by the invite link MUST resolve to the
 * same Trystero room. If they don't, two players silently sit in different
 * rooms, each convinced the other is broken.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { createLobby, normalizeRoomCode, mintCode } from '../src/engine/lobby';
import type { Net } from '../src/engine/net';
import type { Rounds, RoundsState } from '../src/engine/rematch';

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

/**
 * The lobby polls on a timer so it can spot a host transfer. main.ts never held
 * the handle it returns, so destroy() was never called: the poll outlived the
 * screen and kept repainting a container the app had moved on from.
 */
describe('createLobby teardown', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function fakeRounds(): Rounds {
    const state: RoundsState = {
      round: 0,
      phase: 'waiting',
      votes: [],
      present: [{ id: 'a', name: 'A' }],
      voted: false,
      isHost: true,
      canStart: false,
    };
    return {
      vote() {},
      unvote() {},
      go() {},
      finish() {},
      state: () => state,
      destroy() {},
    };
  }

  const fakeNet = {
    selfId: 'a',
    peers: () => ['a'],
    host: () => 'a',
    isHost: () => true,
    count: () => 1,
    channel: () => {
      const send = (() => {}) as never;
      return send;
    },
    ping: async () => 0,
    leave: async () => {},
  } as unknown as Net;

  it('stops polling once destroyed', () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    const rounds = fakeRounds();
    const peeked = vi.spyOn(rounds, 'state');

    const lobby = createLobby({ container, net: fakeNet, rounds, roomCode: 'K7QP', minPlayers: 4 });
    vi.advanceTimersByTime(3000);
    expect(peeked.mock.calls.length).toBeGreaterThan(0);

    lobby.destroy();
    peeked.mockClear();
    vi.advanceTimersByTime(10_000);

    // A destroyed lobby must not touch the room or the DOM again.
    expect(peeked).not.toHaveBeenCalled();
  });
});
