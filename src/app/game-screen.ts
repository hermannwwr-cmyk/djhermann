/**
 * The game screen: builds one play session (gig, tutorial or free play) out of the modules and
 * runs it. This file is wiring only: every piece of behaviour lives in its module.
 */
import './game-screen.css';
import { deckPanel } from '../core/controls';
import { createGameBus } from '../core/events';
import { createFrameLoop } from '../core/frame';
import type { FrameLoop } from '../core/frame';
import type { AppContext, DeckId, GameParams, GigResults, Screen } from '../core/types';
import { createGig } from '../game/gig';
import { createHostLink } from '../net';
import type { HostLink } from '../core/party';
import { createRhythm } from '../game/rhythm';
import { createConsole, createWaveforms } from '../ui/console';
import { createCallouts, createGuide, createPauseMenu, createTopBar, showCard } from '../ui/hud';
import { createLoadingOverlay, openTrackPicker } from '../ui/screens';

interface Session {
  destroy(): void;
  pause(): void;
}

export function createGameScreen(ctx: AppContext): Screen<GameParams> {
  const el = document.createElement('div');
  let session: Session | null = null;

  return {
    el,
    enter(params) {
      session?.destroy();
      session = startSession(ctx, el, params);
    },
    leave() {
      session?.destroy();
      session = null;
    },
    back() {
      session?.pause();
      return true;
    },
  };
}

function div(className: string, parent: HTMLElement): HTMLDivElement {
  const d = document.createElement('div');
  d.className = className;
  parent.appendChild(d);
  return d;
}

function startSession(ctx: AppContext, host: HTMLElement, params: GameParams): Session {
  const { engine, library, settings, nav } = ctx;
  let dead = false;
  let paused = false;
  let finishing = false;
  const cleanup: (() => void)[] = [];

  // ── layout ──
  host.replaceChildren();
  const root = div('gs', host);
  const topSlot = div('gs-top', root);
  const wavesSlot = div('gs-waves', root);
  const playSlot = div('gs-play', root);
  const consoleSlot = div('gs-console', root);
  const guideLayer = div('gs-guide', root);
  const overlay = div('gs-overlay', root);

  // ── modules ──
  const bus = createGameBus();
  const rhythm = createRhythm({ engine, bus, settings });
  const gig = createGig({ engine, bus, library, rhythm, settings, params });
  const loop: FrameLoop = createFrameLoop(engine, () => gig.getHud());

  // party mode: this phone is the host; mirror the gig to the players' phones
  const room = params.party ? ctx.party.room : null;
  const hostLink: HostLink | null =
    room && room.role === 'host' ? createHostLink({ room, engine, bus, rhythm, getHud: () => gig.getHud() }) : null;
  if (hostLink) cleanup.push(loop.add((f) => hostLink.update(f)), () => hostLink.destroy());

  const loading = createLoadingOverlay();
  overlay.appendChild(loading.el);
  const pauseMenu = createPauseMenu({ settings });
  overlay.appendChild(pauseMenu.el);

  const consoleC = createConsole({
    engine,
    settings,
    onLoadRequest: (deck) => void pickTrack(deck),
  });
  consoleC.setLoadEnabled(params.mode === 'free');
  const waves = createWaveforms({ engine, onDeckTap: (deck) => consoleC.openPanel(deckPanel(deck)) });
  const topBar = createTopBar({ bus, settings, onPause: () => void pause() });
  const callouts = createCallouts({ bus, settings });
  const guide = createGuide({
    root,
    settings,
    openPanel: (id) => consoleC.openPanel(id),
    getPanel: () => consoleC.panel,
  });

  topSlot.appendChild(topBar.el);
  wavesSlot.appendChild(waves.el);
  playSlot.appendChild(rhythm.el);
  const calloutLayer = div('gs-callouts', playSlot);
  calloutLayer.appendChild(callouts.el);
  consoleSlot.appendChild(consoleC.el);

  // Between missions the pads need the room: close the drawer a moment after a mission ends,
  // unless another mission has started or the player is still using the console.
  let lastConsoleTouch = 0;
  const onConsoleTouch = (): void => {
    lastConsoleTouch = performance.now();
  };
  consoleC.el.addEventListener('pointerdown', onConsoleTouch, true);
  consoleC.el.addEventListener('pointermove', onConsoleTouch, true);
  let closeTimer = 0;
  const scheduleClose = (): void => {
    window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => {
      if (dead || params.mode === 'free') return;
      if (gig.getHud().mission) return;
      if (performance.now() - lastConsoleTouch < 1500) return scheduleClose();
      consoleC.openPanel(null);
    }, 1400);
  };
  cleanup.push(() => {
    window.clearTimeout(closeTimer);
    consoleC.el.removeEventListener('pointerdown', onConsoleTouch, true);
    consoleC.el.removeEventListener('pointermove', onConsoleTouch, true);
  });
  guideLayer.appendChild(guide.el);

  cleanup.push(
    loop.add((f) => rhythm.update(f), 'logic'),
    loop.add((f) => gig.update(f), 'logic'),
    loop.add((f) => {
      if (gig.ended) finish(gig.getResults());
    }, 'logic'),
    loop.add((f) => topBar.update(f)),
    loop.add((f) => waves.update(f)),
    loop.add((f) => consoleC.update(f)),
    loop.add((f) => callouts.update(f)),
    loop.add((f) => guide.update(f)),
  );

  // ── sound effects for game events ──
  cleanup.push(
    bus.on('mission:end', ({ result }) => {
      scheduleClose();
      if (result.rating === 'fail') engine.playSound('fail', { gain: 0.5 });
      else engine.playSound('success', { gain: result.rating === 'perfect' ? 0.65 : 0.45 });
    }),
    bus.on('callout', ({ kind }) => {
      if (kind === 'drop') engine.playSound('cheer', { gain: 0.3 });
    }),
    bus.on('gig:end', ({ results }) => finish(results)),
  );

  // ── pause / resume ──
  async function pause(): Promise<void> {
    if (dead || paused || finishing) return;
    paused = true;
    loop.stop();
    await engine.suspend();
    const choice = await pauseMenu.open();
    if (dead) return;
    paused = false;
    if (choice === 'resume') {
      await engine.resume();
      loop.start();
    } else if (choice === 'restart') {
      await engine.resume();
      nav.go('game', params);
    } else {
      await engine.resume();
      nav.go('home');
    }
  }

  const onVisibility = (): void => {
    if (document.hidden) void pause();
    else void requestWakeLock();
  };
  document.addEventListener('visibilitychange', onVisibility);
  cleanup.push(() => document.removeEventListener('visibilitychange', onVisibility));

  // ── keep the phone awake while playing ──
  let wakeLock: WakeLockSentinel | null = null;
  async function requestWakeLock(): Promise<void> {
    try {
      wakeLock = (await navigator.wakeLock?.request('screen')) ?? null;
    } catch {
      /* not supported or denied: the screen may dim, the game still works */
    }
  }
  void requestWakeLock();
  cleanup.push(() => void wakeLock?.release().catch(() => undefined));

  // ── free play: load a track onto a deck ──
  async function pickTrack(deck: DeckId): Promise<void> {
    if (dead || params.mode !== 'free') return;
    const id = await openTrackPicker(ctx, overlay, { title: `Load deck ${deck}` });
    if (!id || dead) return;
    loading.show('Loading track');
    try {
      await gig.loadTrack(deck, id, (p, stage) => loading.set(p, stage));
    } catch (err) {
      console.error('[game] could not load track', err);
    }
    await loading.hide();
  }

  // ── end of the gig ──
  function finish(results: GigResults): void {
    if (dead || finishing) return;
    finishing = true;
    hostLink?.finish(results);
    if (results.completed) engine.playSound('cheer', { gain: 0.6 });
    const done = params.tutorial
      ? { title: "YOU'RE READY", subtitle: 'Lesson complete', tone: 'good' as const }
      : results.completed
        ? { title: 'SET COMPLETE!', subtitle: 'The crowd wants more', tone: 'good' as const }
        : { title: 'THE CROWD LEFT', subtitle: 'Keep the music going next time', tone: 'bad' as const };
    void showCard(overlay, { ...done, ms: 1600 }).then(() => {
      if (!dead) nav.go('results', { results, params, ...(hostLink ? { board: hostLink.getBoard() } : {}) });
    });
  }

  if (import.meta.env.DEV) {
    // handle for playtest scripts; never present in production builds
    (window as unknown as { __session?: unknown }).__session = { gig, rhythm, loop, bus, console: consoleC, params };
  }

  // ── start ──
  void (async () => {
    loading.show(params.mode === 'free' ? 'Setting up the decks' : 'Getting the set ready');
    try {
      await engine.unlock();
      await gig.prepare((p, stage) => loading.set(p, stage));
      room?.setPhase('playing', params);
    } catch (err) {
      console.error('[game] could not start', err);
      if (!dead) nav.go('home');
      return;
    }
    if (dead) return;
    loop.start();
    await loading.hide();
  })();

  return {
    pause: () => void pause(),
    destroy() {
      if (dead) return;
      dead = true;
      loop.stop();
      pauseMenu.close();
      for (const fn of cleanup) fn();
      gig.destroy();
      rhythm.destroy();
      guide.destroy();
      callouts.destroy();
      topBar.destroy();
      waves.destroy();
      consoleC.destroy();
      // leave the engine clean for the menus and the next session
      for (const deck of ['A', 'B'] as DeckId[]) {
        engine.setEcho(deck, false);
        engine.setNudge(deck, 0);
        engine.eject(deck);
      }
      host.replaceChildren();
    },
  };
}
