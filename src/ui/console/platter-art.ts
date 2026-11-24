/**
 * Pre-rendered sprites for the platter: the disc that turns (grip ring, strobe rim, record, label)
 * and the light that stays put (sheen, spindle). Built when the size or the track changes, never per frame.
 */
import type { DeckId, TrackMeta } from '../../core/types';
import { rng } from '../../core/math';
import { drawTrackArt } from '../../theme/art';
import { COLORS, FONT_DISPLAY, FONT_UI, font, rgba } from '../../theme/theme';
import { RING_INNER, TAU } from './logic';

/** Radii as fractions of the platter radius. */
export const RIM_INNER = 0.775;
export const VINYL_R = 0.762;
export const LABEL_R = 0.335;

const canvasOf = (size: number): [HTMLCanvasElement, CanvasRenderingContext2D] => {
  const c = document.createElement('canvas');
  c.width = c.height = Math.max(2, Math.round(size));
  return [c, c.getContext('2d')!];
};

const ring = (g: CanvasRenderingContext2D, c: number, r0: number, r1: number): void => {
  g.beginPath();
  g.arc(c, c, r1, 0, TAU);
  g.arc(c, c, r0, 0, TAU, true);
  g.closePath();
};

/** Text set on a circle, centred on `mid` (radians, 0 = 12 o'clock), reading clockwise. */
function arcText(g: CanvasRenderingContext2D, text: string, c: number, r: number, mid: number, maxArc: number, spacing: number): void {
  let chars = [...text];
  const width = (s: string[]): number => s.reduce((n, ch) => n + g.measureText(ch).width + spacing, 0);
  while (chars.length > 3 && width(chars) / r > maxArc) chars = [...chars.slice(0, -2), '…'];
  let a = mid - width(chars) / r / 2;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const ch of chars) {
    const w = g.measureText(ch).width + spacing;
    a += w / r / 2;
    g.save();
    g.translate(c + r * Math.sin(a), c - r * Math.cos(a));
    g.rotate(a);
    g.fillText(ch, 0, 0);
    g.restore();
    a += w / r / 2;
  }
}

/** Everything that turns with the audio. `px` = sprite size in device pixels. */
export function buildDisc(px: number, deck: DeckId, color: string, track: TrackMeta | null): HTMLCanvasElement {
  const [cv, g] = canvasOf(px);
  const c = cv.width / 2;
  const R = c - 1;
  const u = R / 100; // 1 unit = 1 % of the radius
  const rand = rng(track ? track.art.seed + 11 : 97);

  // grip ring: knurled metal, turned by the fingertips to bend the pitch
  const metal = g.createRadialGradient(c, c, R * RING_INNER, c, c, R);
  metal.addColorStop(0, '#0d0d12');
  metal.addColorStop(0.18, '#2c2c36');
  metal.addColorStop(0.6, '#3a3a46');
  metal.addColorStop(0.9, '#22222b');
  metal.addColorStop(1, '#0c0c10');
  ring(g, c, R * RING_INNER, R);
  g.fillStyle = metal;
  g.fill();
  const ridges = 96;
  g.lineCap = 'round';
  for (let i = 0; i < ridges; i++) {
    const a = (i / ridges) * TAU;
    const sx = Math.sin(a);
    const cy = -Math.cos(a);
    g.lineWidth = 1.5 * u;
    g.strokeStyle = 'rgba(0,0,0,0.55)';
    g.beginPath();
    g.moveTo(c + sx * R * 0.875, c + cy * R * 0.875);
    g.lineTo(c + sx * R * 0.972, c + cy * R * 0.972);
    g.stroke();
    const b = a + (0.42 / ridges) * TAU;
    g.lineWidth = 0.9 * u;
    g.strokeStyle = 'rgba(255,255,255,0.13)';
    g.beginPath();
    g.moveTo(c + Math.sin(b) * R * 0.88, c - Math.cos(b) * R * 0.88);
    g.lineTo(c + Math.sin(b) * R * 0.967, c - Math.cos(b) * R * 0.967);
    g.stroke();
  }
  // a lit notch on the ring, so its rotation reads from far away
  g.fillStyle = color;
  g.beginPath();
  g.arc(c, c, R * 0.925, -Math.PI / 2 - 0.035, -Math.PI / 2 + 0.035);
  g.lineWidth = 6.4 * u;
  g.strokeStyle = color;
  g.stroke();

  // platter rim with strobe dots
  const rim = g.createRadialGradient(c, c, R * RIM_INNER, c, c, R * RING_INNER);
  rim.addColorStop(0, '#08080c');
  rim.addColorStop(0.25, '#3d3d49');
  rim.addColorStop(0.55, '#565664');
  rim.addColorStop(1, '#17171d');
  ring(g, c, R * RIM_INNER, R * RING_INNER);
  g.fillStyle = rim;
  g.fill();
  const dots = 72;
  for (let i = 0; i < dots; i++) {
    const a = (i / dots) * TAU;
    g.fillStyle = i % 2 ? 'rgba(236,236,248,0.82)' : 'rgba(10,10,14,0.85)';
    g.beginPath();
    g.arc(c + Math.sin(a) * R * 0.811, c - Math.cos(a) * R * 0.811, 1.15 * u, 0, TAU);
    g.fill();
  }

  if (!track) {
    // bare platter with a felt slipmat
    g.fillStyle = '#101017';
    g.beginPath();
    g.arc(c, c, R * VINYL_R, 0, TAU);
    g.fill();
    for (let i = 0; i < 900; i++) {
      const a = rand() * TAU;
      const r = Math.sqrt(rand()) * R * VINYL_R;
      g.fillStyle = `rgba(255,255,255,${0.015 + rand() * 0.035})`;
      g.fillRect(c + Math.cos(a) * r, c + Math.sin(a) * r, 1.2 * u, 1.2 * u);
    }
    g.strokeStyle = rgba(color, 0.35);
    g.lineWidth = 1.2 * u;
    for (const r of [0.7, 0.66, 0.3]) {
      g.beginPath();
      g.arc(c, c, R * r, 0, TAU);
      g.stroke();
    }
    g.fillStyle = rgba(color, 0.55);
    g.font = font(800, 9.5 * u, FONT_UI);
    arcText(g, 'D J   H E R M A N N', c, R * 0.5, 0, 2.2, 0);
    arcText(g, 'N O   T R A C K', c, R * 0.5, Math.PI, 2.2, 0);
    g.fillStyle = rgba(color, 0.9);
    g.font = font(900, 34 * u, FONT_DISPLAY);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(deck, c, c + 1.5 * u);
    return cv;
  }

  // the record
  g.fillStyle = '#07070a';
  g.beginPath();
  g.arc(c, c, R * VINYL_R, 0, TAU);
  g.fill();
  // grooves: fine rings, with the darker gaps between "songs"
  const gaps = [0.46 + rand() * 0.04, 0.56 + rand() * 0.04, 0.665 + rand() * 0.03];
  const step = Math.max(1.1, 0.62 * u);
  for (let r = R * (LABEL_R + 0.03); r < R * (VINYL_R - 0.022); r += step) {
    const f = r / R;
    let alpha = 0.035 + rand() * 0.085;
    for (const gp of gaps) if (Math.abs(f - gp) < 0.007) alpha = 0;
    if (alpha === 0) continue;
    g.strokeStyle = `rgba(190,190,215,${alpha.toFixed(3)})`;
    g.lineWidth = step * 0.55;
    g.beginPath();
    g.arc(c, c, r, 0, TAU);
    g.stroke();
  }
  // bevelled edge of the vinyl
  g.strokeStyle = 'rgba(255,255,255,0.14)';
  g.lineWidth = 0.7 * u;
  g.beginPath();
  g.arc(c, c, R * (VINYL_R - 0.006), 0, TAU);
  g.stroke();

  // position marker: a strip of tape from the label to the edge, as DJs stick on their records
  g.strokeStyle = 'rgba(255,255,255,0.92)';
  g.lineWidth = 2.6 * u;
  g.lineCap = 'butt';
  g.beginPath();
  g.moveTo(c, c - R * (LABEL_R + 0.03));
  g.lineTo(c, c - R * (VINYL_R - 0.03));
  g.stroke();
  g.strokeStyle = rgba(color, 0.95);
  g.lineWidth = 1 * u;
  g.beginPath();
  g.moveTo(c, c - R * (LABEL_R + 0.03));
  g.lineTo(c, c - R * (VINYL_R - 0.03));
  g.stroke();

  // label: the track's cover art, with the title printed around it
  const lr = R * LABEL_R;
  drawTrackArt(g, c - lr, c - lr, lr * 2, track.art, { shape: 'circle' });
  ring(g, c, lr * 0.62, lr);
  g.fillStyle = 'rgba(6,6,12,0.62)';
  g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.35)';
  g.lineWidth = 0.5 * u;
  g.beginPath();
  g.arc(c, c, lr * 0.62, 0, TAU);
  g.stroke();
  g.beginPath();
  g.arc(c, c, lr - 0.3 * u, 0, TAU);
  g.stroke();
  g.fillStyle = '#ffffff';
  g.font = font(800, 6.6 * u, FONT_UI);
  arcText(g, track.title.toUpperCase(), c, lr * 0.81, 0, 3.6, 0.9 * u);
  g.fillStyle = rgba(COLORS.hwSilk, 0.75);
  g.font = font(700, 4.6 * u, FONT_UI);
  arcText(g, `SIDE ${deck}  ·  33⅓ RPM`, c, lr * 0.81, Math.PI, 2.2, 0.8 * u);
  return cv;
}

/** Light that does not turn: the sheen on the vinyl, the shading of the ring, the spindle. */
export function buildSheen(px: number, color: string, hasRecord: boolean): HTMLCanvasElement {
  const [cv, g] = canvasOf(px);
  const c = cv.width / 2;
  const R = c - 1;
  const conic = (stops: [number, string][]): CanvasGradient | null => {
    if (typeof g.createConicGradient !== 'function') return null;
    const grad = g.createConicGradient(0, c, c);
    for (const [at, col] of stops) grad.addColorStop(at, col);
    return grad;
  };
  const W = (a: number): string => `rgba(255,255,255,${a})`;
  const K = (a: number): string => `rgba(0,0,0,${a})`;

  if (hasRecord) {
    // two opposite wedges of light across the grooves (0 = 3 o'clock, clockwise)
    const sheen = conic([
      [0, W(0)], [0.08, W(0)], [0.125, W(0.07)], [0.17, W(0)],
      [0.55, W(0)], [0.6, W(0.1)], [0.635, W(0.3)], [0.67, W(0.1)], [0.72, W(0)], [1, W(0)],
    ]);
    if (sheen) {
      ring(g, c, R * (LABEL_R + 0.02), R * (VINYL_R - 0.012));
      g.fillStyle = sheen;
      g.fill();
    }
    // the deck's colour, reflected from below where the lit buttons are
    const tint = conic([
      [0, rgba(color, 0)], [0.16, rgba(color, 0)], [0.25, rgba(color, 0.16)], [0.34, rgba(color, 0)], [1, rgba(color, 0)],
    ]);
    if (tint) {
      ring(g, c, R * (LABEL_R + 0.02), R * (VINYL_R - 0.012));
      g.fillStyle = tint;
      g.fill();
    }
  }
  // strobe lamp: the rim dots catch the deck colour on one side
  const lamp = conic([
    [0, rgba(color, 0)], [0.28, rgba(color, 0)], [0.375, rgba(color, 0.75)], [0.47, rgba(color, 0)], [1, rgba(color, 0)],
  ]);
  if (lamp) {
    ring(g, c, R * RIM_INNER, R * RING_INNER);
    g.fillStyle = lamp;
    g.fill();
  }
  // grip ring: lit from the top-left, in shade at the bottom-right
  const shade = conic([
    [0, K(0.3)], [0.12, K(0.42)], [0.3, K(0.12)], [0.45, W(0.02)], [0.62, W(0.2)], [0.75, W(0.06)], [0.9, K(0.14)], [1, K(0.3)],
  ]);
  if (shade) {
    ring(g, c, R * RING_INNER, R);
    g.fillStyle = shade;
    g.fill();
  }
  g.strokeStyle = W(0.22);
  g.lineWidth = Math.max(1, R * 0.006);
  g.beginPath();
  g.arc(c, c, R - g.lineWidth, Math.PI * 0.95, Math.PI * 1.6);
  g.stroke();

  // spindle
  const sr = R * 0.05;
  g.fillStyle = K(0.55);
  g.beginPath();
  g.arc(c + sr * 0.18, c + sr * 0.3, sr * 1.25, 0, TAU);
  g.fill();
  const sp = g.createRadialGradient(c - sr * 0.35, c - sr * 0.4, sr * 0.05, c, c, sr);
  sp.addColorStop(0, '#ffffff');
  sp.addColorStop(0.35, '#c9c9d6');
  sp.addColorStop(0.8, '#6a6a78');
  sp.addColorStop(1, '#2e2e38');
  g.fillStyle = sp;
  g.beginPath();
  g.arc(c, c, sr, 0, TAU);
  g.fill();
  return cv;
}

/** Small record for the front strip: label art inside a ring of vinyl, with a marker. */
export function buildMiniDisc(px: number, color: string, track: TrackMeta | null): HTMLCanvasElement {
  const [cv, g] = canvasOf(px);
  const c = cv.width / 2;
  const R = c;
  g.fillStyle = '#08080c';
  g.beginPath();
  g.arc(c, c, R, 0, TAU);
  g.fill();
  for (let r = R * 0.62; r < R * 0.97; r += Math.max(1.5, R * 0.07)) {
    g.strokeStyle = 'rgba(200,200,225,0.12)';
    g.lineWidth = Math.max(0.75, R * 0.022);
    g.beginPath();
    g.arc(c, c, r, 0, TAU);
    g.stroke();
  }
  const lr = R * 0.54;
  if (track) {
    drawTrackArt(g, c - lr, c - lr, lr * 2, track.art, { shape: 'circle' });
    g.strokeStyle = 'rgba(255,255,255,0.9)';
    g.lineWidth = Math.max(1.5, R * 0.09);
    g.beginPath();
    g.moveTo(c, c - lr * 1.08);
    g.lineTo(c, c - R * 0.96);
    g.stroke();
  } else {
    g.fillStyle = '#15151d';
    g.beginPath();
    g.arc(c, c, lr, 0, TAU);
    g.fill();
    g.strokeStyle = rgba(color, 0.4);
    g.lineWidth = Math.max(1, R * 0.04);
    g.stroke();
  }
  return cv;
}
