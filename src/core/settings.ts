import type { Settings, SettingsStore } from './types';

const KEY = 'djhermann.settings.v1';

export const DEFAULT_SETTINGS: Settings = {
  latencyMs: null,
  haptics: true,
  difficulty: 'chill',
  masterVolume: 0.9,
  lowFx: false,
  guide: true,
  seenHowTo: false,
  tutorialDone: false,
  best: {},
};

/** Settings persisted in localStorage. Works (in memory only) when storage is unavailable. */
export function createSettings(storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()): SettingsStore {
  let state: Settings = { ...DEFAULT_SETTINGS };
  try {
    const raw = storage?.getItem(KEY);
    if (raw) state = { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    /* corrupted or blocked storage: keep defaults */
  }
  const subs = new Set<(s: Settings) => void>();

  return {
    get: () => state,
    set(patch) {
      state = { ...state, ...patch };
      try {
        storage?.setItem(KEY, JSON.stringify(state));
      } catch {
        /* storage full or blocked: keep the in-memory value */
      }
      for (const fn of [...subs]) fn(state);
    },
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
