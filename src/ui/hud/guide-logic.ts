/**
 * The decisions behind the guide, free of DOM so they can be tested:
 * when a mission step begins, which panel to open by itself, and what to point at.
 */
import { panelOf } from '../../core/controls';
import type { ControlId, Gesture, MissionTarget, MissionView, PanelId } from '../../core/types';

export const PANEL_NAME: Record<PanelId, string> = { deckA: 'DECK A', mixer: 'MIXER', deckB: 'DECK B' };

/** What the finger does, in plain words, for the caption next to the spotlight. */
export const GESTURE_WORDS: Record<Gesture, string> = {
  tap: 'TAP',
  hold: 'PRESS & HOLD',
  up: 'SLIDE UP',
  down: 'SLIDE DOWN',
  left: 'SLIDE LEFT',
  right: 'SLIDE RIGHT',
  // a knob is turned by dragging on it: down turns it left, up turns it right
  'turn-left': 'DRAG DOWN',
  'turn-right': 'DRAG UP',
  scratch: 'RUB BACK & FORTH',
};

/** One thing the guide points at: a control with its gesture, or the button that opens a panel. */
export type Pointer =
  | { kind: 'control'; control: ControlId; gesture: Gesture }
  | { kind: 'tab'; panel: PanelId };

/**
 * The panel a step needs opened: the panel of its first target that is not on screen.
 * null when every target is already visible (or lives on the always-visible strip).
 */
export function panelToOpen(targets: readonly MissionTarget[], open: PanelId | null): PanelId | null {
  for (const t of targets) {
    const panel = panelOf(t.control);
    if (panel === null) continue;
    return panel === open ? null : panel;
  }
  return null;
}

/**
 * What to point at right now. A target on the open panel (or on no panel) is pointed at directly;
 * a target on a panel that is not open is replaced by that panel's button, once per panel.
 */
export function planPointers(targets: readonly MissionTarget[], open: PanelId | null, out: Pointer[] = []): Pointer[] {
  out.length = 0;
  for (const t of targets) {
    const panel = panelOf(t.control);
    if (panel === null || panel === open) {
      out.push({ kind: 'control', control: t.control, gesture: t.gesture });
    } else if (!out.some((p) => p.kind === 'tab' && p.panel === panel)) {
      out.push({ kind: 'tab', panel });
    }
  }
  return out;
}

/**
 * Notices when a mission step begins: a new mission, or the same mission asking for different
 * controls. Compares without allocating, so it can run every frame.
 */
export class StepTracker {
  private id = -1;
  private n = -1;
  private controls: ControlId[] = [];
  private gestures: Gesture[] = [];
  /** the guide opened (or decided not to open) a panel for the current step */
  autoOpened = false;

  /** returns true when `mission` starts a new step (null = no mission: resets) */
  observe(mission: MissionView | null): boolean {
    if (!mission) {
      const had = this.id !== -1;
      this.id = -1;
      this.n = -1;
      this.autoOpened = false;
      return had;
    }
    const t = mission.targets;
    let same = mission.id === this.id && t.length === this.n;
    for (let i = 0; same && i < t.length; i++) {
      same = t[i].control === this.controls[i] && t[i].gesture === this.gestures[i];
    }
    if (same) return false;
    this.id = mission.id;
    this.n = t.length;
    for (let i = 0; i < t.length; i++) {
      this.controls[i] = t[i].control;
      this.gestures[i] = t[i].gesture;
    }
    this.autoOpened = false;
    return true;
  }
}

/** Rectangle intersection area as a fraction of `a` (0 when they do not overlap). */
export function visibleFraction(
  ax: number,
  ay: number,
  aw: number,
  ah: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
): number {
  if (aw <= 0 || ah <= 0) return 0;
  const ix = Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx));
  const iy = Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by));
  return (ix * iy) / (aw * ah);
}
