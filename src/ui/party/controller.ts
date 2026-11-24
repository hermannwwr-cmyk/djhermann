/**
 * A player's game screen: their own note highway and pads, in time with the music coming out of
 * the host's speaker. Built like the host's game screen (src/app/game-screen.ts), but every deck
 * here is a mirror of the host's (RemoteEngine), so there is no console: just the stage, the
 * notes and the pads, the live leaderboard, and a line saying what the DJ is doing.
 *
 * States: waiting for the host's music (loading overlay), playing, the DJ paused, the DJ's phone
 * dropped out, reconnecting, results (the final board), and the party ended.
 */
import { House, LogOut, Pause, RefreshCw, Trophy, Unplug, Users, Volume1 } from 'lucide-static';
import { sectionAtBeat } from '../../core/beatgrid';
import { createGameBus } from '../../core/events';
import { IDLE_HUD, createFrameLoop } from '../../core/frame';
import type { FrameLoop } from '../../core/frame';
import type { BoardEntry, ErrorCode, RoomClient } from '../../core/party';
import type { AppContext, FrameState, GigResults, HudState, Screen } from '../../core/types';
import { createRhythmDev } from '../../game/rhythm';
import { createTopBar, showCard } from '../hud';
import { createLoadingOverlay } from '../screens';
import { button, h, icon } from '../screens/dom';
import { formatPercent, formatScore } from '../screens/logic';
import { buzz, playUi } from '../screens/shared';
import { confirmDialog, dismissTopLayer } from '../screens/ui';
import { createBoardChip, renderBoardList } from './board';
import { controllerState, djLine, hostOf, ordinal, rankBoard, roomErrorCopy } from './logic';
import type { ControllerState } from './logic';
import type { PartyNet } from './net';
import { partySession, stateCard } from './parts';

interface Session {
  destroy(): void;
  askLeave(): void;
}

export function createControllerScreen(ctx: AppContext, net: PartyNet): Screen<undefined> {
  const el = h('div', 'pt-ctl');
  let session: Session | null = null;

  const start = (): void => {
    session?.destroy();
    session = null;
    const room = ctx.party.room;
    if (!room || room.status === 'closed') {
      window.setTimeout(() => (room ? ctx.nav.go('lobby') : ctx.nav.go('party', {})), 0);
      return;
    }
    session = startSession(ctx, net, el, room, start);
  };

  return {
    el,
    enter: start,
    leave() {
      session?.destroy();
      session = null;
    },
    back() {
      if (dismissTopLayer(el)) return true;
      session?.askLeave();
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

function startSession(ctx: AppContext, net: PartyNet, host: HTMLElement, room: RoomClient, restart: () => void): Session {
  const { engine, settings, nav, party } = ctx;
  let dead = false;
  let fatal: ErrorCode | null = null;
  let state: ControllerState | null = null;
  const cleanup: (() => void)[] = [];

  // ── layout ──
  host.replaceChildren();
  const root = div('pt-ctl__root', host);
  const topSlot = div('pt-ctl__top', root);
  const boardSlot = div('pt-ctl__board', root);
  const playSlot = div('pt-ctl__play', root);
  const stateSlot = div('pt-ctl__state', playSlot);
  const overlay = div('pt-ctl__overlay', root);

  // ── modules ──
  const bus = createGameBus();
  const remote = net.createRemoteEngine({ room, local: engine });
  const dev = createRhythmDev({ engine: remote, bus, settings });
  const rhythm = dev.controller;
  const reporter = net.createPlayerReporter({ room, bus, rhythm });

  const hud: HudState = { ...IDLE_HUD, mode: 'gig' };
  const getHud = (): HudState => {
    const s = rhythm.getStats();
    const r = remote.hud;
    hud.score = s.points;
    hud.combo = s.combo;
    hud.multiplier = s.multiplier;
    hud.hype = r?.hype ?? 0.5;
    hud.progress = r?.progress ?? null;
    hud.set = r?.set ?? null;
    hud.status =
      state === 'paused'
        ? 'THE DJ PAUSED THE MUSIC'
        : state === 'host-lost' || state === 'reconnecting' || state === 'waiting'
          ? 'WAITING FOR THE DJ'
          : djLine(r);
    return hud;
  };
  const loop: FrameLoop = createFrameLoop(remote, getHud);

  const topBar = createTopBar({ bus, settings, onPause: () => void askLeave() });
  // the top bar's button is the way out here: a party cannot be paused by a player
  const exitBtn = topBar.el.querySelector<HTMLElement>('.hud-pausebtn');
  if (exitBtn) {
    exitBtn.setAttribute('aria-label', 'Leave the party');
    exitBtn.querySelector('.hud-pausebtn__face')?.replaceChildren(icon(LogOut, 'pt-exiticon'));
  }
  const chip = createBoardChip({ getBoard: () => remote.board, myPid: room.pid, layout: 'row' });
  const loading = createLoadingOverlay();
  overlay.appendChild(loading.el);
  // the wait can be long (the DJ is still choosing): there is always a way out
  const waitLeave = button({ className: 'sc-chipbtn pt-ctl__waitleave', icon: LogOut, label: 'Leave' });
  waitLeave.dataset.act = 'leave';
  waitLeave.addEventListener('click', () => void askLeave());
  waitLeave.hidden = true;
  overlay.appendChild(waitLeave);
  const djName = (): string => hostOf(room.players)?.name ?? 'The DJ';

  topSlot.appendChild(topBar.el);
  playSlot.insertBefore(rhythm.el, stateSlot);
  boardSlot.appendChild(chip.el);

  // ── the stage follows the music: sections of the live track light the crowd ──
  let lastSection = '';
  const watchSections = (f: FrameState): void => {
    const deck = f.liveDeck;
    const snap = deck ? f.decks[deck] : null;
    if (!deck || !snap?.track) return;
    const s = sectionAtBeat(snap.track, snap.beat);
    if (!s) return;
    const key = `${deck}:${snap.track.id}:${s.startBar}`;
    if (key === lastSection) return;
    lastSection = key;
    bus.emit('section', { deck, kind: s.kind, energy: s.energy });
  };

  cleanup.push(
    loop.add((f) => {
      rhythm.setDifficulty(room.me?.difficulty ?? settings.get().difficulty);
      rhythm.setDensity(remote.density);
      rhythm.update(f);
      reporter.update(f);
      watchSections(f);
    }, 'logic'),
    loop.add((f) => {
      topBar.update(f);
      chip.update(f);
      watch();
    }),
  );

  // ── states ──
  function facts(): Parameters<typeof controllerState>[0] {
    return {
      status: room.status,
      fatal: fatal !== null,
      hasResults: remote.results !== null,
      hostConnected: room.hostConnected,
      hasTrack: !!(remote.getDeck('A').track || remote.getDeck('B').track),
      hadTick: remote.hud !== null,
      hostLive: remote.hostLive,
    };
  }

  let loadingShown = false;
  function setLoading(on: boolean): void {
    if (on === loadingShown) return;
    loadingShown = on;
    waitLeave.hidden = !on;
    if (on) loading.show(`${djName()} is getting the music ready`);
    else void loading.hide();
  }

  let lastWaitStep = -1;
  function watch(): void {
    if (dead) return;
    const f = facts();
    const next = controllerState(f);
    if (next === 'waiting') {
      setLoading(true);
      const step = f.hasTrack ? 1 : 0;
      if (step !== lastWaitStep) {
        lastWaitStep = step;
        if (step === 0) loading.set(0.3, `${djName()} is getting the music ready`);
        else loading.set(0.75, `Ready. Waiting for ${djName()} to start the music`);
      }
    }
    if (next === state) return;
    const prev = state;
    state = next;
    root.dataset.state = next;
    if (next !== 'waiting') {
      if (lastWaitStep >= 0 && next === 'live') loading.set(1, 'Here it comes');
      setLoading(false);
      lastWaitStep = -1;
    }
    renderState(next, prev);
  }

  let remindPill: HTMLElement | null = null;

  function renderState(s: ControllerState, prev: ControllerState | null): void {
    if (s !== 'live') remindPill?.click();
    stateSlot.replaceChildren();
    stateSlot.classList.remove('pt-ctl__state--on');
    const show = (card: HTMLElement): void => {
      stateSlot.appendChild(card);
      stateSlot.classList.add('pt-ctl__state--on');
    };
    const hostName = hostOf(room.players)?.name ?? 'The DJ';
    switch (s) {
      case 'live':
        if (prev === 'waiting' || prev === null) remindVolume();
        break;
      case 'paused':
        show(stateCard({ icon: Pause, title: 'The DJ paused', body: `The music stopped on ${hostName}’s phone. Your notes come back with it.`, busy: true }));
        break;
      case 'host-lost':
        show(
          stateCard({
            icon: Unplug,
            tone: 'bad',
            title: `${hostName}’s phone dropped out`,
            body: 'Waiting for it to come back. Stay here: the game picks up where it left off.',
            busy: true,
          }),
        );
        break;
      case 'reconnecting':
        show(stateCard({ icon: RefreshCw, title: 'Reconnecting…', body: 'Your phone lost the party for a moment. Hang on.', busy: true }));
        break;
      case 'results':
        void showResults();
        break;
      case 'ended':
        showEnded();
        break;
      default:
        break;
    }
  }

  // ── volume reminder, once per party ──
  function remindVolume(): void {
    if (partySession.reminded.has(room.code)) return;
    partySession.reminded.add(room.code);
    const pill = h(
      'button',
      'pt-remind',
      icon(Volume1),
      h('span', null, h('b', null, 'Turn your volume down a bit. '), 'The music comes from the DJ’s speaker.'),
    );
    pill.type = 'button';
    pill.dataset.act = 'remind';
    remindPill = pill;
    playSlot.appendChild(pill);
    const gone = (): void => {
      if (remindPill === pill) remindPill = null;
      pill.classList.remove('pt-remind--in');
      window.setTimeout(() => pill.remove(), 400);
    };
    pill.addEventListener('click', gone);
    requestAnimationFrame(() => requestAnimationFrame(() => pill.classList.add('pt-remind--in')));
    const t = window.setTimeout(gone, 7000);
    cleanup.push(() => window.clearTimeout(t));
  }

  // ── results ──
  let resultsShown = false;
  async function showResults(): Promise<void> {
    const res = remote.results;
    if (resultsShown || !res) return;
    resultsShown = true;
    partySession.doneWith = room.code;
    const ranked = rankBoard(res.board, room.pid);
    const me = ranked.find((e) => e.me);
    if (me?.rank === 1) playUi(engine, 'cheer', 0.6);
    else playUi(engine, 'success', 0.5);
    buzz(settings, me?.rank === 1 ? [20, 60, 30] : 18);
    await showCard(overlay, {
      title: res.results.completed ? 'SET COMPLETE!' : 'THE CROWD LEFT',
      subtitle: me?.rank === 1 ? 'And you topped the board' : 'Here’s how everyone did',
      tone: res.results.completed ? 'good' : 'bad',
      ms: 1200,
    });
    if (dead) return;
    overlay.appendChild(resultsPanel(res.results, res.board));
  }

  function resultsPanel(results: GigResults, board: BoardEntry[]): HTMLElement {
    const ranked = rankBoard(board, room.pid);
    const me = ranked.find((e) => e.me);
    const stats = rhythm.getStats();
    const score = me?.score ?? stats.points;
    const rank = me?.rank ?? ranked.length;
    const first = rank === 1;
    const n = ranked.length;
    const ahead = me && rank > 1 ? ranked[ranked.indexOf(me) - 1] : null;

    const medal = h(
      'div',
      `pt-res__medal${first ? ' pt-res__medal--gold' : rank <= 3 ? ` pt-res__medal--${rank}` : ''}`,
      h('div', 'pt-res__rays'),
      h('div', 'pt-res__disc', first ? icon(Trophy, 'pt-res__trophy') : null, h('span', 'pt-res__rank ui-num', ordinal(rank))),
    );
    const line = first
      ? n > 1
        ? `You topped the board, out of ${n} players!`
        : 'Nobody beat you tonight.'
      : ahead && ahead.score > score
        ? `Out of ${n} players · ${formatScore(ahead.score - score)} points behind ${ahead.name}`
        : `Out of ${n} players`;
    const judged = stats.perfect + stats.great + stats.good + stats.miss;
    const tile = (label: string, value: string, tone = ''): HTMLElement =>
      h('div', `sc-res__tile${tone ? ` sc-res__tile--${tone}` : ''}`, h('div', 'sc-res__tilelabel', label), h('div', 'sc-res__tilevalue ui-num', value));

    const scroll = h(
      'div',
      'pt-res__scroll ui-scroll',
      h(
        'div',
        'pt-res__hero',
        h('div', 'pt-res__kicker', results.completed ? 'SET COMPLETE' : 'THE CROWD LEFT'),
        medal,
        h('div', 'pt-res__place', first ? 'FIRST PLACE' : `${ordinal(rank).toUpperCase()} PLACE`),
        h('p', 'pt-res__line', line),
      ),
      h(
        'div',
        'sc-res__tiles pt-res__tiles',
        tile('SCORE', formatScore(score), 'gold'),
        tile('ACCURACY', judged === 0 ? '–' : formatPercent(me?.accuracy ?? stats.accuracy)),
        tile('BEST COMBO', String(me?.maxCombo ?? stats.maxCombo)),
      ),
      h(
        'section',
        'sc-section',
        h('div', 'sc-section__head', h('h2', 'sc-h', 'The board'), h('span', 'sc-count', `The set got an ${results.grade}`)),
        renderBoardList(board, room.pid),
      ),
    );
    const lobby = h('button', 'ui-btn ui-btn--primary ui-btn--lg pt-res__again', icon(Users), h('span', null, 'Back to lobby'));
    lobby.type = 'button';
    lobby.dataset.act = 'lobby';
    lobby.addEventListener('click', () => {
      buzz(settings, 12);
      nav.go('lobby');
    });
    const home = h('button', 'ui-btn ui-btn--lg pt-res__home', icon(House));
    home.type = 'button';
    home.dataset.act = 'home';
    home.setAttribute('aria-label', 'Leave the party');
    home.addEventListener('click', () => void askLeave());
    const panel = h('div', 'pt-res', h('div', 'pt-res__glow'), scroll, h('footer', 'sc-foot sc-foot--row pt-res__foot', home, lobby));
    requestAnimationFrame(() => requestAnimationFrame(() => panel.classList.add('pt-res--in')));
    return panel;
  }

  // ── the party ended for good ──
  function showEnded(): void {
    void loading.hide();
    const code = fatal ?? 'not-found';
    const copy = code === 'not-found' ? { title: 'The party is over', body: 'The DJ closed this party.' } : roomErrorCopy(code);
    const homeBtn = button({ className: 'ui-btn ui-btn--primary ui-btn--lg', label: 'Back to the start' });
    homeBtn.dataset.act = 'home';
    homeBtn.addEventListener('click', () => {
      party.leave();
      nav.go('home');
    });
    stateSlot.replaceChildren(stateCard({ icon: LogOut, tone: 'bad', title: copy.title, body: copy.body, actions: [homeBtn] }));
    stateSlot.classList.add('pt-ctl__state--on', 'pt-ctl__state--solid');
  }

  // ── leave ──
  let asking = false;
  async function askLeave(): Promise<void> {
    if (dead || asking) return;
    if (state === 'ended') {
      party.leave();
      nav.go('home');
      return;
    }
    asking = true;
    const ok = await confirmDialog(overlay, {
      title: 'Leave the party?',
      body: `The music keeps playing on the DJ’s phone. You can come back with the code ${room.code}.`,
      confirm: 'Leave',
      cancel: 'Keep playing',
      danger: true,
    });
    asking = false;
    if (!ok || dead) return;
    party.leave();
    nav.go('home');
  }

  // ── room events ──
  cleanup.push(
    room.on('error', ({ code }) => {
      fatal = code;
      watch();
    }),
    room.on('phase', ({ phase }) => {
      if (dead) return;
      if (phase === 'loading' && resultsShown) {
        // the DJ started the next gig while we were looking at the results
        partySession.doneWith = '';
        window.setTimeout(restart, 0);
      } else if (phase === 'lobby' && !resultsShown) {
        // the DJ stopped the gig: back to the lobby together
        window.setTimeout(() => {
          if (!dead) nav.go('lobby');
        }, 0);
      }
    }),
  );

  // ── keep the phone awake while playing ──
  let wakeLock: WakeLockSentinel | null = null;
  const requestWakeLock = async (): Promise<void> => {
    try {
      wakeLock = (await navigator.wakeLock?.request('screen')) ?? null;
    } catch {
      /* not supported or denied */
    }
  };
  const onVisibility = (): void => {
    if (!document.hidden) {
      void requestWakeLock();
      void engine.resume();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  cleanup.push(() => document.removeEventListener('visibilitychange', onVisibility));
  void requestWakeLock();
  cleanup.push(() => void wakeLock?.release().catch(() => undefined));

  if (import.meta.env.DEV) {
    // handle for playtest scripts and the harness; never present in production builds
    (window as unknown as { __partyCtl?: unknown }).__partyCtl = { dev, rhythm, remote, loop, bus, room };
  }

  // ── start ──
  void (async () => {
    try {
      await engine.unlock();
    } catch (err) {
      console.warn('[party] audio did not start; the pads will be silent', err);
    }
    if (dead) return;
    loop.start();
    // the first frame decides between waiting / playing; make sure the overlay is up before it
    watch();
    if (!loadingShown && state === null) setLoading(true);
  })();

  return {
    askLeave: () => void askLeave(),
    destroy() {
      if (dead) return;
      dead = true;
      loop.stop();
      for (const fn of cleanup) fn();
      reporter.destroy();
      rhythm.destroy();
      chip.destroy();
      topBar.destroy();
      remote.destroy();
      host.replaceChildren();
    },
  };
}

