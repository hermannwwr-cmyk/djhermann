/**
 * The missions. Each factory returns a small state machine that is stepped once per frame: it
 * watches the decks and the mixer, keeps its on-screen text and targets up to date, and returns an
 * outcome when the player has done it (or the time has run out). A mission never touches the
 * engine; rescuing a failed mission is the director's job.
 */
import { beatAtSec, distToGrid, phaseOffsetMs } from '../../core/beatgrid';
import { clamp01 } from '../../core/math';
import { BEATS_PER_BAR } from '../../core/types';
import type { DeckId, MissionKind, MissionTarget } from '../../core/types';
import { missionPoints, rateBassDrop, rateBeatmatch, rateCrossfade, rateEchoOut, rateFilterSweep, rateScratch, rateStartDeck } from './ratings';
import type { Rated } from './ratings';
import { TEXT } from './text';
import { TUNING } from './tuning';
import { runs } from './world';
import type { Advice, MissionEnv } from './world';

export interface MissionOutcome extends Rated {
  /** the mission stopped mattering: it is taken off screen, nothing is scored or recorded */
  void?: boolean;
  /** why a beatmatch was dropped */
  why?: 'unsyncable' | 'gone';
}

export interface MissionRuntime {
  readonly kind: MissionKind;
  /** title used in the results list (the on-screen title may change from step to step) */
  readonly resultTitle: string;
  /** points for a perfect rating */
  readonly points: number;
  // what the HUD shows; refreshed by step()
  title: string;
  hint: string;
  targets: MissionTarget[];
  progress: number | null;
  timeLeft: number;
  /** advance one frame; an outcome ends the mission */
  step(): MissionOutcome | null;
  /** PLAY pressed on a deck. self = the director did it, not the player */
  onPlay?(deck: DeckId, perfMs: number, self: boolean): void;
  onSync?(deck: DeckId, ok: boolean, self: boolean): void;
  /** a deck ran off the end of its track */
  onEnd?(deck: DeckId): void;
}

const one = (control: MissionTarget['control'], gesture: MissionTarget['gesture']): MissionTarget[] => [
  { control, gesture },
];
const mod = (v: number, m: number): number => ((v % m) + m) % m;
const beatMs = (bpm: number): number => 60000 / (bpm > 0 ? bpm : TUNING.fallbackBpm);
/** A tip takes over the hint for the last `tipBeats` of every `tipCycleBeats` of a mission. */
const tipTime = (beatsIn: number): boolean =>
  mod(beatsIn, TUNING.hints.tipCycleBeats) >= TUNING.hints.tipCycleBeats - TUNING.hints.tipBeats;

// ───────────────────────────── start the set ─────────────────────────────

export function createStartSet(env: MissionEnv, deck: DeckId): MissionRuntime {
  return {
    kind: 'start-set',
    resultTitle: TEXT.startSet.title,
    points: missionPoints('start-set'),
    title: TEXT.startSet.title,
    hint: TEXT.startSet.hint(deck),
    targets: one(`${deck}.play`, 'tap'),
    progress: null,
    timeLeft: 1,
    step() {
      return env.s.decks[deck].playing ? { rating: 'perfect', label: TEXT.startSet.done } : null;
    },
  };
}

// ───────────────────────────── start the other deck ─────────────────────────────

export interface StartDeckOptions {
  /** the deck to start */
  deck: DeckId;
  /** the deck that is playing: its bar lines are the "1" to hit */
  ref: DeckId;
  /** reference-deck beat of the bar line to aim for (counted in); null = any bar line */
  atBeat: number | null;
  /** beat of the reference deck after which the mission fails; null = no time limit */
  deadlineBeat: number | null;
  /** the same limit on the gig clock, for when the reference deck is not running; null = none */
  maxClockBeats: number | null;
}

/** Distance from a PLAY press to the reference deck's nearest bar line in ms (negative = early). */
export function barLineOffsetMs(refBeat: number, refBpm: number): number {
  return distToGrid(refBeat, BEATS_PER_BAR) * beatMs(refBpm);
}

export function createStartDeck(env: MissionEnv, o: StartDeckOptions): MissionRuntime {
  const { s } = env;
  const startClock = s.clock;
  const startRefBeat = s.decks[o.ref].beat;
  let pressed: 'player' | 'self' | null = null;
  let offsetMs: number | null = null;

  const rt: MissionRuntime = {
    kind: 'start-deck',
    resultTitle: TEXT.startDeck.title(o.deck),
    points: missionPoints('start-deck'),
    title: TEXT.startDeck.title(o.deck),
    hint: TEXT.startDeck.plain(o.deck),
    targets: one(`${o.deck}.play`, 'tap'),
    progress: null,
    timeLeft: 1,
    onPlay(deck, perfMs, self) {
      if (deck !== o.deck || pressed) return;
      pressed = self ? 'self' : 'player';
      const ref = s.decks[o.ref];
      if (!self && ref.track && runs(ref) && ref.rate > 0.5) {
        const beat = beatAtSec(ref.track.grid, env.engine.positionAt(o.ref, perfMs));
        offsetMs = barLineOffsetMs(beat, ref.bpm);
      }
    },
    step() {
      const d = s.decks[o.deck];
      const ref = s.decks[o.ref];
      if (d.playing) {
        return pressed === 'player'
          ? rateStartDeck(offsetMs, env.difficulty)
          : { rating: 'ok', label: TEXT.startDeck.started };
      }
      const counting = !!ref.track && runs(ref) && ref.rate > 0.5;
      if (counting) {
        // count down 4-3-2-1-NOW to the reference deck's bar line, a touch early so it can be read in time
        const b = ref.beat + TUNING.transition.countLeadBeats;
        const inBar = mod(b, BEATS_PER_BAR);
        const nextBar = b - inBar + BEATS_PER_BAR;
        if (o.atBeat !== null && b < o.atBeat - BEATS_PER_BAR) {
          rt.hint = TEXT.startDeck.ready(o.deck);
          rt.progress = 0;
        } else if (inBar < 1 && (o.atBeat === null || b >= o.atBeat)) {
          rt.hint = TEXT.startDeck.now(o.deck);
          rt.progress = 1;
        } else {
          const k = Math.max(1, Math.ceil(nextBar - b));
          rt.hint = TEXT.startDeck.count(o.deck, k);
          rt.progress = clamp01(1 - (nextBar - b) / BEATS_PER_BAR);
        }
      } else {
        rt.hint = TEXT.startDeck.plain(o.deck);
        rt.progress = null;
      }
      let left = 1;
      if (o.maxClockBeats !== null) {
        left = Math.min(left, 1 - (s.clock - startClock) / Math.max(1, o.maxClockBeats));
      }
      if (o.deadlineBeat !== null && counting) {
        left = Math.min(left, (o.deadlineBeat - ref.beat) / Math.max(1, o.deadlineBeat - startRefBeat));
      }
      rt.timeLeft = clamp01(left);
      if ((o.deadlineBeat !== null || o.maxClockBeats !== null) && left <= 0) {
        return { rating: 'fail', label: TEXT.startDeck.fail };
      }
      return null;
    },
  };
  return rt;
}

// ───────────────────────────── beatmatch ─────────────────────────────

export interface BeatmatchOptions {
  /** the deck to adjust (the new one) */
  deck: DeckId;
  /** the deck to match (the one the crowd hears) */
  ref: DeckId;
  /** false: the mission asks for SYNC. true: TEMPO fader and PITCH BEND, SYNC for fewer points */
  manual: boolean;
  /** beats on the gig clock; null = no time limit */
  deadlineBeats: number | null;
  /** has SYNC been used on either deck since the transition began? */
  usedSync: () => boolean;
  /** the old track is about to run out: fail now so the rescue still fits */
  urgent?: () => boolean;
}

export function createBeatmatch(env: MissionEnv, o: BeatmatchOptions): MissionRuntime {
  const { s } = env;
  const M = TUNING.transition.match;
  const tolMs = M.offsetMs[env.difficulty];
  const startClock = s.clock;
  let first = true;
  let stable = 0;
  let gone = 0;
  let unsyncable = false;
  let startDiff = 0;

  const syncTargets = one(`${o.deck}.sync`, 'tap');
  const playTargets = one(`${o.deck}.play`, 'tap');
  const fasterTargets = one(`${o.deck}.tempo`, 'down');
  const slowerTargets = one(`${o.deck}.tempo`, 'up');
  const fasterOrSync: MissionTarget[] = [...fasterTargets, ...syncTargets];
  const slowerOrSync: MissionTarget[] = [...slowerTargets, ...syncTargets];
  const plusTargets = one(`${o.deck}.nudge+`, 'hold');
  const minusTargets = one(`${o.deck}.nudge-`, 'hold');

  const rt: MissionRuntime = {
    kind: 'beatmatch',
    resultTitle: TEXT.beatmatch.resultTitle,
    points: missionPoints('beatmatch'),
    title: o.manual ? TEXT.beatmatch.manualTitle : TEXT.beatmatch.syncTitle(o.deck),
    hint: TEXT.beatmatch.sync(o.deck, o.ref),
    targets: syncTargets,
    progress: 0,
    timeLeft: 1,
    onSync(_deck, ok) {
      if (!ok) unsyncable = true;
    },
    step() {
      const d = s.decks[o.deck];
      const r = s.decks[o.ref];
      const timed = o.deadlineBeats !== null;
      const wasFirst = first;
      first = false;
      if (unsyncable) return { rating: 'ok', label: '', void: true, why: 'unsyncable' };

      // nothing to match against any more: drop the mission (a lesson just waits)
      if (!r.track || !r.playing) {
        gone += s.dtBeats;
        if (timed && gone > 2) return { rating: 'ok', label: '', void: true, why: 'gone' };
      } else gone = 0;

      const manual = o.manual && !(o.usedSync() && d.synced);
      if (!d.playing) {
        stable = 0;
        rt.hint = TEXT.beatmatch.startFirst(o.deck);
        rt.targets = playTargets;
        rt.progress = 0;
      } else {
        const bpmDiff = r.bpm - d.bpm; // > 0: the new deck is too slow
        const off = phaseOffsetMs(d, r); // > 0: the new deck's beat comes first
        const tempoOk = Math.abs(bpmDiff) <= M.bpm;
        const phaseOk = Math.abs(off) <= (stable > 0 ? tolMs * M.stayFactor : tolMs);
        const steady = runs(d) && runs(r);
        if (wasFirst) startDiff = Math.max(0.5, Math.abs(bpmDiff));
        if (tempoOk && phaseOk && steady) {
          if (wasFirst) {
            return rateBeatmatch({ usedSync: o.usedSync(), syncAsked: !o.manual, instant: true });
          }
          stable += s.dtBeats;
          if (stable >= M.holdBeats) {
            return rateBeatmatch({ usedSync: o.usedSync(), syncAsked: !o.manual, instant: false });
          }
          rt.hint = manual ? TEXT.beatmatch.hold : TEXT.beatmatch.syncHold;
          // the target stays where the player's finger is
          rt.progress = o.manual ? 0.75 + 0.25 * (stable / M.holdBeats) : stable / M.holdBeats;
        } else {
          stable = 0;
          if (!manual) {
            rt.hint = TEXT.beatmatch.sync(o.deck, o.ref);
            rt.targets = syncTargets;
            rt.progress = 0;
          } else if (!tempoOk) {
            if (bpmDiff > 0) {
              rt.hint = TEXT.beatmatch.faster(o.deck, d.bpm, r.bpm);
              rt.targets = fasterTargets;
            } else {
              rt.hint = TEXT.beatmatch.slower(o.deck, d.bpm, r.bpm);
              rt.targets = slowerTargets;
            }
            // club: now and then, mention that SYNC is allowed too
            if (env.difficulty === 'club' && tipTime(s.clock - startClock)) {
              rt.hint = TEXT.beatmatch.orSync(o.deck);
              rt.targets = bpmDiff > 0 ? fasterOrSync : slowerOrSync;
            }
            rt.progress = 0.5 * clamp01(1 - Math.abs(bpmDiff) / startDiff);
          } else {
            if (off > 0) {
              rt.hint = TEXT.beatmatch.ahead(o.deck);
              rt.targets = minusTargets;
            } else {
              rt.hint = TEXT.beatmatch.behind(o.deck);
              rt.targets = plusTargets;
            }
            const half = beatMs(Math.min(d.bpm, r.bpm)) / 2;
            rt.progress = 0.5 + 0.25 * clamp01(1 - Math.abs(off) / half);
          }
        }
      }

      if (timed) {
        const left = 1 - (s.clock - startClock) / o.deadlineBeats!;
        rt.timeLeft = clamp01(left);
        if (left <= 0 || o.urgent?.()) return { rating: 'fail', label: TEXT.beatmatch.fail };
      }
      return null;
    },
  };
  return rt;
}

// ───────────────────────────── crossfade ─────────────────────────────

/** Watches the crossfader through a whole transition: how long the blend took, and the bass swap. */
export interface BlendTracker {
  /** call once per frame */
  update(): void;
  /** 0 = fully on the old deck, 1 = fully on the new deck */
  readonly travel: number;
  /** true when the crossfader was already across the first time it was looked at */
  readonly startedAcross: boolean;
  /** beats between the two travel marks, or null while the crossfader has not passed both */
  blendBeats(): number | null;
  readonly bassSwap: boolean;
}

export function createBlendTracker(env: MissionEnv, from: DeckId, to: DeckId): BlendTracker {
  const F = TUNING.transition.fade;
  const { s } = env;
  const dir = to === 'B' ? 1 : -1;
  let travel = 0;
  let tLo: number | null = null;
  let tHi: number | null = null;
  let bassSwap = false;
  let seen = false;
  let startedAcross = false;
  return {
    update() {
      travel = (s.mixer.crossfader * dir + 1) / 2;
      if (!seen) {
        seen = true;
        startedAcross = travel >= F.doneAt;
      }
      if (travel <= F.lo) {
        tLo = null;
        tHi = null;
      } else if (tLo === null) tLo = s.clock;
      if (travel >= F.hi) {
        if (tHi === null && tLo !== null) tHi = s.clock;
      } else tHi = null;
      if (
        travel > F.lo &&
        travel < F.doneAt &&
        s.mixer.channels[from].eq.low <= F.bassSwapOldLow &&
        s.mixer.channels[to].eq.low >= F.bassSwapNewLow
      ) {
        bassSwap = true;
      }
    },
    get travel() {
      return travel;
    },
    get startedAcross() {
      return startedAcross;
    },
    blendBeats: () => (tLo !== null && tHi !== null ? tHi - tLo : null),
    get bassSwap() {
      return bassSwap;
    },
  };
}

export interface CrossfadeOptions {
  from: DeckId;
  to: DeckId;
  /** the two tracks cannot be beatmatched: a quick cut is the right move */
  cut: boolean;
  deadlineBeats: number | null;
  tracker: BlendTracker;
  /** was there a trainwreck since the transition began? */
  trainwrecked: () => boolean;
  urgent?: () => boolean;
  /** mention the bass-swap bonus in the hint */
  tip: boolean;
}

export function createCrossfade(env: MissionEnv, o: CrossfadeOptions): MissionRuntime {
  const { s } = env;
  const F = TUNING.transition.fade;
  const startClock = s.clock;
  const title = o.cut ? TEXT.crossfade.cutTitle(o.to) : TEXT.crossfade.title(o.to);
  const xfTargets = one('xfader', o.to === 'B' ? 'right' : 'left');
  const faderTargets = one(`${o.to}.fader`, 'up');
  const tipTargets: MissionTarget[] = [{ control: `${o.from}.eq.low`, gesture: 'turn-left' }, ...xfTargets];

  const rt: MissionRuntime = {
    kind: 'crossfade',
    resultTitle: title,
    points: missionPoints('crossfade'),
    title,
    hint: TEXT.crossfade.slide(o.to),
    targets: xfTargets,
    progress: 0,
    timeLeft: 1,
    step() {
      const travel = o.tracker.travel;
      if (travel >= F.doneAt) {
        return rateCrossfade({
          blendBeats: o.tracker.blendBeats(),
          cut: o.cut,
          trainwrecked: o.trainwrecked(),
          bassSwap: o.tracker.bassSwap,
        });
      }
      if (s.mixer.channels[o.to].fader < F.minFader) {
        rt.hint = TEXT.crossfade.faderFirst(o.to);
        rt.targets = faderTargets;
      } else {
        rt.targets = xfTargets;
        rt.hint = o.cut ? TEXT.crossfade.cut(o.to) : travel > F.lo ? TEXT.crossfade.keepGoing(o.to) : TEXT.crossfade.slide(o.to);
        // before the slide starts, now and then point at the bass-swap bonus
        if (o.tip && !o.cut && travel <= F.lo && tipTime(s.clock - startClock)) {
          rt.hint = TEXT.crossfade.bonusTip(o.from);
          rt.targets = tipTargets;
        }
      }
      rt.progress = clamp01(travel);
      if (o.deadlineBeats !== null) {
        const left = 1 - (s.clock - startClock) / o.deadlineBeats;
        rt.timeLeft = clamp01(left);
        if (left <= 0 || o.urgent?.()) return { rating: 'fail', label: TEXT.crossfade.fail };
      }
      return null;
    },
  };
  return rt;
}

// ───────────────────────────── stop the old deck ─────────────────────────────

export function createStopDeck(env: MissionEnv, o: { deck: DeckId; deadlineBeats: number | null }): MissionRuntime {
  const { s } = env;
  const startClock = s.clock;
  let ranOut = false;
  const rt: MissionRuntime = {
    kind: 'stop-deck',
    resultTitle: TEXT.stopDeck.title(o.deck),
    points: missionPoints('stop-deck'),
    title: TEXT.stopDeck.title(o.deck),
    hint: TEXT.stopDeck.hint(o.deck),
    targets: one(`${o.deck}.play`, 'tap'),
    progress: null,
    timeLeft: 1,
    onEnd(deck) {
      if (deck === o.deck) ranOut = true;
    },
    step() {
      if (!s.decks[o.deck].playing) {
        return ranOut
          ? { rating: 'fail', label: TEXT.stopDeck.ranOut }
          : { rating: 'perfect', label: TEXT.stopDeck.done };
      }
      if (o.deadlineBeats !== null) {
        const left = 1 - (s.clock - startClock) / o.deadlineBeats;
        rt.timeLeft = clamp01(left);
        if (left <= 0) return { rating: 'fail', label: TEXT.stopDeck.fail };
      }
      return null;
    },
  };
  return rt;
}

// ───────────────────────────── bass drop ─────────────────────────────

export interface BassDropOptions {
  deck: DeckId;
  /** track beat of the drop's downbeat; null = lesson: no timing, no time limit */
  dropBeat: number | null;
}

export function createBassDrop(env: MissionEnv, o: BassDropOptions): MissionRuntime {
  const { s } = env;
  const B = TUNING.tricks.bassDrop;
  const startClock = s.clock;
  const startBeat = s.decks[o.deck].beat;
  const lead = o.dropBeat === null ? 0 : Math.max(1, o.dropBeat - startBeat);
  let phase: 'cut' | 'back' = 'cut';
  const cutTargets = one(`${o.deck}.eq.low`, 'turn-left');
  const backTargets = one(`${o.deck}.eq.low`, 'turn-right');

  const rt: MissionRuntime = {
    kind: 'bass-drop',
    resultTitle: TEXT.bassDrop.title,
    points: missionPoints('bass-drop'),
    title: TEXT.bassDrop.title,
    hint: TEXT.bassDrop.cut(o.deck),
    targets: cutTargets,
    progress: 0,
    timeLeft: 1,
    step() {
      const d = s.decks[o.deck];
      const low = s.mixer.channels[o.deck].eq.low;
      if (phase === 'cut') {
        if (low <= B.cutBelow) phase = 'back';
      } else if (low >= B.backAbove) {
        if (o.dropBeat === null) return { rating: 'perfect', label: TEXT.bassDrop.learned };
        return rateBassDrop((d.beat - o.dropBeat) * beatMs(d.bpm), env.difficulty);
      }

      if (o.dropBeat === null) {
        if (phase === 'cut') {
          rt.hint = TEXT.bassDrop.cut(o.deck);
          rt.targets = cutTargets;
          rt.progress = 0.5 * clamp01((0.5 - low) / (0.5 - B.cutBelow));
        } else {
          rt.hint = TEXT.bassDrop.back(o.deck);
          rt.targets = backTargets;
          rt.progress = 0.5 + 0.5 * clamp01(low / B.backAbove);
        }
        return null;
      }

      const until = o.dropBeat - d.beat; // beats to the drop
      if (phase === 'cut') {
        rt.hint = TEXT.bassDrop.cut(o.deck);
        rt.targets = cutTargets;
      } else {
        rt.targets = backTargets;
        const k = Math.ceil(until - TUNING.transition.countLeadBeats);
        rt.hint = k > 4 ? TEXT.bassDrop.wait : k >= 1 ? TEXT.bassDrop.count(o.deck, k) : TEXT.bassDrop.now(o.deck);
      }
      rt.progress = clamp01(1 - until / lead);
      const span = lead + B.lateBeats;
      // the drop moves with the record; the clock limit is the backstop when the record does not move
      const left = Math.min((until + B.lateBeats) / span, 1 - (s.clock - startClock) / (span + 8));
      rt.timeLeft = clamp01(left);
      if (left <= 0) {
        return { rating: 'fail', label: phase === 'cut' ? TEXT.bassDrop.missed : TEXT.bassDrop.stuck };
      }
      return null;
    },
  };
  return rt;
}

// ───────────────────────────── filter sweep ─────────────────────────────

export function createFilterSweep(env: MissionEnv, o: { deck: DeckId; windowBeats: number | null }): MissionRuntime {
  const { s } = env;
  const F = TUNING.tricks.filterSweep;
  const startClock = s.clock;
  let phase: 'out' | 'back' = 'out';
  let leftAt: number | null = null;
  const outTargets = one(`${o.deck}.filter`, 'turn-left');
  const backRight = one(`${o.deck}.filter`, 'turn-right');
  const backLeft = one(`${o.deck}.filter`, 'turn-left');

  const rt: MissionRuntime = {
    kind: 'filter-sweep',
    resultTitle: TEXT.filterSweep.title,
    points: missionPoints('filter-sweep'),
    title: TEXT.filterSweep.title,
    hint: TEXT.filterSweep.out(o.deck),
    targets: outTargets,
    progress: 0,
    timeLeft: 1,
    step() {
      const f = s.mixer.channels[o.deck].filter;
      const a = Math.abs(f);
      if (a > F.centre) {
        if (leftAt === null) leftAt = s.clock;
      } else if (phase === 'out') leftAt = null;

      if (phase === 'out') {
        if (a >= F.depth) phase = 'back';
      } else if (a <= F.centre) {
        return rateFilterSweep(s.clock - (leftAt ?? s.clock));
      }

      if (phase === 'out') {
        rt.hint = TEXT.filterSweep.out(o.deck);
        rt.targets = outTargets;
        rt.progress = 0.5 * clamp01(a / F.depth);
      } else {
        rt.hint = TEXT.filterSweep.back(o.deck);
        // a sweep to the right is accepted too; the way back is then to the left
        rt.targets = f < 0 ? backRight : backLeft;
        rt.progress = 0.5 + 0.5 * clamp01(1 - (a - F.centre) / (F.depth - F.centre));
      }
      if (o.windowBeats !== null) {
        const left = 1 - (s.clock - startClock) / o.windowBeats;
        rt.timeLeft = clamp01(left);
        if (left <= 0) {
          return { rating: 'fail', label: phase === 'out' ? TEXT.filterSweep.missed : TEXT.filterSweep.stuck };
        }
      }
      return null;
    },
  };
  return rt;
}

// ───────────────────────────── scratch ─────────────────────────────

/** Counts scratch strokes: one stroke = the record pushed or pulled far enough in one direction. */
export function createStrokeCounter(minStrokeSec: number = TUNING.tricks.scratch.minStrokeSec): {
  /** feed the record's movement since the last frame while it is held; returns the stroke count */
  move(deltaSec: number): number;
  /** the record was let go */
  release(): void;
  readonly count: number;
} {
  let dir = 0;
  let run = 0;
  let counted = false;
  let count = 0;
  return {
    move(deltaSec) {
      if (Math.abs(deltaSec) < 1e-5) return count;
      const sign = deltaSec > 0 ? 1 : -1;
      if (sign !== dir) {
        dir = sign;
        run = 0;
        counted = false;
      }
      run += Math.abs(deltaSec);
      if (!counted && run >= minStrokeSec) {
        counted = true;
        count++;
      }
      return count;
    },
    release() {
      dir = 0;
      run = 0;
      counted = false;
    },
    get count() {
      return count;
    },
  };
}

export function createScratch(
  env: MissionEnv,
  o: { deck: DeckId; strokes: number; windowBeats: number | null },
): MissionRuntime {
  const { s } = env;
  const startClock = s.clock;
  const counter = createStrokeCounter();
  let lastPos = s.decks[o.deck].positionSec;
  let firstAt: number | null = null;
  let done: Rated | null = null;
  let doneAt = 0;

  const rt: MissionRuntime = {
    kind: 'scratch',
    resultTitle: TEXT.scratch.title,
    points: missionPoints('scratch'),
    title: TEXT.scratch.title,
    hint: TEXT.scratch.hint(o.deck, Math.max(1, Math.round(o.strokes / 2))),
    targets: one(`${o.deck}.platter`, 'scratch'),
    progress: 0,
    timeLeft: 1,
    step() {
      const d = s.decks[o.deck];
      if (done) {
        // strokes done: the record has to be let go so the music plays on
        if (!d.scratching || s.clock - doneAt >= TUNING.tricks.scratch.letGoBeats) return done;
        return null;
      }
      if (d.scratching) {
        const before = counter.count;
        counter.move(d.positionSec - lastPos);
        if (before === 0 && counter.count > 0) firstAt = s.clock;
      } else counter.release();
      lastPos = d.positionSec;
      if (counter.count >= o.strokes) {
        done = rateScratch(s.clock - (firstAt ?? s.clock));
        if (!d.scratching) return done;
        doneAt = s.clock;
        rt.hint = TEXT.scratch.letGo(o.deck);
        rt.targets = one(`${o.deck}.platter`, 'tap');
        rt.progress = 1;
        rt.timeLeft = 1;
        return null;
      }
      rt.progress = clamp01(counter.count / o.strokes);
      if (o.windowBeats !== null) {
        const left = 1 - (s.clock - startClock) / o.windowBeats;
        rt.timeLeft = clamp01(left);
        if (left <= 0) return { rating: 'fail', label: TEXT.scratch.fail };
      }
      return null;
    },
  };
  return rt;
}

// ───────────────────────────── echo out ─────────────────────────────

export function createEchoOut(env: MissionEnv, o: { deck: DeckId; endBeat: number }): MissionRuntime {
  const { s } = env;
  const E = TUNING.tricks.echoOut;
  const startClock = s.clock;
  const startBeat = s.decks[o.deck].beat;
  const lastBeat = o.endBeat - E.guardBeats;
  const span = Math.max(1, lastBeat - startBeat);
  let echoAt: number | null = null;
  let ranOut = false;
  const holdTargets = one(`${o.deck}.echo`, 'hold');
  const stopTargets: MissionTarget[] = [
    { control: `${o.deck}.echo`, gesture: 'hold' },
    { control: `${o.deck}.play`, gesture: 'tap' },
  ];

  const rt: MissionRuntime = {
    kind: 'echo-out',
    resultTitle: TEXT.echoOut.title,
    points: missionPoints('echo-out'),
    title: TEXT.echoOut.title,
    hint: TEXT.echoOut.hold(o.deck),
    targets: holdTargets,
    progress: 0,
    timeLeft: 1,
    onEnd(deck) {
      if (deck === o.deck) ranOut = true;
    },
    step() {
      const d = s.decks[o.deck];
      const echo = s.mixer.channels[o.deck].echo;
      if (echo) echoAt = s.clock;
      if (ranOut) return { rating: 'fail', label: TEXT.echoOut.fail };
      if (!d.playing) return rateEchoOut(echoAt === null ? null : echo ? 0 : s.clock - echoAt);
      rt.hint = echo ? TEXT.echoOut.stop(o.deck) : TEXT.echoOut.hold(o.deck);
      rt.targets = echo ? stopTargets : holdTargets;
      rt.progress = echo ? 0.5 : 0;
      const left = Math.min((lastBeat - d.beat) / span, 1 - (s.clock - startClock) / (span + 8));
      rt.timeLeft = clamp01(left);
      if (left <= 0) return { rating: 'fail', label: TEXT.echoOut.fail };
      return null;
    },
  };
  return rt;
}

// ───────────────────────────── bring the music back ─────────────────────────────

/**
 * Not a scored mission: shown while there is dead air and nothing else is being asked, so the
 * player is told which control brings the music back. Ends as soon as something is heard.
 */
export function createRecover(
  _env: MissionEnv,
  o: { advise: () => Advice | null; sounding: () => boolean; first: Advice },
): MissionRuntime {
  let shown = o.first;
  let targets = [shown.target];
  const rt: MissionRuntime = {
    kind: shown.what === 'crossfader' || shown.what === 'fader' ? 'crossfade' : 'start-deck',
    resultTitle: TEXT.recover.title,
    points: 0,
    title: TEXT.recover.title,
    hint: shown.hint,
    targets,
    progress: null,
    timeLeft: 1,
    step() {
      if (o.sounding()) return { rating: 'ok', label: TEXT.recover.done, void: true };
      const a = o.advise();
      if (a && (a.what !== shown.what || a.target.control !== shown.target.control)) {
        shown = a;
        targets = [a.target];
      }
      rt.hint = shown.hint;
      rt.targets = targets;
      return null;
    },
  };
  return rt;
}
