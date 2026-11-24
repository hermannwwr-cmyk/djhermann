/**
 * The track library: built-in tracks and the player's own files (kept on this device in
 * IndexedDB, never uploaded).
 */
import type { BuiltinMusic, Library } from '../core/types';
import {
  analyzeTrack,
  decodeAudioFile,
  detectAndAnalyze,
  estimateSections,
  sectionsFromEnvelope,
} from '../analysis';
import { createLibraryCore } from './library';
import type { LibraryAnalysis } from './library';
import { openIdbStore } from './store';

export interface LibraryDeps {
  music: BuiltinMusic;
  sampleRate: number;
}

export const defaultAnalysis: LibraryAnalysis = {
  decodeAudioFile,
  analyzeTrack,
  detectAndAnalyze,
  estimateSections,
  sectionsFromEnvelope,
};

export function createLibrary(deps: LibraryDeps): Library {
  return createLibraryCore({ ...deps, analysis: defaultAnalysis, store: openIdbStore() });
}

export { createLibraryCore } from './library';
export type { LibraryAnalysis, LibraryCoreDeps } from './library';
export { createMemoryStore, openIdbStore } from './store';
export type { TrackRecord, TrackStore, StoredEnvelope } from './store';
export { parseFileName, artFor } from './names';
