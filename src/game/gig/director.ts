/**
 * The gig director: runs a gig or the tutorial. It decides which mission comes when, judges it,
 * rescues the player when time runs out, runs the crowd's hype and keeps score.
 *
 * Two rules shape everything in here:
 *  1. The gig can never get stuck. Every timed mission ends on the gig's own beat clock (which
 *     runs even when no record moves), every failed mission is rescued by doing the action for the
 *     player, dead air is either rescued (chill, tutorial) or drains the hype until the crowd
 *     leaves (club, festival), and a curfew ends any gig that is being stalled.
 *  2. The player is always told what to do: a mission (or, in dead air, a "bring the music back"
 *     prompt) names the control and the gesture.
 */
import { phaseOffsetMs, sectionAtBeat } from '../../core/beatgrid';
import type { GameBus } from '../../core/events';
import { AUDIBLE_MIN } from '../../core/frame';
import { clamp01, damp, lerp } from '../../core/math';
import { crossfaderGain } from '../../core/mixmath';
import { BEATS_PER_BAR, otherDeck } from '../../core/types';
import type {
  AudioEngine,
  CalloutKind,
  CalloutTone,
  DeckId,
  DeckSnapshot,
  FrameState,
  GameParams,
  GigController,
  GigResults,
  HudState,
  Library,
  MissionResult,
  MissionView,
  ProgressFn,
  RhythmController,
  RhythmStats,
  SettingsStore,
  TrackMeta,
} from '../../core/types';
import { createDeadAirDetector, createTrainwreckDetector } from './detectors';
import {
  createBassDrop,
  createBeatmatch,
  createBlendTracker,
  createCrossfade,
  createEchoOut,
  createFilterSweep,
  createRecover,
  createScratch,
  createStartDeck,
  createStartSet,
  createStopDeck,
} from './missions';
import type { BlendTracker, MissionOutcome, MissionRuntime } from './missions';
import { canMatch, energyAt, planTrack, segmentBeats, trackEndBar } from './plan';
import type { PlannedTrick, TrackPlan } from './plan';
import { pointsFor } from './ratings';
import { finishBonus, gradeFor, performance, starsFor } from './results';
import { TEXT } from './text';
import { TUNING } from './tuning';
import { adviseSilence, atEnd, eqSilent, heard, resetChannel, resetMixer, runs, sounding } from './world';
import type { MissionEnv, Sight } from './world';

export interface GigDeps {
  engine: AudioEngine;
  bus: GameBus;
  library: Library;
  rhythm: RhythmController;
  settings: SettingsStore;
  params: GameParams;
}

type Phase = 'idle' | 'loading' | 'ready' | 'playing' | 'ending' | 'ended';
type Script = Generator<void, void, void>;
type ScriptKind = 'transition' | 'trick' | 'finale' | 'lesson' | 'recover';

interface Active {
  rt: MissionRuntime;
  view: MissionView;
  outcome: MissionOutcome | null;
}

interface Transition {
  from: DeckId;
  to: DeckId;
  tracker: BlendTracker;
  usedSync: boolean;
  trainwrecked: boolean;
  /** the two tracks cannot be beatmatched: cut instead of blending */
  cut: boolean;
  /** the rescue crossfade is running */
  fading: boolean;
}

interface PendingLoad {
  deck: DeckId;
  index: number;
  done: boolean;
  failed: boolean;
}

const EMPTY_STATS: RhythmStats = {
  perfect: 0,
  great: 0,
  good: 0,
  miss: 0,
  combo: 0,
  maxCombo: 0,
  multiplier: 1,
  points: 0,
  accuracy: 1,
};

export function createDirector(deps: GigDeps): GigController {
  const { engine, bus, library, rhythm, settings, params } = deps;
  const tutorial = !!params.tutorial;
  const difficulty = params.difficulty;
  /** club + festival: the crowd can walk out. chill + tutorial: dead air is rescued instead */
  const canLose = !tutorial && difficulty !== 'chill';
  const T = TUNING.transition;

  let phase: Phase = 'idle';
  let destroyed = false;
  let generation = 0;
  const unsubs: (() => void)[] = [];

  // ── the set ──
  let set: TrackMeta[] = [];
  let setIndex = 0;
  let main: DeckId = 'A';
  let plan: TrackPlan | null = null;
  let segSec: number[] = [];
  let plannedSec = 0;
  let pending: PendingLoad | null = null;
  let heardIndex = 0;

  // ── the world this frame ──
  const sight: Sight = {
    now: 0,
    dt: 0,
    clock: 0,
    dtBeats: 0,
    decks: { A: engine.getDeck('A'), B: engine.getDeck('B') },
    mixer: engine.getMixer(),
  };
  const env: MissionEnv = { engine, s: sight, difficulty, tutorial };
  let lastBpm: number = TUNING.fallbackBpm;
  let liveDeck: DeckId | null = null;

  // ── missions and scripts ──
  let active: Active | null = null;
  let nextId = 1;
  let script: { kind: ScriptKind; gen: Script } | null = null;
  let transition: Transition | null = null;
  let settleUntil = 0;
  let adoptBeats = 0;
  let finaleDone = false;
  const ended: Record<DeckId, boolean> = { A: false, B: false };
  const selfActs = new Map<string, number>();

  // ── hype and trouble ──
  let hype: number = TUNING.hype.start;
  const deadAir = createDeadAirDetector();
  const trainwreck = createTrainwreckDetector();
  let twGraceUntil = 0;
  let missGraceUntil = 0;
  let zeroSec = 0;
  let leaveWarned = false;
  let lastSectionKey = '';
  let lastLiveBeat = 0;
  let lastDropClock = -Infinity;

  // ── score ──
  const missions: MissionResult[] = [];
  let missionEarned = 0;
  let missionAvailable = 0;
  let stats: RhythmStats = EMPTY_STATS;
  let gigSec = 0;
  let hypeSum = 0;
  let hypePeak: number = TUNING.hype.start;
  const hypeHistory: number[] = [];
  let nextSampleClock = 0;
  let completed = false;
  let endTail = 0;
  let results: GigResults | null = null;
  let progress = 0;
  let density = 0;

  // ── tutorial ──
  const LESSON_STEPS = 9;
  let lessonStep = 0;
  let lessonDensity = 0;
  let pads: { hits: number; need: number } | null = null;

  const hud: HudState = {
    mode: 'gig',
    score: 0,
    combo: 0,
    multiplier: 1,
    hype,
    progress: 0,
    mission: null,
    status: TEXT.status.loading,
    set: null,
  };

  // ───────────────────────────── small helpers ─────────────────────────────

  const beatsPerSec = (): number => lastBpm / 60;
  const isLast = (): boolean => setIndex >= set.length - 1;

  function callout(kind: CalloutKind, text: string, tone: CalloutTone): void {
    bus.emit('callout', { kind, text, tone });
  }
  const rescueCallout = (text: string): void => callout('rescue', text, 'info');

  function addHype(delta: number): void {
    if (tutorial && delta < 0) return; // nothing is penalised in the lesson
    hype = clamp01(hype + delta);
    if (hype > hypePeak) hypePeak = hype;
  }

  function setDensity(value: number): void {
    const v = clamp01(Math.round(value / TUNING.density.step) * TUNING.density.step);
    if (v === density) return;
    density = v;
    try {
      rhythm.setDensity(v);
    } catch (err) {
      console.error('[gig] rhythm.setDensity threw', err);
    }
  }

  /** Mark an engine call of our own, so its event is not mistaken for the player's hand. */
  function expectSelf(type: 'play' | 'pause' | 'sync', deck: DeckId): void {
    selfActs.set(`${type}:${deck}`, sight.now + TUNING.selfActMs);
  }
  function wasSelf(type: 'play' | 'pause' | 'sync', deck: DeckId): boolean {
    const key = `${type}:${deck}`;
    const until = selfActs.get(key);
    if (until === undefined) return false;
    selfActs.delete(key);
    return until >= sight.now;
  }
  function selfPlay(deck: DeckId): void {
    const d = engine.getDeck(deck);
    if (!d.track || d.playing) return;
    expectSelf('play', deck);
    engine.play(deck);
  }
  function selfPause(deck: DeckId): void {
    const d = engine.getDeck(deck);
    if (!d.track || !d.playing) return;
    expectSelf('pause', deck);
    engine.pause(deck);
  }
  function selfSync(deck: DeckId): boolean {
    expectSelf('sync', deck);
    return engine.sync(deck);
  }
  /** Move a deck by a whole number of beats without losing its place in the bar. */
  function jumpBeats(deck: DeckId, beats: number): void {
    const d = sight.decks[deck];
    if (!d.track) return;
    // seek moves the playhead, which runs ahead of what is heard by the output latency
    const playhead = engine.positionAt(deck, sight.now + engine.getLatency() * 1000);
    engine.seek(deck, playhead + (beats * 60) / d.track.grid.bpm);
  }

  // ───────────────────────────── missions ─────────────────────────────

  function syncView(a: Active): void {
    const { rt, view } = a;
    view.title = rt.title;
    view.hint = rt.hint;
    view.targets = rt.targets;
    view.progress = rt.progress;
    view.timeLeft = rt.timeLeft;
  }

  function finishMission(a: Active, out: MissionOutcome): void {
    if (active === a) active = null;
    a.outcome = out;
    const points = out.void ? 0 : pointsFor(a.rt.points, out.rating, out.bonus);
    const result: MissionResult = {
      kind: a.rt.kind,
      title: a.rt.resultTitle,
      rating: out.rating,
      points,
      label: out.label,
    };
    if (!out.void) {
      missions.push(result);
      missionEarned += points;
      missionAvailable += a.rt.points;
      addHype(TUNING.hype.mission[out.rating] + (out.bonus ? TUNING.hype.bassSwap : 0));
    }
    missGraceUntil = sight.clock + TUNING.hype.missGraceBeats;
    bus.emit('mission:end', { mission: { ...a.view }, result });
  }

  function stepActive(): void {
    const a = active;
    if (!a) return;
    let out: MissionOutcome | null;
    try {
      out = a.rt.step();
    } catch (err) {
      console.error('[gig] mission threw', err);
      out = { rating: 'fail', label: '', void: true };
    }
    syncView(a);
    if (out) finishMission(a, out);
  }

  function startMission(rt: MissionRuntime): Active {
    if (active) finishMission(active, { rating: 'ok', label: '', void: true });
    const a: Active = {
      rt,
      view: {
        id: nextId++,
        kind: rt.kind,
        title: rt.title,
        hint: rt.hint,
        targets: rt.targets,
        progress: rt.progress,
        timeLeft: rt.timeLeft,
        points: rt.points,
      },
      outcome: null,
    };
    active = a;
    // the first step puts the right words on screen (and may find the job already done)
    let out: MissionOutcome | null = null;
    try {
      out = rt.step();
    } catch (err) {
      console.error('[gig] mission threw', err);
      out = { rating: 'fail', label: '', void: true };
    }
    syncView(a);
    bus.emit('mission:start', { mission: { ...a.view } });
    if (out) finishMission(a, out);
    return a;
  }

  function* runMission(rt: MissionRuntime): Generator<void, MissionOutcome, void> {
    const a = startMission(rt);
    while (!a.outcome) yield;
    return a.outcome;
  }

  function* waitBeats(beats: number): Script {
    const until = sight.clock + beats;
    while (sight.clock < until) yield;
  }

  function startScript(kind: ScriptKind, gen: Script): void {
    script = { kind, gen };
    drive();
  }

  function drive(): void {
    const sc = script;
    if (!sc) return;
    try {
      if (sc.gen.next().done && script === sc) script = null;
    } catch (err) {
      console.error(`[gig] ${sc.kind} script threw`, err);
      if (script === sc) script = null;
      if (active) finishMission(active, { rating: 'fail', label: '', void: true });
      // never leave the gig half-way through something
      if (sc.kind === 'transition' && transition) {
        const { from, to } = transition;
        try {
          selfPlay(to);
          engine.setCrossfader(to === 'B' ? 1 : -1);
          if (tutorial) transition = null;
          else handover(from, to);
        } catch (err2) {
          console.error('[gig] could not recover the transition', err2);
          transition = null;
        }
      }
      if (sc.kind === 'lesson' || sc.kind === 'finale') beginEnding(true);
    }
  }

  // ───────────────────────────── the set ─────────────────────────────

  function replan(): void {
    const plans = set.map((meta, i) =>
      planTrack(meta, { difficulty, last: i === set.length - 1, nextBpm: set[i + 1]?.grid.bpm ?? null }),
    );
    segSec = plans.map((p, i) => (segmentBeats(p) * 60) / set[i].grid.bpm);
    plannedSec = segSec.reduce((a, b) => a + b, 0);
    // keep the tricks already used on the track that is playing
    const fresh = plans[setIndex] ?? null;
    if (plan && fresh) {
      for (const t of fresh.tricks) {
        if (plan.tricks.some((x) => x.used && x.kind === t.kind && x.startBeat === t.startBeat)) t.used = true;
      }
    }
    plan = fresh;
  }

  function loadNext(deck: DeckId, index: number): void {
    const meta = set[index];
    if (!meta) return;
    const p: PendingLoad = { deck, index, done: false, failed: false };
    pending = p;
    const gen = generation;
    const stale = (): boolean => destroyed || gen !== generation || pending !== p;
    library
      .load(meta.id)
      .then((track) => {
        if (stale()) return;
        return engine.loadTrack(deck, track).then(() => {
          if (stale()) return;
          resetChannel(engine, deck);
          engine.setTempo(deck, 1);
          p.done = true;
        });
      })
      .catch((err) => {
        console.error('[gig] could not load the next track', err);
        if (stale()) return;
        p.failed = true;
        if (!transition) dropNextTracks();
      });
  }

  /** The next track cannot be had: the track that is playing becomes the last one. */
  function dropNextTracks(): void {
    if (isLast()) return;
    set = set.slice(0, setIndex + 1);
    pending = null;
    replan();
    callout('info', TEXT.callout.skippedTrack, 'info');
  }

  /** The new deck has taken over: clear the old deck and put the following track on it. */
  function handover(from: DeckId, to: DeckId): void {
    transition = null;
    adoptBeats = 0;
    setIndex = Math.min(setIndex + 1, set.length - 1);
    heardIndex = setIndex;
    main = to;
    selfPause(from);
    engine.setNudge(from, 0);
    engine.eject(from);
    resetChannel(engine, from);
    engine.setTempo(from, 1);
    ended[from] = false;
    plan = null;
    replan();
    settleUntil = sight.clock + TUNING.tricks.settleBeats;
    if (!isLast()) loadNext(from, setIndex + 1);
  }

  // ───────────────────────────── the transition ─────────────────────────────

  /** Get the next deck ready to be started, as long as nobody can hear it. */
  function prepIncoming(to: DeckId): void {
    const d = sight.decks[to];
    if (!d.track || sounding(sight, to)) return;
    if (d.playing) selfPause(to);
    if (d.scratching) return; // the player has a hand on it: leave it alone
    if (Math.abs(d.positionSec - d.track.grid.firstBeatSec) > 0.02) engine.seek(to, d.track.grid.firstBeatSec);
    engine.setNudge(to, 0);
    // only when the crossfader keeps it silent anyway, so nothing audible changes
    if (crossfaderGain(to, sight.mixer.crossfader) < AUDIBLE_MIN) resetChannel(engine, to);
  }

  function* autoFade(tr: Transition): Script {
    const out = sight.decks[tr.from];
    const beats = runs(out) && !tr.cut ? T.fade.rescueBeats : 0;
    selfPlay(tr.to);
    if (sight.mixer.channels[tr.to].fader < T.fade.minFader) engine.setFader(tr.to, 1);
    if (eqSilent(sight.mixer.channels[tr.to])) resetChannel(engine, tr.to);
    const x0 = sight.mixer.crossfader;
    const x1 = tr.to === 'B' ? 1 : -1;
    const c0 = sight.clock;
    tr.fading = true;
    while (beats > 0 && sight.clock < c0 + beats) {
      engine.setCrossfader(lerp(x0, x1, (sight.clock - c0) / beats));
      yield;
    }
    engine.setCrossfader(x1);
    tr.fading = false;
  }

  function* transitionScript(from: DeckId, to: DeckId): Script {
    const timed = !tutorial;
    const tr: Transition = {
      from,
      to,
      tracker: createBlendTracker(env, from, to),
      usedSync: false,
      trainwrecked: false,
      cut: false,
      fading: false,
    };
    transition = tr;
    tr.tracker.update();
    const out = (): DeckSnapshot => sight.decks[from];
    const inc = (): DeckSnapshot => sight.decks[to];

    // the next track may still be loading
    if (!inc().track) {
      let waited = 0;
      while (!inc().track && pending && !pending.failed && waited < T.loadWaitSec) {
        waited += sight.dt;
        yield;
      }
      if (!inc().track) {
        transition = null;
        dropNextTracks();
        return;
      }
    }
    prepIncoming(to);
    tr.cut = !canMatch(out().bpm || set[setIndex]?.grid.bpm || 0, inc().track!.grid.bpm);
    const endBeat = plan?.endBeat ?? Infinity;
    /** the old track is this close to running out: whatever is being asked, rescue it now */
    const urgent = (reserve: number) => (): boolean => runs(out()) && out().beat >= endBeat - reserve;
    const fadeReserve = T.fade.rescueBeats + T.endGuardBeats;

    // 1. start the new deck on a bar line of the old one
    if (!engine.getDeck(to).playing) {
      let deadlineBeat: number | null = null;
      let maxClock: number | null = null;
      if (timed) {
        const now = out().beat;
        const nextBar = Math.ceil((now + 1) / BEATS_PER_BAR) * BEATS_PER_BAR;
        const target = Math.max(plan?.mixInBeat ?? nextBar, nextBar);
        deadlineBeat = Math.max(nextBar, Math.min(target + T.startWindowBeats, endBeat - fadeReserve - 16));
        maxClock = Math.min(deadlineBeat - now + 4, T.announceBeats + T.startWindowBeats + 8);
      }
      const o = yield* runMission(createStartDeck(env, { deck: to, ref: from, deadlineBeat, maxClockBeats: maxClock }));
      if (o.rating === 'fail') {
        selfPlay(to);
        rescueCallout(TEXT.startDeck.rescue(to));
      }
      yield* waitBeats(T.gapBeats);
    }

    // 2. same speed, beats together
    if (!tr.cut && (runs(out()) || !timed)) {
      const o = yield* runMission(
        createBeatmatch(env, {
          deck: to,
          ref: from,
          manual: timed && difficulty !== 'chill',
          deadlineBeats: timed ? T.match.deadlineBeats[difficulty] : null,
          usedSync: () => tr.usedSync,
          urgent: urgent(fadeReserve + 8),
        }),
      );
      if (o.why === 'unsyncable') tr.cut = true;
      if (o.rating === 'fail') {
        selfPlay(to);
        if (selfSync(to)) rescueCallout(TEXT.beatmatch.rescue(to));
        else tr.cut = true;
      }
      yield* waitBeats(T.gapBeats);
    }

    // 3. crossfade to the new deck
    if (!(tr.tracker.startedAcross && tr.tracker.travel >= T.fade.doneAt)) {
      const o = yield* runMission(
        createCrossfade(env, {
          from,
          to,
          cut: tr.cut,
          deadlineBeats: timed ? T.fade.deadlineBeats : null,
          tracker: tr.tracker,
          trainwrecked: () => tr.trainwrecked,
          urgent: urgent(fadeReserve),
          tip: timed && difficulty !== 'chill' && !tr.cut,
        }),
      );
      if (o.rating === 'fail') {
        rescueCallout(TEXT.crossfade.rescue(to));
        yield* autoFade(tr);
      } else if (o.rating === 'perfect' && !o.void) {
        callout('mix', o.bonus ? TEXT.callout.bassSwap : TEXT.callout.smoothMix, 'good');
      }
      yield* waitBeats(T.gapBeats);
    }

    // 4. stop the old deck
    if (engine.getDeck(from).playing) {
      const o = yield* runMission(
        createStopDeck(env, { deck: from, deadlineBeats: timed ? T.stop.deadlineBeats : null }),
      );
      if (o.rating === 'fail') {
        selfPause(from);
        rescueCallout(TEXT.stopDeck.rescue(from));
      }
    }

    if (tutorial) {
      transition = null;
      main = to;
      return;
    }
    handover(from, to);
  }

  // ───────────────────────────── tricks ─────────────────────────────

  function* trickScript(t: PlannedTrick): Script {
    const deck = main;
    const K = TUNING.tricks;
    let rt: MissionRuntime;
    if (t.kind === 'bass-drop') rt = createBassDrop(env, { deck, dropBeat: t.targetBeat });
    else if (t.kind === 'filter-sweep') rt = createFilterSweep(env, { deck, windowBeats: K.filterSweep.windowBeats });
    else rt = createScratch(env, { deck, strokes: K.scratch.strokes[difficulty], windowBeats: K.scratch.windowBeats });
    const o = yield* runMission(rt);
    if (o.rating === 'fail') {
      // put back whatever was left turned
      const ch = sight.mixer.channels[deck];
      if (t.kind === 'bass-drop' && ch.eq.low < K.bassDrop.backAbove) {
        engine.setEq(deck, 'low', 0.5);
        rescueCallout(TEXT.bassDrop.rescue);
      }
      if (t.kind === 'filter-sweep' && Math.abs(ch.filter) > K.filterSweep.centre) {
        engine.setFilter(deck, 0);
        rescueCallout(TEXT.filterSweep.rescue);
      }
    }
    settleUntil = sight.clock + K.minGapBeats[difficulty];
  }

  function* finaleScript(): Script {
    const deck = main;
    finaleDone = true;
    const o = yield* runMission(createEchoOut(env, { deck, endBeat: plan?.endBeat ?? sight.decks[deck].beat + 16 }));
    if (o.rating === 'fail' && sight.decks[deck].playing) {
      engine.setEcho(deck, true);
      selfPause(deck);
      rescueCallout(TEXT.echoOut.rescue);
    }
    beginEnding(true);
  }

  function* recoverScript(): Script {
    const deck = wantedDeck();
    const first = adviseSilence(sight, deck);
    if (!first) return;
    yield* runMission(
      createRecover(env, {
        first,
        advise: () => adviseSilence(sight, wantedDeck()),
        sounding: () => !deadAir.active,
      }),
    );
  }

  // ───────────────────────────── tutorial ─────────────────────────────

  function* lessonScript(): Script {
    const G = TUNING.tutorial;
    // 1. the pads
    lessonStep = 1;
    pads = { hits: 0, need: G.padHits };
    lessonDensity = G.padDensity;
    const c0 = sight.clock;
    while (pads.hits < pads.need && sight.clock - c0 < G.padMaxBeats) yield;
    pads = null;
    lessonDensity = 0;
    yield* waitBeats(G.gapBeats);
    // 2. LOW down and back up
    lessonStep = 2;
    yield* runMission(createBassDrop(env, { deck: main, dropBeat: null }));
    yield* waitBeats(G.gapBeats);
    // 3. FILTER
    lessonStep = 3;
    yield* runMission(createFilterSweep(env, { deck: main, windowBeats: null }));
    yield* waitBeats(G.gapBeats);
    // 4. scratch
    lessonStep = 4;
    yield* runMission(createScratch(env, { deck: main, strokes: G.strokes, windowBeats: null }));
    yield* waitBeats(G.gapBeats);
    // 5–8. bring in the other deck
    lessonStep = 5;
    if (set.length > 1 && sight.decks[otherDeck(main)].track) {
      yield* transitionScript(main, otherDeck(main));
      yield* waitBeats(G.gapBeats);
    }
    lessonStep = LESSON_STEPS;
    beginEnding(true);
  }

  /** In the lesson the music never runs out: a deck near its end jumps back on a bar line. */
  function keepMusicGoing(): void {
    const G = TUNING.tutorial;
    for (const deck of ['A', 'B'] as DeckId[]) {
      const d = sight.decks[deck];
      if (!d.track || !runs(d)) continue;
      const endBeat = trackEndBar(d.track) * BEATS_PER_BAR;
      const loopAt = endBeat - G.loopGuardBars * BEATS_PER_BAR;
      if (loopAt <= BEATS_PER_BAR || d.beat < loopAt) continue;
      const back = Math.min(G.loopBars * BEATS_PER_BAR, Math.floor(loopAt / BEATS_PER_BAR / 2) * BEATS_PER_BAR);
      if (back >= BEATS_PER_BAR) jumpBeats(deck, -back);
    }
  }

  // ───────────────────────────── trouble ─────────────────────────────

  /** The deck that should be making sound right now. */
  function wantedDeck(): DeckId {
    let order: DeckId[] = [main, otherDeck(main)];
    if (transition && transition.tracker.travel >= 0.5) order = [transition.to, transition.from];
    for (const d of order) if (sight.decks[d].track && sight.decks[d].playing) return d;
    for (const d of order) if (sight.decks[d].track && !atEnd(sight.decks[d])) return d;
    return order[0];
  }

  /** chill + tutorial: put the music back on. Returns true when something was done. */
  function rescueDeadAir(): boolean {
    const deck = wantedDeck();
    const d = sight.decks[deck];
    const ch = sight.mixer.channels[deck];
    if (!d.track || d.scratching) return false; // nothing to play, or the player is holding the record
    let did = false;
    if (!d.playing) {
      selfPlay(deck);
      did = true;
    }
    if (eqSilent(ch)) {
      engine.setEq(deck, 'low', 0.5);
      engine.setEq(deck, 'mid', 0.5);
      engine.setEq(deck, 'high', 0.5);
      did = true;
    }
    if (ch.fader < TUNING.deadAir.lowGain) {
      engine.setFader(deck, 1);
      did = true;
    }
    if (crossfaderGain(deck, sight.mixer.crossfader) < TUNING.deadAir.lowGain) {
      engine.setCrossfader(deck === 'B' ? 1 : -1);
      did = true;
    }
    if (did) rescueCallout(TEXT.recover.rescue);
    return did;
  }

  /** The last track has run out, or was stopped by hand in its final bars. */
  function setIsOver(): boolean {
    if (!isLast() || !plan) return false;
    const m = sight.decks[main];
    if (ended[main] || atEnd(m) || (runs(m) && m.beat >= plan.endBeat)) return true;
    const finalBeat = plan.endBeat - TUNING.end.finalStopBars * BEATS_PER_BAR;
    return !m.playing && !m.scratching && m.beat >= finalBeat && deadAir.active;
  }

  function updateTrouble(): void {
    const { dt, dtBeats, decks, mixer } = sight;
    const a = decks.A;
    const b = decks.B;

    // dead air
    const anySound = sounding(sight, 'A') || sounding(sight, 'B');
    const edge = deadAir.update(dt, anySound);
    if (edge === 'start' && !tutorial) callout('deadair', TEXT.callout.deadAir, 'bad');
    if (deadAir.active) {
      addHype(-TUNING.hype.deadAirPerSec * dt);
      if (!canLose) {
        const after = tutorial ? TUNING.deadAir.tutorialRescueAfterSec : TUNING.deadAir.rescueAfterSec;
        if (deadAir.activeSec >= after) {
          rescueDeadAir();
          deadAir.snooze();
        }
      }
      // tell the player how to bring the music back (not when the set is simply over)
      if (!script && !active && !tutorial && !setIsOver()) startScript('recover', recoverScript());
    }

    // trainwreck
    const both =
      heard(a, mixer.channels.A) >= TUNING.trainwreck.audible &&
      heard(b, mixer.channels.B) >= TUNING.trainwreck.audible &&
      runs(a) &&
      runs(b);
    if (a.scratching || b.scratching) twGraceUntil = Math.max(twGraceUntil, sight.clock + TUNING.trainwreck.graceBeats / 2);
    const twEdge = trainwreck.update({
      dtBeats,
      bothAudible: both,
      bpmDiff: a.bpm - b.bpm,
      offsetMs: both ? phaseOffsetMs(a, b) : 0,
      grace: sight.clock < twGraceUntil,
    });
    if (twEdge === 'start' && !tutorial) callout('trainwreck', TEXT.callout.trainwreck, 'bad');
    if (trainwreck.active) {
      addHype(-TUNING.hype.trainwreckPerSec * dt);
      if (transition) transition.trainwrecked = true;
    }
  }

  function updateSections(): void {
    const live = liveDeck;
    if (!live) return;
    const d = sight.decks[live];
    if (!d.track || d.scratching) return;
    const sec = sectionAtBeat(d.track, d.beat);
    const key = `${live}:${d.track.id}:${sec ? sec.startBar : -1}`;
    if (key !== lastSectionKey) {
      const sameTrack = lastSectionKey.startsWith(`${live}:${d.track.id}:`);
      lastSectionKey = key;
      if (sec) {
        bus.emit('section', { deck: live, kind: sec.kind, energy: sec.energy });
        const startBeat = sec.startBar * BEATS_PER_BAR;
        const landed = sameTrack && d.playing && lastLiveBeat < startBeat && d.beat - startBeat < 2;
        if (sec.kind === 'drop' && landed && sight.clock - lastDropClock >= TUNING.dropCalloutGapBeats) {
          lastDropClock = sight.clock;
          callout('drop', TEXT.callout.drop, 'good');
          if (!trainwreck.active) addHype(TUNING.hype.drop);
        }
      }
    }
    lastLiveBeat = d.beat;
  }

  // ───────────────────────────── performing ─────────────────────────────

  function performing(): void {
    const m = sight.decks[main];
    const other = otherDeck(main);
    if (!plan || !m.track) {
      // the deck that should carry the set is empty: move on if we can, else it is over
      if (!isLast() && sight.decks[other].track) startScript('transition', transitionScript(main, other));
      else beginEnding(true);
      return;
    }

    if (isLast()) {
      // ran out, or stopped by hand in the last bars: that is the ending
      if (setIsOver()) {
        beginEnding(true);
        return;
      }
      if (!finaleDone && runs(m) && sounding(sight, main) && plan.finaleBeat !== null && m.beat >= plan.finaleBeat) {
        startScript('finale', finaleScript());
        return;
      }
    } else {
      // the player mixed into the next deck unasked: go with it
      if (sight.decks[other].track && sounding(sight, other) && !sounding(sight, main)) adoptBeats += sight.dtBeats;
      else adoptBeats = 0;
      const due = plan.announceBeat !== null && m.beat >= plan.announceBeat;
      if (adoptBeats >= T.handoverBeats || due || ended[main] || atEnd(m)) {
        adoptBeats = 0;
        startScript('transition', transitionScript(main, other));
        return;
      }
    }

    // tricks, one at a time, only while this deck plays alone and all is well
    if (sight.clock < settleUntil) return;
    const limit = (isLast() ? plan.finaleBeat : plan.announceBeat) ?? plan.endBeat;
    for (const t of plan.tricks) {
      if (t.used) continue;
      if (m.beat > t.latestStartBeat) {
        t.used = true;
        continue;
      }
      if (m.beat < t.startBeat) break;
      const calm = runs(m) && m.rate > 0.5 && sounding(sight, main) && !sounding(sight, other) && !deadAir.active && !trainwreck.active;
      const length = t.kind === 'bass-drop' ? (t.targetBeat ?? m.beat) - m.beat + TUNING.tricks.bassDrop.lateBeats : t.endBeat - t.startBeat;
      if (calm && m.beat + length <= limit - TUNING.tricks.clearBeforeMixBeats + 0.01) {
        t.used = true;
        startScript('trick', trickScript(t));
      }
      break;
    }
  }

  function wantDensity(): number {
    if (phase !== 'playing') return 0;
    if (tutorial) return lessonDensity;
    if (script || active || transition || !plan) return 0;
    const m = sight.decks[main];
    if (!m.track || !runs(m)) return density;
    // clear the lanes just before something is asked
    const q = TUNING.density.quietBeats;
    const starts: number[] = [];
    for (const t of plan.tricks) if (!t.used) starts.push(t.startBeat);
    if (plan.announceBeat !== null) starts.push(plan.announceBeat);
    if (plan.finaleBeat !== null && !finaleDone) starts.push(plan.finaleBeat);
    for (const sb of starts) if (sb - m.beat >= 0 && sb - m.beat <= q) return 0;
    const [lo, hi] = TUNING.density.range[difficulty];
    return lerp(lo, hi, clamp01(energyAt(m.track, m.beat)));
  }

  // ───────────────────────────── start and end ─────────────────────────────

  function startGig(): void {
    phase = 'playing';
    gigSec = 0;
    nextSampleClock = sight.clock;
    settleUntil = sight.clock + TUNING.tricks.settleBeats;
    twGraceUntil = sight.clock + TUNING.trainwreck.graceBeats;
    deadAir.reset();
    bus.emit('gig:start', { setlist: [...set] });
    if (tutorial) startScript('lesson', lessonScript());
  }

  function beginEnding(done: boolean): void {
    if (phase !== 'playing') return;
    phase = 'ending';
    completed = done;
    endTail = done ? TUNING.end.tailSec : 0;
    script = null;
    transition = null;
    pads = null;
    if (active) finishMission(active, { rating: done ? 'ok' : 'fail', label: '', void: true });
    setDensity(0);
  }

  function buildResults(final: boolean): GigResults {
    const hypeAvg = gigSec > 0 ? hypeSum / gigSec : hype;
    const done = final && completed;
    const judged = stats.perfect + stats.great + stats.good + stats.miss;
    const perf = performance({ missionEarned, missionAvailable, accuracy: stats.accuracy, judged, hypeAvg });
    const bonus = final ? finishBonus(hypeAvg, set.length, done) : 0;
    return {
      completed: done,
      score: Math.round(stats.points + missionEarned + bonus),
      grade: gradeFor(perf, done),
      stars: starsFor(perf, done),
      rhythm: { ...stats },
      missions: missions.map((m) => ({ ...m })),
      hypeAvg,
      hypePeak,
      hypeHistory: [...hypeHistory],
      trainwrecks: trainwreck.count,
      deadAirSec: deadAir.totalSec,
      setlist: set.map((t) => ({ id: t.id, title: t.title })),
      difficulty,
      durationSec: gigSec,
    };
  }

  function finalize(): void {
    if (phase === 'ended') return;
    readStats();
    hypeHistory.push(hype);
    phase = 'ended';
    for (const deck of ['A', 'B'] as DeckId[]) engine.setEcho(deck, false);
    results = buildResults(true);
    if (tutorial && completed) {
      try {
        settings.set({ tutorialDone: true });
      } catch (err) {
        console.error('[gig] could not save settings', err);
      }
    }
    refreshHud();
    bus.emit('gig:end', { results });
  }

  // ───────────────────────────── HUD ─────────────────────────────

  function readStats(): void {
    try {
      stats = rhythm.getStats();
    } catch (err) {
      console.error('[gig] rhythm.getStats threw', err);
    }
  }

  function updateProgress(): void {
    let p = 0;
    if (tutorial) p = lessonStep / LESSON_STEPS;
    else if (plannedSec > 0 && plan) {
      let sec = 0;
      for (let i = 0; i < setIndex; i++) sec += segSec[i] ?? 0;
      const m = sight.decks[main];
      const mine = segSec[setIndex] ?? 0;
      sec += Math.min(mine, Math.max(0, (m.beat * 60) / (set[setIndex]?.grid.bpm ?? 120)));
      if (transition) {
        const n = sight.decks[transition.to];
        const next = set[setIndex + 1];
        if (n.track && next && n.playing) {
          sec = 0;
          for (let i = 0; i <= setIndex; i++) sec += segSec[i] ?? 0;
          sec += Math.min(segSec[setIndex + 1] ?? 0, Math.max(0, (n.beat * 60) / next.grid.bpm));
        }
      }
      p = sec / plannedSec;
    }
    if (phase === 'ended' && completed) p = 1;
    progress = Math.max(progress, clamp01(p));
  }

  function statusLine(): string {
    if (phase === 'idle' || phase === 'loading') return TEXT.status.loading;
    if (phase === 'ended' || phase === 'ending') {
      return tutorial ? TEXT.status.lessonDone : completed ? TEXT.status.complete : TEXT.status.crowdLeft;
    }
    if (pads) return TEXT.status.pads(pads.hits, pads.need);
    if (deadAir.active && phase === 'playing') {
      const a = adviseSilence(sight, wantedDeck());
      if (a) return TEXT.status.deadAir(a.short);
    }
    if (trainwreck.active && !tutorial) return TEXT.status.trainwreck;
    if (canLose && zeroSec > TUNING.hype.leaveWarnSec) return TEXT.status.leaving;
    const m = sight.decks[main];
    const title = m.track?.title ?? set[setIndex]?.title ?? '';
    if (phase === 'ready' || tutorial) return TEXT.status.title(title);
    if (transition) {
      if (transition.fading) return TEXT.status.fading(transition.to);
      if (!sight.decks[transition.to].track) return TEXT.status.loadingNext;
      return TEXT.status.mixing(sight.decks[transition.to].track?.title ?? '');
    }
    if (!plan) return TEXT.status.title(title);
    if (isLast()) {
      const left = Math.ceil((plan.endBeat - m.beat) / BEATS_PER_BAR);
      if (left <= TUNING.status.lastBars && left >= 1) return TEXT.status.lastBars(left);
      return TEXT.status.lastTrack(title);
    }
    if (plan.mixInBeat !== null) {
      const n = Math.ceil((plan.mixInBeat - m.beat) / BEATS_PER_BAR);
      if (n >= 1 && n <= TUNING.status.mixSoonBars) return TEXT.status.mixIn(n);
    }
    return TEXT.status.title(title);
  }

  function refreshHud(): void {
    hud.score = results ? results.score : Math.round(stats.points + missionEarned);
    hud.combo = stats.combo;
    hud.multiplier = stats.multiplier;
    hud.hype = hype;
    hud.progress = progress;
    hud.mission = active ? active.view : null;
    hud.status = statusLine();
    hud.set = set.length ? { index: Math.min(heardIndex, set.length - 1), count: set.length } : null;
  }

  // ───────────────────────────── events ─────────────────────────────

  unsubs.push(
    engine.on('deck:play', ({ deck, perfMs }) => {
      const self = wasSelf('play', deck);
      ended[deck] = false;
      twGraceUntil = Math.max(twGraceUntil, sight.clock + TUNING.trainwreck.graceBeats);
      active?.rt.onPlay?.(deck, perfMs, self);
    }),
    engine.on('deck:pause', ({ deck }) => {
      wasSelf('pause', deck);
    }),
    engine.on('deck:end', ({ deck }) => {
      ended[deck] = true;
      active?.rt.onEnd?.(deck);
    }),
    engine.on('deck:load', ({ deck }) => {
      ended[deck] = false;
    }),
    engine.on('deck:sync', ({ deck, ok }) => {
      const self = wasSelf('sync', deck);
      if (!self && ok && transition) transition.usedSync = true;
      active?.rt.onSync?.(deck, ok, self);
    }),
    engine.on('deck:scratch', ({ active: held }) => {
      if (!held) twGraceUntil = Math.max(twGraceUntil, sight.clock + TUNING.trainwreck.graceBeats / 2);
    }),
    bus.on('judge', ({ judgment }) => {
      if (phase !== 'playing') return;
      if (judgment === 'miss') {
        if (active || transition || sight.clock < missGraceUntil) return;
        addHype(TUNING.hype.miss[difficulty]);
      } else {
        addHype(TUNING.hype.judge[judgment]);
        if (pads) pads.hits++;
      }
    }),
    bus.on('combo:milestone', ({ multiplier }) => {
      if (phase === 'playing') callout('combo', TEXT.callout.combo(multiplier), 'good');
    }),
  );

  // ───────────────────────────── public ─────────────────────────────

  async function prepare(onProgress?: ProgressFn): Promise<void> {
    const gen = ++generation;
    phase = 'loading';
    const stale = (): boolean => destroyed || gen !== generation;

    const ids: string[] = [];
    for (const id of params.setlist) if (library.get(id) && ids.length < 4) ids.push(id);
    // a gig needs two tracks: fill up from the library rather than refuse to start
    for (const meta of library.list()) {
      if (ids.length >= 2) break;
      if (!ids.includes(meta.id)) ids.push(meta.id);
    }
    if (ids.length === 0) throw new Error('[gig] there are no tracks to play');

    rhythm.setDifficulty(difficulty);
    rhythm.setDensity(0);
    density = 0;
    rhythm.reset();
    resetMixer(engine);

    const share = ids.length > 1 ? 0.5 : 1;
    const first = await library.load(ids[0], (p, stage) => onProgress?.(p * share, stage));
    if (stale()) return;
    await engine.loadTrack('A', first);
    if (stale()) return;
    const metas: TrackMeta[] = [first.meta];
    if (ids.length > 1) {
      const second = await library.load(ids[1], (p, stage) => onProgress?.(0.5 + p * 0.5, stage));
      if (stale()) return;
      await engine.loadTrack('B', second);
      if (stale()) return;
      metas.push(second.meta);
    }
    for (const id of ids.slice(2)) {
      const meta = library.get(id);
      if (meta) metas.push(meta);
    }
    resetMixer(engine);

    set = metas;
    setIndex = 0;
    heardIndex = 0;
    main = 'A';
    plan = null;
    replan();
    pending = null;
    phase = 'ready';
    onProgress?.(1);
  }

  function update(frame: FrameState): void {
    if (destroyed || phase === 'idle' || phase === 'loading' || phase === 'ended') return;
    try {
      tick(frame);
    } catch (err) {
      // a bug in here must never freeze the game: log it and carry on with the next frame
      console.error('[gig] update threw', err);
    }
    try {
      refreshHud();
    } catch (err) {
      console.error('[gig] hud threw', err);
    }
  }

  function tick(frame: FrameState): void {
    sight.now = frame.now;
    sight.dt = frame.dt;
    sight.decks = frame.decks;
    sight.mixer = frame.mixer;
    liveDeck = frame.liveDeck;
    if (frame.liveDeck && frame.bpm > 0) lastBpm = frame.bpm;
    sight.dtBeats = frame.dt * beatsPerSec();
    sight.clock += sight.dtBeats;
    readStats();

    if (phase === 'ready') {
      if (!active) startMission(createStartSet(env, main));
      else stepActive();
      if (!active && sight.decks[main].playing) startGig();
      return;
    }

    if (phase === 'ending') {
      gigSec += frame.dt;
      hypeSum += hype * frame.dt;
      endTail -= frame.dt;
      if (endTail <= 0) finalize();
      return;
    }

    // ── playing ──
    gigSec += frame.dt;
    updateTrouble();
    updateSections();
    if (transition) {
      transition.tracker.update();
      if (heardIndex === setIndex && liveDeck === transition.to) heardIndex = Math.min(setIndex + 1, set.length - 1);
    }
    if (tutorial) keepMusicGoing();
    stepActive();
    if (script) drive();
    else performing();
    if (phase !== 'playing') {
      if (endTail <= 0) finalize();
      return;
    }
    setDensity(wantDensity());

    // excitement fades back towards the resting level
    if (!tutorial && hype > TUNING.hype.rest) hype = damp(hype, TUNING.hype.rest, TUNING.hype.fadeHalfLifeSec, frame.dt);
    hypeSum += hype * frame.dt;
    if (hype > hypePeak) hypePeak = hype;
    while (sight.clock >= nextSampleClock) {
      hypeHistory.push(hype);
      nextSampleClock += BEATS_PER_BAR;
    }
    updateProgress();

    // club + festival: an empty dance floor ends the night
    if (canLose) {
      if (hype <= TUNING.hype.leaveBelow) {
        zeroSec += frame.dt;
        if (!leaveWarned && zeroSec >= TUNING.hype.leaveWarnSec) {
          leaveWarned = true;
          callout('info', TEXT.callout.leaving, 'bad');
        }
        if (zeroSec >= TUNING.hype.leaveAfterSec[difficulty]) {
          beginEnding(false);
          finalize();
          return;
        }
      } else {
        zeroSec = 0;
        leaveWarned = false;
      }
    }

    // curfew: no gig goes on for ever, whatever the player does
    if (!tutorial && gigSec > plannedSec * TUNING.end.curfewFactor + TUNING.end.curfewExtraSec) {
      callout('info', TEXT.callout.curfew, 'info');
      beginEnding(true);
    }
  }

  return {
    prepare,
    loadTrack() {
      return Promise.reject(new Error('[gig] the gig picks the tracks: loadTrack is for free play'));
    },
    update,
    getHud: () => hud,
    get ended() {
      return phase === 'ended';
    },
    getResults: () => results ?? buildResults(false),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      generation++;
      for (const fn of unsubs) fn();
      unsubs.length = 0;
      script = null;
      active = null;
      transition = null;
    },
  };
}
