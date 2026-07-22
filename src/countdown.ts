// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * countdown.ts — the three seconds between the host's start arriving and the
 * first night.
 *
 * Two jobs. The obvious one is fairness: night 1 opens with a deadline already
 * running, so without a beat to look up, whoever happened to be staring at the
 * screen when the start fired gets a free head start on the one decision that
 * seeds the whole ledger. The quieter one is that it tells you the table is
 * *about* to be yours — a ring of seats that simply appears reads as a jump-cut,
 * and in a game about watching people that beat matters.
 *
 * The audio matters more than the number. Players look at the table, not the
 * overlay, so the pips are what actually starts the round for them: three ticks
 * and a distinct GO. That is also why the tick fires on the same frame the digit
 * changes rather than on its own timer — a countdown whose sound lags its number
 * feels broken in a way people notice but cannot name.
 *
 * Every peer runs this locally from the moment the host's start arrives, so they
 * are in step to within one network hop (~50-150ms). The phase clock is
 * host-authoritative anyway, so that skew costs nobody a probe.
 */

import type { Sfx } from './engine/sound';

export interface CountdownOptions {
  root: HTMLElement;
  sfx: Sfx;
  /** Ticks to count. Default 3. */
  from?: number;
  reducedMotion?: boolean;
  onDone: () => void;
}

export interface Countdown {
  /** Stop early — a peer that left, or a table torn down mid-count. */
  cancel(): void;
}

export function createCountdown(o: CountdownOptions): Countdown {
  const from = o.from ?? 3;
  let n = from;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;

  const el = document.createElement('div');
  el.className = 'countdown';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'assertive');
  if (o.reducedMotion) el.classList.add('reduced');
  o.root.appendChild(el);

  function paint(text: string, cls: string): void {
    el.innerHTML = `<span class="cd-num ${cls}">${text}</span>`;
  }

  function step(): void {
    if (done) return;
    if (n > 0) {
      paint(String(n), 'cd-tick');
      o.sfx.play('tick');
      n--;
      timer = setTimeout(step, 1000);
      return;
    }
    paint('GO', 'cd-go');
    // A different patch, not a louder tick: the ear should not have to count.
    o.sfx.play('select');
    timer = setTimeout(() => {
      finish();
      o.onDone();
    }, 450);
  }

  function finish(): void {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    el.remove();
  }

  step();

  return {
    cancel() {
      finish();
    },
  };
}
