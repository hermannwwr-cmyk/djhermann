import type { Nav, Screen, ScreenId, ScreenParams } from './types';

export interface NavController extends Nav {
  /** Register a screen. The factory runs on the first visit. */
  register<K extends ScreenId>(id: K, factory: () => Screen<ScreenParams[K]>): void;
}

const LEAVE_MS = 260;

/**
 * Shows one full-screen view at a time inside `root`, with an enter/leave transition
 * (classes: .screen, .screen--enter, .screen--leave – styled in styles/base.css).
 * Wires the browser/device back button to back().
 */
export function createNav(root: HTMLElement): NavController {
  const factories = new Map<ScreenId, () => Screen<never>>();
  const screens = new Map<ScreenId, Screen<never>>();
  const history: { id: ScreenId; params: unknown }[] = [];
  let current: ScreenId | null = null;
  let currentScreen: Screen<never> | null = null;

  function show(id: ScreenId, params: unknown): void {
    const factory = factories.get(id);
    if (!factory) throw new Error(`[nav] unknown screen "${id}"`);

    const prev = currentScreen;
    if (prev) {
      try {
        prev.leave?.();
      } catch (err) {
        console.error('[nav] leave() threw', err);
      }
      const el = prev.el;
      el.classList.remove('screen--enter');
      el.classList.add('screen--leave');
      window.setTimeout(() => {
        if (currentScreen?.el !== el) el.remove();
        el.classList.remove('screen--leave');
      }, LEAVE_MS);
    }

    let screen = screens.get(id);
    if (!screen) {
      screen = factory();
      screens.set(id, screen);
    }
    current = id;
    currentScreen = screen;
    const el = screen.el;
    el.classList.add('screen');
    el.classList.remove('screen--leave');
    el.dataset.screen = id;
    root.appendChild(el);
    // restart the enter animation
    el.classList.remove('screen--enter');
    void el.offsetWidth;
    el.classList.add('screen--enter');

    try {
      const r = (screen.enter as ((p: unknown) => void | Promise<void>) | undefined)?.(params);
      if (r instanceof Promise) r.catch((err) => console.error(`[nav] enter("${id}") rejected`, err));
    } catch (err) {
      console.error(`[nav] enter("${id}") threw`, err);
    }
  }

  function back(): void {
    if (currentScreen?.back?.()) return;
    history.pop();
    const prev = history[history.length - 1];
    if (prev) show(prev.id, prev.params);
    else if (current !== 'home' && factories.has('home')) {
      history.push({ id: 'home', params: undefined });
      show('home', undefined);
    }
  }

  // Device back button: keep one history entry in front of us so "back" stays inside the app.
  if (typeof window !== 'undefined') {
    try {
      window.history.replaceState({ dj: 0 }, '');
      window.history.pushState({ dj: 1 }, '');
    } catch {
      /* history unavailable (sandboxed frame): back button just leaves the page */
    }
    window.addEventListener('popstate', () => {
      try {
        window.history.pushState({ dj: 1 }, '');
      } catch {
        /* ignore */
      }
      back();
    });
  }

  return {
    get current() {
      return current;
    },
    register(id, factory) {
      factories.set(id, factory as () => Screen<never>);
    },
    go(id: ScreenId, ...params: unknown[]) {
      const p = params[0];
      // screens you cannot go "back" into are replaced in the history
      const top = history[history.length - 1];
      if (top && (top.id === 'game' || top.id === 'results' || top.id === 'title' || top.id === id)) history.pop();
      history.push({ id, params: p });
      show(id, p);
    },
    back,
  };
}
