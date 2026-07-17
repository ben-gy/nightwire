/**
 * countdown.test.ts — the three beats between the host's start and the deal.
 *
 * The countdown is the only thing standing between "a start message arrived" and
 * "the night is running", so the two things worth pinning are that it eventually
 * lets go (a countdown that never calls onDone is a game that never starts) and
 * that it can be stopped (a countdown that fires after teardown deals a table
 * into a screen the player has left).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCountdown } from '../src/countdown';
import type { Sfx } from '../src/engine/sound';

function fakeSfx(): Sfx & { played: string[] } {
  const played: string[] = [];
  return {
    played,
    unlock() {},
    play(n) {
      played.push(n);
    },
    muted: () => false,
    setMuted() {},
  };
}

let root: HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  root = document.createElement('div');
  document.body.append(root);
});

afterEach(() => {
  vi.useRealTimers();
  root.remove();
});

describe('countdown', () => {
  it('counts 3-2-1-GO and then starts the game', () => {
    const sfx = fakeSfx();
    const onDone = vi.fn();
    createCountdown({ root, sfx, onDone });

    expect(root.querySelector('.cd-num')!.textContent).toBe('3');
    expect(onDone).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(root.querySelector('.cd-num')!.textContent).toBe('2');
    vi.advanceTimersByTime(1000);
    expect(root.querySelector('.cd-num')!.textContent).toBe('1');
    vi.advanceTimersByTime(1000);
    expect(root.querySelector('.cd-num')!.textContent).toBe('GO');
    // GO is on screen before the table is dealt, not after.
    expect(onDone).not.toHaveBeenCalled();

    vi.advanceTimersByTime(450);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('makes a sound on every beat — players watch the table, not the overlay', () => {
    const sfx = fakeSfx();
    createCountdown({ root, sfx, onDone: () => {} });
    vi.advanceTimersByTime(3450);
    // Three ticks, then something audibly different for GO. The pips ARE the
    // start signal for anyone whose eyes are on the seats.
    expect(sfx.played).toEqual(['tick', 'tick', 'tick', 'select']);
  });

  it('cleans up after itself', () => {
    createCountdown({ root, sfx: fakeSfx(), onDone: () => {} });
    expect(root.querySelector('.countdown')).toBeTruthy();
    vi.advanceTimersByTime(3450);
    // A leftover overlay is a full-screen element sitting over a live table.
    expect(root.querySelector('.countdown')).toBeNull();
  });

  it('cancels dead — no deal after teardown', () => {
    const onDone = vi.fn();
    const cd = createCountdown({ root, sfx: fakeSfx(), onDone });
    vi.advanceTimersByTime(1000);
    cd.cancel();
    expect(root.querySelector('.countdown')).toBeNull();

    // The whole point: the player left the room mid-count. Firing now would deal
    // a table into a screen that no longer exists.
    vi.advanceTimersByTime(10_000);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('survives being cancelled twice, and after it has finished', () => {
    const onDone = vi.fn();
    const cd = createCountdown({ root, sfx: fakeSfx(), onDone });
    vi.advanceTimersByTime(3450);
    expect(onDone).toHaveBeenCalledTimes(1);
    // teardownGame() cancels whatever it finds; it does not know whether the
    // count already finished, and must not care.
    cd.cancel();
    cd.cancel();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('honours reduced motion', () => {
    createCountdown({ root, sfx: fakeSfx(), reducedMotion: true, onDone: () => {} });
    expect(root.querySelector('.countdown')!.classList.contains('reduced')).toBe(true);
  });

  it('announces itself to a screen reader', () => {
    createCountdown({ root, sfx: fakeSfx(), onDone: () => {} });
    const el = root.querySelector('.countdown')!;
    expect(el.getAttribute('role')).toBe('status');
    expect(el.getAttribute('aria-live')).toBe('assertive');
  });
});
