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
  const beats = Math.max(1, Math.floor((bands.durationSec - first) / beatSec));
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

  // bar loudness
  const barSec = beatSec * BEATS_PER_BAR;
  const levels = new Float64Array(barCount);
  for (let b = 0; b < barCount; b++) {
    let from = Math.round((first + b * barSec) * rate);
    let to = Math.round((first + (b + 1) * barSec) * rate);
    if (from < 0) from = 0;
    if (to > bands.length) to = bands.length;
    let sum = 0;
    for (let f = from; f < to; f++) {
      sum += BAND_LOUDNESS.low * bands.low[f] + BAND_LOUDNESS.mid * bands.mid[f] + BAND_LOUDNESS.high * bands.high[f];
    }
    // a last bar cut short by the end of the track is measured over what there is of it;
    // a sliver of a bar takes the level of the bar before
    levels[b] = to - from > barSec * rate * 0.25 ? Math.sqrt(sum / (to - from)) : b > 0 ? levels[b - 1] : 0;
  }
  const reference = percentile(levels, BAR_PERCENTILE);
  if (reference > 1e-5) {
    for (let b = 0; b < barCount; b++) out.bar[b] = Math.min(1, Math.pow(levels[b] / reference, BAR_GAMMA));
  }
  return out;
}
