/**
 * Dev harness for party mode (src/ui/party): the real party screens and menus on a mock engine, a
 * mock library and a pretend party (src/ui/party/mock.ts) with a simulated host and friends.
 * Open http://localhost:5192/dev/party.html
 *
 * Query parameters (all optional):
 *   s=home|party|lobby|controller|results|game   start screen (default party)
 *   role=host|player     lobby: whose lobby (default host)
 *   players=2            friends already in the room
 *   trickle=1            hosted room: friends keep arriving
 *   code=ABCD            party: as if opened from an invite link (?room=ABCD also works, from home)
 *   fail=not-found|full|network   every join fails like this (also: codes ZZZZ, FULL, NETW always fail)
 *   state=waiting|playing|paused|lost|reconnecting|results|ended   controller: which state to reach
 *   beat=64              controller: jump the host's music to this beat once it plays
 *   auto=1               controller: play the pads automatically (human-like timing)
 *   name=Robin           player name (default: a fun suggestion)
 *   reset=1              forget saved settings first
 *
 * Everything is on window.__pt for Playwright (ctx, nav, party, sim()).
 */
import '../styles/base.css';
import { loadFonts } from '../core/fonts';
import { createFrameLoop } from '../core/frame';
import { createGameBus } from '../core/events';
import { createNav } from '../core/nav';
import type { NavController } from '../core/nav';
import { createSettings } from '../core/settings';
import type { RoomErrorCode } from '../core/party';
import type { AppContext, Difficulty, GameParams, HudState, Lane, Screen } from '../core/types';
import { createRhythmDev } from '../game/rhythm';
import type { RhythmDev } from '../game/rhythm';
import { SHOWN, lowerBound } from '../game/rhythm/core';
import { createTopBar } from '../ui/hud';
import { createBoardChip } from '../ui/party/board';
import { createMockParty, fakeGigResults } from '../ui/party/mock';
import type { MockParty } from '../ui/party/mock';
import { registerPartyScreensWith } from '../ui/party/screens';
import { createAmbientBackground, registerScreens } from '../ui/screens';
import { createMockEngine } from './mock-engine';
import { createMockLibrary, mockHud } from './mocks';

const q = new URLSearchParams(location.search);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function div(className: string, parent: HTMLElement): HTMLDivElement {
  const d = document.createElement('div');
  d.className = className;
  parent.appendChild(d);
  return d;
}

/**
 * Stands in for the lead's host game screen: the host's notes on the simulated host engine, the
 * real top bar, the board chip where the lead will mount it, and buttons to end the gig.
 */
function createStubGame(ctx: AppContext & { nav: NavController }, party: MockParty): Screen<GameParams> {
  const el = document.createElement('div');
  el.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;background:var(--bg-1)';
  let stop: (() => void) | null = null;

  return {
    el,
    enter(params) {
      stop?.();
      el.replaceChildren();
      const sim = party.sim();
      if (!sim) return;
      sim.startGig(params);
      const engine = sim.hostEngine;
      const bus = createGameBus();
      const hud: HudState = mockHud({ mission: null, status: 'NEXT MIX IN 8 BARS', score: 0, combo: 0, multiplier: 1 });
      const dev = createRhythmDev({ engine, bus, settings: ctx.settings });
      const loop = createFrameLoop(engine, () => {
        const s = dev.controller.getStats();
        hud.score = s.points + 4200;
        hud.combo = s.combo;
        hud.multiplier = s.multiplier;
        return hud;
      });
      const top = div('', el);
      top.style.cssText = 'position:relative;flex:none;height:calc(104px + var(--safe-top))';
      const play = div('', el);
      play.style.cssText = 'position:relative;flex:1 1 0;min-height:0';
      const consoleStub = div('', el);
      consoleStub.style.cssText =
        'flex:none;height:72px;display:flex;gap:6px;align-items:center;justify-content:center;flex-wrap:wrap;background:var(--hw-plate);border-top:1px solid var(--line)';
      const topBar = createTopBar({ bus, settings: ctx.settings, onPause: () => undefined });
      top.appendChild(topBar.el);
      play.appendChild(dev.controller.el);
      // where the lead mounts the chip on the host: top-right corner of the playfield
      const chipBox = div('', play);
      chipBox.style.cssText = 'position:absolute;top:10px;right:8px;z-index:3;pointer-events:none';
      const chip = createBoardChip({ getBoard: () => sim.board(), myPid: ctx.party.room?.pid ?? '' });
      chipBox.appendChild(chip.el);
      dev.controller.setDensity(0.85);
      const offs = [
        loop.add((f) => dev.controller.update(f), 'logic'),
        loop.add((f) => {
          topBar.update(f);
          chip.update(f);
        }),
      ];
      const btn = (label: string, id: string, fn: () => void): void => {
        const b = document.createElement('button');
        b.className = 'ui-btn ui-btn--sm';
        b.id = id;
        b.textContent = label;
        b.addEventListener('click', fn);
        consoleStub.appendChild(b);
      };
      const end = (completed: boolean) => (): void => {
        sim.fastForward(60);
        const results = { ...fakeGigResults(completed), difficulty: params.difficulty };
        const board = sim.board();
        ctx.party.room?.cast({ k: 'results', results, board });
        ctx.party.room?.setPhase('results');
        ctx.nav.go('results', { results, params, board });
      };
      btn('finish', 'stub-finish', end(true));
      btn('crowd left', 'stub-left', end(false));
      btn('lobby', 'stub-lobby', () => ctx.nav.go('lobby'));
      loop.start();
      stop = () => {
        loop.stop();
        for (const off of offs) off();
        chip.destroy();
        topBar.destroy();
        dev.controller.destroy();
        stop = null;
      };
      (window as unknown as { __stub?: unknown }).__stub = { dev, loop, sim };
      if (q.get('auto') === '1') autoplay(dev, loop);
    },
    leave() {
      stop?.();
    },
  };
}

/** Pads pressed by a pretend player with human timing: mostly close, some early or late, a few misses. */
function autoplay(dev: RhythmDev, loop: { add: (fn: (f: import('../core/types').FrameState) => void, phase?: 'logic' | 'render') => () => void }): () => void {
  const planned = new Set<string>();
  const queue: { t: number; lane: Lane }[] = [];
  const releases: { t: number; lane: Lane }[] = [];
  let seed = 4242;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const gauss = (): number => Math.sqrt(-2 * Math.log(Math.max(1e-6, rand()))) * Math.cos(2 * Math.PI * rand());
  return loop.add((f) => {
    const deck = dev.core.shown;
    const notes = deck ? dev.core.decks[deck] : null;
    const snap = deck ? f.decks[deck] : null;
    if (deck && notes && snap && snap.track && snap.rate > 0.2 && f.liveDeck === deck) {
      const beatsPerMs = (snap.track.grid.bpm * snap.rate) / 60000;
      for (let i = lowerBound(notes.beat, notes.count, snap.beat - 0.2); i < notes.count; i++) {
        const b = notes.beat[i];
        if (b > snap.beat + 0.6) break;
        if (notes.state[i] !== SHOWN) continue;
        const key = `${deck}:${notes.chart.difficulty}:${i}`;
        if (planned.has(key)) continue;
        planned.add(key);
        if (rand() < 0.05) continue;
        const err = rand() < 0.12 ? (rand() < 0.5 ? -1 : 1) * (60 + rand() * 40) : gauss() * 30;
        queue.push({ t: f.now + (b - snap.beat) / beatsPerMs + err, lane: notes.lane[i] as Lane });
      }
    }
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].t <= f.now + 8) {
        const { t, lane } = queue[i];
        queue.splice(i, 1);
        dev.press(lane, t);
        releases.push({ t: f.now + 80, lane });
      }
    }
    for (let i = releases.length - 1; i >= 0; i--) {
      if (releases[i].t <= f.now) {
        dev.release(releases[i].lane);
        releases.splice(i, 1);
      }
    }
  }, 'logic');
}

async function main(): Promise<void> {
  if (q.get('reset')) localStorage.removeItem('djhermann.settings.v1');
  await loadFonts();

  const app = document.getElementById('app')!;
  const frame = div('app-frame', app);
  const bg = div('app-bg', frame);
  const screens = div('app-screens', frame);
  div('app-overlays', frame);

  const settings = createSettings();
  settings.set({ haptics: false });
  if (q.get('name')) settings.set({ playerName: q.get('name')! });
  if (q.get('diff')) settings.set({ difficulty: q.get('diff') as Difficulty });
  const engine = createMockEngine({ latencyMs: 20 });
  const library = createMockLibrary(300);
  const fail = q.get('fail') as RoomErrorCode | null;
  const party = createMockParty({
    local: engine,
    delayMs: Number(q.get('delay') ?? 600),
    failAll: fail,
    friends: Number(q.get('players') ?? (q.get('s') === 'lobby' && q.get('role') !== 'player' ? 0 : 2)),
    trickle: q.get('trickle') === '1',
  });

  const nav = createNav(screens);
  const ctx: AppContext & { nav: NavController } = { engine, library, settings, nav, party: party.store };
  registerScreens(ctx);
  registerPartyScreensWith(ctx, party.net);
  nav.register('game', () => createStubGame(ctx, party));

  const ambient = createAmbientBackground();
  bg.appendChild(ambient.el);
  nav.onChange((id) => {
    if (id === 'game' || id === 'controller') ambient.stop();
    else ambient.start();
  });

  const handle = { ctx, nav, party, sim: () => party.sim(), settings, engine };
  (window as unknown as { __pt: typeof handle }).__pt = handle;

  await engine.unlock();
  const me = (): { name: string; difficulty: Difficulty } => ({
    name: settings.get().playerName || 'Robin',
    difficulty: settings.get().difficulty,
  });
  const start = q.get('s') ?? 'party';
  const state = q.get('state') ?? 'playing';
  const beat = Number(q.get('beat') ?? 0);

  switch (start) {
    case 'home':
      nav.go('home');
      break;
    case 'party':
      nav.go('home');
      nav.go('party', q.get('code') ? { code: q.get('code')! } : {});
      break;
    case 'lobby': {
      nav.go('home');
      if (q.get('role') === 'player') await party.store.join('WXYZ', me());
      else await party.store.host(me());
      nav.go('lobby');
      break;
    }
    case 'game': {
      nav.go('home');
      await party.store.host(me());
      for (let i = Number(q.get('players') ?? 3); i > 0; i--) party.sim()?.addFriend();
      nav.go('lobby');
      const params: GameParams = { mode: 'gig', setlist: ['mock-golden', 'mock-lanterns', 'mock-coast'], difficulty: 'club', party: true };
      nav.go('game', params);
      party.sim()?.fastForward(20);
      break;
    }
    case 'results': {
      nav.go('home');
      await party.store.host(me());
      for (let i = Number(q.get('players') ?? 4); i > 0; i--) party.sim()?.addFriend();
      party.sim()?.fastForward(90);
      const params: GameParams = { mode: 'gig', setlist: ['mock-golden', 'mock-lanterns', 'mock-coast'], difficulty: 'club', party: true };
      nav.go('lobby');
      nav.go('results', { results: fakeGigResults(q.get('case') !== 'left'), params, board: party.sim()!.board() });
      break;
    }
    case 'controller': {
      nav.go('home');
      await party.store.join('WXYZ', me());
      const sim = party.sim()!;
      nav.go('lobby');
      if (state === 'waiting') {
        sim.startGig();
        // stay in "loading": no ticks yet
        sim.setLive = () => undefined;
        break;
      }
      sim.startGig();
      await sleep(2700);
      if (beat) sim.seekBeats(beat);
      sim.fastForward(Number(q.get('ff') ?? 25));
      const ctl = (window as unknown as { __partyCtl?: { dev: RhythmDev; loop: Parameters<typeof autoplay>[1] } }).__partyCtl;
      if (ctl && q.get('auto') === '1') autoplay(ctl.dev, ctl.loop);
      if (state === 'paused') {
        await sleep(1500);
        sim.setLive(false);
      } else if (state === 'lost') {
        await sleep(1500);
        sim.setHostConnected(false);
      } else if (state === 'reconnecting') {
        await sleep(1500);
        sim.setStatus('reconnecting');
      } else if (state === 'results') {
        await sleep(Number(q.get('play') ?? 1500));
        sim.fastForward(60);
        sim.finishGig(q.get('case') !== 'left');
      } else if (state === 'ended') {
        await sleep(1500);
        sim.fatal('not-found');
      }
      break;
    }
    default:
      nav.go('home');
      if (start !== 'home') nav.go(start as 'setup');
  }
}

void main();
