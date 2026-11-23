/**
 * The stage: the club seen from the DJ booth, drawn on one canvas behind the HUD.
 * It is the hype made visible: a crowd in silhouette along the bottom, beams and haze above it,
 * lasers and confetti at the top end, and the gold hype meter drawn into the slot the HUD leaves.
 *
 * Per-frame rules: no shadowBlur (cached sprites, drawn additively), no allocation in the loops
 * (typed arrays for the crowd and the particles), a handful of batched paths for ~100 people.
 */
import { clamp01, damp, rng, smoothstep } from '../../core/math';
import type { FrameState } from '../../core/types';
import { COLORS, canvasDpr, fitCanvas, glowSprite, hexToRgb, roundRectPath } from '../../theme/theme';
import { StageMood, newLook, stageLook } from './stage-model';

export interface StageRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Stage {
  readonly mood: StageMood;
  /** css size of the canvas box; `barTop` is where the HUD row starts (the top safe-area inset) */
  resize(w: number, h: number, barTop: number): void;
  /** where the hype meter is drawn, in canvas css px; null = no meter */
  setMeter(rect: StageRect | null): void;
  /** the live deck entered a section of this energy (0..1): breaks calm the room, drops fill it */
  setEnergy(energy: number): void;
  /** gold glints over the crowd (combo milestones, cheers) */
  sparkle(count: number): void;
  confettiBurst(count: number): void;
  draw(frame: FrameState, lowFx: boolean): void;
}

const TAU = Math.PI * 2;
const N_PAL = 9;
const SICK = '#a6bd3c';
const WHITE = '#ffffff';

function mixHex(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const c = (x: number, y: number): number => Math.round(x + (y - x) * t);
  return `#${((1 << 24) | (c(r1, r2) << 16) | (c(g1, g2) << 8) | c(b1, b2)).toString(16).slice(1)}`;
}

/** the aurora as hex, t = 0 cyan → 0.5 violet → 1 pink */
const auroraHex = (t: number): string =>
  t < 0.5 ? mixHex(COLORS.cyan, COLORS.violet, t * 2) : mixHex(COLORS.violet, COLORS.pink, (t - 0.5) * 2);

/** A soft cone of light, apex at the top centre. Drawn additively, rotated about its apex. */
function beamSprite(hex: string): HTMLCanvasElement {
  const W = 64;
  const H = 160;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const img = g.createImageData(W, H);
  const d = img.data;
  const [r, gr, b] = hexToRgb(hex);
  for (let y = 0; y < H; y++) {
    const v = y / (H - 1);
    const half = 2.2 + (W / 2 - 2.2) * v;
    const along = Math.pow(1 - v, 1.25);
    for (let x = 0; x < W; x++) {
      const u = Math.abs(x + 0.5 - W / 2) / half;
      if (u >= 1) continue;
      const across = (1 - u * u) * (1 - u * u);
      const core = Math.pow(1 - u, 3) * 0.6 * (1 - v);
      const i = (y * W + x) * 4;
      d[i] = r + (255 - r) * core;
      d[i + 1] = gr + (255 - gr) * core;
      d[i + 2] = b + (255 - b) * core;
      d[i + 3] = 255 * across * along;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

interface Sprites {
  beams: HTMLCanvasElement[];
  glows: HTMLCanvasElement[];
  beamSick: HTMLCanvasElement;
  beamWhite: HTMLCanvasElement;
  glowSick: HTMLCanvasElement;
  glowWhite: HTMLCanvasElement;
  glowGold: HTMLCanvasElement;
  glowHot: HTMLCanvasElement;
  glowAmber: HTMLCanvasElement;
  glowRed: HTMLCanvasElement;
}

let sprites: Sprites | null = null;

function getSprites(): Sprites {
  if (sprites) return sprites;
  const beams: HTMLCanvasElement[] = [];
  const glows: HTMLCanvasElement[] = [];
  for (let i = 0; i < N_PAL; i++) {
    const hex = auroraHex(i / (N_PAL - 1));
    beams.push(beamSprite(hex));
    glows.push(glowSprite(hex));
  }
  sprites = {
    beams,
    glows,
    beamSick: beamSprite(SICK),
    beamWhite: beamSprite(WHITE),
    glowSick: glowSprite(SICK),
    glowWhite: glowSprite(WHITE),
    glowGold: glowSprite(COLORS.gold),
    glowHot: glowSprite(COLORS.goldHot),
    glowAmber: glowSprite(COLORS.amber),
    glowRed: glowSprite(COLORS.red),
  };
  return sprites;
}

/** additive sprite, centred, as an ellipse (rx, ry) */
function blit(
  ctx: CanvasRenderingContext2D,
  sprite: HTMLCanvasElement,
  x: number,
  y: number,
  rx: number,
  ry: number,
  alpha: number,
): void {
  if (alpha <= 0.004) return;
  ctx.globalAlpha = alpha > 1 ? 1 : alpha;
  ctx.drawImage(sprite, x - rx, y - ry, rx * 2, ry * 2);
}

/** the same, in a colour along the aurora (t 0..1), cross-fading the two nearest sprites */
function blitPal(
  ctx: CanvasRenderingContext2D,
  pal: HTMLCanvasElement[],
  t: number,
  x: number,
  y: number,
  rx: number,
  ry: number,
  alpha: number,
): void {
  const f = clamp01(t) * (N_PAL - 1);
  const i0 = Math.min(N_PAL - 2, Math.floor(f));
  const fr = f - i0;
  blit(ctx, pal[i0], x, y, rx, ry, alpha * (1 - fr));
  blit(ctx, pal[i0 + 1], x, y, rx, ry, alpha * fr);
}

/** One depth row of the crowd, as a struct of arrays. */
interface Row {
  n: number;
  /** 0 = back, 2 = front */
  depth: number;
  /** y of the shoulder line */
  baseY: number;
  /** how far absent people sink to be out of sight */
  sink: number;
  armW: number;
  x: Float32Array;
  hj: Float32Array;
  r: Float32Array;
  w: Float32Array;
  /** presence threshold: on the floor when the crowd's presence is above it */
  join: Float32Array;
  /** arms threshold: hands up when the room's arm level is above it */
  armAt: Float32Array;
  /** 0 both arms, 1 left, 2 right, 3 none, 4 holds a phone up */
  style: Uint8Array;
  phase: Float32Array;
  amp: Float32Array;
  sway: Float32Array;
  spread: Float32Array;
  reach: Float32Array;
  // state
  present: Float32Array;
  arm: Float32Array;
  bounce: number;
  // per-frame scratch
  sy: Float32Array;
  hx0: Float32Array;
  hy0: Float32Array;
  hx1: Float32Array;
  hy1: Float32Array;
}

const HEAD = [3.4, 4.6, 6.0];
const SHOULDER = [11.5, 15.5, 20.5];
const SPACING = [9.4, 13.0, 17.4];
const LIFT = [15.5, 9.2, 2.6];
const BOUNCE_PX = [2.4, 3.4, 4.6];
const BOUNCE_LAG = [0.045, 0.03, 0.016];
const RIM = [0.5, 0.72, 1];
const OFF = 1e6;

function makeRow(k: number, w: number, h: number, s: number, rand: () => number): Row {
  const xs: number[] = [];
  const sp = SPACING[k] * s;
  for (let x = -sp * rand() * 0.6; x < w + sp * 0.6; x += sp * (0.8 + 0.45 * rand())) xs.push(x);
  const n = xs.length;
  const f = (): Float32Array => new Float32Array(n);
  const row: Row = {
    n,
    depth: k,
    baseY: h - LIFT[k] * s,
    sink: LIFT[k] * s + HEAD[k] * s * 2.6 + 4,
    armW: HEAD[k] * s * 0.62,
    x: f(),
    hj: f(),
    r: f(),
    w: f(),
    join: f(),
    armAt: f(),
    style: new Uint8Array(n),
    phase: f(),
    amp: f(),
    sway: f(),
    spread: f(),
    reach: f(),
    present: f(),
    arm: f(),
    bounce: 0,
    sy: f(),
    hx0: f(),
    hy0: f(),
    hx1: f(),
    hy1: f(),
  };
  for (let i = 0; i < n; i++) {
    row.x[i] = xs[i];
    row.hj[i] = (rand() * 4 - 1.6) * s * (0.5 + k * 0.25);
    row.r[i] = HEAD[k] * s * (0.88 + 0.24 * rand());
    row.w[i] = SHOULDER[k] * s * (0.9 + 0.25 * rand());
    row.join[i] = rand();
    row.armAt[i] = rand();
    const st = rand();
    row.style[i] = st < 0.44 ? 0 : st < 0.62 ? 1 : st < 0.8 ? 2 : st < 0.9 ? 3 : 4;
    row.phase[i] = rand() * TAU;
    row.amp[i] = 0.65 + 0.7 * rand();
    row.sway[i] = 1.3 + 1.5 * rand();
    row.spread[i] = rand() * 0.28;
    row.reach[i] = rand() * 1.25;
    row.present[i] = -1; // set on the first frame
  }
  return row;
}

const N_CONF = 44;
const N_GLINT = 14;
const N_FLAME = 30;
const CONF_COLORS = [COLORS.cyan, COLORS.violet, COLORS.pink, COLORS.gold, '#ffffff'];
const MAX_BEAMS = 8;
/** which beams come on first as the hype grows, per beam count: spread out, the middle first */
const BEAM_ORDER: Record<number, number[]> = {
  4: [1, 2, 0, 3],
  6: [2, 3, 0, 5, 1, 4],
  7: [3, 1, 5, 0, 6, 2, 4],
  8: [3, 4, 1, 6, 0, 7, 2, 5],
};
/** BEAM_RANK[n][i] = position of beam i in the switch-on order */
const BEAM_RANK: Record<number, number[]> = {};
for (const key of Object.keys(BEAM_ORDER)) {
  const order = BEAM_ORDER[Number(key)];
  const rank = new Array<number>(order.length);
  order.forEach((beam, pos) => (rank[beam] = pos));
  BEAM_RANK[Number(key)] = rank;
}

export function createStage(canvas: HTMLCanvasElement): Stage {
  const spr = getSprites();
  const mood = new StageMood();
  const look = newLook();
  const rand = rng(0x51a7e);
  const dpr = canvasDpr();

  let w = 0;
  let h = 0;
  let barTop = 0;
  /** crowd scale: 1 at the standard 62 px stage */
  let s = 1;
  let rows: Row[] = [];
  let bg: HTMLCanvasElement | null = null;
  let scrim: HTMLCanvasElement | null = null;
  let rimAurora: CanvasGradient | null = null;
  let meter: StageRect | null = null;
  let meterGold: CanvasGradient | null = null;
  let meterRed: CanvasGradient | null = null;

  // smoothed inputs
  let first = true;
  let hype = 0.5;
  let alive = 0;
  let bass = 0;
  let tint = 0.5;
  let energy = 0.7;
  let energyTarget = 0.7;
  // clocks
  let tSway = 0;
  let tBeam = 0;
  let tFree = 0;
  const beamLit = new Float32Array(MAX_BEAMS);

  // particles
  const cX = new Float32Array(N_CONF);
  const cY = new Float32Array(N_CONF);
  const cVx = new Float32Array(N_CONF);
  const cVy = new Float32Array(N_CONF);
  const cPh = new Float32Array(N_CONF);
  const cSize = new Float32Array(N_CONF);
  const cOn = new Uint8Array(N_CONF);
  let confAcc = 0;

  const gX = new Float32Array(N_GLINT);
  const gY = new Float32Array(N_GLINT);
  const gLife = new Float32Array(N_GLINT);
  const gMax = new Float32Array(N_GLINT);
  const gGold = new Uint8Array(N_GLINT);
  let glintAcc = 0;

  const fX = new Float32Array(N_FLAME);
  const fY = new Float32Array(N_FLAME);
  const fVx = new Float32Array(N_FLAME);
  const fVy = new Float32Array(N_FLAME);
  const fLife = new Float32Array(N_FLAME);
  const fMax = new Float32Array(N_FLAME);
  const fSize = new Float32Array(N_FLAME);
  let flameAcc = 0;

  // silhouette colours per row and light level: darker and bluer towards the booth
  const N_LEVEL = 16;
  const rowFill: string[][] = [];
  const rowFillSick: string[][] = [];
  {
    const base = ['#141233', '#0a091f', '#04040c'];
    const lit = ['#4a3aa0', '#2a2168', '#0f0c2e'];
    const litSick = ['#4c5522', '#2a3014', '#0f1208'];
    for (let k = 0; k < 3; k++) {
      rowFill.push([]);
      rowFillSick.push([]);
      for (let q = 0; q < N_LEVEL; q++) {
        rowFill[k].push(mixHex(base[k], lit[k], q / (N_LEVEL - 1)));
        rowFillSick[k].push(mixHex(base[k], litSick[k], q / (N_LEVEL - 1)));
      }
    }
  }

  function nBeams(lowFx: boolean): number {
    if (lowFx) return 4;
    return w >= 470 ? 8 : w >= 380 ? 7 : 6;
  }

  function renderStatic(): void {
    // background: the dark room, the rig across the top
    bg = bg ?? document.createElement('canvas');
    const g = fitCanvas(bg, w, h, dpr);
    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#05041a');
    sky.addColorStop(0.55, '#0a0926');
    sky.addColorStop(1, '#141038');
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);
    // truss
    g.fillStyle = '#02020a';
    g.fillRect(0, 0, w, 3.5);
    g.strokeStyle = 'rgba(255,255,255,0.07)';
    g.lineWidth = 1;
    g.beginPath();
    for (let x = -4; x < w + 8; x += 9) {
      g.moveTo(x, 0);
      g.lineTo(x + 4.5, 3.5);
      g.lineTo(x + 9, 0);
    }
    g.moveTo(0, 3.5);
    g.lineTo(w, 3.5);
    g.stroke();
    // lamp heads where the beams start
    const nb = nBeams(false);
    g.fillStyle = '#02020a';
    for (let i = 0; i < nb; i++) {
      const x = (w * (i + 0.5)) / nb;
      roundRectPath(g, x - 4.5, 1, 9, 6.5, 2);
      g.fill();
    }

    // scrim: keeps the HUD text readable over the lights
    scrim = scrim ?? document.createElement('canvas');
    const sg = fitCanvas(scrim, w, h, 1);
    sg.clearRect(0, 0, w, h);
    const top = sg.createLinearGradient(0, 0, 0, barTop + 34);
    top.addColorStop(0, 'rgba(4,4,14,0.62)');
    top.addColorStop((barTop + 6) / (barTop + 34), 'rgba(4,4,14,0.5)');
    top.addColorStop(1, 'rgba(4,4,14,0)');
    sg.fillStyle = top;
    sg.fillRect(0, 0, w, barTop + 34);
    // a pool of shade behind the score
    sg.save();
    sg.translate(64, barTop + 24);
    sg.scale(1, 0.34);
    const pool = sg.createRadialGradient(0, 0, 0, 0, 0, 118);
    pool.addColorStop(0, 'rgba(4,4,14,0.6)');
    pool.addColorStop(0.6, 'rgba(4,4,14,0.32)');
    pool.addColorStop(1, 'rgba(4,4,14,0)');
    sg.fillStyle = pool;
    sg.fillRect(-140, -140, 280, 280);
    sg.restore();

    const ctx = canvas.getContext('2d')!;
    rimAurora = ctx.createLinearGradient(0, 0, w, 0);
    rimAurora.addColorStop(0, COLORS.cyan);
    rimAurora.addColorStop(0.5, '#b9a6ff');
    rimAurora.addColorStop(1, COLORS.pink);
    buildMeterPaint();
  }

  function buildMeterPaint(): void {
    if (!meter) return;
    const ctx = canvas.getContext('2d')!;
    meterGold = ctx.createLinearGradient(meter.x, 0, meter.x + meter.w, 0);
    meterGold.addColorStop(0, '#f08a2a');
    meterGold.addColorStop(0.45, COLORS.gold);
    meterGold.addColorStop(1, COLORS.goldHot);
    meterRed = ctx.createLinearGradient(meter.x, 0, meter.x + meter.w, 0);
    meterRed.addColorStop(0, '#c2182e');
    meterRed.addColorStop(1, COLORS.red);
  }

  function spawnConfetti(x: number, y: number, vx: number, vy: number): void {
    for (let i = 0; i < N_CONF; i++) {
      if (cOn[i]) continue;
      cOn[i] = 1;
      cX[i] = x;
      cY[i] = y;
      cVx[i] = vx;
      cVy[i] = vy;
      cPh[i] = rand() * TAU;
      cSize[i] = 2.6 + rand() * 2.2;
      return;
    }
  }

  function spawnGlint(x: number, y: number, gold: boolean): void {
    for (let i = 0; i < N_GLINT; i++) {
      if (gLife[i] > 0) continue;
      gX[i] = x;
      gY[i] = y;
      gMax[i] = gLife[i] = 0.16 + rand() * 0.2;
      gGold[i] = gold ? 1 : 0;
      return;
    }
  }

  function crowdBandY(): number {
    return h - (5 + rand() * 20) * s;
  }

  function drawCrowd(ctx: CanvasRenderingContext2D, dt: number, light: number, bounceAmt: number, armLevel: number, rimA: number): void {
    const sick = mood.sick;
    const q = Math.min(N_LEVEL - 1, Math.round(clamp01(light) * (N_LEVEL - 1)));
    const kPresent = 1 - Math.pow(0.5, dt / 0.32);
    const kArm = 1 - Math.pow(0.5, dt / 0.13);
    const bottom = h + 2;
    const a0 = Math.PI * 1.12;
    const a1 = Math.PI * 1.88;
    const c0 = Math.cos(a0);
    const s0 = Math.sin(a0);

    for (let k = 0; k < rows.length; k++) {
      const row = rows[k];
      const n = row.n;
      row.bounce = damp(row.bounce, clamp01(pulseNow), BOUNCE_LAG[k], dt);
      const lift = row.bounce * BOUNCE_PX[k] * s * bounceAmt;
      const fill = sick > 0.5 ? rowFillSick[k][q] : rowFill[k][q];

      // pass 1: where everyone is; arms (behind the bodies)
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const want = row.join[i] < presenceNow ? 1 : 0;
        const p = row.present[i] < 0 ? want : row.present[i] + (want - row.present[i]) * kPresent;
        row.present[i] = p;
        row.hy0[i] = OFF;
        row.hy1[i] = OFF;
        if (p < 0.03) {
          row.sy[i] = OFF;
          continue;
        }
        const x = row.x[i];
        const r = row.r[i];
        const bw = row.w[i];
        const sy = row.baseY + row.hj[i] + (1 - p) * row.sink - lift * row.amp[i] + sick * 1.2 * s;
        row.sy[i] = sy;

        const style = row.style[i];
        const wantArm = style !== 3 && row.armAt[i] < armLevel ? 1 : 0;
        const up = row.arm[i] + (wantArm - row.arm[i]) * kArm;
        row.arm[i] = up;
        if (up < 0.03) continue;
        const e = up * up * (3 - 2 * up);
        const steady = style === 4 ? 0.2 : 1;
        const swayX = Math.sin(tSway * row.sway[i] + row.phase[i]) * r * 0.95 * e * steady;
        const pump = lift * row.amp[i] * (style === 1 || style === 2 ? 1.7 : 1.05) * steady;
        for (let side = -1; side <= 1; side += 2) {
          if ((side < 0 && (style === 2 || style === 4)) || (side > 0 && style === 1)) continue;
          const jx = x + side * bw * 0.38;
          const jy = sy + bw * 0.14;
          const ux = x + side * bw * (0.5 + row.spread[i]) + swayX;
          const uy = sy - r * (2.7 + row.reach[i]) - pump;
          const dx = x + side * bw * 0.46;
          const dy = sy + r * 2;
          const hx = dx + (ux - dx) * e;
          const hy = dy + (uy - dy) * e;
          ctx.moveTo(jx, jy);
          ctx.quadraticCurveTo((jx + hx) / 2 + side * bw * 0.2 * e, (jy + hy) / 2 + r * 0.5, hx, hy);
          if (side < 0) {
            row.hx0[i] = hx;
            row.hy0[i] = hy;
          } else {
            row.hx1[i] = hx;
            row.hy1[i] = hy;
          }
        }
      }
      ctx.strokeStyle = fill;
      ctx.lineWidth = row.armW;
      ctx.lineCap = 'round';
      ctx.stroke();

      // pass 2: shoulders, heads, hands
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const sy = row.sy[i];
        if (sy === OFF) continue;
        const x = row.x[i];
        const r = row.r[i];
        const half = row.w[i] / 2;
        const c = row.w[i] * 0.3;
        ctx.moveTo(x - half, bottom);
        ctx.lineTo(x - half, sy + c);
        ctx.quadraticCurveTo(x - half, sy, x - half + c, sy);
        ctx.lineTo(x + half - c, sy);
        ctx.quadraticCurveTo(x + half, sy, x + half, sy + c);
        ctx.lineTo(x + half, bottom);
        ctx.closePath();
        const hy = sy - r * 0.78;
        ctx.moveTo(x + r, hy);
        ctx.arc(x, hy, r, 0, TAU);
        const hr = r * 0.44;
        if (row.hy0[i] !== OFF) {
          ctx.moveTo(row.hx0[i] + hr, row.hy0[i]);
          ctx.arc(row.hx0[i], row.hy0[i], hr, 0, TAU);
        }
        if (row.hy1[i] !== OFF) {
          ctx.moveTo(row.hx1[i] + hr, row.hy1[i]);
          ctx.arc(row.hx1[i], row.hy1[i], hr, 0, TAU);
        }
      }
      ctx.fillStyle = fill;
      ctx.fill();

      // pass 3: rim light on the tops of heads and hands
      const ra = rimA * RIM[k];
      if (ra > 0.02 && rimAurora) {
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const sy = row.sy[i];
          if (sy === OFF) continue;
          const x = row.x[i];
          const r = row.r[i];
          const hy = sy - r * 0.78;
          ctx.moveTo(x + r * c0, hy + r * s0);
          ctx.arc(x, hy, r, a0, a1);
          const hr = r * 0.44;
          if (row.hy0[i] !== OFF) {
            ctx.moveTo(row.hx0[i] + hr * c0, row.hy0[i] + hr * s0);
            ctx.arc(row.hx0[i], row.hy0[i], hr, a0, a1);
          }
          if (row.hy1[i] !== OFF) {
            ctx.moveTo(row.hx1[i] + hr * c0, row.hy1[i] + hr * s0);
            ctx.arc(row.hx1[i], row.hy1[i], hr, a0, a1);
          }
        }
        ctx.lineWidth = k === 2 ? 1.25 : 1;
        if (sick < 0.98) {
          ctx.globalAlpha = Math.min(1, ra * (1 - sick));
          ctx.strokeStyle = rimAurora;
          ctx.stroke();
        }
        if (sick > 0.02) {
          ctx.globalAlpha = Math.min(1, ra * sick * 0.8);
          ctx.strokeStyle = SICK;
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
    }
  }

  function drawMeter(ctx: CanvasRenderingContext2D, dt: number, pulse: number, lowFx: boolean): void {
    if (!meter || !meterGold || !meterRed) return;
    const { x, y, w: mw, h: mh } = meter;
    const fire = look.fire * (1 - mood.sick);
    const danger = look.danger;
    const blink = 0.5 + 0.5 * Math.sin(tFree * 11);
    const fw = Math.max(mh, mw * clamp01(hype));

    // glow under a burning meter
    if (fire > 0.02) {
      ctx.globalCompositeOperation = 'lighter';
      blit(ctx, spr.glowAmber, x + fw / 2, y + mh / 2, fw / 2 + 16, 15, fire * (0.3 + 0.2 * pulse));
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }

    // track
    roundRectPath(ctx, x, y, mw, mh, mh / 2);
    ctx.fillStyle = 'rgba(4,4,14,0.82)';
    ctx.fill();
    // fill
    roundRectPath(ctx, x + 1, y + 1, fw - 2, mh - 2, (mh - 2) / 2);
    ctx.fillStyle = meterGold;
    ctx.fill();
    if (danger > 0.02) {
      ctx.globalAlpha = danger * (0.55 + 0.45 * blink);
      ctx.fillStyle = meterRed;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    // gloss + quarter ticks
    ctx.fillStyle = 'rgba(255,255,255,0.34)';
    ctx.fillRect(x + mh / 2, y + 2, Math.max(0, fw - mh), 1.4);
    ctx.fillStyle = 'rgba(4,4,14,0.4)';
    for (let i = 1; i < 4; i++) ctx.fillRect(x + (mw * i) / 4 - 0.5, y + 2, 1, mh - 4);
    // rim
    roundRectPath(ctx, x + 0.5, y + 0.5, mw - 1, mh - 1, (mh - 1) / 2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.stroke();
    if (danger > 0.02) {
      ctx.globalAlpha = danger * blink;
      ctx.strokeStyle = COLORS.red;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    ctx.globalCompositeOperation = 'lighter';
    // the head of the fill
    blit(ctx, danger > 0.5 ? spr.glowRed : spr.glowGold, x + fw - 1, y + mh / 2, 11, 11, 0.35 + 0.45 * pulse + 0.2 * fire);
    if (danger > 0.02) blit(ctx, spr.glowRed, x + mw / 2, y + mh / 2, mw / 2 + 8, 13, danger * 0.22 * blink);

    // flames
    if (!lowFx) {
      flameAcc += fire * 60 * dt;
      while (flameAcc >= 1) {
        flameAcc -= 1;
        for (let i = 0; i < N_FLAME; i++) {
          if (fLife[i] > 0) continue;
          fX[i] = x + 3 + rand() * Math.max(1, fw - 6);
          fY[i] = y + 2 + rand() * 2;
          fVx[i] = (rand() - 0.5) * 12;
          fVy[i] = -(16 + rand() * 30);
          fMax[i] = fLife[i] = 0.28 + rand() * 0.32;
          fSize[i] = 4.5 + rand() * 4.5;
          break;
        }
      }
      for (let i = 0; i < N_FLAME; i++) {
        if (fLife[i] <= 0) continue;
        fLife[i] -= dt;
        fX[i] += fVx[i] * dt;
        fY[i] += fVy[i] * dt;
        const age = 1 - Math.max(0, fLife[i]) / fMax[i];
        const size = fSize[i] * (1 - age * 0.75);
        const sp = age < 0.28 ? spr.glowHot : age < 0.62 ? spr.glowGold : spr.glowAmber;
        blit(ctx, sp, fX[i], fY[i], size, size * 1.35, (1 - age) * 0.85);
      }
    } else if (fire > 0.02) {
      blit(ctx, spr.glowHot, x + fw / 2, y + 1, fw / 2, 7, fire * (0.3 + 0.25 * pulse));
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  // values shared between draw() and drawCrowd() for the current frame
  let pulseNow = 0;
  let presenceNow = 1;

  return {
    mood,

    resize(nw, nh, nBarTop) {
      const changed = nw !== w || nh !== h || nBarTop !== barTop;
      if (!changed) return;
      const widthChanged = nw !== w;
      w = nw;
      h = nh;
      barTop = nBarTop;
      if (!w || !h) return;
      const ns = Math.min(1.3, Math.max(0.72, (h - barTop) / 62));
      if (widthChanged || ns !== s || rows.length === 0) {
        s = ns;
        const seed = rng(0xd15c0);
        rows = [makeRow(0, w, h, s, seed), makeRow(1, w, h, s, seed), makeRow(2, w, h, s, seed)];
      } else {
        for (let k = 0; k < rows.length; k++) rows[k].baseY = h - LIFT[k] * s;
      }
      renderStatic();
    },

    setMeter(rect) {
      meter = rect;
      buildMeterPaint();
    },

    setEnergy(e) {
      energyTarget = clamp01(e);
    },

    sparkle(count) {
      for (let i = 0; i < count; i++) spawnGlint(rand() * w, crowdBandY() - 6 * s, true);
    },

    confettiBurst(count) {
      for (let i = 0; i < count; i++) {
        spawnConfetti(rand() * w, -2 - rand() * 10, (rand() - 0.5) * 40, 30 + rand() * 45);
      }
    },

    draw(frame, lowFx) {
      if (!w || !h || !bg || !scrim) return;
      const ctx = fitCanvas(canvas, w, h, dpr);
      const dt = frame.dt;
      const hud = frame.hud;

      // ── inputs, smoothed ──
      hype = first ? hud.hype : damp(hype, hud.hype, 0.2, dt);
      first = false;
      stageLook(hype, look);
      mood.step(dt);
      const sick = mood.sick;
      const cheer = mood.cheer;
      const burst = mood.burst;
      const dip = mood.dip;
      const live = frame.liveDeck;
      alive = damp(alive, live ? clamp01(Math.abs(frame.decks[live].rate)) : 0, 0.16, dt);
      const pulse = frame.pulse;
      pulseNow = pulse;
      const low = frame.mixer.bands.low;
      bass = low > bass ? low : damp(bass, low, 0.12, dt);
      tint = damp(tint, live === 'A' ? 0.1 : live === 'B' ? 0.9 : 0.5, 0.45, dt);
      energy = damp(energy, energyTarget, 0.5, dt);

      const light =
        look.light * (0.76 + 0.24 * energy) * (1 - 0.5 * sick) * (1 - 0.3 * dip) * (0.62 + 0.38 * alive) + burst * 0.55;
      const sweep = look.sweep * (1 - sick);
      presenceNow = look.presence;
      const bounceAmt = Math.min(1.4, look.bounce * (1 - sick) * (1 - 0.5 * dip) + cheer * 0.7 + burst * 0.5);
      const armLevel = Math.max(look.arms * (1 - 0.92 * sick) - dip * 0.6, cheer * 1.15, burst * 0.9);

      tFree += dt;
      tSway += dt * (0.3 + 0.7 * alive);
      tBeam += dt * (0.04 + 1.7 * sweep) * (0.2 + 0.8 * alive) * (1 + 0.8 * burst);

      // ── the room ──
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.drawImage(bg, 0, 0, w, h);

      ctx.globalCompositeOperation = 'lighter';
      const hz = h - 14 * s;
      const hazeA = light * (0.2 + 0.26 * bass + 0.12 * pulse);
      for (let i = 0; i < 3; i++) {
        const px = w * (0.14 + 0.36 * i);
        const t = i / 2 + (tint - i / 2) * 0.42;
        blitPal(ctx, spr.glows, t, px, hz, w * 0.34, 36 * s, hazeA * (1 - sick));
        blit(ctx, spr.glowSick, px, hz, w * 0.34, 36 * s, hazeA * sick * 0.75);
      }
      if (!lowFx) {
        // slow drifting haze higher up
        for (let i = 0; i < 3; i++) {
          const u = (0.17 + i * 0.37 + tFree * 0.011 * (i + 1)) % 1;
          const t = 0.5 + 0.5 * Math.sin(i * 2.1 + tFree * 0.07);
          blitPal(ctx, spr.glows, t, u * (w + 160) - 80, h * 0.36, 96, 26 * s, light * 0.09 * (1 - sick));
        }
      }

      // beams
      const nb = nBeams(lowFx);
      const bl = (h + 18) * 1.18;
      const bw = bl * (0.4 + 0.2 * burst);
      const kLit = 1 - Math.pow(0.5, dt / 0.18);
      const ranks = BEAM_RANK[nb];
      for (let i = 0; i < nb; i++) {
        const th = (ranks[i] + 0.5) / nb;
        const want = Math.max(smoothstep(th - 0.08, th + 0.08, look.beams), burst);
        beamLit[i] += (want - beamLit[i]) * kLit;
        const lit = beamLit[i];
        if (lit < 0.01) continue;
        const sx = (w * (i + 0.5)) / nb;
        const fan = (i - (nb - 1) / 2) * 0.19;
        const swing = (0.22 + 0.5 * look.sweep) * Math.sin(tBeam * (0.8 + 0.37 * (i % 3)) + i * 1.7);
        const theta = fan * (1 - 0.5 * sick) + swing * (1 - 0.7 * sick);
        // a failing fixture flickers
        const flick = sick > 0.05 ? 1 - sick * 0.75 * (Math.sin(tFree * 37 + i * 12.9) > 0.1 ? 1 : 0.15) : 1;
        const a = lit * flick * Math.min(1.1, light * (0.38 + 0.36 * pulse * look.bounce + 0.2 * bass) + burst * 0.5);
        const cs = Math.cos(theta);
        const sn = Math.sin(theta);
        ctx.setTransform(dpr * cs, dpr * sn, -dpr * sn, dpr * cs, dpr * sx, dpr * 3);
        const t = clamp01(i / (nb - 1) + (tint - i / (nb - 1)) * 0.4 + 0.13 * Math.sin(tBeam * 0.33 + i * 1.3));
        const f = t * (N_PAL - 1);
        const i0 = Math.min(N_PAL - 2, Math.floor(f));
        const fr = f - i0;
        const aa = a * (1 - sick);
        if (aa * (1 - fr) > 0.004) {
          ctx.globalAlpha = Math.min(1, aa * (1 - fr));
          ctx.drawImage(spr.beams[i0], -bw / 2, 0, bw, bl);
        }
        if (aa * fr > 0.004) {
          ctx.globalAlpha = Math.min(1, aa * fr);
          ctx.drawImage(spr.beams[i0 + 1], -bw / 2, 0, bw, bl);
        }
        if (sick > 0.02) {
          ctx.globalAlpha = Math.min(1, a * sick * 0.8);
          ctx.drawImage(spr.beamSick, -bw / 2, 0, bw, bl);
        }
        if (burst > 0.03) {
          ctx.globalAlpha = Math.min(1, burst * 0.55);
          ctx.drawImage(spr.beamWhite, -bw / 2, 0, bw, bl);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        // the lamp, and the pool of light where the beam lands in the haze
        blitPal(ctx, spr.glows, t, sx, 4, 8, 8, lit * flick * light * 0.9 * (1 - sick));
        blit(ctx, spr.glowWhite, sx, 4, 3, 3, lit * flick * light);
        if (!lowFx) blitPal(ctx, spr.glows, t, sx - (sn / cs) * (hz - 3), hz, 30, 13 * s, a * 0.4 * (1 - sick));
      }

      // lasers, in the deck colours
      const lasers = lowFx ? 0 : look.lasers * (1 - sick) * (0.35 + 0.65 * alive);
      if (lasers > 0.02) {
        const len = h * 2.4 + w * 0.3;
        for (let e = 0; e < 2; e++) {
          const dir = e === 0 ? 1 : -1;
          const ex = e === 0 ? w * 0.07 : w * 0.93;
          const centre = dir * (1.02 + 0.3 * Math.sin(tBeam * 0.9 + e * 2.3));
          const spread = 0.085 + 0.05 * Math.sin(tBeam * 2.1 + e);
          ctx.beginPath();
          for (let j = -2; j <= 2; j++) {
            const phi = centre + j * spread;
            ctx.moveTo(ex, 4);
            ctx.lineTo(ex + Math.sin(phi) * len, 4 + Math.cos(phi) * len);
          }
          ctx.strokeStyle = e === 0 ? COLORS.cyan : COLORS.pink;
          ctx.lineCap = 'butt';
          ctx.globalAlpha = lasers * 0.13;
          ctx.lineWidth = 3;
          ctx.stroke();
          ctx.globalAlpha = lasers * (0.42 + 0.5 * pulse);
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }

      // ── the crowd ──
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      const rimA = Math.min(1, light * (0.34 + 0.4 * pulse + 0.2 * bass) + burst * 0.6 + cheer * 0.25);
      drawCrowd(ctx, dt, light * (0.55 + 0.45 * bass) + burst * 0.4, bounceAmt, armLevel, rimA);

      ctx.globalCompositeOperation = 'lighter';
      if (!lowFx) {
        // phones held up
        const phone = look.sparkle * (1 - sick);
        if (phone > 0.05) {
          for (let k = 0; k < rows.length; k++) {
            const row = rows[k];
            for (let i = 0; i < row.n; i++) {
              if (row.style[i] !== 4 || row.hy1[i] === OFF) continue;
              const tw = 0.75 + 0.25 * Math.sin(tFree * 5 + row.phase[i]);
              blit(ctx, spr.glowWhite, row.hx1[i], row.hy1[i] - 1.5, 2.4 + k, 2.4 + k, phone * row.arm[i] * tw);
            }
          }
        }

        // camera flashes and gold glints
        glintAcc += (look.sparkle * 4 * (1 - sick) + cheer * 26) * dt;
        while (glintAcc >= 1) {
          glintAcc -= 1;
          spawnGlint(rand() * w, crowdBandY() - (cheer > 0.3 ? 8 * s : 0), cheer > 0.3);
        }
        for (let i = 0; i < N_GLINT; i++) {
          if (gLife[i] <= 0) continue;
          gLife[i] -= dt;
          const u = Math.max(0, gLife[i]) / gMax[i];
          const env = u * (1 - u) * 4;
          const sp = gGold[i] ? spr.glowHot : spr.glowWhite;
          blit(ctx, sp, gX[i], gY[i], 2 + 5 * env, 2 + 5 * env, env);
          blit(ctx, sp, gX[i], gY[i], 9 * env, 1.2, env * 0.8);
        }

        // confetti
        confAcc += look.confetti * (1 - sick) * 13 * dt;
        while (confAcc >= 1) {
          confAcc -= 1;
          spawnConfetti(rand() * w, -3, (rand() - 0.5) * 16, 20 + rand() * 26);
        }
        ctx.globalCompositeOperation = 'source-over';
        for (let c = 0; c < CONF_COLORS.length; c++) {
          ctx.fillStyle = CONF_COLORS[c];
          for (let i = c; i < N_CONF; i += CONF_COLORS.length) {
            if (!cOn[i]) continue;
            cPh[i] += dt * 8;
            cX[i] += (cVx[i] + Math.sin(tFree * 2.6 + cPh[i] * 0.3) * 14) * dt;
            cY[i] += cVy[i] * dt;
            cVx[i] *= 1 - Math.min(1, dt * 1.5);
            if (cY[i] > h + 4) {
              cOn[i] = 0;
              continue;
            }
            const cw = cSize[i] * (0.2 + 0.8 * Math.abs(Math.cos(cPh[i])));
            ctx.globalAlpha = 0.92;
            ctx.fillRect(cX[i] - cw / 2, cY[i] - 1.1, cw, 2.2);
          }
        }
        ctx.globalCompositeOperation = 'lighter';
      }

      // a drop: one big flash from the rig
      if (burst > 0.01) {
        blit(ctx, spr.glowHot, w / 2, 0, w * 0.62, h * 1.1, burst * 0.8);
        ctx.globalAlpha = burst * 0.16;
        ctx.fillStyle = COLORS.goldHot;
        ctx.fillRect(0, 0, w, h);
      }
      // a cheer: a warm wash over the floor
      if (cheer > 0.02) blit(ctx, spr.glowGold, w / 2, h, w * 0.6, 30 * s, cheer * 0.3);

      // ── over the room: scrim for the text, then the hype meter ──
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.drawImage(scrim, 0, 0, w, h);
      drawMeter(ctx, dt, pulse, lowFx);
    },
  };
}
