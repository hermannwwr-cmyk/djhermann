/**
 * Choreography of the guide's gesture cue: where the fingertip is, whether it is pressing, and how
 * far through the stroke it is, for a time since the cue appeared. Pure functions; the guide turns
 * a pose into transforms. Every loop starts by pressing, so the motion reads within half a second.
 */
import { clamp, clamp01, easeInOutCubic, easeOutCubic } from '../../core/math';
import type { Gesture } from '../../core/types';

export interface CuePose {
  /** fingertip position relative to the centre of the control, px */
  x: number;
  y: number;
  /** 0 = lifted off the glass, 1 = pressing */
  press: number;
  /** hand opacity */
  alpha: number;
  /** 0..1 through the stroke (slide travelled, hold filled, knob turned) */
  stroke: number;
  /** press ripples, 0..1 while spreading, -1 when idle */
  ripple: number;
  ripple2: number;
  /** rotation of the turn arrow in radians (negative = anticlockwise) */
  turn: number;
}

export const newPose = (): CuePose => ({ x: 0, y: 0, press: 0, alpha: 0, stroke: 0, ripple: -1, ripple2: -1, turn: 0 });

/** loop length per gesture, seconds */
export const CUE_PERIOD: Record<Gesture, number> = {
  tap: 1.15,
  hold: 2.4,
  up: 1.7,
  down: 1.7,
  left: 1.7,
  right: 1.7,
  'turn-left': 1.8,
  'turn-right': 1.8,
  scratch: 1.8,
};

const DIR: Partial<Record<Gesture, readonly [number, number]>> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
  'turn-left': [0, 1],
  'turn-right': [0, -1],
};

/** unit direction the finger travels for a sliding gesture, or null */
export const slideDir = (g: Gesture): readonly [number, number] | null => DIR[g] ?? null;

/** how far the finger travels for a sliding gesture on a control of this size, px */
export function travel(g: Gesture, w: number, h: number): number {
  if (g === 'turn-left' || g === 'turn-right') return clamp(Math.min(w, h) * 0.75, 28, 58);
  const d = DIR[g];
  if (!d) return 0;
  const along = d[0] !== 0 ? w : h;
  return clamp(along * 0.62, 34, 104);
}

/** where on a record the scratching finger rests: radius and angle (clockwise from 12 o'clock) */
export const SCRATCH_ANGLE = 0.85;
export const SCRATCH_SWING = 0.5;
export const scratchRadius = (w: number, h: number): number => Math.min(w, h) * 0.5 * 0.58;

/** how far the knob arrow turns over one stroke, radians */
export const TURN_SWEEP = 1.15;

const seg = (u: number, a: number, b: number): number => clamp01((u - a) / (b - a));

export function cuePose(g: Gesture, tSec: number, w: number, h: number, out: CuePose = newPose()): CuePose {
  const period = CUE_PERIOD[g];
  const u = (((tSec % period) + period) % period) / period;
  out.x = 0;
  out.y = 0;
  out.stroke = 0;
  out.ripple = -1;
  out.ripple2 = -1;
  out.turn = 0;
  out.alpha = 1;

  if (g === 'tap') {
    // press, ripple, lift, rest
    out.press = u < 0.2 ? easeOutCubic(u / 0.2) : u < 0.42 ? 1 : 1 - easeOutCubic(seg(u, 0.42, 0.62));
    if (u >= 0.18) out.ripple = seg(u, 0.18, 0.74);
    if (u >= 0.3) out.ripple2 = seg(u, 0.3, 0.9);
    if (out.ripple >= 1) out.ripple = -1;
    if (out.ripple2 >= 1) out.ripple2 = -1;
    return out;
  }

  if (g === 'hold') {
    // press and stay while the ring fills
    out.press = u < 0.1 ? easeOutCubic(u / 0.1) : u < 0.84 ? 1 : 1 - easeOutCubic(seg(u, 0.84, 0.94));
    out.stroke = seg(u, 0.1, 0.8);
    if (u >= 0.08 && u < 0.4) out.ripple = seg(u, 0.08, 0.4);
    return out;
  }

  if (g === 'scratch') {
    // rock back and forth along the groove, twice
    const r = scratchRadius(w, h);
    out.press = u < 0.08 ? easeOutCubic(u / 0.08) : u < 0.92 ? 1 : 1 - seg(u, 0.92, 1);
    const v = seg(u, 0.08, 0.92);
    out.stroke = v;
    const phi = SCRATCH_ANGLE + SCRATCH_SWING * Math.sin(v * Math.PI * 4);
    out.x = Math.sin(phi) * r;
    out.y = -Math.cos(phi) * r;
    out.turn = phi - SCRATCH_ANGLE;
    return out;
  }

  // slides (faders) and turns (knobs: a vertical drag): press, travel, lift, fade, start again
  const d = DIR[g]!;
  const len = travel(g, w, h);
  const s = easeInOutCubic(seg(u, 0.12, 0.64));
  out.stroke = s;
  out.press = u < 0.1 ? easeOutCubic(u / 0.1) : u < 0.7 ? 1 : 1 - seg(u, 0.7, 0.8);
  out.alpha = u < 0.06 ? u / 0.06 : u < 0.76 ? 1 : 1 - seg(u, 0.76, 0.9);
  out.x = d[0] * len * (s - 0.5);
  out.y = d[1] * len * (s - 0.5);
  if (g === 'turn-left') out.turn = -TURN_SWEEP * s;
  else if (g === 'turn-right') out.turn = TURN_SWEEP * s;
  return out;
}
