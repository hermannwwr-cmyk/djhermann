/**
 * A brief full-width card for the big moments ("GET READY", "SET COMPLETE!", "THE CROWD LEFT"):
 * animates in, holds, animates out, then resolves. It never takes input.
 */
import { el, play, reducedMotion, sleep } from './dom';

export interface CardOptions {
  title: string;
  subtitle?: string;
  tone?: 'good' | 'bad' | 'info';
  /** how long the card holds between its entrance and its exit (default 1400) */
  ms?: number;
}

const OUT = 'cubic-bezier(0.16, 1, 0.3, 1)';
const SPRING = 'cubic-bezier(0.34, 1.4, 0.64, 1)';

export async function showCard(host: HTMLElement, card: CardOptions): Promise<void> {
  const quick = reducedMotion();
  const root = el('div', 'hud-card');
  root.dataset.tone = card.tone ?? 'info';
  root.setAttribute('role', 'status');
  const shade = el('div', 'hud-card__shade');
  const band = el('div', 'hud-card__band');
  const shine = el('div', 'hud-card__shine');
  const title = el('div', 'hud-card__title', card.title);
  band.append(shine, title);
  let sub: HTMLElement | null = null;
  if (card.subtitle) {
    sub = el('div', 'hud-card__sub', card.subtitle);
    band.appendChild(sub);
  }
  root.append(shade, band);
  host.appendChild(root);

  // long titles shrink to fit the width
  const room = band.clientWidth - 32;
  if (room > 0 && title.scrollWidth > room) {
    const size = parseFloat(getComputedStyle(title).fontSize) || 30;
    title.style.fontSize = `${Math.max(16, Math.floor((size * room) / title.scrollWidth))}px`;
  }

  const k = quick ? 0.01 : 1;
  const inMs = 360 * k;
  void play(shade, [{ opacity: 0 }, { opacity: 1 }], { duration: inMs, fill: 'both' });
  void play(band, [{ transform: 'scaleY(0.02)', opacity: 0 }, { transform: 'scaleY(1)', opacity: 1 }], {
    duration: inMs,
    easing: OUT,
    fill: 'both',
  });
  void play(title, [{ transform: 'translateX(-46px) scale(1.12)', opacity: 0 }, { transform: 'none', opacity: 1 }], {
    duration: 420 * k,
    delay: 90 * k,
    easing: SPRING,
    fill: 'both',
  });
  if (sub) {
    void play(sub, [{ transform: 'translateY(8px)', opacity: 0 }, { transform: 'none', opacity: 1 }], {
      duration: 320 * k,
      delay: 220 * k,
      easing: OUT,
      fill: 'both',
    });
  }
  void play(shine, [{ transform: 'translateX(-120%) skewX(-20deg)' }, { transform: 'translateX(220%) skewX(-20deg)' }], {
    duration: 900 * k,
    delay: 200 * k,
    easing: 'ease-out',
    fill: 'both',
  });

  await sleep(inMs + Math.max(0, card.ms ?? 1400));

  const outMs = 260 * k;
  void play(title, [{ transform: 'none', opacity: 1 }, { transform: 'translateX(40px)', opacity: 0 }], {
    duration: outMs * 0.8,
    easing: 'ease-in',
    fill: 'both',
  });
  if (sub) void play(sub, [{ opacity: 1 }, { opacity: 0 }], { duration: outMs * 0.6, fill: 'both' });
  void play(shade, [{ opacity: 1 }, { opacity: 0 }], { duration: outMs, fill: 'both' });
  await play(band, [{ transform: 'scaleY(1)', opacity: 1 }, { transform: 'scaleY(0.02)', opacity: 0 }], {
    duration: outMs,
    easing: 'ease-in',
    fill: 'both',
  });
  root.remove();
}
