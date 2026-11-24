/**
 * The note highway, drawn on one canvas: a lane-coloured road in slight perspective, beat lines
 * that scroll with the record, a hit line that breathes with the beat, the notes, and the hit
 * effects (lane beams, bursts, rings, sparks, the judgment word and the combo).
 *
 * Performance rules: the canvas backing store is sized once for the tallest slot it is likely to
 * get, so the console drawer animation never reallocates it; the static road is cached on an
 * offscreen canvas; notes are pre-rendered sprites; effects live in fixed pools; no shadowBlur.
 */
import { clamp, clamp01, damp, easeOutBack, easeOutCubic, smoothstep } from '../../core/math';
import type { DeckId, Difficulty, FrameState, Judgment, Lane, SettingsStore } from '../../core/types';
import { LANE_COUNT } from '../../core/types';
import {
  COLORS,
  FONT_DISPLAY,
  JUDGMENT_COLORS,
  JUDGMENT_LABELS,
  LANE_COLORS,
  canvasDpr,
  deckColor,
  drawGlow,
  font,
  glowSprite,
  rgba,
} from '../../theme/theme';
import { FADING, MISSED, SHOWN, WINDOW_MS, WINDOW_SCALE, lowerBound } from './core';
import type { DeckNotes, JudgeFx, RhythmCore } from './core';
import { computeLayout, laneCenter, scaleAt, yAtScale } from './layout';
import type { Layout } from './layout';
import { SpriteCache, noteShapePath } from './sprites';
import type { NoteSprite } from './sprites';

/** colours used by the effect pools, by index */
const PALETTE = [
  LANE_COLORS[0],
  LANE_COLORS[1],
  LANE_COLORS[2],
  LANE_COLORS[3],
  COLORS.gold,
  COLORS.goldHot,
  COLORS.mint,
  JUDGMENT_COLORS.good,
  COLORS.red,
  '#ffffff',
] as const;
const C_GOLD = 4;
const C_HOT = 5;
const C_RED = 8;
const C_WHITE = 9;
const J_COLOR: Record<Judgment, number> = { perfect: C_GOLD, great: 6, good: 7, miss: C_RED };
/** the combo number heats up with the multiplier */
const COMBO_COLORS = [COLORS.ink, COLORS.cyan, COLORS.pink, COLORS.gold] as const;
const COMBO_LABELS = ['COMBO', 'COMBO  ×2', 'COMBO  ×3', 'COMBO  ×4'] as const;
const COMBO_MIN = 4;

const MAX_PARTICLES = 160;
const MAX_RINGS = 16;
const MAX_FLASHES = 10;
/** how long the old deck's notes take to fade out after a crossfade */
export const FADE_MS = 450;
/** how long a note takes to fade in when it was decided inside the highway */
const APPEAR_MS = 220;
/** how far a missed note keeps sliding (in beats) while it fades */
const MISS_TAIL_BEATS = 0.8;

type CtxWithSpacing = CanvasRenderingContext2D & { letterSpacing?: string };

export class HighwayView {
  readonly canvas: HTMLCanvasElement;
  /** 0..1 per lane: how close the next note of that lane is (drives the pad backlight) */
  readonly cue = new Float32Array(LANE_COUNT);

  private readonly ctx: CanvasRenderingContext2D;
  private readonly stat: HTMLCanvasElement;
  private readonly sctx: CanvasRenderingContext2D;
  private readonly sprites = new SpriteCache();
  private readonly core: RhythmCore;
  private readonly settings: SettingsStore;
  private L: Layout | null = null;
  private slotW = 0;
  private slotH = 0;
  private padH = 0;
  private dpr = 1;
  private allocW = 0;
  private allocH = 0;
  private staticDirty = true;
  private noteSprites: NoteSprite[] = [];
  private hitGrad: CanvasGradient | null = null;
  private beamGrads: CanvasGradient[] = [];
  private missGrad: CanvasGradient | null = null;
  private hitGlow: HTMLCanvasElement | null = null;
  private hitGlowW = 0;
  private beamLen = 0;
  private wordFont = '';
  private comboFont = '';
  private labelFont = '';
  private subFont = '';
  private hasSpacing = false;

  // ── animated state ──
  private now = 0;
  private alive = 0;
  private readonly beam = new Float32Array(LANE_COUNT);
  private readonly missBeam = new Float32Array(LANE_COUNT);
  private readonly press = new Float32Array(LANE_COUNT);
  private readonly held = new Uint8Array(LANE_COUNT);

  private wordJ: Judgment = 'perfect';
  private wordT0 = -1e9;
  private wordSub = '';

  private combo = 0;
  private comboStr = '';
  private multiplier = 1;
  private comboT0 = -1e9;
  private breakStr = '';
  private breakT0 = -1e9;
  private breakMult = 1;
  private milestoneT0 = -1e9;

  // particles
  private readonly px = new Float32Array(MAX_PARTICLES);
  private readonly py = new Float32Array(MAX_PARTICLES);
  private readonly pvx = new Float32Array(MAX_PARTICLES);
  private readonly pvy = new Float32Array(MAX_PARTICLES);
  private readonly plife = new Float32Array(MAX_PARTICLES);
  private readonly pmax = new Float32Array(MAX_PARTICLES);
  private readonly psize = new Float32Array(MAX_PARTICLES);
  private readonly pcol = new Uint8Array(MAX_PARTICLES);
  private pNext = 0;
  private pAlive = 0;

  // rings (flattened ellipses on the road)
  private readonly rx = new Float32Array(MAX_RINGS);
  private readonly ry = new Float32Array(MAX_RINGS);
  private readonly rt0 = new Float64Array(MAX_RINGS);
  private readonly rsize = new Float32Array(MAX_RINGS);
  private readonly rdur = new Float32Array(MAX_RINGS);
  private readonly rcol = new Uint8Array(MAX_RINGS);
  private rNext = 0;

  // glow flashes
  private readonly fx = new Float32Array(MAX_FLASHES);
  private readonly fy = new Float32Array(MAX_FLASHES);
  private readonly ft0 = new Float64Array(MAX_FLASHES);
  private readonly fsize = new Float32Array(MAX_FLASHES);
  private readonly fcol = new Uint8Array(MAX_FLASHES);
  private readonly fstr = new Float32Array(MAX_FLASHES);
  private fNext = 0;

  constructor(core: RhythmCore, settings: SettingsStore) {
    this.core = core;
    this.settings = settings;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'rh-canvas';
    this.ctx = this.canvas.getContext('2d')!;
    this.stat = document.createElement('canvas');
    this.sctx = this.stat.getContext('2d')!;
    this.hasSpacing = 'letterSpacing' in this.ctx;
    this.rt0.fill(-1e9);
    this.ft0.fill(-1e9);
  }

  get layout(): Layout | null {
    return this.L;
  }

  /** 1 while a deck is live, dims towards 0.3 in dead air */
  get aliveLevel(): number {
    return this.alive;
  }

  /** The slot changed size (or the difficulty changed the scroll speed). Cheap: no reallocation. */
  resize(slotW: number, slotH: number, padH: number, difficulty: Difficulty): void {
    if (slotW < 2 || slotH < 2) return;
    this.slotW = slotW;
    this.slotH = slotH;
    this.padH = padH;
    const L = computeLayout(slotW, slotH, padH, difficulty);
    this.L = L;
    this.core.setLookahead(L.lookahead);

    const dpr = canvasDpr();
    const viewH = typeof window === 'undefined' ? 0 : window.innerHeight * 0.75;
    if (dpr !== this.dpr || Math.round(slotW) !== this.allocW || slotH > this.allocH) {
      this.dpr = dpr;
      this.allocW = Math.round(slotW);
      this.allocH = Math.ceil(Math.max(slotH, viewH, this.allocH) / 64) * 64;
      const bw = Math.round(this.allocW * dpr);
      const bh = Math.round(this.allocH * dpr);
      this.canvas.width = this.stat.width = bw;
      this.canvas.height = this.stat.height = bh;
      this.canvas.style.width = `${this.allocW}px`;
      this.canvas.style.height = `${this.allocH}px`;
      this.hitGlow = null;
    }

    this.noteSprites = this.sprites.get(L.noteW, L.noteH, this.dpr);
    const ctx = this.ctx;
    const right = L.left + LANE_COUNT * L.laneW;
    const g = ctx.createLinearGradient(L.left, 0, right, 0);
    g.addColorStop(0, COLORS.cyan);
    g.addColorStop(0.52, COLORS.violet);
    g.addColorStop(1, COLORS.pink);
    this.hitGrad = g;
    this.beamLen = Math.min(L.hitY * 0.62, 190);
    this.beamGrads = [];
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const b = ctx.createLinearGradient(0, L.hitY, 0, L.hitY - this.beamLen);
      b.addColorStop(0, rgba(LANE_COLORS[lane], 0.62));
      b.addColorStop(0.35, rgba(LANE_COLORS[lane], 0.22));
      b.addColorStop(1, rgba(LANE_COLORS[lane], 0));
      this.beamGrads.push(b);
    }
    const m = ctx.createLinearGradient(0, L.hitY, 0, L.hitY - this.beamLen * 0.6);
    m.addColorStop(0, rgba(COLORS.red, 0.4));
    m.addColorStop(1, rgba(COLORS.red, 0));
    this.missGrad = m;

    const glowW = Math.round(right - L.left + 60);
    if (!this.hitGlow || this.hitGlowW !== glowW) this.renderHitGlow(glowW);

    this.wordFont = font(900, Math.round(L.wordSize), FONT_DISPLAY);
    this.comboFont = font(900, Math.round(L.comboSize), FONT_DISPLAY);
    this.labelFont = font(800, Math.round(clamp(L.comboSize * 0.2, 9, 12)));
    this.subFont = font(800, Math.round(clamp(L.wordSize * 0.42, 9, 11)));
    this.staticDirty = true;
  }

  /** A horizontal aurora glow strip for the hit line, drawn additively every frame. */
  private renderHitGlow(w: number): void {
    const h = 44;
    const c = document.createElement('canvas');
    c.width = Math.round(w * this.dpr);
    c.height = Math.round(h * this.dpr);
    const g = c.getContext('2d')!;
    g.scale(this.dpr, this.dpr);
    const hor = g.createLinearGradient(0, 0, w, 0);
    hor.addColorStop(0, rgba(COLORS.cyan, 0));
    hor.addColorStop(0.08, COLORS.cyan);
    hor.addColorStop(0.52, COLORS.violet);
    hor.addColorStop(0.92, COLORS.pink);
    hor.addColorStop(1, rgba(COLORS.pink, 0));
    g.fillStyle = hor;
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'destination-in';
    const ver = g.createLinearGradient(0, 0, 0, h);
    ver.addColorStop(0, 'rgba(0,0,0,0)');
    ver.addColorStop(0.42, 'rgba(0,0,0,0.55)');
    ver.addColorStop(0.5, 'rgba(0,0,0,1)');
    ver.addColorStop(0.58, 'rgba(0,0,0,0.55)');
    ver.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = ver;
    g.fillRect(0, 0, w, h);
    this.hitGlow = c;
    this.hitGlowW = w;
  }

  // ───────────── static road ─────────────

  private renderStatic(): void {
    const L = this.L!;
    const ctx = this.sctx;
    const dpr = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.stat.width, this.stat.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = this.slotW;
    const H = L.h + 4; // a little under the pad row, which covers it
    const cx = L.cx;
    const right = L.left + LANE_COUNT * L.laneW;
    const sTop = scaleAt(L, L.lookahead);
    const sBot = (H - L.yV) / L.span;
    const xs = (x: number, s: number): number => cx + (x - cx) * s;

    // room: near-black with a violet haze at the far end
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, COLORS.bg0);
    bg.addColorStop(0.6, COLORS.bg1);
    bg.addColorStop(1, '#0c0c18');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    const haze = ctx.createRadialGradient(cx, -H * 0.15, 0, cx, -H * 0.15, Math.max(W, H) * 0.9);
    haze.addColorStop(0, rgba(COLORS.violet, 0.2));
    haze.addColorStop(0.5, rgba(COLORS.violet, 0.05));
    haze.addColorStop(1, rgba(COLORS.violet, 0));
    ctx.fillStyle = haze;
    ctx.fillRect(0, 0, W, H);

    // side floor: faint perspective grid outside the road so the depth reads at both edges
    ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i++) {
      const off = i * L.laneW * 0.9;
      for (const side of [-1, 1]) {
        const xLine = side < 0 ? L.left - off : right + off;
        const gl = ctx.createLinearGradient(0, 0, 0, H);
        gl.addColorStop(0, 'rgba(255,255,255,0)');
        gl.addColorStop(1, `rgba(255,255,255,${0.035 / i})`);
        ctx.strokeStyle = gl;
        ctx.beginPath();
        ctx.moveTo(xs(xLine, sTop), 0);
        ctx.lineTo(xs(xLine, sBot), H);
        ctx.stroke();
      }
    }

    // the road
    const road = ctx.createLinearGradient(0, 0, 0, H);
    road.addColorStop(0, 'rgba(20,20,38,0.35)');
    road.addColorStop(clamp01(L.hitY / H) * 0.9, 'rgba(22,22,42,0.92)');
    road.addColorStop(1, 'rgba(14,14,28,1)');
    ctx.fillStyle = road;
    ctx.beginPath();
    ctx.moveTo(xs(L.left, sTop), 0);
    ctx.lineTo(xs(right, sTop), 0);
    ctx.lineTo(xs(right, sBot), H);
    ctx.lineTo(xs(L.left, sBot), H);
    ctx.closePath();
    ctx.fill();

    // lane tints, brightest towards the hit line
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const x0 = L.left + lane * L.laneW;
      const x1 = x0 + L.laneW;
      const tint = ctx.createLinearGradient(0, 0, 0, H);
      tint.addColorStop(0, rgba(LANE_COLORS[lane], 0));
      tint.addColorStop(clamp01(L.hitY / H), rgba(LANE_COLORS[lane], 0.1));
      tint.addColorStop(1, rgba(LANE_COLORS[lane], 0.04));
      ctx.fillStyle = tint;
      ctx.beginPath();
      ctx.moveTo(xs(x0, sTop), 0);
      ctx.lineTo(xs(x1, sTop), 0);
      ctx.lineTo(xs(x1, sBot), H);
      ctx.lineTo(xs(x0, sBot), H);
      ctx.closePath();
      ctx.fill();
    }

    // lane dividers
    const div = ctx.createLinearGradient(0, 0, 0, H);
    div.addColorStop(0, 'rgba(255,255,255,0)');
    div.addColorStop(clamp01(L.hitY / H), 'rgba(255,255,255,0.11)');
    div.addColorStop(1, 'rgba(255,255,255,0.05)');
    ctx.strokeStyle = div;
    ctx.lineWidth = 1;
    for (let lane = 1; lane < LANE_COUNT; lane++) {
      const x = L.left + lane * L.laneW;
      ctx.beginPath();
      ctx.moveTo(xs(x, sTop), 0);
      ctx.lineTo(xs(x, sBot), H);
      ctx.stroke();
    }

    // rails: the road's edges light up in the deck colours of the aurora (baked glow)
    for (const [x, color] of [
      [L.left, COLORS.cyan],
      [right, COLORS.pink],
    ] as const) {
      const rg = ctx.createLinearGradient(0, 0, 0, H);
      rg.addColorStop(0, rgba(color, 0));
      rg.addColorStop(clamp01(L.hitY / H), rgba(color, 0.85));
      rg.addColorStop(1, rgba(color, 0.3));
      ctx.save();
      ctx.strokeStyle = rg;
      ctx.lineWidth = 2;
      ctx.shadowColor = rgba(color, 0.8);
      ctx.shadowBlur = 10 * dpr;
      ctx.beginPath();
      ctx.moveTo(xs(x, sTop), 0);
      ctx.lineTo(xs(x, sBot), H);
      ctx.stroke();
      ctx.restore();
    }

    // below the hit line the road sinks into the pad plate
    const sink = ctx.createLinearGradient(0, L.hitY + L.noteH * 0.5, 0, H);
    sink.addColorStop(0, 'rgba(5,5,11,0)');
    sink.addColorStop(1, 'rgba(5,5,11,0.7)');
    ctx.fillStyle = sink;
    ctx.fillRect(0, L.hitY + L.noteH * 0.5, W, H - L.hitY);

    // receptor slots at the hit line, in each lane's note shape
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const x = laneCenter(L, lane) - L.noteW / 2;
      const y = L.hitY - L.noteH / 2;
      ctx.save();
      noteShapePath(ctx, lane, x, y, L.noteW, L.noteH);
      ctx.fillStyle = 'rgba(5,5,11,0.65)';
      ctx.fill();
      ctx.shadowColor = rgba(LANE_COLORS[lane], 0.7);
      ctx.shadowBlur = 8 * dpr;
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = rgba(LANE_COLORS[lane], 0.7);
      ctx.stroke();
      ctx.restore();
    }
    this.staticDirty = false;
  }

  // ───────────── events from the game ─────────────

  /** A pad went down (before it is judged). */
  padDown(lane: Lane): void {
    this.held[lane] = 1;
    this.press[lane] = 1;
    this.beam[lane] = Math.max(this.beam[lane], 0.45);
  }

  padUp(lane: Lane): void {
    this.held[lane] = 0;
  }

  judge(fx: JudgeFx, now: number): void {
    const L = this.L;
    const lowFx = this.settings.get().lowFx;
    this.wordJ = fx.judgment;
    this.wordT0 = now;
    const perfectMs = WINDOW_MS.perfect * WINDOW_SCALE[this.core.difficulty];
    this.wordSub =
      fx.judgment === 'great' || fx.judgment === 'good'
        ? Math.abs(fx.errorMs) > perfectMs
          ? fx.errorMs < 0
            ? 'EARLY'
            : 'LATE'
          : ''
        : '';

    if (fx.judgment === 'miss') {
      this.missBeam[fx.lane] = 1;
      if (fx.broken >= COMBO_MIN) {
        this.breakStr = this.comboStr;
        this.breakT0 = now;
        this.breakMult = this.multiplier;
      }
      this.combo = 0;
      this.multiplier = 1;
      return;
    }

    if (fx.combo !== this.combo) {
      this.combo = fx.combo;
      this.comboStr = String(fx.combo);
      this.comboT0 = now;
    }
    this.multiplier = fx.multiplier;
    if (fx.milestone) this.milestoneT0 = now;
    this.beam[fx.lane] = 1;
    if (!L) return;

    const x = laneCenter(L, fx.lane);
    const y = L.hitY;
    const col = J_COLOR[fx.judgment];
    const big = fx.judgment === 'perfect' ? 1 : fx.judgment === 'great' ? 0.78 : 0.55;
    this.flash(x, y, L.laneW * (0.8 + 0.6 * big), col, 0.8, now);
    this.flash(x, y, L.laneW * 0.32, C_WHITE, 0.55 + 0.3 * big, now);
    this.ring(x, y, L.laneW * (0.38 + 0.2 * big), col, 340, now);
    if (fx.judgment === 'perfect') this.ring(x, y, L.laneW * 0.62, fx.lane, 480, now);
    if (!lowFx) {
      const n = fx.judgment === 'perfect' ? 18 : fx.judgment === 'great' ? 11 : 6;
      for (let i = 0; i < n; i++) {
        const c = fx.judgment === 'perfect' && i % 3 === 0 ? C_HOT : i % 2 === 0 ? fx.lane : col;
        this.spark(x, y, L.laneW, c, big);
      }
    }
  }

  reset(): void {
    this.combo = 0;
    this.comboStr = '';
    this.multiplier = 1;
    this.wordT0 = this.comboT0 = this.breakT0 = this.milestoneT0 = -1e9;
    this.plife.fill(0);
    this.rt0.fill(-1e9);
    this.ft0.fill(-1e9);
  }

  private flash(x: number, y: number, size: number, col: number, strength: number, now: number): void {
    const i = this.fNext;
    this.fstr[i] = strength;
    this.fNext = (i + 1) % MAX_FLASHES;
    this.fx[i] = x;
    this.fy[i] = y;
    this.fsize[i] = size;
    this.fcol[i] = col;
    this.ft0[i] = now;
  }

  private ring(x: number, y: number, size: number, col: number, durMs: number, now: number): void {
    const i = this.rNext;
    this.rNext = (i + 1) % MAX_RINGS;
    this.rx[i] = x;
    this.ry[i] = y;
    this.rsize[i] = size;
    this.rdur[i] = durMs;
    this.rcol[i] = col;
    this.rt0[i] = now;
  }

  private spark(x: number, y: number, laneW: number, col: number, big: number): void {
    const i = this.pNext;
    this.pNext = (i + 1) % MAX_PARTICLES;
    const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.4;
    const v = laneW * (2.2 + Math.random() * 3.2) * (0.6 + 0.5 * big);
    this.px[i] = x + (Math.random() - 0.5) * laneW * 0.6;
    this.py[i] = y;
    this.pvx[i] = Math.cos(a) * v;
    this.pvy[i] = Math.sin(a) * v;
    const life = 0.32 + Math.random() * 0.32;
    this.plife[i] = life;
    this.pmax[i] = life;
    this.psize[i] = 3 + Math.random() * 4 * (0.6 + big * 0.6);
    this.pcol[i] = col;
  }

  // ───────────── per frame ─────────────

  draw(frame: FrameState): void {
    const L = this.L;
    if (!L) return;
    if (this.staticDirty) this.renderStatic();
    const ctx = this.ctx;
    const now = frame.now;
    const dt = frame.dt;
    this.now = now;
    const lowFx = this.settings.get().lowFx;
    const live = frame.liveDeck;
    const pulse = lowFx ? frame.pulse * 0.6 : frame.pulse;
    this.alive = damp(this.alive, live ? 1 : 0.32, 0.12, dt);
    const alive = this.alive;
    const cx = L.cx;
    const right = L.left + LANE_COUNT * L.laneW;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, this.canvas.width, Math.min(this.canvas.height, Math.ceil(this.slotH * this.dpr) + 2));
    ctx.drawImage(this.stat, 0, 0);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // ── the room breathes: a glow over the far end in the live deck's colour ──
    const liveColor = live ? deckColor(live) : COLORS.violet;
    if (!lowFx) drawGlow(ctx, cx, -L.h * 0.08, Math.max(L.w * 0.62, L.h * 0.7), liveColor, (0.08 + 0.2 * pulse) * alive);

    // ── beat lines scroll with the record (bar lines in the aurora) ──
    const deck: DeckId | null = this.core.shown;
    const snap = deck ? frame.decks[deck] : null;
    const notes: DeckNotes | null = deck ? this.core.decks[deck] : null;
    const beat = snap && snap.track ? snap.beat : frame.beat;
    {
      const first = Math.ceil(beat - 0.5);
      const last = Math.floor(beat + L.lookahead);
      for (let b = first; b <= last; b++) {
        const d = b - beat;
        const s = scaleAt(L, d);
        const y = yAtScale(L, s);
        if (y > L.h + 2) continue;
        const fade = smoothstep(L.lookahead, L.lookahead * 0.72, d) * (d < 0 ? clamp01(1 + d * 2) : 1);
        const xl = cx + (L.left - cx) * s;
        const xr = cx + (right - cx) * s;
        const bar = ((b % 4) + 4) % 4 === 0;
        if (bar) {
          ctx.globalAlpha = (0.42 + 0.25 * pulse) * fade * alive;
          ctx.fillStyle = this.hitGrad!;
          ctx.fillRect(xl, y - s, xr - xl, 2 * s);
        } else {
          ctx.globalAlpha = 0.09 * fade * alive;
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(xl, y - 0.5 * s, xr - xl, s);
        }
      }
    }

    // ── rails pulse on the beat ──
    if (pulse > 0.02) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.5 * pulse * alive;
      ctx.lineWidth = 3;
      const sTop = scaleAt(L, L.lookahead * 0.55);
      const yTop = yAtScale(L, sTop);
      ctx.strokeStyle = COLORS.cyan;
      ctx.beginPath();
      ctx.moveTo(cx + (L.left - cx) * sTop, yTop);
      ctx.lineTo(L.left, L.hitY);
      ctx.stroke();
      ctx.strokeStyle = COLORS.pink;
      ctx.beginPath();
      ctx.moveTo(cx + (right - cx) * sTop, yTop);
      ctx.lineTo(right, L.hitY);
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    }

    // ── lane beams: a pressed pad throws light up its lane ──
    const sBeam = (L.hitY - this.beamLen - L.yV) / L.span;
    const yBeam = L.hitY - this.beamLen;
    ctx.globalCompositeOperation = 'lighter';
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const held = this.held[lane] ? 0.32 : 0;
      this.beam[lane] = damp(this.beam[lane], held, 0.09, dt);
      this.missBeam[lane] = damp(this.missBeam[lane], 0, 0.12, dt);
      this.press[lane] = damp(this.press[lane], held, 0.06, dt);
      const x0 = L.left + lane * L.laneW + 1;
      const x1 = x0 + L.laneW - 2;
      for (let pass = 0; pass < 2; pass++) {
        const a = pass === 0 ? this.beam[lane] : this.missBeam[lane];
        if (a < 0.01) continue;
        ctx.globalAlpha = a * alive;
        ctx.fillStyle = pass === 0 ? this.beamGrads[lane] : this.missGrad!;
        ctx.beginPath();
        ctx.moveTo(cx + (x0 - cx) * sBeam, yBeam);
        ctx.lineTo(cx + (x1 - cx) * sBeam, yBeam);
        ctx.lineTo(x1, L.hitY + L.noteH * 0.5);
        ctx.lineTo(x0, L.hitY + L.noteH * 0.5);
        ctx.closePath();
        ctx.fill();
      }
    }

    // ── the hit line breathes with the beat ──
    ctx.globalAlpha = (0.3 + 0.6 * pulse) * alive;
    if (this.hitGlow) {
      const gw = this.hitGlowW;
      ctx.drawImage(this.hitGlow, cx - gw / 2, L.hitY - 22 - 4 * pulse, gw, 44 + 8 * pulse);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = (0.65 + 0.35 * pulse) * (0.4 + 0.6 * alive);
    ctx.fillStyle = this.hitGrad!;
    ctx.fillRect(L.left, L.hitY - 1, right - L.left, 2);

    // receptors light up while their pad is down
    ctx.globalCompositeOperation = 'lighter';
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const p = this.press[lane];
      if (p < 0.02) continue;
      ctx.globalAlpha = p * 0.75;
      ctx.fillStyle = LANE_COLORS[lane];
      noteShapePath(ctx, lane, laneCenter(L, lane) - L.noteW / 2, L.hitY - L.noteH / 2, L.noteW, L.noteH);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';

    // ── combo, big and behind the notes ──
    this.drawCombo(ctx, L, now, pulse, alive, lowFx);

    // ── notes ──
    this.cue.fill(0);
    if (notes && snap) this.drawNotes(ctx, L, notes, snap.beat, alive, 1, true);
    const fadeDeck = this.core.fadeDeck;
    if (fadeDeck && fadeDeck !== deck) {
      const t = (now - this.core.fadeAt) / FADE_MS;
      const other = this.core.decks[fadeDeck];
      if (t < 1 && other) this.drawNotes(ctx, L, other, frame.decks[fadeDeck].beat, alive, 1 - easeOutCubic(t), false);
    }

    // ── effects ──
    this.drawEffects(ctx, L, now, dt);
    this.drawWord(ctx, L, now, lowFx);

    // dead air: the whole road dims and waits
    if (alive < 0.98) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = `rgba(5,5,11,${((1 - alive) * 0.5).toFixed(3)})`;
      ctx.fillRect(0, 0, this.slotW, L.h);
    }
    ctx.globalAlpha = 1;
  }

  private drawNotes(
    ctx: CanvasRenderingContext2D,
    L: Layout,
    notes: DeckNotes,
    beat: number,
    alive: number,
    fade: number,
    shownDeck: boolean,
  ): void {
    const sprites = this.noteSprites;
    if (sprites.length < 8) return;
    const now = this.now;
    const cx = L.cx;
    const from = lowerBound(notes.beat, notes.count, beat - MISS_TAIL_BEATS - 0.5);
    const to = lowerBound(notes.beat, notes.count, beat + L.lookahead + 0.01);
    const yMax = L.h + L.noteH;
    // far to near, so nearer notes sit on top
    for (let i = to - 1; i >= from; i--) {
      const st = notes.state[i];
      if (shownDeck ? st !== SHOWN && st !== MISSED : st !== FADING) continue;
      const d = notes.beat[i] - beat;
      if (d > L.lookahead) continue;
      const lane = notes.lane[i];
      let a = smoothstep(L.lookahead, L.lookahead - 0.45, d) * fade * (0.35 + 0.65 * alive);
      let sprite = sprites[lane];
      if (st === MISSED) {
        if (d < -MISS_TAIL_BEATS) continue;
        a *= 0.85 * clamp01(1 + d / MISS_TAIL_BEATS);
        sprite = sprites[4 + lane];
      } else if (st === SHOWN) {
        const ap = notes.appear[i];
        if (ap > 0) a *= clamp01((now - ap) / APPEAR_MS);
        if (d < 0) a *= clamp01(1 + d * 2.2);
        if (shownDeck && d > -0.25 && d < 1.6) {
          const c = 1 - Math.max(0, d) / 1.6;
          if (c > this.cue[lane]) this.cue[lane] = c;
        }
      }
      if (a < 0.01) continue;
      const s = scaleAt(L, d);
      const y = yAtScale(L, s);
      if (y > yMax) continue;
      const x = cx + (laneCenter(L, lane) - cx) * s;
      const dw = (sprite.w + sprite.pad * 2) * s;
      const dh = (sprite.h + sprite.pad * 2) * s;
      ctx.globalAlpha = a;
      ctx.drawImage(sprite.canvas, x - dw / 2, y - dh / 2, dw, dh);
    }
    ctx.globalAlpha = 1;
  }

  private drawEffects(ctx: CanvasRenderingContext2D, L: Layout, now: number, dt: number): void {
    ctx.globalCompositeOperation = 'lighter';
    // glow flashes
    for (let i = 0; i < MAX_FLASHES; i++) {
      const t = (now - this.ft0[i]) / 260;
      if (t < 0 || t >= 1) continue;
      const k = 1 - t;
      drawGlow(ctx, this.fx[i], this.fy[i], this.fsize[i] * (0.7 + 0.5 * easeOutCubic(t)), PALETTE[this.fcol[i]], k * k * this.fstr[i]);
    }
    // rings: flattened ellipses lying on the road
    ctx.lineCap = 'round';
    for (let i = 0; i < MAX_RINGS; i++) {
      const t = (now - this.rt0[i]) / this.rdur[i];
      if (t < 0 || t >= 1) continue;
      const e = easeOutCubic(t);
      const r = this.rsize[i] * (0.35 + 0.85 * e);
      ctx.globalAlpha = (1 - t) * 0.9;
      ctx.strokeStyle = PALETTE[this.rcol[i]];
      ctx.lineWidth = Math.max(0.5, 4 * (1 - t));
      ctx.beginPath();
      ctx.ellipse(this.rx[i], this.ry[i], r, r * 0.42, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    // sparks
    if (this.pAlive > 0 || dt > 0) {
      let alive = 0;
      const grav = L.laneW * 9;
      for (let i = 0; i < MAX_PARTICLES; i++) {
        let life = this.plife[i];
        if (life <= 0) continue;
        life -= dt;
        this.plife[i] = life;
        if (life <= 0) continue;
        alive++;
        this.pvy[i] += grav * dt;
        this.pvx[i] *= 1 - 2.5 * dt;
        this.px[i] += this.pvx[i] * dt;
        this.py[i] += this.pvy[i] * dt;
        const k = life / this.pmax[i];
        const r = this.psize[i] * (0.4 + 0.6 * k);
        ctx.globalAlpha = k;
        ctx.drawImage(glowSprite(PALETTE[this.pcol[i]]), this.px[i] - r, this.py[i] - r, r * 2, r * 2);
      }
      this.pAlive = alive;
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  private drawCombo(
    ctx: CanvasRenderingContext2D,
    L: Layout,
    now: number,
    pulse: number,
    alive: number,
    lowFx: boolean,
  ): void {
    const c = ctx as CtxWithSpacing;
    const y = L.comboY;
    const size = L.comboSize;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // a broken combo drops away in red
    const tb = (now - this.breakT0) / 480;
    if (tb >= 0 && tb < 1 && this.breakStr) {
      ctx.save();
      ctx.globalAlpha = (1 - tb) * 0.8 * alive;
      ctx.translate(L.cx, y + tb * size * 0.6);
      const sc = 1 - 0.25 * tb;
      ctx.scale(sc, sc);
      ctx.font = this.comboFont;
      ctx.fillStyle = COLORS.red;
      ctx.fillText(this.breakStr, 0, 0);
      ctx.restore();
    }

    if (this.combo < COMBO_MIN) return;
    const m = clamp(this.multiplier, 1, 4);
    const color = COMBO_COLORS[m - 1];
    const tp = (now - this.comboT0) / 200;
    const tm = (now - this.milestoneT0) / 700;
    let pop = tp < 1 ? 1 + 0.14 * (1 - easeOutCubic(tp)) : 1;
    if (tm >= 0 && tm < 0.5) pop += 0.32 * (1 - easeOutCubic(tm * 2));

    if (!lowFx) {
      drawGlow(ctx, L.cx, y, size * (1.5 + 0.2 * pulse), color, (0.12 + 0.16 * pulse + (m === 4 ? 0.18 : 0)) * alive);
    }
    // milestone: a shock ring rolls out from the combo
    if (tm >= 0 && tm < 1) {
      const r = size * 0.8 + L.w * 0.55 * easeOutCubic(tm);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = (1 - tm) * 0.85;
      ctx.strokeStyle = color;
      ctx.lineWidth = 3 * (1 - tm) + 0.5;
      ctx.beginPath();
      ctx.ellipse(L.cx, y, r, r * 0.45, 0, 0, Math.PI * 2);
      ctx.stroke();
      if (!lowFx) drawGlow(ctx, L.cx, y, size * 3, color, (1 - tm) * 0.6);
      ctx.globalCompositeOperation = 'source-over';
    }

    ctx.save();
    ctx.translate(L.cx, y);
    ctx.scale(pop, pop);
    ctx.font = this.comboFont;
    ctx.globalAlpha = 0.5 * alive;
    ctx.fillStyle = '#000000';
    ctx.fillText(this.comboStr, 0, size * 0.05);
    ctx.globalAlpha = (m === 1 ? 0.62 : 0.88) * alive;
    ctx.fillStyle = color;
    ctx.fillText(this.comboStr, 0, 0);
    ctx.restore();

    if (L.compact) {
      ctx.globalAlpha = 1;
      return;
    }
    ctx.font = this.labelFont;
    if (this.hasSpacing) c.letterSpacing = '2px';
    ctx.globalAlpha = (m === 1 ? 0.45 : 0.75) * alive;
    ctx.fillStyle = m === 1 ? COLORS.ink2 : color;
    ctx.fillText(COMBO_LABELS[m - 1], L.cx, y + size * 0.62 + 4);
    if (this.hasSpacing) c.letterSpacing = '0px';
    ctx.globalAlpha = 1;
  }

  private drawWord(ctx: CanvasRenderingContext2D, L: Layout, now: number, lowFx: boolean): void {
    const j = this.wordJ;
    const miss = j === 'miss';
    const life = miss ? 520 : 680;
    const t = now - this.wordT0;
    if (t < 0 || t >= life) return;
    const inT = miss ? 120 : 170;
    let sc = t < inT ? 0.55 + 0.45 * easeOutBack(t / inT) : 1;
    if (miss) sc *= 0.82;
    const a = t < life - 220 ? 1 : (life - t) / 220;
    const y = L.wordY - (t / life) * 8 + (miss ? (t / life) * 10 : 0);
    const color = JUDGMENT_COLORS[j];
    if (j === 'perfect' && !lowFx) drawGlow(ctx, L.cx, y, L.wordSize * 3.4, COLORS.gold, 0.45 * a);
    ctx.save();
    ctx.translate(L.cx, y);
    ctx.scale(sc, sc);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = this.wordFont;
    ctx.globalAlpha = a * 0.7;
    ctx.fillStyle = '#000000';
    ctx.fillText(JUDGMENT_LABELS[j], 0, 2);
    ctx.globalAlpha = a;
    ctx.fillStyle = j === 'perfect' && t < 90 ? COLORS.goldHot : color;
    ctx.fillText(JUDGMENT_LABELS[j], 0, 0);
    if (this.wordSub && !L.compact) {
      const c = ctx as CtxWithSpacing;
      ctx.font = this.subFont;
      if (this.hasSpacing) c.letterSpacing = '2px';
      ctx.globalAlpha = a * 0.75;
      ctx.fillStyle = COLORS.ink2;
      ctx.fillText(this.wordSub, 0, L.wordSize * 0.78 + 3);
      if (this.hasSpacing) c.letterSpacing = '0px';
    }
    ctx.restore();
  }
}
