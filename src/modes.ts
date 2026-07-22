// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * modes.ts — the shapes a table can take.
 *
 * Two knobs, and they are the two the whole game turns on: how long you get to
 * argue, and how many nights the Crew have before the lights go out. They are
 * not independent dials to fiddle with — they are one decision about what kind
 * of evidence the ledger holds by the time it matters:
 *
 *   Blackout — three-quarters of the clock gone and one night fewer. The ledger
 *     never gets big enough to cross-reference, so you are reading people, not
 *     numbers. A Ghost's lie usually never gets audited.
 *   Standard — the balance: enough nights to catch a liar out, enough clock to
 *     notice you have.
 *   Inquest — long arguments, extra nights, and at a big table one more liar.
 *     The ledger grows past what a Ghost can keep consistent, so the game turns
 *     into actually cross-examining it.
 *
 * The host picks; the choice travels frozen inside the round start (see
 * the engine's rematch.ts), so every peer plays the same table for the same length.
 * A mode each peer read from its own UI is a mode two peers can disagree about.
 */

import { ghostCountFor, type TableRules } from './game';

export type ModeId = 'blackout' | 'standard' | 'inquest';

export interface Mode {
  id: ModeId;
  name: string;
  /** One line, shown under the name — say what it FEELS like, not the numbers. */
  blurb: string;
  /** Per-phase deadlines in ms. Solo ignores them; a P2P table cannot. */
  deadlines: { night: number; dawn: number; vote: number };
  /** Ghosts on top of the table's default count. Clamped — see maxGhostsFor. */
  ghostBonus: number;
  /** Nights the Crew get = ghosts + this. One wire is cut every single night. */
  cutSlack: number;
}

export const MODES: Record<ModeId, Mode> = {
  blackout: {
    id: 'blackout',
    name: 'Blackout',
    blurb: 'Half the clock, one night fewer. No time to build a case.',
    deadlines: { night: 20_000, dawn: 12_000, vote: 20_000 },
    ghostBonus: 0,
    cutSlack: 1,
  },
  standard: {
    id: 'standard',
    name: 'Standard',
    blurb: 'The full table. Enough nights to catch a liar out.',
    deadlines: { night: 45_000, dawn: 25_000, vote: 45_000 },
    ghostBonus: 0,
    cutSlack: 2,
  },
  inquest: {
    id: 'inquest',
    name: 'Inquest',
    blurb: 'Long arguments, more nights — and at a big table, one more liar.',
    deadlines: { night: 75_000, dawn: 40_000, vote: 90_000 },
    ghostBonus: 1,
    cutSlack: 3,
  },
};

export const DEFAULT_MODE: ModeId = 'standard';

export const MODE_LIST: Mode[] = [MODES.blackout, MODES.standard, MODES.inquest];

/**
 * Resolve a mode id that arrived over the wire or out of storage.
 *
 * Never trust it: an older peer, a corrupted store or a hand-edited message
 * would otherwise hand `undefined` to rulesFor and deal a table of NaN Ghosts —
 * which is not a crash, it is worse: `ghostIdx` would be empty, the Crew would
 * win on night one, and nobody would know why. Falling back keeps a mismatched
 * peer playing Standard.
 *
 * hasOwn, not a bare `MODES[id]`: MODES is an object literal, so it inherits
 * from Object.prototype and `MODES['constructor']` is a truthy FUNCTION. A plain
 * lookup hands that back as a Mode, every field reads undefined, and the wire
 * reaches the exact Ghost-less table this function exists to prevent — via the
 * one input it exists to distrust. `{mode:'constructor'}` is four bytes.
 */
export function modeOf(id: unknown): Mode {
  return (typeof id === 'string' && Object.hasOwn(MODES, id) && MODES[id as ModeId]) || MODES[DEFAULT_MODE];
}

/**
 * The most Ghosts a table of this size can hold and still be a game.
 *
 * checkWin ends it the moment ghosts >= crew, so a mode that adds a liar to a
 * small table does not make it harder — it makes it over. At 6 seats, 3 Ghosts
 * means the Ghosts have already won before the first probe. This is a rule, not
 * a nicety: it is why Inquest quietly declines the extra Ghost below 8 seats.
 *
 * The bar is crew - ghosts >= 2, i.e. the Crew survive one wrong ejection. A
 * table where the first mistake is fatal is a coin flip with extra steps.
 */
export function maxGhostsFor(seats: number): number {
  return Math.max(1, Math.floor((seats - 2) / 2));
}

/**
 * The table this mode deals at this size. Clamped, so it is always playable.
 *
 * The subtlety is the second line, and it was found by measuring rather than by
 * thinking (see tests/modes.test.ts): a mode's extra NIGHTS exist to pay for its
 * extra GHOST. Nights only ever help the Crew — every night is another reading,
 * another vote, another chance — so where the clamp declines the liar, handing
 * over the nights anyway makes Inquest a strictly kinder Standard: the mode the
 * Crew cannot lose. At 5 seats that is not hyperbole, it was 0 Ghost wins in
 * 200 games. So an ungranted Ghost takes its night back with it.
 */
export function rulesFor(mode: Mode, seats: number): TableRules {
  const base = ghostCountFor(seats);
  const ghosts = Math.min(maxGhostsFor(seats), Math.max(1, base + mode.ghostBonus));
  const declined = Math.max(0, base + mode.ghostBonus - ghosts);
  return { ghosts, blackoutAt: ghosts + Math.max(1, mode.cutSlack - declined) };
}

/** The chip's second line. Size-aware, because "nights" is not a constant. */
export function modeMeta(mode: Mode, seats: number): string {
  const r = rulesFor(mode, seats);
  return `${r.blackoutAt} nights · ${Math.round(mode.deadlines.night / 1000)}s`;
}
