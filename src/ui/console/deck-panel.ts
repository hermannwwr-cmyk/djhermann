/**
 * One deck, laid out like a digital turntable: a display across the top, the platter,
 * the transport buttons and the long tempo fader.
 */
import { phaseOffsetBeats } from '../../core/beatgrid';
import { TEMPO_MAX, otherDeck } from '../../core/types';
import type { DeckId, FrameState } from '../../core/types';
import type { Button, Ctl, ScaleMark } from './controls';
import { createButton, createFader } from './controls';
import { h } from './gestures';
import { PHASE_LOCK_BEATS, blinkOn, formatPitch, formatRemain, normToTempo, tempoToNorm } from './logic';
import { createPlatter } from './platter';
import type { PlatterEnv } from './platter';

export interface PanelEnv extends PlatterEnv {
  onLoadRequest?: (deck: DeckId) => void;
}

export interface Panel {
  readonly el: HTMLElement;
  update(frame: FrameState): void;
  destroy(): void;
}

const ICON_PLAY =
  '<svg viewBox="0 0 28 16" aria-hidden="true"><path d="M2 1.6v12.8a1 1 0 0 0 1.5.86l10.4-6.4a1 1 0 0 0 0-1.72L3.5.74A1 1 0 0 0 2 1.6z"/><rect x="18" y="1" width="3.2" height="14" rx="1"/><rect x="23.4" y="1" width="3.2" height="14" rx="1"/></svg>';
const ICON_EJECT =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2 2.4 9.4h11.2z"/><rect x="2.4" y="11.2" width="11.2" height="2.4" rx="0.8"/></svg>';

function tempoScale(): ScaleMark[] {
  const max = Math.round((TEMPO_MAX - 1) * 100);
  const marks: ScaleMark[] = [];
  for (let p = -max; p <= max; p++) {
    const major = p % 4 === 0;
    const mark: ScaleMark = { at: p / max, major };
    if (major) mark.label = p === 0 ? '0' : `${p > 0 ? '+' : '−'}${Math.abs(p)}`;
    marks.push(mark);
  }
  return marks;
}

export function createDeckPanel(env: PanelEnv, deck: DeckId): Panel {
  const { engine } = env;
  const other = otherDeck(deck);
  const ctls: Ctl[] = [];
  const buttons: Button[] = [];

  // ── display ──
  const title = h('div', 'dk-screen-title');
  const time = h('span', 'dk-screen-time ui-num');
  const state = h('span', 'dk-screen-state');
  const bpm = h('div', 'dk-screen-bpm ui-num');
  const pitch = h('span', 'dk-screen-pitch ui-num');
  const pip = h('i', 'dk-phase-pip');
  const phase = h(
    'div',
    'dk-phase',
    { 'data-state': 'idle' },
    h('div', 'dk-phase-bar', null, h('i', 'dk-phase-mid'), pip),
    h('div', 'dk-phase-legend', null, h('span', '', null, 'BEHIND'), h('span', 'dk-phase-word', null, 'BEAT'), h('span', '', null, 'AHEAD')),
  );
  const load = h('button', 'dk-load ui-touch', { type: 'button', 'data-action': `load${deck}`, 'aria-label': `Load a track on deck ${deck}` });
  load.innerHTML = `${ICON_EJECT}<span>LOAD</span>`;
  const onLoad = (): void => env.onLoadRequest?.(deck);
  load.addEventListener('click', onLoad);
  const screen = h(
    'div',
    'dk-screen',
    null,
    h('div', 'dk-screen-id', null, deck),
    h('div', 'dk-screen-track', null, title, h('div', 'dk-screen-sub', null, time, state)),
    h('div', 'dk-screen-tempo', null, bpm, h('div', 'dk-screen-sub', null, h('span', 'dk-screen-unit', null, 'BPM'), pitch)),
    phase,
    load,
  );

  // ── platter ──
  const platter = createPlatter(env, deck);
  ctls.push(platter);
  const well = h('div', 'dk-platter-well', null, platter.el);

  // ── transport ──
  const sync = createButton(env, {
    id: `${deck}.sync`,
    cls: 'dk-btn--sync',
    content: '<i class="dk-led"></i><span>SYNC</span>',
    down: () => void engine.sync(deck),
  });
  const bendDown = createButton(env, {
    id: `${deck}.nudge-`,
    cls: 'dk-btn--bend',
    content: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="6.8" width="10" height="2.4" rx="1"/></svg>',
    down: () => engine.setNudge(deck, -1),
    up: () => engine.setNudge(deck, 0),
  });
  const bendUp = createButton(env, {
    id: `${deck}.nudge+`,
    cls: 'dk-btn--bend',
    content: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="6.8" width="10" height="2.4" rx="1"/><rect x="6.8" y="3" width="2.4" height="10" rx="1"/></svg>',
    down: () => engine.setNudge(deck, 1),
    up: () => engine.setNudge(deck, 0),
  });
  const cue = createButton(env, {
    id: `${deck}.cue`,
    cls: 'dk-btn--round dk-btn--cue',
    content: '<span>CUE</span>',
    down: () => engine.cueDown(deck),
    up: () => engine.cueUp(deck),
  });
  const play = createButton(env, {
    id: `${deck}.play`,
    cls: 'dk-btn--round dk-btn--play',
    content: ICON_PLAY,
    down: () => engine.togglePlay(deck),
  });
  buttons.push(sync, bendDown, bendUp, cue, play);
  const transport = h(
    'div',
    'dk-transport',
    null,
    sync.el,
    h('div', 'dk-bend', null, h('span', 'dk-legend', null, 'PITCH BEND'), h('div', 'dk-bend-row', null, bendDown.el, bendUp.el)),
    h('div', 'dk-cueplay', null, cue.el, play.el),
  );

  // ── tempo ──
  const tempo = createFader(env, {
    id: `${deck}.tempo`,
    orient: 'v',
    cls: 'dk-fader--tempo',
    capLen: 30,
    read: (f) => tempoToNorm(f.decks[deck].tempo),
    write: (n) => engine.setTempo(deck, normToTempo(n)),
    detent: 0.045,
    fine: true,
    doubleTapReset: true,
    scale: tempoScale(),
  });
  tempo.el.append(h('i', 'dk-tempo-led'));
  ctls.push(tempo);
  const tempoCol = h('div', 'dk-tempo', null, h('span', 'dk-legend', null, 'TEMPO'), tempo.el);

  const el = h(
    'section',
    `dk-panel dk-deck dk-deck--${deck.toLowerCase()}`,
    { 'data-panel': deck === 'A' ? 'deckA' : 'deckB', 'aria-label': `Deck ${deck}` },
    screen,
    h('div', 'dk-deck-body', null, well, transport, tempoCol),
  );

  // cached text, so the DOM is only touched when something really changed
  let sTitle = '\u0000';
  let sTime = '';
  let sState = '';
  let sBpm = '';
  let sPitch = '';
  let sPhase = '';
  let sPip = NaN;

  const text = (node: HTMLElement, prev: string, next: string): string => {
    if (prev !== next) node.textContent = next;
    return next;
  };

  return {
    el,
    update(frame) {
      for (const c of ctls) c.update(frame);
      const d = frame.decks[deck];
      const o = frame.decks[other];
      const has = d.track !== null;
      const blink = blinkOn(frame.now);

      sTitle = text(title, sTitle, has ? d.track!.title : 'No track loaded');
      sTime = text(time, sTime, has ? formatRemain(d.positionSec, d.durationSec) : '−–:––');
      const st = !has
        ? ''
        : d.scratching
          ? 'SCRATCH'
          : d.playing
            ? 'PLAY'
            : d.cuePreview
              ? 'CUE'
              : d.positionSec >= d.durationSec - 0.05
                ? 'END'
                : 'PAUSE';
      if (st !== sState) {
        sState = st;
        state.textContent = st;
        state.dataset.s = st;
      }
      sBpm = text(bpm, sBpm, has ? d.bpm.toFixed(2) : '–––.––');
      sPitch = text(pitch, sPitch, formatPitch(d.tempo));
      if (el.classList.contains('dk-empty') === has) el.classList.toggle('dk-empty', !has);

      // phase meter: where this deck's beats fall against the other deck's
      const running = has && o.track !== null && Math.abs(d.rate) > 0.3 && Math.abs(o.rate) > 0.3;
      let ps = 'idle';
      if (running) {
        const off = phaseOffsetBeats(d, o);
        const a = Math.abs(off);
        ps = a <= PHASE_LOCK_BEATS ? 'lock' : a <= 0.12 ? 'near' : 'off';
        const x = Math.round(off * 1000) / 10;
        if (x !== sPip) {
          sPip = x;
          pip.style.transform = `translate3d(${x}%,0,0)`;
        }
      }
      if (ps !== sPhase) {
        sPhase = ps;
        phase.dataset.state = ps;
      }

      // lamps
      play.setLit(!has ? 'off' : d.playing ? 'on' : blink ? 'on' : 'dim');
      const onCue = Math.abs(d.positionSec - d.cueSec) < 0.02;
      cue.setLit(!has ? 'off' : d.cuePreview ? 'on' : d.playing ? 'dim' : onCue ? 'on' : blink ? 'on' : 'dim');
      sync.setLit(d.synced ? 'on' : 'off');
      bendDown.setLit(d.nudge < -0.02 ? 'on' : 'off');
      bendUp.setLit(d.nudge > 0.02 ? 'on' : 'off');
    },
    destroy() {
      load.removeEventListener('click', onLoad);
      for (const c of ctls) c.destroy();
      for (const b of buttons) b.destroy();
    },
  };
}
