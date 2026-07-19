/**
 * sound.ts — procedural sound effects via the Web Audio API. Zero asset files.
 * Call sfx.unlock() from the first user gesture.
 *
 * Stays game-side rather than importing @ben-gy/game-engine/sound: the package's
 * SfxName is a closed union of arcade cues (coin/jump/hit/explosion/powerup) and
 * createSfx() takes no patch overrides, so Nightwire's vocabulary — probe, cut,
 * claim, vote, eject, ghost, crew, tick — cannot be expressed through it. The
 * oscillator plumbing also carries try/catch hardening the package lacks: a cue
 * that throws (a suspended context on iOS, a blocked AudioContext) must never be
 * able to take a live table down.
 */

export type SfxName =
  | 'blip'
  | 'select'
  | 'probe'
  | 'cut'
  | 'claim'
  | 'vote'
  | 'eject'
  | 'ghost'
  | 'crew'
  | 'tick'
  | 'lose'
  | 'win';

interface Patch {
  type: OscillatorType;
  /** [startFreq, endFreq] Hz — glides between them over `dur`. */
  freq: [number, number];
  dur: number;
  /** Peak gain 0..1. */
  gain?: number;
  /** Add a short noise burst (snaps/whooshes). */
  noise?: boolean;
}

const PATCHES: Record<SfxName, Patch> = {
  blip: { type: 'square', freq: [440, 620], dur: 0.06, gain: 0.18 },
  select: { type: 'triangle', freq: [520, 880], dur: 0.09, gain: 0.2 },
  // A soft sonar ping — the probe reaching into the dark.
  probe: { type: 'sine', freq: [980, 520], dur: 0.28, gain: 0.22 },
  // A wire snapping: bright transient collapsing into noise.
  cut: { type: 'sawtooth', freq: [720, 60], dur: 0.22, gain: 0.3, noise: true },
  claim: { type: 'triangle', freq: [660, 760], dur: 0.07, gain: 0.16 },
  vote: { type: 'square', freq: [240, 180], dur: 0.1, gain: 0.24 },
  // Airlock whoosh as a seat is ejected.
  eject: { type: 'sawtooth', freq: [420, 70], dur: 0.6, gain: 0.32, noise: true },
  // Dissonant sting: a Ghost is revealed.
  ghost: { type: 'sawtooth', freq: [180, 300], dur: 0.55, gain: 0.3 },
  // Falling tone: they were Crew. You were wrong.
  crew: { type: 'sine', freq: [520, 200], dur: 0.5, gain: 0.24 },
  tick: { type: 'square', freq: [900, 900], dur: 0.04, gain: 0.14 },
  lose: { type: 'sawtooth', freq: [400, 90], dur: 0.9, gain: 0.3 },
  win: { type: 'triangle', freq: [520, 1180], dur: 0.7, gain: 0.28 },
};

export interface Sfx {
  unlock(): void;
  play(name: SfxName): void;
  muted(): boolean;
  setMuted(m: boolean): void;
}

export function createSfx(initialMuted = false): Sfx {
  let ctx: AudioContext | null = null;
  let muted = initialMuted;

  const ensure = (): AudioContext | null => {
    try {
      if (!ctx) {
        const AC =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
      }
      if (ctx.state === 'suspended') void ctx.resume();
      return ctx;
    } catch {
      // Audio unavailable (blocked/unsupported) — the game stays fully playable.
      return null;
    }
  };

  const noiseBuffer = (ac: AudioContext, dur: number): AudioBuffer => {
    const len = Math.floor(ac.sampleRate * dur);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  };

  return {
    unlock() {
      ensure();
    },
    play(name) {
      if (muted) return;
      const ac = ensure();
      if (!ac) return;
      try {
        const p = PATCHES[name];
        const t0 = ac.currentTime;
        const g = ac.createGain();
        g.gain.setValueAtTime(p.gain ?? 0.25, t0);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + p.dur);
        g.connect(ac.destination);

        const osc = ac.createOscillator();
        osc.type = p.type;
        osc.frequency.setValueAtTime(p.freq[0], t0);
        osc.frequency.exponentialRampToValueAtTime(Math.max(1, p.freq[1]), t0 + p.dur);
        osc.connect(g);
        osc.start(t0);
        osc.stop(t0 + p.dur);

        if (p.noise) {
          const n = ac.createBufferSource();
          n.buffer = noiseBuffer(ac, p.dur);
          const ng = ac.createGain();
          ng.gain.setValueAtTime((p.gain ?? 0.25) * 0.6, t0);
          ng.gain.exponentialRampToValueAtTime(0.0001, t0 + p.dur);
          n.connect(ng);
          ng.connect(ac.destination);
          n.start(t0);
          n.stop(t0 + p.dur);
        }
      } catch {
        /* a failed cue must never break the game */
      }
    },
    muted: () => muted,
    setMuted(m) {
      muted = m;
    },
  };
}
