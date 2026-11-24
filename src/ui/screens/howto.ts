/**
 * How to play: five swipeable cards, each a drawn picture and two plain lines. Swipe (native
 * scroll snapping) or use NEXT; the dots show where you are.
 */
import { ArrowRight, Check, VolumeX, Waves } from 'lucide-static';
import type { AppContext, Screen } from '../../core/types';
import { add, art, button, h, icon } from './dom';
import type { Child } from './dom';
import { crowdArt, missionArt, mixArt, ownMusicArt, padsArt } from './howto-art';
import { dismissTopLayer, topBar } from './ui';

interface Card {
  art: () => string;
  kicker: string;
  title: string;
  body: Child[];
  extra?: () => HTMLElement;
}

/** Built when the screen is first shown (the lines hold DOM nodes). */
const makeCards = (): Card[] => [
  {
    art: padsArt,
    kicker: 'The pads',
    title: 'Hit the pads on the line',
    body: ['Notes slide down four lanes. Tap the pad under a note ', h('b', null, 'when it reaches the line'), '.'],
  },
  {
    art: missionArt,
    kicker: 'Missions',
    title: 'Do what the mission says',
    body: ['The line at the top tells you what to do. ', h('b', null, 'The glowing control is the one to use.')],
  },
  {
    art: mixArt,
    kicker: 'Mixing',
    title: 'Mix in three moves',
    body: [
      h('b', null, 'Start'),
      ' the other deck, ',
      h('b', null, 'match'),
      ' its speed (SYNC can do it for you), then ',
      h('b', null, 'slide'),
      ' the crossfader over.',
    ],
  },
  {
    art: crowdArt,
    kicker: 'The crowd',
    title: 'Keep the crowd hyped',
    body: ['Good hits and smooth mixes fill the hype meter. Two things empty the floor:'],
    extra: () =>
      h(
        'ul',
        'sc-how__avoid',
        h('li', null, icon(VolumeX), h('span', null, h('b', null, 'Silence.'), ' Always keep a track playing.')),
        h('li', null, icon(Waves), h('span', null, h('b', null, 'Clashing beats.'), ' Match the speeds before you slide over.')),
      ),
  },
  {
    art: ownMusicArt,
    kicker: 'Your music',
    title: 'Bring your own music',
    body: ['Load songs from your phone in ', h('b', null, 'My Music'), '. They stay on this device and are never uploaded.'],
  },
];

export function createHowToScreen(ctx: AppContext): Screen<undefined> {
  const { nav, settings } = ctx;
  const el = h('div', 'sc-screen sc-how');

  const track = h('div', 'sc-how__track');
  const dots = h('div', 'sc-how__dots');
  dots.setAttribute('role', 'tablist');
  const cards: HTMLElement[] = [];
  const dotEls: HTMLButtonElement[] = [];
  const CARDS = makeCards();

  CARDS.forEach((c, i) => {
    const card = h(
      'section',
      'sc-how__card',
      h('div', 'sc-how__art', art(c.art(), 'sc-how__svg')),
      h(
        'div',
        'sc-how__text',
        h('div', 'sc-how__kicker', h('span', 'sc-how__n ui-num', String(i + 1)), c.kicker),
        h('h2', 'sc-how__title', c.title),
        h('p', 'sc-how__body', ...c.body),
        c.extra?.() ?? null,
      ),
    );
    card.setAttribute('aria-label', `${i + 1} of ${CARDS.length}: ${c.title}`);
    card.dataset.card = String(i);
    cards.push(card);
    track.appendChild(card);
    const dot = h('button', 'sc-how__dot');
    dot.type = 'button';
    dot.setAttribute('aria-label', `Card ${i + 1}`);
    dot.addEventListener('click', () => goTo(i));
    dotEls.push(dot);
    dots.appendChild(dot);
  });

  const nextLabel = h('span', null, 'NEXT');
  const nextIcon = h('span', 'sc-how__nexticon', icon(ArrowRight));
  const next = h('button', 'ui-btn ui-btn--primary ui-btn--lg sc-how__next', nextLabel, nextIcon);
  next.type = 'button';
  next.dataset.act = 'next';
  const skip = button({ className: 'sc-link', label: 'Skip', onTap: () => finish() });
  skip.dataset.act = 'skip';

  add(el, topBar('How to play', () => nav.back(), skip), track, h('footer', 'sc-foot sc-how__foot', dots, next));

  let index = 0;

  function goTo(i: number, smooth = true): void {
    const target = cards[Math.max(0, Math.min(cards.length - 1, i))];
    track.scrollTo({ left: target.offsetLeft - track.offsetLeft, behavior: smooth ? 'smooth' : 'auto' });
    setIndex(i);
  }

  function setIndex(i: number): void {
    index = Math.max(0, Math.min(cards.length - 1, i));
    cards.forEach((c, k) => c.classList.toggle('sc-how__card--on', k === index));
    dotEls.forEach((d, k) => d.setAttribute('aria-current', String(k === index)));
    const last = index === cards.length - 1;
    nextLabel.textContent = last ? "LET'S PLAY" : 'NEXT';
    nextIcon.replaceChildren(icon(last ? Check : ArrowRight));
    skip.hidden = last;
    if (last && !settings.get().seenHowTo) settings.set({ seenHowTo: true });
  }

  function finish(): void {
    if (!settings.get().seenHowTo) settings.set({ seenHowTo: true });
    nav.back();
  }

  let raf = 0;
  track.addEventListener(
    'scroll',
    () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
        if (i !== index) setIndex(i);
      });
    },
    { passive: true },
  );

  next.addEventListener('click', () => {
    if (index >= cards.length - 1) finish();
    else goTo(index + 1);
  });

  el.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') goTo(index + 1);
    else if (e.key === 'ArrowLeft') goTo(index - 1);
  });

  return {
    el,
    enter() {
      requestAnimationFrame(() => goTo(0, false));
      setIndex(0);
    },
    back: () => dismissTopLayer(el),
  };
}
