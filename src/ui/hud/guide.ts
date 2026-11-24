/**
 * The guide: an overlay over the whole game screen that shows the player which control to use and
 * what to do with it. For each target of the mission in progress it
 *  - opens the console panel the control lives on (once, when the step begins),
 *  - spotlights the control: a pulsing gold ring that hugs it, the rest of the console dimmed,
 *  - plays the gesture on the control itself: a hand that taps, holds, slides, turns or scratches,
 *  - says the gesture in plain words.
 * If the player has switched to another panel it points at the button that brings the right one back.
 * It never takes input (pointer-events: none) and follows the control's rectangle every frame.
 */
import type { Component, ControlId, FrameState, Gesture, PanelId, SettingsStore } from '../../core/types';
import { el } from './dom';
import { SCRATCH_ANGLE, SCRATCH_SWING, cuePose, newPose, scratchRadius, slideDir, travel } from './gestures';
import { GESTURE_WORDS, PANEL_NAME, StepTracker, panelToOpen, planPointers, visibleFraction } from './guide-logic';
import type { Pointer } from './guide-logic';
import { HAND_BOX, HAND_SVG } from './icons';

export interface GuideDeps {
  /** the game screen: controls are found inside it by their data-control / data-tab attributes */
  root: HTMLElement;
  settings: SettingsStore;
  openPanel: (id: PanelId) => void;
  getPanel: () => PanelId | null;
}

const MAX_SPOTS = 4;
const SVG_NS = 'http://www.w3.org/2000/svg';
/** the hand is drawn this wide on screen */
const HAND_W = 40;
const HAND_K = HAND_W / HAND_BOX.w;
const HOLD_R = 17;
const HOLD_C = 2 * Math.PI * HOLD_R;
const LOOKUP_EVERY_MS = 240;

interface Spot {
  el: HTMLDivElement;
  label: HTMLDivElement;
  hand: HTMLDivElement;
  contact: HTMLDivElement;
  rip1: HTMLDivElement;
  rip2: HTMLDivElement;
  track: HTMLDivElement;
  trackFill: HTMLElement;
  arc: SVGSVGElement;
  arcPath: SVGPathElement;
  arcHeads: SVGPathElement;
  hold: SVGSVGElement;
  holdArc: SVGCircleElement;
  // what it points at
  key: string;
  selector: string;
  gesture: Gesture;
  isTab: boolean;
  candidates: HTMLElement[];
  lookedAt: number;
  t0: number;
  // measured this frame (relative to the overlay)
  x: number;
  y: number;
  w: number;
  h: number;
  seen: boolean;
  round: boolean;
  radius: number;
  // applied
  on: boolean;
  aw: number;
  ah: number;
  ax: number;
  ay: number;
  aRound: boolean | null;
  aRadius: number;
  geoKey: string;
  labelShift: number;
  labelBelow: boolean | null;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, className: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  e.setAttribute('class', className);
  return e;
}

function makeSpot(): Spot {
  const root = el('div', 'hud-spot');
  const ping = el('div', 'hud-spot__ping');
  const ring = el('div', 'hud-spot__ring');
  const label = el('div', 'hud-spot__label');
  const cue = el('div', 'hud-cue');

  const arc = svg('svg', 'hud-cue__arc');
  const arcPath = svg('path', 'hud-cue__arcline');
  const arcHeads = svg('path', 'hud-cue__archead');
  arc.append(arcPath, arcHeads);

  const track = el('div', 'hud-cue__track');
  const trackFill = el('i');
  track.append(trackFill, el('b'));

  const rip1 = el('div', 'hud-cue__ripple');
  const rip2 = el('div', 'hud-cue__ripple');

  const hold = svg('svg', 'hud-cue__hold');
  hold.setAttribute('viewBox', '-22 -22 44 44');
  const holdBack = svg('circle', 'hud-cue__holdback');
  holdBack.setAttribute('r', String(HOLD_R));
  const holdArc = svg('circle', 'hud-cue__holdarc');
  holdArc.setAttribute('r', String(HOLD_R));
  holdArc.setAttribute('stroke-dasharray', HOLD_C.toFixed(2));
  hold.append(holdBack, holdArc);

  const contact = el('div', 'hud-cue__contact');
  const hand = el('div', 'hud-cue__hand');
  hand.innerHTML = HAND_SVG;
  hand.style.width = `${HAND_W}px`;
  hand.style.height = `${(HAND_BOX.h * HAND_K).toFixed(1)}px`;
  hand.style.left = `${(-HAND_BOX.tipX * HAND_K).toFixed(1)}px`;
  hand.style.top = `${(-HAND_BOX.tipY * HAND_K).toFixed(1)}px`;
  hand.style.transformOrigin = `${(HAND_BOX.tipX * HAND_K).toFixed(1)}px ${(HAND_BOX.tipY * HAND_K).toFixed(1)}px`;

  cue.append(arc, track, rip1, rip2, hold, contact, hand);
  root.append(ping, ring, cue, label);
  return {
    el: root,
    label,
    hand,
    contact,
    rip1,
    rip2,
    track,
    trackFill,
    arc,
    arcPath,
    arcHeads,
    hold,
    holdArc,
    key: '',
    selector: '',
    gesture: 'tap',
    isTab: false,
    candidates: [],
    lookedAt: -1e9,
    t0: 0,
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    seen: false,
    round: false,
    radius: 10,
    on: false,
    aw: -1,
    ah: -1,
    ax: NaN,
    ay: NaN,
    aRound: null,
    aRadius: -1,
    geoKey: '',
    labelShift: 0,
    labelBelow: null,
  };
}

/** point on a circle of radius r at angle a, measured clockwise from 12 o'clock */
const px = (r: number, a: number): number => Math.sin(a) * r;
const py = (r: number, a: number): number => -Math.cos(a) * r;

/** an arrowhead at angle `a` on a circle of radius r, pointing clockwise (dir 1) or anticlockwise (-1) */
function arrowHead(r: number, a: number, dir: number, size: number): string {
  const x = px(r, a);
  const y = py(r, a);
  const tx = Math.cos(a) * dir;
  const ty = Math.sin(a) * dir;
  const nx = Math.sin(a);
  const ny = -Math.cos(a);
  const f = (n: number): string => n.toFixed(1);
  return (
    `M${f(x + tx * size)} ${f(y + ty * size)}` +
    `L${f(x - tx * size * 0.35 + nx * size * 0.78)} ${f(y - ty * size * 0.35 + ny * size * 0.78)}` +
    `L${f(x - tx * size * 0.35 - nx * size * 0.78)} ${f(y - ty * size * 0.35 - ny * size * 0.78)}Z`
  );
}

function roundRectSub(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  const f = (n: number): string => n.toFixed(1);
  return (
    `M${f(x + rr)} ${f(y)}H${f(x + w - rr)}A${f(rr)} ${f(rr)} 0 0 1 ${f(x + w)} ${f(y + rr)}` +
    `V${f(y + h - rr)}A${f(rr)} ${f(rr)} 0 0 1 ${f(x + w - rr)} ${f(y + h)}` +
    `H${f(x + rr)}A${f(rr)} ${f(rr)} 0 0 1 ${f(x)} ${f(y + h - rr)}` +
    `V${f(y + rr)}A${f(rr)} ${f(rr)} 0 0 1 ${f(x + rr)} ${f(y)}Z`
  );
}

export function createGuide(deps: GuideDeps): Component {
  const { root, settings } = deps;
  const overlay = el('div', 'hud-guide');
  overlay.dataset.on = '0';
  overlay.setAttribute('aria-hidden', 'true');
  const dim = svg('svg', 'hud-guide__dim');
  const dimNear = svg('path', 'hud-guide__dim-near');
  const dimFar = svg('path', 'hud-guide__dim-far');
  dim.append(dimFar, dimNear);
  overlay.appendChild(dim);

  const spots: Spot[] = [];
  for (let i = 0; i < MAX_SPOTS; i++) {
    const s = makeSpot();
    spots.push(s);
    overlay.appendChild(s.el);
  }

  const tracker = new StepTracker();
  const pointers: Pointer[] = [];
  const pose = newPose();
  const clipCache = new WeakMap<HTMLElement, HTMLElement[]>();
  let plannedOpen: PanelId | null | undefined;
  let nSpots = 0;
  let shownOn = false;
  let shownMode = '';
  let consoleEl: HTMLElement | null = null;
  let consoleAt = -1e9;
  let dimKey = '';

  /** ancestors (below the game screen) that clip their content: a control can be scrolled out of them */
  function clipsOf(target: HTMLElement): HTMLElement[] {
    let list = clipCache.get(target);
    if (list) return list;
    list = [];
    for (let p = target.parentElement; p && p !== root && root.contains(p); p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') list.push(p);
    }
    clipCache.set(target, list);
    return list;
  }

  /** the console: an element marked data-console, else the smallest box holding every control and tab */
  function findConsole(now: number): HTMLElement | null {
    if (consoleEl && consoleEl.isConnected && now - consoleAt < 1500) return consoleEl;
    consoleAt = now;
    const marked = root.querySelector<HTMLElement>('[data-console]');
    if (marked) return (consoleEl = marked);
    const all = root.querySelectorAll<HTMLElement>('[data-control],[data-tab]');
    if (!all.length) return (consoleEl = null);
    let lca: HTMLElement | null = all[0].parentElement;
    for (let i = 1; i < all.length && lca; i++) {
      while (lca && lca !== root && !lca.contains(all[i])) lca = lca.parentElement;
    }
    return (consoleEl = lca && lca !== root && root.contains(lca) ? lca : null);
  }

  function assign(spot: Spot, p: Pointer, now: number): void {
    const key = p.kind === 'control' ? `c:${p.control}:${p.gesture}` : `t:${p.panel}`;
    if (key === spot.key) return;
    spot.key = key;
    spot.isTab = p.kind === 'tab';
    spot.gesture = p.kind === 'control' ? p.gesture : 'tap';
    spot.selector = p.kind === 'control' ? `[data-control="${p.control as ControlId}"]` : `[data-tab="${p.panel}"]`;
    spot.candidates = [];
    spot.lookedAt = -1e9;
    spot.t0 = now;
    spot.geoKey = '';
    spot.el.dataset.gesture = spot.gesture;
    spot.el.dataset.kind = p.kind;
    spot.label.textContent = p.kind === 'control' ? GESTURE_WORDS[p.gesture] : `OPEN ${PANEL_NAME[p.panel]}`;
    spot.labelShift = NaN;
  }

  function release(spot: Spot): void {
    spot.key = '';
    spot.candidates = [];
    setOn(spot, false);
  }

  function setOn(spot: Spot, on: boolean): void {
    if (spot.on === on) return;
    spot.on = on;
    spot.el.dataset.on = on ? '1' : '0';
  }

  /** read phase: find the element and measure it relative to the overlay */
  function measure(spot: Spot, base: DOMRect, now: number): void {
    spot.seen = false;
    let stale = spot.candidates.length === 0;
    for (let i = 0; i < spot.candidates.length; i++) if (!spot.candidates[i].isConnected) stale = true;
    if (stale && now - spot.lookedAt >= LOOKUP_EVERY_MS) {
      spot.lookedAt = now;
      spot.candidates = Array.from(root.querySelectorAll<HTMLElement>(spot.selector));
    }
    let best = 0;
    for (let i = 0; i < spot.candidates.length; i++) {
      const target = spot.candidates[i];
      const r = target.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      // how much of it is really on screen: inside the game screen and every clipping ancestor
      let frac = visibleFraction(r.left, r.top, r.width, r.height, base.left, base.top, base.width, base.height);
      const clips = clipsOf(target);
      for (let c = 0; c < clips.length && frac > 0; c++) {
        const cr = clips[c].getBoundingClientRect();
        frac = Math.min(frac, visibleFraction(r.left, r.top, r.width, r.height, cr.left, cr.top, cr.width, cr.height));
      }
      if (frac < 0.55) continue;
      const area = r.width * r.height * frac;
      if (area <= best) continue;
      best = area;
      spot.seen = true;
      spot.x = r.left - base.left;
      spot.y = r.top - base.top;
      spot.w = r.width;
      spot.h = r.height;
      if (target !== spotShapeOf.get(spot)) {
        spotShapeOf.set(spot, target);
        const br = parseFloat(getComputedStyle(target).borderTopLeftRadius) || 0;
        const square = Math.abs(r.width - r.height) < Math.max(4, r.width * 0.12);
        const turning = spot.gesture === 'turn-left' || spot.gesture === 'turn-right' || spot.gesture === 'scratch';
        spot.round = square && (turning || br >= r.width * 0.4);
        spot.radius = Math.min(20, Math.max(8, br + 5));
      }
    }
  }
  const spotShapeOf = new WeakMap<Spot, HTMLElement>();

  /** write phase: ring, caption and the gesture cue */
  function place(spot: Spot, now: number, bw: number, subtle: boolean): void {
    if (!spot.seen) {
      setOn(spot, false);
      return;
    }
    const pad = spot.round ? 4 : 5;
    const w = spot.w + pad * 2;
    const h = spot.h + pad * 2;
    const x = spot.x - pad;
    const y = spot.y - pad;
    const s = spot.el.style;
    if (Math.abs(w - spot.aw) > 0.4 || Math.abs(h - spot.ah) > 0.4) {
      spot.aw = w;
      spot.ah = h;
      s.width = `${w.toFixed(1)}px`;
      s.height = `${h.toFixed(1)}px`;
    }
    if (spot.round !== spot.aRound || spot.radius !== spot.aRadius) {
      spot.aRound = spot.round;
      spot.aRadius = spot.radius;
      s.setProperty('--hud-r', spot.round ? '50%' : `${spot.radius}px`);
    }
    if (Math.abs(x - spot.ax) > 0.05 || Math.abs(y - spot.ay) > 0.05 || !(spot.ax === spot.ax)) {
      spot.ax = x;
      spot.ay = y;
      s.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`;
    }
    setOn(spot, true);
    if (subtle) return;

    // caption: above the control, below when there is no room; kept inside the screen
    const below = y < 30;
    if (below !== spot.labelBelow) {
      spot.labelBelow = below;
      spot.el.dataset.label = below ? 'below' : 'above';
    }
    const lw = (spot.label.textContent ?? '').length * 6.9 + 18;
    const cx = x + w / 2;
    const shift = Math.round(Math.min(bw - lw / 2 - 6, Math.max(lw / 2 + 6, cx)) - cx);
    if (shift !== spot.labelShift) {
      spot.labelShift = shift;
      spot.label.style.setProperty('--hud-shift', `${shift}px`);
    }

    // static geometry of the cue: only when the control's size (or the gesture) changed
    const g = spot.gesture;
    const geoKey = `${g}|${Math.round(spot.w)}|${Math.round(spot.h)}`;
    if (geoKey !== spot.geoKey) {
      spot.geoKey = geoKey;
      layoutCue(spot);
    }

    // the moving parts
    cuePose(g, (now - spot.t0) / 1000, spot.w, spot.h, pose);
    const mirrored = x + w / 2 + pose.x > bw - 46;
    const lift = 1 - pose.press;
    const hx = pose.x + lift * (mirrored ? -5 : 5);
    const hy = pose.y + lift * 9;
    const sc = 1.14 - 0.2 * pose.press;
    const hs = spot.hand.style;
    hs.transform = `translate3d(${hx.toFixed(1)}px,${hy.toFixed(1)}px,0) scale(${(mirrored ? -sc : sc).toFixed(3)},${sc.toFixed(3)}) rotate(-17deg)`;
    hs.opacity = pose.alpha.toFixed(2);
    const cs = spot.contact.style;
    cs.transform = `translate3d(${pose.x.toFixed(1)}px,${pose.y.toFixed(1)}px,0) scale(${(0.55 + 0.45 * pose.press).toFixed(2)})`;
    cs.opacity = (pose.press * pose.alpha * 0.9).toFixed(2);
    ripple(spot.rip1, pose.ripple, pose.x, pose.y);
    ripple(spot.rip2, pose.ripple2, pose.x, pose.y);

    if (g === 'hold') {
      spot.holdArc.style.strokeDashoffset = (HOLD_C * (1 - pose.stroke)).toFixed(1);
    } else if (g === 'turn-left' || g === 'turn-right') {
      spot.arc.style.transform = `rotate(${pose.turn.toFixed(3)}rad)`;
      spot.arc.style.opacity = (0.35 + 0.65 * pose.alpha).toFixed(2);
      spot.trackFill.style.transform = `scaleX(${pose.stroke.toFixed(3)})`;
    } else if (slideDir(g)) {
      spot.trackFill.style.transform = `scaleX(${pose.stroke.toFixed(3)})`;
    }
  }

  function ripple(node: HTMLElement, phase: number, x: number, y: number): void {
    if (phase < 0) {
      if (node.style.opacity !== '0') node.style.opacity = '0';
      return;
    }
    node.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) scale(${(0.3 + 1.1 * phase).toFixed(3)})`;
    node.style.opacity = ((1 - phase) * 0.95).toFixed(2);
  }

  function layoutCue(spot: Spot): void {
    const g = spot.gesture;
    const dir = slideDir(g);
    if (dir) {
      const len = travel(g, spot.w, spot.h);
      const angle = Math.atan2(dir[1], dir[0]);
      spot.track.style.width = `${len.toFixed(1)}px`;
      spot.track.style.transform = `translate3d(${(-dir[0] * len * 0.5).toFixed(1)}px,${(-dir[1] * len * 0.5).toFixed(1)}px,0) rotate(${angle.toFixed(4)}rad)`;
    }
    if (g === 'turn-left' || g === 'turn-right') {
      const cw = g === 'turn-right' ? 1 : -1;
      const r = Math.max(spot.w, spot.h) / 2 + 13;
      const a0 = -cw * 0.75;
      const a1 = cw * 1.5;
      const size = r + 14;
      spot.arc.setAttribute('viewBox', `${-size} ${-size} ${size * 2} ${size * 2}`);
      spot.arc.style.width = spot.arc.style.height = `${size * 2}px`;
      spot.arc.style.left = spot.arc.style.top = `${-size}px`;
      spot.arcPath.setAttribute(
        'd',
        `M${px(r, a0).toFixed(1)} ${py(r, a0).toFixed(1)}A${r.toFixed(1)} ${r.toFixed(1)} 0 0 ${cw > 0 ? 1 : 0} ${px(r, a1).toFixed(1)} ${py(r, a1).toFixed(1)}`,
      );
      spot.arcHeads.setAttribute('d', arrowHead(r, a1, cw, 8));
    } else if (g === 'scratch') {
      const r = scratchRadius(spot.w, spot.h);
      const a0 = SCRATCH_ANGLE - SCRATCH_SWING - 0.12;
      const a1 = SCRATCH_ANGLE + SCRATCH_SWING + 0.12;
      const size = r + 14;
      spot.arc.setAttribute('viewBox', `${-size} ${-size} ${size * 2} ${size * 2}`);
      spot.arc.style.width = spot.arc.style.height = `${size * 2}px`;
      spot.arc.style.left = spot.arc.style.top = `${-size}px`;
      spot.arc.style.transform = '';
      spot.arc.style.opacity = '1';
      spot.arcPath.setAttribute(
        'd',
        `M${px(r, a0).toFixed(1)} ${py(r, a0).toFixed(1)}A${r.toFixed(1)} ${r.toFixed(1)} 0 0 1 ${px(r, a1).toFixed(1)} ${py(r, a1).toFixed(1)}`,
      );
      spot.arcHeads.setAttribute('d', arrowHead(r, a1, 1, 8) + arrowHead(r, a0, -1, 8));
    }
  }

  function hideAll(): void {
    if (shownOn) {
      shownOn = false;
      overlay.dataset.on = '0';
    }
    for (let i = 0; i < nSpots; i++) release(spots[i]);
    nSpots = 0;
    plannedOpen = undefined;
    if (dimKey !== '') {
      dimKey = '';
      dimNear.setAttribute('d', '');
      dimFar.setAttribute('d', '');
    }
  }

  return {
    el: overlay,

    update(frame: FrameState) {
      const mission = frame.hud.mission;
      const stepChanged = tracker.observe(mission);
      if (!mission || mission.targets.length === 0) {
        hideAll();
        return;
      }
      const guideOn = settings.get().guide;
      const now = frame.now;

      // the right panel slides in by itself, once per step; after that the player is in charge
      let open = deps.getPanel();
      if (guideOn && !tracker.autoOpened) {
        tracker.autoOpened = true;
        const need = panelToOpen(mission.targets, open);
        if (need) {
          deps.openPanel(need);
          open = deps.getPanel();
        }
      }

      if (stepChanged || open !== plannedOpen) {
        plannedOpen = open;
        planPointers(mission.targets, open, pointers);
        const n = Math.min(MAX_SPOTS, pointers.length);
        for (let i = 0; i < n; i++) assign(spots[i], pointers[i], now);
        for (let i = n; i < nSpots; i++) release(spots[i]);
        nSpots = n;
      }

      const mode = guideOn ? 'full' : 'subtle';
      if (mode !== shownMode) {
        shownMode = mode;
        overlay.dataset.mode = mode;
      }
      if (!shownOn) {
        shownOn = true;
        overlay.dataset.on = '1';
      }

      // ── read ──
      const base = overlay.getBoundingClientRect();
      if (base.width === 0) return;
      for (let i = 0; i < nSpots; i++) measure(spots[i], base, now);
      const con = guideOn ? findConsole(now) : null;
      const cr = con ? con.getBoundingClientRect() : null;

      // ── write ──
      let any = false;
      for (let i = 0; i < nSpots; i++) {
        place(spots[i], now, base.width, !guideOn);
        any = any || spots[i].seen;
      }

      // dim the rest of the console, with a soft-edged hole around each spotlight
      let key = '';
      if (cr && any) {
        key = `${Math.round(cr.left - base.left)},${Math.round(cr.top - base.top)},${Math.round(cr.width)},${Math.round(cr.height)}`;
        for (let i = 0; i < nSpots; i++) {
          const sp = spots[i];
          if (sp.seen) key += `|${Math.round(sp.x * 2)},${Math.round(sp.y * 2)},${Math.round(sp.w)},${Math.round(sp.h)},${sp.round ? 1 : 0}`;
        }
      }
      if (key !== dimKey) {
        dimKey = key;
        let near = '';
        let far = '';
        if (cr && any) {
          const outer = `M${(cr.left - base.left).toFixed(1)} ${(cr.top - base.top).toFixed(1)}h${cr.width.toFixed(1)}v${cr.height.toFixed(1)}h${(-cr.width).toFixed(1)}Z`;
          near = outer;
          far = outer;
          for (let i = 0; i < nSpots; i++) {
            const sp = spots[i];
            if (!sp.seen) continue;
            const rr = sp.round ? Math.max(sp.w, sp.h) : sp.radius;
            near += roundRectSub(sp.x - 6, sp.y - 6, sp.w + 12, sp.h + 12, sp.round ? rr : rr + 2);
            far += roundRectSub(sp.x - 20, sp.y - 20, sp.w + 40, sp.h + 40, sp.round ? rr : rr + 16);
          }
        }
        dimNear.setAttribute('d', near);
        dimFar.setAttribute('d', far);
      }
    },

    destroy() {
      overlay.remove();
    },
  };
}
