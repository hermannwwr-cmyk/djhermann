/**
 * Canvas-side mirror of styles/tokens.css, plus small drawing helpers shared by every canvas.
 * Keep the two files in step.
 */
import type { DeckId, Judgment, Lane } from '../core/types';

export const COLORS = {
  bg0: '#05050b',
  bg1: '#0a0a14',
  bg2: '#11111f',
  bg3: '#1a1a2e',
  bg4: '#262640',
  ink: '#f4f3ff',
  ink2: '#b9b6d6',
  ink3: '#7d7a9c',
  ink4: '#4a4866',
  cyan: '#2de2ff',
  violet: '#8b6cff',
  pink: '#ff4fa8',
  gold: '#ffcf4a',
  goldHot: '#fff3c4',
  mint: '#4dffb5',
  amber: '#ffa63d',
  red: '#ff4d5e',
  // hardware (console + pads)
  hwPlate: '#15151d',
  hwPlateHi: '#1b1b25',
  hwWell: '#08080d',
  hwRubber: '#23232c',
  hwRubberHi: '#2b2b35',
  hwSilk: '#ececf8',
  ledGreen: '#3dff7a',
  ledAmber: '#ffa63d',
  ledRed: '#ff4d5e',
  ledOff: '#23232e',
} as const;

export const DECK_COLORS: Record<DeckId, string> = { A: COLORS.cyan, B: COLORS.pink };
export const LANE_COLORS: readonly [string, string, string, string] = ['#2de2ff', '#6f8dff', '#b86bff', '#ff4fa8'];
export const JUDGMENT_COLORS: Record<Judgment, string> = {
  perfect: COLORS.gold,
  great: COLORS.mint,
  good: '#9fd8ff',
  miss: COLORS.red,
};
export const JUDGMENT_LABELS: Record<Judgment, string> = {
  perfect: 'PERFECT',
  great: 'GREAT',
  good: 'GOOD',
  miss: 'MISS',
};

export const deckColor = (deck: DeckId): string => DECK_COLORS[deck];
export const laneColor = (lane: Lane | number): string => LANE_COLORS[lane as Lane] ?? COLORS.violet;

export const FONT_DISPLAY = "'Unbounded', 'Manrope', system-ui, sans-serif";
export const FONT_UI = "'Manrope', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
/** Canvas font shorthand, e.g. font(700, 14) or font(900, 32, FONT_DISPLAY). */
export const font = (weight: number, sizePx: number, family: string = FONT_UI): string =>
  `${weight} ${sizePx}px ${family}`;

/** '#rrggbb' → [r, g, b] */
export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** '#rrggbb' + alpha → 'rgba(r,g,b,a)' */
export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Mix two hex colours, t = 0 → a, t = 1 → b. */
export function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const c = (x: number, y: number): number => Math.round(x + (y - x) * t);
  return `rgb(${c(r1, r2)},${c(g1, g2)},${c(b1, b2)})`;
}

/** Colour along the aurora gradient, t = 0 cyan → 0.5 violet → 1 pink. */
export function aurora(t: number): string {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? mix(COLORS.cyan, COLORS.violet, x * 2) : mix(COLORS.violet, COLORS.pink, (x - 0.5) * 2);
}

export const hsl = (h: number, s: number, l: number, a = 1): string => `hsla(${h},${s}%,${l}%,${a})`;

/** Device pixel ratio to render canvases at. Capped: phones with dpr 3+ gain little and lose frames. */
export const canvasDpr = (max = 2): number =>
  Math.min(max, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);

/**
 * Size a canvas backing store for a CSS size and return a context scaled so that
 * 1 unit = 1 CSS pixel. Only reallocates when the size really changed.
 */
export function fitCanvas(
  canvas: HTMLCanvasElement,
  cssW: number,
  cssH: number,
  dpr: number = canvasDpr(),
): CanvasRenderingContext2D {
  const w = Math.max(1, Math.round(cssW * dpr));
  const h = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

const glowCache = new Map<string, HTMLCanvasElement>();

/**
 * A soft radial glow sprite (cached). Draw it with globalCompositeOperation = 'lighter'
 * instead of ctx.shadowBlur, which is far too slow per frame on phones.
 */
export function glowSprite(color: string, radius = 64): HTMLCanvasElement {
  const key = `${color}|${radius}`;
  let c = glowCache.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = c.height = radius * 2;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(radius, radius, 0, radius, radius, radius);
  grad.addColorStop(0, rgba(color, 0.9));
  grad.addColorStop(0.25, rgba(color, 0.45));
  grad.addColorStop(0.6, rgba(color, 0.12));
  grad.addColorStop(1, rgba(color, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, radius * 2, radius * 2);
  glowCache.set(key, c);
  return c;
}

/** Draw a cached glow centred on (x, y) with the given radius and strength (additive). */
export function drawGlow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
  strength = 1,
): void {
  if (strength <= 0 || radius <= 0) return;
  const prevOp = ctx.globalCompositeOperation;
  const prevAlpha = ctx.globalAlpha;
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = Math.min(1, strength) * prevAlpha;
  ctx.drawImage(glowSprite(color), x - radius, y - radius, radius * 2, radius * 2);
  ctx.globalCompositeOperation = prevOp;
  ctx.globalAlpha = prevAlpha;
}

/** Rounded-rect path helper (ctx.roundRect is missing on older iOS). */
export function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
