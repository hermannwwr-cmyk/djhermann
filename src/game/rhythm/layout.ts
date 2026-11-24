/**
 * Geometry of the playfield for a slot of any size: the pad row along the bottom and the note
 * highway above it, drawn with a little perspective. Pure maths, shared by the canvas and the DOM.
 */
import { clamp } from '../../core/math';
import type { Difficulty } from '../../core/types';
import { LANE_COUNT } from '../../core/types';

/** side padding of the pad row and the gap between pads (mirrored in rhythm.css) */
export const PAD_ROW_PADDING = 10;
export const PAD_GAP = 8;
/** the highway's margin at the hit line: lane edges run through the middle of the pad gaps */
const SIDE = PAD_ROW_PADDING - PAD_GAP / 2;
/** how far above the pads a touch still counts for the pad below it */
export const TOUCH_ABOVE_PADS = 26;

/** scroll speed: pixels per beat the highway aims for (harder charts are spread out more) */
const PX_PER_BEAT: Record<Difficulty, number> = { chill: 84, club: 96, festival: 110 };
const MIN_LOOKAHEAD = 2;
const MAX_LOOKAHEAD = 6;

/** Height of the pad row for a slot: small when the console drawer is open, square pads when not. */
export function padRowHeight(slotW: number, slotH: number): number {
  const padW = (slotW - 2 * PAD_ROW_PADDING - (LANE_COUNT - 1) * PAD_GAP) / LANE_COUNT;
  return Math.round(clamp(22 + 0.24 * slotH, 58, Math.max(58, Math.min(124, padW + 24))));
}

export interface Layout {
  /** size of the highway (the slot minus the pad row) in CSS px */
  w: number;
  h: number;
  cx: number;
  /** highway edges and lane width at the hit line */
  left: number;
  laneW: number;
  hitY: number;
  /** scale of the far end relative to the hit line (1 = no perspective) */
  sFar: number;
  /** y of the vanishing point (above the canvas) and its distance to the hit line */
  yV: number;
  span: number;
  /** perspective strength: scale(d) = 1 / (1 + k * d / lookahead) */
  k: number;
  /** beats from the hit line to the far end */
  lookahead: number;
  /** note size at the hit line */
  noteW: number;
  noteH: number;
  /** note size the sprites are drawn at (depends on the width only) */
  noteHRef: number;
  comboY: number;
  comboSize: number;
  wordY: number;
  wordSize: number;
  /** the short layout (console drawer open): labels are dropped */
  compact: boolean;
}

export function computeLayout(slotW: number, slotH: number, padH: number, difficulty: Difficulty): Layout {
  const w = Math.max(1, slotW);
  const h = Math.max(1, slotH - padH);
  const left = SIDE;
  const laneW = (w - 2 * SIDE) / LANE_COUNT;
  const noteW = laneW * 0.8;
  const noteHRef = clamp(laneW * 0.2, 14, 22);

  // two passes: the note height depends on the scroll speed, the hit line on the note height
  let hitY = h - 16;
  let noteH = noteHRef;
  let sFar = 0.7;
  let lookahead = 4;
  for (let pass = 0; pass < 2; pass++) {
    sFar = clamp(1 - (0.4 * hitY) / (w - 2 * SIDE), 0.6, 0.86);
    lookahead = clamp(hitY / PX_PER_BEAT[difficulty], MIN_LOOKAHEAD, MAX_LOOKAHEAD);
    const pxPerBeatAtLine = hitY / (lookahead * sFar);
    noteH = clamp(pxPerBeatAtLine * 0.26, 10, noteHRef);
    hitY = Math.max(24, h - (noteH / 2 + 7));
  }
  const yV = (-hitY * sFar) / (1 - sFar);

  return {
    w,
    h,
    cx: w / 2,
    left,
    laneW,
    hitY,
    sFar,
    yV,
    span: hitY - yV,
    k: 1 / sFar - 1,
    lookahead,
    noteW,
    noteH,
    noteHRef,
    comboY: hitY * 0.33,
    comboSize: clamp(hitY * 0.21, 20, 68),
    wordY: hitY * 0.64,
    wordSize: clamp(hitY * 0.085, 13, Math.min(30, w * 0.07)),
    compact: hitY < 130,
  };
}

/** Perspective scale of something `d` beats before the hit line (1 at the line, sFar at the far end). */
export const scaleAt = (L: Layout, d: number): number => 1 / (1 + (L.k * d) / L.lookahead);
/** y on the canvas for a perspective scale */
export const yAtScale = (L: Layout, s: number): number => L.yV + L.span * s;
/** x of lane centre `lane` at the hit line */
export const laneCenter = (L: Layout, lane: number): number => L.left + (lane + 0.5) * L.laneW;
