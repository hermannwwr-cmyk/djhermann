/**
 * The DJ console: an always-visible front strip (mini decks, crossfader, MIXER button) and a drawer
 * above it that shows one panel at a time (Deck A, Mixer, Deck B). Plus the waveform display.
 */
import './console.css';
import type { AudioEngine, Component, DeckId, FrameState, PanelId, SettingsStore } from '../../core/types';
import type { CtlEnv } from './controls';
import { createDeckPanel } from './deck-panel';
import type { Panel, PanelEnv } from './deck-panel';
import { createFrontStrip } from './front';
import { h } from './gestures';
import { createMixerPanel } from './mixer-panel';

export { createWaveforms } from './waveforms';

export interface ConsoleComponent extends Component {
  /** which drawer panel is open */
  readonly panel: PanelId | null;
  /** null closes the drawer */
  openPanel(id: PanelId | null): void;
  onPanelChange(fn: (id: PanelId | null) => void): () => void;
  /** free play: show a LOAD button on each deck */
  setLoadEnabled(on: boolean): void;
}

export interface ConsoleDeps {
  engine: AudioEngine;
  settings: SettingsStore;
  onLoadRequest?: (deck: DeckId) => void;
}

/** Drawer open/close time; keep in step with --dk-t-drawer in console.css. */
const DRAWER_MS = 220;
const PANEL_IDS: readonly PanelId[] = ['deckA', 'mixer', 'deckB'];

export function createConsole(deps: ConsoleDeps): ConsoleComponent {
  const { engine, settings } = deps;

  const env: PanelEnv & CtlEnv = {
    engine,
    lowFx: () => settings.get().lowFx,
    haptic(ms) {
      if (!settings.get().haptics) return;
      try {
        navigator.vibrate?.(ms);
      } catch {
        /* not allowed here */
      }
    },
    onLoadRequest: (deck) => deps.onLoadRequest?.(deck),
  };

  const panels: Record<PanelId, Panel> = {
    deckA: createDeckPanel(env, 'A'),
    mixer: createMixerPanel(env),
    deckB: createDeckPanel(env, 'B'),
  };
  for (const id of PANEL_IDS) panels[id].el.hidden = true;

  const front = createFrontStrip({ ...env, setXfader: (v) => engine.setCrossfader(v) }, (id) => {
    api.openPanel(current === id ? null : id);
  });

  const stage = h('div', 'dk-drawer-stage', null, ...PANEL_IDS.map((id) => panels[id].el));
  const drawer = h('div', 'dk-drawer', null, stage);
  const el = h('div', 'dk-console', { 'data-panel-open': 'none' }, drawer, front.el);

  let current: PanelId | null = null;
  /** panels drawn this frame: the open one, plus the one leaving while the drawer animates */
  const shown = new Set<PanelId>();
  const hideTimers = new Map<PanelId, number>();
  const subs = new Set<(id: PanelId | null) => void>();

  const show = (id: PanelId): void => {
    const t = hideTimers.get(id);
    if (t !== undefined) {
      clearTimeout(t);
      hideTimers.delete(id);
    }
    const p = panels[id].el;
    p.hidden = false;
    p.classList.remove('dk-leaving');
    shown.add(id);
  };
  const hideLater = (id: PanelId): void => {
    if (!shown.has(id) || hideTimers.has(id)) return;
    panels[id].el.classList.add('dk-leaving');
    hideTimers.set(
      id,
      window.setTimeout(() => {
        hideTimers.delete(id);
        if (current === id) return;
        panels[id].el.hidden = true;
        panels[id].el.classList.remove('dk-leaving');
        shown.delete(id);
      }, DRAWER_MS + 40),
    );
  };

  const api: ConsoleComponent = {
    el,
    get panel() {
      return current;
    },
    openPanel(id) {
      if (id === current) return;
      const prev = current;
      current = id;
      if (id) show(id);
      if (prev) hideLater(prev);
      el.dataset.panelOpen = id ?? 'none';
      el.classList.toggle('dk-open', id !== null);
      front.setActive(id);
      for (const fn of [...subs]) {
        try {
          fn(id);
        } catch (err) {
          console.error('[console] panel listener threw', err);
        }
      }
    },
    onPanelChange(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
    setLoadEnabled(on) {
      el.classList.toggle('dk-loadable', on);
    },
    update(frame: FrameState) {
      const lowFx = settings.get().lowFx;
      front.update(frame, lowFx);
      for (const id of shown) panels[id].update(frame);
    },
    destroy() {
      for (const t of hideTimers.values()) clearTimeout(t);
      hideTimers.clear();
      subs.clear();
      front.destroy();
      for (const id of PANEL_IDS) panels[id].destroy();
      el.remove();
    },
  };
  front.setActive(null);
  return api;
}
