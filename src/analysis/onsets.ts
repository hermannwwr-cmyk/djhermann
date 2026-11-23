/**
 * Onset strength per band: how fast the band's loudness is rising, per millisecond.
 * Each band's power is smoothed just enough to hide the ripple of its own lowest frequency,
 * compressed logarithmically (so a hit counts by how much it stands out, not by its absolute
 * level) and differentiated; only rises faster than a slow swell are kept.
 */
import type { BandPower } from './bands';
import { hannKernel, percentile, smooth } from './dsp';

export interface OnsetStrength {
  /** frames per second */
  rate: number;
  length: number;
  /** >= 0: rise of the log envelope per frame, above the slow-swell threshold */
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
}

export type BandName = 'low' | 'mid' | 'high';
export const BAND_NAMES: readonly BandName[] = ['low', 'mid', 'high'];

/** Smoothing window (ms) per band: about two periods of the band's lowest frequency of interest. */
const SMOOTH_MS: Record<BandName, number> = { low: 29, mid: 7, high: 5 };
/** The knee of the log compression sits this far below the band's loud level. */
const KNEE = 0.1;
/** A band quieter than this fraction of the loudest band is compressed against the loudest band. */
const WEAK_BAND = 0.05;
/** Rises slower than this (log units per ms) are swells, not onsets. */
const SWELL = 0.008;
/** Tracks quieter than this amplitude (about -74 dBFS) have no onsets. */
const SILENCE = 2e-4;

export function computeOnsets(bands: BandPower): OnsetStrength {
  const n = bands.length;
  const amps: Record<BandName, Float32Array> = {
    low: new Float32Array(n),
    mid: new Float32Array(n),
    high: new Float32Array(n),
  };
  const refs: Record<BandName, number> = { low: 0, mid: 0, high: 0 };
  // percentiles over a quarter of the frames are plenty and four times cheaper to sort
  const stride = n > 40000 ? 4 : 1;
  const sample = new Float32Array(Math.ceil(n / stride));
  for (const band of BAND_NAMES) {
    const amp = amps[band];
    smooth(bands[band], hannKernel(Math.max(1, Math.round((SMOOTH_MS[band] * bands.rate) / 1000))), amp);
    for (let i = 0; i < n; i++) amp[i] = Math.sqrt(amp[i] > 0 ? amp[i] : 0);
    for (let i = 0, k = 0; i < n; i += stride, k++) sample[k] = amp[i];
    refs[band] = percentile(sample, 0.98);
  }
  const loudest = Math.max(refs.low, refs.mid, refs.high);
  const out: OnsetStrength = {
    rate: bands.rate,
    length: n,
    low: new Float32Array(n),
    mid: new Float32Array(n),
    high: new Float32Array(n),
  };
  if (!(loudest > SILENCE)) return out;
  for (const band of BAND_NAMES) {
    const amp = amps[band];
    const flux = out[band];
    const knee = KNEE * Math.max(refs[band], loudest * WEAK_BAND);
    // reuse `amp` for the log envelope
    for (let i = 0; i < n; i++) amp[i] = Math.log(1 + amp[i] / knee);
    for (let i = 1; i < n - 1; i++) {
      const rise = (amp[i + 1] - amp[i - 1]) * 0.5 - SWELL;
      flux[i] = rise > 0 ? rise : 0;
    }
  }
  return out;
}
