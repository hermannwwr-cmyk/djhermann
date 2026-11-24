/**
 * Every number the gig director uses, in one place. Musical lengths are in beats (4 beats = 1 bar)
 * unless the name says otherwise; knob and fader values use the engine's ranges.
 */
import type { Difficulty, MissionKind, MissionRating } from '../../core/types';

export type TimingWindow = { perfectMs: number; greatMs: number };

export const TUNING = {
  // ───────────── crowd hype ─────────────
  hype: {
    start: 0.5,
    /** change per judged note that was hit */
    judge: { perfect: 0.012, great: 0.008, good: 0.003 },
    /** change per missed note */
    miss: { chill: -0.004, club: -0.006, festival: -0.008 } as Record<Difficulty, number>,
    /** misses cost nothing while a mission is on screen and for this many beats afterwards */
    missGraceBeats: 4,
    /** change when a mission ends */
    mission: { perfect: 0.1, great: 0.06, ok: 0.025, fail: -0.1 } as Record<MissionRating, number>,
    /** extra for a bass swap during the crossfade */
    bassSwap: 0.03,
    /** a drop landing while the mix is clean */
    drop: 0.04,
    /** drain per second while there is dead air / a trainwreck */
    deadAirPerSec: 0.1,
    trainwreckPerSec: 0.07,
    /** excitement fades: above `rest`, hype relaxes towards it with this half-life */
    rest: 0.5,
    fadeHalfLifeSec: 45,
    /** club + festival: the crowd walks out when hype stays at or below `leaveBelow` this long */
    leaveBelow: 0.02,
    leaveAfterSec: { chill: Infinity, club: 10, festival: 7 } as Record<Difficulty, number>,
    /** the "crowd is leaving" warning comes this long into that countdown */
    leaveWarnSec: 2.5,
  },

  // ───────────── trouble detectors ─────────────
  deadAir: {
    /** no deck heard for longer than this = dead air */
    afterSec: 1.5,
    /** chill + tutorial: this long after dead air was called, the game restarts the music itself */
    rescueAfterSec: 2.5,
    tutorialRescueAfterSec: 2,
    /** a record moving slower than this fraction of normal speed makes no sound */
    minRate: 0.1,
    /** all three EQ knobs at or below this = the channel is silent */
    eqSilent: 0.06,
    /** rescue: faders / crossfader gain below this get pushed back up */
    lowGain: 0.5,
  },
  trainwreck: {
    /** both decks must be at least this audible */
    audible: 0.25,
    /** tempos further apart than this clash (BPM) */
    bpm: 0.6,
    /** … or beats further apart than this (ms) */
    offsetMs: 70,
    /** the clash must last this long before it is called */
    afterBeats: 2,
    /** back in time for this long ends it */
    clearBeats: 1,
    /** no trainwreck this soon after a deck starts or a record is let go */
    graceBeats: 8,
  },

  // ───────────── the transition ─────────────
  transition: {
    /** the next track starts this many bars before the old one ends */
    overlapBars: 16,
    /** tracks whose speeds cannot be matched: start the next one this late and cut over */
    cutOverlapBars: 4,
    /** shortest overlap ever used (very short tracks) */
    minOverlapBars: 4,
    /** START DECK appears this many beats before the mix-in bar line: "get ready", then 4-3-2-1-NOW */
    announceBeats: 8,
    /** START DECK is rescued this many beats after the mix-in bar line (a bar line itself) */
    startWindowBeats: 8,
    /** PLAY press, distance from the old deck's bar line */
    startTiming: {
      chill: { perfectMs: 80, greatMs: 180 },
      club: { perfectMs: 60, greatMs: 140 },
      festival: { perfectMs: 45, greatMs: 110 },
    } as Record<Difficulty, TimingWindow>,
    /** the count shown in the hint runs this far ahead of the beat (reading time) */
    countLeadBeats: 0.12,
    match: {
      /** tempos count as matched within this (BPM) */
      bpm: 0.15,
      /** beats count as together within this (ms) */
      offsetMs: { chill: 60, club: 35, festival: 35 } as Record<Difficulty, number>,
      /** once matched, the beats may wander this much further before the count restarts */
      stayFactor: 1.25,
      /** matched for this many beats running = done */
      holdBeats: 4,
      deadlineBeats: { chill: 16, club: 24, festival: 20 } as Record<Difficulty, number>,
    },
    fade: {
      deadlineBeats: 24,
      /** crossfader travel (0 = old deck, 1 = new deck) that counts as "all the way" */
      doneAt: 0.975,
      /** the blend is timed between these two travel marks */
      lo: 0.15,
      hi: 0.85,
      /** blend length for PERFECT / GREAT (a steady two-bar slide gives 5.6) */
      perfectBeats: 5,
      greatBeats: 2,
      /** cut (unmatchable tracks): blend at most this long for PERFECT / GREAT */
      cutPerfectBeats: 2,
      cutGreatBeats: 4,
      /** bass swap: old deck's LOW at or below / new deck's LOW at or above, during the blend */
      bassSwapOldLow: 0.15,
      bassSwapNewLow: 0.4,
      /** the rescue crossfade takes this long */
      rescueBeats: 8,
      /** the new deck's volume fader must be at least this far up before the crossfade */
      minFader: 0.6,
    },
    stop: { deadlineBeats: 8 },
    /**
     * After the beatmatch the crossfade waits until the new track has played this many bars (its
     * intro), so both tracks really run together; never longer than `fadeWaitMaxBeats`.
     */
    fadeAtBars: 8,
    fadeWaitMaxBeats: 40,
    /** pause between two missions of a transition, so the result can be read */
    gapBeats: 1,
    /** the player mixed into the next deck unasked: take it over after this long */
    handoverBeats: 8,
    /** always leave this much of the old track after the rescue crossfade */
    endGuardBeats: 4,
    /** wait at most this long for a track that is still loading when it is needed */
    loadWaitSec: 20,
  },

  // ───────────── trick missions ─────────────
  tricks: {
    perTrack: { chill: 3, club: 4, festival: 6 } as Record<Difficulty, number>,
    /** breathing room between two tricks */
    minGapBeats: { chill: 16, club: 8, festival: 8 } as Record<Difficulty, number>,
    scratchesPerTrack: { chill: 1, club: 1, festival: 2 } as Record<Difficulty, number>,
    /** no trick this soon after the set starts or a transition ends */
    settleBeats: 8,
    /** a trick must be over this long before START DECK appears */
    clearBeforeMixBeats: 4,
    bassDrop: {
      /** the mission appears this long before the drop */
      leadBeats: 8,
      /** … and is skipped when less than this is left */
      minLeadBeats: 4,
      /** the bass may come back this late before the mission fails */
      lateBeats: 4,
      /** LOW at or below this = bass is out */
      cutBelow: 0.12,
      /** LOW back at or above this = bass is back */
      backAbove: 0.38,
      timing: {
        chill: { perfectMs: 110, greatMs: 240 },
        club: { perfectMs: 85, greatMs: 190 },
        festival: { perfectMs: 65, greatMs: 150 },
      } as Record<Difficulty, TimingWindow>,
    },
    filterSweep: {
      windowBeats: 16,
      /** a late start is fine up to this many beats into the section */
      lateStartBeats: 4,
      /** FILTER at least this far from the middle = "sounds dull" */
      depth: 0.6,
      /** FILTER within this of the middle = back in the middle */
      centre: 0.1,
      /** whole sweep (out and back) at least this long for PERFECT / GREAT */
      perfectBeats: 4,
      greatBeats: 2,
    },
    scratch: {
      windowBeats: 16,
      lateStartBeats: 8,
      /** strokes needed (one stroke = one push or one pull) */
      strokes: { chill: 4, club: 6, festival: 8 } as Record<Difficulty, number>,
      /** a stroke must move the record at least this far (seconds of track) */
      minStrokeSec: 0.04,
      /** first stroke to last within this for PERFECT / GREAT */
      perfectBeats: 6,
      greatBeats: 10,
      /** after the last stroke, wait this long for the record to be let go */
      letGoBeats: 4,
    },
    echoOut: {
      /** the mission covers the last bars of the last track */
      bars: 4,
      /** ECHO used this recently before the stop still counts (GREAT) */
      memoryBeats: 8,
      /** the game ends the set itself this close to the end of the track */
      guardBeats: 2,
    },
  },

  // ───────────── score and grade ─────────────
  /**
   * Scale: a note is worth 100 × the combo multiplier (up to ×4) in the playfield, so a perfect
   * transition (≈ 22 000 with the bass swap) is worth about 55 perfect notes at full combo, and
   * the missions make up roughly a third of a perfect score.
   */
  points: {
    mission: {
      'start-set': 500,
      'start-deck': 5000,
      beatmatch: 7500,
      crossfade: 7500,
      'stop-deck': 1500,
      'bass-drop': 6000,
      'filter-sweep': 4000,
      scratch: 4000,
      'echo-out': 5000,
    } as Record<MissionKind, number>,
    /** share of the points for each rating */
    rating: { perfect: 1, great: 0.7, ok: 0.4, fail: 0 } as Record<MissionRating, number>,
    bassSwapBonus: 2500,
    /** finishing bonus per track of the set, multiplied by the average hype */
    finishPerTrack: 10000,
  },
  grade: {
    /** how the three ingredients are weighed */
    weights: { missions: 0.4, accuracy: 0.35, hype: 0.25 },
    S: 0.9,
    A: 0.78,
    B: 0.64,
    C: 0.48,
    /** performance needed for 1..5 stars */
    stars: [0.3, 0.48, 0.64, 0.78, 0.9],
    /** stars at most when the crowd left */
    starsWhenLost: 1,
  },

  // ───────────── note density ─────────────
  density: {
    /** [quietest section, loudest section] */
    range: { chill: [0.25, 0.55], club: [0.4, 0.8], festival: [0.55, 1] } as Record<Difficulty, [number, number]>,
    /** notes stop this many beats before a planned mission, so the lanes are clear when it starts */
    quietBeats: 4,
    /** only tell the playfield when the density moved at least this much */
    step: 0.05,
    /** energy assumed where a track has no section information */
    defaultEnergy: 0.5,
  },

  // ───────────── start and end of the gig ─────────────
  end: {
    /** after the last track stops, wait this long before the results */
    tailSec: 1.5,
    /** stopping the last track by hand within this many bars of its end counts as the ending */
    finalStopBars: 8,
    /** hard stop: the gig never lasts longer than plannedSec × factor + extraSec */
    curfewFactor: 1.5,
    curfewExtraSec: 60,
  },
  status: {
    /** "MIX IN n BARS" appears when the mix is this close */
    mixSoonBars: 16,
    lastBars: 8,
  },
  /** a tip ("SYNC works too", "bonus: bass swap") replaces the hint for the last tipBeats of every cycle */
  hints: { tipCycleBeats: 8, tipBeats: 3 },
  /** tempo assumed for the gig clock before any deck has played */
  fallbackBpm: 120,
  /** a direct action by the director is recognised in the engine's events for this long (ms) */
  selfActMs: 400,
  /** a callout of the same kind is not repeated within this many beats */
  dropCalloutGapBeats: 8,

  // ───────────── tutorial ─────────────
  tutorial: {
    /** notes to hit in the pads lesson */
    padHits: 8,
    padDensity: 0.5,
    /** the pads lesson moves on by itself after this long */
    padMaxBeats: 128,
    /** pause between two lessons */
    gapBeats: 2,
    /** when a deck gets this close to its end, it jumps back `loopBars` on a bar line */
    loopGuardBars: 8,
    loopBars: 16,
    strokes: 4,
  },

  // ───────────── free play ─────────────
  free: {
    /** where hype settles: nothing playing / one deck / two decks blended in time / trainwreck */
    silent: 0.3,
    solo: 0.6,
    blend: 0.95,
    wreck: 0.1,
    halfLifeSec: 3,
    /** both decks this audible and in time for this many beats = "IN THE MIX" */
    blendAudible: 0.25,
    blendBeats: 16,
  },
} as const;

export type Tuning = typeof TUNING;
