/** Dead-air and trainwreck detectors: small state machines fed once per frame. */
import { TUNING } from './tuning';

export type Edge = 'start' | 'end' | null;

export interface DeadAirDetector {
  /** `sounding`: at least one deck can be heard right now */
  update(dtSec: number, sounding: boolean): Edge;
  readonly active: boolean;
  /** seconds since dead air was called (0 when not active) */
  readonly activeSec: number;
  /** total seconds of dead air so far, including the silence before each call */
  readonly totalSec: number;
  /** restart the "since it was called" timer (after a rescue attempt) */
  snooze(): void;
  reset(): void;
}

export function createDeadAirDetector(afterSec: number = TUNING.deadAir.afterSec): DeadAirDetector {
  let silent = 0;
  let active = false;
  let activeSec = 0;
  let total = 0;
  return {
    update(dtSec, sounding) {
      if (sounding) {
        silent = 0;
        if (active) {
          active = false;
          activeSec = 0;
          return 'end';
        }
        return null;
      }
      silent += dtSec;
      if (active) {
        activeSec += dtSec;
        total += dtSec;
        return null;
      }
      if (silent > afterSec) {
        active = true;
        activeSec = 0;
        total += silent;
        return 'start';
      }
      return null;
    },
    get active() {
      return active;
    },
    get activeSec() {
      return activeSec;
    },
    get totalSec() {
      return total;
    },
    snooze() {
      activeSec = 0;
    },
    reset() {
      silent = 0;
      active = false;
      activeSec = 0;
    },
  };
}

export interface TrainwreckInput {
  /** beats elapsed this frame */
  dtBeats: number;
  /** both decks are clearly audible and running */
  bothAudible: boolean;
  /** difference of the two effective tempos in BPM */
  bpmDiff: number;
  /** distance between the two decks' beats in ms */
  offsetMs: number;
  /** a deck has only just started: do not judge yet */
  grace: boolean;
}

export interface TrainwreckDetector {
  update(i: TrainwreckInput): Edge;
  readonly active: boolean;
  /** how many trainwrecks were called */
  readonly count: number;
  reset(): void;
}

/** True when two audible decks would clash. */
export const clashes = (bpmDiff: number, offsetMs: number): boolean =>
  Math.abs(bpmDiff) > TUNING.trainwreck.bpm || Math.abs(offsetMs) > TUNING.trainwreck.offsetMs;

export function createTrainwreckDetector(): TrainwreckDetector {
  const t = TUNING.trainwreck;
  let bad = 0;
  let good = 0;
  let active = false;
  let count = 0;
  return {
    update(i) {
      const clash = i.bothAudible && clashes(i.bpmDiff, i.offsetMs);
      if (!active) {
        if (!clash || i.grace) {
          bad = 0;
          return null;
        }
        bad += i.dtBeats;
        if (bad > t.afterBeats) {
          active = true;
          good = 0;
          count++;
          return 'start';
        }
        return null;
      }
      if (clash) {
        good = 0;
        return null;
      }
      good += i.dtBeats;
      // one deck gone = over at once; back in time = over after a moment
      if (!i.bothAudible || good >= t.clearBeats) {
        active = false;
        bad = 0;
        return 'end';
      }
      return null;
    },
    get active() {
      return active;
    },
    get count() {
      return count;
    },
    reset() {
      bad = 0;
      good = 0;
      active = false;
    },
  };
}
