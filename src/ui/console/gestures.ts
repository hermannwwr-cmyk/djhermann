/**
 * Pointer handling shared by every console control: one captured pointer per control (so two thumbs
 * can work two controls at once), relative deltas, tap / double-tap detection.
 */
export interface DragHandlers {
  /** pointer went down on the control. Return false to ignore this pointer. */
  start?(e: PointerEvent): boolean | void;
  /** captured pointer moved. dx / dy = movement since the previous event, in CSS px. */
  move?(e: PointerEvent, dx: number, dy: number): void;
  /** pointer released or cancelled */
  end?(e: PointerEvent, cancelled: boolean): void;
  /** two quick taps without a drag */
  doubleTap?(e: PointerEvent): void;
}

const TAP_SLOP_PX = 8;
const TAP_MS = 320;
const DOUBLE_TAP_MS = 380;

export function bindDrag(el: HTMLElement, h: DragHandlers): () => void {
  let active = -1;
  let lastX = 0;
  let lastY = 0;
  let travel = 0;
  let downAt = 0;
  let lastTapAt = -1e9;
  let lastTapX = 0;
  let lastTapY = 0;

  const down = (e: PointerEvent): void => {
    if (active !== -1) return; // a second finger on the same control is ignored
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (h.start && h.start(e) === false) return;
    active = e.pointerId;
    lastX = e.clientX;
    lastY = e.clientY;
    travel = 0;
    downAt = e.timeStamp;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer is already gone (synthetic events): moves still arrive while it stays over el */
    }
    e.preventDefault();
  };

  const move = (e: PointerEvent): void => {
    if (e.pointerId !== active) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    if (dx === 0 && dy === 0) return;
    lastX = e.clientX;
    lastY = e.clientY;
    travel += Math.abs(dx) + Math.abs(dy);
    h.move?.(e, dx, dy);
  };

  const finish = (e: PointerEvent, cancelled: boolean): void => {
    if (e.pointerId !== active) return;
    active = -1;
    try {
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    h.end?.(e, cancelled);
    if (cancelled || !h.doubleTap) return;
    const isTap = travel <= TAP_SLOP_PX && e.timeStamp - downAt <= TAP_MS;
    if (!isTap) {
      lastTapAt = -1e9;
      return;
    }
    const near = Math.abs(e.clientX - lastTapX) + Math.abs(e.clientY - lastTapY) < 44;
    if (e.timeStamp - lastTapAt <= DOUBLE_TAP_MS && near) {
      lastTapAt = -1e9;
      h.doubleTap(e);
    } else {
      lastTapAt = e.timeStamp;
      lastTapX = e.clientX;
      lastTapY = e.clientY;
    }
  };

  const up = (e: PointerEvent): void => finish(e, false);
  const cancel = (e: PointerEvent): void => finish(e, true);
  const lost = (e: PointerEvent): void => finish(e, true);
  const noMenu = (e: Event): void => e.preventDefault();

  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('lostpointercapture', lost);
  el.addEventListener('contextmenu', noMenu);

  return () => {
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', cancel);
    el.removeEventListener('lostpointercapture', lost);
    el.removeEventListener('contextmenu', noMenu);
  };
}

/** Small DOM builder: h('div', 'dk-x', { 'data-control': 'A.play' }, child, 'text'). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  attrs: Record<string, string> | null = null,
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k]);
  for (const c of children) el.append(c);
  return el;
}

/** Element from an HTML/SVG string (for icons and static SVG). */
export function html(markup: string): HTMLElement {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstElementChild as HTMLElement;
}
