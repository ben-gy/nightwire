/**
 * authority.test.ts — who is allowed to run the table.
 *
 * There is ONE host of a room and net.ts owns it: the incumbent keeps the role
 * until it leaves. The table, though, is dealt to a FROZEN ROSTER, and the two
 * lists stop agreeing the moment anyone opens the invite link mid-game. So
 * authorityFor() takes net.ts's answer and only overrides it in the single case
 * net.ts cannot see — a room host that holds no seat at this table.
 *
 * Both directions are fatal if you get them wrong:
 *  - Ignore the incumbent and elect min-id locally, and a seated peer with a
 *    low id steals the table from the peer that dealt it. net.ts no longer
 *    elects by min-id, so this is now reachable in a perfectly ordinary game.
 *  - Follow the room blindly, and a spectator who just followed the link is
 *    handed a table it holds no state for, and the game dies for everyone.
 */

import { describe, it, expect } from 'vitest';
import { Session, GAME_CHANNELS, type Transport } from '../src/session';
import { createRounds } from '../src/engine/rematch';
import { deal, type PublicState } from '../src/game';

const specs = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, bot: false }));
const roster = (n: number) => specs(n).map((s) => s.id);

const silent: Transport = {
  sendSnap() {},
  sendPriv() {},
  sendAct() {},
  requestRoles() {},
  sendRole() {},
};

/** A seed where p0 is Crew, so the host leaving doesn't just end the game. */
function seedWithCrewHost(n: number): number {
  for (let s = 1; s < 2000; s++) {
    if (deal(s, specs(n)).seats.find((x) => x.id === 'p0')!.role === 'crew') return s;
  }
  throw new Error('no seed with a Crew host');
}

function hostSession(n = 6): Session {
  const s = new Session({
    selfId: 'p0',
    solo: false,
    transport: silent,
    roster: roster(n),
    onPublic: () => {},
    onPrivate: () => {},
  });
  s.startAsHost(seedWithCrewHost(n), specs(n));
  s.stop();
  return s;
}

describe('authorityFor — the room has one host, and a seated one keeps the deal', () => {
  it('defers to the incumbent even when a seated peer sorts lower', () => {
    // The exact shape net.ts's incumbency now produces: 'p2' minted the room and
    // hosts it, while 'p0' and 'p1' are seated and sort below. A local min-id
    // rule would hand the table to 'p0' — which is the join-time host theft all
    // over again, one layer down, and 'p0' holds no authoritative state.
    const host = hostSession();
    expect(host.authorityFor(['p0', 'p1', 'p2'], 'p2')).toBe('p2');
  });

  it('ignores a mid-game joiner, however low their id sorts', () => {
    const host = hostSession();
    // 'aaa' followed an invite link into a game already in progress.
    expect(host.authorityFor(['aaa', 'p0', 'p1', 'p2'], 'p0')).toBe('p0');
  });

  it('falls back to the lowest seated survivor when the ROOM host holds no seat', () => {
    // The real host left, and the room elected the spectator that arrived on the
    // link. It has no snapshots and can never run the table; the seated peers
    // all compute the same replacement without talking to each other.
    const host = hostSession();
    expect(host.authorityFor(['aaa', 'p1', 'p2'], 'aaa')).toBe('p1');
  });

  it('still migrates to the next seated peer when the host leaves', () => {
    const host = hostSession();
    expect(host.authorityFor(['aaa', 'p1', 'p2'], 'p1')).toBe('p1');
  });

  it('elects within the roster while the room has not settled on a host', () => {
    // net.host() is null until net.ts settles. That is "no incumbent", not
    // "elect me": main.ts holds off entirely, and this stays deterministic.
    const host = hostSession();
    expect(host.authorityFor(['aaa', 'p0', 'p1'], null)).toBe('p0');
  });

  it('returns null when nobody seated is left in the room', () => {
    const host = hostSession();
    expect(host.authorityFor(['aaa', 'zzz'], 'aaa')).toBeNull();
  });

  it('does NOT demote the real host when a spectator arrives', () => {
    const host = hostSession();
    const peers = ['aaa', 'p0', 'p1'];

    // This is exactly what main.ts does on every roster change.
    host.setHost(host.authorityFor(peers, 'p0') === 'p0');

    expect(host.hosting()).toBe(true);
    // The killer symptom: a demoted host throws its authoritative state away and
    // the table can never advance again.
    expect(host.authoritative()).not.toBeNull();
  });
});

describe('setHost — a spectator can never take the deal', () => {
  it('refuses promotion for a peer with no seat at this table', () => {
    const pub = { seats: specs(6).map((s) => ({ ...s, role: null, alive: true, gone: false })) };
    const spectator = new Session({
      selfId: 'aaa',
      solo: false,
      transport: silent,
      roster: roster(6),
      onPublic: () => {},
      onPrivate: () => {},
    });
    // They can watch — snapshots reach every peer in the room.
    spectator.onSnapshot(pub as PublicState);
    spectator.setHost(true);

    expect(spectator.hosting()).toBe(false);
    expect(spectator.authoritative()).toBeNull();
  });
});

describe('setHost — promoted with nothing to rebuild from', () => {
  it('hands the player back to the lobby instead of freezing the table forever', () => {
    const flashes: string[] = [];
    let stranded = 0;
    const s = new Session({
      selfId: 'p1',
      solo: false,
      transport: silent,
      roster: roster(6),
      onPublic: () => {},
      onPrivate: () => {},
      onFlash: (m) => flashes.push(m),
      onStranded: () => stranded++,
    });

    // Promoted before a single snapshot ever arrived. There is no state to
    // rebuild and no attest can produce one: this used to set isHost, keep
    // state null, and leave the player watching a table that never ticks again.
    s.setHost(true);

    expect(stranded).toBe(1);
    expect(s.hosting()).toBe(false);
    expect(flashes.join(' ')).toMatch(/lobby/i);
  });
});

describe('channel names — the table and the rematch must not share one', () => {
  it('keeps GAME_CHANNELS disjoint from the round protocol', () => {
    const registered: string[] = [];
    const net = {
      selfId: 'a',
      peers: () => ['a'],
      host: () => 'a',
      isHost: () => true,
      hostSettled: () => true,
      count: () => 1,
      channel: (name: string) => {
        registered.push(name);
        const send = Object.assign(() => {}, { off: () => {} });
        return send;
      },
      ping: async () => 0,
      leave: async () => {},
    };
    const rounds = createRounds({
      net: net as never,
      playerName: 'A',
      onRound: () => {},
    });

    const game = Object.values(GAME_CHANNELS);
    // net.channel() fans out now: a shared name means BOTH handlers fire. If the
    // role re-attest still answered on 'rq', every rematch resync poll would make
    // each peer publish its own secret role — mid-game, to whoever asked.
    expect(registered).toContain('rq');
    expect(game.filter((n) => registered.includes(n))).toEqual([]);
    for (const n of game) expect(n.length).toBeLessThanOrEqual(12);

    rounds.destroy();
  });
});
