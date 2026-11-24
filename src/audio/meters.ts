/**
 * Meter maths: peak and three-band energy of a block of samples (from an AnalyserNode), plus the
 * ballistics that make a meter readable. Pure, so it is unit-tested.
 */

export interface BlockLevels {
  peak: number;
  low: number;
  mid: number;
  high: number;
}

/** Band splits used for the visuals (one-pole filters, 6 dB/octave). */
export const METER_LOW_HZ = 180;
export const METER_HIGH_HZ = 2800;

/** Peak of a block (0..∞). */
export function blockPeak(data: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const a = data[i] < 0 ? -data[i] : data[i];
    if (a > peak) peak = a;
  }
  return peak;
}

/**
 * Peak and RMS per band of a block. The band filters start from rest at the block's first sample;
 * the first quarter of the block warms them up and is left out of the RMS.
 */
export function analyseBlock(data: Float32Array, sampleRate: number, out: BlockLevels): BlockLevels {
  const n = data.length;
  const kLow = 1 - Math.exp((-2 * Math.PI * METER_LOW_HZ) / sampleRate);
  const kHigh = 1 - Math.exp((-2 * Math.PI * METER_HIGH_HZ) / sampleRate);
  const skip = n >> 2;
  let lp1 = n ? data[0] : 0;
  let lp2 = lp1;
  let peak = 0;
  let sLow = 0;
  let sMid = 0;
  let sHigh = 0;
  for (let i = 0; i < n; i++) {
    const x = data[i];
    const a = x < 0 ? -x : x;
    if (a > peak) peak = a;
    lp1 += (x - lp1) * kLow; // below METER_LOW_HZ
    lp2 += (x - lp2) * kHigh; // below METER_HIGH_HZ
    if (i >= skip) {
      const low = lp1;
      const high = x - lp2;
      const mid = lp2 - lp1;
      sLow += low * low;
      sMid += mid * mid;
      sHigh += high * high;
    }
  }
  const m = Math.max(1, n - skip);
  out.peak = peak;
  out.low = Math.sqrt(sLow / m);
  out.mid = Math.sqrt(sMid / m);
  out.high = Math.sqrt(sHigh / m);
  return out;
}

/** RMS of a band → 0..1 for visuals. Calibrated on the built-in tracks: one deck at full level reaches about 0.8 (95th percentile) in every band, two decks mixed reach 1. */
export const BAND_SCALE = { low: 2.6, mid: 4.2, high: 11 } as const;
export const bandToUnit = (rms: number, scale: number): number => {
  const v = rms * scale;
  return v >= 1 ? 1 : v <= 0 ? 0 : Math.pow(v, 0.8);
};

/** Meter ballistics: jump up at once, fall back with a time constant. */
export function ballistic(prev: number, next: number, dtSec: number, releaseSec: number): number {
  if (next >= prev) return next;
  const fallen = prev * Math.exp(-Math.max(0, dtSec) / releaseSec);
  return fallen > next ? fallen : next;
}
