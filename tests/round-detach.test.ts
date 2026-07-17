/**
 * round-detach.test.ts — the fan-out tripwire, driven through the real main.ts.
 *
 * The Net now outlives every table and net.channel() fans out, so a round that
 * ends without calling send.off() on its receivers stays subscribed. The next
 * table then has TWO live receivers on 'snap'/'act', and every message is
 * applied twice to the session — a double-counted vote resolves a phase that
 * nobody finished voting on.
 *
 * teardownGame() in main.ts is the only thing standing between us and that, and
 * it is one line in the shell where no unit test reaches. So this drives two
 * tables inside one room and asserts each message still lands exactly once.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Session } from '../src/session';

type Recv = (data: unknown, from: string) => void;
/** The trystero-level receiver per action name — net.ts fans out beneath it. */
const recv = new Map<string, Recv>();
/** net.ts only re-elects a host on join/leave, so the peer must ARRIVE. */
let peerJoin: (id: string) => void = () => {};

vi.mock('trystero', () => ({
  selfId: 'self-id',
  joinRoom: () => ({
    // 'aaa' sorts below 'self-id', so net.ts elects it host and rematch.ts will
    // accept an 'rs' from it. Without a host that isn't us, no table is dealt.
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

const roster = [
  { id: 'aaa', name: 'A' },
  { id: 'bbb', name: 'B' },
  { id: 'ccc', name: 'C' },
  { id: 'self-id', name: 'Me' },
];

/** Deal a table from the elected host, exactly as rematch.ts would receive it. */
const dealTable = (round: number): void =>
  recv.get('rs')!({ round, seed: 1234, roster }, 'aaa');

describe('a finished table detaches its receivers', () => {
  let onSnapshot: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Stubbed so a dummy payload never reaches the renderer; we only count.
    onSnapshot = vi.spyOn(Session.prototype, 'onSnapshot').mockImplementation(() => {});
    // Mounting a table builds the fx canvas. jsdom has no 2d context and logs a
    // page of "not implemented" for it; null is what it returns anyway.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });

  it('delivers each snapshot exactly once after a rematch', async () => {
    document.body.innerHTML = '<div id="app"></div>';
    await import('../src/main');
    document.querySelector<HTMLButtonElement>('[data-friends]')!.click();
    document.querySelector<HTMLButtonElement>('.re-create')!.click();
    await new Promise((r) => setTimeout(r, 20));
    peerJoin('aaa');

    dealTable(1);
    expect(recv.get('snap')).toBeDefined();

    // The rematch: same room, same Net, a second table dealt underneath us.
    dealTable(2);

    onSnapshot.mockClear();
    recv.get('snap')!({}, 'aaa');

    // Twice here means table 1's receiver is still attached to the shared Net.
    expect(onSnapshot).toHaveBeenCalledTimes(1);
  });
});
