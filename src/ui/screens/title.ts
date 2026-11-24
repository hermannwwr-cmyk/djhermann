/**
 * Title screen: the logo, a turntable in the club's light and TAP TO START.
 * The tap is the first user gesture, so it is where the audio engine gets unlocked.
 */
import { Headphones, Play } from 'lucide-static';
import type { AppContext, Screen } from '../../core/types';
import { add, h, icon } from './dom';
import { drawPlatter, drawRecord, drawSheen, drawTonearm } from './record';

/** If the engine has not answered by then, go on anyway: the game screen unlocks again. */
const UNLOCK_TIMEOUT_MS = 6000;

export function createTitleScreen(ctx: AppContext): Screen<undefined> {
  const el = h('div', 'sc-screen sc-title');

  // light beams behind everything
  const beams = h('div', 'sc-title__beams', h('i', 'sc-title__beam'), h('i', 'sc-title__beam'), h('i', 'sc-title__beam'));

  // the turntable, drawn once and animated by CSS
  const deck = h('div', 'sc-title__deck');
  const tt = h('div', 'sc-tt');
  deck.appendChild(tt);
  let heroBuilt = false;
  function buildHero(): void {
    if (heroBuilt) return;
    heroBuilt = true;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const plane = Math.min(760, el.clientWidth * 1.68 || 660) * dpr;
    const platter = h('div', 'sc-tt__platter', drawPlatter(plane * 0.77, 72 / 77));
    const record = h('div', 'sc-tt__record', drawRecord(Math.min(1400, plane * 0.72)));
    const sheen = h('div', 'sc-tt__sheen', drawSheen(Math.min(1400, plane * 0.72)));
    const armCanvas = drawTonearm(Math.min(1400, plane), 0.9, 0.2, 0.735, 0.415);
    const shadowCanvas = document.createElement('canvas');
    shadowCanvas.width = shadowCanvas.height = Math.round(armCanvas.width / 3);
    shadowCanvas.getContext('2d')!.drawImage(armCanvas, 0, 0, shadowCanvas.width, shadowCanvas.height);
    add(tt, h('div', 'sc-tt__plinth'), h('div', 'sc-tt__glow'));
    // the platter's side: a few discs stacked 3 px apart read as a solid rim
    for (let i = 0; i < 4; i++) {
      const rim = h('div', 'sc-tt__rim');
      rim.style.transform = `translateZ(${2 + i * 3}px)`;
      tt.appendChild(rim);
    }
    add(tt, platter, record, sheen, h('div', 'sc-tt__armshadow', shadowCanvas), h('div', 'sc-tt__arm', armCanvas));
  }

  const brand = h(
    'header',
    'sc-title__brand',
    h('h1', 'sc-logo', h('span', 'sc-logo__dj', 'DJ'), nameSpan()),
    tagline(),
  );

  const label = h('span', null, 'TAP TO START');
  const cta = h('span', 'sc-title__cta', icon(Play), label);
  const hintText = h('span', null, 'Best with headphones');
  const hint = h('span', 'sc-title__hint', icon(Headphones), hintText);
  const tap = h('button', 'sc-title__tap', cta, hint);
  tap.type = 'button';
  tap.setAttribute('aria-label', 'Tap to start');

  add(el, beams, deck, h('div', 'sc-title__fade'), brand, tap);

  let busy = false;
  let failures = 0;

  function setState(state: 'idle' | 'busy' | 'error'): void {
    el.classList.toggle('sc-title--busy', state === 'busy');
    el.classList.toggle('sc-title--error', state === 'error');
    label.textContent = state === 'busy' ? 'STARTING' : state === 'error' ? 'TAP AGAIN' : 'TAP TO START';
    hintText.textContent =
      state === 'error' ? 'The sound did not start. Tap once more.' : state === 'busy' ? 'Warming up the decks' : 'Best with headphones';
  }

  async function start(): Promise<void> {
    if (busy) return;
    busy = true;
    setState('busy');
    let ok = true;
    try {
      // must be called right here, inside the tap, or the browser keeps the sound locked
      const unlocking = ctx.engine.unlock();
      const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), UNLOCK_TIMEOUT_MS));
      const result = await Promise.race([unlocking.then(() => 'ok' as const), timeout]);
      if (result === 'timeout') console.warn('[title] audio is taking long to start; carrying on');
    } catch (err) {
      console.error('[title] could not unlock audio', err);
      ok = false;
    }
    busy = false;
    if (ctx.nav.current !== 'title') return;
    if (!ok && failures === 0) {
      // give the player one more try before carrying on without sound
      failures++;
      setState('error');
      return;
    }
    ctx.nav.go('home');
  }

  tap.addEventListener('click', () => void start());

  return {
    el,
    enter() {
      buildHero();
      busy = false;
      failures = 0;
      setState('idle');
    },
    // the device back button must not skip the tap that unlocks the sound
    back: () => true,
  };
}

function nameSpan(): HTMLSpanElement {
  const s = h('span', 'sc-logo__name', 'HERMANN');
  s.dataset.text = 'HERMANN';
  return s;
}

function tagline(): HTMLParagraphElement {
  const p = h('p', 'sc-title__tag');
  const parts = ['Mix the set', 'Hit the pads', 'Move the crowd'];
  parts.forEach((part, i) => {
    if (i > 0) p.appendChild(h('i', null, '/'));
    p.appendChild(document.createTextNode(part));
  });
  return p;
}
