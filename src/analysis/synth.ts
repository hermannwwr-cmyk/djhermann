/**
 * Synthetic test music with an exactly known beat grid: used by the unit tests and by the dev
 * harness (which wraps it in a WAV file to exercise the real import path). Not part of the game.
 */
import { rng } from '../core/math';
import { BEATS_PER_BAR } from '../core/types';
import type { BeatGrid, PcmData, SectionKind } from '../core/types';

export type SynthPattern =
  | 'house' // kick on every beat, off-beat hat, clap on 2 and 4
  | 'click' // a metronome: one short click per beat
  | 'breakbeat' // kick on 1 and the "and" of 3, snare on 2 and 4, eighth-note hats
  | 'halftime' // kick on 1, snare on 3, eighth-note hats
  | 'backbeat'; // kick on 1 and 3, snare on 2 and 4, eighth-note hats

export interface SynthPart {
  kind: SectionKind;
  bars: number;
  /** which layers play; anything left out is off */
  kick?: boolean;
  hat?: boolean;
  clap?: boolean;
  bass?: boolean;
  pad?: boolean;
  /** snare roll that speeds up towards the end of the part */
  roll?: boolean;
  /** gain of the whole part (default 1) */
  level?: number;
}

export interface SynthOptions {
  bpm: number;
  sampleRate?: number;
  /** track time of the first downbeat (default 0.1 s) */
  firstBeatSec?: number;
  pattern?: SynthPattern;
  /** arrangement; default: intro without drums, groove, build, drop, quiet break, build, drop, outro */
  parts?: SynthPart[];
  /** total bars when `parts` is not given (default 64): the default arrangement is scaled to fit */
  bars?: number;
  /** white-noise floor, linear amplitude (default 0.004) */
  noise?: number;
  /** add an off-beat bass line in the parts that have `bass` (default true for 'house') */
  offbeatBass?: boolean;
  /** accent the downbeat of a click track (default true) */
  accent?: boolean;
  /** master gain (default 1) */
  gain?: number;
  /** silence after the last bar, seconds (default 0.5) */
  tailSec?: number;
  seed?: number;
}

export interface SynthTrack {
  pcm: PcmData;
  grid: BeatGrid;
  parts: SynthPart[];
  bars: number;
}

const p = (kind: SectionKind, bars: number, on: string, level = 1): SynthPart => ({
  kind,
  bars,
  level,
  kick: on.includes('k'),
  hat: on.includes('h'),
  clap: on.includes('c'),
  bass: on.includes('b'),
  pad: on.includes('p'),
  roll: on.includes('r'),
});

/** The default 64-bar arrangement, scaled to `bars` (multiples of 4 per part). */
export function defaultParts(bars = 64): SynthPart[] {
  const template: SynthPart[] = [
    p('intro', 8, 'p', 0.5),
    p('groove', 8, 'khcb', 0.75),
    p('build', 4, 'khpr', 0.8),
    p('drop', 16, 'khcbp', 1),
    p('break', 8, 'p', 0.4),
    p('build', 4, 'hpr', 0.7),
    p('drop', 8, 'khcbp', 1),
    p('outro', 8, 'kh', 0.6),
  ];
  if (bars === 64) return template;
  const scale = bars / 64;
  const parts = template.map((t) => ({ ...t, bars: Math.max(4, Math.round((t.bars * scale) / 4) * 4) }));
  // absorb the rounding error in the first drop
  const total = parts.reduce((n, t) => n + t.bars, 0);
  parts[3].bars = Math.max(4, parts[3].bars + bars - total);
  return parts;
}

/** Render a synthetic track. Every event starts at its exact (fractional-sample) grid time. */
export function synthTrack(opts: SynthOptions): SynthTrack {
  const sampleRate = opts.sampleRate ?? 44100;
  const bpm = opts.bpm;
  const firstBeatSec = opts.firstBeatSec ?? 0.1;
  const pattern = opts.pattern ?? 'house';
  const parts = opts.parts ?? defaultParts(opts.bars ?? 64);
  const bars = parts.reduce((n, t) => n + t.bars, 0);
  const beatSec = 60 / bpm;
  const totalSec = firstBeatSec + bars * BEATS_PER_BAR * beatSec + (opts.tailSec ?? 0.5);
  const n = Math.ceil(totalSec * sampleRate);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const rand = rng(opts.seed ?? 1);
  const noise = (): number => rand() * 2 - 1;
  const offbeatBass = opts.offbeatBass ?? pattern === 'house';

  /** Add a mono event starting at t0 (seconds): fn(t) for t in [0, lengthSec). */
  const add = (t0: number, lengthSec: number, gainL: number, gainR: number, fn: (t: number) => number): void => {
    const start = Math.max(0, Math.ceil(t0 * sampleRate));
    const end = Math.min(n, Math.floor((t0 + lengthSec) * sampleRate));
    for (let i = start; i < end; i++) {
      const v = fn(i / sampleRate - t0);
      left[i] += v * gainL;
      right[i] += v * gainR;
    }
  };

  const kick = (t0: number, g: number): void => {
    add(t0, 0.36, g, g, (t) => {
      const phase = 2 * Math.PI * (46 * t + 120 * 0.03 * (1 - Math.exp(-t / 0.03)));
      const body = Math.sin(phase) * Math.exp(-t / 0.15) * 0.85;
      const click = t < 0.012 ? noise() * Math.exp(-t / 0.0025) * 0.3 : 0;
      return body + click;
    });
  };

  const hat = (t0: number, g: number, decay = 0.02): void => {
    let prev = 0;
    let prev2 = 0;
    add(t0, decay * 5, g * 0.75, g, (t) => {
      const x = noise();
      const hp = x - 2 * prev + prev2; // second difference: a steep high-pass
      prev2 = prev;
      prev = x;
      return hp * 0.16 * Math.exp(-t / decay);
    });
  };

  const snare = (t0: number, g: number, clap: boolean): void => {
    // band-passed noise around 1.6 kHz (clap: three quick bursts) plus a short 190 Hz body for a snare
    let z1 = 0;
    let z2 = 0;
    const w = (2 * Math.PI * 1600) / sampleRate;
    const alpha = Math.sin(w) / (2 * 0.9);
    const b0 = alpha / (1 + alpha);
    const a1 = (-2 * Math.cos(w)) / (1 + alpha);
    const a2 = (1 - alpha) / (1 + alpha);
    add(t0, 0.22, g, g, (t) => {
      const x = noise();
      const y = b0 * x + z1;
      z1 = -a1 * y + z2;
      z2 = -b0 * x - a2 * y;
      let env: number;
      if (clap) {
        const burst = t < 0.027 ? Math.exp(-(t % 0.009) / 0.003) : 0;
        env = Math.max(burst, t >= 0.018 ? Math.exp(-(t - 0.018) / 0.06) : 0);
      } else {
        env = Math.exp(-t / 0.07);
      }
      const body = clap ? 0 : Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t / 0.04) * 0.5;
      return y * env * 1.6 + body;
    });
  };

  const bassNote = (t0: number, lengthSec: number, freq: number, g: number): void => {
    let lp = 0;
    const k = 1 - Math.exp((-2 * Math.PI * 320) / sampleRate);
    add(t0, lengthSec, g, g, (t) => {
      const saw = 2 * ((t * freq) % 1) - 1;
      lp += (saw - lp) * k;
      const env = Math.min(1, t / 0.006) * Math.min(1, (lengthSec - t) / 0.02);
      return lp * env * 0.5 + Math.sin(2 * Math.PI * freq * t) * env * 0.35;
    });
  };

  const click = (t0: number, g: number, freq: number): void => {
    add(t0, 0.02, g, g, (t) => Math.sin(2 * Math.PI * freq * t) * Math.exp(-t / 0.004) * 0.8);
  };

  const ROOTS = [55, 55, 65.41, 49]; // A1 A1 C2 G1
  const CHORDS = [
    [220, 261.63, 329.63],
    [220, 261.63, 329.63],
    [261.63, 329.63, 392],
    [196, 246.94, 293.66],
  ];

  let bar = 0;
  for (const part of parts) {
    const g = (part.level ?? 1) * (opts.gain ?? 1);
    const partStart = firstBeatSec + bar * BEATS_PER_BAR * beatSec;
    const partBeats = part.bars * BEATS_PER_BAR;
    for (let b = 0; b < partBeats; b++) {
      const t = partStart + b * beatSec;
      const inBar = b % BEATS_PER_BAR;
      const absBar = bar + Math.floor(b / BEATS_PER_BAR);
      if (pattern === 'click') {
        const strong = inBar === 0 && opts.accent !== false;
        click(t, g * (strong ? 1 : 0.7), strong ? 1760 : 1320);
        continue;
      }
      if (part.kick) {
        if (pattern === 'house') kick(t, g);
        else if (pattern === 'breakbeat') {
          if (inBar === 0) kick(t, g);
          if (inBar === 2) kick(t + beatSec / 2, g);
        } else if (pattern === 'halftime') {
          if (inBar === 0) kick(t, g);
        } else if (inBar === 0 || inBar === 2) kick(t, g);
      }
      if (part.clap) {
        if (pattern === 'house') {
          if (inBar === 1 || inBar === 3) snare(t, g * 0.55, true);
        } else if (pattern === 'halftime') {
          if (inBar === 2) snare(t, g * 0.7, false);
        } else if (inBar === 1 || inBar === 3) snare(t, g * 0.7, false);
      }
      if (part.hat) {
        if (pattern === 'house') hat(t + beatSec / 2, g, 0.03);
        else {
          hat(t, g * 0.7);
          hat(t + beatSec / 2, g * 0.7);
        }
      }
      if (part.bass) {
        const root = ROOTS[absBar % ROOTS.length];
        if (offbeatBass) bassNote(t + beatSec / 2, beatSec * 0.42, root, g * 0.7);
        else if (inBar === 0) bassNote(t, beatSec * 1.8, root, g * 0.6);
      }
      if (part.roll) {
        // eighths, then sixteenths in the second half of the part, getting louder
        const progress = b / partBeats;
        const steps = progress < 0.5 ? 2 : 4;
        for (let s = 0; s < steps; s++) snare(t + (s * beatSec) / steps, g * (0.15 + 0.4 * progress), false);
      }
    }
    if (part.pad && pattern !== 'click') {
      // three detuned saws per chord through a gentle low-pass; ducked by the kick when there is one
      const start = Math.max(0, Math.ceil(partStart * sampleRate));
      const end = Math.min(n, Math.floor((partStart + partBeats * beatSec) * sampleRate));
      const k = 1 - Math.exp((-2 * Math.PI * 1400) / sampleRate);
      let lpL = 0;
      let lpR = 0;
      const fade = 0.03 * sampleRate;
      for (let i = start; i < end; i++) {
        const t = i / sampleRate - partStart;
        const beat = t / beatSec;
        const chord = CHORDS[(bar + Math.floor(beat / BEATS_PER_BAR)) % CHORDS.length];
        let l = 0;
        let r = 0;
        for (let v = 0; v < 3; v++) {
          l += 2 * ((t * chord[v] * 1.003) % 1) - 1;
          r += 2 * ((t * chord[v] * 0.997) % 1) - 1;
        }
        lpL += (l - lpL) * k;
        lpR += (r - lpR) * k;
        const duck = part.kick && pattern === 'house' ? 1 - 0.7 * Math.exp(-(beat % 1) * beatSec * 9) : 1;
        const edge = Math.min(1, (i - start) / fade, (end - i) / fade);
        const amp = 0.09 * g * duck * edge;
        left[i] += lpL * amp;
        right[i] += lpR * amp;
      }
    }
    bar += part.bars;
  }

  const floor = opts.noise ?? 0.004;
  const channels = [new Int16Array(n), new Int16Array(n)];
  for (let i = 0; i < n; i++) {
    const nl = floor ? noise() * floor : 0;
    const nr = floor ? noise() * floor : 0;
    const l = Math.max(-1, Math.min(1, (left[i] + nl) * 0.8));
    const r = Math.max(-1, Math.min(1, (right[i] + nr) * 0.8));
    channels[0][i] = Math.round(l * 32767);
    channels[1][i] = Math.round(r * 32767);
  }
  return {
    pcm: { sampleRate, length: n, channels },
    grid: { bpm, firstBeatSec },
    parts,
    bars,
  };
}

/** Uniform white noise: music with no beat at all. */
export function synthNoise(durationSec: number, sampleRate = 44100, amplitude = 0.2, seed = 7): PcmData {
  const n = Math.ceil(durationSec * sampleRate);
  const rand = rng(seed);
  const channels = [new Int16Array(n), new Int16Array(n)];
  for (let i = 0; i < n; i++) {
    channels[0][i] = Math.round((rand() * 2 - 1) * amplitude * 32767);
    channels[1][i] = Math.round((rand() * 2 - 1) * amplitude * 32767);
  }
  return { sampleRate, length: n, channels };
}

/** 16-bit PCM WAV file of a track. */
export function encodeWav(pcm: PcmData): ArrayBuffer {
  const channels = pcm.channels.length;
  const bytes = pcm.length * channels * 2;
  const buf = new ArrayBuffer(44 + bytes);
  const view = new DataView(buf);
  const text = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + bytes, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, pcm.sampleRate, true);
  view.setUint32(28, pcm.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, bytes, true);
  const out = new Int16Array(buf, 44, pcm.length * channels);
  for (let c = 0; c < channels; c++) {
    const src = pcm.channels[c];
    for (let i = 0, j = c; i < pcm.length; i++, j += channels) out[j] = src[i];
  }
  return buf;
}
