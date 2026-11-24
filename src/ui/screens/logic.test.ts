import { describe, expect, it } from 'vitest';
import type { GameParams, GigResults, TrackMeta } from '../../core/types';
import { rng } from '../../core/math';
import {
  MAX_TEMPO_GAP,
  adjustBpm,
  analyseTaps,
  bestOverall,
  canScaleGrid,
  clampLatencyMs,
  confidenceInfo,
  countsForBest,
  fitTaps,
  formatBpm,
  formatScore,
  gridFromTaps,
  importErrorCopy,
  isNewBest,
  nudgeGrid,
  recommendSetlist,
  sameGrid,
  scaleGrid,
  setlistIssues,
  shiftDownbeat,
  snapTappedBpm,
  tempoGap,
  tooFarApart,
  tutorialParams,
} from './logic';

const track = (id: string, bpm: number, source: 'builtin' | 'user' = 'builtin'): TrackMeta => ({
  id,
  title: id,
  artist: 'x',
  source,
  durationSec: 180,
  grid: { bpm, firstBeatSec: 0.05 },
  key: null,
  sections: [],
  art: { hueA: 0, hueB: 0, seed: 1 },
});

describe('tempo gaps', () => {
  it('measures the gap relative to the slower track, in either order', () => {
    expect(tempoGap(100, 108)).toBeCloseTo(0.08, 10);
    expect(tempoGap(108, 100)).toBeCloseTo(0.08, 10);
    expect(tempoGap(120, 120)).toBe(0);
    expect(tempoGap(0, 120)).toBe(0);
  });

  it('allows exactly 8 % and warns beyond it', () => {
    expect(MAX_TEMPO_GAP).toBe(0.08);
    expect(tooFarApart(100, 108)).toBe(false);
    expect(tooFarApart(100, 108.2)).toBe(true);
    expect(tooFarApart(128, 118)).toBe(true); // 8.47 %
    expect(tooFarApart(122, 126)).toBe(false);
  });

  it('never passes a pair the tempo fader cannot reach', () => {
    // SYNC needs the incoming deck to run at prev/next, which must stay inside 0.92..1.08
    for (let prev = 80; prev <= 180; prev += 0.5) {
      for (let next = 80; next <= 180; next += 0.5) {
        const needed = prev / next;
        if (needed < 0.92 - 1e-9 || needed > 1.08 + 1e-9) expect(tooFarApart(prev, next)).toBe(true);
      }
    }
  });

  it('lists every bad neighbour pair with its position', () => {
    const set = [track('a', 120), track('b', 124), track('c', 140), track('d', 128)];
    const issues = setlistIssues(set);
    expect(issues.map((i) => i.index)).toEqual([1, 2]);
    expect(issues[0].from.id).toBe('b');
    expect(issues[0].to.id).toBe('c');
    expect(issues[0].gap).toBeCloseTo(140 / 124 - 1, 10);
    expect(setlistIssues([track('a', 120)])).toEqual([]);
    expect(setlistIssues([])).toEqual([]);
  });
});

describe('recommendSetlist', () => {
  const catalog = [track('golden', 122), track('lanterns', 124), track('coast', 126), track('bloom', 118), track('sky', 128)];

  it('picks the three closest tempos and orders them slow to fast', () => {
    expect(recommendSetlist(catalog)).toEqual(['golden', 'lanterns', 'coast']);
  });

  it('never recommends a set with a tempo warning when a clean one exists', () => {
    const ids = recommendSetlist([track('a', 90), track('b', 128), track('c', 150), track('d', 126), track('e', 124)]);
    expect(ids).toEqual(['e', 'd', 'b']);
    const metas = ids.map((id) => track(id, { e: 124, d: 126, b: 128 }[id as 'e' | 'd' | 'b']));
    expect(setlistIssues(metas)).toEqual([]);
  });

  it('prefers built-in tracks over the player’s own', () => {
    const tracks = [track('u1', 124, 'user'), track('u2', 124, 'user'), ...catalog];
    expect(recommendSetlist(tracks)).toEqual(['golden', 'lanterns', 'coast']);
  });

  it('falls back to all tracks when there are not enough built-in ones', () => {
    expect(recommendSetlist([track('only', 120), track('mine', 121, 'user'), track('mine2', 140, 'user')], 3)).toEqual([
      'only',
      'mine',
      'mine2',
    ]);
  });

  it('copes with tiny libraries and respects the size limits', () => {
    expect(recommendSetlist([])).toEqual([]);
    expect(recommendSetlist([track('a', 120)])).toEqual(['a']);
    expect(recommendSetlist([track('a', 120), track('b', 121)])).toEqual(['a', 'b']);
    expect(recommendSetlist(catalog, 2)).toHaveLength(2);
    expect(recommendSetlist(catalog, 9)).toHaveLength(4);
  });

  it('keeps library order when tempos tie', () => {
    expect(recommendSetlist([track('x', 124), track('y', 124), track('z', 124)])).toEqual(['x', 'y', 'z']);
  });
});

describe('analyseTaps', () => {
  const period = 0.6;
  const t0 = 10;
  /** taps at click + delay + jitter, one per click */
  const taps = (delayMs: number, jitterMs: number, count = 16, seed = 7): number[] => {
    const rand = rng(seed);
    return Array.from({ length: count }, (_, k) => t0 + k * period + delayMs / 1000 + ((rand() - 0.5) * 2 * jitterMs) / 1000);
  };

  it('recovers a plain delay', () => {
    const a = analyseTaps(taps(85, 0), t0, period)!;
    expect(a.latencyMs).toBeCloseTo(85, 6);
    expect(a.spreadMs).toBeCloseTo(0, 6);
    expect(a.quality).toBe('steady');
    expect(a.dropped).toBe(4);
    expect(a.offsetsMs).toHaveLength(12);
    for (const o of a.offsetsMs) expect(o).toBeCloseTo(85, 6);
  });

  it('is within a few ms with human jitter', () => {
    const a = analyseTaps(taps(140, 25), t0, period)!;
    expect(Math.abs(a.latencyMs - 140)).toBeLessThan(12);
    expect(a.spreadMs).toBeGreaterThan(5);
    expect(a.spreadMs).toBeLessThan(40);
  });

  it('keeps a slightly early tapper negative instead of wrapping to a huge delay', () => {
    const a = analyseTaps(taps(-30, 8), t0, period)!;
    expect(Math.abs(a.latencyMs + 30)).toBeLessThan(8);
  });

  it('resolves a large Bluetooth delay beyond half a period', () => {
    // "nearest click" would call 420 ms late "180 ms early"
    const a = analyseTaps(taps(420, 10), t0, period)!;
    expect(Math.abs(a.latencyMs - 420)).toBeLessThan(8);
  });

  it('handles a cluster that straddles the wrap-around', () => {
    // true delay sits right at a click (0 ms): some taps land just before it, some just after
    const a = analyseTaps(taps(0, 30), t0, period)!;
    expect(Math.abs(a.latencyMs)).toBeLessThan(12);
    for (const o of a.offsetsMs) expect(Math.abs(o)).toBeLessThan(45);
  });

  it('ignores wild taps (median, not mean)', () => {
    const list = taps(100, 4);
    list[7] += 0.25;
    list[11] -= 0.2;
    const a = analyseTaps(list, t0, period)!;
    expect(Math.abs(a.latencyMs - 100)).toBeLessThan(6);
  });

  it('drops the warm-up taps', () => {
    const list = taps(60, 0);
    // the first four are all over the place
    list[0] += 0.2;
    list[1] -= 0.15;
    list[2] += 0.1;
    list[3] += 0.27;
    const a = analyseTaps(list, t0, period)!;
    expect(a.latencyMs).toBeCloseTo(60, 6);
    expect(a.spreadMs).toBeCloseTo(0, 6);
  });

  it('does not need one tap per click', () => {
    const list = taps(75, 0).filter((_, i) => i % 3 !== 1);
    const a = analyseTaps(list, t0, period, { warmup: 2 })!;
    expect(a.latencyMs).toBeCloseTo(75, 6);
  });

  it('grades the consistency', () => {
    expect(analyseTaps(taps(80, 6), t0, period)!.quality).toBe('steady');
    expect(analyseTaps(taps(80, 150, 40), t0, period)!.quality).toBe('poor');
  });

  it('returns null without enough taps', () => {
    expect(analyseTaps(taps(80, 0, 6), t0, period)).toBeNull();
    expect(analyseTaps([], t0, period)).toBeNull();
    expect(analyseTaps(taps(80, 0), t0, 0)).toBeNull();
  });

  it('clamps what gets stored', () => {
    expect(clampLatencyMs(-12.4)).toBe(0);
    expect(clampLatencyMs(84.6)).toBe(85);
    expect(clampLatencyMs(900)).toBe(500);
  });
});

describe('beat grid editing', () => {
  const grid = { bpm: 120, firstBeatSec: 0.25 };

  it('halves and doubles the tempo without moving the first downbeat', () => {
    expect(scaleGrid(grid, 2)).toEqual({ bpm: 240 > 220 ? 120 : 240, firstBeatSec: 0.25 });
    expect(scaleGrid({ bpm: 87, firstBeatSec: 1 }, 2)).toEqual({ bpm: 174, firstBeatSec: 1 });
    expect(scaleGrid({ bpm: 174, firstBeatSec: 1 }, 0.5)).toEqual({ bpm: 87, firstBeatSec: 1 });
  });

  it('refuses to scale out of range', () => {
    expect(canScaleGrid(grid, 2)).toBe(false);
    expect(canScaleGrid(grid, 0.5)).toBe(true);
    expect(canScaleGrid({ bpm: 90, firstBeatSec: 0 }, 0.5)).toBe(false);
    const g = { bpm: 90, firstBeatSec: 0 };
    expect(scaleGrid(g, 0.5)).toBe(g);
  });

  it('adjusts the tempo finely and clamps it', () => {
    expect(adjustBpm(grid, 0.1).bpm).toBeCloseTo(120.1, 6);
    expect(adjustBpm(grid, -0.1).bpm).toBeCloseTo(119.9, 6);
    expect(adjustBpm({ bpm: 219.95, firstBeatSec: 0 }, 0.1).bpm).toBe(220);
    expect(adjustBpm({ bpm: 50, firstBeatSec: 0 }, -1).bpm).toBe(50);
  });

  it('nudges the grid and wraps by a bar instead of going negative', () => {
    expect(nudgeGrid(grid, 0.01).firstBeatSec).toBeCloseTo(0.26, 6);
    expect(nudgeGrid(grid, -0.01).firstBeatSec).toBeCloseTo(0.24, 6);
    // 120 bpm: a bar is 2 s. 0.25 - 0.3 = -0.05 → 1.95
    const wrapped = nudgeGrid(grid, -0.3);
    expect(wrapped.firstBeatSec).toBeCloseTo(1.95, 6);
    // the beat lines did not move relative to the audio
    const beatLen = 0.5;
    expect(((wrapped.firstBeatSec - (0.25 - 0.3)) / beatLen) % 4).toBeCloseTo(0, 6);
  });

  it('cycles the downbeat through four beats and comes back', () => {
    const anchor = grid.firstBeatSec;
    let g = grid;
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      g = shiftDownbeat(g, 1, anchor);
      seen.push(g.firstBeatSec);
    }
    expect(seen[0]).toBeCloseTo(0.75, 6);
    expect(seen[1]).toBeCloseTo(1.25, 6);
    expect(seen[2]).toBeCloseTo(1.75, 6);
    expect(seen[3]).toBeCloseTo(0.25, 6);
    expect(shiftDownbeat(grid, -1, anchor).firstBeatSec).toBeCloseTo(1.75, 6);
  });

  it('keeps a fine nudge when the downbeat moves', () => {
    const nudged = nudgeGrid(grid, 0.02); // 0.27
    const shifted = shiftDownbeat(nudged, 1, grid.firstBeatSec);
    expect(shifted.firstBeatSec).toBeCloseTo(0.77, 6);
  });

  it('compares grids with a tolerance', () => {
    expect(sameGrid(grid, { bpm: 120.001, firstBeatSec: 0.2502 })).toBe(true);
    expect(sameGrid(grid, { bpm: 120.1, firstBeatSec: 0.25 })).toBe(false);
    expect(sameGrid(grid, { bpm: 120, firstBeatSec: 0.26 })).toBe(false);
  });
});

describe('tap tempo', () => {
  const tapsAt = (bpm: number, first: number, count: number, jitterMs = 0, seed = 3): number[] => {
    const rand = rng(seed);
    return Array.from({ length: count }, (_, i) => first + (i * 60) / bpm + ((rand() - 0.5) * 2 * jitterMs) / 1000);
  };

  it('fits tempo and phase exactly from clean taps', () => {
    const fit = fitTaps(tapsAt(128, 3.2, 8))!;
    expect(fit.bpm).toBeCloseTo(128, 6);
    expect(fit.firstTapSec).toBeCloseTo(3.2, 6);
    expect(fit.beats).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('gets close with human jitter', () => {
    const fit = fitTaps(tapsAt(100, 1, 12, 20))!;
    expect(Math.abs(fit.bpm - 100)).toBeLessThan(1.5);
  });

  it('tolerates a missed tap', () => {
    const taps = tapsAt(120, 2, 10);
    taps.splice(4, 1);
    const fit = fitTaps(taps)!;
    expect(fit.bpm).toBeCloseTo(120, 6);
    expect(fit.beats).toEqual([0, 1, 2, 3, 5, 6, 7, 8, 9]);
  });

  it('needs four taps and a sane tempo', () => {
    expect(fitTaps(tapsAt(120, 0, 3))).toBeNull();
    expect(fitTaps(tapsAt(400, 0, 8))).toBeNull();
    expect(fitTaps([1, 1, 1, 1])).toBeNull();
  });

  it('snaps to the detected tempo and its usual mistakes', () => {
    expect(snapTappedBpm(123.1, 123.5)).toBe(123.5);
    expect(snapTappedBpm(61.2, 123.5)).toBe(61.75);
    expect(snapTappedBpm(171, 86)).toBe(172);
    expect(snapTappedBpm(129.5, 86)).toBe(129);
    expect(snapTappedBpm(87, 130.5)).toBe(87);
  });

  it('rounds a tempo it cannot relate to the detection', () => {
    expect(snapTappedBpm(99.8, 140)).toBe(100);
    expect(snapTappedBpm(99.52, 140)).toBe(99.5);
    expect(snapTappedBpm(104.27, null)).toBe(104);
    expect(snapTappedBpm(104.45, null)).toBe(104.5);
  });

  it('builds a grid through the taps, keeping the downbeat near where it was', () => {
    // the detector said 61.75 at 0.4 s; the song is really 123.5 with beats at 0.13 + k * beatLen
    const beatLen = 60 / 123.5;
    const taps = Array.from({ length: 8 }, (_, i) => 0.13 + (20 + i) * beatLen);
    const g = gridFromTaps(taps, { bpm: 61.75, firstBeatSec: 0.4 }, 61.75)!;
    expect(g.bpm).toBe(123.5);
    // a beat line of the true grid, and the one nearest to 0.4
    const k = (g.firstBeatSec - 0.13) / beatLen;
    expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-3);
    expect(Math.abs(g.firstBeatSec - 0.4)).toBeLessThanOrEqual(beatLen / 2 + 1e-6);
    expect(g.firstBeatSec).toBeGreaterThanOrEqual(0);
  });

  it('returns null when the taps make no tempo', () => {
    expect(gridFromTaps([1, 2], { bpm: 120, firstBeatSec: 0 }, 120)).toBeNull();
  });
});

describe('words and numbers', () => {
  it('turns detector confidence into words', () => {
    expect(confidenceInfo(0.95).level).toBe(4);
    expect(confidenceInfo(0.82).label).toBe('Very sure');
    expect(confidenceInfo(0.7).level).toBe(3);
    expect(confidenceInfo(0.4).level).toBe(2);
    expect(confidenceInfo(0.1).level).toBe(1);
    expect(confidenceInfo(undefined).level).toBe(2);
  });

  it('explains every import error, and names the protected services for decode errors', () => {
    const decode = importErrorCopy('decode');
    for (const name of ['Spotify', 'Apple Music', 'YouTube Music', 'Tidal']) expect(decode.body).toContain(name);
    for (const code of ['decode', 'too-short', 'too-long', 'storage', 'unknown'] as const) {
      const c = importErrorCopy(code);
      expect(c.title.length).toBeGreaterThan(3);
      expect(c.body.length).toBeGreaterThan(10);
    }
  });

  it('formats tempo and score', () => {
    expect(formatBpm(122)).toBe('122');
    expect(formatBpm(123.5)).toBe('123.5');
    expect(formatBpm(123.96)).toBe('124');
    expect(formatBpm(86.04)).toBe('86');
    expect(formatScore(0)).toBe('0');
    expect(formatScore(999)).toBe('999');
    expect(formatScore(48250)).toBe('48,250');
    expect(formatScore(1234567.4)).toBe('1,234,567');
    expect(formatScore(-5)).toBe('0');
  });
});

describe('best scores', () => {
  const results = (over: Partial<GigResults> = {}): GigResults => ({
    completed: true,
    score: 50000,
    grade: 'A',
    stars: 4,
    rhythm: { perfect: 1, great: 1, good: 1, miss: 1, combo: 0, maxCombo: 3, multiplier: 1, points: 10, accuracy: 0.8 },
    missions: [],
    hypeAvg: 0.6,
    hypePeak: 0.9,
    hypeHistory: [],
    trainwrecks: 0,
    deadAirSec: 0,
    setlist: [],
    difficulty: 'club',
    durationSec: 200,
    ...over,
  });
  const gig: GameParams = { mode: 'gig', setlist: ['a', 'b'], difficulty: 'club' };

  it('finds the highest score across difficulties', () => {
    expect(bestOverall({})).toBeNull();
    expect(bestOverall({ chill: 0 })).toBeNull();
    expect(bestOverall({ chill: 1200, festival: 800 })).toEqual({ score: 1200, difficulty: 'chill' });
    expect(bestOverall({ chill: 1200, club: 5000, festival: 800 })).toEqual({ score: 5000, difficulty: 'club' });
  });

  it('counts only finished, real gigs', () => {
    expect(countsForBest(results(), gig)).toBe(true);
    expect(countsForBest(results({ completed: false }), gig)).toBe(false);
    expect(countsForBest(results(), { ...gig, tutorial: true })).toBe(false);
    expect(countsForBest(results(), { ...gig, mode: 'free' })).toBe(false);
    expect(countsForBest(results({ score: 0 }), gig)).toBe(false);
  });

  it('compares against the best of the same difficulty', () => {
    expect(isNewBest(results(), gig, {})).toBe(true);
    expect(isNewBest(results(), gig, { club: 49999 })).toBe(true);
    expect(isNewBest(results(), gig, { club: 50000 })).toBe(false);
    expect(isNewBest(results(), gig, { chill: 90000 })).toBe(true);
    expect(isNewBest(results({ completed: false }), gig, {})).toBe(false);
  });

  it('builds the tutorial from the first two built-in tracks', () => {
    const tracks = [track('mine', 100, 'user'), track('one', 122), track('two', 124), track('three', 126)];
    expect(tutorialParams(tracks)).toEqual({ mode: 'gig', tutorial: true, difficulty: 'chill', setlist: ['one', 'two'] });
  });
});
