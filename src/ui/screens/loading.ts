/**
 * The loading overlay the app shows while tracks are prepared: a record being "pressed". The
 * grooves are cut from the label outwards as the progress grows, an aurora ring runs round it,
 * and the stage is written underneath in plain words.
 *
 * The overlay is an element the caller mounts (normally in the app's overlay layer); show() /
 * set() / hide() drive it. Nothing runs per frame: the spin is a CSS animation that only runs
 * while the overlay is visible.
 */
import { clamp01 } from '../../core/math';
import { h, nextFrame, wait } from './dom';
import { recordElement } from './record';

export interface LoadingOverlay {
  el: HTMLElement;
  show(label?: string): void;
  set(progress: number, label?: string): void;
  hide(): Promise<void>;
}

const RING_R = 47;
const RING_LEN = 2 * Math.PI * RING_R;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Short, plain-words tips shown while the player waits. */
const TIPS = [
  'The glowing control is always the one to use.',
  'Hit the pads when the notes reach the line.',
  'Keep the music playing: silence empties the floor.',
  'Two tracks at the same speed mix without a clash.',
  'Slide the crossfader to hand the crowd to the other deck.',
];

let tipIndex = Math.floor(Math.random() * TIPS.length);

function ring(): { svg: SVGSVGElement; arc: SVGCircleElement } {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('class', 'sc-load__ring');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = `
    <defs>
      <linearGradient id="sc-load-grad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#2de2ff"/><stop offset="0.52" stop-color="#8b6cff"/><stop offset="1" stop-color="#ff4fa8"/>
      </linearGradient>
    </defs>
    <circle class="sc-load__track" cx="50" cy="50" r="${RING_R}"/>`;
  const arc = document.createElementNS(SVG_NS, 'circle');
  arc.setAttribute('class', 'sc-load__arc');
  arc.setAttribute('cx', '50');
  arc.setAttribute('cy', '50');
  arc.setAttribute('r', String(RING_R));
  arc.setAttribute('stroke-dasharray', `${RING_LEN} ${RING_LEN}`);
  arc.setAttribute('stroke-dashoffset', String(RING_LEN));
  svg.appendChild(arc);
  return { svg, arc };
}

export function createLoadingOverlay(): LoadingOverlay {
  const { svg, arc } = ring();
  const press = h('div', 'sc-load__press');
  const blank = h('div', 'sc-load__blank');
  let rec: HTMLElement | null = null;
  const disc = h('div', 'sc-load__disc', blank, press);
  const stage = h('div', 'sc-load__stage');
  const pct = h('div', 'sc-load__pct ui-num', '0', h('small', null, '%'));
  const tip = h('p', 'sc-load__tip');
  const el = h(
    'div',
    'sc-load',
    h('div', 'sc-load__haze'),
    h('div', 'sc-load__center', h('div', 'sc-load__record', svg, disc), pct, stage),
    tip,
  );
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.hidden = true;

  let progress = 0;
  let shown = false;
  let hideToken = 0;

  function paint(label?: string): void {
    const p = clamp01(progress);
    arc.setAttribute('stroke-dashoffset', String(RING_LEN * (1 - p)));
    el.style.setProperty('--p', p.toFixed(3));
    pct.firstChild!.textContent = String(Math.round(p * 100));
    if (label !== undefined) stage.textContent = label;
    el.classList.toggle('sc-load--done', p >= 1);
  }

  function show(label?: string): void {
      hideToken++;
      // the record is drawn the first time it is needed, at the size it is shown
      if (!rec) {
        rec = recordElement(184, 'logo', 'sc-load__vinyl');
        press.appendChild(rec);
      }
      progress = 0;
      tip.textContent = TIPS[tipIndex];
      tipIndex = (tipIndex + 1) % TIPS.length;
      paint(label ?? 'Getting ready');
      el.hidden = false;
      if (!shown) {
        shown = true;
        void nextFrame().then(() => {
          if (shown) el.classList.add('sc-load--in');
        });
      }
  }

  return {
    el,
    show,
    set(p, label) {
      if (!shown) show(label);
      progress = Number.isFinite(p) ? p : progress;
      paint(label);
    },
    async hide() {
      if (!shown) return;
      shown = false;
      const token = ++hideToken;
      el.classList.remove('sc-load--in');
      await wait(340);
      if (token === hideToken && !shown) el.hidden = true;
    },
  };
}

