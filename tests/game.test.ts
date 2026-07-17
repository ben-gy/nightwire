/**
 * The rules core. These lock down the two things the whole game rests on:
 * Crew readings publish truthfully and automatically, and only Ghosts choose
 * their number.
 */

import { describe, it, expect } from 'vitest';
import {
  deal,
  submitProbe,
  submitCut,
  submitClaim,
  submitVote,
  resolveNight,
  resolveDawn,
  resolveVote,
  nextRound,
  publicView,
  privateView,
  trueReading,
  windowOf,
  nightComplete,
  votesComplete,
  ghostCountFor,
  blackoutFor,
  type GameState,
  type Role,
} from '../src/game';

/** Build an exact table so rules tests don't depend on what the deal rolled. */
function makeState(roles: Role[], overrides: Partial<GameState> = {}): GameState {
  const ghostCount = roles.filter((r) => r === 'ghost').length;
  return {
    seed: 1,
    seats: roles.map((role, i) => ({
      id: `p${i}`,
      name: `P${i}`,
      role,
      alive: true,
      gone: false,
      bot: false,
    })),
    round: 1,
    phase: 'night',
    cuts: 0,
    blackoutAt: blackoutFor(ghostCount),
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
    log: [],
    ...overrides,
  };
}

const table = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, bot: false }));

describe('table setup', () => {
  it('scales Ghosts and the blackout clock with the table', () => {
    expect(ghostCountFor(4)).toBe(1);
    expect(ghostCountFor(5)).toBe(1);
    expect(ghostCountFor(6)).toBe(2);
    expect(ghostCountFor(8)).toBe(2);
    expect(ghostCountFor(9)).toBe(3);
    expect(ghostCountFor(10)).toBe(3);
    expect(blackoutFor(1)).toBe(3);
    expect(blackoutFor(3)).toBe(5);
  });
});

describe('probing', () => {
  it('rejects probing your own seat', () => {
    const s = makeState(['crew', 'crew', 'crew', 'ghost']);
    expect(submitProbe(s, 'p0', 'p0')).toBe(s);
  });

  it('rejects probing an ejected seat', () => {
    const s = makeState(['crew', 'crew', 'crew', 'ghost']);
    const dead = { ...s, seats: s.seats.map((x) => (x.id === 'p1' ? { ...x, alive: false } : x)) };
    expect(submitProbe(dead, 'p0', 'p1')).toBe(dead);
  });

  it('rejects probes outside the night phase', () => {
    const s = makeState(['crew', 'crew', 'crew', 'ghost'], { phase: 'vote' });
    expect(submitProbe(s, 'p0', 'p1')).toBe(s);
  });

  it('ignores a disconnected seat trying to act', () => {
    const s = makeState(['crew', 'crew', 'crew', 'ghost']);
    const gone = { ...s, seats: s.seats.map((x) => (x.id === 'p0' ? { ...x, gone: true } : x)) };
    expect(submitProbe(gone, 'p0', 'p1')).toBe(gone);
  });

  it('knows when the night is complete', () => {
    let s = makeState(['crew', 'crew', 'crew', 'ghost']);
    expect(nightComplete(s)).toBe(false);
    s = submitProbe(s, 'p0', 'p1');
    s = submitProbe(s, 'p1', 'p2');
    s = submitProbe(s, 'p2', 'p3');
    s = submitProbe(s, 'p3', 'p0');
    expect(nightComplete(s)).toBe(false); // the Ghost still owes a cut
    s = submitCut(s, 'p3', 'p0');
    expect(nightComplete(s)).toBe(true);
  });

  it('only lets a Ghost cut a wire', () => {
    const s = makeState(['crew', 'crew', 'crew', 'ghost']);
    expect(submitCut(s, 'p0', 'p1')).toBe(s);
    expect(submitCut(s, 'p3', 'p1')).not.toBe(s);
  });
});

describe('night resolution — the heart of the game', () => {
  it('publishes every Crew reading automatically and truthfully', () => {
    let s = makeState(['crew', 'crew', 'crew', 'ghost']);
    s = submitProbe(s, 'p0', 'p2');
    s = submitProbe(s, 'p1', 'p3');
    s = submitProbe(s, 'p2', 'p0');
    s = submitProbe(s, 'p3', 'p1');
    s = submitCut(s, 'p3', 'p9'); // invalid target — ignored
    s = submitCut(s, 'p3', 'p2');
    const truth1 = trueReading(s, 'p3');
    s = resolveNight(s);

    expect(s.phase).toBe('dawn');
    // p1 is Crew: their number is already on the board, and it is the truth.
    expect(s.claims['p1']).toBe(truth1);
    expect(s.readings['p1']).toBe(truth1);
    // p3 is the Ghost: they hold a reading but have published nothing yet.
    expect(s.readings['p3']).toBeDefined();
    expect(s.claims['p3']).toBeUndefined();
  });

  it('darkens the cut seat so they get no reading at all', () => {
    let s = makeState(['crew', 'crew', 'crew', 'ghost']);
    for (const [a, b] of [['p0', 'p1'], ['p1', 'p2'], ['p2', 'p3'], ['p3', 'p0']]) {
      s = submitProbe(s, a, b);
    }
    s = submitCut(s, 'p3', 'p0');
    s = resolveNight(s);
    expect(s.darkened).toBe('p0');
    expect(s.readings['p0']).toBeUndefined();
    expect(s.claims['p0']).toBeUndefined();
  });

  it('ticks the blackout clock every single night', () => {
    let s = makeState(['crew', 'crew', 'crew', 'ghost']);
    for (const [a, b] of [['p0', 'p1'], ['p1', 'p2'], ['p2', 'p3'], ['p3', 'p0']]) {
      s = submitProbe(s, a, b);
    }
    s = submitCut(s, 'p3', 'p0');
    expect(resolveNight(s).cuts).toBe(1);
  });

  it('breaks a Ghost cut tie deterministically from the seed', () => {
    const build = () => {
      let s = makeState(['crew', 'crew', 'crew', 'crew', 'ghost', 'ghost']);
      for (const id of ['p0', 'p1', 'p2', 'p3', 'p4', 'p5']) {
        s = submitProbe(s, id, id === 'p0' ? 'p1' : 'p0');
      }
      s = submitCut(s, 'p4', 'p0');
      s = submitCut(s, 'p5', 'p1');
      return resolveNight(s);
    };
    expect(build().darkened).toBe(build().darkened);
    expect(['p0', 'p1']).toContain(build().darkened);
  });
});

describe('claims — only Ghosts get to choose', () => {
  function toDawn(): GameState {
    let s = makeState(['crew', 'crew', 'crew', 'ghost']);
    for (const [a, b] of [['p0', 'p1'], ['p1', 'p2'], ['p2', 'p3'], ['p3', 'p1']]) {
      s = submitProbe(s, a, b);
    }
    s = submitCut(s, 'p3', 'p2');
    return resolveNight(s);
  }

  it('lets a Ghost publish a number that is not the truth', () => {
    const s = toDawn();
    const lie = s.readings['p3'] === 0 ? 1 : 0;
    const after = submitClaim(s, 'p3', lie);
    expect(after.claims['p3']).toBe(lie);
    expect(after.claims['p3']).not.toBe(s.readings['p3']);
  });

  it('refuses a claim from a Crew member — their number is not theirs to pick', () => {
    const s = toDawn();
    expect(submitClaim(s, 'p0', 3)).toBe(s);
  });

  it('refuses an out-of-range or non-integer claim', () => {
    const s = toDawn();
    expect(submitClaim(s, 'p3', -1)).toBe(s);
    expect(submitClaim(s, 'p3', 4)).toBe(s);
    expect(submitClaim(s, 'p3', 1.5)).toBe(s);
  });

  it('publishes the truth for a Ghost who never chose, rather than stalling', () => {
    const s = resolveDawn(toDawn());
    expect(s.phase).toBe('vote');
    const row = s.ledger.find((r) => r.by === 'p3')!;
    expect(row.claim).toBe(trueReading(toDawn(), 'p1'));
  });

  it('writes a ledger row per probe, with the window it was taken in', () => {
    const dawn = toDawn();
    const s = resolveDawn(dawn);
    expect(s.ledger).toHaveLength(4);
    const row = s.ledger.find((r) => r.by === 'p0')!;
    expect(row.target).toBe('p1');
    expect(row.window).toEqual(windowOf(dawn, 'p1'));
    expect(row.round).toBe(1);
  });

  it('marks the darkened seat dark, with no number', () => {
    const s = resolveDawn(toDawn());
    const row = s.ledger.find((r) => r.by === 'p2')!;
    expect(row.dark).toBe(true);
    expect(row.claim).toBeNull();
  });
});

describe('voting', () => {
  const atVote = (roles: Role[], o: Partial<GameState> = {}) =>
    makeState(roles, { phase: 'vote', ...o });

  it('ejects the plurality target and reveals their role', () => {
    let s = atVote(['crew', 'crew', 'crew', 'ghost']);
    s = submitVote(s, 'p0', 'p3');
    s = submitVote(s, 'p1', 'p3');
    s = submitVote(s, 'p2', 'p3');
    s = submitVote(s, 'p3', 'p0');
    expect(votesComplete(s)).toBe(true);
    const after = resolveVote(s);
    expect(after.lastEjected).toEqual({ id: 'p3', role: 'ghost', round: 1 });
    expect(after.seats.find((x) => x.id === 'p3')!.alive).toBe(false);
  });

  it('ejects nobody on a tie — the round is simply wasted', () => {
    let s = atVote(['crew', 'crew', 'crew', 'crew', 'crew', 'ghost'], { cuts: 1 });
    s = submitVote(s, 'p0', 'p1');
    s = submitVote(s, 'p1', 'p0');
    s = submitVote(s, 'p2', 'p3');
    s = submitVote(s, 'p3', 'p2');
    s = submitVote(s, 'p4', 'p5');
    s = submitVote(s, 'p5', 'p4');
    const after = resolveVote(s);
    expect(after.lastEjected).toBeNull();
    expect(after.seats.every((x) => x.alive)).toBe(true);
  });

  it('rejects a vote for an already-ejected seat', () => {
    const s = atVote(['crew', 'crew', 'crew', 'ghost']);
    const dead = { ...s, seats: s.seats.map((x) => (x.id === 'p3' ? { ...x, alive: false } : x)) };
    expect(submitVote(dead, 'p0', 'p3')).toBe(dead);
  });
});

describe('win conditions', () => {
  it('gives the Crew the win when the last Ghost is ejected', () => {
    let s = makeState(['crew', 'crew', 'crew', 'ghost'], { phase: 'vote', cuts: 1 });
    for (const v of ['p0', 'p1', 'p2']) s = submitVote(s, v, 'p3');
    s = submitVote(s, 'p3', 'p0');
    const after = resolveVote(s);
    expect(after.winner).toBe('crew');
    expect(after.phase).toBe('over');
  });

  it('gives the Ghosts the win at blackout', () => {
    let s = makeState(['crew', 'crew', 'crew', 'crew', 'crew', 'ghost'], {
      phase: 'vote',
      cuts: 3, // blackoutAt for 1 Ghost
    });
    for (const v of ['p0', 'p1', 'p2', 'p3', 'p4', 'p5']) s = submitVote(s, v, 'p0');
    const after = resolveVote(s);
    expect(after.winner).toBe('ghosts');
  });

  it('lets the Crew win on the very night the lights were due to go out', () => {
    // Ejecting the last Ghost beats the blackout — Crew win takes priority.
    let s = makeState(['crew', 'crew', 'crew', 'ghost'], { phase: 'vote', cuts: 3 });
    for (const v of ['p0', 'p1', 'p2']) s = submitVote(s, v, 'p3');
    const after = resolveVote(s);
    expect(after.winner).toBe('crew');
  });

  it('gives the Ghosts the win when they reach parity with the Crew', () => {
    let s = makeState(['crew', 'crew', 'ghost'], { phase: 'vote', cuts: 1 });
    s = { ...s, ghostCount: 1, blackoutAt: 3 };
    for (const v of ['p0', 'p1', 'p2']) s = submitVote(s, v, 'p0');
    const after = resolveVote(s);
    // 1 Crew vs 1 Ghost — nobody left to outvote them.
    expect(after.winner).toBe('ghosts');
  });
});

describe('round advance', () => {
  it('clears the round scratch state and starts the next night', () => {
    const s = makeState(['crew', 'crew', 'crew', 'crew', 'ghost'], {
      phase: 'resolve',
      cuts: 1,
      probes: { p0: 'p1' },
      readings: { p0: 1 },
      claims: { p0: 1 },
      votes: { p0: 'p1' },
      cutVotes: { p4: 'p0' },
      darkened: 'p0',
      lastEjected: { id: 'x', role: 'crew', round: 1 },
    });
    const n = nextRound(s);
    expect(n.round).toBe(2);
    expect(n.phase).toBe('night');
    expect(n.probes).toEqual({});
    expect(n.readings).toEqual({});
    expect(n.claims).toEqual({});
    expect(n.votes).toEqual({});
    expect(n.cutVotes).toEqual({});
    expect(n.darkened).toBeNull();
    expect(n.lastEjected).toBeNull();
    expect(n.cuts).toBe(1); // the clock does NOT rewind
  });

  it('keeps the ledger across rounds — old claims stay evidence', () => {
    const s = makeState(['crew', 'crew', 'crew', 'ghost'], {
      phase: 'resolve',
      ledger: [{ round: 1, by: 'p0', target: 'p1', window: ['p0', 'p1', 'p2'], claim: 1, truth: null, dark: false }],
    });
    expect(nextRound(s).ledger).toHaveLength(1);
  });
});

describe('secrecy — what a client is allowed to see', () => {
  it('never leaks an unrevealed role in the public view', () => {
    for (let seed = 0; seed < 50; seed++) {
      const s = deal(seed, table(8));
      const pub = publicView(s);
      expect(pub.seats.every((x) => x.role === null)).toBe(true);
      // Nothing role-shaped rides along in the seat payload. (The state as a
      // whole legitimately mentions `ghostCount` — that's public.)
      expect(JSON.stringify(pub.seats)).not.toContain('ghost');
      expect(JSON.stringify(pub.seats)).not.toContain('crew');
    }
  });

  it('reveals a role only once the seat is ejected', () => {
    const s = makeState(['crew', 'crew', 'crew', 'ghost'], {
      seats: makeState(['crew', 'crew', 'crew', 'ghost']).seats.map((x) =>
        x.id === 'p3' ? { ...x, alive: false } : x,
      ),
      ejections: [{ id: 'p3', role: 'ghost', round: 1 }],
    });
    const pub = publicView(s);
    expect(pub.seats.find((x) => x.id === 'p3')!.role).toBe('ghost');
    expect(pub.seats.find((x) => x.id === 'p0')!.role).toBeNull();
  });

  it('reveals every role at game over', () => {
    const s = makeState(['crew', 'crew', 'crew', 'ghost'], { phase: 'over', winner: 'crew' });
    expect(publicView(s).seats.every((x) => x.role !== null)).toBe(true);
  });

  it('reports WHO has acted without leaking WHAT they did', () => {
    let s = makeState(['crew', 'crew', 'crew', 'ghost']);
    s = submitProbe(s, 'p0', 'p1');
    const pub = publicView(s);
    expect(pub.acted).toEqual(['p0']);
    expect(JSON.stringify(pub)).not.toContain('"p0":"p1"');
  });

  it('tells a Ghost who their allies are, and a Crew member nothing', () => {
    const s = makeState(['crew', 'crew', 'ghost', 'ghost']);
    expect(privateView(s, 'p2')!.allies).toEqual(['p3']);
    expect(privateView(s, 'p0')!.allies).toEqual([]);
    expect(privateView(s, 'p0')!.role).toBe('crew');
    expect(privateView(s, 'nobody')).toBeNull();
  });
});
