import { beforeAll, describe, expect, test } from 'vitest';
import { ImportError } from '../core/types';
import type { BuiltinMusic, PcmData, TrackMeta } from '../core/types';
import { analyzeTrack, detectAndAnalyze, estimateSections, sectionsFromEnvelope } from '../analysis';
import { encodeWav, synthTrack } from '../analysis/synth';
import { createLibraryCore } from './library';
import type { LibraryAnalysis } from './library';
import { createMemoryStore } from './store';
import type { TrackStore } from './store';

const SR = 44100;

/** Read a 16-bit PCM WAV (what the tests import) the way decodeAudioFile would decode it. */
async function decodeWav(file: Blob, sampleRate: number): Promise<PcmData> {
  const buf = await file.arrayBuffer();
  const view = new DataView(buf);
  const tag = (o: number): string => String.fromCharCode(...new Uint8Array(buf, o, 4));
  if (buf.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    throw new ImportError('decode', 'This file is in a format this browser cannot read.');
  }
  const channels = view.getUint16(22, true);
  const rate = view.getUint32(24, true);
  if (rate !== sampleRate) throw new Error('test decoder does not resample');
  const frames = view.getUint32(40, true) / (2 * channels);
  const data = new Int16Array(buf, 44, frames * channels);
  const out = Array.from({ length: 2 }, () => new Int16Array(frames));
  for (let i = 0; i < frames; i++) {
    out[0][i] = data[i * channels];
    out[1][i] = data[i * channels + (channels > 1 ? 1 : 0)];
  }
  if (frames / sampleRate < 20) throw new ImportError('too-short', 'too short');
  return { sampleRate, length: frames, channels: out };
}

const analysis: LibraryAnalysis = { decodeAudioFile: decodeWav, analyzeTrack, detectAndAnalyze, estimateSections, sectionsFromEnvelope };

function builtinMeta(id: string, bpm: number): TrackMeta {
  return {
    id,
    title: id,
    artist: 'DJ Hermann Originals',
    source: 'builtin',
    durationSec: 0,
    grid: { bpm, firstBeatSec: 0.1 },
    key: null,
    sections: [{ kind: 'groove', startBar: 0, bars: 8, energy: 1 }],
    art: { hueA: 0, hueB: 180, seed: 1 },
  };
}

function fakeMusic(): BuiltinMusic & { renders: string[] } {
  const catalog = [builtinMeta('b1', 120), builtinMeta('b2', 124), builtinMeta('b3', 126), builtinMeta('b4', 128)];
  const renders: string[] = [];
  return {
    catalog,
    renders,
    async renderTrack(id, sampleRate, onProgress) {
      renders.push(id);
      const meta = catalog.find((m) => m.id === id)!;
      onProgress?.(0.5);
      await new Promise((r) => setTimeout(r, 5));
      onProgress?.(1);
      return synthTrack({ bpm: meta.grid.bpm, firstBeatSec: 0.1, bars: 8, sampleRate, parts: [{ kind: 'groove', bars: 8, kick: true, hat: true }] }).pcm;
    },
    async renderSounds() {
      throw new Error('not used');
    },
  };
}

/** A user's file: a 40-bar track at 126 BPM with an intro, a drop and a break. */
let userWav: ArrayBuffer;
const USER_BPM = 126;
const USER_FIRST = 0.42;
beforeAll(() => {
  const track = synthTrack({
    bpm: USER_BPM,
    firstBeatSec: USER_FIRST,
    sampleRate: SR,
    parts: [
      { kind: 'intro', bars: 8, pad: true, level: 0.5 },
      { kind: 'drop', bars: 16, kick: true, hat: true, clap: true, bass: true, pad: true },
      { kind: 'break', bars: 8, pad: true, level: 0.4 },
      { kind: 'drop', bars: 8, kick: true, hat: true, clap: true, bass: true, pad: true },
    ],
  });
  userWav = encodeWav(track.pcm);
});
const userFile = (name = 'Test Artist - Night Drive.wav'): File => new File([userWav], name, { type: 'audio/wav' });

const make = (store: Promise<TrackStore> = Promise.resolve(createMemoryStore()), music = fakeMusic(), now?: () => number) =>
  createLibraryCore({ music, sampleRate: SR, analysis, store, now });

describe('library: built-in tracks', () => {
  test('list, get and load with progress', async () => {
    const music = fakeMusic();
    const lib = make(undefined, music);
    expect(lib.list().map((m) => m.id)).toEqual(['b1', 'b2', 'b3', 'b4']);
    expect(lib.get('b2')?.grid.bpm).toBe(124);
    const progress: [number, string | undefined][] = [];
    const track = await lib.load('b1', (p, s) => progress.push([p, s]));
    expect(track.meta.id).toBe('b1');
    expect(track.pcm.length).toBeGreaterThan(0);
    expect(track.waveform.rate).toBeGreaterThanOrEqual(200);
    expect(track.energy.div).toBe(4);
    // progress rises from 0 to 1 and names its stages
    for (let i = 1; i < progress.length; i++) expect(progress[i][0]).toBeGreaterThanOrEqual(progress[i - 1][0] - 1e-9);
    expect(progress[progress.length - 1][0]).toBe(1);
    expect(new Set(progress.map((p) => p[1]))).toContain('Pressing the record');
  }, 30000);

  test('concurrent loads share one job; the cache keeps the three most recent', async () => {
    const music = fakeMusic();
    const lib = make(undefined, music);
    const [a, b] = await Promise.all([lib.load('b1'), lib.load('b1')]);
    expect(a).toBe(b);
    expect(music.renders).toEqual(['b1']);
    await lib.load('b1');
    expect(music.renders).toEqual(['b1']);
    await lib.load('b2');
    await lib.load('b3');
    await lib.load('b1'); // touch b1: b2 is now the oldest
    await lib.load('b4');
    expect(lib.cachedIds()).toEqual(['b4', 'b1', 'b3']);
    await lib.load('b2');
    expect(music.renders).toEqual(['b1', 'b2', 'b3', 'b4', 'b2']);
  }, 30000);

  test('a failed render is not cached and can be retried', async () => {
    const music = fakeMusic();
    let fail = true;
    const render = music.renderTrack.bind(music);
    music.renderTrack = async (id, sr, p) => {
      if (fail) throw new Error('boom');
      return render(id, sr, p);
    };
    const lib = make(undefined, music);
    await expect(lib.load('b1')).rejects.toThrow('boom');
    fail = false;
    await expect(lib.load('b1')).resolves.toBeTruthy();
  }, 30000);
});

describe('library: importing', () => {
  test('import detects the grid, names the track, stores it and survives a restart', async () => {
    const store = createMemoryStore();
    let clock = 1000;
    const lib = make(Promise.resolve(store), fakeMusic(), () => clock++);
    let changes = 0;
    lib.subscribe(() => changes++);
    const stages = new Set<string | undefined>();
    let last = -1;
    const meta = await lib.importFile(userFile(), (p, s) => {
      expect(p).toBeGreaterThanOrEqual(last - 1e-9);
      last = p;
      stages.add(s);
    });
    expect(last).toBe(1);
    expect([...stages]).toEqual(expect.arrayContaining(['Reading the file', 'Finding the beat', 'Saving']));
    expect(meta.source).toBe('user');
    expect(meta.title).toBe('Night Drive');
    expect(meta.artist).toBe('Test Artist');
    expect(Math.abs(meta.grid.bpm - USER_BPM)).toBeLessThan(0.02);
    // the detected first beat is the true first downbeat (or a whole number of bars before or after it)
    const barSec = (4 * 60) / USER_BPM;
    const bars = (meta.grid.firstBeatSec - USER_FIRST) / barSec;
    expect(Math.abs(bars - Math.round(bars)) * barSec).toBeLessThan(0.012);
    expect(meta.gridConfidence).toBeGreaterThan(0.7);
    expect(meta.sections.reduce((n, s) => n + s.bars, 0)).toBeGreaterThanOrEqual(39);
    expect(meta.sections.some((s) => s.kind === 'drop')).toBe(true);
    expect(changes).toBe(1);
    expect(lib.list().map((m) => m.id)).toEqual(['b1', 'b2', 'b3', 'b4', meta.id]);
    expect(await store.list()).toHaveLength(1);

    // right after the import the track is cached: loading it decodes nothing
    expect(lib.cachedIds()).toContain(meta.id);

    // a fresh library over the same store (the app restarted) has the track and loads it from the file
    const again = make(Promise.resolve(store));
    await again.ready;
    expect(again.get(meta.id)?.title).toBe('Night Drive');
    const loaded = await again.load(meta.id);
    expect(loaded.meta.id).toBe(meta.id);
    expect(loaded.pcm.length).toBeGreaterThan(SR * 20);
    expect(loaded.energy.bar.length).toBeGreaterThan(30);
  }, 60000);

  test('user tracks are listed newest first, after the built-ins', async () => {
    let clock = 0;
    const lib = make(undefined, fakeMusic(), () => (clock += 10));
    const a = await lib.importFile(userFile('A - One.wav'));
    const b = await lib.importFile(userFile('B - Two.wav'));
    expect(lib.list().map((m) => m.id)).toEqual(['b1', 'b2', 'b3', 'b4', b.id, a.id]);
  }, 60000);

  test('importing the same file twice keeps one copy', async () => {
    const lib = make();
    const a = await lib.importFile(userFile());
    const b = await lib.importFile(userFile());
    expect(b.id).toBe(a.id);
    expect(lib.list()).toHaveLength(5);
  }, 60000);

  test('a file the browser cannot read rejects with a decode ImportError', async () => {
    const lib = make();
    const junk = new File([new Uint8Array(5000).fill(7)], 'song.m4p', { type: 'audio/mp4' });
    const err = await lib.importFile(junk).catch((e) => e);
    expect(err).toBeInstanceOf(ImportError);
    expect(err.code).toBe('decode');
    expect(lib.list()).toHaveLength(4);
  });

  test('an unexpected failure becomes an ImportError("unknown")', async () => {
    const lib = createLibraryCore({
      music: fakeMusic(),
      sampleRate: SR,
      store: Promise.resolve(createMemoryStore()),
      analysis: { ...analysis, decodeAudioFile: async () => { throw new TypeError('kaput'); } },
    });
    const err = await lib.importFile(userFile()).catch((e) => e);
    expect(err).toBeInstanceOf(ImportError);
    expect(err.code).toBe('unknown');
  });

  test('when storage is full the track is kept for the session and still loads', async () => {
    const full: TrackStore = {
      ...createMemoryStore(),
      kind: 'indexeddb',
      add: async () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
    };
    const lib = make(Promise.resolve(full));
    const meta = await lib.importFile(userFile());
    expect(lib.get(meta.id)).toBeTruthy();
    // push it out of the cache, then load it again from the session copy
    await lib.load('b1');
    await lib.load('b2');
    await lib.load('b3');
    expect(lib.cachedIds()).not.toContain(meta.id);
    const loaded = await lib.load(meta.id);
    expect(loaded.meta.id).toBe(meta.id);
  }, 60000);

  test('without any storage (private browsing) the library still works', async () => {
    const lib = make(Promise.reject(new Error('no IndexedDB')));
    await lib.ready;
    expect(lib.storageKind()).toBe('memory');
    const meta = await lib.importFile(userFile());
    expect(lib.list().map((m) => m.id)).toContain(meta.id);
  }, 60000);
});

describe('library: grid fixes and removal', () => {
  test('setGrid persists, re-estimates the sections and drops the cached analysis', async () => {
    const store = createMemoryStore();
    const lib = make(Promise.resolve(store));
    const meta = await lib.importFile(userFile());
    const before = await lib.load(meta.id);
    let changes = 0;
    lib.subscribe(() => changes++);

    // move the downbeat by one beat: bars now start a beat later
    const grid = { bpm: meta.grid.bpm, firstBeatSec: meta.grid.firstBeatSec + 60 / meta.grid.bpm };
    const fixed = await lib.setGrid(meta.id, grid);
    expect(fixed.grid).toEqual(grid);
    expect(lib.get(meta.id)?.grid).toEqual(grid);
    expect(changes).toBe(1);
    expect((await store.list())[0].meta.grid).toEqual(grid);
    expect(lib.cachedIds()).not.toContain(meta.id);

    // the sections from the stored envelope match a full analysis on the new grid
    const after = await lib.load(meta.id);
    expect(after).not.toBe(before);
    expect(after.meta.grid).toEqual(grid);
    const full = estimateSections(after.energy);
    expect(fixed.sections.map(({ kind, startBar, bars }) => ({ kind, startBar, bars }))).toEqual(
      full.map(({ kind, startBar, bars }) => ({ kind, startBar, bars })),
    );
    fixed.sections.forEach((s, i) => expect(s.energy).toBeCloseTo(full[i].energy, 2));

    // half tempo: sections still tile the track
    const half = await lib.setGrid(meta.id, { bpm: meta.grid.bpm / 2, firstBeatSec: meta.grid.firstBeatSec });
    const bars = half.sections.reduce((n, s) => n + s.bars, 0);
    expect(bars).toBeGreaterThanOrEqual(19);

    // a first beat before the start moves on by whole bars
    const early = await lib.setGrid(meta.id, { bpm: 126, firstBeatSec: -0.5 });
    expect(early.grid.firstBeatSec).toBeGreaterThanOrEqual(0);
    expect(early.grid.firstBeatSec).toBeCloseTo(-0.5 + (4 * 60) / 126, 6);

    await expect(lib.setGrid('b1', grid)).rejects.toThrow();
    await expect(lib.setGrid(meta.id, { bpm: Number.NaN, firstBeatSec: 0 })).rejects.toThrow();
  }, 60000);

  test('remove deletes the track everywhere', async () => {
    const store = createMemoryStore();
    const lib = make(Promise.resolve(store));
    const meta = await lib.importFile(userFile());
    let changes = 0;
    lib.subscribe(() => changes++);
    await lib.remove(meta.id);
    expect(lib.get(meta.id)).toBeUndefined();
    expect(lib.list()).toHaveLength(4);
    expect(await store.list()).toHaveLength(0);
    expect(await store.getFile(meta.id)).toBeUndefined();
    expect(lib.cachedIds()).not.toContain(meta.id);
    expect(changes).toBe(1);
    await expect(lib.load(meta.id)).rejects.toThrow();
    // built-ins cannot be removed
    await lib.remove('b1');
    expect(lib.get('b1')).toBeTruthy();
  }, 60000);
});
