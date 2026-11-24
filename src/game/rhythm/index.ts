/**
 * The playfield: the note highway with the four performance pads along its bottom edge.
 *
 *   const rhythm = createRhythm({ engine, bus, settings });
 *   slot.appendChild(rhythm.el);       // fills its container
 *   loop.add((f) => rhythm.update(f), 'logic');
 *
 * It follows the engine's deck:load / deck:eject events and charts whatever is on each deck. The
 * notes ride the live deck's beat. Pads: pointer (multi-touch) on the pad row, keys D F J K.
 */
import './rhythm.css';
import type { GameBus } from '../../core/events';
import type { AudioEngine, Difficulty, FrameState, Lane, RhythmController, SettingsStore } from '../../core/types';
import { LANE_COUNT, LANE_SOUNDS } from '../../core/types';
import { RhythmCore } from './core';
import { PAD_ROW_PADDING, PAD_GAP, TOUCH_ABOVE_PADS, padRowHeight } from './layout';
import { PadRow } from './pads';
import { HighwayView } from './view';

export { generateChart, RULES, handOf } from './chart';
export type { Chart, Note, ChartRules } from './chart';

export interface RhythmDeps {
  engine: AudioEngine;
  bus: GameBus;
  settings: SettingsStore;
}

/** The controller plus handles for dev harnesses and tests (not part of the game contract). */
export interface RhythmDev {
  controller: RhythmController;
  core: RhythmCore;
  /** press / release a pad as if a finger did, with the event time in performance.now() ms */
  press(lane: Lane, perfMs: number): void;
  release(lane: Lane): void;
  /** ms spent inside update() on the last frame */
  readonly lastUpdateMs: number;
}

const KEY_LANES: Record<string, Lane> = { KeyD: 0, KeyF: 1, KeyJ: 2, KeyK: 3 };
const SIDE = PAD_ROW_PADDING - PAD_GAP / 2;

/** event.timeStamp when it is a usable performance.now() value, else now */
function eventTime(e: Event): number {
  const now = performance.now();
  const t = e.timeStamp;
  return t > now - 1000 && t <= now + 5 ? t : now;
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

export function createRhythmDev(deps: RhythmDeps): RhythmDev {
  const { engine, bus, settings } = deps;
  let difficulty: Difficulty = settings.get().difficulty;
  let now = 0;

  const el = document.createElement('div');
  el.className = 'rh ui-touch';

  let view: HighwayView | null = null;
  const core = new RhythmCore({
    engine,
    bus,
    difficulty,
    onJudge: (fx) => view?.judge(fx, now || performance.now()),
  });
  view = new HighwayView(core, settings);
  const v = view;
  const pads = new PadRow();
  el.append(v.canvas, pads.el);

  // ── size ──
  let slotW = 0;
  let slotH = 0;
  let padH = 0;
  const relayout = (): void => {
    if (slotW < 2 || slotH < 2) return;
    padH = padRowHeight(slotW, slotH);
    el.style.setProperty('--rh-pad-h', `${padH}px`);
    el.classList.toggle('rh--compact', padH < 76);
    el.classList.toggle('rh--large', padH >= 100);
    v.resize(slotW, slotH, padH, difficulty);
  };
  const ro = new ResizeObserver((entries) => {
    const r = entries[entries.length - 1].contentRect;
    if (r.width === slotW && r.height === slotH) return;
    slotW = r.width;
    slotH = r.height;
    relayout();
  });
  ro.observe(el);

  // ── pads ──
  function press(lane: Lane, perfMs: number): void {
    engine.playSound(LANE_SOUNDS[lane]);
    if (settings.get().haptics) {
      try {
        navigator.vibrate?.(8);
      } catch {
        /* not allowed here */
      }
    }
    bus.emit('pad', { lane, perfMs });
    pads.down(lane);
    v.padDown(lane);
    core.tap(lane, perfMs);
  }
  function release(lane: Lane): void {
    pads.up(lane);
    v.padUp(lane);
  }

  const pointers = new Map<number, Lane>();
  const onPointerDown = (e: PointerEvent): void => {
    if (e.button > 0 || slotW < 2) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (y < slotH - padH - TOUCH_ABOVE_PADS) return;
    e.preventDefault();
    const laneW = (slotW - 2 * SIDE) / LANE_COUNT;
    const lane = Math.max(0, Math.min(LANE_COUNT - 1, Math.floor((x - SIDE) / laneW))) as Lane;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic or already gone */
    }
    const prev = pointers.get(e.pointerId);
    if (prev !== undefined) release(prev);
    pointers.set(e.pointerId, lane);
    press(lane, eventTime(e));
  };
  const onPointerEnd = (e: PointerEvent): void => {
    const lane = pointers.get(e.pointerId);
    if (lane === undefined) return;
    pointers.delete(e.pointerId);
    release(lane);
  };
  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('pointerup', onPointerEnd);
  el.addEventListener('pointercancel', onPointerEnd);
  el.addEventListener('lostpointercapture', onPointerEnd);
  el.addEventListener('contextmenu', (e) => e.preventDefault());

  const keysDown = new Set<string>();
  const onKeyDown = (e: KeyboardEvent): void => {
    const lane = KEY_LANES[e.code];
    if (lane === undefined || e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
    if (keysDown.has(e.code)) return;
    e.preventDefault();
    keysDown.add(e.code);
    press(lane, eventTime(e));
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    if (!keysDown.delete(e.code)) return;
    release(KEY_LANES[e.code]);
  };
  const releaseAll = (): void => {
    for (const code of keysDown) release(KEY_LANES[code]);
    keysDown.clear();
    for (const lane of pointers.values()) release(lane);
    pointers.clear();
    pads.releaseAll();
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', releaseAll);

  let lastUpdateMs = 0;
  const controller: RhythmController = {
    el,
    setDifficulty(d) {
      if (d === difficulty) return;
      difficulty = d;
      core.setDifficulty(d);
      relayout();
    },
    get density() {
      return core.density;
    },
    setDensity(d) {
      core.setDensity(d);
    },
    getStats: () => core.getStats(),
    reset() {
      core.reset();
      v.reset();
    },
    update(frame: FrameState) {
      const t0 = performance.now();
      now = frame.now;
      // the slot may have been sized before the observer fired (first frame after mounting)
      if (slotW < 2 && el.clientWidth > 1) {
        slotW = el.clientWidth;
        slotH = el.clientHeight;
        relayout();
      }
      core.update(frame);
      v.draw(frame);
      pads.update(v.cue, frame.pulse, v.aliveLevel, frame.dt, settings.get().lowFx);
      lastUpdateMs = performance.now() - t0;
    },
    destroy() {
      ro.disconnect();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', releaseAll);
      core.destroy();
      el.remove();
    },
  };

  return {
    controller,
    core,
    press,
    release,
    get lastUpdateMs() {
      return lastUpdateMs;
    },
  };
}

export function createRhythm(deps: RhythmDeps): RhythmController {
  return createRhythmDev(deps).controller;
}
