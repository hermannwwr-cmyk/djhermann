/**
 * Beat-energy map: onset strength per sixteenth note and band on a known beat grid, plus the
 * loudness of every bar. The rhythm game charts its notes from it and the sections come from it.
 */
import { BEATS_PER_BAR } from '../core/types';
import type { BeatEnergy, BeatGrid } from '../core/types';
import type { BandPower } from './bands';
import { percentile } from './dsp';
import { BAND_NAMES } from './onsets';
import type { OnsetStrength } from './onsets';

/** Subdivisions per beat. */
export const ENERGY_DIV = 4;
/** Strengths are divided by this percentile of the hits in the band (and clipped at 1). */
const HIT_PERCENTILE = 0.95;
/** Total rise (log units) below which a sixteenth holds no hit worth counting. */
const HIT_FLOOR = 0.15;
/** The band's reference is never below this rise, so a band with only faint hits stays faint. */
const MIN_REFERENCE = 0.6;
/** Loudness of a bar: this percentile of all bars maps to 1. */
const BAR_PERCENTILE = 0.9;
/** Loudness-like compression of the bar level. */
const BAR_GAMMA = 0.6;
/** Rough loudness weighting of the bands (treble counts more than its power suggests). */
const BAND_LOUDNESS = { low: 1, mid: 1, high: 2.5 } as const;

export function computeBeatEnergy(bands: BandPower, onsets: OnsetStrength, grid: BeatGrid): BeatEnergy {
  const div = ENERGY_DIV;
  const bpm = grid.bpm > 0 && Number.isFinite(grid.bpm) ? grid.bpm : 120;
  const beatSec = 60 / bpm;
  const first = Number.isFinite(grid.firstBeatSec) ? grid.firstBeatSec : 0;
  const beats = beatCount(grid, bands.durationSec);
  const n = beats * div;
  const barCount = Math.ceil(beats / BEATS_PER_BAR);
  const out: BeatEnergy = {
    div,
    low: new Float32Array(n),
    mid: new Float32Array(n),
    high: new Float32Array(n),
    bar: new Float32Array(barCount),
  };
  const rate = onsets.rate;
  const stepSec = beatSec / div;
  const frames = onsets.length;

  // every onset frame belongs to the sixteenth it is nearest to
  const edge = (i: number): number => {
    const f = Math.round((first + (i - 0.5) * stepSec) * rate);
    return f < 0 ? 0 : f > frames ? frames : f;
  };
  const hits: number[] = [];
  for (const band of BAND_NAMES) {
    const src = onsets[band];
    const dst = out[band];
    hits.length = 0;
    let from = edge(0);
    for (let i = 0; i < n; i++) {
      const to = edge(i + 1);
      let sum = 0;
      for (let f = from; f < to; f++) sum += src[f];
      dst[i] = sum;
      if (sum > HIT_FLOOR) hits.push(sum);
      from = to;
    }
    const reference = Math.max(MIN_REFERENCE, hits.length ? percentile(hits, HIT_PERCENTILE) : 0);
    for (let i = 0; i < n; i++) dst[i] = dst[i] >= reference ? 1 : dst[i] / reference;
  }

  out.bar.set(barLevels(loudnessEnvelope(bands), grid, barCount));
  return out;
}

/** Loudness-weighted band power, averaged over frames: what the bar levels are measured from. */
export interface LoudnessEnvelope {
  /** frames per second */
  rate: number;
  data: Float32Array;
}

/**
 * Loudness-weighted power of the three bands, optionally averaged down to `rate` frames per second.
 * At 100 frames per second it is small enough to store with a track (about 120 kB for 5 minutes)
 * and still gives the same bar levels, so the sections can be re-estimated for a corrected grid
 * without decoding the file again.
 */
export function loudnessEnvelope(bands: BandPower, rate = bands.rate): LoudnessEnvelope {
  const factor = Math.max(1, Math.round(bands.rate / rate));
  const n = Math.ceil(bands.length / factor);
  const data = new Float32Array(n);
  for (let j = 0; j < n; j++) {
    const from = j * factor;
    const to = Math.min(bands.length, from + factor);
    let sum = 0;
    for (let f = from; f < to; f++) {
      sum += BAND_LOUDNESS.low * bands.low[f] + BAND_LOUDNESS.mid * bands.mid[f] + BAND_LOUDNESS.high * bands.high[f];
    }
    data[j] = to > from ? sum / (to - from) : 0;
  }
  return { rate: bands.rate / factor, data };
}

/** Number of whole beats from the grid's first beat to the end of the track (at least 1). */
export function beatCount(grid: BeatGrid, durationSec: number): number {
  const bpm = grid.bpm > 0 && Number.isFinite(grid.bpm) ? grid.bpm : 120;
  const first = Number.isFinite(grid.firstBeatSec) ? grid.firstBeatSec : 0;
  return Math.max(1, Math.floor(((durationSec - first) * bpm) / 60));
}

/** 0..1 loudness of each bar on a grid: a high percentile of the bars maps to 1, compressed like loudness. */
export function barLevels(env: LoudnessEnvelope, grid: BeatGrid, barCount: number): Float32Array {
  const out = new Float32Array(barCount);
  const bpm = grid.bpm > 0 && Number.isFinite(grid.bpm) ? grid.bpm : 120;
  const first = Number.isFinite(grid.firstBeatSec) ? grid.firstBeatSec : 0;
  const barSec = (60 / bpm) * BEATS_PER_BAR;
  const rate = env.rate;
  const frames = env.data.length;
  const levels = new Float64Array(barCount);
  for (let b = 0; b < barCount; b++) {
    let from = Math.round((first + b * barSec) * rate);
    let to = Math.round((first + (b + 1) * barSec) * rate);
    if (from < 0) from = 0;
    if (to > frames) to = frames;
    let sum = 0;
    for (let f = from; f < to; f++) sum += env.data[f];
    // a last bar cut short by the end of the track is measured over what there is of it;
    // a sliver of a bar takes the level of the bar before
    levels[b] = to - from > barSec * rate * 0.25 ? Math.sqrt(sum / (to - from)) : b > 0 ? levels[b - 1] : 0;
  }
  const reference = percentile(levels, BAR_PERCENTILE);
  if (reference > 1e-5) {
    for (let b = 0; b < barCount; b++) out[b] = Math.min(1, Math.pow(levels[b] / reference, BAR_GAMMA));
  }
  return out;
}
