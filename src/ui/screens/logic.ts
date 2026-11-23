/**
 * The menus' pure logic: setlist advice, tap-along calibration maths, beat-grid editing and the
 * small formatters. No DOM in here, so all of it is unit-tested (logic.test.ts).
 */
import { BEATS_PER_BAR } from '../../core/types';
import type {
  BeatGrid,
  Difficulty,
  GameParams,
  GigResults,
  ImportErrorCode,
  Settings,
  TrackMeta,
} from '../../core/types';
import { fract } from '../../core/math';

// ───────────────────────────── setlist ─────────────────────────────

/** Two neighbours further apart than this cannot be brought to the same speed (tempo fader is ±8 %). */
export const MAX_TEMPO_GAP = 0.08;
export const SETLIST_MIN = 2;
export const SETLIST_MAX = 4;

/** How far apart two tempos are, as a fraction of the slower one (0.05 = 5 %). */
export function tempoGap(bpmA: number, bpmB: number): number {
  if (!(bpmA > 0) || !(bpmB > 0)) return 0;
  return Math.max(bpmA, bpmB) / Math.min(bpmA, bpmB) - 1;
}

export const tooFarApart = (bpmA: number, bpmB: number): boolean => tempoGap(bpmA, bpmB) > MAX_TEMPO_GAP + 1e-9;

export interface SetlistIssue {
  /** index of the first track of the pair in the setlist */
  index: number;
  from: TrackMeta;
  to: TrackMeta;
  /** tempoGap of the pair */
  gap: number;
}

/** Every pair of neighbours in the set whose tempos are too far apart to beatmatch. */
export function setlistIssues(tracks: TrackMeta[]): SetlistIssue[] {
  const out: SetlistIssue[] = [];
  for (let i = 0; i + 1 < tracks.length; i++) {
    const from = tracks[i];
    const to = tracks[i + 1];
    const gap = tempoGap(from.grid.bpm, to.grid.bpm);
    if (gap > MAX_TEMPO_GAP + 1e-9) out.push({ index: i, from, to, gap });
  }
  return out;
}

/**
 * A good default set: `size` tracks whose tempos sit closest together, played from the slowest to
 * the fastest so the energy builds. Built-in tracks are preferred (their beat grids are exact);
 * the player's own tracks are only used when there are not enough built-in ones.
 */
export function recommendSetlist(tracks: TrackMeta[], size = 3): string[] {
  const builtin = tracks.filter((t) => t.source === 'builtin');
  const pool = builtin.length >= SETLIST_MIN ? builtin : tracks;
  const n = Math.min(Math.max(size, SETLIST_MIN), SETLIST_MAX, pool.length);
  if (n < SETLIST_MIN) return pool.map((t) => t.id);

  // sort by tempo (stable: library order breaks ties), then take the tightest window of n
  const sorted = pool.map((t, i) => ({ t, i })).sort((a, b) => a.t.grid.bpm - b.t.grid.bpm || a.i - b.i);
  let best = 0;
  let bestRange = Infinity;
  for (let s = 0; s + n <= sorted.length; s++) {
    const range = sorted[s + n - 1].t.grid.bpm - sorted[s].t.grid.bpm;
    if (range < bestRange - 1e-9) {
      bestRange = range;
      best = s;
    }
  }
  return sorted.slice(best, best + n).map((x) => x.t.id);
}

// ───────────────────────────── calibration ─────────────────────────────

export type TapQuality = 'steady' | 'good' | 'uneven' | 'poor';

export interface TapAnalysis {
  /** median of (tap − click it belongs to), in ms. This is the sound delay. */
  latencyMs: number;
  /** robust spread of the taps (1.4826 × median absolute deviation), in ms */
  spreadMs: number;
  /** the offset of every tap that was used, in ms, in tap order */
  offsetsMs: number[];
  /** taps ignored at the start (the player is still finding the beat) */
  dropped: number;
  quality: TapQuality;
}

export interface TapAnalysisOptions {
  /** taps to ignore at the start (default 4) */
  warmup?: number;
  /**
   * How early a tap may be and still belong to the click after it, as a fraction of the period
   * (default 0.2). People anticipate a steady click by a few tens of ms at most, while Bluetooth
   * can be hundreds of ms late, so the window is deliberately lopsided: with a 600 ms click it
   * accepts delays from −120 ms to +480 ms instead of ±300 ms.
   */
  early?: number;
}

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Work out the sound delay from a tap-along. Times are in seconds on one clock (AudioContext
 * time): `tapTimesSec` are the taps, clicks were scheduled at firstClickSec + k × periodSec.
 * Returns null when there are too few taps left after the warm-up to say anything.
 */
export function analyseTaps(
  tapTimesSec: number[],
  firstClickSec: number,
  periodSec: number,
  opts: TapAnalysisOptions = {},
): TapAnalysis | null {
  const warmup = Math.max(0, opts.warmup ?? 4);
  const early = opts.early ?? 0.2;
  const taps = tapTimesSec.slice(warmup);
  if (taps.length < 3 || !(periodSec > 0)) return null;

  // phase of every tap inside the click period, 0..1
  const phases = taps.map((t) => fract((t - firstClickSec) / periodSec));

  // circular mean: where the taps cluster, even when the cluster straddles the wrap-around
  let sx = 0;
  let sy = 0;
  for (const p of phases) {
    sx += Math.cos(p * Math.PI * 2);
    sy += Math.sin(p * Math.PI * 2);
  }
  const centre = fract(Math.atan2(sy, sx) / (Math.PI * 2));

  // every tap relative to the cluster centre, -0.5..0.5
  const rel = phases.map((p) => {
    const d = fract(p - centre);
    return d >= 0.5 ? d - 1 : d;
  });
  const relMedian = median(rel);

  // the delay as a phase, moved into the window [-early, 1 - early)
  let delay = fract(centre + relMedian);
  if (delay >= 1 - early) delay -= 1;

  const spread = 1.4826 * median(rel.map((d) => Math.abs(d - relMedian)));
  const spreadMs = spread * periodSec * 1000;

  return {
    latencyMs: delay * periodSec * 1000,
    spreadMs,
    offsetsMs: rel.map((d) => (delay + (d - relMedian)) * periodSec * 1000),
    dropped: Math.min(warmup, tapTimesSec.length),
    quality: spreadMs < 18 ? 'steady' : spreadMs < 35 ? 'good' : spreadMs < 60 ? 'uneven' : 'poor',
  };
}

/** The value we store: whole milliseconds, never negative (sound cannot arrive early), capped at half a second. */
export const clampLatencyMs = (ms: number): number => Math.round(Math.min(500, Math.max(0, ms)));

// ───────────────────────────── beat grid editing ─────────────────────────────

export const BPM_MIN = 50;
export const BPM_MAX = 220;

const cleanBpm = (bpm: number): number => Math.round(bpm * 100) / 100;

/** ½× / 2×: change the tempo by a factor, keeping the first downbeat where it is. No-op when out of range. */
export function scaleGrid(grid: BeatGrid, factor: number): BeatGrid {
  const bpm = cleanBpm(grid.bpm * factor);
  if (bpm < BPM_MIN || bpm > BPM_MAX) return grid;
  return { bpm, firstBeatSec: grid.firstBeatSec };
}

export const canScaleGrid = (grid: BeatGrid, factor: number): boolean => scaleGrid(grid, factor) !== grid;

/** Fine tempo change in BPM (clamped to the supported range). */
export function adjustBpm(grid: BeatGrid, deltaBpm: number): BeatGrid {
  const bpm = cleanBpm(Math.min(BPM_MAX, Math.max(BPM_MIN, grid.bpm + deltaBpm)));
  return { bpm, firstBeatSec: grid.firstBeatSec };
}

/**
 * Slide the whole grid earlier (negative) or later (positive). The first downbeat never goes
 * before the start of the track: it wraps forward by one bar instead, which keeps every line
 * where the player put it.
 */
export function nudgeGrid(grid: BeatGrid, deltaSec: number): BeatGrid {
  const barLen = (BEATS_PER_BAR * 60) / grid.bpm;
  let first = grid.firstBeatSec + deltaSec;
  while (first < 0) first += barLen;
  return { bpm: grid.bpm, firstBeatSec: Math.round(first * 10000) / 10000 };
}

/**
 * Move "the 1" (the first beat of the bar) by whole beats, cycling through the four beats that
 * follow `anchorSec` (where the grid started when editing began) so it never wanders off into the
 * track.
 */
export function shiftDownbeat(grid: BeatGrid, beats: number, anchorSec: number): BeatGrid {
  const beatLen = 60 / grid.bpm;
  const rel = (grid.firstBeatSec - anchorSec) / beatLen;
  const whole = Math.round(rel);
  const sub = rel - whole; // the fine nudge, kept as it is
  const k = (((whole + beats) % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR;
  let first = anchorSec + (k + sub) * beatLen;
  while (first < 0) first += beatLen * BEATS_PER_BAR;
  return { bpm: grid.bpm, firstBeatSec: Math.round(first * 10000) / 10000 };
}

export interface TapFit {
  /** tempo of the taps */
  bpm: number;
  /** track time of the first tap according to the fitted line */
  firstTapSec: number;
  /** beat index given to every tap (a skipped beat leaves a gap) */
  beats: number[];
}

/**
 * Fit a steady tempo to taps made along with the music. `positionsSec` are the track positions
 * (as heard) of the taps, in order. A missed tap is tolerated: intervals are counted in whole
 * beats of the typical interval. Returns null with fewer than 4 taps or a tempo out of range.
 */
export function fitTaps(positionsSec: number[]): TapFit | null {
  const n = positionsSec.length;
  if (n < 4) return null;
  const intervals: number[] = [];
  for (let i = 1; i < n; i++) intervals.push(positionsSec[i] - positionsSec[i - 1]);
  const typical = median(intervals);
  if (!(typical > 0)) return null;

  const beats: number[] = [0];
  for (let i = 1; i < n; i++) beats.push(beats[i - 1] + Math.max(1, Math.round(intervals[i - 1] / typical)));

  // least squares: position = firstTap + beat × beatLen
  let sb = 0;
  let sp = 0;
  for (let i = 0; i < n; i++) {
    sb += beats[i];
    sp += positionsSec[i];
  }
  const mb = sb / n;
  const mp = sp / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (beats[i] - mb) * (positionsSec[i] - mp);
    den += (beats[i] - mb) * (beats[i] - mb);
  }
  if (den === 0) return null;
  const beatLen = num / den;
  if (!(beatLen > 0)) return null;
  const bpm = 60 / beatLen;
  if (bpm < BPM_MIN || bpm > BPM_MAX) return null;
  return { bpm, firstTapSec: mp - mb * beatLen, beats };
}

/**
 * Tapping is only good to a percent or so. When the tapped tempo is close to the detected tempo
 * (or to the usual ways detection goes wrong: half, double, 2/3, 3/2), trust the detected number;
 * otherwise round the tapped tempo to something sensible.
 */
export function snapTappedBpm(tapped: number, detected: number | null): number {
  if (detected && detected > 0) {
    for (const f of [1, 0.5, 2, 2 / 3, 1.5]) {
      const cand = detected * f;
      if (cand >= BPM_MIN && cand <= BPM_MAX && Math.abs(tapped / cand - 1) <= 0.03) return cleanBpm(cand);
    }
  }
  const whole = Math.round(tapped);
  return Math.abs(tapped - whole) <= 0.35 ? whole : Math.round(tapped * 10) / 10;
}

/**
 * The grid that follows a tap-along: tempo from the taps (snapped), beat lines through the taps,
 * and the downbeat kept as close as possible to where it was.
 */
export function gridFromTaps(positionsSec: number[], current: BeatGrid, detectedBpm: number | null): BeatGrid | null {
  const fit = fitTaps(positionsSec);
  if (!fit) return null;
  const bpm = snapTappedBpm(fit.bpm, detectedBpm);
  const beatLen = 60 / bpm;
  // with the tempo fixed, the best phase is the mean of what every tap says
  let sum = 0;
  for (let i = 0; i < positionsSec.length; i++) sum += positionsSec[i] - fit.beats[i] * beatLen;
  const tap0 = sum / positionsSec.length;
  // the beat line nearest to the current first downbeat
  let first = tap0 + Math.round((current.firstBeatSec - tap0) / beatLen) * beatLen;
  while (first < 0) first += beatLen;
  return { bpm, firstBeatSec: Math.round(first * 10000) / 10000 };
}

export const sameGrid = (a: BeatGrid, b: BeatGrid): boolean =>
  Math.abs(a.bpm - b.bpm) < 0.005 && Math.abs(a.firstBeatSec - b.firstBeatSec) < 0.0005;

// ───────────────────────────── words ─────────────────────────────

export interface ConfidenceInfo {
  /** 1 (a guess) .. 4 (very sure) */
  level: 1 | 2 | 3 | 4;
  label: string;
  /** what the player should do about it */
  advice: string;
}

/** Turn the detector's 0..1 confidence into words. Unknown confidence reads as "have a listen". */
export function confidenceInfo(confidence: number | undefined): ConfidenceInfo {
  const c = confidence ?? 0.5;
  if (c >= 0.8) return { level: 4, label: 'Very sure', advice: 'Have a quick listen to be safe.' };
  if (c >= 0.6) return { level: 3, label: 'Fairly sure', advice: 'Have a listen: the clicks should land on the beat.' };
  if (c >= 0.35) return { level: 2, label: 'Not sure', advice: 'Please check: the clicks should land on the beat.' };
  return { level: 1, label: 'Just a guess', advice: 'This one needs your help. Tap along to set the tempo.' };
}

export interface ImportErrorCopy {
  title: string;
  body: string;
}

/** Plain-words explanation for every way an import can fail. */
export function importErrorCopy(code: ImportErrorCode): ImportErrorCopy {
  switch (code) {
    case 'decode':
      return {
        title: "This file can't be opened",
        body: 'Songs saved inside Spotify, Apple Music, YouTube Music or Tidal are copy-protected and will not load. Use an MP3, WAV, M4A or FLAC file you own.',
      };
    case 'too-short':
      return {
        title: 'Too short to mix',
        body: 'There is not enough music in this file to DJ with. Pick a full song.',
      };
    case 'too-long':
      return {
        title: 'Too long for the decks',
        body: 'This looks like a whole mix or album. Pick a single song instead.',
      };
    case 'storage':
      return {
        title: 'No room to keep it',
        body: 'This device would not let the game save the song. Free up some space or delete a song you added earlier, then try again. Private browsing can also block saving.',
      };
    default:
      return {
        title: 'That did not work',
        body: 'Something went wrong while adding this file. Try again, or try another file.',
      };
  }
}

export const formatBpm = (bpm: number): string => {
  const r = Math.round(bpm * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
};

/** 48250 → "48,250" (same everywhere, whatever the device locale). */
export const formatScore = (n: number): string =>
  String(Math.max(0, Math.round(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export const formatPercent = (fraction: number): string => `${Math.round(fraction * 100)}%`;

export const DIFFICULTIES: readonly Difficulty[] = ['chill', 'club', 'festival'];

export const DIFFICULTY_COPY: Record<Difficulty, { name: string; line: string }> = {
  chill: { name: 'CHILL', line: 'Guided. SYNC matches the speed for you, and the crowd is forgiving.' },
  club: { name: 'CLUB', line: 'Match the speed by hand for bonus points.' },
  festival: { name: 'FESTIVAL', line: 'Dense notes and strict timing.' },
};

// ───────────────────────────── scores ─────────────────────────────

export interface BestScore {
  score: number;
  difficulty: Difficulty;
}

/** The player's highest score across the difficulties, or null before the first finished gig. */
export function bestOverall(best: Settings['best']): BestScore | null {
  let out: BestScore | null = null;
  for (const d of DIFFICULTIES) {
    const score = best[d];
    if (typeof score === 'number' && score > 0 && (!out || score > out.score)) out = { score, difficulty: d };
  }
  return out;
}

/** Only real, finished gigs count towards the best score (not the tutorial, not free play, not a walk-out). */
export const countsForBest = (results: GigResults, params: GameParams): boolean =>
  params.mode === 'gig' && !params.tutorial && results.completed && results.score > 0;

export function isNewBest(results: GigResults, params: GameParams, best: Settings['best']): boolean {
  if (!countsForBest(results, params)) return false;
  return results.score > (best[results.difficulty] ?? 0);
}

/** The first two built-in tracks: the guided tutorial always uses them. */
export function tutorialSetlist(tracks: TrackMeta[]): string[] {
  const builtin = tracks.filter((t) => t.source === 'builtin');
  return (builtin.length >= 2 ? builtin : tracks).slice(0, 2).map((t) => t.id);
}

export function tutorialParams(tracks: TrackMeta[]): GameParams {
  return { mode: 'gig', tutorial: true, difficulty: 'chill', setlist: tutorialSetlist(tracks) };
}
