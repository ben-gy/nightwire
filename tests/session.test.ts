/**
 * MULTIPLAYER CONTRACT GATE #2 — host transfer.
 *
 * The host leaving must not freeze or end the table. These tests drive the
 * takeover with no network at all: a client session is promoted, rebuilds the
 * role table by asking each survivor to attest their OWN role, and then has to
 * carry the game all the way to game-over on its own.
 */

import { describe, it, expect } from 'vitest';
import { Session, type Transport, type Action } from '../src/session';
import { deal, privateView, type PublicState, type PrivateView, type Role } from '../src/game';

const specs = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, bot: false }));

/**
 * Pick a seed where the host (p0) is Crew. Otherwise the host walking out ends
 * the game instantly — the last Ghost left — and we'd never exercise the
 * takeover we're actually here to test.
 */
function seedWithCrewHost(n: number): number {
  for (let s = 1; s < 2000; s++) {
    if (deal(s, specs(n)).seats.find((x) => x.id === 'p0')!.role === 'crew') return s;
  }
  throw new Error('no seed with a Crew host');
}

/**
 * A host (p0) and one client (p1) wired together, plus a fake clock so the
 * deadlines are drivable.
 */
function harness(n = 6, seed = seedWithCrewHost(n)) {
  let now = 0;
  const clock = () => now;

  let host: Session;
  let client: Session;
  const roleRequests: string[] = [];

  const hostTx: Transport = {
    sendSnap: (pub) => client.onSnapshot(pub),
    sendPriv: (to, priv) => {
      if (to === 'p1') client.onPrivate(priv);
    },
    sendAct: () => {},
    requestRoles: () => {},
    sendRole: () => {},
  };

  const clientTx: Transport = {
    sendSnap: () => {},
    sendPriv: () => {},
    sendAct: (a: Action) => host.onAction('p1', a),
    // p2 and p3 have no Session here; the test answers for them by hand.
    requestRoles: () => roleRequests.push('sent'),
    sendRole: () => {},
  };

  let clientPub: PublicState | null = null;
  let clientPriv: PrivateView | null = null;
  const flashes: string[] = [];

  host = new Session({
    selfId: 'p0',
    solo: false,
    transport: hostTx,
    onPublic: () => {},
    onPrivate: () => {},
    now: clock,
    deadlines: { night: 1000, dawn: 1000, vote: 1000 },
  });

  client = new Session({
    selfId: 'p1',
    solo: false,
    transport: clientTx,
    onPublic: (p) => {
      clientPub = p;
    },
    onPrivate: (p) => {
      clientPriv = p;
    },
    onFlash: (m) => flashes.push(m),
    now: clock,
    deadlines: { night: 1000, dawn: 1000, vote: 1000 },
  });

  host.startAsHost(seed, specs(n));
  host.stop(); // tests drive tick() by hand

  const roleOf = (id: string): Role => host.authoritative()!.seats.find((s) => s.id === id)!.role;

  return {
    host,
    client,
    flashes,
    roleRequests,
    n,
    advance: (ms: number) => {
      now += ms;
    },
    pub: () => clientPub,
    priv: () => clientPriv,
    roleOf,
    /** Answer the re-attest on behalf of every seat but the departed host and self. */
    attestAll: () => {
      for (let i = 2; i < n; i++) client.onRoleReply(`p${i}`, roleOf(`p${i}`));
    },
    /** Everyone probes, so the host can be pushed through a phase. */
    allProbe: () => {
      for (let i = 0; i < n; i++) {
        host.onAction(`p${i}`, { t: 'probe', target: i === 0 ? 'p1' : 'p0' });
      }
    },
  };
}

describe('host authority before any transfer', () => {
  it('gives the host authoritative state and the client none', () => {
    const h = harness();
    expect(h.host.hosting()).toBe(true);
    expect(h.host.authoritative()).not.toBeNull();
    expect(h.client.hosting()).toBe(false);
    expect(h.client.authoritative()).toBeNull();
  });

  it('sends each peer only its OWN secret', () => {
    const h = harness();
    const priv = h.priv()!;
    expect(priv.role).toBe(h.roleOf('p1'));
    // A Crew member learns nothing about anyone else.
    if (priv.role === 'crew') expect(priv.allies).toEqual([]);
  });

  it('does NOT let a client mutate shared state directly — it forwards instead', () => {
    const h = harness();
    h.client.act({ t: 'probe', target: 'p2' });
    // The client still holds no authoritative state...
    expect(h.client.authoritative()).toBeNull();
    // ...but the host applied the forwarded action.
    expect(h.host.authoritative()!.probes['p1']).toBe('p2');
  });
});

describe('CONTRACT GATE #2 — the promoted peer takes over', () => {
  it('asks every survivor to attest their own role, then assumes control', () => {
    const h = harness();
    const truth = Object.fromEntries(
      Array.from({ length: h.n }, (_, i) => [`p${i}`, h.roleOf(`p${i}`)]),
    );

    h.client.onPeerLeave('p0'); // the host closed their tab
    h.client.setHost(true);

    expect(h.roleRequests.length).toBeGreaterThan(0);
    expect(h.flashes.join(' ')).toMatch(/host now/i);
    // Not yet authoritative — it has no role table until people answer.
    expect(h.client.authoritative()).toBeNull();

    h.attestAll();

    const state = h.client.authoritative();
    expect(state).not.toBeNull();
    expect(h.client.hosting()).toBe(true);
    // The rebuilt table agrees exactly with what the old host actually dealt.
    for (let i = 1; i < h.n; i++) {
      expect(state!.seats.find((s) => s.id === `p${i}`)!.role).toBe(truth[`p${i}`]);
    }
    expect(state!.seats.filter((s) => s.role === 'ghost')).toHaveLength(state!.ghostCount);
  });

  it('only ever attests for itself when asked', () => {
    const sent: { to: string; role: Role }[] = [];
    let s: Session;
    s = new Session({
      selfId: 'p1',
      solo: false,
      transport: {
        sendSnap: () => {},
        sendPriv: () => {},
        sendAct: () => {},
        requestRoles: () => {},
        sendRole: (to, role) => sent.push({ to, role }),
      },
      onPublic: () => {},
      onPrivate: () => {},
    });
    s.onPrivate({ role: 'ghost', reading: null, probeTarget: null, cutTarget: null, allies: ['p3'] });
    s.onRoleRequest('p2');
    expect(sent).toEqual([{ to: 'p2', role: 'ghost' }]);
  });

  it('reveals and drops the departed host rather than waiting on them forever', () => {
    const h = harness();
    h.client.onPeerLeave('p0');
    h.client.setHost(true);
    h.attestAll();

    const seat = h.client.authoritative()!.seats.find((s) => s.id === 'p0')!;
    expect(seat.alive).toBe(false);
    expect(h.client.authoritative()!.ejections.some((e) => e.id === 'p0')).toBe(true);
  });

  it('proceeds on the timeout when a survivor never answers', () => {
    const h = harness();
    h.client.onPeerLeave('p0');
    h.client.setHost(true);
    for (let i = 2; i < h.n - 1; i++) h.client.onRoleReply(`p${i}`, h.roleOf(`p${i}`));
    expect(h.client.authoritative()).toBeNull(); // still waiting on the last seat

    h.advance(5_000);
    h.client.tick();

    expect(h.client.authoritative()).not.toBeNull(); // the table moves on
    expect(h.client.authoritative()!.seats.find((s) => s.id === `p${h.n - 1}`)!.alive).toBe(false);
  });

  it('keeps the Ghost count honest when a silent seat is dropped', () => {
    // A seat that never attests must not be quietly assumed Crew — that would
    // erase a Ghost from the table and hand the Crew a win they never earned.
    const h = harness();
    h.client.onPeerLeave('p0');
    h.client.setHost(true);
    for (let i = 2; i < h.n - 1; i++) h.client.onRoleReply(`p${i}`, h.roleOf(`p${i}`));
    h.advance(5_000);
    h.client.tick();

    const s = h.client.authoritative()!;
    expect(s.seats.filter((x) => x.role === 'ghost')).toHaveLength(s.ghostCount);
  });

  it('keeps the blackout clock honest when a night in flight is rewound', () => {
    const h = harness();
    // Push the host to dawn, so a cut has landed and cuts === 1.
    h.allProbe();
    h.advance(2000);
    h.host.tick();
    expect(h.host.authoritative()!.phase).toBe('dawn');
    expect(h.host.authoritative()!.cuts).toBe(1);

    h.client.onPeerLeave('p0');
    h.client.setHost(true);
    h.attestAll();

    const s = h.client.authoritative()!;
    // The round restarts, so the cut that belonged to it is taken back —
    // otherwise the takeover would quietly cost the Crew a whole round.
    expect(s.phase).toBe('night');
    expect(s.round).toBe(1);
    expect(s.cuts).toBe(0);
    expect(s.readings).toEqual({});
    expect(s.probes).toEqual({});
  });

  it('preserves a vote already in flight — those are public', () => {
    const h = harness();
    h.allProbe();
    h.advance(2000);
    h.host.tick(); // -> dawn
    h.advance(2000);
    h.host.tick(); // -> vote
    expect(h.host.authoritative()!.phase).toBe('vote');
    h.host.onAction('p2', { t: 'vote', target: 'p3' });

    h.client.onPeerLeave('p0');
    h.client.setHost(true);
    h.attestAll();

    const s = h.client.authoritative()!;
    expect(s.phase).toBe('vote');
    expect(s.votes['p2']).toBe('p3');
    expect(s.ledger.length).toBeGreaterThan(0);
  });

  /**
   * The one that matters most: after the host vanishes, the survivor must be
   * able to carry the game to a real ending. A frozen board is a failed run.
   */
  it('drives the game all the way to game-over after the takeover', () => {
    const h = harness();
    h.client.onPeerLeave('p0');
    h.client.setHost(true);
    h.attestAll();
    expect(h.client.authoritative()!.phase).not.toBe('over');

    // Nobody does anything at all — the deadlines alone must resolve the run.
    for (let i = 0; i < 400 && h.client.authoritative()!.phase !== 'over'; i++) {
      h.advance(1500);
      h.client.tick();
    }

    const s = h.client.authoritative()!;
    expect(s.phase).toBe('over');
    expect(s.winner).not.toBeNull();
    // It ended for a real reason, not by stalling out.
    expect(s.cuts >= s.blackoutAt || s.seats.filter((x) => x.alive && x.role === 'ghost').length === 0).toBe(true);
  });

  it('is idempotent — a repeated promotion does not re-deal the table', () => {
    const h = harness();
    h.client.onPeerLeave('p0');
    h.client.setHost(true);
    h.attestAll();
    const before = h.client.authoritative();
    h.client.setHost(true);
    expect(h.client.authoritative()).toBe(before);
  });
});

describe('peer leave — contract gate #3', () => {
  it('reveals a departed seat and never stalls the round on them', () => {
    const h = harness(6);
    const role = h.roleOf('p4');
    h.host.onPeerLeave('p4');
    const s = h.host.authoritative()!;
    expect(s.seats.find((x) => x.id === 'p4')!.alive).toBe(false);
    expect(s.ejections.find((e) => e.id === 'p4')!.role).toBe(role);
    expect(s.phase).not.toBe('over');
  });

  it('still reaches game-over with a seat gone', () => {
    const h = harness(6);
    h.host.onPeerLeave('p4');
    for (let i = 0; i < 400 && h.host.authoritative()!.phase !== 'over'; i++) {
      h.advance(1500);
      h.host.tick();
    }
    expect(h.host.authoritative()!.phase).toBe('over');
    expect(h.host.authoritative()!.winner).not.toBeNull();
  });
});

describe('solo — contract gate #5, playable if nobody ever joins', () => {
  function soloGame(seed: number) {
    let pub: PublicState | null = null;
    let now = 0;
    const s = new Session({
      selfId: 'me',
      solo: true,
      onPublic: (p) => {
        pub = p;
      },
      onPrivate: () => {},
      now: () => now,
    });
    s.startAsHost(seed, [
      { id: 'me', name: 'You', bot: false },
      ...Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, name: `B${i}`, bot: true })),
    ]);
    s.stop();
    return { s, tick: () => (now += 1000, s.tick()), pub: () => pub };
  }

  /** Play the human seat with the simplest legal move available. */
  function playHuman(s: Session) {
    const st = s.authoritative()!;
    const me = st.seats.find((x) => x.id === 'me')!;
    if (!me.alive) return;
    const priv = privateView(st, 'me')!;
    const others = st.seats.filter((x) => x.alive && x.id !== 'me').map((x) => x.id);
    if (others.length === 0) return;
    if (st.phase === 'night') {
      if (!st.probes['me']) s.act({ t: 'probe', target: others[0] });
      if (priv.role === 'ghost' && !st.cutVotes['me']) s.act({ t: 'cut', target: others[0] });
    } else if (st.phase === 'dawn') {
      if (priv.role === 'ghost' && priv.reading !== null && st.claims['me'] === undefined) {
        s.act({ t: 'claim', value: 0 });
      }
    } else if (st.phase === 'vote' && st.votes['me'] === undefined) {
      s.act({ t: 'vote', target: others[0] });
    }
  }

  it('plays a whole game against bots, start to finish, with no network', () => {
    for (const seed of [1234, 77, 2026]) {
      const g = soloGame(seed);
      for (let i = 0; i < 500 && g.s.authoritative()!.phase !== 'over'; i++) {
        playHuman(g.s);
        g.tick();
      }
      const st = g.s.authoritative()!;
      expect(st.phase).toBe('over');
      expect(st.winner).not.toBeNull();
      // It ended for a real reason.
      expect(st.cuts >= st.blackoutAt || st.seats.filter((x) => x.alive && x.role === 'ghost').length === 0).toBe(true);
      // Every role is on the table once it's done.
      expect(g.pub()!.seats.every((x) => x.role !== null)).toBe(true);
    }
  });

  it('never times the solo player out — the table waits for you to think', () => {
    const g = soloGame(1234);
    for (let i = 0; i < 200; i++) g.tick(); // hours pass; the human does nothing
    const st = g.s.authoritative()!;
    expect(st.phase).toBe('night');
    expect(st.round).toBe(1);
    expect(st.cuts).toBe(0);
  });

  it('has bots actually play — they probe, claim and vote on their own', () => {
    let now = 0;
    const s = new Session({
      selfId: 'me',
      solo: true,
      onPublic: () => {},
      onPrivate: () => {},
      now: () => now,
    });
    s.startAsHost(99, [
      { id: 'me', name: 'You', bot: false },
      ...Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, name: `B${i}`, bot: true })),
    ]);
    s.stop();
    s.tick();
    const st = s.authoritative()!;
    for (let i = 0; i < 5; i++) expect(st.probes[`b${i}`]).toBeDefined();
    expect(st.probes['me']).toBeUndefined(); // the human is never auto-played
  });
});
