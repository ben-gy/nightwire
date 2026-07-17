/**
 * results-screen.test.ts — the summary must not be a dead end.
 *
 * The reported failure: one player still reading the reveal left everyone else
 * on "Ready — waiting…" forever, and the only control that did anything was
 * Menu — which tore the whole room down. The escape hatches are a host
 * force-start, a way back to the lobby that KEEPS the room, and a countdown you
 * can actually see. All three are wiring, which is where this game's bugs live.
 */

import { describe, it, expect } from 'vitest';
import { createGameUi } from '../src/ui';
import { deal, publicView, privateView, type PublicState } from '../src/game';

const specs = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, bot: false }));

/** A finished table, seen from p0's seat. */
function over(): { pub: PublicState; priv: ReturnType<typeof privateView> } {
  const s = deal(1234, specs(6));
  const done = { ...s, phase: 'over' as const, winner: 'crew' as const };
  return { pub: publicView(done), priv: privateView(done, 'p0') };
}

function mount(room: boolean) {
  const el = document.createElement('div');
  const calls = { startNow: 0, lobby: 0, again: 0, menu: 0 };
  const ui = createGameUi(el, {
    selfId: 'p0',
    onProbe: () => {},
    onCut: () => {},
    onClaim: () => {},
    onVote: () => {},
    onAgain: () => calls.again++,
    onMenu: () => calls.menu++,
    ...(room
      ? { onStartNow: () => calls.startNow++, onLobby: () => calls.lobby++ }
      : {}),
  });
  const { pub, priv } = over();
  ui.update(pub, priv);
  return { el, ui, calls };
}

describe('the results screen in a room', () => {
  it('offers a way back to the lobby that does NOT leave the room', () => {
    const { el, calls } = mount(true);
    const back = el.querySelector<HTMLButtonElement>('[data-lobby]');
    expect(back).not.toBeNull();
    back!.click();
    // Menu is the only control that may tear the room down. This one must not.
    expect(calls).toMatchObject({ lobby: 1, menu: 0 });
  });

  it('hides "Start now" until the host can actually use it', () => {
    const { el, ui } = mount(true);
    const btn = el.querySelector<HTMLButtonElement>('[data-start-now]')!;
    expect(btn.hidden).toBe(true);

    ui.setAgain({ label: 'Ready — waiting…', status: 'Dealing in 5s', canStart: true });
    expect(btn.hidden).toBe(false);
  });

  it('fires go() from "Start now" rather than waiting out the countdown', () => {
    const { el, ui, calls } = mount(true);
    ui.setAgain({ label: 'Ready — waiting…', status: '', canStart: true });
    el.querySelector<HTMLButtonElement>('[data-start-now]')!.click();
    expect(calls.startNow).toBe(1);
  });

  it('shows the countdown, so the wait has a visible horizon', () => {
    const { el, ui } = mount(true);
    ui.setAgain({
      label: 'Ready — waiting…',
      status: 'Dealing in 6s — waiting for 1 more player',
      canStart: false,
    });
    expect(el.querySelector('[data-again-status]')!.textContent).toMatch(/Dealing in 6s/);
  });

  it('keeps the rematch copy across a repaint of the panel', () => {
    // The panel re-renders on every snapshot. Losing the live status here is how
    // a room already counting down reverts to a stale "Play again".
    const { el, ui } = mount(true);
    ui.setAgain({ label: 'Ready — waiting…', status: '2/3 ready', canStart: false });
    const { pub, priv } = over();
    ui.update(pub, priv);
    expect(el.querySelector('[data-again]')!.textContent).toBe('Ready — waiting…');
    expect(el.querySelector('[data-again-status]')!.textContent).toBe('2/3 ready');
  });
});

describe('the results screen in solo', () => {
  it('offers neither control — there is no room and nobody to wait for', () => {
    const { el } = mount(false);
    expect(el.querySelector('[data-start-now]')).toBeNull();
    expect(el.querySelector('[data-lobby]')).toBeNull();
    // Play again still restarts immediately.
    expect(el.querySelector('[data-again]')).not.toBeNull();
  });
});
