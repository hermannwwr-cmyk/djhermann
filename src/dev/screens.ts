/**
 * Dev harness for the menus (src/ui/screens): the real screens on a mock engine and a mock library.
 * Open http://localhost:5188/dev/screens.html
 *
 * Query parameters (all optional):
 *   s=title|home|setup|library|settings|calibrate|howto|results|game|loading|picker   start screen
 *   case=s|a|c|left|tutorial        which fake results to show (s=results)
 *   p=0.4                           progress of the loading overlay (s=loading)
 *   reset=1                         forget saved settings first
 *   set={"tutorialDone":true}       patch the settings (JSON)
 *   user=2                          start with N tracks of "my music" already in the library
 *   delay=600                       mock library delay in ms (an import takes twice this)
 *   sound=1                         make the silent mock engine beep, so calibration can be tried by ear
 *
 * Everything is on window.__sc for Playwright.
 */
import '../styles/base.css';
import { loadFonts } from '../core/fonts';
import { createNav } from '../core/nav';
import { createSettings } from '../core/settings';
import type {
  AppContext,
  BeatGrid,
  Difficulty,
  GameParams,
  GigResults,
  Library,
  MissionResult,
  Screen,
  Settings,
  TrackMeta,
} from '../core/types';
import { createAmbientBackground, createLoadingOverlay, openTrackPicker, registerScreens } from '../ui/screens';
import { createMockEngine } from './mock-engine';
import type { MockEngine } from './mock-engine';
import { createMockLibrary, mockMeta, mockTrack } from './mocks';

const q = new URLSearchParams(location.search);

function div(className: string, parent: HTMLElement): HTMLDivElement {
  const d = document.createElement('div');
  d.className = className;
  parent.appendChild(d);
  return d;
}

/** The mock library plus some "my music" that is there from the start (no waiting for fake imports). */
function withUserTracks(lib: Library, extra: TrackMeta[]): Library {
  const mine = [...extra];
  const subs = new Set<() => void>();
  const changed = (): void => {
    for (const fn of [...subs]) fn();
  };
  lib.subscribe(changed);
  return {
    list() {
      const all = lib.list();
      return [...all.filter((m) => m.source === 'builtin'), ...all.filter((m) => m.source === 'user').reverse(), ...mine];
    },
    get: (id) => mine.find((m) => m.id === id) ?? lib.get(id),
    async load(id, onProgress) {
      const meta = mine.find((m) => m.id === id);
      if (!meta) return lib.load(id, onProgress);
      for (let i = 1; i <= 4; i++) {
        await new Promise((r) => setTimeout(r, 120));
        onProgress?.(i / 4, i < 3 ? 'Reading your file' : 'Finding the beat');
      }
      return mockTrack(meta);
    },
    importFile: (file, onProgress) => lib.importFile(file, onProgress),
    async setGrid(id, grid: BeatGrid) {
      const i = mine.findIndex((m) => m.id === id);
      if (i < 0) return lib.setGrid(id, grid);
      mine[i] = { ...mine[i], grid };
      changed();
      return mine[i];
    },
    async remove(id) {
      const i = mine.findIndex((m) => m.id === id);
      if (i < 0) return lib.remove(id);
      mine.splice(i, 1);
      changed();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}

/** Give the silent mock engine a voice: a short blip for every playSound, at the scheduled time. */
function addBeeps(engine: MockEngine): void {
  let audio: AudioContext | null = null;
  const unlock = engine.unlock.bind(engine);
  engine.unlock = async () => {
    audio ??= new AudioContext({ latencyHint: 'interactive' });
    await audio.resume();
    return unlock();
  };
  const play = engine.playSound.bind(engine);
  engine.playSound = (name, opts) => {
    play(name, opts);
    if (!audio) return;
    const delay = Math.max(0, (opts?.atCtxTime ?? engine.ctxTime()) - engine.ctxTime());
    const t = audio.currentTime + delay;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = name === 'tick' ? 1760 : name === 'tock' ? 1175 : 660;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.5 * (opts?.gain ?? 1), t + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    osc.connect(gain).connect(audio.destination);
    osc.start(t);
    osc.stop(t + 0.08);
  };
}

type ResultCase = 's' | 'a' | 'c' | 'left' | 'tutorial';

const mission = (kind: MissionResult['kind'], title: string, rating: MissionResult['rating'], points: number, label: string): MissionResult => ({
  kind,
  title,
  rating,
  points,
  label,
});

/** Plausible results for every kind of ending. */
function fakeResults(kind: ResultCase, params: GameParams, library: Library): GigResults {
  const setlist = params.setlist.map((id) => ({ id, title: library.get(id)?.title ?? id }));
  const wave = (n: number, fn: (t: number) => number): number[] =>
    Array.from({ length: n }, (_, i) => Math.min(1, Math.max(0, fn(i / (n - 1)))));
  const base = { setlist, difficulty: params.difficulty, durationSec: 236 };

  if (kind === 's') {
    return {
      ...base,
      completed: true,
      score: 128450,
      grade: 'S',
      stars: 5,
      rhythm: { perfect: 212, great: 31, good: 6, miss: 2, combo: 44, maxCombo: 148, multiplier: 4, points: 86200, accuracy: 0.968 },
      missions: [
        mission('start-set', 'START THE SET', 'perfect', 1000, 'ON THE ONE'),
        mission('start-deck', 'START DECK B', 'perfect', 1500, 'RIGHT ON THE BEAT'),
        mission('beatmatch', 'MATCH THE SPEED', 'perfect', 3000, 'BY HAND'),
        mission('crossfade', 'CROSSFADE TO DECK B', 'perfect', 2500, 'SMOOTH MIX'),
        mission('bass-drop', 'KILL THE BASS, THEN DROP IT', 'great', 2400, 'A HAIR EARLY'),
        mission('scratch', 'SCRATCH DECK B', 'perfect', 2000, 'CLEAN CUTS'),
        mission('filter-sweep', 'SWEEP THE FILTER', 'perfect', 2000, 'FULL SWEEP'),
        mission('crossfade', 'CROSSFADE TO DECK A', 'great', 2000, 'BASS SWAP'),
      ],
      hypeAvg: 0.86,
      hypePeak: 1,
      hypeHistory: wave(64, (t) => 0.42 + 0.5 * Math.pow(t, 0.55) + 0.08 * Math.sin(t * 22) - (t > 0.55 && t < 0.62 ? 0.12 : 0)),
      trainwrecks: 0,
      deadAirSec: 0,
    };
  }
  if (kind === 'a') {
    return {
      ...base,
      completed: true,
      score: 96300,
      grade: 'A',
      stars: 4,
      rhythm: { perfect: 150, great: 62, good: 22, miss: 11, combo: 12, maxCombo: 84, multiplier: 2, points: 61200, accuracy: 0.89 },
      missions: [
        mission('start-set', 'START THE SET', 'perfect', 1000, 'ON THE ONE'),
        mission('start-deck', 'START DECK B', 'great', 1200, 'A TOUCH LATE'),
        mission('beatmatch', 'MATCH THE SPEED', 'great', 2200, 'BY HAND'),
        mission('crossfade', 'CROSSFADE TO DECK B', 'perfect', 2500, 'SMOOTH MIX'),
        mission('bass-drop', 'KILL THE BASS, THEN DROP IT', 'ok', 1200, 'LATE DROP'),
        mission('scratch', 'SCRATCH DECK B', 'perfect', 2000, 'CLEAN CUTS'),
      ],
      hypeAvg: 0.71,
      hypePeak: 0.94,
      hypeHistory: wave(64, (t) => 0.45 + 0.3 * t + 0.14 * Math.sin(t * 13)),
      trainwrecks: 0,
      deadAirSec: 1.2,
    };
  }
  if (kind === 'c') {
    return {
      ...base,
      completed: true,
      score: 41200,
      grade: 'C',
      stars: 2,
      rhythm: { perfect: 64, great: 71, good: 48, miss: 39, combo: 3, maxCombo: 23, multiplier: 1, points: 27400, accuracy: 0.71 },
      missions: [
        mission('start-set', 'START THE SET', 'great', 800, 'A TOUCH LATE'),
        mission('start-deck', 'START DECK B', 'ok', 600, 'OFF THE BEAT'),
        mission('beatmatch', 'MATCH THE SPEED', 'ok', 900, 'USED SYNC'),
        mission('crossfade', 'CROSSFADE TO DECK B', 'great', 1800, 'A BIT QUICK'),
        mission('bass-drop', 'KILL THE BASS, THEN DROP IT', 'fail', 0, 'MISSED THE DROP'),
        mission('scratch', 'SCRATCH DECK B', 'ok', 700, 'TOO SHY'),
        mission('filter-sweep', 'SWEEP THE FILTER', 'fail', 0, 'RAN OUT OF TIME'),
      ],
      hypeAvg: 0.48,
      hypePeak: 0.74,
      hypeHistory: wave(64, (t) => 0.5 + 0.18 * Math.sin(t * 9) - 0.2 * Math.exp(-Math.pow((t - 0.6) * 9, 2)) + 0.06 * Math.sin(t * 31)),
      trainwrecks: 2,
      deadAirSec: 6.5,
    };
  }
  if (kind === 'left') {
    return {
      ...base,
      durationSec: 96,
      completed: false,
      score: 12300,
      grade: 'D',
      stars: 0,
      rhythm: { perfect: 21, great: 30, good: 25, miss: 47, combo: 0, maxCombo: 11, multiplier: 1, points: 9100, accuracy: 0.52 },
      missions: [
        mission('start-set', 'START THE SET', 'great', 800, 'A TOUCH LATE'),
        mission('start-deck', 'START DECK B', 'fail', 0, 'NEVER STARTED'),
        mission('beatmatch', 'MATCH THE SPEED', 'fail', 0, 'BEATS CLASHED'),
      ],
      hypeAvg: 0.27,
      hypePeak: 0.55,
      hypeHistory: wave(28, (t) => 0.5 + 0.06 * Math.sin(t * 10) - 0.55 * Math.pow(t, 1.6)),
      trainwrecks: 4,
      deadAirSec: 14.2,
    };
  }
  return {
    ...base,
    durationSec: 141,
    completed: true,
    score: 18400,
    grade: 'A',
    stars: 4,
    rhythm: { perfect: 30, great: 14, good: 6, miss: 4, combo: 9, maxCombo: 21, multiplier: 1, points: 9800, accuracy: 0.86 },
    missions: [
      mission('start-set', 'START THE SET', 'perfect', 1000, 'ON THE ONE'),
      mission('start-deck', 'START DECK B', 'great', 1200, 'NICE'),
      mission('beatmatch', 'MATCH THE SPEED', 'great', 1500, 'USED SYNC'),
      mission('crossfade', 'CROSSFADE TO DECK B', 'perfect', 2500, 'SMOOTH MIX'),
      mission('bass-drop', 'KILL THE BASS, THEN DROP IT', 'ok', 900, 'GOT THERE'),
      mission('scratch', 'SCRATCH DECK B', 'great', 1500, 'NICE'),
    ],
    hypeAvg: 0.7,
    hypePeak: 0.9,
    hypeHistory: wave(40, (t) => 0.5 + 0.35 * t),
    trainwrecks: 0,
    deadAirSec: 0,
  };
}

/** Stands in for the lead's game screen: shows what it was started with and can end the gig. */
function createStubGame(ctx: AppContext, overlays: HTMLElement): Screen<GameParams> {
  const el = document.createElement('div');
  el.style.cssText =
    'display:flex;flex-direction:column;gap:12px;padding:calc(24px + var(--safe-top)) 20px 24px;background:var(--bg-1);overflow:auto';
  let params: GameParams = { mode: 'free', setlist: [], difficulty: 'chill' };
  const pre = document.createElement('pre');
  pre.id = 'stub-params';
  pre.style.cssText =
    'margin:0;padding:14px;border-radius:14px;background:#000;border:1px solid var(--line);font:600 12px/1.5 ui-monospace,monospace;color:var(--mint);white-space:pre-wrap;word-break:break-all';
  const title = document.createElement('div');
  title.className = 'ui-title';
  title.textContent = 'GAME (stub)';
  const note = document.createElement('div');
  note.className = 'ui-muted';
  note.textContent = 'The real game screen belongs to the lead. It was started with:';
  el.append(title, note, pre);

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px';
  const btn = (label: string, id: string, fn: () => void): void => {
    const b = document.createElement('button');
    b.className = 'ui-btn ui-btn--sm';
    b.id = id;
    b.textContent = label;
    b.addEventListener('click', fn);
    row.appendChild(b);
  };
  const end = (kind: ResultCase) => (): void => {
    const k: ResultCase = params.tutorial ? 'tutorial' : kind;
    ctx.nav.go('results', { results: fakeResults(k, params, ctx.library), params });
  };
  btn('finish: S', 'stub-s', end('s'));
  btn('finish: A', 'stub-a', end('a'));
  btn('finish: C', 'stub-c', end('c'));
  btn('crowd left', 'stub-left', end('left'));
  btn('track picker', 'stub-picker', () => {
    void openTrackPicker(ctx, overlays, { title: 'Load deck B' }).then((id) => {
      pre.textContent = `${JSON.stringify(params, null, 2)}\n\npicker → ${JSON.stringify(id)}`;
    });
  });
  btn('loading 40 %', 'stub-loading', () => {
    const loading = createLoadingOverlay();
    overlays.appendChild(loading.el);
    loading.show('Getting the set ready');
    loading.set(0.4, 'Pressing vinyl');
    setTimeout(() => {
      loading.set(1, 'Ready');
      void loading.hide().then(() => loading.el.remove());
    }, 4000);
  });
  btn('home', 'stub-home', () => ctx.nav.go('home'));
  el.appendChild(row);

  return {
    el,
    enter(p) {
      params = p;
      pre.textContent = JSON.stringify(p, null, 2);
    },
  };
}

async function main(): Promise<void> {
  if (q.get('reset')) localStorage.removeItem('djhermann.settings.v1');
  await loadFonts();

  const app = document.getElementById('app')!;
  const frame = div('app-frame', app);
  const bg = div('app-bg', frame);
  const screens = div('app-screens', frame);
  const overlays = div('app-overlays', frame);

  const settings = createSettings();
  if (q.get('set')) settings.set(JSON.parse(q.get('set')!) as Partial<Settings>);

  const engine = createMockEngine({ latencyMs: 28 });
  if (q.get('sound')) addBeeps(engine);

  const userCount = Number(q.get('user') ?? 0);
  const mine: TrackMeta[] = [];
  const names: [string, number, number, number, number][] = [
    ['Sunset Rooftops (Extended Mix)', 123.5, 20, 200, 0.82],
    ['voice memo 2026-11-02', 87, 320, 60, 0.31],
    ['Garage Session 04', 132, 140, 260, 0.64],
  ];
  for (let i = 0; i < userCount; i++) {
    const [title, bpm, hueA, hueB, conf] = names[i % names.length];
    mine.push({ ...mockMeta(`mine-${i}`, title, bpm, hueA, hueB, 'user'), gridConfidence: conf, key: i === 1 ? null : 'F minor' });
  }
  const library = withUserTracks(createMockLibrary(Number(q.get('delay') ?? 600)), mine);

  const nav = createNav(screens);
  const ctx: AppContext & { nav: typeof nav } = { engine, library, settings, nav };
  registerScreens(ctx);
  nav.register('game', () => createStubGame(ctx, overlays));

  const ambient = createAmbientBackground();
  bg.appendChild(ambient.el);
  nav.onChange((id) => {
    if (id === 'game') ambient.stop();
    else ambient.start();
  });

  const gigParams = (): GameParams => ({
    mode: 'gig',
    setlist: library
      .list()
      .slice(0, 3)
      .map((t) => t.id),
    difficulty: (q.get('difficulty') as Difficulty | null) ?? 'club',
  });

  const handle = { ctx, nav, engine, library, settings, ambient, overlays, fakeResults, gigParams };
  (window as unknown as { __sc: typeof handle }).__sc = handle;

  const start = q.get('s') ?? 'title';
  switch (start) {
    case 'results': {
      const kind = (q.get('case') ?? 's') as ResultCase;
      const params: GameParams = kind === 'tutorial' ? { ...gigParams(), tutorial: true, difficulty: 'chill' } : gigParams();
      nav.go('home');
      nav.go('results', { results: fakeResults(kind, params, library), params });
      break;
    }
    case 'game':
      nav.go('home');
      nav.go('game', gigParams());
      break;
    case 'loading': {
      nav.go('game', gigParams());
      const loading = createLoadingOverlay();
      overlays.appendChild(loading.el);
      loading.show('Getting the set ready');
      loading.set(Number(q.get('p') ?? 0.4), q.get('label') ?? 'Pressing vinyl');
      Object.assign(handle, { loading });
      break;
    }
    case 'picker':
      nav.go('game', { mode: 'free', setlist: [], difficulty: 'chill' });
      void openTrackPicker(ctx, overlays, { title: 'Load deck B' }).then((id) => {
        Object.assign(handle, { picked: id });
      });
      break;
    case 'title':
      nav.go('title');
      break;
    default:
      // any menu screen: unlock like the title would, then arrive from home so "back" works
      await engine.unlock();
      nav.go('home');
      if (start !== 'home') nav.go(start as 'setup');
  }
}

void main();
