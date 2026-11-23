/**
 * What the pieces of this module share without being handed it: the settings store (so the
 * ambient backdrop and the overlays, which take no arguments, can honour "fewer effects").
 * registerScreens() fills it in.
 */
import type { AudioEngine, SettingsStore } from '../../core/types';

interface Shared {
  settings: SettingsStore | null;
  /** true when the player asked for fewer effects */
  lowFx(): boolean;
}

export const shared: Shared = {
  settings: null,
  lowFx() {
    return this.settings?.get().lowFx ?? false;
  },
};

/** Short vibration, when the player wants it and the phone can do it (Android; iOS has no web vibration). */
export function buzz(settings: SettingsStore, pattern: number | number[] = 12): void {
  if (!settings.get().haptics) return;
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* not allowed here: never mind */
  }
}

/** Play a one-shot through the engine, ignoring an engine that is not ready or a sound that is missing. */
export function playUi(engine: AudioEngine, name: string, gain = 0.5, atCtxTime?: number): void {
  try {
    if (!engine.unlocked) return;
    engine.playSound(name, atCtxTime === undefined ? { gain } : { gain, atCtxTime });
  } catch (err) {
    console.warn('[screens] could not play', name, err);
  }
}
