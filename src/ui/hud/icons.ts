/** Icons used by the HUD: lucide glyphs for the mission line, and the guide's pointing hand. */
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  Disc3,
  Pointer,
  RotateCcw,
  RotateCw,
  Star,
  X,
} from 'lucide-static';
import type { Gesture, MissionRating } from '../../core/types';

export const GESTURE_ICON: Record<Gesture, string> = {
  tap: Pointer,
  hold: Pointer,
  up: ArrowUp,
  down: ArrowDown,
  left: ArrowLeft,
  right: ArrowRight,
  'turn-left': RotateCcw,
  'turn-right': RotateCw,
  scratch: Disc3,
};

export const RATING_ICON: Record<MissionRating, string> = {
  perfect: Star,
  great: Check,
  ok: Check,
  fail: X,
};

/** The hand is drawn in a 54 × 60 box; its fingertip (the point that touches) is here. */
export const HAND_BOX = { w: 54, h: 60, tipX: 21, tipY: 7.5 } as const;

function handPass(grow: number, color: string): string {
  const sw = (n: number): number => n + grow;
  return (
    `<g stroke="${color}" fill="${color}" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="M20 6.5V31" stroke-width="${sw(11)}"/>` +
    `<path d="M29.6 22.5V34" stroke-width="${sw(9)}"/>` +
    `<path d="M38.2 25V34" stroke-width="${sw(8.4)}"/>` +
    `<path d="M45.6 28.5V35" stroke-width="${sw(7)}"/>` +
    `<path d="M16 40L8 30.5" stroke-width="${sw(9.5)}"/>` +
    `<rect x="14.5" y="27" width="34.6" height="26.5" rx="11" stroke-width="${grow}"/>` +
    `</g>`
  );
}

/**
 * A pointing hand: white with a dark outline so it reads on any control. Built from round-capped
 * strokes, drawn twice (a fatter dark pass under a white pass) so the outline has no inner seams.
 */
export const HAND_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -2 ${HAND_BOX.w} ${HAND_BOX.h}">` +
  handPass(3.4, '#0a0a18') +
  handPass(0, '#ffffff') +
  `<path d="M25 25V31.5M34 27V32M41.9 29.5V33" stroke="#a9a6c6" stroke-width="1.3" fill="none" stroke-linecap="round"/>` +
  `</svg>`;
