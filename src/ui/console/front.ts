/**
 * The front strip of the console, always visible: the two mini decks (buttons for the deck panels,
 * with records that really turn), the crossfader and the MIXER button.
 */
import type { DeckId, FrameState, PanelId, TrackMeta } from '../../core/types';
import { canvasDpr, deckColor, drawGlow, fitCanvas, rgba } from '../../theme/theme';
import type { Ctl, CtlEnv } from './controls';
import { createFader } from './controls';
import { h } from './gestures';
import { TAU, platterAngle } from './logic';
import { buildMiniDisc } from './platter-art';

export interface MiniDeck {
  readonly el: HTMLButtonElement;
  update(frame: FrameState, lowFx: boolean): void;
  destroy(): void;
}

/** A small turning record ringed by the track's progress. It is the button for its deck panel. */
export function createMiniDeck(deck: DeckId, onTap: () => void): MiniDeck {
  const color = deckColor(deck);
  const canvas = h('canvas', 'dk-mini-canvas');
  const led = h('i', 'dk-mini-led');
  const el = h(
    'button',
    `dk-mini dk-mini--${deck.toLowerCase()} ui-touch`,
    { type: 'button', 'data-tab': deck === 'A' ? 'deckA' : 'deckB', 'aria-label': `Deck ${deck}` },
    h('span', 'dk-mini-well', null, canvas),
    h('span', 'dk-mini-id', null, led, deck),
  );
  el.addEventListener('click', onTap);

  let size = 0;
  let sprite: HTMLCanvasElement | null = null;
  let gloss: HTMLCanvasElement | null = null;
  let spriteFor: TrackMeta | null | undefined;
  let spriteSize = 0;
  let lastKey = '';
  let ledOn = false;

  const ro = new ResizeObserver(() => {
    size = Math.floor(Math.min(canvas.clientWidth, canvas.clientHeight));
  });
  ro.observe(canvas);

  return {
    el,
    update(frame, lowFx) {
      const d = frame.decks[deck];
      const playing = d.playing || d.cuePreview || d.scratching;
      if (playing !== ledOn) {
        ledOn = playing;
        el.classList.toggle('dk-playing', playing);
      }
      if (size < 8) return;
      const dpr = canvasDpr();
      const discPx = Math.round((size - 8) * dpr);
      if (!sprite || spriteFor !== d.track || spriteSize !== discPx) {
        sprite = buildMiniDisc(discPx, color, d.track);
        gloss = buildGloss(discPx);
        spriteFor = d.track;
        spriteSize = discPx;
        lastKey = '';
      }
      const angle = d.track ? platterAngle(d.positionSec) % TAU : 0;
      const progress = d.track && d.durationSec > 0 ? Math.min(1, d.positionSec / d.durationSec) : 0;
      const live = frame.liveDeck === deck && !lowFx ? Math.round(frame.pulse * 8) : 0;
      const key = `${angle.toFixed(3)}|${progress.toFixed(3)}|${live}|${playing ? 1 : 0}`;
      if (key === lastKey) return;
      lastKey = key;

      const ctx = fitCanvas(canvas, size, size, dpr);
      const c = size / 2;
      ctx.clearRect(0, 0, size, size);
      // progress ring: a dim track and the played part in the deck colour
      ctx.lineCap = 'round';
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = rgba(color, 0.16);
      ctx.beginPath();
      ctx.arc(c, c, c - 1.6, 0, TAU);
      ctx.stroke();
      if (progress > 0.002) {
        ctx.strokeStyle = rgba(color, playing ? 0.95 : 0.55);
        ctx.beginPath();
        ctx.arc(c, c, c - 1.6, -Math.PI / 2, -Math.PI / 2 + progress * TAU);
        ctx.stroke();
      }
      if (live > 0) drawGlow(ctx, c, c, c * 0.9, color, 0.22 * frame.pulse);
      ctx.save();
      ctx.translate(c, c);
      ctx.rotate(angle);
      const r = (size - 8) / 2;
      ctx.drawImage(sprite, -r, -r, r * 2, r * 2);
      ctx.restore();
      // fixed light (does not turn) and the spindle
      if (gloss) ctx.drawImage(gloss, c - r, c - r, r * 2, r * 2);
    },
    destroy() {
      el.removeEventListener('click', onTap);
      ro.disconnect();
    },
  };
}

/** Light that stays put on the mini record: a glossy wedge and the spindle. */
function buildGloss(px: number): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = cv.height = Math.max(2, px);
  const g = cv.getContext('2d')!;
  const c = cv.width / 2;
  const sheen = g.createLinearGradient(0, 0, cv.width, cv.height);
  sheen.addColorStop(0, 'rgba(255,255,255,0.16)');
  sheen.addColorStop(0.42, 'rgba(255,255,255,0)');
  sheen.addColorStop(0.75, 'rgba(0,0,0,0)');
  sheen.addColorStop(1, 'rgba(0,0,0,0.25)');
  g.fillStyle = sheen;
  g.beginPath();
  g.arc(c, c, c, 0, TAU);
  g.fill();
  const sr = Math.max(1.5, c * 0.075);
  const sp = g.createRadialGradient(c - sr * 0.3, c - sr * 0.3, 0, c, c, sr);
  sp.addColorStop(0, '#ffffff');
  sp.addColorStop(0.5, '#b9b9c8');
  sp.addColorStop(1, '#4a4a58');
  g.fillStyle = sp;
  g.beginPath();
  g.arc(c, c, sr, 0, TAU);
  g.fill();
  return cv;
}

export interface FrontStrip {
  readonly el: HTMLElement;
  setActive(id: PanelId | null): void;
  update(frame: FrameState, lowFx: boolean): void;
  destroy(): void;
}

const ICON_MIXER =
  '<svg viewBox="0 0 20 16" aria-hidden="true"><rect x="3" y="1" width="2" height="14" rx="1"/><rect x="9" y="1" width="2" height="14" rx="1"/><rect x="15" y="1" width="2" height="14" rx="1"/><rect x="1.5" y="9" width="5" height="3.2" rx="1"/><rect x="7.5" y="3.5" width="5" height="3.2" rx="1"/><rect x="13.5" y="7" width="5" height="3.2" rx="1"/></svg>';

export function createFrontStrip(env: CtlEnv & { setXfader(v: number): void }, onTab: (id: PanelId) => void): FrontStrip {
  const miniA = createMiniDeck('A', () => onTab('deckA'));
  const miniB = createMiniDeck('B', () => onTab('deckB'));

  const xfader: Ctl = createFader(env, {
    id: 'xfader',
    orient: 'h',
    cls: 'dk-fader--x',
    capLen: 26,
    read: (f) => f.mixer.crossfader,
    write: (n) => env.setXfader(n),
    doubleTapReset: true,
    scale: Array.from({ length: 9 }, (_, i) => ({ at: -1 + i * 0.25, major: i === 0 || i === 4 || i === 8 })),
  });

  const mixerBtn = h('button', 'dk-tab-mixer ui-touch', { type: 'button', 'data-tab': 'mixer', 'aria-label': 'Mixer' });
  mixerBtn.innerHTML = `<i class="dk-led"></i>${ICON_MIXER}<span>MIXER</span>`;
  const onMixer = (): void => onTab('mixer');
  mixerBtn.addEventListener('click', onMixer);

  const centre = h(
    'div',
    'dk-front-mid',
    null,
    h('div', 'dk-front-row', null, mixerBtn),
    h(
      'div',
      'dk-xf',
      null,
      h('span', 'dk-xf-end dk-xf-end--a', null, 'A'),
      h('div', 'dk-xf-body', null, xfader.el, h('span', 'dk-legend dk-xf-legend', null, 'CROSSFADER')),
      h('span', 'dk-xf-end dk-xf-end--b', null, 'B'),
    ),
  );

  const el = h('div', 'dk-front', null, miniA.el, centre, miniB.el);
  const tabs: Record<PanelId, HTMLElement> = { deckA: miniA.el, mixer: mixerBtn, deckB: miniB.el };

  return {
    el,
    setActive(id) {
      for (const k of Object.keys(tabs) as PanelId[]) {
        const on = k === id;
        tabs[k].classList.toggle('dk-on', on);
        tabs[k].setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    },
    update(frame, lowFx) {
      miniA.update(frame, lowFx);
      miniB.update(frame, lowFx);
      xfader.update(frame);
    },
    destroy() {
      miniA.destroy();
      miniB.destroy();
      xfader.destroy();
      mixerBtn.removeEventListener('click', onMixer);
    },
  };
}
