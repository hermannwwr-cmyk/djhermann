/**
 * Procedural cover art for a track, drawn from its TrackArt (two hues + a seed).
 * Used for the label on the vinyl and for covers in menus, so a track looks the same everywhere.
 */
import type { TrackArt } from '../core/types';
import { rng } from '../core/math';
import { hsl } from './theme';

export interface ArtOptions {
  /** 'circle' for a record label, 'rounded' for a cover (default) */
  shape?: 'circle' | 'rounded';
  /** corner radius as a fraction of size for 'rounded' (default 0.18) */
  radius?: number;
}

/** Draw the art into the square (x, y, size, size). */
export function drawTrackArt(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  art: TrackArt,
  opts: ArtOptions = {},
): void {
  const rand = rng(art.seed);
  const cx = x + size / 2;
  const cy = y + size / 2;
  ctx.save();
  ctx.beginPath();
  if (opts.shape === 'circle') {
    ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
  } else {
    const r = size * (opts.radius ?? 0.18);
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + size, y, x + size, y + size, r);
    ctx.arcTo(x + size, y + size, x, y + size, r);
    ctx.arcTo(x, y + size, x, y, r);
    ctx.arcTo(x, y, x + size, y, r);
  }
  ctx.closePath();
  ctx.clip();

  // sky: a diagonal blend of the two hues
  const ang = rand() * Math.PI * 2;
  const dx = Math.cos(ang) * size * 0.6;
  const dy = Math.sin(ang) * size * 0.6;
  const sky = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
  sky.addColorStop(0, hsl(art.hueA, 88, 56));
  sky.addColorStop(0.55, hsl((art.hueA + art.hueB) / 2 + (Math.abs(art.hueA - art.hueB) > 180 ? 180 : 0), 80, 40));
  sky.addColorStop(1, hsl(art.hueB, 85, 30));
  ctx.fillStyle = sky;
  ctx.fillRect(x, y, size, size);

  const motif = Math.floor(rand() * 3);
  if (motif === 0) {
    // a low sun cut by horizon lines
    const sx = x + size * (0.3 + rand() * 0.4);
    const sy = y + size * (0.42 + rand() * 0.16);
    const sr = size * (0.2 + rand() * 0.1);
    const sun = ctx.createLinearGradient(0, sy - sr, 0, sy + sr);
    sun.addColorStop(0, hsl(art.hueA + 30, 100, 86, 0.95));
    sun.addColorStop(1, hsl(art.hueB, 100, 66, 0.9));
    ctx.fillStyle = sun;
    ctx.beginPath();
    ctx.arc(sx, sy, sr, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = hsl(art.hueB, 70, 14, 0.9);
    const base = y + size * 0.62;
    for (let i = 0; i < 6; i++) {
      const yy = base + (i * i * size) / 60;
      ctx.fillRect(x, yy, size, Math.max(1, size * (0.012 + i * 0.012)));
    }
    ctx.fillStyle = hsl(art.hueB, 60, 10, 0.55);
    ctx.fillRect(x, y + size * 0.78, size, size * 0.22);
  } else if (motif === 1) {
    // rings rippling out from an off-centre point
    const rx = x + size * (0.2 + rand() * 0.6);
    const ry = y + size * (0.2 + rand() * 0.6);
    ctx.lineWidth = Math.max(1, size * 0.022);
    for (let i = 1; i <= 9; i++) {
      ctx.strokeStyle = hsl(i % 2 ? art.hueA + 20 : art.hueB - 20, 100, 82, 0.5 - i * 0.04);
      ctx.beginPath();
      ctx.arc(rx, ry, (i * size) / 9, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = hsl(art.hueA + 40, 100, 90, 0.9);
    ctx.beginPath();
    ctx.arc(rx, ry, size * 0.045, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // layered hills of sound
    const layers = 5;
    for (let l = 0; l < layers; l++) {
      const t = l / (layers - 1);
      const baseY = y + size * (0.34 + t * 0.52);
      const amp = size * (0.06 + rand() * 0.07);
      const freq = 1.2 + rand() * 2.2;
      const ph = rand() * Math.PI * 2;
      ctx.fillStyle = hsl(art.hueA + (art.hueB - art.hueA) * t, 85, 70 - t * 48, 0.82);
      ctx.beginPath();
      ctx.moveTo(x, y + size);
      for (let i = 0; i <= 24; i++) {
        const px = x + (i / 24) * size;
        ctx.lineTo(px, baseY + Math.sin((i / 24) * Math.PI * freq + ph) * amp);
      }
      ctx.lineTo(x + size, y + size);
      ctx.closePath();
      ctx.fill();
    }
  }

  // soft light from the top-left, shade at the bottom-right
  const light = ctx.createRadialGradient(x + size * 0.25, y + size * 0.2, 0, cx, cy, size * 0.85);
  light.addColorStop(0, 'rgba(255,255,255,0.22)');
  light.addColorStop(0.5, 'rgba(255,255,255,0)');
  light.addColorStop(1, 'rgba(0,0,0,0.3)');
  ctx.fillStyle = light;
  ctx.fillRect(x, y, size, size);
  ctx.restore();
}

/** Render the art once to its own canvas (cache the result; do not call per frame). */
export function trackArtCanvas(art: TrackArt, sizePx: number, opts: ArtOptions = {}): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = Math.max(1, Math.round(sizePx));
  drawTrackArt(c.getContext('2d')!, 0, 0, c.width, art, opts);
  return c;
}
