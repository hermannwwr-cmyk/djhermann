/**
 * Boots a dev harness page: fonts + base styles, a phone-shaped frame, a mock engine with two
 * tracks loaded (deck A playing, deck B cued), the game bus and a running frame loop.
 *
 *   const h = await bootHarness();
 *   const thing = createThing({ engine: h.engine, bus: h.bus });
 *   h.mount(thing.el);            // or h.root.appendChild(...)
 *   h.loop.add((f) => thing.update(f));
 *
 * Everything is also exposed on window.__h for poking from Playwright.
 */
import '../styles/base.css';
import { createGameBus } from '../core/events';
import type { GameBus } from '../core/events';
import { loadFonts } from '../core/fonts';
import { createFrameLoop } from '../core/frame';
import type { FrameLoop } from '../core/frame';
import type { HudState, LoadedTrack } from '../core/types';
import { createMockEngine } from './mock-engine';
import type { MockEngine } from './mock-engine';
import { MOCK_CATALOG, mockHud, mockTrack } from './mocks';

export interface Harness {
  /** the phone-shaped frame (position: relative; fills the viewport up to 520px wide) */
  root: HTMLElement;
  engine: MockEngine;
  bus: GameBus;
  loop: FrameLoop;
  tracks: { A: LoadedTrack; B: LoadedTrack };
  /** mutable HUD state the loop serves to components */
  hud: HudState;
  /** append an element to the frame, optionally into a box with a fixed height in px */
  mount(el: HTMLElement, heightPx?: number): HTMLElement;
}

export interface HarnessOptions {
  /** start deck A playing (default true) */
  autoplay?: boolean;
  /** start position of deck A in beats (default 0) */
  startBeat?: number;
}

export async function bootHarness(opts: HarnessOptions = {}): Promise<Harness> {
  await loadFonts();
  const app = document.getElementById('app') ?? document.body.appendChild(document.createElement('div'));
  app.id = 'app';
  const root = document.createElement('div');
  root.className = 'app-frame';
  root.style.display = 'flex';
  root.style.flexDirection = 'column';
  app.appendChild(root);

  const engine = createMockEngine();
  const bus = createGameBus();
  const hud = mockHud();
  const loop = createFrameLoop(engine, () => hud);
  const tracks = { A: mockTrack(MOCK_CATALOG[0]), B: mockTrack(MOCK_CATALOG[1]) };

  await engine.unlock();
  await engine.loadTrack('A', tracks.A);
  await engine.loadTrack('B', tracks.B);
  engine.setCrossfader(-1);
  if (opts.startBeat) {
    engine.seek('A', tracks.A.meta.grid.firstBeatSec + (opts.startBeat * 60) / tracks.A.meta.grid.bpm);
  }
  if (opts.autoplay !== false) engine.play('A');
  loop.start();

  const harness: Harness = {
    root,
    engine,
    bus,
    loop,
    tracks,
    hud,
    mount(el, heightPx) {
      if (heightPx === undefined) {
        root.appendChild(el);
        return el;
      }
      const box = document.createElement('div');
      box.style.cssText = `position:relative;flex:none;height:${heightPx}px;width:100%`;
      box.appendChild(el);
      root.appendChild(box);
      return box;
    },
  };
  (window as unknown as { __h: Harness }).__h = harness;
  return harness;
}
