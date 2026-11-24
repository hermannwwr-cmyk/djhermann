/**
 * Settings: sound delay (calibration), volume, the playing aids, help, reset and credits.
 */
import {
  ChevronRight,
  CircleHelp,
  GraduationCap,
  Hand,
  RotateCcw,
  Sparkles,
  Timer,
  Vibrate,
  Volume2,
} from 'lucide-static';
import { DEFAULT_SETTINGS } from '../../core/settings';
import type { AppContext, Screen } from '../../core/types';
import { add, h, icon } from './dom';
import type { Child } from './dom';
import { tutorialParams } from './logic';
import { buzz, playUi } from './shared';
import { confirmDialog, dismissTopLayer, slider, toast, toggle, topBar } from './ui';
import type { Toggle } from './ui';

export function createSettingsScreen(ctx: AppContext): Screen<undefined> {
  const { nav, settings, engine, library } = ctx;
  const el = h('div', 'sc-screen sc-settings');
  const body = h('div', 'sc-body sc-body--fade ui-scroll');

  const row = (svg: string, title: string, sub: string | null, trailing: Child, tag: 'div' | 'button' = 'div'): HTMLElement => {
    const r = h(
      tag,
      'sc-row',
      h('span', 'sc-row__icon', icon(svg)),
      h('span', 'sc-row__text', h('span', 'sc-row__title', title), sub ? h('span', 'sc-row__sub', sub) : null),
      trailing,
    );
    if (tag === 'button') (r as HTMLButtonElement).type = 'button';
    return r;
  };
  const group = (title: string, ...rows: HTMLElement[]): HTMLElement =>
    h('section', 'sc-section', h('h2', 'sc-h', title), h('div', 'sc-group', ...rows));
  const chevron = (): HTMLElement => icon(ChevronRight, 'sc-row__chev');

  // sound
  const delayValue = h('span', 'sc-row__value ui-num');
  const delayRow = row(Timer, 'Sound delay', 'Notes feel late or early? Line them up.', h('span', 'sc-row__trail', delayValue, chevron()), 'button');
  delayRow.dataset.act = 'calibrate';
  delayRow.addEventListener('click', () => nav.go('calibrate'));

  const volValue = h('span', 'sc-row__value ui-num');
  let lastBlip = 0;
  const vol = slider('Master volume', settings.get().masterVolume, (v) => {
    settings.set({ masterVolume: Math.round(v * 100) / 100 });
    engine.setMasterVolume(v);
    volValue.textContent = `${Math.round(v * 100)}%`;
    // let the player hear the level, but not on every pixel of the drag
    const now = performance.now();
    if (now - lastBlip > 220) {
      lastBlip = now;
      playUi(engine, 'tock', 0.7);
    }
  });
  vol.el.dataset.act = 'volume';
  const volRow = h(
    'div',
    'sc-row sc-row--stack',
    h('div', 'sc-row__line', h('span', 'sc-row__icon', icon(Volume2)), h('span', 'sc-row__text', h('span', 'sc-row__title', 'Volume')), volValue),
    vol.el,
  );

  // playing
  const toggles: Partial<Record<'guide' | 'haptics' | 'lowFx', Toggle>> = {};
  const toggleRow = (key: 'guide' | 'haptics' | 'lowFx', svg: string, title: string, sub: string): HTMLElement => {
    const t = toggle(title, settings.get()[key], (on) => {
      settings.set({ [key]: on });
      if (key === 'haptics' && on) buzz(settings, 20);
    });
    t.el.dataset.act = key;
    toggles[key] = t;
    return row(svg, title, sub, t.el);
  };

  // help
  const howRow = row(CircleHelp, 'How to play', 'The game in five pictures.', chevron(), 'button');
  howRow.dataset.act = 'howto';
  howRow.addEventListener('click', () => nav.go('howto'));
  const tutRow = row(GraduationCap, 'Replay the tutorial', 'The 2-minute guided first mix.', chevron(), 'button');
  tutRow.dataset.act = 'tutorial';
  tutRow.addEventListener('click', () => nav.go('game', tutorialParams(library.list())));

  // data
  const resetRow = row(RotateCcw, 'Reset progress', 'Clears your best scores and the tutorial.', chevron(), 'button');
  resetRow.classList.add('sc-row--danger');
  resetRow.dataset.act = 'reset';
  resetRow.addEventListener('click', () => {
    void confirmDialog(el, {
      title: 'Reset your progress?',
      body: 'Your best scores are cleared and the tutorial is offered again. Your music and your settings stay.',
      confirm: 'Reset',
      danger: true,
    }).then((yes) => {
      if (!yes) return;
      settings.set({ best: {}, tutorialDone: DEFAULT_SETTINGS.tutorialDone, seenHowTo: DEFAULT_SETTINGS.seenHowTo });
      toast(el, 'Progress reset', 'good');
    });
  });

  const credits = h(
    'section',
    'sc-credits',
    h('h2', 'sc-h', 'Credits'),
    h('p', null, h('b', null, 'Music.'), ' Every built-in track and sound is original, made for this game.'),
    h('p', null, h('b', null, 'Fonts.'), ' Unbounded and Manrope, under the SIL Open Font License.'),
    h('p', null, h('b', null, 'Icons.'), ' Lucide, under the ISC License.'),
    h('p', 'sc-credits__ver', 'DJ Hermann'),
  );

  add(
    body,
    group('Sound', delayRow, volRow),
    group(
      'Playing',
      toggleRow('guide', Hand, 'Show me what to press', 'Spotlights the control to use in every mission.'),
      toggleRow('haptics', Vibrate, 'Vibration', 'A small buzz on hits, on phones that can do it.'),
      toggleRow('lowFx', Sparkles, 'Fewer effects', 'Smoother on slower phones.'),
    ),
    group('Help', howRow, tutRow),
    group('Your data', resetRow),
    credits,
  );
  add(el, topBar('Settings', () => nav.back()), body);

  function sync(): void {
    const s = settings.get();
    delayValue.textContent = s.latencyMs === null ? `Auto · ${Math.round(engine.getAutoLatencyMs())} ms` : `${Math.round(s.latencyMs)} ms`;
    vol.set(s.masterVolume);
    volValue.textContent = `${Math.round(s.masterVolume * 100)}%`;
    toggles.guide?.set(s.guide);
    toggles.haptics?.set(s.haptics);
    toggles.lowFx?.set(s.lowFx);
  }

  return {
    el,
    enter() {
      sync();
      body.scrollTop = 0;
    },
    back: () => dismissTopLayer(el),
  };
}
