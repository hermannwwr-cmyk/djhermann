/**
 * The pause menu: a modal over the game with RESUME, RESTART and QUIT, plus the guide and haptics
 * switches. It animates with CSS only, because the frame loop is stopped while the game is paused.
 */
import { LogOut, MousePointerClick, Play, RotateCcw, Vibrate } from 'lucide-static';
import type { Settings, SettingsStore } from '../../core/types';
import { canVibrate, el, iconEl, play } from './dom';

export type PauseChoice = 'resume' | 'restart' | 'quit';

export interface PauseDeps {
  settings: SettingsStore;
  /** RESTART and QUIT throw the gig away, so they ask for a second tap. Pass false to skip that. */
  confirm?: boolean;
}

export interface PauseMenu {
  readonly el: HTMLElement;
  /** Show the menu. Resolves with the player's choice (the menu closes itself). */
  open(): Promise<PauseChoice>;
  /** Hide the menu. A pending open() resolves with 'resume'. */
  close(): void;
}

const CONFIRM_MS = 3200;
const ARMED_TEXT: Record<'restart' | 'quit', string> = { restart: 'SURE? TAP AGAIN', quit: 'SURE? TAP AGAIN' };
const IDLE_TEXT: Record<'restart' | 'quit', string> = { restart: 'RESTART', quit: 'QUIT' };

export function createPauseMenu(deps: PauseDeps): PauseMenu {
  const { settings } = deps;
  const needConfirm = deps.confirm !== false;

  const root = el('div', 'hud-pause');
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Paused');
  const scrim = el('div', 'hud-pause__scrim');
  const card = el('div', 'hud-pause__card');
  const eyebrow = el('div', 'hud-pause__eyebrow', 'THE MUSIC IS WAITING');
  const title = el('h2', 'hud-pause__title', 'PAUSED');

  function button(action: PauseChoice, label: string, svg: string, cls: string): { btn: HTMLButtonElement; text: HTMLSpanElement } {
    const btn = el('button', `ui-btn ui-btn--block ${cls}`);
    btn.type = 'button';
    btn.dataset.action = action;
    const text = el('span', '', label);
    btn.append(iconEl(svg), text);
    return { btn, text };
  }
  const resume = button('resume', 'RESUME', Play, 'ui-btn--primary ui-btn--lg');
  const restart = button('restart', IDLE_TEXT.restart, RotateCcw, 'hud-pause__alt');
  const quit = button('quit', IDLE_TEXT.quit, LogOut, 'hud-pause__alt hud-pause__quit');
  const row = el('div', 'hud-pause__row');
  row.append(restart.btn, quit.btn);

  function toggle(key: 'guide' | 'haptics', name: string, about: string, svg: string): HTMLButtonElement {
    const btn = el('button', 'hud-toggle');
    btn.type = 'button';
    btn.dataset.setting = key;
    btn.setAttribute('role', 'switch');
    const text = el('span', 'hud-toggle__text');
    text.append(el('span', 'hud-toggle__name', name), el('span', 'hud-toggle__about', about));
    const sw = el('span', 'hud-toggle__switch');
    sw.appendChild(el('i'));
    btn.append(iconEl(svg), text, sw);
    btn.addEventListener('click', () => {
      const next = !settings.get()[key];
      settings.set({ [key]: next } as Partial<Settings>);
      if (key === 'haptics' && next && canVibrate()) {
        try {
          navigator.vibrate(30);
        } catch {
          /* not allowed: fine */
        }
      }
    });
    return btn;
  }
  const guideToggle = toggle('guide', 'GUIDE', 'Show which control to use', MousePointerClick);
  const hapticsToggle = toggle('haptics', 'HAPTICS', 'Vibrate on hits', Vibrate);
  const toggles = el('div', 'hud-pause__toggles');
  toggles.append(guideToggle, hapticsToggle);

  card.append(eyebrow, title, resume.btn, row, toggles);
  root.append(scrim, card);

  function syncToggles(s: Settings): void {
    guideToggle.setAttribute('aria-checked', String(s.guide));
    hapticsToggle.setAttribute('aria-checked', String(s.haptics));
  }
  syncToggles(settings.get());
  /** subscribed only while the menu is open, so a finished session leaves nothing behind */
  let unsubscribe: (() => void) | null = null;

  let pending: ((choice: PauseChoice) => void) | null = null;
  let promise: Promise<PauseChoice> | null = null;
  let armed: 'restart' | 'quit' | null = null;
  let armTimer = 0;

  function disarm(): void {
    if (!armed) return;
    window.clearTimeout(armTimer);
    const b = armed === 'restart' ? restart : quit;
    b.text.textContent = IDLE_TEXT[armed];
    delete b.btn.dataset.armed;
    armed = null;
  }

  function hide(): void {
    disarm();
    root.hidden = true;
    delete root.dataset.open;
    document.removeEventListener('keydown', onKey);
    unsubscribe?.();
    unsubscribe = null;
  }

  function choose(choice: PauseChoice): void {
    const done = pending;
    pending = null;
    promise = null;
    if (!done) return;
    void play(card, [{ transform: 'none', opacity: 1 }, { transform: 'scale(0.96)', opacity: 0 }], {
      duration: 130,
      easing: 'ease-in',
    }).then(() => {
      // open() may have been called again while the card was leaving
      if (!pending) hide();
      done(choice);
    });
  }

  function onAction(action: PauseChoice): void {
    if (!pending) return;
    if (action === 'resume' || !needConfirm) {
      choose(action);
      return;
    }
    if (armed === action) {
      choose(action);
      return;
    }
    disarm();
    armed = action;
    const b = action === 'restart' ? restart : quit;
    b.text.textContent = ARMED_TEXT[action];
    b.btn.dataset.armed = '1';
    armTimer = window.setTimeout(disarm, CONFIRM_MS);
  }

  for (const b of [resume, restart, quit]) {
    b.btn.addEventListener('click', () => onAction(b.btn.dataset.action as PauseChoice));
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      onAction('resume');
    }
  }

  return {
    el: root,

    open() {
      if (promise) return promise;
      promise = new Promise<PauseChoice>((resolve) => {
        pending = resolve;
      });
      syncToggles(settings.get());
      unsubscribe ??= settings.subscribe(syncToggles);
      root.hidden = false;
      // restart the CSS entrance
      delete root.dataset.open;
      void root.offsetWidth;
      root.dataset.open = '1';
      document.addEventListener('keydown', onKey);
      resume.btn.focus({ preventScroll: true });
      return promise;
    },

    close() {
      const done = pending;
      pending = null;
      promise = null;
      hide();
      done?.('resume');
    },
  };
}
