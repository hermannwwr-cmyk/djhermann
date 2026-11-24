/**
 * The decks' "screens": two stacked scrolling waveforms (A above B) with beat grids.
 * Both use the same real-time scale, so two decks at the same BPM scroll at the same speed and
 * beats that line up sit exactly above each other. The waveform is rendered to offscreen tiles
 * (lazily, a couple per frame at most) and blitted every frame.
 */
import { phaseOffsetBeats, secAtBeat } from '../../core/beatgrid';
import { BEATS_PER_BAR } from '../../core/types';
import type { AudioEngine, Component, DeckId, FrameState, TrackMeta, WaveformData } from '../../core/types';
import { COLORS, FONT_DISPLAY, canvasDpr, deckColor, drawGlow, fitCanvas, font, mix, rgba, roundRectPath } from '../../theme/theme';
import { h } from './gestures';
import { PHASE_LOCK_BEATS, WAVE_PX_PER_SEC, wavePxPerTrackSec } from './logic';

/** Tile width in CSS px at the native scale (WAVE_PX_PER_SEC px per track second). */
const TILE_W = 256;
const MAX_TILES = 14;
/** Fraction of the width left of the playhead (what was just played). */
const PLAYHEAD_AT = 0.32;
/** Gap between the two lanes, px (the seam where the beat ticks of both decks meet). */
const SEAM = 4;

interface Lane {
  deck: DeckId;
  color: string;
  track: TrackMeta | null;
  wave: WaveformData | null;
  tiles: Map<number, HTMLCanvasElement>;
  /** label sprite (deck letter + BPM) and the text it was made for */
  label: HTMLCanvasElement | null;
  labelText: string;
}

/** The three band colours of a deck: lows deep, mids in the deck colour, highs bright. */
function bandColors(color: string): [string, string, string] {
  return [mix(color, '#1a1040', 0.55), mix(color, '#ffffff', 0.08), mix(color, '#ffffff', 0.72)];
}

/** Peak of a band over the buckets [i0, i1). */
function peak(arr: Uint8Array, i0: number, i1: number): number {
  let m = 0;
  const end = Math.min(arr.length, Math.max(i0 + 1, i1));
  for (let i = Math.max(0, i0); i < end; i++) if (arr[i] > m) m = arr[i];
  return m;
}

/** Render one tile of a lane's waveform: tile `index` covers track time [index, index+1) × TILE_W / WAVE_PX_PER_SEC. */
export function renderTile(wave: WaveformData, index: number, laneH: number, dpr: number, color: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  const wPx = Math.round(TILE_W * dpr);
  const hPx = Math.max(2, Math.round(laneH * dpr));
  c.width = wPx;
  c.height = hPx;
  const g = c.getContext('2d')!;
  const [lowC, midC, highC] = bandColors(color);
  const mid = hPx / 2;
  const half = hPx / 2 - 1;
  const secPerPx = 1 / (WAVE_PX_PER_SEC * dpr);
  const t0 = (index * TILE_W) / WAVE_PX_PER_SEC;
  const col = Math.max(1, Math.round(dpr)); // one column per CSS px
  const bands: [Uint8Array, string, number][] = [
    [wave.low, lowC, 1],
    [wave.mid, midC, 0.78],
    [wave.high, highC, 0.5],
  ];
  for (const [arr, fill, scale] of bands) {
    g.fillStyle = fill;
    g.beginPath();
    for (let x = 0; x < wPx; x += col) {
      const t = t0 + x * secPerPx;
      if (t < 0) continue;
      const i0 = Math.floor(t * wave.rate);
      if (i0 >= wave.length) break;
      const i1 = Math.floor((t + col * secPerPx) * wave.rate);
      const v = (peak(arr, i0, i1) / 255) * scale;
      const hh = Math.max(dpr * 0.5, v * half);
      g.rect(x, mid - hh, col, hh * 2);
    }
    g.fill();
  }
  // a faint top light on the whole picture so it reads as a lit screen
  const shade = g.createLinearGradient(0, 0, 0, hPx);
  shade.addColorStop(0, 'rgba(255,255,255,0.10)');
  shade.addColorStop(0.5, 'rgba(255,255,255,0)');
  shade.addColorStop(1, 'rgba(0,0,0,0.25)');
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = shade;
  g.fillRect(0, 0, wPx, hPx);
  return c;
}

function makeLabel(deck: DeckId, color: string, text: string, laneH: number, dpr: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  const hCss = Math.min(18, laneH - 6);
  const g0 = c.getContext('2d')!;
  g0.font = font(800, Math.round(hCss * 0.62));
  const w = Math.ceil(hCss + 6 + g0.measureText(text || 'NO TRACK').width + 2);
  c.width = Math.round(w * dpr);
  c.height = Math.round(hCss * dpr);
  const g = c.getContext('2d')!;
  g.scale(dpr, dpr);
  // badge with the deck letter
  g.fillStyle = color;
  roundRectPath(g, 0, 0, hCss, hCss, 4);
  g.fill();
  g.fillStyle = '#07070c';
  g.font = font(900, hCss * 0.62, FONT_DISPLAY);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(deck, hCss / 2, hCss / 2 + 0.5);
  g.textAlign = 'left';
  g.fillStyle = text ? COLORS.ink : rgba(COLORS.ink, 0.4);
  g.font = font(800, Math.round(hCss * 0.62));
  g.fillText(text || 'NO TRACK', hCss + 5, hCss / 2 + 0.5);
  return c;
}

export function createWaveforms(deps: { engine: AudioEngine; onDeckTap?: (deck: DeckId) => void }): Component {
  const { engine } = deps;
  const canvas = h('canvas', 'dk-waves-canvas');
  const el = h('div', 'dk-waves ui-touch', { role: 'button', 'aria-label': 'Waveforms of deck A and deck B' }, canvas);

  const lanes: Record<DeckId, Lane> = {
    A: { deck: 'A', color: deckColor('A'), track: null, wave: null, tiles: new Map(), label: null, labelText: '\u0000' },
    B: { deck: 'B', color: deckColor('B'), track: null, wave: null, tiles: new Map(), label: null, labelText: '\u0000' },
  };

  let w = 0;
  let hgt = 0;
  let laneH = 0;
  let dpr = 1;
  let frameBg: HTMLCanvasElement | null = null;

  const resize = (): void => {
    const nw = el.clientWidth;
    const nh = el.clientHeight;
    if (nw === w && nh === hgt) return;
    w = nw;
    hgt = nh;
    dpr = canvasDpr();
    laneH = Math.max(8, Math.floor((hgt - SEAM - 4) / 2));
    for (const id of ['A', 'B'] as DeckId[]) {
      lanes[id].tiles.clear();
      lanes[id].labelText = '\u0000';
    }
    frameBg = null;
  };
  const ro = new ResizeObserver(resize);
  ro.observe(el);

  const onDown = (e: PointerEvent): void => {
    const r = el.getBoundingClientRect();
    const deck: DeckId = e.clientY - r.top < r.height / 2 ? 'A' : 'B';
    deps.onDeckTap?.(deck);
  };
  el.addEventListener('pointerdown', onDown);

  const laneY = (deck: DeckId): number => (deck === 'A' ? 2 : 2 + laneH + SEAM);

  /** Static background: the recessed screen, lane wells, the seam. Rebuilt on resize. */
  function buildBg(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = Math.round(w * dpr);
    c.height = Math.round(hgt * dpr);
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);
    const bg = g.createLinearGradient(0, 0, 0, hgt);
    bg.addColorStop(0, '#04040a');
    bg.addColorStop(1, '#07070f');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, hgt);
    for (const id of ['A', 'B'] as DeckId[]) {
      const y = laneY(id);
      const lg = g.createLinearGradient(0, y, 0, y + laneH);
      lg.addColorStop(0, rgba(lanes[id].color, 0.05));
      lg.addColorStop(0.5, rgba(lanes[id].color, 0.015));
      lg.addColorStop(1, rgba(lanes[id].color, 0.05));
      g.fillStyle = lg;
      g.fillRect(0, y, w, laneH);
      // centre line
      g.fillStyle = rgba(lanes[id].color, 0.12);
      g.fillRect(0, y + laneH / 2 - 0.5, w, 1);
    }
    // scanlines: a subtle LCD texture
    g.fillStyle = 'rgba(0,0,0,0.18)';
    for (let y = 0; y < hgt; y += 2) g.fillRect(0, y, w, 1);
    return c;
  }

  function tile(lane: Lane, index: number, budget: { n: number }): HTMLCanvasElement | null {
    let t = lane.tiles.get(index);
    if (t) {
      // refresh LRU order
      lane.tiles.delete(index);
      lane.tiles.set(index, t);
      return t;
    }
    if (!lane.wave || budget.n <= 0) return null;
    budget.n--;
    t = renderTile(lane.wave, index, laneH, dpr, lane.color);
    lane.tiles.set(index, t);
    if (lane.tiles.size > MAX_TILES) lane.tiles.delete(lane.tiles.keys().next().value as number);
    return t;
  }

  const playX = (): number => Math.round(w * PLAYHEAD_AT);

  function drawLane(ctx: CanvasRenderingContext2D, frame: FrameState, lane: Lane, locked: boolean, budget: { n: number }): void {
    const d = frame.decks[lane.deck];
    const y = laneY(lane.deck);
    const px = playX();

    if (d.track !== lane.track) {
      lane.track = d.track;
      lane.wave = d.track ? (engine.getLoadedTrack(lane.deck)?.waveform ?? null) : null;
      lane.tiles.clear();
    }

    const bpmText = d.track ? d.bpm.toFixed(2) : '';
    if (bpmText !== lane.labelText || !lane.label) {
      lane.labelText = bpmText;
      lane.label = makeLabel(lane.deck, lane.color, bpmText, laneH, dpr);
    }

    if (!d.track || !lane.wave) {
      ctx.fillStyle = rgba(lane.color, 0.3);
      ctx.fillRect(0, y + laneH / 2 - 0.5, w, 1);
      ctx.fillStyle = rgba(COLORS.ink, 0.38);
      ctx.font = font(700, 10);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`DECK ${lane.deck} IS EMPTY`, w / 2 + 30, y + laneH / 2);
      ctx.textAlign = 'left';
    } else {
      const pps = wavePxPerTrackSec(d.tempo);
      const scale = pps / WAVE_PX_PER_SEC;
      const pos = d.positionSec;
      const t0 = pos - px / pps;
      const t1 = pos + (w - px) / pps;
      const tileSec = TILE_W / WAVE_PX_PER_SEC;
      const i0 = Math.max(0, Math.floor(t0 / tileSec));
      const i1 = Math.floor(t1 / tileSec);
      const tw = TILE_W * scale;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, y, w, laneH);
      ctx.clip();
      for (let i = i0; i <= i1; i++) {
        if (i * tileSec > d.durationSec) break;
        const img = tile(lane, i, budget);
        if (!img) continue;
        const x = px + (i * tileSec - pos) * pps;
        ctx.drawImage(img, x, y, tw + 0.5, laneH);
      }
      // prefetch the tile coming up next
      const next = i1 + 1;
      if (next * tileSec <= d.durationSec && !lane.tiles.has(next)) tile(lane, next, budget);

      // the part already played is dimmer
      ctx.fillStyle = 'rgba(4,4,10,0.55)';
      ctx.fillRect(0, y, px, laneH);

      // beat grid
      const grid = d.track.grid;
      const b0 = Math.ceil(((t0 - grid.firstBeatSec) * grid.bpm) / 60);
      const b1 = Math.floor(((t1 - grid.firstBeatSec) * grid.bpm) / 60);
      const tickH = 5;
      const tickY = lane.deck === 'A' ? y + laneH - tickH : y;
      for (let b = b0; b <= b1; b++) {
        const x = Math.round(px + (secAtBeat(grid, b) - pos) * pps) + 0.5;
        const down = ((b % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR === 0;
        ctx.fillStyle = down ? 'rgba(255,255,255,0.42)' : 'rgba(255,255,255,0.14)';
        ctx.fillRect(x - 0.5, y, 1, laneH);
        // beat ticks on the seam side: where the two decks' ticks meet, the beats line up
        ctx.fillStyle = locked ? COLORS.mint : down ? '#ffffff' : rgba(lane.color, 0.95);
        ctx.fillRect(x - (down ? 1.5 : 1), tickY, down ? 3 : 2, tickH);
      }

      // cue point
      const cx = px + (d.cueSec - pos) * pps;
      if (cx > -6 && cx < w + 6) {
        ctx.fillStyle = COLORS.amber;
        ctx.beginPath();
        ctx.moveTo(cx - 4, y);
        ctx.lineTo(cx + 4, y);
        ctx.lineTo(cx, y + 5);
        ctx.closePath();
        ctx.fill();
        ctx.fillRect(Math.round(cx) - 0.5, y, 1, laneH);
      }
      ctx.restore();
    }

    // label: deck letter and the effective BPM, on a dark plate at the left
    if (lane.label) {
      const lh = lane.label.height / dpr;
      const ly = Math.round(y + (laneH - lh) / 2);
      ctx.fillStyle = 'rgba(4,4,10,0.78)';
      ctx.fillRect(0, y, 6 + lane.label.width / dpr + 6, laneH);
      ctx.drawImage(lane.label, 5, ly, lane.label.width / dpr, lh);
    }
  }

  const budget = { n: 0 };

  return {
    el,
    update(frame: FrameState) {
      if (w < 16 || hgt < 16) {
        resize();
        if (w < 16 || hgt < 16) return;
      }
      const ctx = fitCanvas(canvas, w, hgt, dpr);
      if (!frameBg) frameBg = buildBg();
      ctx.drawImage(frameBg, 0, 0, w, hgt);

      const a = frame.decks.A;
      const b = frame.decks.B;
      const running = a.track !== null && b.track !== null && a.rate > 0.3 && b.rate > 0.3;
      const locked = running && Math.abs(phaseOffsetBeats(a, b)) <= PHASE_LOCK_BEATS && Math.abs(a.bpm - b.bpm) < 0.05;

      budget.n = 2;
      drawLane(ctx, frame, lanes.A, locked, budget);
      drawLane(ctx, frame, lanes.B, locked, budget);

      // the seam between the lanes: lights up green while the beats line up
      const sy = 2 + laneH;
      ctx.fillStyle = locked ? rgba(COLORS.mint, 0.85) : 'rgba(255,255,255,0.06)';
      ctx.fillRect(0, sy + SEAM / 2 - 0.5, w, 1);

      // playhead
      const px = playX();
      const live = frame.liveDeck;
      if (live) drawGlow(ctx, px, hgt / 2, 26, deckColor(live), 0.25 + 0.45 * frame.pulse);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(px - 1, 0, 2, hgt);
      ctx.beginPath();
      ctx.moveTo(px - 5, 0);
      ctx.lineTo(px + 5, 0);
      ctx.lineTo(px, 5);
      ctx.closePath();
      ctx.moveTo(px - 5, hgt);
      ctx.lineTo(px + 5, hgt);
      ctx.lineTo(px, hgt - 5);
      ctx.closePath();
      ctx.fill();
    },
    destroy() {
      ro.disconnect();
      el.removeEventListener('pointerdown', onDown);
      el.remove();
    },
  };
}
