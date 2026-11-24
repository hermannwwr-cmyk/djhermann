/**
 * Builds the app: frame, engine, music, library, screens. Called once from src/main.ts.
 */
import '../styles/base.css';
import './game-screen.css';
import { createAudioEngine } from '../audio';
import { loadFonts } from '../core/fonts';
import { createNav } from '../core/nav';
import { createSettings } from '../core/settings';
import type { AppContext } from '../core/types';
import { createLibrary } from '../library';
import { createBuiltinMusic } from '../music';
import { createPartyStore } from '../net';
import { createAmbientBackground, registerScreens } from '../ui/screens';
import { createGameScreen } from './game-screen';
import { registerPartyScreens } from '../ui/party';

function div(className: string, parent: HTMLElement): HTMLDivElement {
  const d = document.createElement('div');
  d.className = className;
  parent.appendChild(d);
  return d;
}

export async function boot(): Promise<void> {
  const app = document.getElementById('app')!;
  app.replaceChildren();
  const frame = div('app-frame', app);
  const bg = div('app-bg', frame);
  const screens = div('app-screens', frame);
  div('app-overlays', frame);
  const rotate = div('app-rotate', frame);
  rotate.innerHTML =
    '<div><div class="app-rotate__title">Turn your phone upright</div><div class="ui-muted">DJ Hermann plays in portrait.</div></div>';

  await loadFonts();

  const settings = createSettings();
  const engine = createAudioEngine();
  const applySettings = (): void => {
    const s = settings.get();
    engine.setLatencyMs(s.latencyMs);
    engine.setMasterVolume(s.masterVolume);
  };
  applySettings();
  settings.subscribe(applySettings);

  const music = createBuiltinMusic();
  const library = createLibrary({ music, sampleRate: engine.sampleRate });
  const nav = createNav(screens);
  const party = createPartyStore();
  const ctx: AppContext = { engine, library, settings, nav, party };

  registerScreens({ ...ctx, nav });
  registerPartyScreens({ ...ctx, nav });
  nav.register('game', () => createGameScreen(ctx));

  // the menus share one ambient backdrop; the game screen has its own stage
  const ambient = createAmbientBackground();
  bg.appendChild(ambient.el);
  nav.onChange((id) => {
    if (id === 'game' || id === 'controller') ambient.stop();
    else ambient.start();
  });

  // pads and UI sounds: rendered once in the background, registered when ready
  void music
    .renderSounds(engine.sampleRate)
    .then((sounds) => {
      for (const [name, pcm] of Object.entries(sounds)) engine.registerSound(name, pcm);
    })
    .catch((err) => console.error('[boot] could not render sounds', err));

  // in the menus, stop audio while the tab is hidden (the game screen pauses itself)
  document.addEventListener('visibilitychange', () => {
    if (nav.current === 'game') return;
    if (document.hidden) void engine.suspend();
    else void engine.resume();
  });

  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    void import('virtual:pwa-register')
      .then(({ registerSW }) => registerSW({ immediate: true }))
      .catch((err) => console.warn('[boot] service worker not registered', err));
  }

  if (import.meta.env.DEV) {
    // handle for playtest scripts; never present in production builds
    (window as unknown as { __dj?: unknown }).__dj = { ...ctx, music };
  }

  nav.go('title');
}
