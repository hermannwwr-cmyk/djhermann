/** Score, grade and stars. Pure. */
import { clamp01 } from '../../core/math';
import type { Grade } from '../../core/types';
import { TUNING } from './tuning';

export interface PerformanceInput {
  /** mission points earned / on offer (bonus points can push earned above available) */
  missionEarned: number;
  missionAvailable: number;
  /** RhythmStats.accuracy, and how many notes were judged at all */
  accuracy: number;
  judged: number;
  /** 0..1 average hype over the gig */
  hypeAvg: number;
}

/**
 * 0..1: how much of what was on offer the player took. Missions, note accuracy and average hype,
 * weighted; an ingredient that never came up (no missions issued, no notes judged) is left out.
 */
export function performance(i: PerformanceInput): number {
  const w = TUNING.grade.weights;
  let sum = w.hype * clamp01(i.hypeAvg);
  let weight = w.hype;
  if (i.missionAvailable > 0) {
    sum += w.missions * clamp01(i.missionEarned / i.missionAvailable);
    weight += w.missions;
  }
  if (i.judged > 0) {
    sum += w.accuracy * clamp01(i.accuracy);
    weight += w.accuracy;
  }
  return weight > 0 ? clamp01(sum / weight) : 0;
}

export function gradeFor(perf: number, completed: boolean): Grade {
  if (!completed) return 'D';
  const g = TUNING.grade;
  return perf >= g.S ? 'S' : perf >= g.A ? 'A' : perf >= g.B ? 'B' : perf >= g.C ? 'C' : 'D';
}

export function starsFor(perf: number, completed: boolean): number {
  let stars = 0;
  for (const t of TUNING.grade.stars) if (perf >= t) stars++;
  return completed ? stars : Math.min(stars, TUNING.grade.starsWhenLost);
}

/** Bonus for finishing the set, from the average hype. Nothing when the crowd left. */
export function finishBonus(hypeAvg: number, tracks: number, completed: boolean): number {
  return completed ? Math.round(clamp01(hypeAvg) * TUNING.points.finishPerTrack * Math.max(1, tracks)) : 0;
}
