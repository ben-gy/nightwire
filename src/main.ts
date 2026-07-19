/**
 * main.ts — bootstrap and screen flow. Owns no game logic.
 *
 * Screens: menu → (solo | room entry → lobby) → game → results.
 */

// mobile.css FIRST — it is the baseline main.css is allowed to override, not
// the other way round.
// feedback:begin (managed by hub/scripts/feedback/backfill.mjs)
import { mountFeedback } from './feedback';
mountFeedback();
// feedback:end

import './styles/mobile.css';
import './styles/main.css';
import { hardenViewport } from '@ben-gy/game-engine/mobile';
import { createStore } from '@ben-gy/game-engine/storage';
import { createSfx, type SfxName } from './engine/sound';
import { createNet, roomAppId, setTurnConfig, type Net } from '@ben-gy/game-engine/net';
import { getTurnConfig } from '@ben-gy/game-engine/turn';
import { createRounds, type Rounds, type RoundPlayer } from '@ben-gy/game-engine/rematch';
import {
  clearRoomInUrl,
  createLobby,
  createListing,
  createRoomEntry,
  normalizeRoomCode,
  setRoomInUrl,
  P2P_IP_NOTE,
  type BoardAccess,
  type Listing,
} from './engine/lobby';
import { createNoticeboard, type Noticeboard, type PublicRoom } from '@ben-gy/game-engine/noticeboard';
import { Session, GAME_CHANNELS, type Action, type Transport } from './session';
import { createGameUi, escapeHtml, type GameUi } from './ui';
import { createFx, type Fx } from './fx';
import { createCountdown } from './countdown';
import { BOT_NAMES } from './bot';
import { shuffle, makeRng } from '@ben-gy/game-engine/rng';
import { MIN_SEATS, type PublicState, type PrivateView, type Role } from './game';
import { DEFAULT_MODE, MODE_LIST, modeMeta, modeOf, rulesFor, type ModeId } from './modes';

const SLUG = 'nightwire';
const MAX_SEATS_MP = 10;

/**
 * Fetch the TURN credentials and install them before ANY mesh exists.
 *
 * Trystero builds one global connection pool from the config of the first
 * joinRoom() on the page and reuses it for every room afterwards, so a
 * setTurnConfig() that lands even one room late leaves the initiating half of
 * every peer pair on STUN only — and STUN alone does not survive carrier CGNAT,
 * which is how two phones on mobile data end up in the same room code seeing
 * nobody. Nightwire has two meshes and the public-room noticeboard is usually
 * the FIRST one a player opens (Browse, before any game room exists), so this
 * cannot live in the room-join path: it belongs at boot.
 *
 * Awaited at both mesh sites rather than fired and forgotten. getTurnConfig() is
 * session-cached and fails open to [], so this is at worst one short wait on the
 * first tap and never a reason a join does not happen.
 */
const turnReady: Promise<void> = getTurnConfig().then(
  (servers) => setTurnConfig(servers),
  () => setTurnConfig([]),
);

// Before anything renders: iOS ignores the viewport meta's user-scalable=no, so
// a double-tap or a pinch zooms into a live table with no way back out.
hardenViewport();

const store = createStore(SLUG);
const sfx = createSfx(store.get('muted', false));

const app = document.querySelector<HTMLElement>('#app')!;

let net: Net | null = null;
let rounds: Rounds | null = null;
let lobby: { destroy: () => void; repaint: () => void } | null = null;
let roomEntry: { destroy: () => void } | null = null;
let session: Session | null = null;
let gameUi: GameUi | null = null;
let fx: Fx | null = null;
let prevPub: PublicState | null = null;
/** Detaches THIS round's receivers from the shared Net (see wireRound). */
let unwireRound: (() => void) | null = null;
let againTick: ReturnType<typeof setInterval> | null = null;
let countdown: { cancel: () => void } | null = null;
let listing: Listing | null = null;
let listingTick: ReturnType<typeof setInterval> | null = null;
/** The room we are in, and whether it is on the public list. Private by default. */
let roomCode = '';
let roomPublic = false;

/** The mode this player last chose. The HOST's choice is what a room plays. */
let modeId: ModeId = modeOf(store.get<string>('mode', DEFAULT_MODE)).id;

function setMode(id: ModeId): void {
  modeId = modeOf(id).id;
  store.set('mode', modeId);
}

// Optional call, not a bare one: matchMedia is not universal (jsdom has none),
// and the whole module is imported for its side effects — an exception here
// takes the entire app down before a single screen paints, to decide whether an
// animation plays. Absent means animate.
const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** A ?room= in the URL (an invite link) is honoured ONCE. joinRoom() also writes
 *  the code into the URL, so without this the room's creator would find "Play
 *  with friends" silently re-entering the finished room while their guest — who
 *  had already spent the link — got the create/join screen. Same button, two
 *  behaviours, depending on how you arrived. */
let pendingRoom: string | null = (() => {
  const c = normalizeRoomCode(new URL(location.href).searchParams.get('room') ?? '');
  return c.length >= 3 ? c : null;
})();

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

app.innerHTML = `
  <div class="main-content">
    <header class="topbar">
      <button class="brand" data-home type="button">
        <span class="brand-mark" aria-hidden="true"></span>
        <span class="brand-name">Nightwire</span>
      </button>
      <div class="topbar-actions">
        <button class="icon-btn" data-help type="button" aria-label="How to play">?</button>
        <button class="icon-btn" data-mute type="button" aria-label="Toggle sound"></button>
      </div>
    </header>
    <main id="screen"></main>
  </div>
  <footer class="site-footer">
    Built by <a href="https://benrichardson.dev/" target="_blank" rel="noopener">benrichardson.dev</a>
    · <a href="https://hub.benrichardson.dev" target="_blank" rel="noopener">more games, tools &amp; sites</a>
  </footer>
  <div class="modal" data-modal hidden>
    <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <button class="modal-x" data-modal-close type="button" aria-label="Close">×</button>
      <div data-modal-body></div>
    </div>
  </div>`;

const screen = app.querySelector<HTMLElement>('#screen')!;
const modal = app.querySelector<HTMLElement>('[data-modal]')!;
const modalBody = app.querySelector<HTMLElement>('[data-modal-body]')!;

function paintMute(): void {
  const b = app.querySelector<HTMLElement>('[data-mute]')!;
  b.textContent = sfx.muted() ? '🔇' : '🔊';
  b.setAttribute('aria-pressed', String(sfx.muted()));
}
paintMute();

app.querySelector('[data-mute]')?.addEventListener('click', () => {
  sfx.setMuted(!sfx.muted());
  store.set('muted', sfx.muted());
  paintMute();
  if (!sfx.muted()) play('select');
});
app.querySelector('[data-home]')?.addEventListener('click', () => showMenu());
app.querySelector('[data-help]')?.addEventListener('click', () => openModal(HOW_TO));
app.querySelector('[data-modal-close]')?.addEventListener('click', closeModal);
modal.addEventListener('click', (e) => {
  if (e.target === modal) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modal.hidden) closeModal();
});

function openModal(html: string): void {
  modalBody.innerHTML = html;
  modal.hidden = false;
  app.querySelector<HTMLElement>('[data-modal-close]')?.focus();
}
function closeModal(): void {
  modal.hidden = true;
}

/** Audio is blocked until a gesture; unlock on the first one, then play freely. */
function play(n: SfxName): void {
  try {
    sfx.unlock();
    sfx.play(n);
  } catch {
    /* sound is never load-bearing */
  }
}
document.addEventListener('pointerdown', () => sfx.unlock(), { once: true });
document.addEventListener('keydown', () => sfx.unlock(), { once: true });

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

const HOW_TO = `
  <h2 id="modal-title">How to play</h2>
  <p><strong>You're at a table. Some of you are Ghosts.</strong></p>
  <ol class="howto">
    <li><strong>Night.</strong> Probe a seat. You learn how many Ghosts sit in that
      <strong>3-seat window</strong> — the seat you picked and its two neighbours.</li>
    <li><strong>Dawn.</strong> Every reading is published.
      <strong>Crew readings publish automatically and truthfully — Ghosts choose what number to publish.</strong>
      So every claim is a clue, and some of the clues are lies.</li>
    <li><strong>Day.</strong> Vote to eject one seat. Their role is revealed.</li>
  </ol>
  <p><strong>Crew win</strong> by ejecting every Ghost. <strong>Ghosts win</strong> when the wire cuts
    run out and the lights go out — one wire is cut every single night, so the clock never stops.</p>
  <p class="tip">Ghosts also darken one console each night: that player gets no reading at all.
    Tap any seat to highlight the window it reads.</p>`;

const ABOUT = `
  <h2 id="modal-title">About Nightwire</h2>
  <p>A hidden-role deduction game where the evidence is numbers instead of arguments —
    a Minesweeper board where some of the numbers are lying. Play solo against bots that
    genuinely solve the ledger, or with 4–10 friends over a shared link.</p>
  <h3>Multiplayer is peer-to-peer</h3>
  <p>There is no game server. Players connect directly to each other over WebRTC; a free public
    signaling relay is used only to broker that first handshake, and no game data is stored on
    any server.</p>
  <h3>Who deals the cards</h3>
  <p>The room host's browser deals the roles — much like the friend who deals the cards face-down
    can peek at the deck. No other player ever receives anyone else's role, and if the host leaves,
    the new host rebuilds the table by asking each player what they are. Making this
    host-proof would need a full mental-poker protocol; we'd rather tell you plainly than pretend.</p>
  <h3>Public rooms and your IP address</h3>
  <p>Rooms are <strong>private by default</strong>: only people you send the code to can find them.
    If you list a room publicly — or tap “Browse public games” — your browser joins a shared
    peer-to-peer list, and connecting to a peer means exchanging IP addresses. So on the public list,
    strangers can see your IP; in a private room, only the friends you invited can. That is true of
    any peer-to-peer game and there is no server here to hide behind. It is opt-in on both sides,
    nothing joins the list until you tap it, and your browser leaves the list as soon as you stop
    browsing or your table starts or goes private.</p>
  <h3>Privacy</h3>
  <p>No cookies, no fingerprinting, no third-party fonts. Anonymous, cookie-less page-view counts
    via Cloudflare Web Analytics.</p>
  <p>Built by <a href="https://benrichardson.dev/" target="_blank" rel="noopener">benrichardson.dev</a>
    · <a href="https://hub.benrichardson.dev" target="_blank" rel="noopener">more games, tools &amp; sites</a></p>`;

// ---------------------------------------------------------------------------
// Mode picker
// ---------------------------------------------------------------------------

/** `seats` sizes the meta line: "nights" depends on how many of you there are. */
function modePicker(seats: number): string {
  const m = modeOf(modeId);
  return `
    <div class="modes" role="radiogroup" aria-label="Table mode">
      ${MODE_LIST.map(
        (x) => `<button class="mode-chip${x.id === m.id ? ' on' : ''}" type="button"
          role="radio" aria-checked="${x.id === m.id}" data-mode="${x.id}">
          <span class="mode-name">${escapeHtml(x.name)}</span>
          <span class="mode-meta">${escapeHtml(modeMeta(x, seats))}</span>
        </button>`,
      ).join('')}
      <p class="mode-blurb">${escapeHtml(m.blurb)}</p>
    </div>`;
}

function modeNote(seats: number): string {
  // The HOST's gossiped choice — never our own local pick. Rendering `modeId`
  // here would confidently tell a guest "Host picked Blackout" while the host
  // was actually setting up an Inquest.
  const hostOpts = rounds?.state().hostOpts as { mode?: unknown; pub?: unknown } | null | undefined;
  if (hostOpts == null) return `<p class="mode-note">Waiting for the host’s pick…</p>`;
  const m = modeOf(hostOpts.mode);
  return (
    `<p class="mode-note">Host picked <strong>${escapeHtml(m.name)}</strong> · ${escapeHtml(
      modeMeta(m, seats),
    )}</p>` +
    // Guests play at the host's table too. Someone who was handed an invite link
    // has no way of knowing strangers can walk in unless we say so.
    (hostOpts.pub
      ? `<p class="mode-note pub">This room is listed publicly — anyone browsing can join.</p>`
      : '')
  );
}

function wireModePicker(repaint: () => void): void {
  for (const btn of screen.querySelectorAll<HTMLButtonElement>('.mode-chip')) {
    btn.addEventListener('click', () => {
      setMode(btn.dataset.mode as ModeId);
      play('select');
      repaint();
    });
  }
}

// ---------------------------------------------------------------------------
// Public / private
// ---------------------------------------------------------------------------

/** The host's own control, in the lobby: a room can be taken off the list again. */
function visibilityPicker(): string {
  const chip = (pub: boolean, name: string, meta: string): string =>
    `<button class="vis-chip${roomPublic === pub ? ' on' : ''}" type="button"
      role="radio" aria-checked="${roomPublic === pub}" data-pub="${pub ? 1 : 0}">
      <span class="vis-name">${escapeHtml(name)}</span>
      <span class="vis-meta">${escapeHtml(meta)}</span>
    </button>`;
  return `
    <div class="vis" role="radiogroup" aria-label="Who can join">
      ${chip(false, 'Private', 'Invite only')}
      ${chip(true, 'Public', 'Listed for anyone')}
    </div>
    <p class="re-note">${escapeHtml(P2P_IP_NOTE)}</p>`;
}

function wireVisibility(repaint: () => void): void {
  for (const btn of screen.querySelectorAll<HTMLButtonElement>('.vis-chip')) {
    btn.addEventListener('click', () => {
      roomPublic = btn.dataset.pub === '1';
      play('select');
      // Immediately, not on the next tick: "private" has to mean off the list
      // now, not within a second.
      syncListing();
      repaint();
    });
  }
}

// ---------------------------------------------------------------------------
// The public room list
//
// At most one board, held only while something is actually using it — browsing
// the list, or listing our own room. It is a mesh of STRANGERS (see P2P_IP_NOTE),
// so it is never opened by the page loading and never left running behind a
// screen the player has walked away from.
// ---------------------------------------------------------------------------

let board: Noticeboard | null = null;
let boardRooms: ((rooms: PublicRoom[]) => void) | null = null;
/** Serialises open/close. net.ts throws if the board's room is rejoined while
 *  the last one is still tearing down, and browse → back → browse is two taps. */
let boardQueue: Promise<void> = Promise.resolve();

function onBoard(then: () => void): Promise<void> {
  boardQueue = boardQueue
    .then(() => turnReady)
    .then(() => {
      // Very often the first mesh of the session — see turnReady. Same appId
      // stamping as the game room so a cached old build cannot half-join.
      board ??= createNoticeboard({ appId: roomAppId(SLUG), onRooms: (r) => boardRooms?.(r) });
      then();
    })
    .then(
      () => undefined,
      (e) => console.error(e),
    );
  return boardQueue;
}

const boardAccess: BoardAccess = {
  open(onRooms) {
    boardRooms = onRooms;
    // Hand over whatever is already known so the list is not blank for a cycle.
    return onBoard(() => onRooms(board!.rooms()));
  },
  announce(ad) {
    return onBoard(() => board!.announce(ad));
  },
  close() {
    boardRooms = null;
    const b = board;
    board = null;
    if (!b) return;
    // CHAIN, never replace — same trap as roomTeardown below.
    boardQueue = boardQueue.then(() => b.destroy()).then(
      () => undefined,
      () => undefined,
    );
  },
};

/** Feed lobby.ts's roomAd() rule the room's current truth. It decides. */
function syncListing(): void {
  if (!listing) return;
  if (!net || !rounds) {
    listing.close();
    return;
  }
  const s = rounds.state();
  listing.sync({
    isPublic: roomPublic,
    isHost: net.isHost(),
    inLobby: !!lobby,
    playing: s.phase === 'playing',
    code: roomCode,
    host: playerName(),
    players: s.present.length,
    max: MAX_SEATS_MP,
    note: modeOf(modeId).name,
  });
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

function playerName(): string {
  return store.get('name', '') || `Player ${Math.floor(Math.random() * 90 + 10)}`;
}

function showMenu(): void {
  void leaveRoom();
  const seats = store.get('seats', 6);
  screen.innerHTML = `
    <section class="menu">
      <h1 class="title">Nightwire</h1>
      <p class="tagline">Some of the numbers are lying.</p>
      <p class="pitch">Probe a seat, learn how many Ghosts sit in that window, and find the liars
        before the lights go out.</p>

      <div class="menu-main">
        <button class="btn primary big" data-solo>Play solo</button>
        <label class="seats">
          <span>Table size</span>
          <select data-seats aria-label="Number of seats">
            ${[4, 5, 6, 7, 8, 9, 10]
              .map((n) => `<option value="${n}" ${n === seats ? 'selected' : ''}>${n} seats</option>`)
              .join('')}
          </select>
        </label>
      </div>
      ${modePicker(seats)}

      <div class="menu-alt">
        <button class="btn" data-friends>Play with friends</button>
        <button class="btn ghost" data-howto>How to play</button>
        <button class="btn ghost" data-about>About</button>
      </div>
      <p class="menu-note">Solo plays against bots that really do solve the ledger.
        With friends: 4–10 players, peer-to-peer, no accounts.</p>
    </section>`;

  const sel = screen.querySelector<HTMLSelectElement>('[data-seats]')!;
  sel.addEventListener('change', () => {
    store.set('seats', Number(sel.value));
    // The chips read "N nights", and N moves with the table size — repaint or
    // they quietly lie about the game you are one tap from starting.
    showMenu();
  });
  wireModePicker(() => showMenu());
  screen.querySelector('[data-solo]')?.addEventListener('click', () => {
    play('select');
    startSolo(Number(sel.value));
  });
  screen.querySelector('[data-friends]')?.addEventListener('click', () => {
    play('select');
    showRoomEntry();
  });
  screen.querySelector('[data-howto]')?.addEventListener('click', () => openModal(HOW_TO));
  screen.querySelector('[data-about]')?.addEventListener('click', () => openModal(ABOUT));

  if (!store.get('seen-howto', false)) {
    openModal(HOW_TO);
    store.set('seen-howto', true);
  }
}

// ---------------------------------------------------------------------------
// Solo
// ---------------------------------------------------------------------------

function startSolo(seatCount: number): void {
  void leaveRoom();
  const seed = Math.floor(Math.random() * 0xffffffff) >>> 0;
  const names = shuffle(makeRng(seed), BOT_NAMES).slice(0, seatCount - 1);
  const specs = [
    { id: 'you', name: 'You', bot: false },
    ...names.map((n, i) => ({ id: `bot${i}`, name: n, bot: true })),
  ];

  // Solo plays the local pick — there is no host to defer to. The deadlines are
  // still passed for completeness; Session ignores them in solo, because nobody
  // is waiting on you.
  const mode = modeOf(modeId);
  session = new Session({
    selfId: 'you',
    solo: true,
    rules: rulesFor(mode, seatCount),
    deadlines: mode.deadlines,
    onPublic: handlePublic,
    onPrivate: handlePrivate,
  });
  mountGame('you', () => startSolo(seatCount));
  session.startAsHost(seed, specs);
}

// ---------------------------------------------------------------------------
// Multiplayer
// ---------------------------------------------------------------------------

function showRoomEntry(): void {
  void leaveRoom();

  // Arrived on an invite link? Drop straight into that room — once, ever. We are
  // the guest here, never the host: whoever sent the link already holds the room.
  if (pendingRoom) {
    const code = pendingRoom;
    pendingRoom = null;
    void openRoom(code, false, false);
    return;
  }

  // Handing the entry `board` is what makes public rooms exist at all — it does
  // not join anything until the player taps Browse.
  roomEntry = createRoomEntry({
    container: screen,
    title: 'Play with friends',
    subtitle: 'Nightwire needs 4–10 players. Start a room, or type a friend’s code.',
    board: boardAccess,
    onSubmit: (code, created, isPublic) => void openRoom(code, created, isPublic),
    onCancel: () => showMenu(),
  });
}

/**
 * Join a room ONCE and hold it for as long as the player stays. Every table —
 * the first and every rematch — is dealt inside this one Net via `rounds`.
 * Nothing here may call net.leave() except the trip back to the menu.
 */
async function openRoom(code: string, created: boolean, isPublic: boolean): Promise<void> {
  leaveRoom();
  // A previous room may still be tearing down (Trystero defers it ~99ms).
  // Joining inside that window returns the dying room, so wait it out.
  await roomTeardown;
  // Relays before the first mesh, always — see turnReady. Already resolved if
  // the player came through Browse.
  await turnReady;
  // The public flag stays OUT of the URL. It is the host's live choice, not a
  // property of the code: baked into an invite link it would survive the host
  // flipping the room private, and every guest who forwarded the link would be
  // handing on a claim that is no longer true.
  setRoomInUrl(code);
  roomCode = code;
  roomPublic = created && isPublic;

  try {
    net = createNet(
      // `created` is the difference between minting this code and walking into
      // someone else's room. Only the minter may host on arrival; a guest waits
      // to hear from the incumbent instead of racing it for the role.
      //
      // roomAppId() stamps the wire revision into the app id, so a player on a
      // cached old build lands in a different room entirely rather than joining
      // this one and speaking a protocol nobody here understands.
      { appId: roomAppId(SLUG), roomId: code, claimHost: created },
      {
        // Wiring these is the whole host-transfer contract. A bare createNet()
        // here would make a takeover impossible.
        onHostChange: () => syncAuthority(),
        onPeerLeave: (id) => {
          session?.onPeerLeave(id);
          syncAuthority();
        },
        onPeers: () => {
          session?.onRoster();
          syncAuthority();
        },
      },
    );
  } catch (err) {
    // The room is somehow still held (see the engine's net.ts). Never strand the
    // player on a blank screen — say so and go back somewhere they can act.
    console.error(err);
    flash('Could not open that room — try again');
    showMenu();
    return;
  }

  rounds = createRounds({
    net,
    playerName: playerName(),
    minPlayers: MIN_SEATS,
    // Only the host's pick counts, and it travels frozen with the start — a mode
    // each peer read from its own UI is a mode two peers can disagree about.
    // `pub` rides along so a guest can see that strangers may walk in; it is
    // gossiped with presence, so it is live rather than a claim from join time.
    roundOpts: () => ({ mode: modeId, pub: roomPublic }),
    onRound: ({ seed, players, isHost, opts }) => startTable(seed, players, isHost, opts),
  });

  listing = createListing(boardAccess);
  // Player counts move, the host can flip the room private, and the host role
  // itself can transfer mid-lobby. Poll one rule rather than hunt every edge.
  listingTick = setInterval(syncListing, 1000);

  showLobby();
}

function showLobby(): void {
  if (!net || !rounds) return;
  teardownGame();
  lobby = createLobby({
    container: screen,
    net,
    rounds,
    roomCode,
    minPlayers: MIN_SEATS,
    maxPlayers: MAX_SEATS_MP,
    note: 'The host’s browser deals the roles — play with people you’d hand a deck of cards.',
    // Only the host chooses; everyone else sees what they are about to play, so
    // nobody is surprised by a three-night Blackout they did not pick.
    modeSlot: () => {
      const seats = Math.max(MIN_SEATS, rounds!.state().present.length);
      return net!.isHost() ? modePicker(seats) + visibilityPicker() : modeNote(seats);
    },
    onModeMount: () => {
      wireModePicker(() => lobby?.repaint());
      wireVisibility(() => lobby?.repaint());
    },
    onCancel: () => showMenu(),
  });
  syncListing();
}

/**
 * Register this round's receivers on the shared Net, and hand back the detach.
 *
 * The Net now outlives every round, and channel() fans out to all subscribers —
 * so a finished round that stays subscribed keeps answering: the old host would
 * resolve the next table's actions against the dead one and broadcast snapshots
 * of it over the live game.
 *
 * The role re-attest deliberately does NOT use 'rq' — that name belongs to
 * rematch.ts's resync, and with fan-out both handlers fire, so every resync poll
 * would make each peer publish its secret role to the room.
 */
function wireRound(n: Net): { transport: Transport; off: () => void } {
  const sendSnap = n.channel<PublicState>(GAME_CHANNELS.snap, (pub) => session?.onSnapshot(pub));
  const sendPriv = n.channel<PrivateView>(GAME_CHANNELS.priv, (p) => session?.onPrivate(p));
  const sendAct = n.channel<Action>(GAME_CHANNELS.act, (a, from) => session?.onAction(from, a));
  const sendRq = n.channel<null>(GAME_CHANNELS.roleRequest, (_d, from) => session?.onRoleRequest(from));
  const sendRl = n.channel<{ role: Role }>(GAME_CHANNELS.roleReply, (m, from) =>
    session?.onRoleReply(from, m.role),
  );

  return {
    transport: {
      sendSnap: (pub) => sendSnap(pub),
      sendPriv: (to, priv) => sendPriv(priv, to),
      sendAct: (a) => sendAct(a),
      requestRoles: () => sendRq(null),
      sendRole: (to, role) => sendRl({ role }, to),
    },
    off: () => {
      sendSnap.off();
      sendPriv.off();
      sendAct.off();
      sendRq.off();
      sendRl.off();
    },
  };
}

function startTable(seed: number, players: RoundPlayer[], isHost: boolean, opts: unknown): void {
  if (!net) return;
  teardownGame();
  lobby?.destroy();
  lobby = null;
  // The table is starting, so the room comes off the list right now — not up to
  // a tick later, and not "once someone notices". syncListing reads `lobby`,
  // which is the null above.
  syncListing();

  // The roster arrives frozen from the host, identical bytes on every peer, so
  // seat N is the same player everywhere — and it is what authority follows.
  if (!players.some((p) => p.id === net!.selfId)) {
    // Not dealt into this table (we joined mid-deal). Wait for the next one
    // rather than sitting at a table we hold no seat at.
    showLobby();
    flash('Next round — you’re in the lobby');
    return;
  }

  const wire = wireRound(net);
  unwireRound = wire.off;

  // The mode arrives frozen from the host, identical bytes on every peer — but
  // only the host consumes it. A client rebuilds the ghost count and the night
  // budget from the snapshot instead, which is exactly why a promoted host needs
  // no copy of it to take the deal over.
  const mode = modeOf((opts as { mode?: unknown } | undefined)?.mode);

  const s = new Session({
    selfId: net.selfId,
    solo: false,
    transport: wire.transport,
    roster: players.map((p) => p.id),
    rules: rulesFor(mode, players.length),
    deadlines: mode.deadlines,
    onPublic: handlePublic,
    onPrivate: handlePrivate,
    onFlash: (msg) => flash(msg),
    onStranded: () => {
      rounds?.finish();
      showLobby();
    },
  });
  session = s;
  mountGame(net.selfId, playAgain, true);

  // The Session is wired NOW so no snapshot can arrive before anyone is
  // listening, but the DEAL waits for GO. Delaying the whole Session instead
  // would mean a peer whose countdown is throttled (a backgrounded tab) misses
  // the host's opening snapshot and stares at an empty table until someone acts.
  if (isHost) {
    runCountdown(() => {
      s.startAsHost(
        seed,
        players.map((p) => ({ id: p.id, name: p.name, bot: false })),
      );
      // AFTER the deal, never before: setHost(true) on a host holding no state
      // and no snapshot is the stranded branch, and it would fire every round.
      syncAuthority();
    });
    return;
  }

  // Clients hold no authoritative state — they render snapshots, and run the
  // clock only so a promotion can time out cleanly.
  s.start();
  runCountdown(() => {});
  syncAuthority();
}

/** The three beats before the first night. Overlays the table; blocks nothing. */
function runCountdown(onDone: () => void): void {
  cancelCountdown();
  const host = document.createElement('div');
  host.className = 'cd-host';
  app.appendChild(host);
  const cd = createCountdown({
    root: host,
    sfx,
    reducedMotion,
    onDone: () => {
      countdown = null;
      host.remove();
      onDone();
    },
  });
  // cancel() removes the overlay but not the host we made for it, so wrap it:
  // a leftover .cd-host is a fixed, full-screen element sitting over the table.
  countdown = {
    cancel: () => {
      cd.cancel();
      host.remove();
    },
  };
}

function cancelCountdown(): void {
  countdown?.cancel();
  countdown = null;
}

/**
 * Hand the deal to the right seat.
 *
 * net.ts is the single answer to "who hosts this room" — the incumbent, until it
 * leaves. session.authorityFor() takes that answer and only overrides it in the
 * one case net.ts cannot see: a room host holding no seat at this table.
 *
 * Nothing may be decided before the room settles. An unsettled peer has heard
 * from nobody, so host() is null — treating that as "no incumbent, elect
 * locally" is how every peer used to crown itself on a mesh that never formed.
 */
function syncAuthority(): void {
  if (!net || !session) return;
  if (!net.hostSettled()) return;
  session.setHost(session.authorityFor(net.peers(), net.host()) === net.selfId);
}

/**
 * "Play again" in a room. NOT a rejoin: the mesh stays exactly as it is and this
 * only registers a vote — the next table is dealt underneath us once everyone
 * has voted. Leaving and rejoining here is what used to strand every player
 * alone as their own host (see the engine's net.ts).
 */
function playAgain(): void {
  if (!rounds) return;
  if (rounds.state().voted) rounds.unvote();
  else rounds.vote();
  paintAgain();
}

function paintAgain(): void {
  if (!rounds || !gameUi) return;
  const s = rounds.state();
  const waiting = s.present.length - s.votes.length;
  const secs = s.startsInMs !== null ? Math.ceil(s.startsInMs / 1000) : null;

  let status: string;
  if (!s.voted) {
    status = `${s.votes.length}/${s.present.length} ready for another table`;
  } else if (secs !== null) {
    // Say WHY we are still waiting and when it ends. A bare "waiting…" with no
    // horizon is exactly what made the old unanimity rule feel like a hang.
    status = `Dealing in ${secs}s — waiting for ${waiting} more player${waiting === 1 ? '' : 's'}`;
  } else if (waiting > 0) {
    status = `Waiting for ${waiting} more player${waiting === 1 ? '' : 's'}…`;
  } else {
    status = 'Dealing…';
  }

  gameUi.setAgain({
    label: s.voted ? 'Ready — waiting…' : 'Play again',
    status,
    // Nothing to force while the whole table is already in: the deal is imminent.
    canStart: s.canStart && s.votes.length < s.present.length,
  });
}

window.addEventListener('beforeunload', () => {
  try {
    void net?.leave();
  } catch {
    /* leaving is best-effort */
  }
});

// ---------------------------------------------------------------------------
// Game mount + juice
// ---------------------------------------------------------------------------

/** `room` adds the controls that only mean anything with other people in it. */
function mountGame(selfId: string, again: () => void, room = false): void {
  prevPub = null;
  gameUi = createGameUi(screen, {
    selfId,
    ...(room
      ? {
          onStartNow: () => rounds?.go(),
          onLobby: () => {
            // Back to the lobby WITHOUT leaving the room — the mesh, the roster
            // and everyone's records survive. From there you can wait, re-ready,
            // or just see who is still around, instead of the summary being a
            // dead end whose only way out was the menu.
            rounds?.unvote();
            showLobby();
          },
        }
      : {}),
    onProbe: (t) => {
      play('probe');
      session?.act({ t: 'probe', target: t });
    },
    onCut: (t) => {
      play('cut');
      session?.act({ t: 'cut', target: t });
    },
    onClaim: (v) => {
      play('claim');
      session?.act({ t: 'claim', value: v });
    },
    onVote: (t) => {
      play('vote');
      session?.act({ t: 'vote', target: t });
    },
    onAgain: again,
    onMenu: () => showMenu(),
  });

  const canvas = screen.querySelector<HTMLCanvasElement>('[data-fx]');
  const shakeTarget = screen.querySelector<HTMLElement>('[data-shake]');
  if (canvas && shakeTarget) fx = createFx(canvas, shakeTarget);
}

function centreOf(id: string): [number, number] | null {
  const el = gameUi?.seatEl(id);
  const wrap = screen.querySelector<HTMLElement>('[data-shake]');
  if (!el || !wrap) return null;
  const a = el.getBoundingClientRect();
  const b = wrap.getBoundingClientRect();
  if (b.width < 1) return null;
  return [a.left - b.left + a.width / 2, a.top - b.top + a.height / 2];
}

function handlePublic(pub: PublicState): void {
  gameUi?.update(pub, session?.privateState() ?? null);

  // Juice is driven by diffing snapshots, so it fires identically for the host,
  // a client, and a promoted peer.
  if (prevPub) {
    if (pub.darkened && pub.darkened !== prevPub.darkened) {
      play('cut');
      fx?.shake(7);
      // A spark runs from the middle of the table out to the console that died.
      const to = centreOf(pub.darkened);
      const from = tableCentre();
      if (to && from) fx?.spark(from, to, '#ffb347');
    }
    const e = pub.lastEjected;
    if (e && e.id !== prevPub.lastEjected?.id) {
      play('eject');
      fx?.shake(14);
      const c = centreOf(e.id);
      if (c) fx?.burst(c[0], c[1], e.role === 'ghost' ? '#a882ff' : '#3fd0c9', 26);
      setTimeout(() => play(e.role === 'ghost' ? 'ghost' : 'crew'), 320);
    }
    if (pub.winner && !prevPub.winner) {
      const priv = session?.privateState();
      const won =
        (pub.winner === 'crew' && priv?.role === 'crew') || (pub.winner === 'ghosts' && priv?.role === 'ghost');
      play(won ? 'win' : 'lose');
      fx?.shake(10);
      if (won) {
        const c = centreOf(session!.selfId);
        if (c) fx?.burst(c[0], c[1], '#ffb347', 40);
      }
      recordResult(pub.winner, priv?.role);
      // Reopen voting in the room. The table is done; the mesh is not.
      rounds?.finish();
      if (rounds) {
        paintAgain();
        againTick = setInterval(paintAgain, 500);
      }
    }
  }
  prevPub = pub;
}

function tableCentre(): [number, number] | null {
  const w = screen.querySelector<HTMLElement>('[data-shake]');
  if (!w || w.clientWidth < 1) return null;
  return [w.clientWidth / 2, w.clientHeight / 2];
}

function handlePrivate(priv: PrivateView | null): void {
  const pub = session?.publicState();
  if (pub) gameUi?.update(pub, priv);
}

function recordResult(winner: 'crew' | 'ghosts', role?: Role): void {
  if (!role) return;
  const won = (winner === 'crew' && role === 'crew') || (winner === 'ghosts' && role === 'ghost');
  const key = role === 'ghost' ? 'record-ghost' : 'record-crew';
  const rec = store.get<{ w: number; l: number }>(key, { w: 0, l: 0 });
  store.set(key, { w: rec.w + (won ? 1 : 0), l: rec.l + (won ? 0 : 1) });
}

function flash(msg: string): void {
  let el = app.querySelector<HTMLElement>('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    app.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el?.classList.remove('show'), 3200);
}

/** Drop the table, keeping the room (and its Net) alive for the next one. */
function teardownGame(): void {
  cancelCountdown();
  session?.destroy();
  session = null;
  gameUi?.destroy();
  gameUi = null;
  fx?.destroy();
  fx = null;
  prevPub = null;
  unwireRound?.();
  unwireRound = null;
  if (againTick) clearInterval(againTick);
  againTick = null;
  screen.innerHTML = '';
}

/** Resolves once any in-flight room teardown has fully finished. */
let roomTeardown: Promise<void> = Promise.resolve();

/**
 * Leave the room for good. Only ever on the way to the menu — NEVER between
 * tables. `net.leave()` is awaited because Trystero keeps the room in its cache
 * until teardown finishes; joining again before then hands back the dying room
 * and every peer ends up alone, elected host of nothing. A rematch keeps the Net
 * and deals a new round inside it (the engine's rematch.ts).
 */
function leaveRoom(): Promise<void> {
  teardownGame();
  lobby?.destroy();
  lobby = null;
  roomEntry?.destroy();
  roomEntry = null;
  rounds?.destroy();
  rounds = null;
  // Off the list and off the board, before anything else can go wrong. Leaving
  // is one of the three ways a room stops being public (the others are going
  // private and dealing a table) and it is the one where nobody is left to
  // notice a stale listing.
  listing?.close();
  listing = null;
  if (listingTick) clearInterval(listingTick);
  listingTick = null;
  roomPublic = false;
  roomCode = '';
  // Also covers a board opened by the browse screen: leaveRoom() is on every
  // path out of it.
  boardAccess.close();
  // The room is over for us — take the code out of the URL so a refresh, or
  // reopening from the home-screen icon, lands on the menu instead of silently
  // dragging us back into a table we walked away from.
  clearRoomInUrl();
  const leaving = net;
  net = null;
  // CHAIN, never replace. leaveRoom() runs again on the way into a new room, and
  // by then `net` is already null — replacing the promise there would hand back
  // an instantly-resolved teardown while the real one was still inside
  // Trystero's 99ms window, and the next createNet would throw.
  roomTeardown = roomTeardown.then(() => leaving?.leave()).then(
    () => undefined,
    () => undefined,
  );
  return roomTeardown;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

if (pendingRoom) {
  // Arriving on an invite link goes straight to that room.
  showRoomEntry();
} else {
  showMenu();
}
