/**
 * lobby-mode.test.ts — what a GUEST is told about the table it is about to sit
 * at, driven through the real main.ts.
 *
 * The host's mode decides how many Ghosts are dealt and how long the night runs.
 * A guest's lobby therefore has exactly one honest thing to render: the host's
 * gossiped pick. Rendering the guest's OWN chip choice and labelling it "Host
 * picked …" is a confident lie — it reads as information, it is unfalsifiable
 * until the table is dealt, and it is one character of difference in main.ts.
 *
 * So the local pick here is deliberately NOT the host's, and the assertion is
 * that the screen says the host's.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Recv = (data: unknown, from: string) => void;
const recv = new Map<string, Recv>();
let peerJoin: (id: string) => void = () => {};

vi.mock('trystero', () => ({
  selfId: 'self-id',
  joinRoom: () => ({
    getPeers: () => ({ aaa: {} }),
    onPeerJoin: (cb: (id: string) => void) => {
      peerJoin = cb;
    },
    onPeerLeave: () => {},
    makeAction: (name: string) => [
      () => {},
      (cb: Recv) => {
        recv.set(name, cb);
      },
    ],
    leave: async () => {},
  }),
}));

/**
 * Hand the room to 'aaa' the way a real incumbent announces itself.
 *
 * Claims are epoch-ordered now: higher term wins, equal term breaks by min-id.
 * We minted this room at term 1 and so did 'aaa', so this is the equal-term case
 * and 'aaa' takes it on id. The term is not optional — net.ts drops an announce
 * without one, which is what makes an untermed claim unable to move a room.
 */
const cedeHostTo = (id: string): void => recv.get('__h')!({ host: id, epoch: 1 }, id);

/** The host gossips its lobby settings with presence (rematch.ts's 'rv'). */
const hostGossips = (opts: unknown): void =>
  recv.get('rv')!({ round: 1, name: 'A', in: false, opts }, 'aaa');

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  recv.clear();
  // main.ts boots on import and is cached, so a second `await import` in the
  // same file is a no-op against a fresh <div id="app"> — every test after the
  // first would assert on a blank page and pass for the wrong reason.
  vi.resetModules();
  // …and the previous test left ?room= in the URL, which main.ts reads at boot
  // as an invite link and honours by skipping the menu entirely.
  history.replaceState(null, '', '/');
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a guest's lobby shows the HOST's table", () => {
  it("names the host's mode, never the guest's own pick", async () => {
    // This browser's chip says Blackout. The host is running an Inquest.
    localStorage.setItem('game:nightwire:mode', JSON.stringify('blackout'));
    document.body.innerHTML = '<div id="app"></div>';
    await import('../src/main');

    document.querySelector<HTMLButtonElement>('[data-friends]')!.click();
    document.querySelector<HTMLButtonElement>('.re-create')!.click();
    await vi.advanceTimersByTimeAsync(50);

    peerJoin('aaa');
    cedeHostTo('aaa');
    hostGossips({ mode: 'inquest', pub: false });
    await vi.advanceTimersByTimeAsync(700); // the lobby's repaint poll

    const note = document.querySelector('.mode-note')!.textContent!;
    expect(note).toContain('Inquest');
    expect(note).not.toContain('Blackout');
    // And a guest gets no picker at all — it is not their choice to make.
    expect(document.querySelector('.mode-chip')).toBeNull();
  });

  it('tells a guest when strangers can walk into the room', async () => {
    // The invite link carries no public flag (deliberately — it would outlive
    // the host flipping the room private), so this gossip is the ONLY way a
    // guest learns the room is listed. Silence here is a privacy surprise.
    document.body.innerHTML = '<div id="app"></div>';
    await import('../src/main');
    document.querySelector<HTMLButtonElement>('[data-friends]')!.click();
    document.querySelector<HTMLButtonElement>('.re-create')!.click();
    await vi.advanceTimersByTimeAsync(50);

    peerJoin('aaa');
    cedeHostTo('aaa');
    hostGossips({ mode: 'standard', pub: true });
    await vi.advanceTimersByTimeAsync(700);

    expect(document.querySelector('.mode-note.pub')!.textContent).toMatch(/listed publicly/i);
  });

  it('says it is waiting rather than guessing, before the host has spoken', async () => {
    document.body.innerHTML = '<div id="app"></div>';
    await import('../src/main');
    document.querySelector<HTMLButtonElement>('[data-friends]')!.click();
    document.querySelector<HTMLButtonElement>('.re-create')!.click();
    await vi.advanceTimersByTimeAsync(50);

    peerJoin('aaa');
    cedeHostTo('aaa');
    await vi.advanceTimersByTimeAsync(700);

    // Null hostOpts is "we have not heard yet". Filling that silence with a
    // default would be the same lie in a quieter voice.
    expect(document.querySelector('.mode-note')!.textContent).toMatch(/Waiting for the host/i);
  });
});
