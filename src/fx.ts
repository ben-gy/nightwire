// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * fx.ts — particles and screen shake on a canvas sitting behind the seat ring.
 *
 * Purely decorative: if this file did nothing at all, the game would still be
 * fully playable. It respects prefers-reduced-motion by degrading to nothing.
 */

export interface Fx {
  burst(x: number, y: number, color: string, n?: number): void;
  spark(from: [number, number], to: [number, number], color: string): void;
  shake(strength?: number): void;
  resize(): void;
  destroy(): void;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: string;
}

interface Spark {
  from: [number, number];
  to: [number, number];
  t: number;
  color: string;
}

const reducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function createFx(canvas: HTMLCanvasElement, shakeTarget: HTMLElement): Fx {
  const ctx = canvas.getContext('2d');
  const particles: Particle[] = [];
  const sparks: Spark[] = [];
  let shakeAmt = 0;
  let raf = 0;
  let w = 0;
  let h = 0;

  function resize(): void {
    const rect = canvas.getBoundingClientRect();
    // Guard against a transient 0-size measurement: computing a scale from a
    // 0x0 rect yields NaN/Infinity and silently corrupts every coordinate.
    if (rect.width < 1 || rect.height < 1) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = rect.width;
    h = rect.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function frame(): void {
    raf = requestAnimationFrame(frame);
    if (!ctx || w < 1) return;
    ctx.clearRect(0, 0, w, h);

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= 1 / 60;
      if (p.life <= 0) {
        particles.splice(i, 1);
        continue;
      }
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.05; // a little gravity so embers fall
      p.vx *= 0.99;
      const a = p.life / p.max;
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1 + a * 2.2, 0, Math.PI * 2);
      ctx.fill();
    }

    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.t += 0.035;
      if (s.t >= 1) {
        sparks.splice(i, 1);
        continue;
      }
      const x = s.from[0] + (s.to[0] - s.from[0]) * s.t;
      const y = s.from[1] + (s.to[1] - s.from[1]) * s.t;
      ctx.globalAlpha = 1 - s.t;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(s.from[0], s.from[1]);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    if (shakeAmt > 0.1) {
      shakeAmt *= 0.88;
      const dx = (Math.random() - 0.5) * shakeAmt;
      const dy = (Math.random() - 0.5) * shakeAmt;
      shakeTarget.style.transform = `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px)`;
    } else if (shakeAmt !== 0) {
      shakeAmt = 0;
      shakeTarget.style.transform = '';
    }
  }

  const ro =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => resize())
      : null;
  ro?.observe(canvas);
  window.addEventListener('resize', resize);
  resize();
  raf = requestAnimationFrame(frame);

  return {
    burst(x, y, color, n = 18) {
      if (reducedMotion()) return;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 0.6 + Math.random() * 2.6;
        const life = 0.5 + Math.random() * 0.7;
        particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 0.6, life, max: life, color });
      }
    },
    spark(from, to, color) {
      if (reducedMotion()) return;
      sparks.push({ from, to, t: 0, color });
    },
    shake(strength = 10) {
      if (reducedMotion()) return;
      shakeAmt = strength;
    },
    resize,
    destroy() {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener('resize', resize);
      shakeTarget.style.transform = '';
    },
  };
}
