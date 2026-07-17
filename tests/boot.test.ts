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
