/**
 * Planning a track of the set: where it ends, where the next track comes in, and which trick
 * missions fit where. Pure functions of the track's metadata.
 */
import { sectionAtBeat, totalBars } from '../../core/beatgrid';
import { BEATS_PER_BAR, TEMPO_MAX, TEMPO_MIN } from '../../core/types';
import type { Difficulty, TrackMeta } from '../../core/types';
import { TUNING } from './tuning';

export type TrickKind = 'bass-drop' | 'filter-sweep' | 'scratch';

export interface PlannedTrick {
  kind: TrickKind;
  /** track beat at which the mission should appear */
  startBeat: number;
  /** … and the latest beat at which starting it still makes sense */
  latestStartBeat: number;
  /** track beat by which the mission is over at the latest */
  endBeat: number;
  /** bass-drop: the downbeat of the drop */
  targetBeat: number | null;
  used: boolean;
}

export interface TrackPlan {
  /** beat at which the music of the track is over (end of the last section) */
  endBeat: number;
  /** bar line on which the next deck should start; null on the last track */
  mixInBeat: number | null;
  /** beat at which START DECK appears; null on the last track */
  announceBeat: number | null;
  /** beat at which ECHO OUT appears; null unless this is the last track */
  finaleBeat: number | null;
  /** true when the next track cannot be brought to this one's speed: cut instead of blending */
  cut: boolean;
  tricks: PlannedTrick[];
}

/** Bar at which the track's music ends: the end of its last section, or of its beat grid. */
export function trackEndBar(meta: TrackMeta): number {
  const total = Math.max(1, totalBars(meta));
  let end = 0;
  for (const s of meta.sections) end = Math.max(end, s.startBar + s.bars);
  // sections that stop far short of the audio (or run past it) are not trusted
  if (end < total * 0.6 || end > total) return total;
  return end;
}

/**
 * Can a deck playing a track with native tempo `inBpm` be brought to `outBpm` with its tempo fader
 * (and so with SYNC)?
 */
export function canMatch(outBpm: number, inBpm: number): boolean {
  if (!(outBpm > 0) || !(inBpm > 0)) return false;
  const tempo = outBpm / inBpm;
  return tempo >= TEMPO_MIN - 1e-6 && tempo <= TEMPO_MAX + 1e-6;
}

/** Section energy at a beat, with a default where the track has no section there. */
export function energyAt(meta: TrackMeta, beat: number): number {
  return sectionAtBeat(meta, beat)?.energy ?? TUNING.density.defaultEnergy;
}

export interface PlanOptions {
  difficulty: Difficulty;
  /** the last track of the set: no transition, an echo-out finale instead */
  last: boolean;
  /** native tempo of the next track (ignored on the last track) */
  nextBpm?: number | null;
}

interface Candidate extends PlannedTrick {
  priority: number;
}

export function planTrack(meta: TrackMeta, o: PlanOptions): TrackPlan {
  const T = TUNING.transition;
  const K = TUNING.tricks;
  const endBar = trackEndBar(meta);
  const endBeat = endBar * BEATS_PER_BAR;

  let mixInBeat: number | null = null;
  let announceBeat: number | null = null;
  let finaleBeat: number | null = null;
  let cut = false;
  if (o.last) {
    finaleBeat = Math.max(0, endBeat - K.echoOut.bars * BEATS_PER_BAR);
  } else {
    cut = o.nextBpm != null && !canMatch(meta.grid.bpm, o.nextBpm);
    const wanted = cut ? T.cutOverlapBars : T.overlapBars;
    // short tracks: never give more than half the track to the overlap
    const half = Math.floor(endBar / 2 / 4) * 4;
    const overlap = Math.min(wanted, Math.max(T.minOverlapBars, half));
    mixInBeat = Math.max(1, endBar - overlap) * BEATS_PER_BAR;
    announceBeat = Math.max(0, mixInBeat - T.announceBeats);
  }

  // tricks must be over before the transition / the finale is announced
  const limit = (o.last ? finaleBeat! : announceBeat!) - K.clearBeforeMixBeats;
  const from = K.settleBeats;
  const cands: Candidate[] = [];
  const secs = [...meta.sections].sort((a, b) => a.startBar - b.startBar);

  secs.forEach((s, i) => {
    const start = s.startBar * BEATS_PER_BAR;
    const len = s.bars * BEATS_PER_BAR;
    const prev = i > 0 ? secs[i - 1] : null;
    if (s.kind === 'drop' && prev && (prev.kind === 'build' || prev.kind === 'break')) {
      cands.push({
        kind: 'bass-drop',
        priority: 0,
        startBeat: start - K.bassDrop.leadBeats,
        latestStartBeat: start - K.bassDrop.minLeadBeats,
        endBeat: start + K.bassDrop.lateBeats,
        targetBeat: start,
        used: false,
      });
    }
    if (s.kind === 'break' && len >= K.filterSweep.windowBeats) {
      cands.push({
        kind: 'filter-sweep',
        priority: 1,
        startBeat: start,
        latestStartBeat: start + K.filterSweep.lateStartBeats,
        endBeat: start + K.filterSweep.windowBeats,
        targetBeat: null,
        used: false,
      });
    }
    if (s.kind === 'build' && len >= K.filterSweep.windowBeats + K.bassDrop.leadBeats + 4) {
      cands.push({
        kind: 'filter-sweep',
        priority: 2,
        startBeat: start,
        latestStartBeat: start + K.filterSweep.lateStartBeats,
        endBeat: start + K.filterSweep.windowBeats,
        targetBeat: null,
        used: false,
      });
    }
    if ((s.kind === 'drop' || s.kind === 'groove') && len >= 32) {
      // in the middle of the section, on a bar line
      const at = start + Math.floor(s.bars / 2) * BEATS_PER_BAR;
      cands.push({
        kind: 'scratch',
        priority: s.kind === 'drop' ? 3 : 4,
        startBeat: at,
        latestStartBeat: at + K.scratch.lateStartBeats,
        endBeat: at + K.scratch.windowBeats,
        targetBeat: null,
        used: false,
      });
    }
  });

  const gap = K.minGapBeats[o.difficulty];
  const max = K.perTrack[o.difficulty];
  const maxScratches = K.scratchesPerTrack[o.difficulty];
  const chosen: Candidate[] = [];
  const fits = (c: PlannedTrick): boolean =>
    c.startBeat >= from &&
    c.endBeat <= limit &&
    chosen.every((x) => c.startBeat >= x.endBeat + gap || c.endBeat + gap <= x.startBeat);

  cands.sort((a, b) => a.priority - b.priority || a.startBeat - b.startBeat);
  for (const c of cands) {
    if (chosen.length >= max) break;
    if (c.kind === 'scratch' && chosen.filter((x) => x.kind === 'scratch').length >= maxScratches) continue;
    if (fits(c)) chosen.push(c);
  }

  // a track with no usable sections still gets something to do, if it is long enough
  if (chosen.length === 0 && limit - from >= 96) {
    const span = limit - from;
    const bar = (beat: number): number => Math.floor(beat / BEATS_PER_BAR) * BEATS_PER_BAR;
    const a = bar(from + span / 3);
    const b = bar(from + (span * 2) / 3);
    const generic: Candidate[] = [
      {
        kind: 'filter-sweep',
        priority: 0,
        startBeat: a,
        latestStartBeat: a + K.filterSweep.lateStartBeats,
        endBeat: a + K.filterSweep.windowBeats,
        targetBeat: null,
        used: false,
      },
      {
        kind: 'scratch',
        priority: 1,
        startBeat: b,
        latestStartBeat: b + K.scratch.lateStartBeats,
        endBeat: b + K.scratch.windowBeats,
        targetBeat: null,
        used: false,
      },
    ];
    for (const c of generic) if (fits(c)) chosen.push(c);
  }

  chosen.sort((a, b) => a.startBeat - b.startBeat);
  const tricks: PlannedTrick[] = chosen.map(({ priority: _p, ...t }) => t);
  return { endBeat, mixInBeat, announceBeat, finaleBeat, cut, tricks };
}

/** Seconds a track contributes to the set at its native tempo (up to its mix-in point, or its end). */
export function segmentBeats(plan: TrackPlan): number {
  return plan.mixInBeat ?? plan.endBeat;
}
