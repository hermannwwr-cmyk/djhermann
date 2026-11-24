/**
 * Home: the four things you can do, with the right one first. Until the tutorial is done that is
 * LEARN TO DJ; afterwards it is PLAY A GIG.
 */
import {
  ChevronRight,
  CircleHelp,
  Disc3,
  GraduationCap,
  ListMusic,
  Play,
  Settings as SettingsIcon,
  SlidersHorizontal,
  Sparkles,
  Trophy,
  Users,
} from 'lucide-static';
import type { AppContext, Screen } from '../../core/types';
import { add, button, clear, h, icon } from './dom';
import { DIFFICULTY_COPY, bestOverall, formatScore, tutorialParams } from './logic';
import { recordElement } from './record';
import { takeRoomInvite } from '../party/parts';

type Action = 'learn' | 'gig' | 'free' | 'music' | 'party';

export function createHomeScreen(ctx: AppContext): Screen<undefined> {
  const { nav, settings, library } = ctx;
  const el = h('div', 'sc-screen sc-home');

  const gear = button({ className: 'ui-iconbtn', icon: SettingsIcon, ariaLabel: 'Settings', onTap: () => nav.go('settings') });
  gear.dataset.act = 'settings';
  const head = h(
    'header',
    'sc-home__head',
    h('div', 'sc-wordmark', h('span', null, 'DJ'), h('span', 'ui-aurora-text', 'HERMANN')),
    gear,
  );
  const body = h('div', 'sc-body ui-scroll');
  add(el, head, body);

  // drawn once, reused on every visit
  let heroArt: HTMLElement | null = null;

  function run(action: Action): void {
    switch (action) {
      case 'learn':
        nav.go('game', tutorialParams(library.list()));
        break;
      case 'gig':
        nav.go('setup');
        break;
      case 'free':
        nav.go('game', { mode: 'free', setlist: [], difficulty: settings.get().difficulty });
        break;
      case 'music':
        nav.go('library');
        break;
      case 'party':
        nav.go('party', {});
        break;
    }
  }

  function bestLine(): HTMLElement | null {
    const best = bestOverall(settings.get().best);
    if (!best) return null;
    return h('span', 'sc-best', icon(Trophy), 'BEST ', h('b', 'ui-num', formatScore(best.score)), ` · ${DIFFICULTY_COPY[best.difficulty].name}`);
  }

  function hero(action: 'learn' | 'gig'): HTMLElement {
    const learn = action === 'learn';
    const card = h('button', 'sc-hero');
    card.type = 'button';
    card.dataset.act = action;
    heroArt ??= recordElement(250, 'logo', 'sc-hero__art');
    add(
      card,
      heroArt,
      learn
        ? h('span', 'sc-hero__badge', icon(Sparkles), 'Start here · 2 minutes')
        : h('span', 'sc-hero__badge sc-hero__badge--plain', 'Tonight’s set'),
      h('span', 'sc-hero__title', learn ? 'LEARN TO DJ' : 'PLAY A GIG'),
      h(
        'span',
        'sc-hero__line',
        learn ? 'Your first mix, one easy step at a time.' : 'Mix the tracks, hit the pads, move the crowd.',
      ),
      learn ? null : bestLine(),
      h('span', 'sc-hero__go', icon(Play), learn ? 'Start the lesson' : 'Play'),
    );
    card.addEventListener('click', () => run(action));
    return card;
  }

  function item(action: Action, svg: string, tone: string, title: string, line: string, extra?: HTMLElement | null): HTMLElement {
    const b = h('button', 'sc-menu__item');
    b.type = 'button';
    b.dataset.act = action;
    const ic = h('span', 'sc-menu__icon', icon(svg));
    ic.style.setProperty('--tone', tone);
    add(b, ic, h('span', 'sc-menu__text', h('span', 'sc-menu__title', title), h('span', 'sc-menu__line', line), extra ?? null), icon(ChevronRight, 'sc-menu__chev'));
    b.addEventListener('click', () => run(action));
    return b;
  }

  function render(): void {
    const s = settings.get();
    const mine = library.list().filter((t) => t.source === 'user').length;
    clear(body);
    const menu = h('div', 'sc-menu');
    const free = item('free', SlidersHorizontal, 'var(--violet)', 'FREE PLAY', 'Just you and the decks. No score.');
    const party = item('party', Users, 'var(--cyan)', 'PARTY MODE', 'Play together · phones as pads.');
    party.classList.add('pt-homeparty');
    party.querySelector('.sc-menu__title')?.appendChild(h('span', 'sc-tag pt-homeparty__new', 'NEW'));
    const music = item(
      'music',
      ListMusic,
      'var(--pink)',
      'MY MUSIC',
      mine > 0 ? `${mine} of your own song${mine === 1 ? '' : 's'} loaded. Add more.` : 'DJ with your own songs.',
    );
    if (!s.tutorialDone) {
      add(body, hero('learn'));
      add(menu, item('gig', Disc3, 'var(--cyan)', 'PLAY A GIG', 'Three tracks, one crowd, a grade at the end.', bestLine()), party, free, music);
    } else {
      add(body, hero('gig'));
      add(menu, party, free, music, item('learn', GraduationCap, 'var(--gold)', 'LEARN TO DJ', 'Replay the 2-minute lesson.'));
    }
    const how = button({ className: 'sc-link', icon: CircleHelp, label: 'How to play', onTap: () => nav.go('howto') });
    how.dataset.act = 'howto';
    if (!s.seenHowTo) how.appendChild(h('span', 'sc-dot'));
    add(body, menu, h('div', 'sc-home__foot', how));
  }

  return {
    el,
    enter() {
      render();
      body.scrollTop = 0;
      // opened from a party invite (?room=CODE): straight on to joining, once the title's tap has unlocked the sound
      const code = takeRoomInvite();
      if (code) window.setTimeout(() => nav.current === 'home' && nav.go('party', { code }), 0);
    },
  };
}
