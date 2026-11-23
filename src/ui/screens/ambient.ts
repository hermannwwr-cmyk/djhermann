/**
 * The backdrop behind the menus: club haze, slow light beams and soft bokeh in the aurora colours.
 * It is drawn small (about a third of the screen resolution) and stretched by CSS, which is what
 * makes it soft and keeps it cheap; it redraws about 30 times a second and not at all when stopped.
 */
import { rng } from '../../core/math';
import { COLORS, glowSprite, rgba } from '../../theme/theme';
import { prefersReducedMotion } from './dom';
import { shared } from './shared';
import { onFrame } from './ticker';

export interface AmbientBackground {
  el: HTMLElement;
  start(): void;
  stop(): void;
}

interface Blob {
  color: string;
  /** centre and drift, in units of the canvas size */
  x: number;
  y: number;
  ax: number;
  ay: number;
  /** radius in units of the canvas width */
  r: number;
  alpha: number;
  speed: number;
  phase: number;
}

interface Beam {
  color: string;
  /** apex x in units of the canvas width (the apex sits above the top edge) */
  x: number;
  /** resting angle from straight down, radians */
  angle: number;
  sway: number;
  speed: number;
  phase: number;
  /** length in units of the canvas height, half-width at the far end in units of the length */
  length: number;
  spread: number;
  alpha: number;
}

interface Bokeh {
  sprite: number;
  x: number;
  y: number;
  r: number;
  alpha: number;
  rise: number;
  sway: number;
  phase: number;
  twinkle: number;
}

const SCALE = 0.34;
const FRAME_MS = 1000 / 30;

const BLOBS: Blob[] = [
  { color: COLORS.cyan, x: 0.12, y: 0.1, ax: 0.16, ay: 0.07, r: 0.95, alpha: 0.2, speed: 0.021, phase: 0 },
  { color: COLORS.violet, x: 0.55, y: 0.36, ax: 0.2, ay: 0.1, r: 1.15, alpha: 0.17, speed: 0.016, phase: 1.7 },
  { color: COLORS.pink, x: 0.92, y: 0.84, ax: 0.14, ay: 0.08, r: 1.0, alpha: 0.19, speed: 0.019, phase: 3.1 },
  { color: COLORS.violet, x: 0.1, y: 0.95, ax: 0.1, ay: 0.06, r: 0.8, alpha: 0.11, speed: 0.024, phase: 4.6 },
  { color: COLORS.cyan, x: 0.95, y: 0.2, ax: 0.08, ay: 0.09, r: 0.6, alpha: 0.09, speed: 0.027, phase: 5.4 },
];

const BEAMS: Beam[] = [
  { color: COLORS.cyan, x: 0.1, angle: 0.34, sway: 0.16, speed: 0.11, phase: 0.4, length: 1.05, spread: 0.2, alpha: 0.15 },
  { color: COLORS.violet, x: 0.42, angle: -0.08, sway: 0.2, speed: 0.083, phase: 2.2, length: 1.15, spread: 0.17, alpha: 0.12 },
  { color: COLORS.pink, x: 0.9, angle: -0.36, sway: 0.15, speed: 0.097, phase: 4.1, length: 1.05, spread: 0.2, alpha: 0.15 },
  { color: COLORS.violet, x: 0.68, angle: 0.12, sway: 0.22, speed: 0.071, phase: 5.6, length: 0.95, spread: 0.14, alpha: 0.08 },
];

const BOKEH_COLORS = [COLORS.cyan, COLORS.violet, COLORS.pink, '#6f8dff', '#ffffff'];

/** A light beam: narrow and bright at the lamp, wide and faint at the far end, soft at the sides. */
function makeBeamSprite(color: string): HTMLCanvasElement {
  const w = 96;
  const hgt = 192;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = hgt;
  const g = c.getContext('2d')!;
  const img = g.createImageData(w, hgt);
  const n = parseInt(color.slice(1), 16);
  const r = (n >> 16) & 255;
  const gr = (n >> 8) & 255;
  const b = n & 255;
  for (let y = 0; y < hgt; y++) {
    const t = y / (hgt - 1); // 0 at the lamp, 1 at the far end
    const half = 0.035 + 0.465 * t; // half-width of the cone at this distance, 0..0.5 of the sprite
    const along = Math.pow(1 - t, 1.35) * Math.min(1, t * 14); // fades with distance; no hard start
    for (let x = 0; x < w; x++) {
      const u = Math.abs(x / (w - 1) - 0.5) / half; // 0 on the axis, 1 at the edge of the cone
      let a = 0;
      if (u < 1) {
        const side = Math.cos((u * Math.PI) / 2);
        a = along * side * side;
      }
      const i = (y * w + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = gr;
      img.data[i + 2] = b;
      img.data[i + 3] = Math.round(255 * a);
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

/** An out-of-focus light: a flat disc with a slightly brighter rim and a soft edge. */
function makeBokehSprite(color: string): HTMLCanvasElement {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, rgba(color, 0.5));
  grad.addColorStop(0.62, rgba(color, 0.55));
  grad.addColorStop(0.8, rgba(color, 0.9));
  grad.addColorStop(0.9, rgba(color, 0.55));
  grad.addColorStop(1, rgba(color, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

export function createAmbientBackground(): AmbientBackground {
  const el = document.createElement('div');
  el.className = 'sc-ambient';
  el.setAttribute('aria-hidden', 'true');
  const canvas = document.createElement('canvas');
  canvas.className = 'sc-ambient__canvas';
  const shade = document.createElement('div');
  shade.className = 'sc-ambient__shade';
  el.append(canvas, shade);

  const g = canvas.getContext('2d')!;
  let w = 0;
  let h = 0;
  let running = false;
  let off: (() => void) | null = null;
  let lastDraw = -Infinity;
  let time = 0;
  let beamSprites: HTMLCanvasElement[] | null = null;
  let bokehSprites: HTMLCanvasElement[] | null = null;

  const rand = rng(20261123);
  const bokeh: Bokeh[] = Array.from({ length: 18 }, () => ({
    sprite: Math.floor(rand() * BOKEH_COLORS.length),
    x: rand(),
    y: rand(),
    r: 0.018 + rand() * rand() * 0.075,
    alpha: 0.05 + rand() * 0.13,
    rise: 0.004 + rand() * 0.011,
    sway: 0.01 + rand() * 0.03,
    phase: rand() * Math.PI * 2,
    twinkle: 0.2 + rand() * 0.5,
  }));

  function resize(): void {
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    if (!cw || !ch) return;
    const nw = Math.max(64, Math.round(cw * SCALE));
    const nh = Math.max(64, Math.round(ch * SCALE));
    if (nw === w && nh === h) return;
    w = canvas.width = nw;
    h = canvas.height = nh;
    draw();
  }

  function draw(): void {
    if (!w || !h) return;
    const low = shared.lowFx();
    beamSprites ??= BEAMS.map((b) => makeBeamSprite(b.color));
    bokehSprites ??= BOKEH_COLORS.map((c) => makeBokehSprite(c));

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.clearRect(0, 0, w, h);
    g.globalCompositeOperation = 'lighter';

    // haze: big soft clouds of colour drifting on slow loops
    for (const b of BLOBS) {
      const a = time * b.speed * Math.PI * 2 + b.phase;
      const x = (b.x + Math.cos(a) * b.ax) * w;
      const y = (b.y + Math.sin(a * 0.8 + 1) * b.ay) * h;
      const r = b.r * w;
      g.globalAlpha = b.alpha * (0.85 + 0.15 * Math.sin(a * 1.7));
      g.drawImage(glowSprite(b.color), x - r, y - r, r * 2, r * 2);
    }

    // beams from lamps above the top edge, swaying slowly
    const beams = low ? 2 : BEAMS.length;
    for (let i = 0; i < beams; i++) {
      const b = BEAMS[i];
      const ang = b.angle + Math.sin(time * b.speed * Math.PI * 2 + b.phase) * b.sway;
      const len = b.length * h;
      const half = len * b.spread;
      const breathe = 0.75 + 0.25 * Math.sin(time * b.speed * 9 + b.phase * 3);
      g.setTransform(Math.cos(ang), Math.sin(ang), -Math.sin(ang), Math.cos(ang), b.x * w, -0.06 * h);
      g.globalAlpha = b.alpha * breathe;
      g.drawImage(beamSprites[i], -half, 0, half * 2, len);
    }
    g.setTransform(1, 0, 0, 1, 0, 0);

    // bokeh: far-away lights drifting up
    const count = low ? 8 : bokeh.length;
    for (let i = 0; i < count; i++) {
      const p = bokeh[i];
      const y = 1.1 - ((((p.y + time * p.rise) % 1.2) + 1.2) % 1.2);
      const x = p.x + Math.sin(time * 0.21 + p.phase) * p.sway;
      const r = p.r * w;
      const tw = 1 - p.twinkle * (0.5 + 0.5 * Math.sin(time * 0.9 + p.phase * 2.3));
      // fade in and out near the top and bottom so nothing pops
      const edge = Math.min(1, Math.min(y + 0.1, 1.1 - y) * 6);
      g.globalAlpha = p.alpha * tw * Math.max(0, edge);
      g.drawImage(bokehSprites[p.sprite], x * w - r, y * h - r, r * 2, r * 2);
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
  }

  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  ro?.observe(el);

  return {
    el,
    start() {
      if (running) return;
      running = true;
      el.classList.add('sc-ambient--on');
      resize();
      if (prefersReducedMotion()) {
        draw(); // a still picture: no loop at all
        return;
      }
      lastDraw = -Infinity;
      off = onFrame((now, dt) => {
        time += dt;
        const every = shared.lowFx() ? FRAME_MS * 2 : FRAME_MS;
        if (now - lastDraw < every - 2) return;
        lastDraw = now;
        if (!w || !h) resize();
        draw();
      });
    },
    stop() {
      if (!running) return;
      running = false;
      off?.();
      off = null;
      el.classList.remove('sc-ambient--on');
    },
  };
}
