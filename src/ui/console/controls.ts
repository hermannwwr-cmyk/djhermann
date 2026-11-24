/**
 * The hardware widgets: rotary knob, fader (channel, cross, tempo), LED meter, backlit button.
 * Each one shows the value it reads from the frame; while a finger is on it, the finger wins.
 */
import type { ControlId, FrameState } from '../../core/types';
import { bindDrag, h, html } from './gestures';
import {
  KNOB_DETENT,
  KNOB_DRAG_PX,
  KNOB_SWEEP_DEG,
  METER_SEGMENTS,
  clampRaw,
  fineGain,
  fromRaw,
  knobArcPath,
  meterFall,
  meterSegments,
  toRaw,
} from './logic';

export interface Ctl {
  readonly el: HTMLElement;
  update(frame: FrameState): void;
  destroy(): void;
}

/** What the widgets need from the console. */
export interface CtlEnv {
  /** a short vibration (detents, button presses) when haptics are on and the device can */
  haptic(ms: number): void;
}

// ───────────── knob ─────────────

export interface KnobOpts {
  id: ControlId;
  label: string;
  kind: 'eq' | 'filter';
  /** normalised value -1..1 with the detent at 0 */
  read(frame: FrameState): number;
  write(n: number): void;
}

const KNOB_TICKS = ((): string => {
  let s = '';
  for (let d = -KNOB_SWEEP_DEG; d <= KNOB_SWEEP_DEG; d += 30) {
    const a = (d * Math.PI) / 180;
    const r0 = d === 0 ? 39.5 : 41;
    const x0 = 50 + r0 * Math.sin(a);
    const y0 = 50 - r0 * Math.cos(a);
    const x1 = 50 + 45 * Math.sin(a);
    const y1 = 50 - 45 * Math.cos(a);
    s += `<line class="${d === 0 ? 'dk-knob-tick0' : 'dk-knob-tick'}" x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}"/>`;
  }
  return s;
})();

const ARC_R = 48.2;

export function createKnob(env: CtlEnv, o: KnobOpts): Ctl {
  const track = knobArcPath(-1, ARC_R) + knobArcPath(1, ARC_R);
  const ring = html(
    `<svg class="dk-knob-ring" viewBox="0 0 100 100" aria-hidden="true">${KNOB_TICKS}` +
      `<path class="dk-knob-track" d="${track}"/><path class="dk-knob-arc" d=""/></svg>`,
  );
  const arc = ring.querySelector('.dk-knob-arc') as SVGPathElement;
  const rot = h('div', 'dk-knob-rot', null, h('i', 'dk-knob-ptr'));
  const cap = h('div', 'dk-knob-cap', null, rot, h('i', 'dk-knob-gloss'));
  const dial = h('div', 'dk-knob-dial', null, ring, cap);
  const el = h('div', `dk-knob dk-knob--${o.kind} ui-touch`, { 'data-control': o.id }, dial);
  if (o.kind === 'filter') {
    el.append(h('span', 'dk-knob-end dk-knob-end--l', null, 'LPF'), h('span', 'dk-knob-end dk-knob-end--r', null, 'HPF'));
  }
  el.append(h('span', 'dk-legend', null, o.label));

  let held = false;
  let raw = 0;
  let local = 0;
  let shown = NaN;
  let current = 0;

  const render = (n: number): void => {
    if (n === shown) return;
    shown = n;
    rot.style.transform = `rotate(${(n * KNOB_SWEEP_DEG).toFixed(2)}deg)`;
    arc.setAttribute('d', knobArcPath(n, ARC_R));
    el.classList.toggle('dk-zero', n === 0);
    el.classList.toggle('dk-min', n <= -1);
  };

  const set = (n: number): void => {
    if (n !== local && (n === 0 || Math.abs(n) === 1)) env.haptic(6);
    local = n;
    o.write(n);
    render(n);
  };

  const unbind = bindDrag(el, {
    start() {
      held = true;
      local = current;
      raw = toRaw(current, KNOB_DETENT);
      el.classList.add('dk-held');
    },
    move(_e, _dx, dy) {
      raw = clampRaw(raw - (dy / KNOB_DRAG_PX) * 2, KNOB_DETENT);
      set(fromRaw(raw, KNOB_DETENT));
    },
    end() {
      held = false;
      el.classList.remove('dk-held');
    },
    doubleTap() {
      raw = 0;
      set(0);
    },
  });

  return {
    el,
    update(frame) {
      current = held ? local : o.read(frame);
      render(current);
    },
    destroy: unbind,
  };
}

// ───────────── fader ─────────────

export interface ScaleMark {
  /** position along the travel, -1 (top / left) .. 1 (bottom / right) */
  at: number;
  label?: string;
  major?: boolean;
}

export interface FaderOpts {
  id: ControlId;
  orient: 'v' | 'h';
  /** extra class: dk-fader--ch | dk-fader--x | dk-fader--tempo */
  cls: string;
  /** cap length along the travel, px */
  capLen: number;
  /** position -1..1 along the travel: -1 = top / left, +1 = bottom / right */
  read(frame: FrameState): number;
  write(n: number): void;
  /** half width of the centre detent in travel units (0 = no detent) */
  detent?: number;
  /** a slow finger makes fine moves (tempo fader) */
  fine?: boolean;
  /** double-tap puts the fader back on its detent */
  doubleTapReset?: boolean;
  scale?: ScaleMark[];
}

export function createFader(env: CtlEnv, o: FaderOpts): Ctl {
  const zone = o.detent ?? 0;
  const vertical = o.orient === 'v';
  const scale = h('div', 'dk-fader-scale');
  for (const m of o.scale ?? []) {
    const pct = `${((m.at + 1) * 50).toFixed(2)}%`;
    const tick = h('i', m.major ? 'dk-tick dk-tick--major' : 'dk-tick');
    tick.style[vertical ? 'top' : 'left'] = pct;
    scale.append(tick);
    if (m.label !== undefined) {
      const lab = h('span', 'dk-tick-label', null, m.label);
      lab.style[vertical ? 'top' : 'left'] = pct;
      scale.append(lab);
    }
  }
  const capEl = h('div', 'dk-fader-cap', null, h('i', 'dk-fader-cap-line'));
  const el = h(
    'div',
    `dk-fader dk-fader--${o.orient} ${o.cls} ui-touch`,
    { 'data-control': o.id },
    scale,
    h('div', 'dk-fader-slot'),
    capEl,
  );
  el.style.setProperty('--dk-cap', `${o.capLen}px`);

  let half = 1;
  let held = false;
  let raw = 0;
  let local = 0;
  let shown = NaN;
  let shownHalf = NaN;
  let current = 0;
  let lastMoveT = 0;

  const measure = (): void => {
    const len = vertical ? el.clientHeight : el.clientWidth;
    half = Math.max(1, (len - o.capLen) / 2 - 3);
  };
  const ro = new ResizeObserver(measure);
  ro.observe(el);

  const render = (n: number): void => {
    if (n === shown && half === shownHalf) return;
    shown = n;
    shownHalf = half;
    const px = (n * half).toFixed(2);
    capEl.style.transform = vertical ? `translate3d(0,${px}px,0)` : `translate3d(${px}px,0,0)`;
    el.classList.toggle('dk-zero', n === 0);
  };

  const set = (n: number): void => {
    if (n !== local && ((zone > 0 && n === 0) || Math.abs(n) === 1)) env.haptic(6);
    local = n;
    o.write(n);
    render(n);
  };

  const unbind = bindDrag(el, {
    start(e) {
      measure();
      held = true;
      local = current;
      raw = toRaw(current, zone);
      lastMoveT = e.timeStamp;
      el.classList.add('dk-held');
    },
    move(e, dx, dy) {
      const d = vertical ? dy : dx;
      let gain = 1;
      if (o.fine) {
        const dt = Math.max(4, e.timeStamp - lastMoveT) / 1000;
        gain = fineGain(d / dt);
      }
      lastMoveT = e.timeStamp;
      raw = clampRaw(raw + (d / half) * gain, zone);
      set(fromRaw(raw, zone));
    },
    end() {
      held = false;
      el.classList.remove('dk-held');
    },
    ...(o.doubleTapReset
      ? {
          doubleTap() {
            raw = 0;
            set(0);
          },
        }
      : {}),
  });

  return {
    el,
    update(frame) {
      current = held ? local : o.read(frame);
      render(current);
    },
    destroy() {
      unbind();
      ro.disconnect();
    },
  };
}

// ───────────── LED meter ─────────────

export interface Meter {
  readonly el: HTMLElement;
  update(level: number, dt: number): void;
}

export function createMeter(cls = ''): Meter {
  const el = h('div', `dk-meter ${cls}`);
  const segs: HTMLElement[] = [];
  for (let i = 0; i < METER_SEGMENTS; i++) {
    const s = h('i', i >= METER_SEGMENTS - 1 ? 'dk-seg dk-seg--red' : i >= METER_SEGMENTS - 3 ? 'dk-seg dk-seg--amber' : 'dk-seg');
    segs.push(s);
  }
  // first child = top segment
  for (let i = METER_SEGMENTS - 1; i >= 0; i--) el.append(segs[i]);
  let shown = 0;
  let lit = 0;
  return {
    el,
    update(level, dt) {
      shown = meterFall(shown, level, dt);
      const n = meterSegments(shown);
      if (n === lit) return;
      const lo = Math.min(n, lit);
      const hi = Math.max(n, lit);
      for (let i = lo; i < hi; i++) segs[i].classList.toggle('dk-on', i < n);
      lit = n;
    },
  };
}

// ───────────── button ─────────────

export type Lit = 'off' | 'dim' | 'on';

export interface Button {
  readonly el: HTMLElement;
  setLit(lit: Lit): void;
  destroy(): void;
}

export interface ButtonOpts {
  id?: ControlId;
  cls: string;
  /** inner markup: icon and/or legend */
  content: string;
  attrs?: Record<string, string>;
  down(e: PointerEvent): void;
  up?(): void;
}

export function createButton(env: CtlEnv, o: ButtonOpts): Button {
  const attrs: Record<string, string> = { type: 'button', ...(o.attrs ?? {}) };
  if (o.id) attrs['data-control'] = o.id;
  const el = h('button', `dk-btn ${o.cls} ui-touch`, attrs);
  el.innerHTML = `<i class="dk-btn-glow"></i><span class="dk-btn-face">${o.content}</span>`;
  let lit: Lit = 'off';
  el.dataset.lit = lit;
  const unbind = bindDrag(el, {
    start(e) {
      el.classList.add('dk-down');
      env.haptic(8);
      o.down(e);
    },
    end() {
      el.classList.remove('dk-down');
      o.up?.();
    },
  });
  return {
    el,
    setLit(next) {
      if (next === lit) return;
      lit = next;
      el.dataset.lit = next;
    },
    destroy: unbind,
  };
}
