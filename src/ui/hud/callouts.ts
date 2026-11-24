/**
 * Callouts: the big shouts over the playfield ("TRAINWRECK!", "DEAD AIR", "DROP!", a rescue) and
 * combo milestones. Short, loud, gone in about a second, and kept in the upper part of the
 * playfield so they never sit on the hit line. Takes no input.
 */
import type { GameBus } from '../../core/events';
import type { CalloutKind, CalloutTone, Component, SettingsStore } from '../../core/types';
import { canVibrate, el, play, reducedMotion } from './dom';

export interface CalloutsDeps {
  bus: GameBus;
  settings: SettingsStore;
}

const SPRING = 'cubic-bezier(0.34, 1.56, 0.64, 1)';
const OUT = 'cubic-bezier(0.16, 1, 0.3, 1)';
/** Unbounded 900 capitals are about this wide per character, in em */
const CHAR_EM = 0.86;

interface Shout {
  el: HTMLElement;
  kind: CalloutKind;
}

export function createCallouts(deps: CalloutsDeps): Component {
  const { bus, settings } = deps;
  const root = el('div', 'hud-callouts');
  root.setAttribute('aria-live', 'polite');
  const vignette = el('div', 'hud-callouts__vignette');
  root.appendChild(vignette);

  let w = 0;
  let h = 0;
  const ro = new ResizeObserver(() => {
    w = root.clientWidth;
    h = root.clientHeight;
  });
  ro.observe(root);

  const live: Shout[] = [];
  let lastComboAt = -1e9;

  function remove(shout: Shout): void {
    const i = live.indexOf(shout);
    if (i >= 0) live.splice(i, 1);
    shout.el.remove();
  }

  function shout(kind: CalloutKind, text: string, tone: CalloutTone, sub = ''): void {
    const lowFx = settings.get().lowFx || reducedMotion();
    // an older shout steps aside: up and out, fast
    for (const old of [...live]) {
      void play(old.el, [{ opacity: 1 }, { opacity: 0, transform: 'translate(-50%, -150%) scale(0.8)' }], {
        duration: 160,
        easing: 'ease-in',
        fill: 'forwards',
      }).then(() => remove(old));
    }

    const node = el('div', 'hud-shout');
    node.dataset.tone = tone;
    node.dataset.kind = kind;
    const width = w || 360;
    const height = h || 240;
    const base = Math.min(46, Math.max(22, Math.min(width * 0.115, height * 0.24)));
    const size = Math.max(16, Math.min(base, (width - 28) / (Math.max(4, text.length) * CHAR_EM)));
    node.style.fontSize = `${size.toFixed(1)}px`;
    if (!lowFx && (kind === 'drop' || kind === 'combo' || tone === 'good')) node.appendChild(el('div', 'hud-shout__rays'));
    node.appendChild(el('div', 'hud-shout__text', text));
    if (sub) node.appendChild(el('div', 'hud-shout__sub', sub));
    root.appendChild(node);
    const entry: Shout = { el: node, kind };
    live.push(entry);

    const bad = tone === 'bad';
    const hold = bad ? 1250 : kind === 'drop' ? 1150 : 1000;
    const at = 'translate(-50%, -50%)';
    const frames: Keyframe[] = bad
      ? [
          { transform: `${at} scale(1.5)`, opacity: 0, offset: 0 },
          { transform: `${at} scale(1) translateX(0)`, opacity: 1, offset: 0.1 },
          { transform: `${at} translateX(-7px) rotate(-1.5deg)`, opacity: 1, offset: 0.16 },
          { transform: `${at} translateX(6px) rotate(1.2deg)`, opacity: 1, offset: 0.22 },
          { transform: `${at} translateX(-4px)`, opacity: 1, offset: 0.28 },
          { transform: `${at} translateX(0)`, opacity: 1, offset: 0.34 },
          { transform: `${at} translateY(0)`, opacity: 1, offset: 0.78 },
          { transform: `${at} translateY(10px) scale(0.96)`, opacity: 0, offset: 1 },
        ]
      : [
          { transform: `${at} scale(0.4)`, opacity: 0, offset: 0, easing: SPRING },
          { transform: `${at} scale(1)`, opacity: 1, offset: 0.22, easing: 'linear' },
          { transform: `${at} scale(1.04)`, opacity: 1, offset: 0.74, easing: OUT },
          { transform: `${at} translateY(-22px) scale(1.1)`, opacity: 0, offset: 1 },
        ];
    void play(node, frames, { duration: hold, fill: 'forwards' }).then(() => remove(entry));

    if (bad) {
      void play(vignette, [{ opacity: 0 }, { opacity: 1, offset: 0.12 }, { opacity: 0.7, offset: 0.5 }, { opacity: 0 }], {
        duration: 1100,
        easing: 'ease-out',
      });
      if (settings.get().haptics && canVibrate()) {
        try {
          navigator.vibrate([40, 50, 40]);
        } catch {
          /* not allowed: fine */
        }
      }
    }
  }

  const offs = [
    bus.on('callout', ({ kind, text, tone }) => {
      const now = performance.now();
      if (kind === 'combo') {
        // the rhythm module's milestone and the gig's own combo shout are the same moment
        if (now - lastComboAt < 500) return;
        lastComboAt = now;
      }
      shout(kind, text, tone);
    }),
    bus.on('combo:milestone', ({ combo, multiplier }) => {
      const now = performance.now();
      if (now - lastComboAt < 500) return;
      lastComboAt = now;
      shout('combo', `×${multiplier}`, 'good', `${combo} COMBO`);
    }),
  ];

  return {
    el: root,
    update() {
      /* everything here is event driven and animated by the browser */
    },
    destroy() {
      for (const off of offs) off();
      ro.disconnect();
      root.remove();
    },
  };
}
