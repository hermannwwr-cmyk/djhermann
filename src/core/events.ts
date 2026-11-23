/** Tiny typed event emitter. `on` returns an unsubscribe function. */
export class Emitter<E> {
  private handlers = new Map<keyof E, Set<(e: never) => void>>();

  on<K extends keyof E>(type: K, fn: (e: E[K]) => void): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(fn as (e: never) => void);
    return () => {
      set.delete(fn as (e: never) => void);
    };
  }

  emit<K extends keyof E>(type: K, event: E[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        (fn as (e: E[K]) => void)(event);
      } catch (err) {
        console.error(`[events] handler for "${String(type)}" threw`, err);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}

import type { GameEvents } from './types';

/** The bus that carries GameEvents between the rhythm playfield, the gig and the HUD. */
export type GameBus = Emitter<GameEvents>;
export const createGameBus = (): GameBus => new Emitter<GameEvents>();
