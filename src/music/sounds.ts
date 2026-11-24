/**
 * One-shot sounds: the four pads (played live over a full mix, so they are loud, bright and
 * saturated enough to cut through) and the UI sounds. Every sound starts at sample 0 with no
 * silence in front, ends in a short fade, and is deterministic.
 */
import type { PcmData, SoundName } from '../core/types';
import { rng } from '../core/math';
import { Svf, TABLE_SIZE, TAU, fade, filter, midiToHz, noise, normPeak, normRms, peakOf, softSat, stereo, waveTable } from './dsp';
import type { Sample } from './dsp';
import { bell, clap, snap } from './synth';

const frames = (sec: number, sr: number): number => Math.max(1, Math.round(sec * sr));

/** Peak level of each sound after normalising (linear). Pads at -1 dBFS, UI sounds quieter. */
export const SOUND_PEAK: Record<SoundName, number> = {
  boom: 0.89,
  clap: 0.89,
  zap: 0.85,
  horn: 0.85,
  tick: 0.7,
  tock: 0.6,
  success: 0.6,
  fail: 0.55,
  cheer: 0.5,
  whoosh: 0.5,
};

/**
 * 808-style sub drop with an impact on top. The sub alone would vanish on a phone speaker, so a
 * saturated octave-up body and a noisy crack carry it into the mids.
 */
function boom(sr: number): Sample {
  const n = frames(1.15, sr);
  const out = new Float32Array(n);
  const crack = filter(filter(noise(frames(0.15, sr), 8080), 'lp', 4500, 0.7, sr), 'hp', 300, 0.7, sr);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    // pitch falls from 170 Hz to 46 Hz: phase = integral of the frequency
    const ph = TAU * (46 * t + 124 * 0.06 * (1 - Math.exp(-t / 0.06)));
    const env = Math.exp(-t / 0.38) * Math.min(1, i / 8);
    const sub = Math.sin(ph) * env;
    // octave-up body, driven hard: the part a small speaker can play
    const body = softSat(Math.sin(2 * ph + 0.4) * 3, 3) * Math.exp(-t / 0.2) * 0.62;
    let x = softSat(sub * 1.8, 2.2) * 0.85 + body;
    if (i < crack.length) x += crack[i] * 1.5 * Math.exp(-t / 0.035);
    x += Math.sin(TAU * 1100 * t) * Math.exp(-t / 0.005) * 0.45;
    out[i] = x;
  }
  const s = stereo(out, out.slice());
  return fade(s, 0, frames(0.12, sr));
}

/** Layered clap: two claps a hair apart, a snap on top and a short room. */
function padClap(sr: number): Sample {
  const a = clap(sr, { tone: 1300, tail: 0.085, bright: 0.7, body: 0.45, seed: 1701 }, 0.34);
  const b = clap(sr, { tone: 1900, tail: 0.05, bright: 0.9, body: 0, seed: 1802 }, 0.34);
  const c = snap(sr, 1903);
  const n = a.l.length;
  const off = frames(0.004, sr);
  for (let i = 0; i < n; i++) {
    const j = i - off;
    a.l[i] += (j >= 0 ? b.l[j] : 0) * 0.6 + (i < c.l.length ? c.l[i] * 0.35 : 0);
    a.r![i] += (j >= 0 ? b.r![j] : 0) * 0.6 + (i < c.l.length ? c.l[i] * 0.35 : 0);
  }
  return fade(a, 0, frames(0.03, sr));
}

/** Laser zap: a square-ish tone diving from 3.2 kHz to 140 Hz with a little FM fizz. */
function zap(sr: number): Sample {
  const n = frames(0.32, sr);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  let pl = 0;
  let pr = 0.25;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = 140 + 3100 * Math.exp(-t / 0.045);
    const fm = 1 + 0.08 * Math.sin(TAU * 55 * t);
    pl += (f * fm) / sr;
    pr += (f * 1.012 * fm) / sr;
    const env = Math.exp(-t / 0.11) * Math.min(1, i / 4);
    l[i] = softSat(Math.sin(TAU * pl) * 2.5, 2) * env;
    r[i] = softSat(Math.sin(TAU * pr) * 2.5, 2) * env;
  }
  return fade(stereo(l, r), 0, frames(0.04, sr));
}

/** Air horn: two raspy detuned horns a minor third apart, three blasts, the last one held. */
function horn(sr: number): Sample {
  const n = frames(0.66, sr);
  const blasts: [number, number][] = [
    [0, 0.085],
    [0.115, 0.2],
    [0.23, 0.6],
  ];
  const tones = [midiToHz(68), midiToHz(68) * 1.006, midiToHz(71), midiToHz(71) * 0.994];
  const tables = tones.map((f) => waveTable('saw', f * 1.03, sr));
  const ph = [0, 0.3, 0.55, 0.8];
  const chans = [new Float32Array(n), new Float32Array(n)];
  const rand = rng(4242);
  const flutter = Array.from({ length: 64 }, () => rand() * 2 - 1);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let env = 0;
    for (const [a, b] of blasts) {
      if (t >= a && t < b + 0.02) {
        const u = t - a;
        env = Math.max(env, Math.min(1, u / 0.006) * (t < b ? 1 : 1 - (t - b) / 0.02));
      }
    }
    const scoop = Math.pow(2, (-0.9 / 12) * Math.exp(-((t % 0.115) / 0.02)));
    const fl = 1 + 0.004 * flutter[Math.floor(t * 90) & 63];
    for (let k = 0; k < 4; k++) {
      const x = ph[k] * TABLE_SIZE;
      const i0 = x | 0;
      const s = tables[k][i0] + (x - i0) * (tables[k][i0 + 1] - tables[k][i0]);
      ph[k] += (tones[k] * scoop * fl) / sr;
      if (ph[k] >= 1) ph[k] -= 1;
      chans[k & 1][i] += s * env * 0.5;
    }
  }
  for (const ch of chans) {
    // brassy: emphasise ~1.4 kHz and ~3 kHz, roll off the fizz, then saturate
    const f1 = new Svf();
    const f2 = new Svf();
    const lp = new Svf();
    f1.set(1400, 1.6, sr);
    f2.set(3000, 2, sr);
    lp.set(6000, 0.7, sr);
    for (let i = 0; i < n; i++) {
      const x = ch[i];
      const y = x * 0.6 + f1.bp(x) * 1.2 + f2.bp(x) * 0.7;
      ch[i] = softSat(lp.lp(y) * 2.2, 2.2);
    }
  }
  return fade(stereo(chans[0], chans[1]), 0, frames(0.03, sr));
}

/** Metronome click: a sine burst at full level from the very first sample. */
function click(sr: number, freq: number, decay: number, len: number, bright: number): Sample {
  const n = frames(len, sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    // cosine: full amplitude at sample 0, so the onset is exact
    out[i] = (Math.cos(TAU * freq * t) + bright * Math.cos(TAU * freq * 2.71 * t) * Math.exp(-t / 0.002)) * Math.exp(-t / decay);
  }
  return fade(stereo(out, out.slice()), 0, frames(0.006, sr));
}

/** Rising chime: a quick major arpeggio of FM bells. */
function success(sr: number): Sample {
  const n = frames(1.1, sr);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  const seq: [number, number][] = [
    [84, 0],
    [88, 0.07],
    [91, 0.14],
    [96, 0.21],
  ];
  for (const [m, at] of seq) {
    const b = bell(sr, m, { ratio: 3.5, index: 1.6, indexDecay: 0.08, decay: 0.32, len: 0.85 });
    const o = frames(at, sr);
    for (let i = 0; i < b.l.length && o + i < n; i++) {
      l[o + i] += b.l[i] * 0.5;
      r[o + i] += b.r![i] * 0.5;
    }
  }
  return fade(stereo(l, r), 0, frames(0.12, sr));
}

/**
 * Low, soft thud with a muted falling minor third on top (G4 → E4, rounded triangle-ish tone), so
 * it reads as "not quite" on a phone speaker without being harsh.
 */
function fail(sr: number): Sample {
  const n = frames(0.5, sr);
  const out = new Float32Array(n);
  const nz = filter(noise(n, 6060), 'lp', 600, 0.7, sr);
  const tone = new Svf();
  tone.set(1500, 0.7, sr);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const thud = Math.sin(TAU * (70 * t + 60 * 0.05 * (1 - Math.exp(-t / 0.05)))) * Math.exp(-t / 0.12) * Math.min(1, i / 24);
    const f = t < 0.13 ? midiToHz(67) : midiToHz(64);
    ph += f / sr;
    const tri = 1 - 4 * Math.abs((ph % 1) - 0.5);
    const tenv = t < 0.13 ? Math.exp(-t / 0.09) * Math.min(1, i / 48) : 0.85 * Math.exp(-(t - 0.13) / 0.12) * Math.min(1, (t - 0.13) / 0.012) + Math.exp(-t / 0.09) * Math.max(0, 1 - (t - 0.13) / 0.012);
    out[i] = thud * 0.8 + nz[i] * 0.5 * Math.exp(-t / 0.025) + tone.lp(tri) * tenv * 0.55;
  }
  return fade(stereo(out, out.slice()), 0, frames(0.08, sr));
}

/** Crowd swell: many voices (noise through moving vowel formants) and scattered claps. */
function cheer(sr: number): Sample {
  const len = 1.5;
  const n = frames(len, sr);
  const chans = [new Float32Array(n), new Float32Array(n)];
  const rand = rng(777);
  const F: [number, number][] = [
    [800, 1200],
    [500, 900],
    [350, 2300],
    [600, 1700],
  ];
  for (let v = 0; v < 14; v++) {
    const src = noise(n, 900 + v);
    const [a, b] = F[v % F.length];
    const shift = 0.85 + rand() * 0.5;
    const f1 = new Svf();
    const f2 = new Svf();
    const rate = 3 + rand() * 5;
    const phase = rand() * TAU;
    const start = v === 0 ? 0 : rand() * 0.25;
    const pan = rand();
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      if ((i & 63) === 0) {
        const wob = 1 + 0.25 * Math.sin(TAU * rate * 0.3 * t + phase);
        f1.set(a * shift * wob, 6, sr);
        f2.set(b * shift * wob, 7, sr);
      }
      const am = 0.6 + 0.4 * Math.sin(TAU * rate * t + phase);
      const env = t < start ? 0 : (v === 0 ? 0.35 + 0.65 * Math.min(1, t / 0.35) : Math.min(1, (t - start) / 0.35)) * (t > len - 0.6 ? Math.max(0, (len - t) / 0.6) : 1);
      const y = (f1.bp(src[i]) + f2.bp(src[i]) * 0.6) * am * env;
      chans[0][i] += y * (1 - pan);
      chans[1][i] += y * pan;
    }
  }
  // a few voices shouting "wooo": saws gliding up through an "oo" formant pair
  for (let v = 0; v < 4; v++) {
    const f0 = 260 + rand() * 180;
    const at = 0.08 + rand() * 0.3;
    const dur = 0.7 + rand() * 0.4;
    const table = waveTable('saw', f0 * 1.6, sr);
    const fa = new Svf();
    const fb = new Svf();
    fa.set(420 * (1 + v * 0.08), 5, sr);
    fb.set(1000 * (1 + v * 0.06), 6, sr);
    const ch = chans[v & 1];
    const other = chans[(v + 1) & 1];
    let ph = rand();
    const i0 = Math.floor(at * sr);
    const m = Math.min(n - i0, Math.floor(dur * sr));
    for (let i = 0; i < m; i++) {
      const u = i / m;
      const f = f0 * (1 + 0.45 * Math.min(1, u * 2.2)) * (1 + 0.012 * Math.sin(TAU * 6 * u * dur));
      ph += f / sr;
      if (ph >= 1) ph -= 1;
      const x = ph * TABLE_SIZE;
      const k = x | 0;
      const sv = table[k] + (x - k) * (table[k + 1] - table[k]);
      const env = Math.sin(Math.PI * u) ** 1.5 * 0.5;
      const y = (fa.bp(sv) + fb.bp(sv) * 0.45) * env;
      ch[i0 + i] += y * 0.75;
      other[i0 + i] += y * 0.35;
    }
  }
  // applause: short bright bursts at random times, denser in the middle
  for (let k = 0; k < 70; k++) {
    const at = Math.floor((0.1 + rand() * 1.1) * sr);
    const burst = filter(noise(frames(0.02, sr), 3000 + k), 'bp', 1500 + rand() * 1500, 1.2, sr);
    const ch = chans[k & 1];
    for (let i = 0; i < burst.length && at + i < n; i++) ch[at + i] += burst[i] * 1.2 * Math.exp(-i / (0.004 * sr));
  }
  return fade(stereo(chans[0], chans[1]), frames(0.005, sr), frames(0.2, sr));
}

/** Noise sweep: a band rising then falling, moving across the stereo field. */
function whoosh(sr: number): Sample {
  const n = frames(0.8, sr);
  const src = noise(n, 5150);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  const f = new Svf();
  for (let i = 0; i < n; i++) {
    const u = i / n;
    if ((i & 31) === 0) f.set(300 * Math.pow(20, Math.sin(Math.PI * Math.pow(u, 0.8))), 1.8, sr);
    const env = 0.12 * (1 - u) + 0.88 * Math.sin(Math.PI * Math.pow(u, 0.7)) ** 2;
    const y = f.bp(src[i]) * env;
    const p = 0.15 + 0.7 * u;
    l[i] = y * Math.cos((p * Math.PI) / 2);
    r[i] = y * Math.sin((p * Math.PI) / 2);
  }
  return fade(stereo(l, r), 0, frames(0.04, sr));
}

const MAKERS: Record<SoundName, (sr: number) => Sample> = {
  boom,
  clap: padClap,
  zap,
  horn,
  tick: (sr) => click(sr, 2600, 0.012, 0.05, 0.5),
  tock: (sr) => click(sr, 1500, 0.01, 0.045, 0.2),
  success,
  fail,
  cheer,
  whoosh,
};

export const SOUND_NAMES = Object.keys(MAKERS) as SoundName[];

/**
 * The pads play over the music and must feel equally loud: each is set to the same loudest-50 ms
 * RMS, unless that would push its peak past SOUND_PEAK.
 */
const PAD_RMS = 0.35;
const PADS: readonly SoundName[] = ['boom', 'clap', 'zap', 'horn'];

/** Float sample → 16-bit stereo PCM, normalised to the sound's peak. */
export function toPcm(s: Sample, sr: number, peak: number, rms?: number): PcmData {
  if (rms !== undefined) {
    normRms(s, rms, sr);
    if (peakOf(s.l, s.r) > peak) normPeak(s, peak);
  } else normPeak(s, peak);
  const r = s.r ?? s.l;
  const n = s.l.length;
  const a = new Int16Array(n);
  const b = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    a[i] = Math.max(-32768, Math.min(32767, Math.round(s.l[i] * 32767)));
    b[i] = Math.max(-32768, Math.min(32767, Math.round(r[i] * 32767)));
  }
  return { sampleRate: sr, length: n, channels: [a, b] };
}

export function renderSound(name: SoundName, sr: number): PcmData {
  return toPcm(MAKERS[name](sr), sr, SOUND_PEAK[name], PADS.includes(name) ? PAD_RMS : undefined);
}
