/** Small DOM helpers shared by the HUD pieces. */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** An inline SVG icon (a trusted, static SVG string such as a lucide icon) in a sized span. */
export function iconEl(svg: string, className = ''): HTMLSpanElement {
  const s = el('span', className ? `hud-ico ${className}` : 'hud-ico');
  s.innerHTML = svg;
  s.setAttribute('aria-hidden', 'true');
  return s;
}

export const reducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run a one-shot Web Animation and resolve when it has finished (or was cancelled). Where the Web
 * Animations API is missing the promise resolves after the same time, so sequences keep their pace.
 */
export function play(target: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions): Promise<void> {
  const total = Number(options.duration ?? 0) + Number(options.delay ?? 0);
  if (typeof target.animate !== 'function') return sleep(total);
  try {
    const anim = target.animate(keyframes, options);
    return anim.finished.then(
      () => undefined,
      () => undefined,
    );
  } catch {
    return sleep(total);
  }
}

export { sleep };
