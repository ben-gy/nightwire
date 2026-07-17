/**
 * MULTIPLAYER CONTRACT GATE #1 — room entry by typed code.
 *
 * A hand-typed code and the code carried by the invite link MUST resolve to the
 * same Trystero room. If they don't, two players silently sit in different
 * rooms, each convinced the other is broken.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  clearRoomInUrl,
  createLobby,
  inviteLink,
  mintCode,
  normalizeRoomCode,
  setRoomInUrl,
} from '../src/engine/lobby';
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
function fakeRounds(): Rounds {
  const state: RoundsState = {
    round: 0,
    phase: 'waiting',
    votes: [],
    present: [{ id: 'a', name: 'A' }],
    voted: false,
    isHost: true,
    canStart: false,
    startsInMs: null,
    hostOpts: null,
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

/** `settled` is net.ts's "I have heard from the room" — see hostSettled(). */
function fakeNet(settled = true): Net {
  return {
    selfId: 'a',
    peers: () => ['a'],
    host: () => (settled ? 'a' : null),
    isHost: () => settled,
    hostSettled: () => settled,
    count: () => 1,
    channel: () => {
      const send = (() => {}) as never;
      return send;
    },
    ping: async () => 0,
    leave: async () => {},
  } as unknown as Net;
}

describe('createLobby teardown', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('stops polling once destroyed', () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    const rounds = fakeRounds();
    const peeked = vi.spyOn(rounds, 'state');

    const lobby = createLobby({
      container,
      net: fakeNet(),
      rounds,
      roomCode: 'K7QP',
      minPlayers: 4,
    });
    vi.advanceTimersByTime(3000);
    expect(peeked.mock.calls.length).toBeGreaterThan(0);

    lobby.destroy();
    peeked.mockClear();
    vi.advanceTimersByTime(10_000);

    // A destroyed lobby must not touch the room or the DOM again.
    expect(peeked).not.toHaveBeenCalled();
  });
});

/**
 * The second shipped bug, at the layer the player actually sees it.
 *
 * Every peer used to paint itself HOST the instant it joined, before the mesh
 * had formed — and if discovery was slow or failed, it stayed that way. Two
 * players, the right room code, both wearing the host badge, seeing nobody. The
 * lobby must say "connecting" until net.ts has actually settled, and must not
 * offer a control that only the host can meaningfully press.
 */
describe('createLobby — an unsettled room is not a hosted room', () => {
  afterEach(() => vi.restoreAllMocks());

  function paint(settled: boolean): HTMLElement {
    const container = document.createElement('div');
    createLobby({
      container,
      net: fakeNet(settled),
      rounds: fakeRounds(),
      roomCode: 'K7QP',
      minPlayers: 4,
    }).destroy();
    return container;
  }

  it('says "connecting" and pins no HOST badge while unsettled', () => {
    const el = paint(false);
    expect(el.querySelector('.lobby-searching')?.textContent).toMatch(/connecting/i);
    expect(el.querySelector('.lobby-badge')).toBeNull();
    expect(el.querySelector('.lobby-start')).toBeNull();
  });

  it('will not let you ready up into a room that has not connected', () => {
    // Readying up here is a promise the room cannot keep: there is no host to
    // hear the vote, so the button just silently does nothing.
    expect(paint(false).querySelector<HTMLButtonElement>('.lobby-ready')!.disabled).toBe(true);
  });

  it('shows the host badge and the Start control once settled', () => {
    const el = paint(true);
    expect(el.querySelector('.lobby-searching')?.textContent ?? '').not.toMatch(/connecting/i);
    expect(el.querySelector('.lobby-badge')?.textContent).toBe('HOST');
    expect(el.querySelector<HTMLButtonElement>('.lobby-ready')!.disabled).toBe(false);
  });
});

/**
 * ?room= outliving the session: "it always spawns the same game room no matter
 * what". Nothing ever cleared the parameter, so a reload — or reopening from the
 * new home-screen icon — silently rejoined a room the player had left.
 */
describe('clearRoomInUrl', () => {
  it('drops ?room= so a reopen does not rejoin a room you left', () => {
    history.replaceState(null, '', '/?room=K7QP');
    clearRoomInUrl();
    expect(new URL(location.href).searchParams.has('room')).toBe(false);
  });

  it('leaves an unrelated query string alone', () => {
    history.replaceState(null, '', '/?room=K7QP&debug=1');
    clearRoomInUrl();
    const url = new URL(location.href);
    expect(url.searchParams.has('room')).toBe(false);
    expect(url.searchParams.get('debug')).toBe('1');
  });

  it('is a no-op when there is no room to clear', () => {
    history.replaceState(null, '', '/?debug=1');
    clearRoomInUrl();
    expect(location.search).toBe('?debug=1');
  });

  it('round-trips with setRoomInUrl — the invite link still works', () => {
    history.replaceState(null, '', '/');
    setRoomInUrl('K7QP');
    expect(inviteLink('K7QP')).toContain('room=K7QP');
    clearRoomInUrl();
    expect(location.search).toBe('');
  });
});
