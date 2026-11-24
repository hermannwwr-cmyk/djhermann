/**
 * Procedural drawings of a vinyl record, the light it catches and a tonearm. Everything is drawn
 * once into its own canvas; the screens then spin and tilt those canvases with CSS transforms, so
 * nothing here runs per frame.
 */
import { rng } from '../../core/math';
import type { TrackArt } from '../../core/types';
import { drawTrackArt } from '../../theme/art';
import { COLORS, FONT_DISPLAY, FONT_UI, font, hexToRgb } from '../../theme/theme';

const TAU = Math.PI * 2;

function makeCanvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = Math.max(8, Math.round(size));
  return [c, c.getContext('2d')!];
}

/** Text set along a circle, starting at `startAngle` and reading clockwise. */
function textOnArc(
  g: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  radius: number,
  startAngle: number,
  spacing: number,
): void {
  let a = startAngle;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const ch of text) {
    const wdt = g.measureText(ch).width + spacing;
    a += wdt / 2 / radius;
    g.save();
    g.translate(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
    g.rotate(a + Math.PI / 2);
    g.fillText(ch, 0, 0);
    g.restore();
    a += wdt / 2 / radius;
  }
}

export type RecordLabel = 'logo' | TrackArt;

export interface RecordOptions {
  /** what the paper label in the middle shows: the game's own label, or a track's cover art */
  label?: RecordLabel;
  seed?: number;
}

/**
 * The record itself, seen from straight above: black vinyl, grooves, the gaps between songs and a
 * paper label. This is the layer that spins.
 */
export function drawRecord(size: number, opts: RecordOptions = {}): HTMLCanvasElement {
  const [c, g] = makeCanvas(size);
  const S = c.width;
  const R = S / 2;
  const rand = rng(opts.seed ?? 33);

  // vinyl
  const body = g.createRadialGradient(R, R, R * 0.2, R, R, R);
  body.addColorStop(0, '#11111b');
  body.addColorStop(0.72, '#0a0a11');
  body.addColorStop(1, '#040407');
  g.fillStyle = body;
  g.beginPath();
  g.arc(R, R, R * 0.996, 0, TAU);
  g.fill();

  // grooves: fine rings of uneven brightness, with three smooth gaps between "songs"
  const r0 = R * 0.4;
  const r1 = R * 0.956;
  const gaps = [0.535, 0.672, 0.815].map((f) => R * f);
  const step = Math.max(1.25, S / 430);
  g.lineWidth = Math.max(0.75, S / 1100);
  for (let r = r0; r < r1; r += step) {
    if (gaps.some((gr) => Math.abs(r - gr) < S * 0.0045)) continue;
    const a = 0.03 + rand() * 0.075 + 0.02 * Math.sin(r * 0.09);
    g.strokeStyle = `rgba(185,190,255,${a.toFixed(3)})`;
    g.beginPath();
    g.arc(R, R, r, 0, TAU);
    g.stroke();
  }
  // louder passages: short brighter arcs, so the eye can see the record turning
  for (let i = 0; i < 90; i++) {
    const r = r0 + rand() * (r1 - r0);
    const start = rand() * TAU;
    g.strokeStyle = `rgba(215,220,255,${(0.035 + rand() * 0.075).toFixed(3)})`;
    g.lineWidth = Math.max(0.75, (S / 900) * (0.6 + rand()));
    g.beginPath();
    g.arc(R, R, r, start, start + 0.12 + rand() * 0.95);
    g.stroke();
  }
  // the gaps read as glossy black bands
  g.lineWidth = S * 0.006;
  g.strokeStyle = 'rgba(0,0,0,0.5)';
  for (const gr of gaps) {
    g.beginPath();
    g.arc(R, R, gr, 0, TAU);
    g.stroke();
  }
  // rim: a thin bevel that catches light
  g.lineWidth = S * 0.006;
  g.strokeStyle = 'rgba(255,255,255,0.13)';
  g.beginPath();
  g.arc(R, R, R * 0.991, 0, TAU);
  g.stroke();
  g.lineWidth = S * 0.004;
  g.strokeStyle = 'rgba(0,0,0,0.7)';
  g.beginPath();
  g.arc(R, R, R * 0.975, 0, TAU);
  g.stroke();

  // label
  const lr = R * 0.36;
  const label = opts.label ?? 'logo';
  if (label === 'logo') drawLogoLabel(g, R, R, lr);
  else {
    drawTrackArt(g, R - lr, R - lr, lr * 2, label, { shape: 'circle' });
    g.fillStyle = 'rgba(8,6,16,0.16)';
    g.beginPath();
    g.arc(R, R, lr, 0, TAU);
    g.fill();
  }
  // label edge + pressed ring
  g.lineWidth = Math.max(1, S * 0.004);
  g.strokeStyle = 'rgba(0,0,0,0.45)';
  g.beginPath();
  g.arc(R, R, lr, 0, TAU);
  g.stroke();
  g.lineWidth = Math.max(1, S * 0.0025);
  g.strokeStyle = 'rgba(255,255,255,0.22)';
  g.beginPath();
  g.arc(R, R, lr * 0.45, 0, TAU);
  g.stroke();

  // spindle
  const sp = g.createRadialGradient(R - lr * 0.03, R - lr * 0.04, 0, R, R, lr * 0.115);
  sp.addColorStop(0, '#ffffff');
  sp.addColorStop(0.45, '#b9b9c8');
  sp.addColorStop(1, '#4b4b5a');
  g.fillStyle = 'rgba(0,0,0,0.6)';
  g.beginPath();
  g.arc(R, R, lr * 0.15, 0, TAU);
  g.fill();
  g.fillStyle = sp;
  g.beginPath();
  g.arc(R, R, lr * 0.105, 0, TAU);
  g.fill();
  return c;
}

function drawLogoLabel(g: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  g.save();
  g.beginPath();
  g.arc(cx, cy, r, 0, TAU);
  g.clip();
  const grad = g.createLinearGradient(cx - r, cy - r * 0.5, cx + r, cy + r * 0.5);
  grad.addColorStop(0, COLORS.cyan);
  grad.addColorStop(0.52, COLORS.violet);
  grad.addColorStop(1, COLORS.pink);
  g.fillStyle = grad;
  g.fillRect(cx - r, cy - r, r * 2, r * 2);

  // a dark half: a two-tone label shows the spin far better than a plain one
  g.fillStyle = 'rgba(10,7,20,0.86)';
  g.beginPath();
  g.moveTo(cx, cy);
  g.arc(cx, cy, r, Math.PI * 0.98, Math.PI * 2.02);
  g.closePath();
  g.fill();

  // light from the top-left
  const light = g.createRadialGradient(cx - r * 0.4, cy - r * 0.5, 0, cx, cy, r * 1.1);
  light.addColorStop(0, 'rgba(255,255,255,0.28)');
  light.addColorStop(0.55, 'rgba(255,255,255,0)');
  light.addColorStop(1, 'rgba(0,0,0,0.25)');
  g.fillStyle = light;
  g.fillRect(cx - r, cy - r, r * 2, r * 2);

  // lettering
  g.fillStyle = 'rgba(244,243,255,0.95)';
  g.font = font(900, r * 0.27, FONT_DISPLAY);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('DJ', cx, cy - r * 0.62);
  g.font = font(900, r * 0.2, FONT_DISPLAY);
  g.fillText('HERMANN', cx, cy - r * 0.33);
  g.fillStyle = 'rgba(10,7,20,0.82)';
  g.font = font(800, r * 0.105, FONT_UI);
  textOnArc(g, 'ORIGINAL CLUB SOUND  ·  33⅓ RPM  ·  SIDE A', cx, cy, r * 0.8, Math.PI * 0.86, r * 0.022);
  g.restore();
}

interface SheenLight {
  /** canvas angle of the streak: 0 = right, PI/2 = towards the bottom of the canvas */
  angle: number;
  /** angular half-width in radians */
  width: number;
  color: string;
  strength: number;
}

const DEFAULT_LIGHTS: SheenLight[] = [
  // cyan from the front-left, pink from the front-right, each with a fainter twin on the far side
  { angle: Math.PI / 2 + 0.62, width: 0.36, color: COLORS.cyan, strength: 0.42 },
  { angle: Math.PI / 2 + 0.62, width: 0.08, color: '#d8fbff', strength: 0.7 },
  { angle: Math.PI / 2 - 0.62, width: 0.36, color: COLORS.pink, strength: 0.42 },
  { angle: Math.PI / 2 - 0.62, width: 0.08, color: '#ffe0f0', strength: 0.7 },
  { angle: -Math.PI / 2 + 0.62, width: 0.3, color: COLORS.cyan, strength: 0.28 },
  { angle: -Math.PI / 2 + 0.62, width: 0.06, color: '#d8fbff', strength: 0.3 },
  { angle: -Math.PI / 2 - 0.62, width: 0.3, color: COLORS.pink, strength: 0.28 },
  { angle: -Math.PI / 2 - 0.62, width: 0.06, color: '#ffe0f0', strength: 0.3 },
  { angle: -Math.PI / 2, width: 0.75, color: COLORS.violet, strength: 0.1 },
];

function sheenAt(theta: number, lights: SheenLight[]): [number, number, number, number] {
  let r = 0;
  let gg = 0;
  let b = 0;
  let total = 0;
  for (const l of lights) {
    let d = Math.abs(theta - l.angle) % TAU;
    if (d > Math.PI) d = TAU - d;
    const k = l.strength * Math.exp(-((d / l.width) * (d / l.width)));
    const [lr, lg, lb] = hexToRgb(l.color);
    r += lr * k;
    gg += lg * k;
    b += lb * k;
    total += k;
  }
  if (total < 1e-4) return [255, 255, 255, 0];
  return [Math.round(r / total), Math.round(gg / total), Math.round(b / total), Math.min(0.9, total)];
}

/**
 * The light a record catches: streaks that run from the label to the rim and stay put while the
 * record turns under them. Drawn to sit exactly on top of drawRecord() at the same size.
 */
export function drawSheen(size: number, lights: SheenLight[] = DEFAULT_LIGHTS): HTMLCanvasElement {
  const [c, g] = makeCanvas(size);
  const S = c.width;
  const R = S / 2;

  const conic = (g as CanvasRenderingContext2D & { createConicGradient?: (a: number, x: number, y: number) => CanvasGradient })
    .createConicGradient;
  if (typeof conic === 'function') {
    const grad = conic.call(g, 0, R, R);
    const stops = 180;
    for (let i = 0; i <= stops; i++) {
      const [r, gg, b, a] = sheenAt((i / stops) * TAU, lights);
      grad.addColorStop(i / stops, `rgba(${r},${gg},${b},${a.toFixed(3)})`);
    }
    g.fillStyle = grad;
    g.beginPath();
    g.arc(R, R, R, 0, TAU);
    g.fill();
  } else {
    // older Safari: thin overlapping wedges
    const slices = 360;
    for (let i = 0; i < slices; i++) {
      const a0 = (i / slices) * TAU;
      const a1 = ((i + 1.6) / slices) * TAU;
      const [r, gg, b, a] = sheenAt((a0 + a1) / 2, lights);
      if (a < 0.004) continue;
      g.fillStyle = `rgba(${r},${gg},${b},${(a * 0.8).toFixed(3)})`;
      g.beginPath();
      g.moveTo(R, R);
      g.arc(R, R, R, a0, a1);
      g.closePath();
      g.fill();
    }
  }

  // only the grooved part shines: fade out over the label and soften at the rim
  g.globalCompositeOperation = 'destination-in';
  const mask = g.createRadialGradient(R, R, 0, R, R, R);
  mask.addColorStop(0, 'rgba(0,0,0,0)');
  mask.addColorStop(0.37, 'rgba(0,0,0,0)');
  mask.addColorStop(0.44, 'rgba(0,0,0,0.85)');
  mask.addColorStop(0.7, 'rgba(0,0,0,1)');
  mask.addColorStop(0.95, 'rgba(0,0,0,0.9)');
  mask.addColorStop(0.985, 'rgba(0,0,0,0.5)');
  mask.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = mask;
  g.fillRect(0, 0, S, S);

  // the grooves cut the light into fine lines
  g.globalCompositeOperation = 'destination-out';
  const rand = rng(77);
  g.lineWidth = Math.max(0.75, S / 900);
  for (let r = R * 0.4; r < R * 0.96; r += Math.max(1.5, S / 300)) {
    g.strokeStyle = `rgba(0,0,0,${(0.12 + rand() * 0.4).toFixed(3)})`;
    g.beginPath();
    g.arc(R, R, r + rand() * 1.5, 0, TAU);
    g.stroke();
  }
  for (const f of [0.535, 0.672, 0.815]) {
    g.lineWidth = S * 0.006;
    g.strokeStyle = 'rgba(0,0,0,0.55)';
    g.beginPath();
    g.arc(R, R, R * f, 0, TAU);
    g.stroke();
  }
  g.globalCompositeOperation = 'source-over';
  return c;
}

/**
 * The platter the record sits on, seen from above: a dark metal disc a little larger than the
 * record, with the rows of strobe dots that every DJ turntable has around its edge.
 * `recordFraction` is the record's radius as a fraction of the platter's.
 */
export function drawPlatter(size: number, recordFraction = 0.94): HTMLCanvasElement {
  const [c, g] = makeCanvas(size);
  const S = c.width;
  const R = S / 2;
  const metal = g.createRadialGradient(R, R, R * 0.8, R, R, R);
  metal.addColorStop(0, '#1b1b25');
  metal.addColorStop(0.55, '#2c2c3a');
  metal.addColorStop(0.8, '#3c3c4e');
  metal.addColorStop(1, '#15151d');
  g.fillStyle = metal;
  g.beginPath();
  g.arc(R, R, R * 0.998, 0, TAU);
  g.fill();

  // strobe dots: two staggered rows
  const rows = [
    { r: R * (recordFraction + (1 - recordFraction) * 0.36), n: 120, d: S * 0.0052 },
    { r: R * (recordFraction + (1 - recordFraction) * 0.72), n: 132, d: S * 0.0052 },
  ];
  g.fillStyle = 'rgba(232,232,246,0.82)';
  for (const row of rows) {
    for (let i = 0; i < row.n; i++) {
      const a = (i / row.n) * TAU;
      g.beginPath();
      g.arc(R + Math.cos(a) * row.r, R + Math.sin(a) * row.r, row.d / 2, 0, TAU);
      g.fill();
    }
  }
  // bevel
  g.lineWidth = S * 0.004;
  g.strokeStyle = 'rgba(255,255,255,0.22)';
  g.beginPath();
  g.arc(R, R, R * 0.992, 0, TAU);
  g.stroke();
  return c;
}

/**
 * A tonearm seen from above, drawn into a square canvas. The pivot sits at (pivotX, pivotY) and
 * the stylus rests at (stylusX, stylusY), all as fractions of the canvas size.
 */
export function drawTonearm(
  size: number,
  pivotX: number,
  pivotY: number,
  stylusX: number,
  stylusY: number,
): HTMLCanvasElement {
  const [c, g] = makeCanvas(size);
  const S = c.width;
  const px = pivotX * S;
  const py = pivotY * S;
  const sx = stylusX * S;
  const sy = stylusY * S;
  const len = Math.hypot(sx - px, sy - py);
  const ang = Math.atan2(sy - py, sx - px);
  const u = S / 100; // one unit = 1 % of the canvas

  /** polished metal seen across a tube of the given half-width */
  const metalAcross = (halfWidth: number): CanvasGradient => {
    const m = g.createLinearGradient(0, -halfWidth, 0, halfWidth);
    m.addColorStop(0, '#8f8fa3');
    m.addColorStop(0.22, '#ffffff');
    m.addColorStop(0.5, '#b4b4c6');
    m.addColorStop(0.78, '#5a5a6b');
    m.addColorStop(1, '#2b2b38');
    return m;
  };
  const bar = (x: number, halfWidth: number, length: number, radius = halfWidth): void => {
    g.beginPath();
    g.moveTo(x + radius, -halfWidth);
    g.arcTo(x + length, -halfWidth, x + length, halfWidth, radius);
    g.arcTo(x + length, halfWidth, x, halfWidth, radius);
    g.arcTo(x, halfWidth, x, -halfWidth, radius);
    g.arcTo(x, -halfWidth, x + length, -halfWidth, radius);
    g.closePath();
    g.fill();
  };

  // pivot housing (under the arm)
  const base = g.createRadialGradient(px - u * 2, py - u * 2.5, 0, px, py, u * 7.4);
  base.addColorStop(0, '#565669');
  base.addColorStop(0.55, '#262632');
  base.addColorStop(1, '#0d0d14');
  g.fillStyle = base;
  g.beginPath();
  g.arc(px, py, u * 7.2, 0, TAU);
  g.fill();
  g.lineWidth = u * 0.55;
  g.strokeStyle = 'rgba(255,255,255,0.28)';
  g.beginPath();
  g.arc(px, py, u * 6.85, 0, TAU);
  g.stroke();
  g.lineWidth = u * 0.5;
  g.strokeStyle = 'rgba(0,0,0,0.6)';
  g.beginPath();
  g.arc(px, py, u * 4.4, 0, TAU);
  g.stroke();

  g.save();
  g.translate(px, py);
  g.rotate(ang);

  // counterweight behind the pivot, with its ribbed grip
  g.fillStyle = metalAcross(u * 3.1);
  bar(-u * 13, u * 3.1, u * 7.5, u * 0.8);
  g.fillStyle = 'rgba(0,0,0,0.4)';
  for (let i = 0; i < 6; i++) g.fillRect(-u * 12.3 + i * u * 1.15, -u * 3.1, u * 0.4, u * 6.2);
  g.fillStyle = metalAcross(u * 1.5);
  bar(-u * 6, u * 1.5, u * 6.5, u * 0.5);

  // the tube
  g.fillStyle = metalAcross(u * 1.15);
  bar(-u * 0.5, u * 1.15, len - u * 8.5, u * 1.1);

  // headshell, angled in towards the spindle, with the cartridge under it
  g.translate(len - u * 9.6, 0);
  g.rotate(0.38);
  g.fillStyle = '#101018';
  bar(-u * 1, u * 2.5, u * 11.6, u * 0.7);
  g.fillStyle = metalAcross(u * 2.5);
  g.globalAlpha = 0.92;
  bar(-u * 1, u * 2.5, u * 4.4, u * 0.7);
  g.globalAlpha = 1;
  // cartridge body: the one coloured thing on the arm
  const cart = g.createLinearGradient(0, -u * 2, 0, u * 2);
  cart.addColorStop(0, '#ffb1d8');
  cart.addColorStop(0.5, '#ff4fa8');
  cart.addColorStop(1, '#b41f6e');
  g.fillStyle = cart;
  bar(u * 4.6, u * 2, u * 5.6, u * 0.5);
  // finger lift
  g.fillStyle = metalAcross(u * 0.6);
  g.save();
  g.translate(u * 2.2, -u * 2.4);
  g.rotate(-Math.PI / 2 - 0.25);
  bar(0, u * 0.6, u * 4.2, u * 0.6);
  g.restore();
  g.restore();

  // bearing cap on top of the pivot
  const cap = g.createRadialGradient(px - u * 1.2, py - u * 1.4, 0, px, py, u * 3.4);
  cap.addColorStop(0, '#ffffff');
  cap.addColorStop(0.45, '#b9b9c8');
  cap.addColorStop(1, '#3d3d4b');
  g.fillStyle = cap;
  g.beginPath();
  g.arc(px, py, u * 3.2, 0, TAU);
  g.fill();
  g.lineWidth = u * 0.35;
  g.strokeStyle = 'rgba(0,0,0,0.5)';
  g.beginPath();
  g.arc(px, py, u * 3.2, 0, TAU);
  g.stroke();
  return c;
}

/**
 * A spinning record as an element: the record turns (CSS), the light on it stays put.
 * `sizePx` is the CSS size it will be shown at; the caller sizes the element.
 */
export function recordElement(sizePx: number, label: RecordLabel = 'logo', className = ''): HTMLDivElement {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const el = document.createElement('div');
  el.className = className ? `sc-minirec ${className}` : 'sc-minirec';
  el.setAttribute('aria-hidden', 'true');
  const spin = document.createElement('div');
  spin.className = 'sc-minirec__spin';
  spin.appendChild(drawRecord(sizePx * dpr, { label }));
  const sheen = document.createElement('div');
  sheen.className = 'sc-minirec__sheen';
  sheen.appendChild(drawSheen(sizePx * dpr));
  el.append(spin, sheen);
  return el;
}
