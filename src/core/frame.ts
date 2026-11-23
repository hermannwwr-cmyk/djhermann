import type { AudioEngine, DeckId, FrameState, HudState } from './types';
import { fract } from './math';
import { BEATS_PER_BAR } from './types';

export const IDLE_HUD: HudState = {
  mode: 'free',
  score: 0,
  combo: 0,
  multiplier: 1,
  hype: 0.5,
  progress: null,
  mission: null,
  status: '',
  set: null,
};

/** Below this audibility a deck does not count as heard. */
export const AUDIBLE_MIN = 0.08;

export type FramePhase = 'logic' | 'render';
export type FrameFn = (frame: FrameState) => void;

export interface FrameLoop {
  /** The frame object. It is reused and mutated every frame – read it, don't keep copies of it. */
  readonly frame: FrameState;
  /**
   * Register a per-frame callback. 'logic' callbacks (rhythm, gig) run first, then the HUD state is
   * refreshed, then 'render' callbacks (everything that draws). Returns an unsubscribe function.
   */
  add(fn: FrameFn, phase?: FramePhase): () => void;
  start(): void;
  stop(): void;
  /** Run one frame by hand (tests). */
  tick(nowMs: number): FrameState;
}

/**
 * The one requestAnimationFrame loop of the game. Reads the engine once per frame, works out the
 * live deck and beat phase, and hands the same FrameState to every component.
 */
export function createFrameLoop(engine: AudioEngine, getHud: () => HudState = () => IDLE_HUD): FrameLoop {
  const logic = new Set<FrameFn>();
  const render = new Set<FrameFn>();
  let raf = 0;
  let running = false;
  let last = 0;
  let live: DeckId | null = null;

  const frame: FrameState = {
    now: 0,
    dt: 0,
    decks: { A: engine.getDeck('A'), B: engine.getDeck('B') },
    mixer: engine.getMixer(),
    liveDeck: null,
    beat: 0,
    beatPhase: 0,
    barPhase: 0,
    bpm: 0,
    pulse: 0,
    hud: getHud(),
  };

  function pickLive(a: number, b: number): DeckId | null {
    const cur = live === 'A' ? a : live === 'B' ? b : 0;
    const other = live === 'A' ? b : live === 'B' ? a : 0;
    if (live && cur >= AUDIBLE_MIN) {
      // hysteresis: the other deck has to be clearly louder to take over
      if (other > cur * 1.25 + 0.05) return live === 'A' ? 'B' : 'A';
      return live;
    }
    if (a < AUDIBLE_MIN && b < AUDIBLE_MIN) return null;
    return a >= b ? 'A' : 'B';
  }

  function run(fns: Set<FrameFn>): void {
    for (const fn of [...fns]) {
      try {
        fn(frame);
      } catch (err) {
        console.error('[frame] callback threw', err);
      }
    }
  }

  function tick(nowMs: number): FrameState {
    frame.dt = last === 0 ? 0 : Math.min(0.1, Math.max(0, (nowMs - last) / 1000));
    frame.now = nowMs;
    last = nowMs;

    frame.decks.A = engine.getDeck('A');
    frame.decks.B = engine.getDeck('B');
    frame.mixer = engine.getMixer();

    live = pickLive(frame.decks.A.audibility, frame.decks.B.audibility);
    frame.liveDeck = live;
    const deck = live ? frame.decks[live] : null;
    if (deck && deck.track) {
      frame.beat = deck.beat;
      frame.beatPhase = fract(deck.beat);
      frame.barPhase = fract(deck.beat / BEATS_PER_BAR);
      frame.bpm = deck.bpm;
      const moving = Math.min(1, Math.max(0, deck.rate));
      frame.pulse = Math.pow(1 - frame.beatPhase, 2.5) * moving;
    } else {
      frame.beat = 0;
      frame.beatPhase = 0;
      frame.barPhase = 0;
      frame.bpm = 0;
      frame.pulse = 0;
    }

    run(logic);
    frame.hud = getHud();
    run(render);
    return frame;
  }

  function loop(t: number): void {
    if (!running) return;
    tick(t);
    raf = requestAnimationFrame(loop);
  }

  return {
    frame,
    add(fn, phase = 'render') {
      const set = phase === 'logic' ? logic : render;
      set.add(fn);
      return () => {
        set.delete(fn);
      };
    },
    start() {
      if (running) return;
      running = true;
      last = 0;
      raf = requestAnimationFrame(loop);
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
    },
    tick,
  };
}
