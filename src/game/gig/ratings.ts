/** Pure rating maths for every mission. No engine, no state: everything here is unit-tested. */
import type { Difficulty, MissionKind, MissionRating } from '../../core/types';
import { TEXT } from './text';
import { TUNING } from './tuning';
import type { TimingWindow } from './tuning';

export interface Rated {
  rating: MissionRating;
  label: string;
  /** points on top of the rated share (bass swap) */
  bonus?: number;
}

/** Rating from a timing error in ms (sign ignored). Being there at all is always worth an OK. */
export function rateTiming(errorMs: number, w: TimingWindow): MissionRating {
  const e = Math.abs(errorMs);
  if (e <= w.perfectMs) return 'perfect';
  if (e <= w.greatMs) return 'great';
  return 'ok';
}

/** Points for a mission worth `base` at a perfect rating. */
export function pointsFor(base: number, rating: MissionRating, bonus = 0): number {
  return Math.round(base * TUNING.points.rating[rating]) + (rating === 'fail' ? 0 : Math.round(bonus));
}

export const missionPoints = (kind: MissionKind): number => TUNING.points.mission[kind];

/**
 * START DECK: `offsetMs` is the distance from the press to the old deck's nearest bar line
 * (negative = the bar line was still ahead, the press was early). null = there was no beat to hit.
 */
export function rateStartDeck(offsetMs: number | null, difficulty: Difficulty): Rated {
  if (offsetMs === null) return { rating: 'ok', label: TEXT.startDeck.started };
  const rating = rateTiming(offsetMs, TUNING.transition.startTiming[difficulty]);
  if (rating === 'perfect') return { rating, label: TEXT.startDeck.perfect };
  if (rating === 'great') return { rating, label: TEXT.startDeck.great };
  return { rating, label: offsetMs < 0 ? TEXT.startDeck.early : TEXT.startDeck.late };
}

/**
 * BEATMATCH: matching by hand is worth everything; SYNC is what chill asks for (full marks) and a
 * shortcut on club / festival (OK). `instant` = the decks were already together.
 */
export function rateBeatmatch(o: { usedSync: boolean; syncAsked: boolean; instant: boolean }): Rated {
  if (o.usedSync) {
    return o.syncAsked
      ? { rating: 'perfect', label: TEXT.beatmatch.inSync }
      : { rating: 'ok', label: TEXT.beatmatch.usedSync };
  }
  return { rating: 'perfect', label: o.instant ? TEXT.beatmatch.lockedIn : TEXT.beatmatch.byHand };
}

const demote = (r: MissionRating): MissionRating => (r === 'perfect' ? 'great' : 'ok');

/**
 * CROSSFADE: `blendBeats` is how long the crossfader took between the two travel marks
 * (null = it was never seen moving through them, e.g. it jumped). A blend wants a few bars; a cut
 * (tracks that cannot be beatmatched) wants to be quick. A trainwreck during it costs one step,
 * a bass swap adds a bonus.
 */
export function rateCrossfade(o: {
  blendBeats: number | null;
  cut: boolean;
  trainwrecked: boolean;
  bassSwap: boolean;
}): Rated {
  const f = TUNING.transition.fade;
  const beats = o.blendBeats ?? 0;
  let rating: MissionRating;
  let label: string;
  if (o.cut) {
    rating = beats <= f.cutPerfectBeats ? 'perfect' : beats <= f.cutGreatBeats ? 'great' : 'ok';
    label = rating === 'perfect' ? TEXT.crossfade.cutPerfect : rating === 'great' ? TEXT.crossfade.cutGreat : TEXT.crossfade.cutSlow;
  } else {
    rating = beats >= f.perfectBeats ? 'perfect' : beats >= f.greatBeats ? 'great' : 'ok';
    label = rating === 'perfect' ? TEXT.crossfade.perfect : rating === 'great' ? TEXT.crossfade.great : TEXT.crossfade.quick;
  }
  if (o.trainwrecked) {
    return { rating: demote(rating), label: TEXT.crossfade.trainwreck };
  }
  if (o.bassSwap && !o.cut) return { rating, label: TEXT.crossfade.bassSwap, bonus: TUNING.points.bassSwapBonus };
  return { rating, label };
}

/** BASS DROP: `errorMs` = when the bass came back relative to the drop's downbeat (negative = early). */
export function rateBassDrop(errorMs: number, difficulty: Difficulty): Rated {
  const rating = rateTiming(errorMs, TUNING.tricks.bassDrop.timing[difficulty]);
  if (rating === 'perfect') return { rating, label: TEXT.bassDrop.perfect };
  if (rating === 'great') return { rating, label: TEXT.bassDrop.great };
  return { rating, label: errorMs < 0 ? TEXT.bassDrop.early : TEXT.bassDrop.late };
}

/** FILTER SWEEP: a slow sweep out and back beats a flick. */
export function rateFilterSweep(sweepBeats: number): Rated {
  const f = TUNING.tricks.filterSweep;
  if (sweepBeats >= f.perfectBeats) return { rating: 'perfect', label: TEXT.filterSweep.perfect };
  if (sweepBeats >= f.greatBeats) return { rating: 'great', label: TEXT.filterSweep.great };
  return { rating: 'ok', label: TEXT.filterSweep.quick };
}

/** SCRATCH: brisk strokes, first to last. */
export function rateScratch(beatsTaken: number): Rated {
  const s = TUNING.tricks.scratch;
  if (beatsTaken <= s.perfectBeats) return { rating: 'perfect', label: TEXT.scratch.perfect };
  if (beatsTaken <= s.greatBeats) return { rating: 'great', label: TEXT.scratch.great };
  return { rating: 'ok', label: TEXT.scratch.ok };
}

/** ECHO OUT: `echoAgoBeats` = how long before the stop ECHO was last on (0 = still on, null = never). */
export function rateEchoOut(echoAgoBeats: number | null): Rated {
  if (echoAgoBeats === null || echoAgoBeats > TUNING.tricks.echoOut.memoryBeats) {
    return { rating: 'ok', label: TEXT.echoOut.noEcho };
  }
  if (echoAgoBeats <= 0) return { rating: 'perfect', label: TEXT.echoOut.perfect };
  return { rating: 'great', label: TEXT.echoOut.great };
}
