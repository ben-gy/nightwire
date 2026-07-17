/**
 * session.ts — host authority, the clock, and the host takeover.
 *
 * The transport is injected, so every branch in here (including the takeover)
 * is drivable from a test with no network at all.
 *
 * Host-authoritative star:
 *   host  -> all : 'snap' public state
 *   host  -> one : 'priv' your role + your reading (nobody else's, ever)
 *   peer  -> host: 'act'  probe / cut / claim / vote
 *   host* -> all : 'rq'   new host asks everyone to re-attest their OWN role
 *   peer  -> host: 'rl'   my role (a peer can only ever attest for itself)
 *
 * Why 'rq'/'rl' exist: no peer is ever sent another peer's secret role, so a
 * promoted host has no role table. It rebuilds one by asking each surviving
 * player what they are. Every peer keeps its own role locally from the moment
 * it's dealt, precisely so it can answer.
 */

import {
  deal,
  resolveNight,
  resolveDawn,
  resolveVote,
  nextRound,
  submitProbe,
  submitCut,
  submitClaim,
  submitVote,
  publicView,
  privateView,
  checkWin,
  nightComplete,
  claimsComplete,
  votesComplete,
  activeSeats,
  livingRing,
  seatOf,
  type GameState,
  type PublicState,
  type PrivateView,
  type Role,
  type SeatSpec,
} from './game';
import { chooseProbe, chooseCut, chooseClaim, chooseVote, botRng } from './bot';
import { makeRng } from './engine/rng';

export type Action =
  | { t: 'probe'; target: string }
  | { t: 'cut'; target: string }
  | { t: 'claim'; value: number }
  | { t: 'vote'; target: string };

export interface Transport {
  sendSnap(pub: PublicState): void;
  sendPriv(to: string, priv: PrivateView): void;
  sendAct(a: Action): void;
  requestRoles(): void;
  sendRole(to: string, role: Role): void;
}

export interface SessionOpts {
  selfId: string;
  solo: boolean;
  transport?: Transport;
  onPublic: (pub: PublicState) => void;
  onPrivate: (priv: PrivateView | null) => void;
  onFlash?: (msg: string) => void;
  now?: () => number;
  /** Per-phase deadlines in ms. Solo has none — think as long as you like. */
  deadlines?: { night: number; dawn: number; vote: number };
}

const DEFAULT_DEADLINES = { night: 45_000, dawn: 25_000, vote: 45_000 };
/** How long a dead host's peers wait for role re-attests before continuing. */
export const ROLE_TIMEOUT_MS = 4_000;
/** The beat between an ejection reveal and the next night. */
const RESOLVE_PAUSE_MS = 4_000;
/**
 * Dawn is held briefly even once every number is in. Without it the phase
 * resolves in a single tick and the player never actually sees the reading they
 * just spent the night getting — the whole point of the round.
 */
const DAWN_MIN_MS = 2_600;

const noopTransport: Transport = {
  sendSnap() {},
  sendPriv() {},
  sendAct() {},
  requestRoles() {},
  sendRole() {},
};

export class Session {
  readonly selfId: string;
  private solo: boolean;
  private tx: Transport;
  private opts: SessionOpts;
  private now: () => number;
  private deadlines: { night: number; dawn: number; vote: number };

  /** Authoritative state. Non-null only while we are the host. */
  private state: GameState | null = null;
  /** The last public state we know — every peer has one. */
  private pub: PublicState | null = null;
  private priv: PrivateView | null = null;
  private isHost = false;

  /** Our own role, remembered from the moment we're dealt, so we can attest. */
  private myRole: Role | null = null;

  private phaseStartedAt = 0;
  private resolveAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  // Takeover bookkeeping.
  private awaitingRoles = false;
  private roleReplies = new Map<string, Role>();
  private roleDeadline = 0;
  /** Peers we've seen leave. Clients track this too, so that if we're promoted
   *  we don't sit waiting on a role attest from someone already gone. */
  private goneIds = new Set<string>();

  constructor(opts: SessionOpts) {
    this.opts = opts;
    this.selfId = opts.selfId;
    this.solo = opts.solo;
    this.tx = opts.transport ?? noopTransport;
    this.now = opts.now ?? (() => Date.now());
    this.deadlines = opts.deadlines ?? DEFAULT_DEADLINES;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Drive time-based logic off setInterval, never rAF alone: browsers freeze
   * rAF in a backgrounded tab, which would stall the whole table's clock.
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 250);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Deal the table and become the authority. */
  startAsHost(seed: number, specs: readonly SeatSpec[]): void {
    this.isHost = true;
    this.state = deal(seed, specs);
    this.myRole = seatOf(this.state, this.selfId)?.role ?? null;
    this.phaseStartedAt = this.now();
    this.publish();
    this.start();
  }

  /** A client's view of a fresh snapshot from the host. */
  onSnapshot(pub: PublicState): void {
    if (this.isHost) return; // we are the authority; ignore stale gossip
    this.pub = pub;
    this.opts.onPublic(pub);
  }

  /** A client's view of its own secret. */
  onPrivate(priv: PrivateView): void {
    this.priv = priv;
    this.myRole = priv.role;
    this.opts.onPrivate(priv);
  }

  destroy(): void {
    this.stop();
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /** An action taken by the local player. Hosts apply it; clients forward it. */
  act(a: Action): void {
    if (this.isHost) this.applyAction(this.selfId, a);
    else this.tx.sendAct(a);
  }

  /** An action arriving from a peer. Host-only. */
  onAction(from: string, a: Action): void {
    if (!this.isHost) return;
    this.applyAction(from, a);
  }

  private applyAction(from: string, a: Action): void {
    if (!this.state) return;
    const s = this.state;
    switch (a.t) {
      case 'probe':
        this.state = submitProbe(s, from, a.target);
        break;
      case 'cut':
        this.state = submitCut(s, from, a.target);
        break;
      case 'claim':
        this.state = submitClaim(s, from, a.value);
        break;
      case 'vote':
        this.state = submitVote(s, from, a.target);
        break;
    }
    if (this.state !== s) this.publish();
  }

  // -------------------------------------------------------------------------
  // Roster
  // -------------------------------------------------------------------------

  /**
   * A peer dropped. Their seat is revealed and leaves the game — a disconnect
   * shouldn't leave a secret role floating that no one can ever attest to, and
   * the table shouldn't sit waiting on someone who closed their laptop.
   */
  onPeerLeave(id: string): void {
    // Every peer records this, host or not — see goneIds.
    this.goneIds.add(id);
    if (this.awaitingRoles && this.haveAllRoles()) this.assumeControl();
    if (!this.isHost || !this.state) return;
    const seat = seatOf(this.state, id);
    if (!seat || !seat.alive) return;
    this.state = {
      ...this.state,
      seats: this.state.seats.map((x) => (x.id === id ? { ...x, alive: false, gone: true } : x)),
      ejections: [...this.state.ejections, { id, role: seat.role, round: this.state.round }],
      log: [
        ...this.state.log,
        `${seat.name} left the table — they were ${seat.role === 'ghost' ? 'a GHOST' : 'CREW'}.`,
      ],
    };
    this.state = checkWin(this.state);
    if (this.state.winner) this.state = { ...this.state, phase: 'over' };
    this.publish();
  }

  onRoster(): void {
    if (this.isHost) this.publish();
  }

  // -------------------------------------------------------------------------
  // Host transfer — contract gate #2
  // -------------------------------------------------------------------------

  /**
   * net.ts re-elected us. Take over the simulation so the game keeps advancing
   * and can still reach game-over.
   *
   * We can rebuild everything public from our last snapshot, but the roles were
   * never ours to hold — so ask every survivor to attest their own.
   */
  setHost(isHost: boolean): void {
    if (isHost === this.isHost) return;
    if (!isHost) {
      // Demoted (shouldn't normally happen — election is monotonic per roster).
      this.isHost = false;
      this.state = null;
      return;
    }
    this.isHost = true;

    if (this.state) {
      // We already hold authoritative state (e.g. we dealt this table).
      this.publish();
      return;
    }
    if (!this.pub || this.pub.phase === 'over') {
      this.opts.onFlash?.("You're the host now.");
      return;
    }

    this.awaitingRoles = true;
    this.roleReplies = new Map();
    if (this.myRole) this.roleReplies.set(this.selfId, this.myRole);
    this.roleDeadline = this.now() + ROLE_TIMEOUT_MS;
    this.tx.requestRoles();
    this.opts.onFlash?.("The host left — you're the host now. You hold the deal.");
    this.start();
  }

  /** Someone asked us to attest. We can only ever speak for ourselves. */
  onRoleRequest(from: string): void {
    if (this.myRole) this.tx.sendRole(from, this.myRole);
  }

  /** A survivor told us what they are. */
  onRoleReply(from: string, role: Role): void {
    if (!this.awaitingRoles) return;
    this.roleReplies.set(from, role);
    if (this.haveAllRoles()) this.assumeControl();
  }

  private haveAllRoles(): boolean {
    if (!this.pub) return false;
    return this.pub.seats
      .filter((s) => s.alive && s.role === null && !this.goneIds.has(s.id))
      .every((s) => this.roleReplies.has(s.id));
  }

  /**
   * Rebuild authoritative state from the last snapshot plus the attested roles.
   *
   * The current round's probes and readings were secret and died with the old
   * host, so a night/dawn in flight rewinds to the top of that same round —
   * un-ticking the cut if one had already landed, so the blackout clock stays
   * honest. A vote in flight survives intact: the ledger and the votes are
   * public, so we can resolve it exactly as the old host would have.
   */
  private assumeControl(): void {
    if (!this.pub) return;
    this.awaitingRoles = false;
    const pub = this.pub;

    // Seats whose role is still secret and who never answered the re-attest.
    const unattested = pub.seats
      .filter((s) => s.alive && s.role === null && !this.roleReplies.has(s.id))
      .map((s) => s.id)
      .sort();

    // Ghosts we can account for: revealed on the table, plus attested.
    let known = 0;
    for (const s of pub.seats) {
      if (s.role === 'ghost') known++;
      else if (s.role === null && this.roleReplies.get(s.id) === 'ghost') known++;
    }
    // Any Ghosts left over must be hiding among the silent seats. Assign them so
    // the Ghost count stays honest — defaulting everyone silent to Crew would
    // erase a Ghost and hand the Crew a win they never earned.
    const inferredGhosts = new Set(unattested.slice(0, Math.max(0, pub.ghostCount - known)));

    const roleFor = (id: string, revealed: Role | null): Role =>
      revealed ?? this.roleReplies.get(id) ?? (inferredGhosts.has(id) ? 'ghost' : 'crew');

    let state: GameState = {
      seed: pub.seed,
      seats: pub.seats.map((s) => ({
        id: s.id,
        name: s.name,
        role: roleFor(s.id, s.role),
        alive: s.alive,
        gone: s.gone,
        bot: s.bot,
      })),
      round: pub.round,
      phase: pub.phase,
      cuts: pub.cuts,
      blackoutAt: pub.blackoutAt,
      ghostCount: pub.ghostCount,
      probes: {},
      readings: {},
      claims: {},
      cutVotes: {},
      darkened: pub.darkened,
      votes: pub.votes,
      ledger: pub.ledger,
      ejections: pub.ejections,
      lastEjected: pub.lastEjected,
      winner: pub.winner,
      log: pub.log,
    };

    // Anyone who never attested has effectively left; reveal and drop them, so
    // the table isn't waiting on a seat nobody can hear from.
    for (const id of unattested) {
      const seat = state.seats.find((x) => x.id === id)!;
      state = {
        ...state,
        seats: state.seats.map((x) => (x.id === id ? { ...x, alive: false, gone: true } : x)),
        ejections: [...state.ejections, { id, role: seat.role, round: state.round }],
        log: [
          ...state.log,
          `${seat.name} is out of contact — they were ${seat.role === 'ghost' ? 'a GHOST' : 'CREW'}.`,
        ],
      };
    }

    if (state.phase === 'night' || state.phase === 'dawn') {
      const rewound = state.phase === 'dawn' ? Math.max(0, state.cuts - 1) : state.cuts;
      state = {
        ...state,
        phase: 'night',
        cuts: rewound,
        darkened: null,
        probes: {},
        readings: {},
        claims: {},
        cutVotes: {},
        log: [...state.log, `A new hand takes the deal. Night ${state.round} starts over.`],
      };
    }

    this.state = checkWin(state);
    this.phaseStartedAt = this.now();
    this.publish();
  }

  // -------------------------------------------------------------------------
  // The clock
  // -------------------------------------------------------------------------

  tick(): void {
    if (this.awaitingRoles && this.now() >= this.roleDeadline) {
      // Some survivor never answered — proceed with who we have rather than
      // leaving the table frozen forever.
      this.assumeControl();
      return;
    }
    if (!this.isHost || !this.state) return;
    const s = this.state;
    if (s.phase === 'over') return;

    if (this.solo) this.runBots();

    switch (this.state.phase) {
      case 'night':
        if (nightComplete(this.state) || this.expired('night')) {
          this.fillNight();
          this.state = resolveNight(this.state);
          this.enterPhase();
        }
        break;
      case 'dawn':
        if (
          (claimsComplete(this.state) && this.now() - this.phaseStartedAt >= DAWN_MIN_MS) ||
          this.expired('dawn')
        ) {
          this.state = resolveDawn(this.state);
          this.enterPhase();
        }
        break;
      case 'vote':
        if (votesComplete(this.state) || this.expired('vote')) {
          this.state = resolveVote(this.state);
          this.enterPhase();
          if (this.state.phase === 'resolve') this.resolveAt = this.now() + RESOLVE_PAUSE_MS;
        }
        break;
      case 'resolve':
        if (this.now() >= this.resolveAt) {
          this.state = nextRound(this.state);
          this.enterPhase();
        }
        break;
    }
  }

  private enterPhase(): void {
    this.phaseStartedAt = this.now();
    this.publish();
  }

  /** Solo has no deadlines — the table waits for you. P2P can't. */
  private expired(phase: 'night' | 'dawn' | 'vote'): boolean {
    if (this.solo) return false;
    return this.now() - this.phaseStartedAt >= this.deadlines[phase];
  }

  /** Nobody's silence stalls the night: fill in anything still missing. */
  private fillNight(): void {
    if (!this.state) return;
    const rng = makeRng(`${this.state.seed}:${this.state.round}:fill`);
    for (const id of activeSeats(this.state)) {
      if (!this.state.probes[id]) {
        const others = livingRing(this.state).filter((x) => x !== id);
        this.state = submitProbe(this.state, id, others[Math.floor(rng() * others.length)]);
      }
      const seat = seatOf(this.state, id)!;
      if (seat.role === 'ghost' && !this.state.cutVotes[id]) {
        const others = livingRing(this.state).filter((x) => x !== id);
        this.state = submitCut(this.state, id, others[Math.floor(rng() * others.length)]);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Bots (solo only — see bot.ts for why they can't exist in a P2P room)
  // -------------------------------------------------------------------------

  private runBots(): void {
    if (!this.state) return;
    const pub = publicView(this.state);
    for (const seat of this.state.seats) {
      if (!seat.bot || !seat.alive) continue;
      const priv = privateView(this.state, seat.id)!;
      const s = this.state;
      switch (s.phase) {
        case 'night':
          if (!s.probes[seat.id]) {
            this.state = submitProbe(this.state, seat.id, chooseProbe(pub, seat.id, priv, botRng(pub, seat.id, 'probe')));
          }
          if (seat.role === 'ghost' && !this.state.cutVotes[seat.id]) {
            this.state = submitCut(this.state, seat.id, chooseCut(pub, seat.id, priv, botRng(pub, seat.id, 'cut')));
          }
          break;
        case 'dawn':
          if (seat.role === 'ghost' && s.readings[seat.id] !== undefined && s.claims[seat.id] === undefined) {
            this.state = submitClaim(this.state, seat.id, chooseClaim(pub, seat.id, priv, botRng(pub, seat.id, 'claim')));
          }
          break;
        case 'vote':
          if (s.votes[seat.id] === undefined) {
            this.state = submitVote(this.state, seat.id, chooseVote(pub, seat.id, priv, botRng(pub, seat.id, 'vote')));
          }
          break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Publishing
  // -------------------------------------------------------------------------

  private publish(): void {
    if (!this.state) return;
    const pub = publicView(this.state);
    this.pub = pub;
    this.opts.onPublic(pub);
    this.tx.sendSnap(pub);

    const mine = privateView(this.state, this.selfId);
    if (mine) {
      this.priv = mine;
      this.myRole = mine.role;
      this.opts.onPrivate(mine);
    }

    // Each peer receives ONLY its own secret. Nobody holds anyone else's role.
    for (const seat of this.state.seats) {
      if (seat.bot || seat.id === this.selfId) continue;
      const p = privateView(this.state, seat.id);
      if (p) this.tx.sendPriv(seat.id, p);
    }
  }

  // -------------------------------------------------------------------------
  // Introspection (UI + tests)
  // -------------------------------------------------------------------------

  hosting(): boolean {
    return this.isHost;
  }
  publicState(): PublicState | null {
    return this.pub;
  }
  privateState(): PrivateView | null {
    return this.priv;
  }
  /** Test seam: the authoritative state, when we hold it. */
  authoritative(): GameState | null {
    return this.state;
  }
}
