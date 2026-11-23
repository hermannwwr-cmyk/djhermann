/**
 * Front end shared by every analysis: mono mixdown, three-band split and per-millisecond band
 * power. The waveform, the beat-energy map and the beat-grid detector are all derived from it.
 *
 *   PCM ─ mixdown (mono, ÷2) ─┬─ high-pass 2.5 kHz ───────────────► high power / ms
 *                             ├─ high-pass 180 Hz ─ low-pass 2.5 kHz ► mid power / ms
 *                             └─ ÷4 ─ low-pass 180 Hz ─────────────► low power / ms
 */
import type { PcmData, ProgressFn } from '../core/types';
import { BUTTER4_Q, biquad, groupDelay } from './dsp';
import type { Biquad } from './dsp';

/** Band-power frames per second (1 ms frames at any sample rate). */
export const ENV_RATE = 1000;
/** Crossover frequencies of the three bands. */
export const LOW_HZ = 180;
export const HIGH_HZ = 2500;

/** Mono mix of a track at half (or less) of its sample rate: the input of the band split. */
export interface MonoMix {
  sampleRate: number;
  length: number;
  samples: Int16Array;
}

/** Mean power of each band per 1 ms frame. */
export interface BandPower {
  /** frames per second (ENV_RATE) */
  rate: number;
  /** number of frames */
  length: number;
  durationSec: number;
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
}

/** How many source frames are averaged into one mono sample (keeps the mix at 22–32 kHz). */
export function mixFactor(sampleRate: number): number {
  return Math.max(1, Math.floor(sampleRate / 22050));
}

/** Allocate the mono mix for a track. Fill it with `mixInto`. */
export function createMix(pcm: PcmData): MonoMix {
  const factor = mixFactor(pcm.sampleRate);
  const length = Math.floor(pcm.length / factor);
  return { sampleRate: pcm.sampleRate / factor, length, samples: new Int16Array(length) };
}

/** Fill mono samples [from, to) of the mix. Split into chunks to keep the main thread free. */
export function mixInto(pcm: PcmData, mix: MonoMix, from: number, to: number): void {
  const factor = mixFactor(pcm.sampleRate);
  const out = mix.samples;
  const left = pcm.channels[0];
  const right = pcm.channels.length > 1 ? pcm.channels[1] : null;
  if (!left) return;
  if (right && factor === 2) {
    for (let i = from, j = from * 2; i < to; i++, j += 2) {
      out[i] = (left[j] + left[j + 1] + right[j] + right[j + 1]) >> 2;
    }
    return;
  }
  const scale = 1 / (factor * (right ? 2 : 1));
  for (let i = from; i < to; i++) {
    let sum = 0;
    const base = i * factor;
    for (let k = 0; k < factor; k++) sum += left[base + k] + (right ? right[base + k] : 0);
    out[i] = Math.round(sum * scale);
  }
}

/** Mono mixdown in one go (blocks for a few tens of milliseconds on a long track). */
export function mixdown(pcm: PcmData): MonoMix {
  const mix = createMix(pcm);
  mixInto(pcm, mix, 0, mix.length);
  return mix;
}

const butter4 = (kind: 'lp' | 'hp', freq: number, sampleRate: number): [Biquad, Biquad] => [
  biquad(kind, freq, sampleRate, BUTTER4_Q[0]),
  biquad(kind, freq, sampleRate, BUTTER4_Q[1]),
];

/** Split the mono mix into three bands and measure each band's mean power per millisecond. */
export function computeBandPower(mix: MonoMix, onProgress?: ProgressFn): BandPower {
  const fs = mix.sampleRate;
  const n = mix.length;
  const s = mix.samples;
  const durationSec = n / fs;
  const frames = Math.max(1, Math.ceil(durationSec * ENV_RATE - 1e-9));
  const low = new Float32Array(frames);
  const mid = new Float32Array(frames);
  const high = new Float32Array(frames);
  const samplesPerFrame = fs / ENV_RATE;
  const SCALE = 1 / 32768;

  // high band: fourth-order high-pass
  const [h1, h2] = butter4('hp', HIGH_HZ, fs);
  const h1b0 = h1[0], h1b1 = h1[1], h1b2 = h1[2], h1a1 = h1[3], h1a2 = h1[4];
  const h2b0 = h2[0], h2b1 = h2[1], h2b2 = h2[2], h2a1 = h2[3], h2a2 = h2[4];
  let h1z1 = 0, h1z2 = 0, h2z1 = 0, h2z2 = 0;

  // mid band: fourth-order high-pass at the low crossover, fourth-order low-pass at the high one
  const [m1, m2] = butter4('hp', LOW_HZ, fs);
  const [m3, m4] = butter4('lp', HIGH_HZ, fs);
  const m1b0 = m1[0], m1b1 = m1[1], m1b2 = m1[2], m1a1 = m1[3], m1a2 = m1[4];
  const m2b0 = m2[0], m2b1 = m2[1], m2b2 = m2[2], m2a1 = m2[3], m2a2 = m2[4];
  const m3b0 = m3[0], m3b1 = m3[1], m3b2 = m3[2], m3a1 = m3[3], m3a2 = m3[4];
  const m4b0 = m4[0], m4b1 = m4[1], m4b2 = m4[2], m4a1 = m4[3], m4a2 = m4[4];
  let m1z1 = 0, m1z2 = 0, m2z1 = 0, m2z2 = 0, m3z1 = 0, m3z2 = 0, m4z1 = 0, m4z2 = 0;

  // low band input: the mix decimated by four with a boxcar (its nulls sit exactly on the
  // frequencies that would alias into the low band)
  const LOW_DECIM = 4;
  const lowLength = Math.floor(n / LOW_DECIM);
  const lowIn = new Float32Array(lowLength);
  let acc = 0;

  const report = onProgress ? Math.max(1, Math.floor(frames / 40)) : 0;
  let i = 0;
  for (let m = 0; m < frames; m++) {
    let end = Math.ceil((m + 1) * samplesPerFrame);
    if (end > n || m === frames - 1) end = n;
    const start = i;
    let sumHigh = 0;
    let sumMid = 0;
    for (; i < end; i++) {
      const x = s[i] * SCALE;

      acc += x;
      if ((i & 3) === 3) {
        lowIn[i >> 2] = acc * 0.25;
        acc = 0;
      }

      let y = h1b0 * x + h1z1;
      h1z1 = h1b1 * x - h1a1 * y + h1z2;
      h1z2 = h1b2 * x - h1a2 * y;
      let v = h2b0 * y + h2z1;
      h2z1 = h2b1 * y - h2a1 * v + h2z2;
      h2z2 = h2b2 * y - h2a2 * v;
      sumHigh += v * v;

      y = m1b0 * x + m1z1;
      m1z1 = m1b1 * x - m1a1 * y + m1z2;
      m1z2 = m1b2 * x - m1a2 * y;
      v = m2b0 * y + m2z1;
      m2z1 = m2b1 * y - m2a1 * v + m2z2;
      m2z2 = m2b2 * y - m2a2 * v;
      y = m3b0 * v + m3z1;
      m3z1 = m3b1 * v - m3a1 * y + m3z2;
      m3z2 = m3b2 * v - m3a2 * y;
      v = m4b0 * y + m4z1;
      m4z1 = m4b1 * y - m4a1 * v + m4z2;
      m4z2 = m4b2 * y - m4a2 * v;
      sumMid += v * v;
    }
    const count = i - start;
    if (count > 0) {
      high[m] = sumHigh / count;
      mid[m] = sumMid / count;
    }
    if (report && m % report === 0) onProgress!(0.9 * (m / frames));
  }

  // low band: a 25 Hz high-pass (rumble, DC) and a fourth-order low-pass at the decimated rate
  const lowRate = fs / LOW_DECIM;
  const l0 = biquad('hp', 25, lowRate, Math.SQRT1_2);
  const [l1, l2] = butter4('lp', LOW_HZ, lowRate);
  const l0b0 = l0[0], l0b1 = l0[1], l0b2 = l0[2], l0a1 = l0[3], l0a2 = l0[4];
  const l1b0 = l1[0], l1b1 = l1[1], l1b2 = l1[2], l1a1 = l1[3], l1a2 = l1[4];
  const l2b0 = l2[0], l2b1 = l2[1], l2b2 = l2[2], l2a1 = l2[3], l2a2 = l2[4];
  let l0z1 = 0, l0z2 = 0, l1z1 = 0, l1z2 = 0, l2z1 = 0, l2z2 = 0;
  // The low-pass delays a kick by a few milliseconds; shift the frames back by that much so the
  // three bands line up in time. The boxcar's centre is 1.5 mix samples after its first sample.
  const delaySec = groupDelay([l0, l1, l2], 70, lowRate) - 1.5 / fs;
  const counts = new Uint16Array(frames);
  for (let j = 0; j < lowLength; j++) {
    const x = lowIn[j];
    let y = l0b0 * x + l0z1;
    l0z1 = l0b1 * x - l0a1 * y + l0z2;
    l0z2 = l0b2 * x - l0a2 * y;
    let v = l1b0 * y + l1z1;
    l1z1 = l1b1 * y - l1a1 * v + l1z2;
    l1z2 = l1b2 * y - l1a2 * v;
    y = l2b0 * v + l2z1;
    l2z1 = l2b1 * v - l2a1 * y + l2z2;
    l2z2 = l2b2 * v - l2a2 * y;
    const frame = Math.floor((j / lowRate - delaySec) * ENV_RATE);
    if (frame >= 0 && frame < frames) {
      low[frame] += y * y;
      counts[frame]++;
    }
  }
  for (let m = 0; m < frames; m++) {
    if (counts[m] > 0) low[m] /= counts[m];
  }
  onProgress?.(1);
  return { rate: ENV_RATE, length: frames, durationSec, low, mid, high };
}
