/**
 * Beat-grid detection for steady-tempo music (70-180 BPM, 4/4).
 *
 *  1. Coarse period: autocorrelation of the onset strength per band, scored together with its
 *     two- and four-fold lags so that binary (4/4) pulses win over dotted ones.
 *  2. Exact period: "epoch folding". The onsets are folded onto one beat period; the right period
 *     is the one that makes the folded profile sharpest. Searched over a growing stretch of the
 *     track, so the last pass resolves a drift of about a millisecond over the whole track.
 *  3. Half or double time: decided from where the low-band pulse and the backbeat sit.
 *  4. Snap to a whole or half BPM when the fold is about as sharp there.
 *  5. Beat phase from the folded profile, downbeat from where the arrangement changes.
 */
import { BEATS_PER_BAR } from '../core/types';
import type { BeatGrid } from '../core/types';
import { clamp01, smoothstep } from '../core/math';
import type { BandPower } from './bands';
import { autocorrelate } from './dsp';
import { BAND_NAMES } from './onsets';
import type { BandName, OnsetStrength } from './onsets';

export const MIN_BPM = 70;
export const MAX_BPM = 180;

/** How much each band counts when bands are added up: the kick drum carries the beat. */
const BAND_WEIGHT: Record<BandName, number> = { low: 1.5, mid: 1, high: 0.8 };
/** Onset frames weaker than this (log units per ms) are ignored. */
const EVENT_FLOOR = 0.012;
/** The folded onset peak sits this far from where the hits really start (measured on synthetic drums). */
const ONSET_LAG_SEC = -0.0009;
/** Snap to a whole/half BPM when the folded profile keeps at least this much of its sharpness. */
const SNAP_KEEP = 0.9;

export interface GridDetails {
  /** tempo of the best free fit, before snapping */
  fittedBpm: number;
  snapped: boolean;
  /** 'none' when only one tempo of the octave family is in range */
  octave: 'none' | 'fast' | 'slow';
  octaveReason: string;
  /** sharpness of the folded profile relative to a flat one (1 = no beat at all) */
  sharpness: number;
  /** spread of the beat phase between stretches of the track, ms */
  phaseSpreadMs: number;
  /** score of each of the four beats as the downbeat */
  downbeatScores: number[];
}

export interface GridResult {
  grid: BeatGrid;
  confidence: number;
  details: GridDetails;
}

/** Onset frames above the floor, as (time, strength) lists per band. Sorted by time. */
type AnyBand = BandName | 'sub';

interface Events {
  time: Record<AnyBand, Float64Array>;
  weight: Record<AnyBand, Float32Array>;
  total: Record<AnyBand, number>;
  durationSec: number;
}

function collectEvents(on: OnsetStrength): Events {
  const time = {} as Record<AnyBand, Float64Array>;
  const weight = {} as Record<AnyBand, Float32Array>;
  const total = {} as Record<AnyBand, number>;
  for (const band of ['low', 'mid', 'high', 'sub'] as const) {
    const src = on[band];
    let count = 0;
    for (let i = 0; i < src.length; i++) if (src[i] > EVENT_FLOOR) count++;
    const t = new Float64Array(count);
    const w = new Float32Array(count);
    let sum = 0;
    for (let i = 0, k = 0; i < src.length; i++) {
      if (src[i] > EVENT_FLOOR) {
        t[k] = (i + 0.5) / on.rate;
        w[k] = src[i];
        sum += src[i];
        k++;
      }
    }
    time[band] = t;
    weight[band] = w;
    total[band] = sum;
  }
  return { time, weight, total, durationSec: on.length / on.rate };
}

/** First index whose time is >= t. */
function lowerBound(times: Float64Array, t: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Fold one band's events in [from, to) seconds onto `period`, into `bins` (cleared first). */
function fold(ev: Events, band: AnyBand, period: number, bins: Float64Array, from = 0, to = Infinity): void {
  const times = ev.time[band];
  const weights = ev.weight[band];
  const nb = bins.length;
  bins.fill(0);
  const start = from > 0 ? lowerBound(times, from) : 0;
  const end = to < Infinity ? lowerBound(times, to) : times.length;
  const scale = nb / period;
  for (let i = start; i < end; i++) {
    const x = times[i] * scale;
    const k = Math.floor(x);
    const f = x - k;
    const a = k % nb;
    const b = a + 1 === nb ? 0 : a + 1;
    const w = weights[i];
    bins[a] += w * (1 - f);
    bins[b] += w * f;
  }
}

/** Sharpness of the fold at `period`: the weighted sum of squares of the three band profiles. */
function foldScore(ev: Events, period: number, bins: Float64Array, from = 0, to = Infinity): number {
  let score = 0;
  for (const band of BAND_NAMES) {
    fold(ev, band, period, bins, from, to);
    let sq = 0;
    for (let k = 0; k < bins.length; k++) sq += bins[k] * bins[k];
    score += BAND_WEIGHT[band] * sq;
  }
  return score;
}

/** Centre of the `windowSec` stretch with the most onset energy. */
function densestCentre(ev: Events, windowSec: number): number {
  const d = ev.durationSec;
  if (d <= windowSec) return d / 2;
  const step = 2;
  const slots = Math.ceil(d / step);
  const hist = new Float64Array(slots);
  for (const band of BAND_NAMES) {
    const t = ev.time[band];
    const w = ev.weight[band];
    for (let i = 0; i < t.length; i++) hist[Math.min(slots - 1, Math.floor(t[i] / step))] += w[i] * BAND_WEIGHT[band];
  }
  const span = Math.max(1, Math.round(windowSec / step));
  let sum = 0;
  for (let i = 0; i < span && i < slots; i++) sum += hist[i];
  let best = sum;
  let bestStart = 0;
  for (let i = span; i < slots; i++) {
    sum += hist[i] - hist[i - span];
    if (sum > best) {
      best = sum;
      bestStart = i - span + 1;
    }
  }
  return (bestStart + span / 2) * step;
}

/**
 * Find the period near `start` (within ±`range`, relative) whose fold is sharpest. The search
 * runs over a growing stretch of the track: each pass narrows the period enough for the next,
 * longer pass to stay on the same peak.
 */
function refinePeriod(ev: Events, start: number, range: number): { period: number; score: number; bins: number } {
  const d = ev.durationSec;
  const windows: number[] = [];
  for (const w of [30, 120, 480]) if (w < d * 0.8) windows.push(w);
  windows.push(d);
  const centre = densestCentre(ev, windows[0]);
  let period = start;
  let span = range;
  let score = 0;
  let nb = 1;
  for (const win of windows) {
    const binSec = win <= 30 ? 0.004 : win <= 120 ? 0.002 : 0.001;
    nb = Math.max(8, Math.round(period / binSec));
    const bins = new Float64Array(nb);
    const from = Math.max(0, Math.min(d - win, centre - win / 2));
    const to = from + win;
    // the fold stays sharp while the drift over the stretch is under about one pulse width
    const step = (0.3 * (2 * binSec + 0.003)) / win;
    const count = Math.max(3, Math.ceil(span / step));
    const scores = new Float64Array(2 * count + 1);
    let best = 0;
    for (let k = -count; k <= count; k++) {
      const s = foldScore(ev, period * (1 + k * step), bins, from, to);
      scores[k + count] = s;
      if (s > scores[best]) best = k + count;
    }
    let offset = best - count;
    if (best > 0 && best < 2 * count) {
      const a = scores[best - 1];
      const b = scores[best];
      const c = scores[best + 1];
      const denom = a - 2 * b + c;
      if (denom < 0) offset += (0.5 * (a - c)) / denom;
    }
    period *= 1 + offset * step;
    score = scores[best];
    span = 3 * step;
  }
  return { period, score, bins: nb };
}

/** Linear interpolation into an array at a fractional index (0 outside). */
function at(values: Float64Array, x: number): number {
  if (x < 0 || x >= values.length - 1) return 0;
  const i = Math.floor(x);
  const f = x - i;
  return values[i] * (1 - f) + values[i + 1] * f;
}

/** Largest value within ±radius samples of a fractional index. */
function peakNear(values: Float64Array, x: number, radius: number): number {
  let best = -Infinity;
  for (let k = -radius; k <= radius; k++) {
    const v = at(values, x + k);
    if (v > best) best = v;
  }
  return best;
}

interface Coarse {
  /** best pulse period in seconds, anywhere in the octave family */
  period: number;
  /** combined autocorrelation (weighted over bands, 1 at lag 0) */
  acf: Float64Array;
  /** lags per second */
  rate: number;
}

const ACF_RATE = 250;

/** Coarse pulse period from the band-wise autocorrelation of the onset strength. */
function coarsePeriod(on: OnsetStrength): Coarse | null {
  const decim = Math.max(1, Math.round(on.rate / ACF_RATE));
  const rate = on.rate / decim;
  const n = Math.floor(on.length / decim);
  const maxPeriod = 60 / MIN_BPM;
  const minPeriod = 60 / MAX_BPM;
  const maxLag = Math.min(n - 1, Math.ceil(maxPeriod * 1.03 * 4 * rate) + 2);
  if (maxLag < 8) return null;
  const acf = new Float64Array(maxLag + 1);
  const buf = new Float32Array(n);
  let zero = 0;
  for (const band of BAND_NAMES) {
    const src = on[band];
    for (let i = 0, j = 0; i < n; i++, j += decim) {
      let sum = 0;
      for (let k = 0; k < decim; k++) sum += src[j + k];
      buf[i] = sum;
    }
    const r = autocorrelate(buf, maxLag);
    for (let lag = 0; lag <= maxLag; lag++) acf[lag] += BAND_WEIGHT[band] * r[lag];
    zero += BAND_WEIGHT[band] * r[0];
  }
  if (!(zero > 0)) return null;
  for (let lag = 0; lag <= maxLag; lag++) acf[lag] /= zero;

  let best = -Infinity;
  let bestPeriod = 0;
  const stepSec = 0.0005;
  const scoreAt = (period: number): number => {
    const lag = period * rate;
    return (at(acf, lag) + at(acf, 2 * lag) + at(acf, 4 * lag)) / 3;
  };
  for (let period = minPeriod * 0.985; period <= maxPeriod * 1.015; period += stepSec) {
    const s = scoreAt(period);
    if (s > best) {
      best = s;
      bestPeriod = period;
    }
  }
  if (!(best > 0)) return null;
  return { period: bestPeriod, acf, rate };
}

/** Folded profile per band over `beats` beats, smoothed over ±2 ms. */
function foldedProfiles(
  ev: Events,
  period: number,
  beats: number,
  which: readonly AnyBand[] = BAND_NAMES,
): { nb: number; profiles: Record<AnyBand, Float64Array> } {
  const nb = Math.max(16, Math.round(period * beats * 1000));
  const raw = new Float64Array(nb);
  const profiles = {} as Record<AnyBand, Float64Array>;
  for (const band of which) {
    fold(ev, band, period * beats, raw);
    const out = new Float64Array(nb);
    for (let k = 0; k < nb; k++) {
      let sum = 0;
      for (let j = -2; j <= 2; j++) sum += raw[(k + j + nb) % nb];
      out[k] = sum / 5;
    }
    profiles[band] = out;
  }
  return { nb, profiles };
}

function maxAround(profile: Float64Array, centre: number, radius: number): number {
  const nb = profile.length;
  let best = 0;
  for (let j = -radius; j <= radius; j++) {
    const v = profile[(((Math.round(centre) + j) % nb) + nb) % nb];
    if (v > best) best = v;
  }
  return best;
}

function argMax(values: Float64Array): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i] > values[best]) best = i;
  return best;
}

/**
 * Mid-band energy in the 70 ms after each quarter of a folded period (above the steady
 * background), starting at `phase`. Tells a bare kick from a kick with a clap, or from a snare.
 */
function midEnergyAfterSlots(bands: BandPower, period: number, phase: number): number[] {
  const nb = Math.max(16, Math.round(period * 200)); // 5 ms bins
  const sums = new Float64Array(nb);
  const counts = new Float64Array(nb);
  const power = bands.mid;
  const scale = nb / (period * bands.rate);
  for (let i = 0; i < power.length; i++) {
    const k = Math.floor((i + 0.5) * scale) % nb;
    sums[k] += power[i];
    counts[k]++;
  }
  for (let k = 0; k < nb; k++) sums[k] = counts[k] > 0 ? sums[k] / counts[k] : 0;
  const background = Float64Array.from(sums).sort()[Math.floor(nb * 0.2)];
  const first = (phase / period) * nb;
  const width = Math.max(1, Math.round((0.07 / period) * nb));
  return [0, 1, 2, 3].map((j) => {
    let sum = 0;
    const start = Math.round(first + (j * nb) / 4) - 1;
    for (let k = 0; k < width; k++) sum += Math.max(0, sums[(((start + k) % nb) + nb) % nb] - background);
    return sum;
  });
}

/**
 * Both `fast` and 2 × `fast` are plausible beat periods. Decide which one is the beat.
 * Default: the faster one (140-180 BPM is dance music; 70-90 is its half-time reading).
 * The slower one wins when the faster pulse is hardly there, or when the bass drum plays on
 * every other fast beat with no snare in between (four-on-the-floor at the slow tempo).
 */
function chooseOctave(ev: Events, bands: BandPower, coarse: Coarse, fast: number): { choice: 'fast' | 'slow'; reason: string } {
  const lagFast = fast * coarse.rate;
  const support = peakNear(coarse.acf, lagFast, 2) / Math.max(1e-6, peakNear(coarse.acf, 2 * lagFast, 2));
  if (support < 0.2) return { choice: 'slow', reason: `no pulse at the fast tempo (support ${support.toFixed(2)})` };

  // four fast beats folded on top of each other: slot 0 is the strongest pulse, slots 1-3 follow it
  const { nb, profiles } = foldedProfiles(ev, fast, 4, ['low', 'mid', 'high', 'sub']);
  let subMean = 0;
  for (let k = 0; k < nb; k++) subMean += profiles.sub[k];
  subMean /= nb;
  const subPeak = profiles.sub[argMax(profiles.sub)];
  const totalWeight = ev.total.low * BAND_WEIGHT.low + ev.total.mid * BAND_WEIGHT.mid + ev.total.high * BAND_WEIGHT.high;
  // is there a bass drum at all? (a click track or a hi-hat loop has none)
  const kicks = ev.total.sub * BAND_WEIGHT.low > 0.08 * totalWeight && subPeak > 5 * subMean;
  let pulse = profiles.sub;
  if (!kicks) {
    pulse = new Float64Array(nb);
    for (const band of BAND_NAMES) for (let k = 0; k < nb; k++) pulse[k] += BAND_WEIGHT[band] * profiles[band][k];
  }
  const k0 = argMax(pulse);
  const quarter = nb / 4;
  const slots = (profile: Float64Array): number[] => [0, 1, 2, 3].map((j) => maxAround(profile, k0 + j * quarter, 8));
  const p = slots(pulse);
  const info = `pulse ${p.map((v) => (v / p[0]).toFixed(2)).join('/')}`;
  if (Math.min(p[1], p[2], p[3]) >= 0.55 * p[0]) return { choice: 'fast', reason: `pulse on every fast beat (${info})` };
  if (p[2] >= 0.55 * p[0] && Math.max(p[1], p[3]) <= 0.6 * Math.min(p[0], p[2])) {
    // The pulse is on every other fast beat. Look at how much mid-band sound (snare, clap)
    // follows each of the four fast beats.
    const e = kicks ? midEnergyAfterSlots(bands, fast * 4, (k0 / nb) * fast * 4) : [0, 0, 0, 0];
    const hits = `mid ${e.map((v) => (v / Math.max(1e-12, e[0] + e[2])).toFixed(2)).join('/')}`;
    if (kicks && Math.max(e[0], e[2]) >= 1.8 * Math.min(e[0], e[2])) {
      return { choice: 'slow', reason: `clap on every other kick (${info}, ${hits})` };
    }
    if (kicks && e[1] + e[3] >= 1.2 * (e[0] + e[2])) {
      return { choice: 'fast', reason: `kick and snare alternate (${info}, ${hits})` };
    }
    return { choice: 'slow', reason: `pulse on every other fast beat (${info}, ${hits})` };
  }
  return { choice: 'fast', reason: `no steady pulse, dance range preferred (${info})` };
}

/** Snap the period to a whole or half BPM if the fold stays about as sharp there. */
function snapPeriod(ev: Events, period: number, nb: number): { period: number; snapped: boolean } {
  const bins = new Float64Array(nb);
  const fitted = foldScore(ev, period, bins);
  const bpm = 60 / period;
  for (const candidate of [Math.round(bpm), Math.round(bpm * 2) / 2]) {
    if (candidate <= 0) continue;
    if (Math.abs(candidate - bpm) < 1e-9) return { period, snapped: false };
    const score = foldScore(ev, 60 / candidate, bins);
    if (score >= SNAP_KEEP * fitted) return { period: 60 / candidate, snapped: true };
  }
  return { period, snapped: false };
}

/** Phase (seconds, 0..period) of the beat: the strongest point of the weighted folded profile. */
function beatPhase(ev: Events, period: number): { phase: number; profile: Float64Array } {
  const { nb, profiles } = foldedProfiles(ev, period, 1);
  const combined = new Float64Array(nb);
  for (const band of BAND_NAMES) for (let k = 0; k < nb; k++) combined[k] += BAND_WEIGHT[band] * profiles[band][k];
  const k0 = argMax(combined);
  // centre of mass of the top of the peak
  const floor = combined[k0] * 0.5;
  let num = 0;
  let den = 0;
  for (let j = -6; j <= 6; j++) {
    const v = combined[(k0 + j + nb) % nb] - floor;
    if (v > 0) {
      num += v * j;
      den += v;
    }
  }
  const pos = k0 + (den > 0 ? num / den : 0);
  let phase = (pos / nb) * period - ONSET_LAG_SEC;
  phase = ((phase % period) + period) % period;
  return { phase, profile: combined };
}

/** How far the beat phase wanders between stretches of the track (weighted spread, seconds). */
function phaseSpread(ev: Events, period: number, reference: Float64Array): number {
  const d = ev.durationSec;
  const segments = Math.max(4, Math.min(12, Math.round(d / 20)));
  const nb = reference.length;
  const bins = new Float64Array(nb);
  const combined = new Float64Array(nb);
  const maxShift = Math.min(Math.floor(nb / 4), 40);
  const shifts: number[] = [];
  const weights: number[] = [];
  for (let s = 0; s < segments; s++) {
    const from = (s * d) / segments;
    const to = ((s + 1) * d) / segments;
    combined.fill(0);
    let weight = 0;
    for (const band of BAND_NAMES) {
      fold(ev, band, period, bins, from, to);
      for (let k = 0; k < nb; k++) {
        combined[k] += BAND_WEIGHT[band] * bins[k];
        weight += BAND_WEIGHT[band] * bins[k];
      }
    }
    if (!(weight > 0)) continue;
    let best = -Infinity;
    let bestShift = 0;
    for (let shift = -maxShift; shift <= maxShift; shift++) {
      let dot = 0;
      for (let k = 0; k < nb; k++) dot += combined[(k + shift + nb) % nb] * reference[k];
      if (dot > best) {
        best = dot;
        bestShift = shift;
      }
    }
    shifts.push((bestShift / nb) * period);
    weights.push(best);
  }
  if (shifts.length < 2) return 0.05;
  // stretches without drums (an intro, a break) have no phase worth comparing
  const strongest = Math.max(...weights);
  for (let i = 0; i < weights.length; i++) if (weights[i] < 0.25 * strongest) weights[i] = 0;
  let wsum = 0;
  let mean = 0;
  for (let i = 0; i < shifts.length; i++) {
    wsum += weights[i];
    mean += weights[i] * shifts[i];
  }
  mean /= wsum;
  let variance = 0;
  for (let i = 0; i < shifts.length; i++) variance += weights[i] * (shifts[i] - mean) ** 2;
  return Math.sqrt(variance / wsum);
}

/**
 * Which of the four beats is the downbeat. Layers come in and drop out on bar lines, so bars cut
 * at the right beat show the biggest jumps in loudness from one bar to the next; the snare or
 * clap sits on beats 2 and 4; and the first bass drum of a track is nearly always a "one".
 */
function chooseDownbeat(ev: Events, bands: BandPower, period: number, phase: number): { index: number; scores: number[] } {
  const rate = bands.rate;
  const beats = Math.floor((bands.durationSec - phase) / period);
  if (beats < 8) return { index: 0, scores: [1, 0, 0, 0] };

  // loudness per beat and band, in dB over a floor well below the band's loud level
  const level: Record<BandName, Float32Array> = {
    low: new Float32Array(beats),
    mid: new Float32Array(beats),
    high: new Float32Array(beats),
  };
  for (const band of BAND_NAMES) {
    const power = bands[band];
    const dst = level[band];
    let loud = 0;
    for (let k = 0; k < beats; k++) {
      const from = Math.max(0, Math.round((phase + k * period) * rate));
      const to = Math.min(power.length, Math.round((phase + (k + 1) * period) * rate));
      let sum = 0;
      for (let i = from; i < to; i++) sum += power[i];
      dst[k] = to > from ? sum / (to - from) : 0;
      if (dst[k] > loud) loud = dst[k];
    }
    const floor = Math.max(loud * 1e-4, 1e-10);
    for (let k = 0; k < beats; k++) dst[k] = 10 * Math.log10(1 + dst[k] / floor);
  }

  // 1. loudness jumps between consecutive bars; jumps up count double (drop-outs often come early)
  const jumps = [0, 0, 0, 0];
  for (let c = 0; c < BEATS_PER_BAR; c++) {
    const bars = Math.floor((beats - c) / BEATS_PER_BAR);
    for (const band of BAND_NAMES) {
      const src = level[band];
      let prev = 0;
      // the bar before the first whole one: beats that exist, the rest counts as silence
      for (let b = 0; b < BEATS_PER_BAR; b++) {
        const k = c - BEATS_PER_BAR + b;
        if (k >= 0) prev += src[k];
      }
      prev /= BEATS_PER_BAR;
      for (let j = 0; j < bars; j++) {
        const k = c + j * BEATS_PER_BAR;
        const cur = (src[k] + src[k + 1] + src[k + 2] + src[k + 3]) / BEATS_PER_BAR;
        const diff = cur - prev;
        jumps[c] += diff > 0 ? diff * diff : 0.5 * diff * diff;
        prev = cur;
      }
    }
  }
  const maxJump = Math.max(...jumps, 1e-9);

  // 2. backbeat: are the mid-band hits on odd or on even beats?
  const hit = (band: BandName, k: number): number => {
    const t = ev.time[band];
    const w = ev.weight[band];
    const centre = phase + k * period;
    let sum = 0;
    for (let i = lowerBound(t, centre - 0.02), end = lowerBound(t, centre + 0.04); i < end; i++) sum += w[i];
    return sum;
  };
  let even = 0;
  let odd = 0;
  let firstKick = -1;
  const lowHits = new Float32Array(beats);
  let lowMax = 0;
  for (let k = 0; k < beats; k++) {
    const m = hit('mid', k);
    if (k % 2 === 0) even += m;
    else odd += m;
    lowHits[k] = hit('low', k);
    if (lowHits[k] > lowMax) lowMax = lowHits[k];
  }
  const parity = even + odd > 0 ? (odd - even) / (odd + even) : 0; // > 0: backbeat on odd beats

  // 3. the first beat with a solid low hit
  const sortedLow = Float32Array.from(lowHits).sort();
  const typicalKick = sortedLow[Math.floor(sortedLow.length * 0.75)];
  if (typicalKick > 0) {
    for (let k = 0; k < beats; k++) {
      if (lowHits[k] >= 0.6 * typicalKick) {
        firstKick = k;
        break;
      }
    }
  }

  const scores = [0, 0, 0, 0];
  for (let c = 0; c < BEATS_PER_BAR; c++) {
    scores[c] = jumps[c] / maxJump;
    const backbeatOdd = c % 2 === 0; // downbeat on an even beat puts beats 2 and 4 on odd ones
    const agrees = parity > 0 === backbeatOdd;
    scores[c] += (agrees ? 0.5 : -0.5) * clamp01(Math.abs(parity) / 0.3);
    if (firstKick >= 0 && firstKick % BEATS_PER_BAR === c) scores[c] += 0.25;
  }
  let index = 0;
  for (let c = 1; c < BEATS_PER_BAR; c++) if (scores[c] > scores[index]) index = c;
  return { index, scores };
}

const NO_GRID: GridResult = {
  grid: { bpm: 120, firstBeatSec: 0 },
  confidence: 0,
  details: {
    fittedBpm: 120,
    snapped: false,
    octave: 'none',
    octaveReason: 'no onsets found',
    sharpness: 1,
    phaseSpreadMs: 0,
    downbeatScores: [0, 0, 0, 0],
  },
};

export interface GridHint {
  /** search only near this tempo (±4 %): the player's tap tempo or a ½× / 2× correction */
  bpm: number;
}

/** Detect the beat grid from the onset strength (and band power, for the downbeat). */
export function detectGridFromOnsets(on: OnsetStrength, bands: BandPower, hint?: GridHint): GridResult {
  const ev = collectEvents(on);
  const eventCount = ev.time.low.length + ev.time.mid.length + ev.time.high.length;
  if (eventCount < 16 || ev.durationSec < 2) return NO_GRID;

  let period: number;
  let nb: number;
  let octave: GridDetails['octave'] = 'none';
  let octaveReason = 'only one tempo in range';
  if (hint && hint.bpm > 0) {
    const fit = refinePeriod(ev, 60 / hint.bpm, 0.04);
    period = fit.period;
    nb = fit.bins;
    octaveReason = 'tempo given';
  } else {
    const coarse = coarsePeriod(on);
    if (!coarse) return NO_GRID;
    const fit = refinePeriod(ev, coarse.period, 0.015);
    period = fit.period;
    nb = fit.bins;
    const minPeriod = 60 / (MAX_BPM * 1.012);
    const maxPeriod = 60 / (MIN_BPM / 1.012);
    let fast = 0;
    if (period / 2 >= minPeriod) fast = period / 2;
    else if (period * 2 <= maxPeriod) fast = period;
    if (fast > 0) {
      const decision = chooseOctave(ev, bands, coarse, fast);
      octave = decision.choice;
      octaveReason = decision.reason;
      const chosen = decision.choice === 'fast' ? fast : fast * 2;
      nb = Math.max(8, Math.round((nb * chosen) / period));
      period = chosen;
    }
  }
  const fittedBpm = 60 / period;
  const snap = snapPeriod(ev, period, nb);
  period = snap.period;

  const { phase, profile } = beatPhase(ev, period);
  const downbeat = chooseDownbeat(ev, bands, period, phase);
  const barSec = period * BEATS_PER_BAR;
  let firstBeatSec = (phase + downbeat.index * period) % barSec;
  // a downbeat a few milliseconds before the file starts is the file's first sample
  if (barSec - firstBeatSec < 0.008) firstBeatSec = 0;

  // confidence: how sharply the onsets fold onto the beat, and how steady the phase stays
  const bins = new Float64Array(profile.length);
  const score = foldScore(ev, period, bins);
  // the same onsets folded on periods that cannot be right: what "no beat" looks like for this track
  const off = (foldScore(ev, period * 1.0137, bins) + foldScore(ev, period * 0.9871, bins)) / 2;
  const sharpness = off > 0 ? score / off : 1;
  const spread = phaseSpread(ev, period, profile);
  let confidence = smoothstep(1.1, 4, sharpness) * (1 - smoothstep(0.004, 0.025, spread));
  // a tempo picked by preference, or a downbeat that barely beat its runner-up, is a guess
  if (octave !== 'none' && octaveReason.startsWith('no steady pulse')) confidence *= 0.85;
  const ranked = [...downbeat.scores].sort((a, b) => b - a);
  if (ranked[1] > 0.85 * ranked[0]) confidence *= 0.9;

  return {
    grid: { bpm: 60 / period, firstBeatSec },
    confidence: clamp01(confidence),
    details: {
      fittedBpm,
      snapped: snap.snapped,
      octave,
      octaveReason,
      sharpness,
      phaseSpreadMs: spread * 1000,
      downbeatScores: downbeat.scores,
    },
  };
}
