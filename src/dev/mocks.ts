/**
 * Fake data for dev harnesses and tests: synthetic tracks (no real audio), a fake library
 * and a fake HUD state. Nothing here ships in the game.
 */
import { beatAtSec } from '../core/beatgrid';
import { clamp01, fract, rng } from '../core/math';
import { BEATS_PER_BAR, ImportError } from '../core/types';
import type {
  BeatEnergy,
  BeatGrid,
  HudState,
  Library,
  LoadedTrack,
  MissionView,
  PcmData,
  SectionKind,
  TrackMeta,
  TrackSection,
  WaveformData,
} from '../core/types';

/** The arrangement every mock track uses (64 bars). */
const TEMPLATE: [SectionKind, number, number][] = [
  ['intro', 8, 0.35],
  ['groove', 8, 0.55],
  ['build', 4, 0.7],
  ['drop', 16, 1],
  ['break', 8, 0.3],
  ['build', 4, 0.75],
  ['drop', 8, 1],
  ['outro', 8, 0.4],
];

export function mockSections(): TrackSection[] {
  let bar = 0;
  return TEMPLATE.map(([kind, bars, energy]) => {
    const s = { kind, startBar: bar, bars, energy };
    bar += bars;
    return s;
  });
}

export function mockMeta(
  id: string,
  title: string,
  bpm: number,
  hueA: number,
  hueB: number,
  source: 'builtin' | 'user' = 'builtin',
): TrackMeta {
  const sections = mockSections();
  const bars = sections.reduce((n, s) => n + s.bars, 0);
  const firstBeatSec = 0.05;
  return {
    id,
    title,
    artist: source === 'builtin' ? 'DJ Hermann Originals' : 'My Music',
    source,
    durationSec: firstBeatSec + (bars * BEATS_PER_BAR * 60) / bpm + 1,
    grid: { bpm, firstBeatSec },
    key: 'A minor',
    sections,
    art: { hueA, hueB, seed: id.length * 7919 + Math.round(bpm) },
    ...(source === 'user' ? { gridConfidence: 0.82 } : {}),
  };
}

export const MOCK_CATALOG: TrackMeta[] = [
  mockMeta('mock-golden', 'Golden Hour Drive', 122, 38, 330),
  mockMeta('mock-lanterns', 'Paper Lanterns', 124, 190, 280),
  mockMeta('mock-coast', 'Northern Coast', 126, 160, 215),
  mockMeta('mock-bloom', 'Tidal Bloom', 118, 300, 20),
  mockMeta('mock-skyline', 'Skyline Hearts', 128, 250, 330),
];

function sectionEnergyAt(meta: TrackMeta, beat: number): { kind: SectionKind; energy: number } {
  const bar = Math.floor(beat / BEATS_PER_BAR);
  for (const s of meta.sections) {
    if (bar >= s.startBar && bar < s.startBar + s.bars) return { kind: s.kind, energy: s.energy };
  }
  return { kind: 'outro', energy: 0.1 };
}

/** Plausible-looking three-band waveform for a mock track. */
export function mockWaveform(meta: TrackMeta, rate = 200): WaveformData {
  const length = Math.ceil(meta.durationSec * rate);
  const low = new Uint8Array(length);
  const mid = new Uint8Array(length);
  const high = new Uint8Array(length);
  const rand = rng(meta.art.seed);
  for (let i = 0; i < length; i++) {
    const beat = beatAtSec(meta.grid, i / rate);
    if (beat < 0) continue;
    const { kind, energy } = sectionEnergyAt(meta, beat);
    const drums = kind === 'break' ? 0.12 : 1;
    const ph = fract(beat);
    const kick = Math.exp(-ph * 7) * drums;
    const hat = Math.exp(-fract(beat + 0.5) * 12) * drums * (energy > 0.5 ? 1 : 0.5);
    const clap = Math.floor(beat) % 2 === 1 ? Math.exp(-ph * 9) * drums : 0;
    const pad = 0.25 + 0.5 * energy * (0.75 + 0.25 * Math.sin(beat * 0.9));
    low[i] = Math.round(255 * clamp01(kick * (0.55 + 0.45 * energy) + 0.12 * energy * rand()));
    mid[i] = Math.round(255 * clamp01(pad * 0.7 + clap * 0.5 + 0.1 * rand()));
    high[i] = Math.round(255 * clamp01(hat * 0.6 * energy + clap * 0.35 + 0.08 * rand()));
  }
  return { rate, length, low, mid, high };
}

export function mockEnergy(meta: TrackMeta): BeatEnergy {
  const div = 4;
  const beats = Math.max(1, Math.floor(beatAtSec(meta.grid, meta.durationSec)));
  const n = beats * div;
  const low = new Float32Array(n);
  const mid = new Float32Array(n);
  const high = new Float32Array(n);
  const bar = new Float32Array(Math.ceil(beats / BEATS_PER_BAR));
  const rand = rng(meta.art.seed + 1);
  for (let i = 0; i < n; i++) {
    const beat = i / div;
    const { kind, energy } = sectionEnergyAt(meta, beat);
    const drums = kind === 'break' ? 0.1 : 1;
    const sub = i % div;
    low[i] = sub === 0 ? drums * (0.7 + 0.3 * energy) : 0.05 * rand();
    mid[i] = sub === 0 && Math.floor(beat) % 2 === 1 ? drums * 0.9 : energy * 0.35 * rand();
    high[i] = sub === 2 ? drums * 0.7 * energy : sub === 0 ? 0.2 : 0.25 * energy * rand();
    bar[Math.floor(beat / BEATS_PER_BAR)] = energy;
  }
  return { div, low, mid, high, bar };
}

const SILENT_PCM = (sampleRate: number): PcmData => ({
  sampleRate,
  length: 1,
  channels: [new Int16Array(1), new Int16Array(1)],
});

/** A LoadedTrack with fake waveform/energy and one silent sample of audio. */
export function mockTrack(meta: TrackMeta, sampleRate = 48000): LoadedTrack {
  return { meta, pcm: SILENT_PCM(sampleRate), waveform: mockWaveform(meta), energy: mockEnergy(meta) };
}

/** A Library over the mock catalog. importFile fakes a short analysis and adds a "user" track. */
export function createMockLibrary(delayMs = 600): Library {
  const metas = [...MOCK_CATALOG];
  const subs = new Set<() => void>();
  const changed = (): void => {
    for (const fn of [...subs]) fn();
  };
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  return {
    list: () => [...metas.filter((m) => m.source === 'builtin'), ...metas.filter((m) => m.source === 'user')],
    get: (id) => metas.find((m) => m.id === id),
    async load(id, onProgress) {
      const meta = metas.find((m) => m.id === id);
      if (!meta) throw new Error(`unknown track ${id}`);
      for (let i = 1; i <= 5; i++) {
        await sleep(delayMs / 5);
        onProgress?.(i / 5, i < 4 ? 'Pressing vinyl' : 'Finding the beat');
      }
      return mockTrack(meta);
    },
    async importFile(file, onProgress) {
      if (/\.(m4p|aax|wma)$/i.test(file.name)) {
        throw new ImportError('decode', 'This file is protected or in a format the browser cannot read.');
      }
      for (let i = 1; i <= 8; i++) {
        await sleep(delayMs / 4);
        onProgress?.(i / 8, i < 3 ? 'Reading file' : i < 7 ? 'Finding the beat' : 'Saving');
      }
      const meta = mockMeta(`user-${metas.length}`, file.name.replace(/\.[^.]+$/, ''), 123.5, 20, 200, 'user');
      metas.push(meta);
      changed();
      return meta;
    },
    async setGrid(id, grid: BeatGrid) {
      const i = metas.findIndex((m) => m.id === id);
      if (i < 0) throw new Error(`unknown track ${id}`);
      metas[i] = { ...metas[i], grid };
      changed();
      return metas[i];
    },
    async remove(id) {
      const i = metas.findIndex((m) => m.id === id);
      if (i >= 0) metas.splice(i, 1);
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

export const MOCK_MISSION: MissionView = {
  id: 1,
  kind: 'start-deck',
  title: 'START DECK B',
  hint: 'Press the green PLAY button on deck B',
  targets: [{ control: 'B.play', gesture: 'tap' }],
  progress: null,
  timeLeft: 0.7,
  points: 1000,
};

export const mockHud = (over: Partial<HudState> = {}): HudState => ({
  mode: 'gig',
  score: 48250,
  combo: 37,
  multiplier: 3,
  hype: 0.72,
  progress: 0.4,
  mission: MOCK_MISSION,
  status: 'NEXT MIX IN 8 BARS',
  set: { index: 0, count: 3 },
  ...over,
});
