/**
 * ui.ts — the table, the ledger, and the action panel.
 *
 * The seat ring is plain DOM positioned with percentage trig, so it needs no
 * element measurement at all (nothing to go NaN, nothing to re-layout on
 * resize) and every seat is a real <button> — keyboard and screen readers work
 * for free.
 */

import {
  publicWindow,
  publicMaxClaim,
  type PublicState,
  type PrivateView,
  type LedgerRow,
} from './game';

export interface UiCallbacks {
  /** Which seat is the local player. */
  selfId: string;
  onProbe(target: string): void;
  onCut(target: string): void;
  onClaim(value: number): void;
  onVote(target: string): void;
  onAgain(): void;
  onMenu(): void;
}

export interface GameUi {
  update(pub: PublicState, priv: PrivateView | null): void;
  seatEl(id: string): HTMLElement | null;
  destroy(): void;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

export function createGameUi(container: HTMLElement, cb: UiCallbacks): GameUi {
  const selfId = cb.selfId;
  container.innerHTML = `
    <div class="game">
      <div class="hud">
        <div class="hud-round"><span class="hud-k">Round</span> <span class="hud-v" data-round>1</span></div>
        <div class="blackout" title="Wire cuts before the lights go out">
          <span class="hud-k">Blackout</span>
          <div class="meter" data-meter role="img" aria-label="blackout progress"></div>
        </div>
        <div class="hud-phase" data-phase>Night</div>
      </div>

      <div class="table-wrap" data-shake>
        <canvas class="fx" data-fx aria-hidden="true"></canvas>
        <div class="ring" data-ring></div>
        <div class="ring-mid" data-mid></div>
      </div>

      <div class="panel" data-panel role="region" aria-live="polite"></div>

      <details class="ledger" open>
        <summary>The ledger <span class="hint">every published reading</span></summary>
        <div data-ledger></div>
      </details>

      <details class="logbox">
        <summary>Night log</summary>
        <ol data-log></ol>
      </details>
    </div>`;

  const ring = container.querySelector<HTMLElement>('[data-ring]')!;
  const mid = container.querySelector<HTMLElement>('[data-mid]')!;
  const panel = container.querySelector<HTMLElement>('[data-panel]')!;
  const ledgerEl = container.querySelector<HTMLElement>('[data-ledger]')!;
  const logEl = container.querySelector<HTMLElement>('[data-log]')!;
  const roundEl = container.querySelector<HTMLElement>('[data-round]')!;
  const meterEl = container.querySelector<HTMLElement>('[data-meter]')!;
  const phaseEl = container.querySelector<HTMLElement>('[data-phase]')!;

  const seatEls = new Map<string, HTMLButtonElement>();
  let last: PublicState | null = null;
  let lastPriv: PrivateView | null = null;
  /** The window the player is currently inspecting (tap a seat to preview). */
  let hovered: string | null = null;

  function buildSeats(pub: PublicState): void {
    ring.innerHTML = '';
    seatEls.clear();
    const n = pub.seats.length;
    pub.seats.forEach((s, i) => {
      // -90deg puts seat 0 at the top; percentages are of the ring box, so this
      // needs no measurement and scales to any viewport.
      const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'seat';
      el.dataset.id = s.id;
      el.style.left = `${(50 + 39 * Math.cos(a)).toFixed(3)}%`;
      el.style.top = `${(50 + 39 * Math.sin(a)).toFixed(3)}%`;
      el.innerHTML = `
        <span class="seat-num" data-num></span>
        <span class="seat-name" data-name></span>
        <span class="seat-tag" data-tag></span>
        <span class="seat-votes" data-votes></span>`;
      el.addEventListener('click', () => onSeatClick(s.id));
      el.addEventListener('pointerenter', () => {
        hovered = s.id;
        paintWindow();
      });
      el.addEventListener('pointerleave', () => {
        hovered = null;
        paintWindow();
      });
      ring.appendChild(el);
      seatEls.set(s.id, el);
    });
  }

  function onSeatClick(id: string): void {
    const pub = last;
    const priv = lastPriv;
    if (!pub || !priv) return;
    const self = pub.seats.find((s) => s.id === selfId);
    const target = pub.seats.find((s) => s.id === id);
    // Tapping is also how you inspect a window on touch — do that regardless.
    hovered = id;
    paintWindow();
    if (!self?.alive || !target?.alive) return;

    if (pub.phase === 'night') {
      if (!priv.probeTarget) {
        if (id !== selfId) cb.onProbe(id);
      } else if (priv.role === 'ghost' && !priv.cutTarget) {
        cb.onCut(id);
      }
    } else if (pub.phase === 'vote') {
      cb.onVote(id);
    }
  }

  function paintWindow(): void {
    if (!last) return;
    const win = hovered ? publicWindow(last, hovered) : [];
    for (const [id, el] of seatEls) el.classList.toggle('in-window', win.includes(id));
  }

  function claimThisRound(pub: PublicState, id: string): LedgerRow | undefined {
    return pub.ledger.find((r) => r.round === pub.round && r.by === id);
  }

  function update(pub: PublicState, priv: PrivateView | null): void {
    const rebuilt = !last || last.seats.length !== pub.seats.length;
    last = pub;
    lastPriv = priv;
    if (rebuilt) buildSeats(pub);

    roundEl.textContent = String(pub.round);
    phaseEl.textContent =
      pub.phase === 'night'
        ? 'Night'
        : pub.phase === 'dawn'
          ? 'Dawn'
          : pub.phase === 'vote'
            ? 'Vote'
            : pub.phase === 'resolve'
              ? 'Reveal'
              : 'Over';
    phaseEl.dataset.p = pub.phase;

    // Blackout meter — one pip per cut the Ghosts still need.
    meterEl.innerHTML = Array.from(
      { length: pub.blackoutAt },
      (_, i) => `<i class="${i < pub.cuts ? 'cut' : ''}"></i>`,
    ).join('');
    meterEl.setAttribute('aria-label', `${pub.cuts} of ${pub.blackoutAt} wires cut`);

    const tally = new Map<string, number>();
    for (const t of Object.values(pub.votes)) tally.set(t, (tally.get(t) ?? 0) + 1);

    for (const s of pub.seats) {
      const el = seatEls.get(s.id);
      if (!el) continue;
      const row = claimThisRound(pub, s.id);
      const num = el.querySelector<HTMLElement>('[data-num]')!;
      const name = el.querySelector<HTMLElement>('[data-name]')!;
      const tag = el.querySelector<HTMLElement>('[data-tag]')!;
      const votes = el.querySelector<HTMLElement>('[data-votes]')!;

      name.textContent = s.name;
      // The published number is the whole point — show it big, on the seat.
      num.textContent = row ? (row.dark ? '·' : String(row.claim ?? '')) : '';
      el.classList.toggle('has-num', !!row);
      el.classList.toggle('dark', !!row?.dark || pub.darkened === s.id);
      el.classList.toggle('out', !s.alive);
      el.classList.toggle('self', s.id === selfId);
      el.classList.toggle('acted', pub.acted.includes(s.id));
      el.classList.toggle('ally', !!priv?.allies.includes(s.id));
      el.classList.toggle('role-ghost', s.role === 'ghost');
      el.classList.toggle('role-crew', s.role === 'crew');

      const tags: string[] = [];
      // Skip the badge when the seat is literally named "You" (solo) — the name
      // already says it.
      if (s.id === selfId && s.name !== 'You') tags.push('YOU');
      if (priv?.allies.includes(s.id)) tags.push('ALLY');
      if (s.role === 'ghost') tags.push('GHOST');
      else if (s.role === 'crew') tags.push('CREW');
      if (s.gone) tags.push('LEFT');
      tag.textContent = tags.join(' · ');

      const n = tally.get(s.id) ?? 0;
      votes.textContent = n > 0 ? '●'.repeat(Math.min(n, 6)) : '';
      el.setAttribute(
        'aria-label',
        `${s.name}${s.id === selfId ? ' (you)' : ''}${row && !row.dark ? `, published ${row.claim}` : ''}${
          s.alive ? '' : `, ejected — ${s.role}`
        }${n ? `, ${n} vote${n === 1 ? '' : 's'}` : ''}`,
      );
      el.disabled = !s.alive || pub.phase === 'over';
    }

    mid.innerHTML = midCopy(pub, priv);
    renderPanel(pub, priv);
    renderLedger(pub);
    logEl.innerHTML = pub.log
      .slice(-14)
      .reverse()
      .map((l) => `<li>${escapeHtml(l)}</li>`)
      .join('');
    paintWindow();
  }

  /** The Ghosts have two ways to win; say which one actually happened. */
  function byBlackout(pub: PublicState): boolean {
    return pub.cuts >= pub.blackoutAt;
  }

  function midCopy(pub: PublicState, priv: PrivateView | null): string {
    if (pub.phase === 'over') {
      const label = pub.winner === 'crew' ? 'CREW HOLD' : byBlackout(pub) ? 'BLACKOUT' : 'GHOSTS WIN';
      return `<div class="mid-big ${pub.winner}">${label}</div>`;
    }
    const left = pub.blackoutAt - pub.cuts;
    return `
      <div class="mid-role ${priv?.role ?? ''}">${priv ? (priv.role === 'ghost' ? 'You are a GHOST' : 'You are CREW') : ''}</div>
      <div class="mid-sub">${left} cut${left === 1 ? '' : 's'} to blackout</div>`;
  }

  function waiting(pub: PublicState, verb: string): string {
    const outstanding = pub.seats.filter((s) => s.alive && !s.gone && !pub.acted.includes(s.id)).length;
    return `<p class="wait"><span class="spinner sm" aria-hidden="true"></span> ${verb}${
      outstanding ? ` — waiting on ${outstanding} seat${outstanding === 1 ? '' : 's'}` : ''
    }</p>`;
  }

  function renderPanel(pub: PublicState, priv: PrivateView | null): void {
    const self = pub.seats.find((s) => s.id === selfId);
    if (!priv || !self) {
      panel.innerHTML = `<p class="wait"><span class="spinner sm"></span> Joining the table…</p>`;
      return;
    }

    if (pub.phase === 'over') {
      const won =
        (pub.winner === 'crew' && priv.role === 'crew') || (pub.winner === 'ghosts' && priv.role === 'ghost');
      panel.innerHTML = `
        <div class="result ${won ? 'win' : 'lose'}">
          <h2>${won ? 'You win' : 'You lose'}</h2>
          <p>${
            pub.winner === 'crew'
              ? 'Every Ghost was found. The station holds.'
              : byBlackout(pub)
                ? 'The last wire parted. Blackout.'
                : 'The Ghosts outnumber the Crew. There was no one left to stop them.'
          }</p>
          <p class="result-sub">You were <strong>${priv.role === 'ghost' ? 'a Ghost' : 'Crew'}</strong>.</p>
          <div class="row">
            <button class="btn primary" data-again>Play again</button>
            <button class="btn ghost" data-menu>Menu</button>
          </div>
        </div>`;
      panel.querySelector('[data-again]')?.addEventListener('click', () => cb.onAgain());
      panel.querySelector('[data-menu]')?.addEventListener('click', () => cb.onMenu());
      return;
    }

    if (!self.alive) {
      panel.innerHTML = `<p class="dead-note">You're out of the game — but you can watch it play out.</p>${waiting(
        pub,
        'The table continues',
      )}`;
      return;
    }

    switch (pub.phase) {
      case 'night': {
        if (!priv.probeTarget) {
          panel.innerHTML = `<p class="ask">Choose a seat to <strong>probe</strong>.</p>
            <p class="sub">You'll learn how many Ghosts sit in that 3-seat window.</p>`;
          return;
        }
        const t = pub.seats.find((s) => s.id === priv.probeTarget)?.name ?? '?';
        if (priv.role === 'ghost' && !priv.cutTarget) {
          panel.innerHTML = `<p class="ask">Probing <strong>${escapeHtml(t)}</strong>. Now choose a console to <strong>cut</strong>.</p>
            <p class="sub">That seat gets no reading at dawn.</p>`;
          return;
        }
        panel.innerHTML = `<p class="locked">Probing <strong>${escapeHtml(t)}</strong>.</p>${waiting(
          pub,
          'Waiting for the table',
        )}`;
        return;
      }
      case 'dawn': {
        if (priv.reading === null) {
          panel.innerHTML = `<p class="ask">Your console is <strong>dark</strong>. You have nothing to publish tonight.</p>${waiting(
            pub,
            'Dawn is breaking',
          )}`;
          return;
        }
        if (priv.role === 'crew') {
          panel.innerHTML = `<p class="reading">Your reading: <strong class="big">${priv.reading}</strong></p>
            <p class="sub">Crew readings publish automatically, exactly as taken.</p>${waiting(pub, 'Dawn is breaking')}`;
          return;
        }
        const max = priv.probeTarget ? publicMaxClaim(pub, priv.probeTarget) : 0;
        const published = pub.acted.includes(selfId);
        panel.innerHTML = `
          <p class="reading">Your true reading: <strong class="big">${priv.reading}</strong></p>
          <p class="sub">You're a Ghost — publish whatever you like.</p>
          <div class="claims">${Array.from(
            { length: max + 1 },
            (_, v) => `<button class="claim ${v === priv.reading ? 'is-truth' : ''}" data-claim="${v}">${v}</button>`,
          ).join('')}</div>
          ${published ? waiting(pub, 'Published') : ''}`;
        panel.querySelectorAll<HTMLButtonElement>('[data-claim]').forEach((b) =>
          b.addEventListener('click', () => cb.onClaim(Number(b.dataset.claim))),
        );
        return;
      }
      case 'vote': {
        const mine = pub.votes[selfId];
        const name = mine ? pub.seats.find((s) => s.id === mine)?.name : null;
        panel.innerHTML = `<p class="ask">Vote to <strong>eject</strong> a seat.</p>
          ${name ? `<p class="locked">You voted for <strong>${escapeHtml(name)}</strong>. Tap another seat to change it.</p>` : ''}
          ${waiting(pub, 'Votes are coming in')}`;
        return;
      }
      case 'resolve': {
        const e = pub.lastEjected;
        panel.innerHTML = e
          ? `<p class="reveal ${e.role}">${escapeHtml(
              pub.seats.find((s) => s.id === e.id)?.name ?? '',
            )} was <strong>${e.role === 'ghost' ? 'a GHOST' : 'CREW'}</strong>.</p>`
          : `<p class="reveal">The table deadlocked. Nobody was ejected.</p>`;
        return;
      }
    }
  }

  function renderLedger(pub: PublicState): void {
    if (pub.ledger.length === 0) {
      ledgerEl.innerHTML = `<p class="empty">Nothing published yet. The first readings arrive at dawn.</p>`;
      return;
    }
    const nameOf = (id: string) => pub.seats.find((s) => s.id === id)?.name ?? id;
    const rounds = [...new Set(pub.ledger.map((r) => r.round))].sort((a, b) => b - a);
    ledgerEl.innerHTML = rounds
      .map((rd) => {
        const rows = pub.ledger.filter((r) => r.round === rd);
        return `<div class="lg-round">
          <h4>Round ${rd}</h4>
          <ul>
            ${rows
              .map(
                (r) => `<li class="${r.dark ? 'is-dark' : ''}">
                  <span class="lg-by">${escapeHtml(nameOf(r.by))}</span>
                  <span class="lg-arrow" aria-hidden="true">→</span>
                  <span class="lg-target">${escapeHtml(nameOf(r.target))}</span>
                  <span class="lg-claim">${r.dark ? 'dark' : r.claim}</span>
                </li>`,
              )
              .join('')}
          </ul>
        </div>`;
      })
      .join('');
  }

  return {
    update,
    seatEl: (id) => seatEls.get(id) ?? null,
    destroy() {
      container.innerHTML = '';
    },
  };
}
