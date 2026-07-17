/**
 * modes.test.ts — the host's mode is what the table plays, and every mode is
 * actually a game.
 *
 * Two separate claims here, and the second is the one that bites.
 *
 * The first is agreement: a mode changes how many liars are dealt AND how long
 * the night lasts, so two peers resolving it differently are not playing the
 * same game at the same table — the same class of bug as roster drift. It
 * therefore travels frozen inside the round start, and an id off the wire is
 * never trusted.
 *
 * The second is viability. A mode that adds a Ghost is not "harder", it can be
 * OVER: checkWin ends the game the moment ghosts >= crew, so an extra liar at a
 * table of six hands the Ghosts a win before the first probe. That is not a
 * thing to reason about and hope — the bots solve this ledger for real, so the
 * modes are played out and MEASURED here.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODE,
  MODES,
  MODE_LIST,
  maxGhostsFor,
  modeMeta,
  modeOf,
  rulesFor,
  type Mode,
} from '../src/modes';
import { MAX_SEATS, MIN_SEATS, ghostCountFor, deal } from '../src/game';
import { Session } from '../src/session';
import type { PublicState } from '../src/game';

describe('modeOf', () => {
  it('resolves a known id', () => {
    expect(modeOf('blackout').cutSlack).toBe(1);
    expect(modeOf('inquest').deadlines.vote).toBe(90_000);
  });

  it('falls back rather than handing the deal an undefined table', () => {
    // A start from an older peer, a corrupted store, or a hand-edited message.
    // Without the fallback this is rulesFor(undefined) -> NaN Ghosts, and that
    // does not crash: it deals a table with NO Ghosts, the Crew win on night one
    // and nobody ever finds out why.
    for (const bad of [undefined, null, '', 'nope', 42, {}, ['inquest']]) {
      expect(modeOf(bad as unknown).id).toBe(DEFAULT_MODE);
      const r = rulesFor(modeOf(bad as unknown), 6);
      expect(Number.isInteger(r.ghosts)).toBe(true);
      expect(r.ghosts).toBeGreaterThan(0);
    }
  });

  it('resolves a hostile id off the wire without inheriting from Object', () => {
    // MODES is an object literal, so 'constructor' / 'toString' are truthy on it.
    // Returning one of those as a Mode would put `undefined` in every field —
    // the exact Ghost-less table the fallback above exists to prevent, reached
    // through the one input it exists to distrust.
    for (const bad of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(modeOf(bad).id).toBe(DEFAULT_MODE);
      expect(rulesFor(modeOf(bad), 6).ghosts).toBeGreaterThan(0);
    }
  });
});

describe('the modes are actually different games', () => {
  it('offers a real spread of clock and nights — no two feel the same', () => {
    const nights = new Set(MODE_LIST.map((m) => rulesFor(m, 8).blackoutAt));
    const clocks = new Set(MODE_LIST.map((m) => m.deadlines.night));
    expect(nights.size).toBe(MODE_LIST.length);
    expect(clocks.size).toBe(MODE_LIST.length);
    // Not a rounding difference: the slowest mode gives you well over triple the
    // night of the fastest, which is the difference between a gut call and an
    // argument.
    expect(MODES.inquest.deadlines.night).toBeGreaterThan(MODES.blackout.deadlines.night * 3);
  });

  it('changes the shape of the ledger, not just the numbers on it', () => {
    // Nights are the resource the whole game is played against: every night cuts
    // exactly one wire, so blackoutAt IS how many ledger rounds can ever exist.
    expect(rulesFor(MODES.blackout, 8).blackoutAt).toBeLessThan(
      rulesFor(MODES.standard, 8).blackoutAt,
    );
    expect(rulesFor(MODES.inquest, 8).blackoutAt).toBeGreaterThan(
      rulesFor(MODES.standard, 8).blackoutAt,
    );
    // And at a big table Inquest deals a liar the others do not.
    expect(rulesFor(MODES.inquest, 8).ghosts).toBe(rulesFor(MODES.standard, 8).ghosts + 1);
  });

  it('deals the table its mode asks for', () => {
    for (const m of MODE_LIST) {
      for (let seats = MIN_SEATS; seats <= MAX_SEATS; seats++) {
        const r = rulesFor(m, seats);
        const s = deal(1, table(seats), r);
        expect(s.ghostCount, `${m.id}/${seats}`).toBe(r.ghosts);
        expect(s.seats.filter((x) => x.role === 'ghost')).toHaveLength(r.ghosts);
        expect(s.blackoutAt, `${m.id}/${seats}`).toBe(r.blackoutAt);
      }
    }
  });
});

describe('rulesFor keeps every table winnable', () => {
  it('never deals a table the Ghosts have already won', () => {
    for (const m of MODE_LIST) {
      for (let seats = MIN_SEATS; seats <= MAX_SEATS; seats++) {
        const { ghosts } = rulesFor(m, seats);
        const crew = seats - ghosts;
        // checkWin: ghosts >= crew is an instant Ghost win. The bar is stricter —
        // the Crew must survive one wrong ejection, or the game is a coin flip
        // with extra steps.
        expect(crew - ghosts, `${m.id}/${seats}`).toBeGreaterThanOrEqual(2);
        expect(ghosts).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('declines the extra Ghost exactly where it would break the table', () => {
    // 6 seats + Inquest's bonus would be 3 Ghosts vs 3 Crew — over before the
    // first probe. The clamp is the reason Inquest is a mode and not a bug.
    expect(ghostCountFor(6) + MODES.inquest.ghostBonus).toBe(3);
    expect(rulesFor(MODES.inquest, 6).ghosts).toBe(2);
    expect(maxGhostsFor(6)).toBe(2);
    // At 8 there is room for it, so it is taken.
    expect(rulesFor(MODES.inquest, 8).ghosts).toBe(3);
  });

  it('takes the extra night back with the ghost it was meant to pay for', () => {
    // Found by measuring, not by thinking. Nights only ever help the Crew, so a
    // mode that keeps its extra night after the clamp declines its extra Ghost
    // is not "a longer Standard" — it is the mode the Crew cannot lose. Inquest
    // at 5 seats scored 0 Ghost wins in 200 games before this.
    for (const seats of [4, 5, 6, 7, 9]) {
      const inq = rulesFor(MODES.inquest, seats);
      const std = rulesFor(MODES.standard, seats);
      expect(inq.ghosts, `inquest/${seats} ghosts`).toBe(std.ghosts);
      expect(inq.blackoutAt, `inquest/${seats} nights`).toBe(std.blackoutAt);
    }
    // Where the Ghost IS dealt, the night comes with it.
    for (const seats of [8, 10]) {
      const inq = rulesFor(MODES.inquest, seats);
      expect(inq.ghosts).toBe(rulesFor(MODES.standard, seats).ghosts + 1);
      expect(inq.blackoutAt).toBe(rulesFor(MODES.standard, seats).blackoutAt + 2);
    }
  });

  it('still gives the meta line real numbers at every size', () => {
    for (const m of MODE_LIST) {
      for (let seats = MIN_SEATS; seats <= MAX_SEATS; seats++) {
        expect(modeMeta(m, seats)).toMatch(/^\d+ nights · \d+s$/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Viability — measured, not assumed.
// ---------------------------------------------------------------------------

const table = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, bot: true }));

/**
 * Play a whole table out with bots on every seat, on a fake clock.
 *
 * Solo has no deadlines (session.ts: `expired` is false), so this measures the
 * BALANCE of a mode's ghost count and night budget, which is what the clamp is
 * about — not its clock. The clock is a human-attention knob and no bot can
 * speak to it.
 */
function playOut(seed: number, seats: number, mode: Mode): PublicState {
  let t = 0;
  let last: PublicState | null = null;
  const s = new Session({
    selfId: 'p0',
    solo: true,
    rules: rulesFor(mode, seats),
    deadlines: mode.deadlines,
    now: () => t,
    onPublic: (p) => {
      last = p;
    },
    onPrivate: () => {},
  });
  s.startAsHost(seed, table(seats));
  s.destroy(); // kill the real interval; we drive tick() ourselves
  for (let i = 0; i < 2000 && !(last as PublicState | null)?.winner; i++) {
    t += 1000;
    s.tick();
  }
  return last!;
}

interface Tally {
  crew: number;
  ghosts: number;
  unfinished: number;
  rounds: number;
}

function measure(mode: Mode, seats: number, games: number): Tally {
  const out: Tally = { crew: 0, ghosts: 0, unfinished: 0, rounds: 0 };
  for (let seed = 0; seed < games; seed++) {
    const pub = playOut(seed, seats, mode);
    out.rounds += pub.round;
    if (pub.winner === 'crew') out.crew++;
    else if (pub.winner === 'ghosts') out.ghosts++;
    else out.unfinished++;
  }
  return out;
}

describe('every mode is a game the bots can actually finish', () => {
  const SIZES = [4, 6, 8, 10];
  const GAMES = 30;
  /**
   * Sample size for the comparisons, and it is not padding.
   *
   * Ghost wins are rare enough against these bots (3-15%) that 30 games is not a
   * measurement, it is a rumour: at 8 seats it reported Standard 16.7% / Inquest
   * 3.3%, and at N=1000 the same code reports 3.4% / 9.1% — the sign flips. A
   * balance claim read off 30 games would have shipped a mode tuned backwards.
   * The sim is deterministic (seeded rng, fake clock), so this is exact, not
   * flaky — it just has to be big enough to be true.
   */
  const COMPARE = 400;

  it('always reaches a winner — no mode can hang the table', () => {
    for (const m of MODE_LIST) {
      for (const seats of SIZES) {
        const t = measure(m, seats, GAMES);
        expect(t.unfinished, `${m.id}/${seats} unfinished`).toBe(0);
        expect(t.crew + t.ghosts).toBe(GAMES);
      }
    }
  });

  it('is not decided before it is played — both sides win, in every mode', () => {
    // The failure this catches is not "unbalanced", it is DEGENERATE: a mode
    // where one side cannot lose is not a mode, and the numbers that produce it
    // (one Ghost too many, one night too few) look perfectly reasonable in the
    // table above. Measured across sizes, since a mode can be fine at 8 and
    // hopeless at 4.
    for (const m of MODE_LIST) {
      const t = measure(m, 8, COMPARE);
      expect(t.crew, `${m.id} crew wins`).toBeGreaterThan(0);
      expect(t.ghosts, `${m.id} ghost wins`).toBeGreaterThan(0);
    }
  });

  it('swings the game to the Ghosts under Blackout, at every table size', () => {
    // The mode's whole claim, measured: taking a night away is not a cosmetic
    // number, it is the Ghosts' mode. It roughly doubles their wins at every
    // size — 53/400 vs 16/400 at 8 seats, 182/400 vs 132/400 at 4.
    for (const seats of [4, 5, 6, 7, 8, 9, 10]) {
      const fast = measure(MODES.blackout, seats, COMPARE).ghosts;
      const base = measure(MODES.standard, seats, COMPARE).ghosts;
      expect(fast, `blackout/${seats} ghost wins vs standard's ${base}`).toBeGreaterThan(base);
    }
  });

  it('never makes Inquest the mode the Crew cannot lose', () => {
    // The measured half of the "extra night rides with the ghost" rule above.
    // That test pins the numbers; this pins what the numbers are FOR — at no
    // size may Inquest hand the Ghosts a worse game than Standard, because a
    // mode sold as "more liars, more nights" that is quietly the Crew's easiest
    // table is a lie told to whoever picked it.
    //
    // Below 8 seats the clamp declines the liar, so Inquest deals Standard's
    // exact table and the sim is deterministic: EQUAL, not merely close. That
    // exactness is the assertion — it is what the night-give-back buys.
    for (const seats of [4, 5, 6, 7, 9]) {
      const inq = measure(MODES.inquest, seats, COMPARE).ghosts;
      const std = measure(MODES.standard, seats, COMPARE).ghosts;
      expect(inq, `inquest/${seats} ghost wins vs standard's ${std}`).toBe(std);
    }
  });

  it('makes Inquest harder for the Crew where the extra liar is actually dealt', () => {
    // 8 and 10 seats are where Inquest earns its name: an extra Ghost, and the
    // extra nights that pay for it. If the liar did not show up in the OUTCOME,
    // the mode would just be a longer wait. Measured: 26/400 vs 16/400 at 8,
    // 58/400 vs 27/400 at 10.
    for (const seats of [8, 10]) {
      const inq = measure(MODES.inquest, seats, COMPARE).ghosts;
      const std = measure(MODES.standard, seats, COMPARE).ghosts;
      expect(inq, `inquest/${seats} ghost wins vs standard's ${std}`).toBeGreaterThan(std);
    }
  });

  it('spends the night budget it advertises — Blackout really is shorter', () => {
    // The mode promises fewer nights; a mode whose extra nights never actually
    // get played is a label, not a mode.
    const mean = (m: Mode): number => measure(m, 8, 40).rounds / 40;
    expect(mean(MODES.blackout)).toBeLessThan(mean(MODES.standard));
    expect(mean(MODES.standard)).toBeLessThan(mean(MODES.inquest));
  });

  it('costs little enough to deal inline', () => {
    // Nightwire's expensive mode is the big one: 10 seats, 4 Ghosts, 7 nights,
    // and a bot on every seat solving the ledger each phase. If a whole game is
    // cheap, dealing one certainly is.
    playOut(0, 10, MODES.inquest); // warm
    const t0 = performance.now();
    const N = 10;
    for (let i = 0; i < N; i++) playOut(i, 10, MODES.inquest);
    const per = (performance.now() - t0) / N;
    expect(per, `inquest/10 full game: ${per.toFixed(2)}ms`).toBeLessThan(150);
  });
});
