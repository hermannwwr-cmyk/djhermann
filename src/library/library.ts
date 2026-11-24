/**
 * The track library: built-in tracks plus the player's own files, loading (render or decode +
 * analyse) with a small cache, importing, manual grid fixes. Storage and analysis are injected so
 * the logic runs in Node tests with an in-memory store.
 */
import { ImportError } from '../core/types';
import type {
  BeatGrid,
  BuiltinMusic,
  Library,
  LoadedTrack,
  PcmData,
  ProgressFn,
  TrackAnalysis,
  TrackMeta,
  TrackSection,
} from '../core/types';
import { BEATS_PER_BAR } from '../core/types';
import { artFor, newTrackId, parseFileName } from './names';
import { createMemoryStore } from './store';
import type { StoredEnvelope, TrackRecord, TrackStore } from './store';

/** What the library needs from the analysis module. */
export interface LibraryAnalysis {
  decodeAudioFile(file: Blob, sampleRate: number): Promise<PcmData>;
  analyzeTrack(pcm: PcmData, grid: BeatGrid, onProgress?: ProgressFn): Promise<TrackAnalysis>;
  detectAndAnalyze(
    pcm: PcmData,
    onProgress?: ProgressFn,
  ): Promise<{ grid: BeatGrid; confidence: number; analysis: TrackAnalysis; envelope: StoredEnvelope }>;
  estimateSections(energy: TrackAnalysis['energy']): TrackSection[];
  sectionsFromEnvelope(envelope: StoredEnvelope, grid: BeatGrid, durationSec: number): TrackSection[];
}

export interface LibraryCoreDeps {
  music: BuiltinMusic;
  sampleRate: number;
  analysis: LibraryAnalysis;
  /** the persistent store; when it rejects (no IndexedDB), tracks live in memory for the session */
  store: Promise<TrackStore>;
  /** LoadedTracks kept in memory (PCM is big): default 3 */
  cacheSize?: number;
  /** clock for addedAt (tests) */
  now?: () => number;
}

/** Progress stage labels. */
export const STAGE_PRESS = 'Pressing the record';
export const STAGE_READ = 'Reading the file';
export const STAGE_SAVE = 'Saving';
export const STAGE_READY = 'Ready';
const STAGE_WAVE = 'Drawing the waveform';

const MISSING_FILE = "This track's file is no longer on this device. Import it again.";
const UNKNOWN_IMPORT = 'Something went wrong while reading this track. Try another file.';

interface Inflight {
  promise: Promise<LoadedTrack>;
  listeners: Set<ProgressFn>;
}

export function createLibraryCore(deps: LibraryCoreDeps): Library & {
  /** resolves once the stored tracks are listed */
  ready: Promise<void>;
  /** 'indexeddb' or 'memory' once ready */
  storageKind(): TrackStore['kind'];
  /** ids of the LoadedTracks in the cache, most recently used first (for tests) */
  cachedIds(): string[];
} {
  const { music, sampleRate, analysis } = deps;
  const cacheSize = Math.max(1, deps.cacheSize ?? 3);
  const now = deps.now ?? Date.now;

  const builtins = new Map<string, TrackMeta>();
  for (const m of music.catalog) builtins.set(m.id, m);
  /** user tracks, newest first */
  let users: TrackRecord[] = [];
  /** files of tracks that could not be stored (no room, no IndexedDB): this session only */
  const sessionFiles = new Map<string, Blob>();
  const removed = new Set<string>();
  let store: TrackStore = createMemoryStore();

  const cache = new Map<string, LoadedTrack>(); // insertion order = least recently used first
  const inflight = new Map<string, Inflight>();
  /** bumped by setGrid / remove: a load that started before must not fill the cache */
  const generation = new Map<string, number>();
  const gen = (id: string): number => generation.get(id) ?? 0;
  const bump = (id: string): void => {
    generation.set(id, gen(id) + 1);
  };

  const subs = new Set<() => void>();
  let listCache: TrackMeta[] | null = null;
  const changed = (): void => {
    listCache = null;
    for (const fn of [...subs]) {
      try {
        fn();
      } catch (err) {
        console.error('[library] subscriber failed', err);
      }
    }
  };

  const sortUsers = (): void => {
    users.sort((a, b) => b.addedAt - a.addedAt);
  };

  const ready = deps.store
    .then(async (s) => {
      const records = await s.list();
      store = s;
      const known = new Set(users.map((r) => r.id));
      for (const r of records) if (!known.has(r.id) && !removed.has(r.id) && r.meta) users.push(r);
      sortUsers();
      if (records.length) changed();
    })
    .catch((err) => {
      console.warn('[library] no persistent storage, tracks are kept for this session only', err);
    });

  const findUser = (id: string): TrackRecord | undefined => users.find((r) => r.id === id);

  const touch = (id: string, track: LoadedTrack): void => {
    cache.delete(id);
    cache.set(id, track);
    while (cache.size > cacheSize) cache.delete(cache.keys().next().value as string);
  };

  async function loadUncached(id: string, emit: ProgressFn): Promise<LoadedTrack> {
    const builtin = builtins.get(id);
    if (builtin) {
      const pcm = await music.renderTrack(id, sampleRate, (p) => emit(0.75 * p, STAGE_PRESS));
      const { waveform, energy } = await analysis.analyzeTrack(pcm, builtin.grid, (p) => emit(0.75 + 0.25 * p, STAGE_WAVE));
      return { meta: builtin, pcm, waveform, energy };
    }
    await ready;
    const rec = findUser(id);
    if (!rec) throw new Error(`Unknown track: ${id}`);
    emit(0.02, STAGE_READ);
    let file = sessionFiles.get(id);
    if (!file) {
      try {
        file = await store.getFile(id);
      } catch (err) {
        console.warn('[library] could not read a stored file', err);
      }
    }
    if (!file) throw new ImportError('storage', MISSING_FILE);
    const pcm = await analysis.decodeAudioFile(file, sampleRate);
    emit(0.35, STAGE_WAVE);
    const grid = rec.meta.grid;
    const { waveform, energy } = await analysis.analyzeTrack(pcm, grid, (p) => emit(0.35 + 0.65 * p, STAGE_WAVE));
    // the grid may have been fixed while this ran: the energy is then stale, but the meta is current
    return { meta: findUser(id)?.meta ?? rec.meta, pcm, waveform, energy };
  }

  function load(id: string, onProgress?: ProgressFn): Promise<LoadedTrack> {
    const hit = cache.get(id);
    if (hit) {
      touch(id, hit);
      onProgress?.(1, STAGE_READY);
      return Promise.resolve(hit);
    }
    const running = inflight.get(id);
    if (running) {
      if (onProgress) running.listeners.add(onProgress);
      return running.promise;
    }
    const listeners = new Set<ProgressFn>();
    if (onProgress) listeners.add(onProgress);
    const emit: ProgressFn = (p, stage) => {
      for (const fn of listeners) fn(p, stage);
    };
    const startGen = gen(id);
    const promise = loadUncached(id, emit).then(
      (track) => {
        if (inflight.get(id)?.promise === promise) inflight.delete(id);
        if (gen(id) === startGen) touch(id, track);
        emit(1, STAGE_READY);
        return track;
      },
      (err) => {
        if (inflight.get(id)?.promise === promise) inflight.delete(id);
        throw err;
      },
    );
    inflight.set(id, { promise, listeners });
    return promise;
  }

  async function importFile(file: File, onProgress?: ProgressFn): Promise<TrackMeta> {
    const emit = (p: number, stage: string): void => onProgress?.(p, stage);
    try {
      emit(0, STAGE_READ);
      await ready;
      // the same file again: no second copy
      const dup = users.find((r) => r.fileName === file.name && r.fileSize === file.size);
      if (dup) {
        emit(1, STAGE_READY);
        return dup.meta;
      }
      const pcm = await analysis.decodeAudioFile(file, sampleRate);
      emit(0.15, STAGE_READ);
      const full = await analysis.detectAndAnalyze(pcm, (p, stage) => emit(0.15 + 0.77 * p, stage ?? STAGE_WAVE));
      const durationSec = pcm.length / pcm.sampleRate;
      const { title, artist } = parseFileName(file.name);
      const id = newTrackId(now());
      const meta: TrackMeta = {
        id,
        title,
        artist,
        source: 'user',
        durationSec,
        grid: full.grid,
        key: null,
        sections: analysis.estimateSections(full.analysis.energy),
        art: artFor(title),
        gridConfidence: full.confidence,
      };
      const record: TrackRecord = {
        id,
        meta,
        addedAt: now(),
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type,
        envelope: full.envelope,
      };
      emit(0.93, STAGE_SAVE);
      try {
        await store.add(record, file);
        requestPersistence();
      } catch (err) {
        // full (quota) or refused (private browsing): keep it for this session
        console.warn('[library] could not store the track, keeping it for this session', err);
        sessionFiles.set(id, file);
      }
      users.unshift(record);
      sortUsers();
      touch(id, { meta, pcm, waveform: full.analysis.waveform, energy: full.analysis.energy });
      changed();
      emit(1, STAGE_READY);
      return meta;
    } catch (err) {
      if (err instanceof ImportError) throw err;
      console.error('[library] import failed', err);
      throw new ImportError('unknown', UNKNOWN_IMPORT);
    }
  }

  async function setGrid(id: string, grid: BeatGrid): Promise<TrackMeta> {
    await ready;
    if (builtins.has(id)) throw new Error('Built-in tracks have a fixed beat grid');
    const rec = findUser(id);
    if (!rec) throw new Error(`Unknown track: ${id}`);
    if (!(grid.bpm >= 30 && grid.bpm <= 300) || !Number.isFinite(grid.firstBeatSec)) {
      throw new Error(`Invalid beat grid: ${grid.bpm} BPM, first beat ${grid.firstBeatSec}`);
    }
    // beat 0 must be a downbeat inside the track: move a first beat before the start on by whole bars
    const barSec = (60 / grid.bpm) * BEATS_PER_BAR;
    let firstBeatSec = grid.firstBeatSec;
    if (firstBeatSec < 0) firstBeatSec += Math.ceil(-firstBeatSec / barSec - 1e-9) * barSec;
    const fixed: BeatGrid = { bpm: grid.bpm, firstBeatSec };

    bump(id);
    cache.delete(id);
    let sections: TrackSection[];
    if (rec.envelope) {
      sections = analysis.sectionsFromEnvelope(rec.envelope, fixed, rec.meta.durationSec);
    } else {
      // an old record without an envelope: analyse the file again on the new grid
      rec.meta = { ...rec.meta, grid: fixed };
      const track = await load(id);
      sections = analysis.estimateSections(track.energy);
    }
    const meta: TrackMeta = { ...rec.meta, grid: fixed, sections };
    rec.meta = meta;
    bump(id);
    cache.delete(id);
    if (!sessionFiles.has(id)) {
      try {
        await store.update(rec);
      } catch (err) {
        console.warn('[library] could not save the grid fix', err);
      }
    }
    changed();
    return meta;
  }

  async function remove(id: string): Promise<void> {
    if (builtins.has(id)) return;
    removed.add(id);
    await ready;
    const had = users.length;
    users = users.filter((r) => r.id !== id);
    sessionFiles.delete(id);
    cache.delete(id);
    bump(id);
    try {
      await store.remove(id);
    } catch (err) {
      console.warn('[library] could not delete the stored track', err);
    }
    if (users.length !== had) changed();
  }

  let persistRequested = false;
  function requestPersistence(): void {
    if (persistRequested || store.kind !== 'indexeddb') return;
    persistRequested = true;
    // ask the browser not to evict the player's music under storage pressure (best effort)
    try {
      const storage = (globalThis.navigator as Navigator | undefined)?.storage;
      storage?.persist?.().catch(() => {});
    } catch {
      /* not supported */
    }
  }

  return {
    ready,
    storageKind: () => store.kind,
    cachedIds: () => [...cache.keys()].reverse(),
    list() {
      if (!listCache) listCache = [...builtins.values(), ...users.map((r) => r.meta)];
      return listCache.slice();
    },
    get(id) {
      return builtins.get(id) ?? findUser(id)?.meta;
    },
    load,
    importFile,
    setGrid,
    remove,
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}
