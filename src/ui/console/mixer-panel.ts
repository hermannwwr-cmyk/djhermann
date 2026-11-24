/**
 * The mixer: two channel strips (HI / MID / LOW, FILTER, channel fader with its LED meter, ECHO)
 * either side of the master meter.
 */
import { DECK_IDS } from '../../core/types';
import type { DeckId, EqBand, FrameState } from '../../core/types';
import type { Button, Ctl, Meter, ScaleMark } from './controls';
import { createButton, createFader, createKnob, createMeter } from './controls';
import type { PanelEnv, Panel } from './deck-panel';
import { h } from './gestures';
import { eqToNorm, normToEq } from './logic';

const EQ: [EqBand, string][] = [
  ['high', 'HI'],
  ['mid', 'MID'],
  ['low', 'LOW'],
];

const FADER_SCALE: ScaleMark[] = Array.from({ length: 11 }, (_, i) => {
  const mark: ScaleMark = { at: -1 + i * 0.2, major: i % 5 === 0 };
  if (i % 5 === 0) mark.label = String(10 - i);
  return mark;
});

export function createMixerPanel(env: PanelEnv): Panel {
  const { engine } = env;
  const ctls: Ctl[] = [];
  const buttons: Button[] = [];
  const meters = {} as Record<DeckId, Meter>;
  const echoes = {} as Record<DeckId, Button>;

  const strip = (deck: DeckId): HTMLElement => {
    const knobs = h('div', 'dk-ch-knobs');
    for (const [band, label] of EQ) {
      const k = createKnob(env, {
        id: `${deck}.eq.${band}`,
        label,
        kind: 'eq',
        read: (f) => eqToNorm(f.mixer.channels[deck].eq[band]),
        write: (n) => engine.setEq(deck, band, normToEq(n)),
      });
      ctls.push(k);
      knobs.append(k.el);
    }
    const filter = createKnob(env, {
      id: `${deck}.filter`,
      label: 'FILTER',
      kind: 'filter',
      read: (f) => f.mixer.channels[deck].filter,
      write: (n) => engine.setFilter(deck, n),
    });
    ctls.push(filter);
    knobs.append(filter.el);

    const fader = createFader(env, {
      id: `${deck}.fader`,
      orient: 'v',
      cls: 'dk-fader--ch',
      capLen: 34,
      // top of the slot is loudest
      read: (f) => 1 - 2 * f.mixer.channels[deck].fader,
      write: (n) => engine.setFader(deck, (1 - n) / 2),
      scale: FADER_SCALE,
    });
    ctls.push(fader);
    const meter = createMeter();
    meters[deck] = meter;
    const echo = createButton(env, {
      id: `${deck}.echo`,
      cls: 'dk-btn--echo',
      content: '<i class="dk-led"></i><span>ECHO</span>',
      down: () => engine.setEcho(deck, true),
      up: () => engine.setEcho(deck, false),
    });
    echoes[deck] = echo;
    buttons.push(echo);

    const level = h(
      'div',
      'dk-ch-level',
      null,
      h('div', 'dk-ch-head', null, h('span', 'dk-ch-id', null, deck), h('span', 'dk-legend', null, 'LEVEL')),
      h('div', 'dk-ch-fadrow', null, fader.el, meter.el),
      echo.el,
    );
    return h('div', `dk-ch dk-ch--${deck.toLowerCase()}`, null, knobs, level);
  };

  const masterL = createMeter('dk-meter--master');
  const masterR = createMeter('dk-meter--master');
  const beat = h('i', 'dk-beat-led');
  const master = h(
    'div',
    'dk-master',
    null,
    h('div', 'dk-brand', null, h('b', '', null, 'DJH'), h('span', '', null, 'MIX·2')),
    h('div', 'dk-master-meters', null, masterL.el, h('div', 'dk-master-scale', null, ...['+', '0', '', '10', '', '20', '', '30'].map((t) => h('span', '', null, t))), masterR.el),
    h('span', 'dk-legend', null, 'MASTER'),
    h('div', 'dk-beat', null, beat, h('span', 'dk-legend', null, 'BEAT')),
  );

  const el = h('section', 'dk-panel dk-mixer', { 'data-panel': 'mixer', 'aria-label': 'Mixer' }, strip('A'), master, strip('B'));

  let beatShown = -1;

  return {
    el,
    update(frame: FrameState) {
      for (const c of ctls) c.update(frame);
      for (const id of DECK_IDS) {
        meters[id].update(frame.decks[id].level, frame.dt);
        echoes[id].setLit(frame.mixer.channels[id].echo ? 'on' : 'off');
      }
      masterL.update(frame.mixer.masterLevel, frame.dt);
      masterR.update(frame.mixer.masterLevel * 0.94, frame.dt);
      const b = Math.round(frame.pulse * 10) / 10;
      if (b !== beatShown) {
        beatShown = b;
        beat.style.opacity = String(b);
      }
    },
    destroy() {
      for (const c of ctls) c.destroy();
      for (const b of buttons) b.destroy();
    },
  };
}
