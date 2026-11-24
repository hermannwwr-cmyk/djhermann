/**
 * Three-band display waveform: per-bucket peak amplitude of each band, scaled per band against a
 * loud-but-not-loudest reference and compressed like loudness, so quiet parts stay visible and
 * loud parts keep their shape instead of sitting at 255.
 */
import type { WaveformData } from '../core/types';
import type { BandPower } from './bands';
import { percentile } from './dsp';

/** Buckets per second of track time. */
export const WAVEFORM_RATE = 200;

/** Frames (ms) a peak is held, so a band draws as an envelope and not as its own ripple. */
const HOLD_FRAMES = { low: 14, mid: 4, high: 2 } as const;
/** A band is never boosted more than this much (amplitude ratio) relative to the loudest band. */
const MAX_BAND_BOOST = 10;
/** The reference level (a high percentile of the band) lands here on the 0..1 scale. */
const REF_LEVEL = 0.9;
/** Loudness-like compression of the amplitude. */
const GAMMA = 0.6;
/** Above this the curve bends towards 1, so peaks over the reference are not clipped flat. */
const KNEE = 0.8;
/** A track whose loudest band stays under this amplitude (about -74 dBFS) is drawn as silence. */
const SILENCE = 2e-4;

/** Map an amplitude relative to the band's reference (1 = reference) to 0..255. */
export function displayLevel(relative: number): number {
  if (!(relative > 0)) return 0;
  let u = REF_LEVEL * Math.pow(relative, GAMMA);
  if (u > KNEE) u = KNEE + (1 - KNEE) * (1 - Math.exp(-(u - KNEE) / (1 - KNEE)));
  return Math.round(255 * u);
}

function bandPeaks(power: Float32Array, hold: number, perBucket: number, length: number): Float32Array {
  const peaks = new Float32Array(length);
  const frames = power.length;
  for (let b = 0; b < length; b++) {
    let from = b * perBucket - (hold - 1);
    if (from < 0) from = 0;
    let to = (b + 1) * perBucket;
    if (to > frames) to = frames;
    let max = 0;
    for (let m = from; m < to; m++) if (power[m] > max) max = power[m];
    peaks[b] = Math.sqrt(max);
  }
  return peaks;
}

export function computeWaveform(bands: BandPower): WaveformData {
  const perBucket = Math.max(1, Math.round(bands.rate / WAVEFORM_RATE));
  const rate = bands.rate / perBucket;
  const length = Math.ceil(bands.length / perBucket);
  const peaks = {
    low: bandPeaks(bands.low, HOLD_FRAMES.low, perBucket, length),
    mid: bandPeaks(bands.mid, HOLD_FRAMES.mid, perBucket, length),
    high: bandPeaks(bands.high, HOLD_FRAMES.high, perBucket, length),
  };
  const refs = {
    low: percentile(peaks.low, 0.99),
    mid: percentile(peaks.mid, 0.99),
    high: percentile(peaks.high, 0.99),
  };
  const loudest = Math.max(refs.low, refs.mid, refs.high);
  const out: WaveformData = {
    rate,
    length,
    low: new Uint8Array(length),
    mid: new Uint8Array(length),
    high: new Uint8Array(length),
  };
  if (!(loudest > SILENCE)) return out;
  for (const band of ['low', 'mid', 'high'] as const) {
    const ref = Math.max(refs[band], loudest / MAX_BAND_BOOST);
    const src = peaks[band];
    const dst = out[band];
    for (let b = 0; b < length; b++) dst[b] = displayLevel(src[b] / ref);
  }
  return out;
}
