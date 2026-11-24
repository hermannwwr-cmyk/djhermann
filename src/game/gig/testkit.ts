/**
 * Test kit for the gig director: a mock engine on a hand-driven clock, an instant mock library,
 * a fake rhythm playfield, the real frame loop, and "bot" players that act through the engine
 * exactly as the console UI would. Used by the *.test.ts files only; nothing here ships.
 */
import { createGameBus } from '../../core/events';
import type { GameBus } from '../../core/events';
import { createFrameLoop } from '../../core/frame';
import type { FrameLoop } from '../../core/frame';
import { rng } from '../../core/math';
import { createSettings } from '../../core/settings';
import { BEATS_PER_BAR, TEMPO_MAX, TEMPO_MIN } from '../../core/types';
import type {
  ControlId,
  DeckId,
  Difficulty,
  FrameState,
  GameEvents,
  GameMode,
  GigController,
  Judgment,
  Lane,
  Library,
  LoadedTrack,
  MissionTarget,
  RhythmController,
  RhythmStats,
  SettingsStore,
  TrackMeta,
} from '../../core/types';
import { createMockEngine } from '../../dev/mock-engine';
import type { MockEngine } from '../../dev/mock-engine';
import { MOCK_CATALOG, mockMeta, mockTrack } from '../../dev/mocks';
import { createGig } from './index';

// ───────────────────────────── fakes ─────────────────────────────

export interface FakeRhythm extends RhythmController {
  density: number;
  difficulty: Difficulty | null;
  /** judge one note (the bot decides how well it was hit) */
  judge(j: Judgment): void;
}

const POINTS: Record<Judgment, number> = { perfect: 300, great: 200, good: 100, miss: 0 };
const WEIGHT: Record<Judgment, number> = { perfect: 1, great: 0.7, good: 0.4, miss: 0 };

export function createFakeRhythm(bus: GameBus): FakeRhythm {
  let stats: RhythmStats = blank();
  let weight = 0;
  function blank(): RhythmStats {
    return { perfect: 0, great: 0, good: 0, miss: 0, combo: 0, maxCombo: 0, multiplier: 1, points: 0, accuracy: 1 };
  }
  const r: FakeRhythm = {
    el: null as unknown as HTMLElement,
    density: 0,
    difficulty: null,
    setDifficulty(d) {
      r.difficulty = d;
    },
    setDensity(d) {
      r.density = d;
    },
    getStats: () => ({ ...stats }),
    reset() {
      stats = blank();
      weight = 0;
    },
    update() {},
    destroy() {},
    judge(j) {
      stats[j]++;
      if (j === 'miss') {
        if (stats.combo > 0) bus.emit('combo:break', { combo: stats.combo });
        stats.combo = 0;
      } else stats.combo++;
      stats.maxCombo = Math.max(stats.maxCombo, stats.combo);
      const mult = stats.combo >= 30 ? 4 : stats.combo >= 20 ? 3 : stats.combo >= 10 ? 2 : 1;
      if (mult > stats.multiplier) bus.emit('combo:milestone', { combo: stats.combo, multiplier: mult });
      stats.multiplier = mult;
      const pts = POINTS[j] * mult;
      stats.points += pts;
      weight += WEIGHT[j];
      const n = stats.perfect + stats.great + stats.good + stats.miss;
      stats.accuracy = weight / n;
      bus.emit('judge', {
        lane: (n % 4) as Lane,
        judgment: j,
        errorMs: 0,
        combo: stats.combo,
        multiplier: stats.multiplier,
        points: pts,
      });
    },
  };
  return r;
}

/** A library over the mock catalog whose loads resolve on the next microtask. */
export function createInstantLibrary(extra: TrackMeta[] = [], failIds: string[] = []): Library {
  const metas = [...MOCK_CATALOG, ...extra];
  const cache = new Map<string, LoadedTrack>();
  return {
    list: () => [...metas],
    get: (id) => metas.find((m) => m.id === id),
    async load(id, onProgress) {
      if (failIds.includes(id)) throw new Error(`cannot load ${id}`);
      const meta = metas.find((m) => m.id === id);
      if (!meta) throw new Error(`unknown track ${id}`);
      let t = cache.get(id);
      if (!t) {
        t = mockTrack(meta);
        cache.set(id, t);
      }
      onProgress?.(1);
      return t;
    },
    importFile: () => Promise.reject(new Error('no')),
    setGrid: () => Promise.reject(new Error('no')),
    remove: async () => {},
    subscribe: () => () => {},
  };
}

/** A short track (32 bars) at a given tempo, for tests that do not need a whole set. */
export function shortMeta(id: string, bpm: number): TrackMeta {
  const m = mockMeta(id, `Short ${id}`, bpm, 10, 200);
  const sections = [
    { kind: 'intro' as const, startBar: 0, bars: 8, energy: 0.4 },
    { kind: 'build' as const, startBar: 8, bars: 4, energy: 0.7 },
    { kind: 'drop' as const, startBar: 12, bars: 12, energy: 1 },
    { kind: 'outro' as const, startBar: 24, bars: 8, energy: 0.4 },
  ];
  return { ...m, sections, durationSec: 0.05 + (32 * BEATS_PER_BAR * 60) / bpm + 1 };
}

// ───────────────────────────── the simulation ─────────────────────────────

export interface SimOptions {
  mode?: GameMode;
  setlist?: string[];
  difficulty?: Difficulty;
  tutorial?: boolean;
  library?: Library;
  fps?: number;
}

export interface Sim {
  engine: MockEngine;
  bus: GameBus;
  rhythm: FakeRhythm;
  settings: SettingsStore;
  gig: GigController;
  loop: FrameLoop;
  events: { [K in keyof GameEvents]: GameEvents[K][] };
  /** simulated ms clock */
  readonly t: number;
  readonly frames: number;
  /** violations of the per-frame invariants */
  violations: string[];
  /** console.error calls made by the gig */
  errors: unknown[][];
  /** run one frame (plus pending promise callbacks) */
  frame(): Promise<FrameState>;
  /** run frames until `until` is true or `maxSec` of simulated time passed */
  run(maxSec: number, onFrame?: (f: FrameState) => void, until?: () => boolean): Promise<void>;
  /** prepare() with promise flushing */
  prepare(): Promise<void>;
  restoreConsole(): void;
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

export async function createSim(o: SimOptions = {}): Promise<Sim> {
  let t = 1000;
  let frames = 0;
  const dtMs = 1000 / (o.fps ?? 60);
  const engine = createMockEngine({ now: () => t });
  await engine.unlock();
  const bus = createGameBus();
  const rhythm = createFakeRhythm(bus);
  const store = new Map<string, string>();
  const settings = createSettings({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) });
  const library = o.library ?? createInstantLibrary();
  const gig = createGig({
    engine,
    bus,
    library,
    rhythm,
    settings,
    params: {
      mode: o.mode ?? 'gig',
      setlist: o.setlist ?? ['mock-golden', 'mock-lanterns', 'mock-coast'],
      difficulty: o.difficulty ?? 'chill',
      tutorial: o.tutorial,
    },
  });
  const loop = createFrameLoop(engine, () => gig.getHud());
  loop.add((f) => gig.update(f), 'logic');

  const events = {} as Sim['events'];
  const kinds: (keyof GameEvents)[] = [
    'pad',
    'judge',
    'combo:break',
    'combo:milestone',
    'mission:start',
    'mission:end',
    'callout',
    'section',
    'gig:start',
    'gig:end',
  ];
  for (const k of kinds) {
    const list: unknown[] = [];
    (events as Record<string, unknown[]>)[k] = list;
    bus.on(k, (e) => void list.push(e));
  }

  const violations: string[] = [];
  const errors: unknown[][] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };

  function check(): void {
    let hud;
    try {
      hud = gig.getHud();
    } catch (err) {
      violations.push(`getHud threw: ${String(err)}`);
      return;
    }
    if (!(hud.hype >= 0 && hud.hype <= 1)) violations.push(`hype out of range: ${hud.hype}`);
    if (hud.mission) {
      if (hud.mission.targets.length < 1) violations.push(`mission ${hud.mission.kind} has no target`);
      if (!hud.mission.hint.trim()) violations.push(`mission ${hud.mission.kind} has no hint`);
      if (!hud.mission.title.trim()) violations.push(`mission ${hud.mission.kind} has no title`);
      if (!(hud.mission.timeLeft >= 0 && hud.mission.timeLeft <= 1)) violations.push(`timeLeft ${hud.mission.timeLeft}`);
      const p = hud.mission.progress;
      if (p !== null && !(p >= 0 && p <= 1)) violations.push(`progress ${p}`);
    }
    if (hud.progress !== null && !(hud.progress >= 0 && hud.progress <= 1)) violations.push(`gig progress ${hud.progress}`);
    if (!Number.isFinite(hud.score)) violations.push(`score ${hud.score}`);
    if (violations.length > 50) violations.length = 50;
  }

  const sim: Sim = {
    engine,
    bus,
    rhythm,
    settings,
    gig,
    loop,
    events,
    get t() {
      return t;
    },
    get frames() {
      return frames;
    },
    violations,
    errors,
    async frame() {
      t += dtMs;
      frames++;
      const f = loop.tick(t);
      check();
      if (frames % 4 === 0) await flush();
      else await Promise.resolve();
      return f;
    },
    async run(maxSec, onFrame, until) {
      const end = t + maxSec * 1000;
      while (t < end) {
        if (until?.()) return;
        const f = await sim.frame();
        onFrame?.(f);
      }
    },
    async prepare() {
      const p = gig.prepare();
      for (let i = 0; i < 50; i++) await flush();
      await p;
    },
    restoreConsole() {
      console.error = origError;
    },
  };
  return sim;
}

// ───────────────────────────── bots ─────────────────────────────

export interface Bot {
  act(f: FrameState): void;
}

const deckOf = (c: ControlId): DeckId => (c === 'xfader' ? 'A' : (c[0] as DeckId));

/** Plays notes: on every beat of the live deck with density > 0, judges one note. */
export function createNotePlayer(sim: Sim, pick: () => Judgment): Bot {
  let lastBeat = -1;
  return {
    act(f) {
      if (!f.liveDeck || sim.rhythm.density <= 0) {
        lastBeat = -1;
        return;
      }
      const b = Math.floor(f.beat);
      if (lastBeat >= 0 && b !== lastBeat) sim.rhythm.judge(pick());
      lastBeat = b;
    },
  };
}

/**
 * Does every mission promptly and well, the way a good DJ would: presses PLAY on the one,
 * matches by hand (or with SYNC when asked), crossfades over two bars with a bass swap, drops the
 * bass on the downbeat, sweeps the filter slowly, scratches briskly, echoes out.
 */
export function createPerfectBot(sim: Sim, o: { manual: boolean }): Bot {
  const e = sim.engine;
  let missionId = -1;
  let state: Record<string, number> = {};
  let prevRefBeat: number | null = null;
  return {
    act(f) {
      const m = f.hud.mission;
      // let go of the record unless a scratch is asked for
      for (const id of ['A', 'B'] as DeckId[]) {
        if (f.decks[id].scratching && (!m || m.kind !== 'scratch' || m.targets[0].gesture !== 'scratch')) e.scratchEnd(id);
      }
      if (!m) {
        missionId = -1;
        return;
      }
      if (m.id !== missionId) {
        missionId = m.id;
        state = {};
        prevRefBeat = null;
      }
      const target = m.targets[0];
      const deck = deckOf(target.control);
      const d = f.decks[deck];
      if (m.title === 'BRING THE MUSIC BACK') {
        follow(sim, f, target);
        return;
      }
      switch (m.kind) {
        case 'start-set':
          e.play(deck);
          break;
        case 'start-deck': {
          if (!m.hint.includes('NOW') && !m.hint.includes('…')) {
            // recover prompt or nothing to count with: just press it
            e.play(deck);
            break;
          }
          const other = f.decks[deck === 'A' ? 'B' : 'A'];
          const rb = other.beat;
          if (prevRefBeat !== null && Math.floor(rb / 4) !== Math.floor(prevRefBeat / 4)) e.play(deck);
          prevRefBeat = rb;
          break;
        }
        case 'beatmatch': {
          const ref = f.decks[deck === 'A' ? 'B' : 'A'];
          if (!d.playing) {
            e.play(deck);
            break;
          }
          if (!o.manual) {
            if (!state.synced) {
              state.synced = 1;
              e.sync(deck);
            }
            break;
          }
          if (!d.track || !ref.track) break;
          const want = Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, ref.bpm / d.track.grid.bpm));
          if (Math.abs(d.tempo - want) > 1e-6) e.setTempo(deck, want);
          // phase: positive = this deck is ahead → bend it down
          let ph = (((d.beat - ref.beat) % 1) + 1) % 1;
          if (ph > 0.5) ph -= 1;
          const ms = (ph * 60000) / ref.bpm;
          if (Math.abs(ms) < 4) e.setNudge(deck, 0);
          else e.setNudge(deck, ms > 0 ? -1 : 1);
          break;
        }
        case 'crossfade': {
          if (target.control.endsWith('.fader')) {
            e.setFader(deck, 1);
            break;
          }
          if (target.control.endsWith('.play')) {
            e.play(deck);
            break;
          }
          if (target.control.endsWith('.eq.low')) {
            for (const b of ['low', 'mid', 'high'] as const) e.setEq(deck, b, 0.5);
            break;
          }
          if (target.control.endsWith('.platter')) {
            e.scratchEnd(deck);
            break;
          }
          const dir = target.gesture === 'right' ? 1 : -1;
          const to: DeckId = dir > 0 ? 'B' : 'A';
          const from: DeckId = to === 'A' ? 'B' : 'A';
          if (state.x === undefined) {
            state.x = f.mixer.crossfader;
            e.setEq(from, 'low', 0); // bass swap
          }
          state.x += (dir * 2 * ((f.bpm || 120) / 60) * f.dt) / 8; // end to end in about 8 beats
          state.x = Math.max(-1, Math.min(1, state.x));
          e.setCrossfader(state.x);
          break;
        }
        case 'stop-deck':
          if (d.playing) e.pause(deck);
          break;
        case 'bass-drop': {
          if (!d.track) break;
          if (target.gesture === 'turn-left') {
            e.setEq(deck, 'low', 0);
            break;
          }
          // the next drop's downbeat
          const drop = d.track.sections.find((s) => s.kind === 'drop' && s.startBar * 4 > d.beat - 3);
          if (!drop || d.beat >= drop.startBar * 4 - 0.02 || m.hint.startsWith('Now turn')) e.setEq(deck, 'low', 0.5);
          break;
        }
        case 'filter-sweep': {
          state.f = state.f ?? 0;
          if (target.gesture === 'turn-left' && !state.back) state.f = Math.max(-0.8, state.f - 0.8 / (3 * 30));
          else {
            state.back = 1;
            state.f = Math.min(0, state.f + 0.8 / (3 * 30));
          }
          if (state.f <= -0.8) state.back = 1;
          e.setFilter(deck, state.f);
          break;
        }
        case 'scratch': {
          if (target.gesture !== 'scratch') break;
          state.n = (state.n ?? 0) + 1;
          if (!d.scratching) e.scratchStart(deck);
          if (state.n % 6 === 0) e.scratchMove(deck, (Math.floor(state.n / 6) % 2 ? -1 : 1) * 0.08);
          break;
        }
        case 'echo-out':
          if (!f.mixer.channels[deck].echo) e.setEcho(deck, true);
          else if (d.playing) e.pause(deck);
          break;
      }
    },
  };
}

/** Does what a target says, once. */
export function follow(sim: Sim, f: FrameState, target: MissionTarget): void {
  const e = sim.engine;
  const c = target.control;
  const deck = deckOf(c);
  if (c === 'xfader') e.setCrossfader(target.gesture === 'right' ? 1 : -1);
  else if (c.endsWith('.play')) {
    if (!f.decks[deck].playing) e.play(deck);
  } else if (c.endsWith('.fader')) e.setFader(deck, 1);
  else if (c.endsWith('.platter')) e.scratchEnd(deck);
  else if (c.includes('.eq.')) for (const b of ['low', 'mid', 'high'] as const) e.setEq(deck, b, 0.5);
}

/** Follows the guide literally and slowly, after waiting `waitSec` on every new step. */
export function createPatientBot(sim: Sim, waitSec: number): Bot {
  const inner = createPerfectBot(sim, { manual: false });
  let key = '';
  let since = 0;
  return {
    act(f) {
      const m = f.hud.mission;
      const k = m ? `${m.id}:${m.targets.map((x) => x.control + x.gesture).join()}` : '';
      if (k !== key) {
        key = k;
        since = 0;
      }
      since += f.dt;
      if (since >= waitSec) inner.act(f);
      else for (const id of ['A', 'B'] as DeckId[]) if (f.decks[id].scratching) sim.engine.scratchEnd(id);
    },
  };
}

/** Random control moves, stops, scratches, syncs. Seeded. */
export function createChaosBot(sim: Sim, seed: number): Bot {
  const e = sim.engine;
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const scratching: Record<DeckId, number> = { A: 0, B: 0 };
  const nudging: Record<DeckId, number> = { A: 0, B: 0 };
  const cue: Record<DeckId, number> = { A: 0, B: 0 };
  return {
    act(f) {
      for (const d of ['A', 'B'] as DeckId[]) {
        if (scratching[d] > 0) {
          scratching[d]--;
          e.scratchMove(d, (r() - 0.5) * 0.3);
          if (scratching[d] === 0) e.scratchEnd(d);
        }
        if (nudging[d] > 0 && --nudging[d] === 0) e.setNudge(d, 0);
        if (cue[d] > 0 && --cue[d] === 0) e.cueUp(d);
      }
      if (r() > 0.06) return;
      const d = pick(['A', 'B'] as const);
      switch (Math.floor(r() * 14)) {
        case 0:
          e.togglePlay(d);
          break;
        case 1:
          e.setEq(d, pick(['low', 'mid', 'high'] as const), pick([0, 0.5, 1, r()]));
          break;
        case 2:
          e.setFilter(d, pick([-1, 0, 1, r() * 2 - 1]));
          break;
        case 3:
          e.setFader(d, pick([0, 1, r()]));
          break;
        case 4:
          e.setCrossfader(pick([-1, 0, 1, r() * 2 - 1]));
          break;
        case 5:
          e.setTempo(d, TEMPO_MIN + r() * (TEMPO_MAX - TEMPO_MIN));
          break;
        case 6:
          e.setNudge(d, pick([-1, 1]));
          nudging[d] = Math.floor(r() * 60);
          break;
        case 7:
          e.scratchStart(d);
          scratching[d] = Math.floor(r() * (r() < 0.1 ? 3600 : 120)) + 1;
          break;
        case 8:
          e.sync(d);
          break;
        case 9:
          e.cueDown(d);
          cue[d] = Math.floor(r() * 30) + 1;
          break;
        case 10:
          e.setEcho(d, r() < 0.5);
          break;
        case 11:
          // follow the guide now and then
          {
            const m = f.hud.mission;
            if (m && m.targets[0].control.endsWith('.play')) e.togglePlay(deckOf(m.targets[0].control));
          }
          break;
        default:
          break;
      }
    },
  };
}
