/**
 * One shared requestAnimationFrame loop for everything the menus animate on a canvas (ambient
 * backdrop, beat-check waveform, calibration pad, count-ups). It only runs while something is
 * subscribed. The game screen has its own frame loop (core/frame); this one never runs there
 * unless a menu overlay (the track picker, the loading overlay) is animating.
 */
export type TickFn = (nowMs: number, dtSec: number) => void;

const fns = new Set<TickFn>();
let raf = 0;
let last = 0;

function loop(t: number): void {
  const dt = last === 0 ? 0 : Math.min(0.1, Math.max(0, (t - last) / 1000));
  last = t;
  for (const fn of [...fns]) {
    try {
      fn(t, dt);
    } catch (err) {
      console.error('[screens] frame callback threw', err);
    }
  }
  if (fns.size > 0) raf = requestAnimationFrame(loop);
  else {
    raf = 0;
    last = 0;
  }
}

/** Run `fn` on every animation frame until the returned function is called. */
export function onFrame(fn: TickFn): () => void {
  fns.add(fn);
  if (raf === 0) {
    last = 0;
    raf = requestAnimationFrame(loop);
  }
  return () => {
    fns.delete(fn);
  };
}

/**
 * Animate a value from 0 to 1 over `ms`, calling `step(t)` with the linear progress every frame
 * (and once with exactly 1 at the end). Returns a cancel function.
 */
export function tween(ms: number, step: (t: number) => void, done?: () => void): () => void {
  let start = -1;
  let off: (() => void) | null = null;
  off = onFrame((now) => {
    if (start < 0) start = now;
    const t = ms <= 0 ? 1 : Math.min(1, (now - start) / ms);
    step(t);
    if (t >= 1) {
      off?.();
      off = null;
      done?.();
    }
  });
  return () => {
    off?.();
    off = null;
  };
}
