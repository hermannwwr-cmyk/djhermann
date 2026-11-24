/**
 * Free play: no missions, no score, nothing ends. The decks are the player's. Hype follows how the
 * two decks are mixed, purely as feedback.
 */
import { phaseOffsetMs, sectionAtBeat } from '../../core/beatgrid';
import { clamp01, damp } from '../../core/math';
import { BEATS_PER_BAR } from '../../core/types';
import type { DeckId, FrameState, GigController, GigResults, HudState, ProgressFn } from '../../core/types';
import { clashes, createTrainwreckDetector } from './detectors';
import type { GigDeps } from './director';
import { TEXT } from './text';
import { TUNING } from './tuning';
import { heard, resetMixer, runs, sounding } from './world';
import type { Sight } from './world';

export function createFreePlay(deps: GigDeps): GigController {
  const { engine, bus, library, rhythm, params } = deps;
  const F = TUNING.free;
  let destroyed = false;
  let hype: number = TUNING.hype.start;
  let clock = 0;
  let lastBpm: number = TUNING.fallbackBpm;
  let graceUntil = 0;
  let blendBeats = 0;
  let inTheMix = false;
  let lastSectionKey = '';
  let lastLiveBeat = 0;
  const loads: Record<DeckId, number> = { A: 0, B: 0 };
  const trainwreck = createTrainwreckDetector();
  const sight: Sight = {
    now: 0,
    dt: 0,
    clock: 0,
    dtBeats: 0,
    decks: { A: engine.getDeck('A'), B: engine.getDeck('B') },
    mixer: engine.getMixer(),
  };
  const hud: HudState = {
    mode: 'free',
    score: 0,
    combo: 0,
    multiplier: 1,
    hype,
    progress: null,
    mission: null,
    status: TEXT.status.freeIdle,
    set: null,
  };

  const unsubs = [
    engine.on('deck:play', () => {
      graceUntil = clock + TUNING.trainwreck.graceBeats;
    }),
    engine.on('deck:scratch', ({ active }) => {
      if (!active) graceUntil = Math.max(graceUntil, clock + TUNING.trainwreck.graceBeats / 2);
    }),
  ];

  async function loadTrack(deck: DeckId, trackId: string, onProgress?: ProgressFn): Promise<void> {
    const ticket = ++loads[deck];
    engine.pause(deck);
    const track = await library.load(trackId, onProgress);
    // a newer request for this deck (or the end of the session) wins
    if (destroyed || ticket !== loads[deck]) return;
    engine.pause(deck);
    await engine.loadTrack(deck, track);
  }

  return {
    async prepare(onProgress) {
      rhythm.setDifficulty(params.difficulty);
      rhythm.setDensity(0);
      rhythm.reset();
      resetMixer(engine);
      const tracks = library.list().slice(0, 2);
      const decks: DeckId[] = ['A', 'B'];
      for (let i = 0; i < tracks.length; i++) {
        const share = 1 / tracks.length;
        await loadTrack(decks[i], tracks[i].id, (p, stage) => onProgress?.((i + p) * share, stage));
        if (destroyed) return;
      }
      resetMixer(engine);
      onProgress?.(1);
    },
    loadTrack,
    update(frame: FrameState) {
      if (destroyed) return;
      sight.now = frame.now;
      sight.dt = frame.dt;
      sight.decks = frame.decks;
      sight.mixer = frame.mixer;
      if (frame.liveDeck && frame.bpm > 0) lastBpm = frame.bpm;
      const dtBeats = (frame.dt * lastBpm) / 60;
      clock += dtBeats;
      sight.clock = clock;
      sight.dtBeats = dtBeats;
      const a = frame.decks.A;
      const b = frame.decks.B;

      const both =
        heard(a, frame.mixer.channels.A) >= F.blendAudible &&
        heard(b, frame.mixer.channels.B) >= F.blendAudible &&
        runs(a) &&
        runs(b);
      const bpmDiff = a.bpm - b.bpm;
      const offsetMs = both ? phaseOffsetMs(a, b) : 0;
      if (a.scratching || b.scratching) graceUntil = Math.max(graceUntil, clock + TUNING.trainwreck.graceBeats / 2);
      const edge = trainwreck.update({ dtBeats, bothAudible: both, bpmDiff, offsetMs, grace: clock < graceUntil });
      if (edge === 'start') bus.emit('callout', { kind: 'trainwreck', text: TEXT.callout.trainwreck, tone: 'bad' });

      // a clean blend held for a few bars gets a nod
      if (both && !clashes(bpmDiff, offsetMs)) {
        blendBeats += dtBeats;
        if (!inTheMix && blendBeats >= F.blendBeats) {
          inTheMix = true;
          bus.emit('callout', { kind: 'mix', text: TEXT.callout.inTheMix, tone: 'good' });
        }
      } else {
        blendBeats = 0;
        if (!both) inTheMix = false;
      }

      const anySound = sounding(sight, 'A') || sounding(sight, 'B');
      const target = trainwreck.active ? F.wreck : !anySound ? F.silent : both ? F.blend : F.solo;
      hype = clamp01(damp(hype, target, F.halfLifeSec, frame.dt));

      // sections and drops of whatever the crowd hears, for the lights
      const live = frame.liveDeck;
      const d = live ? frame.decks[live] : null;
      if (live && d && d.track && !d.scratching) {
        const sec = sectionAtBeat(d.track, d.beat);
        const key = `${live}:${d.track.id}:${sec ? sec.startBar : -1}`;
        if (key !== lastSectionKey) {
          const sameTrack = lastSectionKey.startsWith(`${live}:${d.track.id}:`);
          lastSectionKey = key;
          if (sec) {
            bus.emit('section', { deck: live, kind: sec.kind, energy: sec.energy });
            const startBeat = sec.startBar * BEATS_PER_BAR;
            if (sec.kind === 'drop' && sameTrack && d.playing && lastLiveBeat < startBeat && d.beat - startBeat < 2) {
              bus.emit('callout', { kind: 'drop', text: TEXT.callout.drop, tone: 'good' });
            }
          }
        }
        lastLiveBeat = d.beat;
      }

      hud.hype = hype;
      hud.status = trainwreck.active
        ? TEXT.status.trainwreck
        : inTheMix
          ? TEXT.status.inTheMix
          : d && d.track && anySound
            ? TEXT.status.title(d.track.title)
            : a.track || b.track
              ? TEXT.status.freeIdle
              : TEXT.status.freeEmpty;
    },
    getHud: () => hud,
    get ended() {
      return false;
    },
    getResults(): GigResults {
      return {
        completed: false,
        score: 0,
        grade: 'D',
        stars: 0,
        rhythm: rhythm.getStats(),
        missions: [],
        hypeAvg: hype,
        hypePeak: hype,
        hypeHistory: [],
        trainwrecks: trainwreck.count,
        deadAirSec: 0,
        setlist: [],
        difficulty: params.difficulty,
        durationSec: 0,
      };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const fn of unsubs) fn();
    },
  };
}
