import { describe, expect, it } from 'vitest';
import {
  pointsFor,
  rateBassDrop,
  rateBeatmatch,
  rateCrossfade,
  rateEchoOut,
  rateFilterSweep,
  rateScratch,
  rateStartDeck,
  rateTiming,
} from './ratings';
import { finishBonus, gradeFor, performance, starsFor } from './results';
import { TUNING } from './tuning';

describe('timing ratings', () => {
  const w = { perfectMs: 50, greatMs: 120 };
  it('rates by the size of the error, either side', () => {
    expect(rateTiming(0, w)).toBe('perfect');
    expect(rateTiming(-50, w)).toBe('perfect');
    expect(rateTiming(51, w)).toBe('great');
    expect(rateTiming(-120, w)).toBe('great');
    expect(rateTiming(121, w)).toBe('ok');
    expect(rateTiming(5000, w)).toBe('ok');
  });

  it('START DECK: early and late are told apart, no beat to hit is an OK', () => {
    const win = TUNING.transition.startTiming.club;
    expect(rateStartDeck(10, 'club')).toMatchObject({ rating: 'perfect', label: 'ON THE ONE' });
    expect(rateStartDeck(-(win.perfectMs + 1), 'club')).toMatchObject({ rating: 'great' });
    expect(rateStartDeck(-(win.greatMs + 50), 'club')).toMatchObject({ rating: 'ok', label: 'A BIT EARLY' });
    expect(rateStartDeck(win.greatMs + 50, 'club')).toMatchObject({ rating: 'ok', label: 'A BIT LATE' });
    expect(rateStartDeck(null, 'club')).toMatchObject({ rating: 'ok' });
    // chill is more forgiving than festival
    const e = TUNING.transition.startTiming.festival.perfectMs + 5;
    expect(rateStartDeck(e, 'chill').rating).toBe('perfect');
    expect(rateStartDeck(e, 'festival').rating).toBe('great');
  });

  it('BASS DROP: rated by how close to the downbeat the bass came back', () => {
    const win = TUNING.tricks.bassDrop.timing.club;
    expect(rateBassDrop(0, 'club').rating).toBe('perfect');
    expect(rateBassDrop(win.perfectMs + 1, 'club').rating).toBe('great');
    expect(rateBassDrop(-(win.greatMs + 1), 'club')).toMatchObject({ rating: 'ok', label: 'TOO EARLY' });
    expect(rateBassDrop(win.greatMs + 1, 'club')).toMatchObject({ rating: 'ok', label: 'TOO LATE' });
  });
});

describe('mission ratings', () => {
  it('BEATMATCH: by hand is worth everything, SYNC only when it was asked for', () => {
    expect(rateBeatmatch({ usedSync: false, syncAsked: false, instant: false })).toMatchObject({
      rating: 'perfect',
      label: 'BY HAND',
    });
    expect(rateBeatmatch({ usedSync: true, syncAsked: true, instant: false }).rating).toBe('perfect');
    expect(rateBeatmatch({ usedSync: true, syncAsked: false, instant: false })).toMatchObject({
      rating: 'ok',
      label: 'USED SYNC',
    });
    expect(rateBeatmatch({ usedSync: false, syncAsked: false, instant: true }).label).toBe('LOCKED IN');
  });

  it('CROSSFADE: a few bars beats a snap, a bass swap adds a bonus, a trainwreck costs a step', () => {
    const f = TUNING.transition.fade;
    const base = { cut: false, trainwrecked: false, bassSwap: false };
    expect(rateCrossfade({ ...base, blendBeats: f.perfectBeats }).rating).toBe('perfect');
    expect(rateCrossfade({ ...base, blendBeats: f.greatBeats }).rating).toBe('great');
    expect(rateCrossfade({ ...base, blendBeats: 0.2 }).rating).toBe('ok');
    expect(rateCrossfade({ ...base, blendBeats: null }).rating).toBe('ok');
    const swap = rateCrossfade({ ...base, blendBeats: 8, bassSwap: true });
    expect(swap).toMatchObject({ rating: 'perfect', label: 'BASS SWAP', bonus: TUNING.points.bassSwapBonus });
    const wreck = rateCrossfade({ ...base, blendBeats: 8, bassSwap: true, trainwrecked: true });
    expect(wreck).toMatchObject({ rating: 'great', label: 'TRAINWRECK' });
    expect(wreck.bonus).toBeUndefined();
    expect(rateCrossfade({ ...base, blendBeats: 1, trainwrecked: true }).rating).toBe('ok');
  });

  it('CROSSFADE as a cut: quick is right', () => {
    const base = { cut: true, trainwrecked: false, bassSwap: true };
    expect(rateCrossfade({ ...base, blendBeats: 0.5 })).toMatchObject({ rating: 'perfect', label: 'CLEAN CUT' });
    expect(rateCrossfade({ ...base, blendBeats: null }).rating).toBe('perfect');
    expect(rateCrossfade({ ...base, blendBeats: 3 }).rating).toBe('great');
    expect(rateCrossfade({ ...base, blendBeats: 12 }).rating).toBe('ok');
    expect(rateCrossfade({ ...base, blendBeats: 0.5 }).bonus).toBeUndefined();
  });

  it('FILTER SWEEP, SCRATCH, ECHO OUT', () => {
    const fs = TUNING.tricks.filterSweep;
    expect(rateFilterSweep(fs.perfectBeats).rating).toBe('perfect');
    expect(rateFilterSweep(fs.greatBeats).rating).toBe('great');
    expect(rateFilterSweep(0.3).rating).toBe('ok');
    const sc = TUNING.tricks.scratch;
    expect(rateScratch(sc.perfectBeats).rating).toBe('perfect');
    expect(rateScratch(sc.greatBeats).rating).toBe('great');
    expect(rateScratch(sc.greatBeats + 1).rating).toBe('ok');
    expect(rateEchoOut(0).rating).toBe('perfect');
    expect(rateEchoOut(2).rating).toBe('great');
    expect(rateEchoOut(null)).toMatchObject({ rating: 'ok', label: 'NO ECHO' });
    expect(rateEchoOut(TUNING.tricks.echoOut.memoryBeats + 1).rating).toBe('ok');
  });

  it('points: share by rating, bonus only when not failed', () => {
    expect(pointsFor(1000, 'perfect')).toBe(1000);
    expect(pointsFor(1000, 'great')).toBe(700);
    expect(pointsFor(1000, 'ok')).toBe(400);
    expect(pointsFor(1000, 'fail', 500)).toBe(0);
    expect(pointsFor(1500, 'perfect', 500)).toBe(2000);
  });
});

describe('results maths', () => {
  it('performance weighs missions, accuracy and hype; missing ingredients are left out', () => {
    expect(performance({ missionEarned: 10, missionAvailable: 10, accuracy: 1, judged: 100, hypeAvg: 1 })).toBeCloseTo(1);
    expect(performance({ missionEarned: 0, missionAvailable: 10, accuracy: 0, judged: 100, hypeAvg: 0 })).toBe(0);
    // no notes judged: accuracy does not drag the grade down
    const noNotes = performance({ missionEarned: 10, missionAvailable: 10, accuracy: 1, judged: 0, hypeAvg: 1 });
    expect(noNotes).toBeCloseTo(1);
    // bonus points cannot push it above 1
    expect(performance({ missionEarned: 20, missionAvailable: 10, accuracy: 1, judged: 1, hypeAvg: 1 })).toBe(1);
    const w = TUNING.grade.weights;
    const half = performance({ missionEarned: 5, missionAvailable: 10, accuracy: 0.5, judged: 10, hypeAvg: 0.5 });
    expect(half).toBeCloseTo(0.5);
    const missionsOnly = performance({ missionEarned: 10, missionAvailable: 10, accuracy: 0, judged: 10, hypeAvg: 0 });
    expect(missionsOnly).toBeCloseTo(w.missions / (w.missions + w.accuracy + w.hype));
  });

  it('grades and stars climb with performance; losing the crowd caps them', () => {
    const g = TUNING.grade;
    expect(gradeFor(g.S, true)).toBe('S');
    expect(gradeFor(g.S - 0.001, true)).toBe('A');
    expect(gradeFor(g.A, true)).toBe('A');
    expect(gradeFor(g.B, true)).toBe('B');
    expect(gradeFor(g.C, true)).toBe('C');
    expect(gradeFor(g.C - 0.01, true)).toBe('D');
    expect(gradeFor(1, false)).toBe('D');
    expect(starsFor(1, true)).toBe(5);
    expect(starsFor(0, true)).toBe(0);
    expect(starsFor(g.stars[2], true)).toBe(3);
    expect(starsFor(1, false)).toBe(g.starsWhenLost);
    let last = -1;
    for (let p = 0; p <= 1.0001; p += 0.01) {
      const s = starsFor(p, true);
      expect(s).toBeGreaterThanOrEqual(last);
      last = s;
    }
  });

  it('finishing bonus follows average hype and the length of the set', () => {
    expect(finishBonus(1, 3, true)).toBe(3 * TUNING.points.finishPerTrack);
    expect(finishBonus(0.5, 2, true)).toBe(TUNING.points.finishPerTrack);
    expect(finishBonus(1, 3, false)).toBe(0);
  });
});
