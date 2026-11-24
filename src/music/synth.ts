/**
 * Every instrument of the built-in soundtrack, as functions that synthesise one note (or one
 * drum hit, loop or effect) into a Sample. The renderer calls each distinct note once and then
 * plays the result like a sampler, so the cost follows the number of different notes, not the
 * length of the track.
 */
import { rng } from '../core/math';
import { Svf, TABLE_SIZE, TAU, fade, filter, midiToHz, mono, noise, normPeak, normRms, rmsOf, scale, sine, softSat, stereo, waveTable } from './dsp';
import type { Sample, WaveShape } from './dsp';

const frames = (sec: number, sr: number): number => Math.max(1, Math.round(sec * sr));

// ───────────────────────────── drums ─────────────────────────────

export interface KickParams {
  /** resting pitch of the body in Hz (45..55) */
  fEnd: number;
  /** punch: pitch the body falls from */
  fMid: number;
  /** pitch of the first milliseconds (the knock) */
  fTop: number;
  /** body decay time constant in seconds */
  decay: number;
  /** level of the noise click, 0..1 */
  click: number;
  drive: number;
}

/** Sine-sweep kick. The waveform starts at sample 0, so the onset is exactly where it is placed. */
export function kick(sr: number, p: KickParams): Sample {
  const n = frames(0.44, sr);
  const out = new Float32Array(n);
  const t1 = 0.045;
  const t2 = 0.006;
  const hold = 0.05;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const ph = TAU * (p.fEnd * t + (p.fMid - p.fEnd) * t1 * (1 - Math.exp(-t / t1)) + (p.fTop - p.fMid) * t2 * (1 - Math.exp(-t / t2)));
    const a = t < hold ? 1 : Math.exp(-(t - hold) / p.decay);
    out[i] = softSat(Math.sin(ph) * a, p.drive);
  }
  const cn = frames(0.02, sr);
  const click = filter(noise(cn, 9001), 'hp', 2500, 0.7, sr);
  for (let i = 0; i < cn; i++) out[i] += click[i] * p.click * Math.exp(-i / (0.003 * sr));
  return normPeak(fade(mono(out), 0, frames(0.03, sr)));
}

export interface ClapParams {
  /** centre of the main band in Hz */
  tone: number;
  /** decay of the tail in seconds */
  tail: number;
  /** level of the bright layer */
  bright: number;
  /** low-mid body (a snare-like thump under the clap), 0..1 */
  body: number;
  seed: number;
}

/** Layered clap: three fast noise bursts, then a tail; stereo. */
export function clap(sr: number, p: ClapParams, lenSec = 0.32): Sample {
  const n = frames(lenSec, sr);
  const common = noise(n, p.seed);
  const chans: Float32Array[] = [];
  for (let c = 0; c < 2; c++) {
    const own = noise(n, p.seed + 17 + c * 31);
    const a = new Float32Array(n);
    const b = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      a[i] = common[i] * 0.75 + own[i] * 0.5;
      b[i] = a[i];
    }
    filter(a, 'bp', p.tone, 1.3, sr);
    filter(a, 'hp', 500, 0.7, sr);
    filter(b, 'bp', p.tone * 2.6, 0.9, sr);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      let env = 0;
      for (let k = 0; k < 3; k++) {
        const tk = t - k * 0.011;
        if (tk >= 0) env += 0.85 * Math.exp(-tk / 0.004);
      }
      const tt = t - 0.031;
      if (tt >= 0) env += Math.exp(-tt / p.tail);
      out[i] = (a[i] + b[i] * p.bright) * env;
      if (p.body > 0) out[i] += p.body * 0.6 * Math.sin(TAU * (190 * t + 60 * 0.015 * (1 - Math.exp(-t / 0.015)))) * Math.exp(-t / 0.045);
    }
    chans.push(out);
  }
  return normPeak(fade(stereo(chans[0], chans[1]), 0, frames(0.02, sr)));
}

/** Snare for rolls and fills: tuned body plus bright noise. `tune` multiplies the body pitch. */
export function snare(sr: number, tune: number, seed: number): Sample {
  const n = frames(0.22, sr);
  const nz = filter(filter(noise(n, seed), 'hp', 1800, 0.7, sr), 'bp', 4200, 0.6, sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const body = Math.sin(TAU * tune * (182 * t + 70 * 0.012 * (1 - Math.exp(-t / 0.012)))) * Math.exp(-t / 0.05);
    out[i] = body * 0.7 + nz[i] * 1.6 * Math.exp(-t / 0.07);
  }
  return normPeak(fade(mono(out), 0, frames(0.02, sr)));
}

export interface HatParams {
  /** decay time constant in seconds: ~0.015 closed, ~0.1 open */
  decay: number;
  len: number;
  /** high-pass corner in Hz */
  hp: number;
  /** attack in seconds (shakers swell in) */
  attack: number;
  seed: number;
}

export function hat(sr: number, p: HatParams): Sample {
  const n = frames(p.len, sr);
  const src = noise(n, p.seed);
  const ring = filter(src.slice(), 'bp', Math.min(9800, sr * 0.4), 2.2, sr);
  filter(filter(src, 'hp', p.hp, 0.8, sr), 'hp', p.hp * 0.8, 0.6, sr);
  const out = new Float32Array(n);
  const att = Math.max(1, p.attack * sr);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const a = (i < att ? i / att : 1) * Math.exp(-t / p.decay);
    out[i] = (src[i] + ring[i] * 0.7) * a;
  }
  return normPeak(fade(mono(out), 0, frames(Math.min(0.02, p.len / 3), sr)));
}

/** Finger snap / rim: a tight, bright tick with a little pitch. */
export function snap(sr: number, seed: number): Sample {
  const n = frames(0.12, sr);
  const nz = filter(noise(n, seed), 'bp', 2400, 3, sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const e = Math.exp(-t / 0.004) + (t >= 0.007 ? Math.exp(-(t - 0.007) / 0.016) : 0);
    out[i] = nz[i] * e * 2 + Math.sin(TAU * 1650 * t) * Math.exp(-t / 0.005) * 0.5;
  }
  return normPeak(fade(mono(out), 0, frames(0.02, sr)));
}

/** Tom / conga: a sine with a small pitch drop and a soft slap. */
export function tom(sr: number, freq: number, decay: number, seed: number): Sample {
  const n = frames(Math.min(0.5, decay * 5), sr);
  const nz = filter(noise(n, seed), 'bp', 1300, 1.2, sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    out[i] = Math.sin(TAU * (freq * t + freq * 0.5 * 0.018 * (1 - Math.exp(-t / 0.018)))) * Math.exp(-t / decay) + nz[i] * 0.5 * Math.exp(-t / 0.008);
  }
  return normPeak(fade(mono(out), 0, frames(0.02, sr)));
}

/** Crash cymbal: long bright noise, stereo. */
export function crash(sr: number, seed: number, lenSec = 2.4): Sample {
  const n = frames(lenSec, sr);
  const chans: Float32Array[] = [];
  for (let c = 0; c < 2; c++) {
    const src = noise(n, seed + c * 101);
    const ring = filter(src.slice(), 'bp', 6200, 1.6, sr);
    filter(src, 'hp', 3600, 0.7, sr);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      src[i] = (src[i] + ring[i] * 0.6) * (0.35 * Math.exp(-t / 0.08) + 0.65 * Math.exp(-t / 0.62)) * Math.min(1, i / (0.002 * sr));
    }
    chans.push(src);
  }
  return normPeak(fade(stereo(chans[0], chans[1]), 0, frames(0.15, sr)));
}

// ───────────────────────────── bass ─────────────────────────────

export interface BassParams {
  /** level of the sine sub */
  sub: number;
  /** level of the filtered harmonic layer */
  mid: number;
  shape: WaveShape;
  /** octaves the harmonic layer sits above the sub (0 or 1) */
  midOct: number;
  /** resting cutoff of the harmonic layer in Hz */
  cutoff: number;
  /** cutoff envelope amount, as a multiple of `cutoff` */
  env: number;
  envDecay: number;
  q: number;
  drive: number;
  release: number;
}

/** Sub sine plus a low-passed saw/square an octave up, mono. Phase starts at 0 on every note. */
export function bassNote(sr: number, midi: number, durSec: number, p: BassParams): Sample {
  const f = midiToHz(midi);
  const n = frames(durSec + p.release, sr);
  const out = new Float32Array(n);
  const fm = f * Math.pow(2, p.midOct);
  const table = waveTable(p.shape, fm * 1.003, sr);
  const f1 = new Svf();
  const f2 = new Svf();
  const hold = Math.round(durSec * sr);
  const att = Math.max(1, Math.round(0.003 * sr));
  const rel = Math.max(1, n - hold);
  let ph1 = 0;
  let ph2 = 0.37;
  const inc1 = (fm * 0.9975) / sr;
  const inc2 = (fm * 1.0025) / sr;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    if ((i & 15) === 0) {
      const fc = p.cutoff * (1 + p.env * Math.exp(-t / p.envDecay));
      f1.set(fc, p.q, sr);
      f2.set(fc, 0.6, sr);
    }
    let x = ph1 * TABLE_SIZE;
    let i0 = x | 0;
    let s = table[i0] + (x - i0) * (table[i0 + 1] - table[i0]);
    x = ph2 * TABLE_SIZE;
    i0 = x | 0;
    s += table[i0] + (x - i0) * (table[i0 + 1] - table[i0]);
    ph1 += inc1;
    if (ph1 >= 1) ph1 -= 1;
    ph2 += inc2;
    if (ph2 >= 1) ph2 -= 1;
    const midv = f2.lp(f1.lp(s * 0.5));
    const amp = (i < att ? i / att : 1) * (i < hold ? 1 : 0.5 + 0.5 * Math.cos((Math.PI * (i - hold)) / rel));
    out[i] = softSat((Math.sin(TAU * f * t) * p.sub + midv * p.mid) * amp, p.drive);
  }
  return normPeak(mono(out));
}

// ───────────────────────────── supersaw ─────────────────────────────

export interface SupersawParams {
  /** detune of the outermost voices as a fraction of the pitch (0.011 = ±19 cents) */
  detune: number;
  seed: number;
}

const SS_SPREAD = [-1, -0.571, -0.177, 0, 0.181, 0.565, 0.977];
const SS_PAN = [-0.85, 0.6, -0.35, 0, 0.35, -0.6, 0.85];
const SS_GAIN = [0.8, 0.9, 1, 1, 1, 0.9, 0.8];

/**
 * Seven detuned saws spread across the stereo field, rendered as a seamless ~2 s loop: every voice
 * completes a whole number of cycles in the loop, so it can be played from any offset for any length.
 */
export function supersawLoop(sr: number, midi: number, p: SupersawParams, loopSec = 2): Sample {
  const f = midiToHz(midi);
  const centre = Math.max(8, Math.round(f * loopSec));
  const n = Math.round((centre * sr) / f);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  const rand = rng(p.seed + midi * 131);
  const table = waveTable('saw', f * (1 + p.detune), sr);
  const used = new Set<number>();
  for (let v = 0; v < 7; v++) {
    let cycles = centre + Math.round(centre * p.detune * SS_SPREAD[v] + (v === 3 ? 0 : rand() - 0.5));
    while (used.has(cycles)) cycles += SS_SPREAD[v] < 0 ? -1 : 1;
    used.add(cycles);
    const inc = cycles / n;
    let ph = rand();
    const ang = ((SS_PAN[v] + 1) * Math.PI) / 4;
    const gl = Math.cos(ang) * SS_GAIN[v];
    const gr = Math.sin(ang) * SS_GAIN[v];
    for (let i = 0; i < n; i++) {
      const x = ph * TABLE_SIZE;
      const i0 = x | 0;
      const s = table[i0] + (x - i0) * (table[i0 + 1] - table[i0]);
      l[i] += s * gl;
      r[i] += s * gr;
      ph += inc;
      if (ph >= 1) ph -= 1;
    }
  }
  const level = Math.sqrt((rmsOf(l) ** 2 + rmsOf(r) ** 2) / 2);
  const s = scale(stereo(l, r), 0.25 / level);
  s.loop = true;
  return s;
}

// ───────────────────────────── plucks and keys ─────────────────────────────

export interface PluckParams {
  shape: WaveShape;
  /** resting cutoff in Hz */
  cutoff: number;
  /** extra cutoff at the attack in Hz */
  env: number;
  envDecay: number;
  q: number;
  /** amplitude decay time constant in seconds */
  decay: number;
  /** detune between the two oscillators in cents */
  detune: number;
  len: number;
}

/** Classic synth pluck: two oscillators through a 24 dB low-pass whose cutoff snaps shut. */
export function pluck(sr: number, midi: number, p: PluckParams): Sample {
  const f = midiToHz(midi);
  const n = frames(p.len, sr);
  const out = new Float32Array(n);
  const table = waveTable(p.shape, f * 1.01, sr);
  const f1 = new Svf();
  const f2 = new Svf();
  const d = Math.pow(2, p.detune / 2400);
  const inc1 = (f * d) / sr;
  const inc2 = f / d / sr;
  let ph1 = 0.1;
  let ph2 = 0.6;
  const att = Math.max(1, 0.0015 * sr);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    if ((i & 15) === 0) {
      const fc = p.cutoff + f * 0.5 + p.env * Math.exp(-t / p.envDecay);
      f1.set(fc, p.q, sr);
      f2.set(fc, 0.6, sr);
    }
    let x = ph1 * TABLE_SIZE;
    let i0 = x | 0;
    let s = table[i0] + (x - i0) * (table[i0 + 1] - table[i0]);
    x = ph2 * TABLE_SIZE;
    i0 = x | 0;
    s += table[i0] + (x - i0) * (table[i0 + 1] - table[i0]);
    ph1 += inc1;
    if (ph1 >= 1) ph1 -= 1;
    ph2 += inc2;
    if (ph2 >= 1) ph2 -= 1;
    out[i] = f2.lp(f1.lp(s * 0.5)) * (i < att ? i / att : 1) * Math.exp(-t / p.decay);
  }
  return normPeak(fade(mono(out), 0, frames(0.03, sr)), 0.9);
}

interface Partial {
  /** frequency in Hz */
  f: number;
  /** amplitude */
  a: number;
  /** decay time constant in seconds */
  tau: number;
}

/** Sum of exponentially decaying sine partials (each one a two-multiply resonator). */
function modal(sr: number, partials: Partial[], lenSec: number): Float32Array {
  const n = frames(lenSec, sr);
  const out = new Float32Array(n);
  for (const p of partials) {
    if (p.f >= sr * 0.45 || p.a === 0) continue;
    const w = (TAU * p.f) / sr;
    const r = Math.exp(-1 / (p.tau * sr));
    const c = 2 * r * Math.cos(w);
    const r2 = r * r;
    const m = Math.min(n, Math.ceil(p.tau * sr * 9.5));
    let y1 = 0;
    let y2 = -Math.sin(w) / r; // so that y[0] = 0 and y[1] = r·sin(w)
    for (let i = 0; i < m; i++) {
      const y = c * y1 - r2 * y2;
      y2 = y1;
      y1 = y;
      out[i] += p.a * y;
    }
  }
  return out;
}

export interface StringParams {
  /** pluck position along the string, 0..0.5 (small = brighter, more nasal) */
  pos: number;
  /** spectral slope: partial k has amplitude 1 / k^bright */
  bright: number;
  /** decay of the fundamental in seconds */
  t1: number;
  /** how much faster high partials die */
  damp: number;
  len: number;
  /** level of the pick noise */
  pick: number;
}

/** Plucked string (clean guitar / nylon): harmonic partials shaped by the pluck position. */
export function stringPluck(sr: number, midi: number, p: StringParams): Sample {
  const f = midiToHz(midi);
  const partials: Partial[] = [];
  for (let k = 1; k <= 60; k++) {
    const fk = k * f * Math.sqrt(1 + 0.00012 * k * k);
    if (fk > 13000) break;
    partials.push({
      f: fk,
      a: Math.sin(Math.PI * k * p.pos) / Math.pow(k, p.bright),
      tau: (p.t1 * Math.pow(220 / f, 0.3)) / (1 + p.damp * (k - 1) + p.damp * 0.12 * (k - 1) * (k - 1)),
    });
  }
  const out = modal(sr, partials, p.len);
  const pn = frames(0.012, sr);
  const pick = filter(noise(pn, 4242 + midi), 'bp', 2600, 1.2, sr);
  const lvl = rmsOf(out, 0, Math.min(out.length, frames(0.05, sr)));
  for (let i = 0; i < pn; i++) out[i] += pick[i] * p.pick * lvl * 3 * Math.exp(-i / (0.003 * sr));
  return normPeak(fade(mono(out), 0, frames(0.04, sr)), 0.9);
}

export interface KeysParams {
  bright: number;
  t1: number;
  len: number;
}

/** Soft house piano: slightly inharmonic partials on two detuned strings, with a hammer thump. */
export function keys(sr: number, midi: number, p: KeysParams): Sample {
  const f = midiToHz(midi);
  const partials: Partial[] = [];
  for (let k = 1; k <= 28; k++) {
    const fk = k * f * Math.sqrt(1 + 0.00035 * k * k);
    if (fk > 11000) break;
    const a = (0.55 + 0.45 * Math.abs(Math.sin((Math.PI * k) / 7.5))) / Math.pow(k, p.bright);
    const tau = (p.t1 * Math.pow(220 / f, 0.4)) / (1 + 0.4 * (k - 1));
    partials.push({ f: fk * 1.00028, a: a * 0.5, tau }, { f: fk * 0.99972, a: a * 0.5, tau: tau * 0.9 });
  }
  const out = modal(sr, partials, p.len);
  const hn = frames(0.01, sr);
  const hammer = filter(noise(hn, 777 + midi), 'lp', 1800, 0.7, sr);
  const lvl = rmsOf(out, 0, Math.min(out.length, frames(0.05, sr)));
  for (let i = 0; i < hn; i++) out[i] += hammer[i] * lvl * 1.2 * Math.exp(-i / (0.0025 * sr));
  return normPeak(fade(mono(out), 0, frames(0.05, sr)), 0.9);
}

/** Marimba / kalimba: a fundamental with short bar overtones. */
export function mallet(sr: number, midi: number, decay = 0.32): Sample {
  const f = midiToHz(midi);
  const out = modal(
    sr,
    [
      { f, a: 1, tau: decay },
      { f: f * 3.93, a: 0.28, tau: decay * 0.22 },
      { f: f * 9.6, a: 0.09, tau: decay * 0.08 },
      { f: f * 2, a: 0.12, tau: decay * 0.5 },
    ],
    Math.min(1.2, decay * 5),
  );
  return normPeak(fade(mono(out), 0, frames(0.04, sr)), 0.9);
}

export interface BellParams {
  /** modulator : carrier frequency ratio (2 = glassy, 3.5 = bell) */
  ratio: number;
  /** FM index at the attack */
  index: number;
  indexDecay: number;
  decay: number;
  len: number;
}

/** Two-operator FM bell / tine, two slightly detuned copies left and right. */
export function bell(sr: number, midi: number, p: BellParams): Sample {
  const f = midiToHz(midi);
  const n = frames(p.len, sr);
  const chans: Float32Array[] = [];
  const att = Math.max(1, 0.001 * sr);
  for (let c = 0; c < 2; c++) {
    const fc = f * (c === 0 ? 0.9985 : 1.0015);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const idx = p.index * Math.exp(-t / p.indexDecay);
      out[i] = Math.sin(TAU * fc * t + idx * Math.sin(TAU * fc * p.ratio * t)) * Math.exp(-t / p.decay) * (i < att ? i / att : 1);
    }
    chans.push(out);
  }
  return normPeak(fade(stereo(chans[0], chans[1]), 0, frames(0.04, sr)), 0.9);
}

// ───────────────────────────── vocal chop ─────────────────────────────

export type Vowel = 'ah' | 'oh' | 'oo' | 'ee' | 'eh' | 'uh';
export type Onset = 'none' | 'd' | 'b' | 'y' | 'w' | 'n' | 'h';

/** F1, F2, F3 in Hz and their gains (a bright female voice, the register vocal chops live in). */
const VOWELS: Record<Vowel, readonly number[]> = {
  ah: [850, 1220, 2810, 1, 0.75, 0.3],
  oh: [560, 920, 2710, 1, 0.55, 0.2],
  oo: [380, 950, 2670, 1, 0.3, 0.12],
  ee: [320, 2700, 3300, 1, 0.5, 0.4],
  eh: [610, 2300, 2990, 1, 0.55, 0.32],
  uh: [640, 1200, 2600, 1, 0.5, 0.22],
};

/** Where F1 / F2 start for each consonant-like onset, and how long the glide to the vowel takes. */
const ONSETS: Record<Onset, readonly number[]> = {
  none: [0, 0, 0],
  h: [0, 0, 0],
  d: [260, 1800, 0.04],
  b: [260, 800, 0.035],
  y: [290, 2600, 0.085],
  w: [310, 650, 0.085],
  n: [260, 1450, 0.05],
};

export interface VoxParams {
  vowel: Vowel;
  /** vowel to glide to during the note (a diphthong: "ah" → "ee" reads as "ay") */
  to?: Vowel;
  onset: Onset;
  /** semitones the pitch starts flat by before it snaps up */
  scoop: number;
  /** note at which the formants are unshifted */
  refMidi: number;
  /** 0..1 how far the formants follow the pitch (1 = a re-pitched sample) */
  track: number;
  /** level of the breath noise */
  breath: number;
  /** vibrato depth as a fraction of the pitch */
  vib: number;
  /** source brightness, ~0.6 (soft) .. 1.6 (cutting) */
  bright: number;
  /** amplitude decay in seconds for plucky chops; 0 = sustained */
  decay: number;
}

/**
 * Vocal-chop voice: a doubled saw "glottis" with a pitch scoop and vibrato, sung through three
 * moving formants. Consonant-like onsets come from formant glides, so notes read as syllables.
 */
export function vox(sr: number, midi: number, durSec: number, p: VoxParams): Sample {
  const f0 = midiToHz(midi);
  const n = frames(durSec + 0.05, sr);
  const hold = Math.round(durSec * sr);
  const table = waveTable('saw', f0 * 1.02, sr);
  const va = VOWELS[p.vowel];
  const vb = VOWELS[p.to ?? p.vowel];
  const on = ONSETS[p.onset];
  const shift = Math.pow(2, ((midi - p.refMidi) / 12) * p.track);
  const murmur = p.onset === 'n' ? 0.045 : 0;
  const breathy = p.onset === 'h' ? 0.04 : 0;
  const att = (p.onset === 'd' || p.onset === 'b' ? 0.004 : p.onset === 'none' ? 0.008 : 0.014) * sr;
  const nz = noise(n, 5150 + midi);
  const chans: Float32Array[] = [];
  for (let c = 0; c < 2; c++) {
    const out = new Float32Array(n);
    const bank = [new Svf(), new Svf(), new Svf()];
    const body = new Svf();
    const det = c === 0 ? 0.996 : 1.004;
    let ph = c * 0.41;
    let tilt = 0;
    const tiltK = 1 - Math.exp((-TAU * 3200 * p.bright) / sr);
    let g1 = 1;
    let g2 = 0.5;
    let g3 = 0.3;
    let inc = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      if ((i & 15) === 0) {
        const tv = t - murmur;
        const m = p.to ? Math.min(1, Math.max(0, (t / durSec - 0.3) / 0.45)) : 0;
        const glide = on[2] > 0 && tv >= 0 ? Math.exp(-tv / (on[2] / 3)) : on[2] > 0 ? 1 : 0;
        const F1 = (va[0] + (vb[0] - va[0]) * m) * shift;
        const F2 = (va[1] + (vb[1] - va[1]) * m) * shift;
        const F3 = (va[2] + (vb[2] - va[2]) * m) * shift;
        bank[0].set(F1 + (on[0] - F1) * glide, 5, sr);
        bank[1].set(F2 + (on[1] - F2) * glide, 7, sr);
        bank[2].set(F3, 8, sr);
        g1 = va[3] + (vb[3] - va[3]) * m;
        g2 = va[4] + (vb[4] - va[4]) * m;
        g3 = va[5] + (vb[5] - va[5]) * m;
        const vib = 1 + p.vib * Math.sin(TAU * 5.6 * t) * Math.min(1, Math.max(0, (t - 0.12) / 0.15));
        const f = f0 * det * Math.pow(2, (-p.scoop / 12) * Math.exp(-t / 0.028)) * vib;
        inc = f / sr;
        body.set(f * 1.3, 0.8, sr);
      }
      const x = ph * TABLE_SIZE;
      const i0 = x | 0;
      let s = table[i0] + (x - i0) * (table[i0 + 1] - table[i0]);
      ph += inc;
      if (ph >= 1) ph -= 1;
      let voiced = 1;
      if (murmur > 0 && t < murmur) voiced = 0.3;
      if (breathy > 0) voiced = Math.min(1, t / breathy);
      s = s * voiced + nz[i] * (p.breath + (breathy > 0 ? 0.5 * (1 - voiced) : 0));
      tilt += tiltK * (s - tilt);
      const y = bank[0].bp(tilt) * g1 + bank[1].bp(tilt) * g2 + bank[2].bp(tilt) * g3 + body.lp(tilt) * 0.22 * voiced;
      let amp = i < att ? i / att : 1;
      if (p.decay > 0) amp *= Math.exp(-t / p.decay);
      if (i >= hold) amp *= 0.5 + 0.5 * Math.cos((Math.PI * (i - hold)) / (n - hold));
      out[i] = y * amp;
    }
    chans.push(out);
  }
  const l = chans[0];
  const r = chans[1];
  for (let i = 0; i < n; i++) {
    const a = l[i];
    const b = r[i];
    l[i] = a * 0.78 + b * 0.22;
    r[i] = b * 0.78 + a * 0.22;
  }
  return normRms(stereo(l, r), 0.22, sr);
}

// ───────────────────────────── synth lead ─────────────────────────────

export interface LeadParams {
  shape: WaveShape;
  /** 1, 3 or 5 voices */
  voices: number;
  /** total detune spread in cents */
  detune: number;
  cutoff: number;
  env: number;
  envDecay: number;
  q: number;
  /** portamento time from the previous note in seconds (0 = none) */
  glide: number;
  /** amplitude decay in seconds, 0 = sustained */
  decay: number;
}

/** Detuned saw/square lead with portamento from the previous note. Stereo. */
export function lead(sr: number, midi: number, durSec: number, prevMidi: number | null, p: LeadParams): Sample {
  const f0 = midiToHz(midi);
  const n = frames(durSec + 0.07, sr);
  const hold = Math.round(durSec * sr);
  const table = waveTable(p.shape, Math.max(f0, prevMidi === null ? 0 : midiToHz(prevMidi)) * 1.01, sr);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  const from = prevMidi === null || p.glide <= 0 ? 0 : prevMidi - midi;
  const rand = rng(900 + midi * 7 + (prevMidi ?? 0));
  for (let v = 0; v < p.voices; v++) {
    const spread = p.voices === 1 ? 0 : (v / (p.voices - 1)) * 2 - 1;
    const det = Math.pow(2, (spread * p.detune) / 2400);
    const ang = ((spread * 0.7 + 1) * Math.PI) / 4;
    const gl = Math.cos(ang);
    const gr = Math.sin(ang);
    let ph = rand();
    let inc = 0;
    for (let i = 0; i < n; i++) {
      if ((i & 15) === 0) inc = (f0 * det * Math.pow(2, (from / 12) * Math.exp(-i / sr / Math.max(1e-4, p.glide / 3)))) / sr;
      const x = ph * TABLE_SIZE;
      const i0 = x | 0;
      const s = table[i0] + (x - i0) * (table[i0 + 1] - table[i0]);
      ph += inc;
      if (ph >= 1) ph -= 1;
      l[i] += s * gl;
      r[i] += s * gr;
    }
  }
  const att = Math.max(1, 0.004 * sr);
  for (const ch of [l, r]) {
    const f1 = new Svf();
    const f2 = new Svf();
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      if ((i & 15) === 0) {
        const fc = p.cutoff + p.env * Math.exp(-t / p.envDecay);
        f1.set(fc, p.q, sr);
        f2.set(fc, 0.6, sr);
      }
      let amp = i < att ? i / att : 1;
      if (p.decay > 0) amp *= Math.exp(-t / p.decay);
      if (i >= hold) amp *= 0.5 + 0.5 * Math.cos((Math.PI * (i - hold)) / (n - hold));
      ch[i] = f2.lp(f1.lp(ch[i])) * amp;
    }
  }
  return normRms(stereo(l, r), 0.22, sr);
}

// ───────────────────────────── transitions ─────────────────────────────

/** White-noise riser: a band that sweeps up and swells for `durSec`, cut dead at the end. */
export function riserNoise(sr: number, durSec: number, seed: number): Sample {
  const n = frames(durSec, sr);
  const chans: Float32Array[] = [];
  for (let c = 0; c < 2; c++) {
    const src = noise(n, seed + c * 53);
    const f = new Svf();
    for (let i = 0; i < n; i++) {
      const u = i / n;
      if ((i & 31) === 0) f.set(350 * Math.pow(26, u), 1.4, sr);
      src[i] = (f.bp(src[i]) + src[i] * 0.12 * u) * Math.pow(u, 2.2);
    }
    chans.push(src);
  }
  return normPeak(fade(stereo(chans[0], chans[1]), 0, frames(0.008, sr)), 0.9);
}

/** Pitched riser: detuned saws climbing `semis` semitones to `midi`. */
export function riserTone(sr: number, durSec: number, midi: number, semis: number): Sample {
  const n = frames(durSec, sr);
  const fEnd = midiToHz(midi);
  const table = waveTable('saw', fEnd * 1.02, sr);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let v = 0; v < 3; v++) {
    const det = [0.994, 1, 1.006][v];
    const gl = [0.9, 0.6, 0.2][v];
    let ph = v * 0.31;
    let inc = 0;
    for (let i = 0; i < n; i++) {
      if ((i & 31) === 0) inc = (fEnd * det * Math.pow(2, (-semis * (1 - Math.pow(i / n, 1.4))) / 12)) / sr;
      const x = ph * TABLE_SIZE;
      const i0 = x | 0;
      const s = table[i0] + (x - i0) * (table[i0 + 1] - table[i0]);
      ph += inc;
      if (ph >= 1) ph -= 1;
      l[i] += s * gl;
      r[i] += s * (1.1 - gl);
    }
  }
  for (const ch of [l, r]) {
    const f = new Svf();
    for (let i = 0; i < n; i++) {
      const u = i / n;
      if ((i & 31) === 0) f.set(500 + 7000 * u * u, 1, sr);
      ch[i] = f.lp(ch[i]) * Math.pow(u, 1.6);
    }
  }
  return normPeak(fade(stereo(l, r), 0, frames(0.008, sr)), 0.9);
}

/** Noise falling away after a drop lands. */
export function downlifter(sr: number, durSec: number, seed: number): Sample {
  const n = frames(durSec, sr);
  const chans: Float32Array[] = [];
  for (let c = 0; c < 2; c++) {
    const src = noise(n, seed + c * 71);
    const f1 = new Svf();
    for (let i = 0; i < n; i++) {
      const u = i / n;
      if ((i & 31) === 0) f1.set(9000 * Math.pow(0.03, u), 1.2, sr);
      src[i] = f1.lp(src[i]) * Math.exp(-u * 3.2) * Math.min(1, i / (0.004 * sr));
    }
    chans.push(filter(src, 'hp', 220, 0.7, sr));
  }
  return normPeak(fade(stereo(chans[0], chans[1]), 0, frames(0.2, sr)), 0.9);
}

/** Low boom with a noisy crack, for the first beat of a drop. */
export function impact(sr: number, seed: number): Sample {
  const n = frames(1.7, sr);
  const nz = filter(noise(n, seed), 'lp', 1700, 0.7, sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const ph = TAU * (38 * t + 60 * 0.11 * (1 - Math.exp(-t / 0.11)));
    out[i] = softSat(Math.sin(ph) * Math.exp(-t / 0.45), 1.5) + nz[i] * 0.8 * Math.exp(-t / 0.11);
  }
  return normPeak(fade(mono(out), 0, frames(0.2, sr)), 0.9);
}

/** Reverse cymbal: bright noise that swells into the point where it stops. */
export function reverseCrash(sr: number, durSec: number, seed: number): Sample {
  const n = frames(durSec, sr);
  const chans: Float32Array[] = [];
  for (let c = 0; c < 2; c++) {
    const src = filter(noise(n, seed + c * 29), 'hp', 3000, 0.7, sr);
    for (let i = 0; i < n; i++) src[i] *= Math.exp(((i - n) / n) * 4.5);
    chans.push(src);
  }
  return normPeak(fade(stereo(chans[0], chans[1]), frames(0.02, sr), frames(0.006, sr)), 0.9);
}

/** One cycle table of a sine, re-exported for the one-shot sounds. */
export { sine };
