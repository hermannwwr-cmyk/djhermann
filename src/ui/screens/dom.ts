/** Tiny DOM helpers shared by the menu screens. Nothing here knows about the game. */

export type Child = Node | string | number | null | undefined | false;

/** Create an element with a class name and children. Strings become text nodes (never HTML). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  add(e, ...children);
  return e;
}

export function add(parent: Element, ...children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export function attrs<T extends Element>(e: T, map: Record<string, string | number | boolean | null | undefined>): T {
  for (const [k, v] of Object.entries(map)) {
    if (v === null || v === undefined || v === false) e.removeAttribute(k);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  return e;
}

/** An icon from lucide-static (an SVG string we ship, so innerHTML is safe here). */
export function icon(svg: string, className = ''): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = className ? `ui-icon ${className}` : 'ui-icon';
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = svg;
  return s;
}

/** A block of our own inline SVG artwork. */
export function art(svg: string, className?: string): HTMLDivElement {
  const d = document.createElement('div');
  if (className) d.className = className;
  d.setAttribute('aria-hidden', 'true');
  d.innerHTML = svg;
  return d;
}

export interface ButtonOptions {
  label?: string;
  icon?: string;
  iconAfter?: string;
  className?: string;
  ariaLabel?: string;
  onTap?: (e: MouseEvent) => void;
}

/** A <button type="button">. Acts on click: menus are not timing-sensitive, and lists must scroll. */
export function button(opts: ButtonOptions): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  if (opts.className) b.className = opts.className;
  if (opts.icon) b.appendChild(icon(opts.icon));
  if (opts.label !== undefined) b.appendChild(h('span', null, opts.label));
  if (opts.iconAfter) b.appendChild(icon(opts.iconAfter));
  if (opts.ariaLabel) b.setAttribute('aria-label', opts.ariaLabel);
  if (opts.onTap) b.addEventListener('click', opts.onTap);
  return b;
}

export function clear(e: Element): void {
  e.replaceChildren();
}

/** Resolve after the next two animation frames (lets a freshly mounted element take its start styles). */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const prefersReducedMotion = (): boolean =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Press-and-hold repeat for a button (grid nudge): fires once on press, then repeats, speeding up.
 * `fn` receives how many times it has fired during this hold (1, 2, 3, ...).
 */
export function holdRepeat(el: HTMLElement, fn: (count: number) => void): () => void {
  let timer = 0;
  let count = 0;
  let active = false;

  const stop = (): void => {
    active = false;
    window.clearTimeout(timer);
  };
  const step = (): void => {
    if (!active) return;
    count++;
    fn(count);
    timer = window.setTimeout(step, count === 1 ? 380 : count < 10 ? 110 : 55);
  };
  const down = (e: PointerEvent): void => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events have no active pointer to capture */
    }
    stop();
    active = true;
    count = 0;
    step();
  };
  const key = (e: KeyboardEvent): void => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    if (!e.repeat) count = 0;
    count++;
    fn(count);
  };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointercancel', stop);
  el.addEventListener('lostpointercapture', stop);
  el.addEventListener('keydown', key);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  return () => {
    stop();
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointerup', stop);
    el.removeEventListener('pointercancel', stop);
    el.removeEventListener('lostpointercapture', stop);
    el.removeEventListener('keydown', key);
  };
}
