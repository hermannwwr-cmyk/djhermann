/**
 * Small DSP kit for the built-in music: band-limited wavetables, a state-variable filter,
 * seeded noise and buffer helpers. Pure TypeScript on typed arrays, so a render is the same
 * arithmetic on every device and runs in a worker, on the main thread or in Node.
 */
import { rng } from '../core/math';

export const TAU = Math.PI * 2;
export const midiToHz = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);
export const dbToGain = (db: number): number => Math.pow(10, db / 20);
export const gainToDb = (g: number): number => 20 * Math.log10(Math.max(g, 1e-12));

/** Mono or stereo sample. `loop` marks a seamless loop (supersaw chords). */
export interface Sample {
  l: Float32Array;
  r: Float32Array | null;
  loop?: boolean;
}

// ───────────────────────────── wavetables ─────────────────────────────

export const TABLE_SIZE = 4096;
const TABLE_MASK = TABLE_SIZE - 1;
export type WaveShape = 'saw' | 'square';

interface WaveSet {
  /** harmonic count of each table, ascending */
  levels: number[];
  /** TABLE_SIZE + 1 samples each (guard point for interpolation) */
  tables: Float32Array[];
}

const waveSets = new Map<WaveShape, WaveSet>();
let sineTable: Float32Array | null = null;

/** One cycle of a sine, TABLE_SIZE + 1 samples. */
export function sine(): Float32Array {
  if (!sineTable) {
    sineTable = new Float32Array(TABLE_SIZE + 1);
    for (let i = 0; i <= TABLE_SIZE; i++) sineTable[i] = Math.sin((i / TABLE_SIZE) * TAU);
  }
  return sineTable;
}

function buildWaveSet(shape: WaveShape): WaveSet {
  const sin = sine();
  const levels: number[] = [];
  for (let h = 1; h < 512; h = Math.max(h + 1, Math.round(h * 1.26))) levels.push(h);
  levels.push(512);
  const tables: Float32Array[] = [];
  const acc = new Float64Array(TABLE_SIZE);
  let done = 0;
  for (const top of levels) {
    for (let h = done + 1; h <= top; h++) {
      if (shape === 'square' && h % 2 === 0) continue;
      const amp = (shape === 'saw' ? 2 / Math.PI : 4 / Math.PI) / h;
      let idx = 0;
      for (let i = 0; i < TABLE_SIZE; i++) {
        acc[i] += amp * sin[idx];
        idx = (idx + h) & TABLE_MASK;
      }
    }
    done = top;
    const t = new Float32Array(TABLE_SIZE + 1);
    t.set(acc);
    t[TABLE_SIZE] = t[0];
    tables.push(t);
  }
  return { levels, tables };
}

/** Band-limited single-cycle table whose harmonics all stay under 0.45 × sampleRate at `freq`. */
export function waveTable(shape: WaveShape, freq: number, sampleRate: number): Float32Array {
  let set = waveSets.get(shape);
  if (!set) waveSets.set(shape, (set = buildWaveSet(shape)));
  const maxH = (0.45 * sampleRate) / Math.max(freq, 1);
  let pick = 0;
  for (let i = 0; i < set.levels.length; i++) {
    if (set.levels[i] <= maxH) pick = i;
    else break;
  }
  return set.tables[pick];
}

// ───────────────────────────── filters ─────────────────────────────

/** Zero-delay-feedback state-variable filter (stable under fast modulation). */
export class Svf {
  private ic1 = 0;
  private ic2 = 0;
  private a1 = 0;
  private a2 = 0;
  private a3 = 0;
  private k = 1;
  private v1 = 0;
  private v2 = 0;

  set(freq: number, q: number, sampleRate: number): void {
    const f = freq < 10 ? 10 : freq > sampleRate * 0.45 ? sampleRate * 0.45 : freq;
    const g = Math.tan((Math.PI * f) / sampleRate);
    this.k = 1 / q;
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }

  private tick(x: number): void {
    const v3 = x - this.ic2;
    this.v1 = this.a1 * this.ic1 + this.a2 * v3;
    this.v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * this.v1 - this.ic1;
    this.ic2 = 2 * this.v2 - this.ic2;
  }

  lp(x: number): number {
    this.tick(x);
    return this.v2;
  }

  hp(x: number): number {
    this.tick(x);
    return x - this.k * this.v1 - this.v2;
  }

  /** band-pass with unity gain at the centre frequency */
  bp(x: number): number {
    this.tick(x);
    return this.k * this.v1;
  }

  reset(): void {
    this.ic1 = this.ic2 = 0;
  }
}

export type FilterKind = 'lp' | 'hp' | 'bp';

/** Filter a buffer in place with a fixed 12 dB/oct filter. */
export function filter(buf: Float32Array, kind: FilterKind, freq: number, q: number, sampleRate: number): Float32Array {
  const f = new Svf();
  f.set(freq, q, sampleRate);
  const n = buf.length;
  if (kind === 'lp') for (let i = 0; i < n; i++) buf[i] = f.lp(buf[i]);
  else if (kind === 'hp') for (let i = 0; i < n; i++) buf[i] = f.hp(buf[i]);
  else for (let i = 0; i < n; i++) buf[i] = f.bp(buf[i]);
  return buf;
}

// ───────────────────────────── buffers ─────────────────────────────

/** White noise in -1..1 from a seed. */
export function noise(length: number, seed: number): Float32Array {
  const rand = rng(seed);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = rand() * 2 - 1;
  return out;
}

export function peakOf(...bufs: (Float32Array | null)[]): number {
  let m = 0;
  for (const b of bufs) {
    if (!b) continue;
    for (let i = 0; i < b.length; i++) {
      const a = b[i] < 0 ? -b[i] : b[i];
      if (a > m) m = a;
    }
  }
  return m;
}

export function rmsOf(buf: Float32Array, from = 0, to = buf.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

export function scale(s: Sample, g: number): Sample {
  for (let i = 0; i < s.l.length; i++) s.l[i] *= g;
  if (s.r) for (let i = 0; i < s.r.length; i++) s.r[i] *= g;
  return s;
}

/** Scale so the largest sample is `peak`. */
export function normPeak(s: Sample, peak = 1): Sample {
  const p = peakOf(s.l, s.r);
  return p > 0 ? scale(s, peak / p) : s;
}

/** Scale so the loudest 50 ms window has RMS `level` (evens out notes of one instrument). */
export function normRms(s: Sample, level: number, sampleRate: number): Sample {
  const win = Math.max(1, Math.min(s.l.length, Math.round(0.05 * sampleRate)));
  let best = 0;
  for (let from = 0; from + win <= s.l.length; from += win >> 1) {
    let r = rmsOf(s.l, from, from + win);
    if (s.r) r = Math.sqrt((r * r + rmsOf(s.r, from, from + win) ** 2) / 2);
    if (r > best) best = r;
  }
  return best > 0 ? scale(s, level / best) : s;
}

/** Raised-cosine fades at both ends, in frames. */
export function fade(s: Sample, inFrames: number, outFrames: number): Sample {
  const n = s.l.length;
  const a = Math.min(inFrames, n);
  const b = Math.min(outFrames, n);
  for (const ch of [s.l, s.r]) {
    if (!ch) continue;
    for (let i = 0; i < a; i++) ch[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / a);
    for (let i = 0; i < b; i++) ch[n - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / b);
  }
  return s;
}

/** x / (1 + |x|)-style soft saturation scaled to keep unity gain for small signals. */
export const softSat = (x: number, drive: number): number => Math.tanh(x * drive) / Math.tanh(drive);

export const mono = (l: Float32Array): Sample => ({ l, r: null });
export const stereo = (l: Float32Array, r: Float32Array): Sample => ({ l, r });
