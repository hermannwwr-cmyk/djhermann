/**
 * The building blocks the menu screens share: top bar, track rows and covers, switch, slider,
 * bottom sheet, confirm dialog and toast.
 */
import { ChevronLeft, X } from 'lucide-static';
import { clamp01, formatTime } from '../../core/math';
import type { TrackMeta } from '../../core/types';
import { trackArtCanvas } from '../../theme/art';
import { add, attrs, button, h, icon, nextFrame, wait } from './dom';
import type { Child } from './dom';
import { formatBpm } from './logic';

// ───────────────────────────── top bar ─────────────────────────────

export function topBar(title: string, onBack: () => void, right?: HTMLElement | null, backIcon: string = ChevronLeft): HTMLElement {
  const back = button({ className: 'ui-iconbtn', icon: backIcon, ariaLabel: 'Back', onTap: onBack });
  back.dataset.act = 'back';
  return h('header', 'sc-top', back, h('h1', 'sc-top__title', title), right ?? h('span', 'sc-top__spacer'));
}

// ───────────────────────────── tracks ─────────────────────────────

const coverCache = new Map<string, HTMLCanvasElement>();

/** A track's cover art at a CSS size (rendered once per track and size, then copied). */
export function cover(meta: TrackMeta, sizePx: number, className = 'sc-cover'): HTMLCanvasElement {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const px = Math.round(sizePx * dpr);
  const key = `${meta.art.hueA}|${meta.art.hueB}|${meta.art.seed}|${px}`;
  let src = coverCache.get(key);
  if (!src) {
    src = trackArtCanvas(meta.art, px, { radius: 0.2 });
    coverCache.set(key, src);
  }
  const c = document.createElement('canvas');
  c.width = c.height = px;
  c.getContext('2d')!.drawImage(src, 0, 0);
  c.className = className;
  c.style.width = c.style.height = `${sizePx}px`;
  c.setAttribute('aria-hidden', 'true');
  return c;
}

export interface TrackRowOptions {
  /** element shown at the far right (selection badge, chevron, ...) */
  trailing?: Child;
  /** extra line under the row (actions) */
  below?: Child;
  /** small tag after the title ("NEW") */
  tag?: string;
  coverSize?: number;
  /** render as a <button> (the whole row is tappable) */
  onTap?: () => void;
}

/** One track in a list: cover, title, artist, and BPM + key on the right. */
export function trackRow(meta: TrackMeta, opts: TrackRowOptions = {}): HTMLElement {
  const title = h('span', 'sc-track__title', meta.title);
  const titleLine = h('span', 'sc-track__titleline', title, opts.tag ? h('span', 'sc-tag', opts.tag) : null);
  const sub = h('span', 'sc-track__sub', `${meta.artist} · ${formatTime(meta.durationSec)}`);
  const bpm = h(
    'span',
    'sc-track__tempo',
    h('span', 'sc-track__bpm ui-num', formatBpm(meta.grid.bpm)),
    h('span', 'sc-track__unit', 'BPM'),
    h('span', 'sc-track__key', meta.key ?? 'Key unknown'),
  );
  const main = h(
    opts.onTap ? 'button' : 'div',
    'sc-track__main',
    cover(meta, opts.coverSize ?? 52),
    h('span', 'sc-track__text', titleLine, sub),
    bpm,
    opts.trailing ?? null,
  );
  if (opts.onTap) {
    (main as HTMLButtonElement).type = 'button';
    main.addEventListener('click', opts.onTap);
  }
  const row = h('div', 'sc-track', main, opts.below ?? null);
  row.dataset.track = meta.id;
  return row;
}

// ───────────────────────────── switch + slider ─────────────────────────────

export interface Toggle {
  el: HTMLButtonElement;
  set(on: boolean): void;
}

export function toggle(ariaLabel: string, on: boolean, onChange: (on: boolean) => void): Toggle {
  const el = h('button', 'sc-switch', h('span', 'sc-switch__knob'));
  el.type = 'button';
  attrs(el, { role: 'switch', 'aria-label': ariaLabel, 'aria-checked': String(on) });
  let state = on;
  const set = (v: boolean): void => {
    state = v;
    el.setAttribute('aria-checked', String(v));
  };
  el.addEventListener('click', () => {
    set(!state);
    onChange(state);
  });
  return { el, set };
}

export interface Slider {
  el: HTMLElement;
  set(value: number): void;
}

/** A 0..1 slider with a metal cap. Drag anywhere on it; arrow keys work too. */
export function slider(ariaLabel: string, value: number, onInput: (value: number) => void): Slider {
  const fill = h('span', 'sc-slider__fill');
  const cap = h('span', 'sc-slider__cap');
  const track = h('span', 'sc-slider__track', fill);
  const el = h('div', 'sc-slider ui-touch', track, cap);
  attrs(el, { role: 'slider', tabindex: 0, 'aria-label': ariaLabel, 'aria-valuemin': 0, 'aria-valuemax': 100 });
  let v = clamp01(value);

  const paint = (): void => {
    el.style.setProperty('--v', String(v));
    el.setAttribute('aria-valuenow', String(Math.round(v * 100)));
  };
  const fromEvent = (e: PointerEvent): void => {
    const r = el.getBoundingClientRect();
    const pad = 14; // half the cap: the cap stays inside the track
    v = clamp01((e.clientX - r.left - pad) / Math.max(1, r.width - pad * 2));
    paint();
    onInput(v);
  };
  el.addEventListener('pointerdown', (e) => {
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic event */
    }
    el.classList.add('sc-slider--held');
    fromEvent(e);
  });
  el.addEventListener('pointermove', (e) => {
    if (el.classList.contains('sc-slider--held')) fromEvent(e);
  });
  const release = (): void => el.classList.remove('sc-slider--held');
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
  el.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 0.05 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -0.05 : 0;
    if (!step) return;
    e.preventDefault();
    v = clamp01(v + step);
    paint();
    onInput(v);
  });
  paint();
  return {
    el,
    set(value) {
      v = clamp01(value);
      paint();
    },
  };
}

// ───────────────────────────── layers: sheet, dialog, toast ─────────────────────────────

interface OpenLayer {
  el: HTMLElement;
  dismiss(): void;
}

const layers: OpenLayer[] = [];

/** Close the top-most sheet or dialog inside `root`. Returns true when there was one (for Screen.back). */
export function dismissTopLayer(root: HTMLElement): boolean {
  for (let i = layers.length - 1; i >= 0; i--) {
    if (root.contains(layers[i].el)) {
      layers[i].dismiss();
      return true;
    }
  }
  return false;
}

export interface Sheet {
  el: HTMLElement;
  /** the scrolling content area */
  body: HTMLElement;
  /** fixed area under the content (buttons) */
  foot: HTMLElement;
  setTitle(title: string): void;
  close(): Promise<void>;
  /** resolves when the sheet has gone, however it was closed */
  closed: Promise<void>;
}

export interface SheetOptions {
  title: string;
  className?: string;
  /** called when the player dismisses the sheet (X, backdrop, back button). Return false to keep it open. */
  onDismiss?: () => boolean | void;
  /** fill the screen instead of hugging the content */
  tall?: boolean;
}

/** A bottom sheet over `host` (which must be positioned). */
export function openSheet(host: HTMLElement, opts: SheetOptions): Sheet {
  const title = h('h2', 'sc-sheet__title', opts.title);
  const body = h('div', 'sc-sheet__body ui-scroll');
  const foot = h('div', 'sc-sheet__foot');
  const closeBtn = button({ className: 'ui-iconbtn', icon: X, ariaLabel: 'Close' });
  closeBtn.dataset.act = 'close';
  const panel = h('div', `sc-sheet${opts.tall ? ' sc-sheet--tall' : ''}${opts.className ? ` ${opts.className}` : ''}`);
  attrs(panel, { role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title });
  add(panel, h('span', 'sc-sheet__grab'), h('div', 'sc-sheet__head', title, closeBtn), body, foot);
  const scrim = h('div', 'sc-layer__scrim');
  const el = h('div', 'sc-layer sc-layer--sheet', scrim, panel);
  host.appendChild(el);

  let closing = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));
  const entry: OpenLayer = { el, dismiss };
  layers.push(entry);

  async function close(): Promise<void> {
    if (closing) return closed;
    closing = true;
    const i = layers.indexOf(entry);
    if (i >= 0) layers.splice(i, 1);
    el.classList.remove('sc-layer--open');
    await wait(260);
    el.remove();
    resolveClosed();
  }
  function dismiss(): void {
    if (opts.onDismiss?.() === false) return;
    void close();
  }
  closeBtn.addEventListener('click', dismiss);
  scrim.addEventListener('click', dismiss);
  void nextFrame().then(() => {
    if (!closing) el.classList.add('sc-layer--open');
  });

  return {
    el,
    body,
    foot,
    setTitle(t) {
      title.textContent = t;
      panel.setAttribute('aria-label', t);
    },
    close,
    closed,
  };
}

export interface ConfirmOptions {
  title: string;
  body: string;
  confirm: string;
  cancel?: string;
  /** style the confirm button as destructive */
  danger?: boolean;
}

/** A small modal question. Resolves true when confirmed. */
export function confirmDialog(host: HTMLElement, opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const yes = button({ className: `ui-btn ${opts.danger ? 'sc-btn--danger' : 'ui-btn--primary'}`, label: opts.confirm });
    yes.dataset.act = 'confirm';
    const no = button({ className: 'ui-btn ui-btn--ghost', label: opts.cancel ?? 'Cancel' });
    no.dataset.act = 'cancel';
    const card = h(
      'div',
      'sc-dialog',
      h('h2', 'sc-dialog__title', opts.title),
      h('p', 'sc-dialog__body', opts.body),
      h('div', 'sc-dialog__actions', no, yes),
    );
    attrs(card, { role: 'alertdialog', 'aria-modal': 'true', 'aria-label': opts.title });
    const scrim = h('div', 'sc-layer__scrim');
    const el = h('div', 'sc-layer sc-layer--dialog', scrim, card);
    host.appendChild(el);
    let done = false;
    const entry: OpenLayer = { el, dismiss: () => finish(false) };
    layers.push(entry);
    function finish(answer: boolean): void {
      if (done) return;
      done = true;
      const i = layers.indexOf(entry);
      if (i >= 0) layers.splice(i, 1);
      el.classList.remove('sc-layer--open');
      void wait(200).then(() => el.remove());
      resolve(answer);
    }
    yes.addEventListener('click', () => finish(true));
    no.addEventListener('click', () => finish(false));
    scrim.addEventListener('click', () => finish(false));
    void nextFrame().then(() => {
      if (!done) el.classList.add('sc-layer--open');
    });
  });
}

/** A short message that floats up from the bottom of `host` and leaves by itself. */
export function toast(host: HTMLElement, text: string, tone: 'info' | 'good' | 'bad' = 'info', ms = 2600): void {
  host.querySelector('.sc-toast')?.remove();
  const el = h('div', `sc-toast sc-toast--${tone}`, text);
  el.setAttribute('role', 'status');
  host.appendChild(el);
  void nextFrame().then(() => el.classList.add('sc-toast--in'));
  window.setTimeout(() => {
    el.classList.remove('sc-toast--in');
    window.setTimeout(() => el.remove(), 260);
  }, ms);
}
