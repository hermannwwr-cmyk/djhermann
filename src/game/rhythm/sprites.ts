/**
 * Pre-rendered note sprites. Every lane has its own outline and glyph, so the lanes read apart by
 * shape as well as by colour (colour-blind players), and the receptor slot at the hit line has the
 * same outline as the notes that land in it:
 *
 *   BOOM  a round pill with a kick-drum dot
 *   CLAP  a squared block with two bars (two hands)
 *   ZAP   a hexagon with pointed ends and a zigzag
 *   HORN  a slanted block with a star
 *
 * Glow is baked in with shadowBlur here, once, never per frame.
 */
import type { Lane } from '../../core/types';
import { COLORS, LANE_COLORS, mix, rgba } from '../../theme/theme';

/** Trace a lane's note outline into the current path, in a box of w × h at (x, y). */
export function noteShapePath(ctx: CanvasRenderingContext2D, lane: number, x: number, y: number, w: number, h: number): void {
  ctx.beginPath();
  switch (lane) {
    case 0: {
      const r = h / 2;
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2);
      ctx.lineTo(x + r, y + h);
      ctx.arc(x + r, y + r, r, Math.PI / 2, (Math.PI * 3) / 2);
      break;
    }
    case 1: {
      const r = Math.min(h * 0.24, w / 2);
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      break;
    }
    case 2: {
      const k = h * 0.5;
      ctx.moveTo(x + k, y);
      ctx.lineTo(x + w - k, y);
      ctx.lineTo(x + w, y + h / 2);
      ctx.lineTo(x + w - k, y + h);
      ctx.lineTo(x + k, y + h);
      ctx.lineTo(x, y + h / 2);
      break;
    }
    default: {
      const k = h * 0.42;
      ctx.moveTo(x + k, y);
      ctx.lineTo(x + w, y);
      ctx.lineTo(x + w - k, y + h);
      ctx.lineTo(x, y + h);
      break;
    }
  }
  ctx.closePath();
}

/** Draw a lane's glyph centred on (cx, cy) for a note of height h. */
function glyph(ctx: CanvasRenderingContext2D, lane: number, cx: number, cy: number, h: number, color: string): void {
  const g = h * 0.3;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  switch (lane) {
    case 0: {
      ctx.lineWidth = Math.max(1.2, h * 0.1);
      ctx.beginPath();
      ctx.arc(cx, cy, g * 0.95, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, g * 0.38, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 1: {
      const bw = Math.max(1.6, h * 0.13);
      const bh = g * 2;
      ctx.beginPath();
      ctx.rect(cx - g * 0.55 - bw / 2, cy - bh / 2, bw, bh);
      ctx.rect(cx + g * 0.55 - bw / 2, cy - bh / 2, bw, bh);
      ctx.fill();
      break;
    }
    case 2: {
      ctx.lineWidth = Math.max(1.4, h * 0.12);
      ctx.beginPath();
      ctx.moveTo(cx - g * 1.3, cy + g * 0.55);
      ctx.lineTo(cx - g * 0.45, cy - g * 0.6);
      ctx.lineTo(cx + g * 0.45, cy + g * 0.6);
      ctx.lineTo(cx + g * 1.3, cy - g * 0.55);
      ctx.stroke();
      break;
    }
    default: {
      const ro = g * 1.2;
      const ri = g * 0.4;
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 4;
        const r = i % 2 === 0 ? ro : ri;
        if (i === 0) ctx.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
        else ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      }
      ctx.closePath();
      ctx.fill();
      break;
    }
  }
}

export interface NoteSprite {
  canvas: HTMLCanvasElement;
  /** margin around the note box (CSS px) that holds the glow */
  pad: number;
  /** note box size in CSS px */
  w: number;
  h: number;
}

/**
 * Render one note: glow, a lit body in the lane colour, a hot rim and the lane glyph.
 * `dead` renders the grey, unlit version used for a missed note as it slides away.
 */
export function renderNote(lane: Lane, w: number, h: number, dpr: number, dead: boolean): NoteSprite {
  const pad = Math.ceil(h * 0.9) + 4;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil((w + pad * 2) * dpr);
  canvas.height = Math.ceil((h + pad * 2) * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  const base = LANE_COLORS[lane];
  const color = dead ? mix(base, COLORS.ink4, 0.78) : base;
  const x = pad;
  const y = pad;

  // glow (baked)
  if (!dead) {
    ctx.save();
    ctx.shadowColor = rgba(base, 0.95);
    ctx.shadowBlur = h * 0.85 * dpr;
    noteShapePath(ctx, lane, x, y, w, h);
    ctx.fillStyle = base;
    ctx.fill();
    ctx.shadowBlur = h * 0.35 * dpr;
    ctx.fill();
    ctx.restore();
  }

  // body
  const body = ctx.createLinearGradient(0, y, 0, y + h);
  if (dead) {
    body.addColorStop(0, rgba(COLORS.ink3, 0.55));
    body.addColorStop(1, rgba(COLORS.bg4, 0.55));
  } else {
    body.addColorStop(0, mix(base, '#ffffff', 0.62));
    body.addColorStop(0.45, mix(base, '#ffffff', 0.12));
    body.addColorStop(1, mix(base, '#000000', 0.3));
  }
  noteShapePath(ctx, lane, x, y, w, h);
  ctx.fillStyle = body;
  ctx.fill();

  // specular band across the top half
  ctx.save();
  noteShapePath(ctx, lane, x, y, w, h);
  ctx.clip();
  const spec = ctx.createLinearGradient(0, y, 0, y + h * 0.5);
  spec.addColorStop(0, `rgba(255,255,255,${dead ? 0.12 : 0.55})`);
  spec.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = spec;
  ctx.fillRect(x, y, w, h * 0.5);
  ctx.restore();

  // rim
  noteShapePath(ctx, lane, x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.lineJoin = 'round';
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = dead ? rgba(COLORS.ink3, 0.5) : mix(base, '#ffffff', 0.78);
  ctx.stroke();

  glyph(ctx, lane, x + w / 2, y + h / 2, h, dead ? rgba(COLORS.ink, 0.35) : 'rgba(6,6,16,0.78)');
  return { canvas, pad, w, h };
}

/** Cache of note sprites keyed by size, so the drawer animation reuses what it rendered before. */
export class SpriteCache {
  private readonly map = new Map<string, NoteSprite[]>();

  /** live sprites [lane 0..3] followed by dead sprites [lane 0..3] for a note box of w × h */
  get(w: number, h: number, dpr: number): NoteSprite[] {
    const qw = Math.max(8, Math.round(w));
    const qh = Math.max(6, Math.round(h));
    const key = `${qw}x${qh}@${dpr}`;
    let set = this.map.get(key);
    if (set) return set;
    set = [];
    for (let dead = 0; dead < 2; dead++) {
      for (let lane = 0; lane < 4; lane++) set.push(renderNote(lane as Lane, qw, qh, dpr, dead === 1));
    }
    if (this.map.size > 24) this.map.clear();
    this.map.set(key, set);
    return set;
  }
}
