/**
 * Example dev harness: copy dev/example.html + this file to start your own.
 * Open http://localhost:<port>/dev/example.html
 */
import { bootHarness } from './harness';
import { COLORS, FONT_DISPLAY, deckColor, drawGlow, fitCanvas, font } from '../theme/theme';
import type { Component, FrameState } from '../core/types';

/** A minimal component: a canvas that pulses on the beat and prints the deck state. */
function createBeatLamp(): Component {
  const el = document.createElement('div');
  el.style.cssText = 'position:absolute;inset:0';
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:100%;height:100%';
  el.appendChild(canvas);
  let w = 0;
  let h = 0;
  const ro = new ResizeObserver(() => {
    w = el.clientWidth;
    h = el.clientHeight;
  });
  ro.observe(el);

  return {
    el,
    update(frame: FrameState) {
      if (!w || !h) return;
      const ctx = fitCanvas(canvas, w, h);
      ctx.clearRect(0, 0, w, h);
      const live = frame.liveDeck;
      const color = live ? deckColor(live) : COLORS.ink4;
      drawGlow(ctx, w / 2, h / 2, 60 + 80 * frame.pulse, color, 0.4 + 0.6 * frame.pulse);
      ctx.fillStyle = COLORS.ink;
      ctx.textAlign = 'center';
      ctx.font = font(900, 28, FONT_DISPLAY);
      ctx.fillText(live ? `DECK ${live}` : 'DEAD AIR', w / 2, h / 2 + 8);
      ctx.font = font(700, 12);
      ctx.fillStyle = COLORS.ink2;
      const d = frame.decks.A;
      ctx.fillText(`beat ${frame.beat.toFixed(2)}  ·  ${frame.bpm.toFixed(1)} bpm  ·  A @ ${d.positionSec.toFixed(2)}s`, w / 2, h / 2 + 34);
    },
    destroy() {
      ro.disconnect();
      el.remove();
    },
  };
}

const h = await bootHarness();
const lamp = createBeatLamp();
h.mount(lamp.el, 240);
h.loop.add((f) => lamp.update(f));

const row = document.createElement('div');
row.style.cssText = 'display:flex;gap:8px;padding:16px;flex-wrap:wrap';
const btn = (label: string, fn: () => void): void => {
  const b = document.createElement('button');
  b.className = 'ui-btn ui-btn--sm';
  b.textContent = label;
  b.addEventListener('click', fn);
  row.appendChild(b);
};
btn('play/pause A', () => h.engine.togglePlay('A'));
btn('play/pause B', () => h.engine.togglePlay('B'));
btn('xfade → B', () => h.engine.setCrossfader(1));
btn('xfade → A', () => h.engine.setCrossfader(-1));
btn('sync B', () => h.engine.sync('B'));
h.root.appendChild(row);
