/**
 * boot.test.ts — the screen wiring, driven through the real main.ts.
 *
 * Everything else here tests a module in isolation, which is exactly where the
 * shipped bug hid: each piece was fine and the wiring between them was not. This
 * walks the actual path a player takes — menu, create a room, land in a lobby —
 * with Trystero stubbed out. It is deliberately shallow; it exists to catch a
 * screen flow that throws or never paints.
 */
import { describe, it, expect, vi } from 'vitest';

/**
 * main.ts fetches TURN credentials at boot and holds the room join until they
 * land, because Trystero freezes one global connection pool from the first
 * joinRoom() on the page — relays that arrive after it are relays no peer in the
 * session ever gets. That ordering is correct and worth the wait in a browser,
 * but it makes a unit test's "did the lobby paint?" depend on a live HTTPS
 * round-trip to rt.benrichardson.dev. Stub it: this test is about screen wiring,
 * and a test that can be failed by someone else's network is not a test.
 */
vi.mock('@ben-gy/game-engine/turn', () => ({ getTurnConfig: async () => [] }));

vi.mock('trystero', () => ({
  selfId: 'self-id',
  joinRoom: () => ({
    getPeers: () => ({}),
    onPeerJoin: () => {},
    onPeerLeave: () => {},
    makeAction: () => [() => {}, () => {}],
    leave: async () => {},
  }),
}));
describe('boot', () => {
  it('renders the menu and opens a room without throwing', async () => {
    document.body.innerHTML = '<div id="app"></div>';
    await import('../src/main');
    expect(document.querySelector('.menu')).not.toBeNull();
    document.querySelector<HTMLButtonElement>('[data-friends]')!.click();
    expect(document.querySelector('.room-entry')).not.toBeNull();
    document.querySelector<HTMLButtonElement>('.re-create')!.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector('.lobby')).not.toBeNull();
    expect(document.querySelector('.lobby-code')?.textContent).toMatch(/^[A-Z0-9]{4}$/);
  });
});
