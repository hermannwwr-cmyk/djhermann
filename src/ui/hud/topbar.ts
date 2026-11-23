/**
 * The top bar: the stage (crowd + lights, the hype made visible) behind the score, combo, hype
 * meter, gig progress and pause button, with the mission line under it.
 */
import { Flame, Pause } from 'lucide-static';
import type { GameBus } from '../../core/events';
import type { Component, FrameState, GameMode, SettingsStore } from '../../core/types';
import { formatScore, stepCount } from './counter';
import { el, iconEl, play } from './dom';
import { createMissionLine } from './mission-line';
import { createStage } from './stage';
import { hypeZone } from './stage-model';
import type { HypeZone } from './stage-model';

export interface TopBarDeps {
  bus: GameBus;
  settings: SettingsStore;
  onPause: () => void;
}

const SPRING = 'cubic-bezier(0.34, 1.56, 0.64, 1)';
const ZONE_TEXT: Record<HypeZone, string> = { low: 'LOSING THEM', mid: '', fire: 'ON FIRE' };

/** multiplier → badge level (styles the badge: ×1 quiet, then along the aurora, gold from ×5) */
const multLevel = (m: number): string => (m <= 1 ? '1' : m >= 5 ? '5' : String(Math.floor(m)));

export function createTopBar(deps: TopBarDeps): Component {
  const { bus, settings } = deps;

  // ── DOM ──
  const root = el('div', 'hud-top');
  root.dataset.mode = 'gig';
  const stageBox = el('div', 'hud-stage');
  const canvas = el('canvas', 'hud-stage__canvas');
  const bar = el('div', 'hud-bar');

  const score = el('div', 'hud-score');
  const scoreLabel = el('div', 'hud-label hud-score__label', 'SCORE');
  const scoreValue = el('div', 'hud-score__value', '0');
  const free = el('div', 'hud-score__free', 'FREE PLAY');
  const combo = el('div', 'hud-combo');
  combo.dataset.cold = '1';
  const mult = el('span', 'hud-mult', '×1');
  mult.dataset.level = '1';
  const multRing = el('span', 'hud-mult__ring');
  const comboN = el('span', 'hud-combo__n', '0');
  const comboL = el('span', 'hud-combo__l', 'COMBO');
  const multWrap = el('span', 'hud-mult__wrap');
  multWrap.append(multRing, mult);
  combo.append(multWrap, comboN, comboL);
  score.append(scoreLabel, scoreValue, free, combo);

  const hype = el('div', 'hud-hype');
  hype.dataset.zone = 'mid';
  const hypeHead = el('div', 'hud-hype__head');
  const hypeLabel = el('span', 'hud-label', 'HYPE');
  const hypeState = el('span', 'hud-hype__state');
  const hypeFlame = iconEl(Flame, 'hud-hype__flame');
  const hypeText = el('span', '', '');
  hypeState.append(hypeFlame, hypeText);
  hypeHead.append(hypeLabel, hypeState);
  const hypeSlot = el('div', 'hud-hype__slot');
  hypeSlot.setAttribute('role', 'meter');
  hypeSlot.setAttribute('aria-label', 'Crowd hype');
  hype.append(hypeHead, hypeSlot);

  const pauseBtn = el('button', 'hud-pausebtn');
  pauseBtn.type = 'button';
  pauseBtn.setAttribute('aria-label', 'Pause');
  const pauseFace = el('span', 'hud-pausebtn__face');
  pauseFace.appendChild(iconEl(Pause));
  pauseBtn.appendChild(pauseFace);
  pauseBtn.addEventListener('click', () => deps.onPause());

  bar.append(score, hype, pauseBtn);

  const setEl = el('div', 'hud-set');
  const setLabel = el('span', 'hud-set__label', 'TRACK');
  const setValue = el('span', 'hud-set__value', '');
  setEl.append(setLabel, setValue);
  const gig = el('div', 'hud-gig');
  const gigFill = el('i');
  const gigDot = el('b');
  gig.append(gigFill, gigDot);

  stageBox.append(canvas, bar, setEl, gig);
  const mission = createMissionLine();
  root.append(stageBox, mission.el);

  const stage = createStage(canvas);

  // ── layout ──
  let w = 0;
  function measure(): void {
    w = stageBox.clientWidth;
    const h = stageBox.clientHeight;
    root.dataset.compact = h - bar.offsetTop < 58 ? '1' : '0';
    stage.resize(w, h, bar.offsetTop);
    // offset* (not client rects): the slot must be right even while the screen is mid-transition
    stage.setMeter(
      hypeSlot.offsetWidth > 0
        ? {
            x: bar.offsetLeft + hypeSlot.offsetLeft,
            y: bar.offsetTop + hypeSlot.offsetTop,
            w: hypeSlot.offsetWidth,
            h: hypeSlot.offsetHeight,
          }
        : null,
    );
    mission.resize(w);
    shownProgress = -1;
  }
  const ro = new ResizeObserver(measure);
  ro.observe(root);
  ro.observe(hypeSlot);

  // ── state on screen ──
  let mode: GameMode = 'gig';
  let shown = 0;
  let shownInt = 0;
  let shownLen = 1;
  let lastScore = 0;
  let bump = 0;
  let bumped = false;
  let shownCombo = 0;
  let shownMult = 1;
  let zone: HypeZone = 'mid';
  let shownSetIndex = -1;
  let shownSetCount = -1;
  let shownProgress = -1;
  let hasProgress = false;
  let lastDropAt = -1e9;

  function burstOfLight(strength: number): void {
    const now = performance.now();
    if (now - lastDropAt < 600) return; // the section event and the callout for the same drop
    lastDropAt = now;
    stage.mood.flash(strength);
    if (!settings.get().lowFx) stage.confettiBurst(10);
  }

  const offs = [
    bus.on('combo:milestone', ({ multiplier }) => {
      void play(mult, [{ transform: 'scale(1)' }, { transform: 'scale(1.75)', offset: 0.32 }, { transform: 'scale(1)' }], {
        duration: 560,
        easing: SPRING,
      });
      void play(
        multRing,
        [
          { transform: 'scale(0.7)', opacity: 0.95 },
          { transform: 'scale(2.6)', opacity: 0 },
        ],
        { duration: 620, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
      );
      stage.sparkle(3 + Math.min(6, multiplier * 2));
    }),
    bus.on('combo:break', ({ combo: lost }) => {
      if (lost < 4) return;
      void play(
        combo,
        [
          { transform: 'translateX(0)' },
          { transform: 'translateX(-4px)' },
          { transform: 'translateX(4px)' },
          { transform: 'translateX(-2px)' },
          { transform: 'translateX(0)' },
        ],
        { duration: 300, easing: 'ease-out' },
      );
    }),
    bus.on('mission:end', ({ result }) => {
      mission.showResult(result);
      const m = stage.mood;
      if (result.rating === 'fail') {
        m.sag(1);
      } else {
        m.applaud(result.rating === 'perfect' ? 1 : result.rating === 'great' ? 0.75 : 0.45);
        if (!settings.get().lowFx) {
          stage.sparkle(result.rating === 'perfect' ? 8 : 4);
          if (result.rating === 'perfect') stage.confettiBurst(18);
        }
      }
    }),
    bus.on('callout', ({ kind, tone }) => {
      const m = stage.mood;
      if (kind === 'trainwreck' || kind === 'deadair') m.sicken();
      else if (kind === 'rescue') {
        m.recover();
        m.applaud(0.6);
      } else if (kind === 'drop') burstOfLight(1);
      else if (kind === 'mix' && tone === 'good') m.applaud(0.4);
    }),
    bus.on('section', ({ kind, energy }) => {
      stage.setEnergy(energy);
      if (kind === 'drop') burstOfLight(0.6 + 0.4 * energy);
    }),
  ];

  return {
    el: root,

    update(frame: FrameState) {
      if (!w) return;
      const hud = frame.hud;

      if (hud.mode !== mode) {
        mode = hud.mode;
        root.dataset.mode = mode;
      }

      // score: counts up, with a little bump when points come in
      if (mode === 'gig') {
        if (hud.score > lastScore) bump = 1;
        lastScore = hud.score;
        shown = stepCount(shown, hud.score, frame.dt);
        const r = Math.round(shown);
        if (r !== shownInt) {
          shownInt = r;
          const text = formatScore(r);
          scoreValue.textContent = text;
          if (text.length !== shownLen) {
            shownLen = text.length;
            scoreValue.dataset.long = text.length >= 10 ? '2' : text.length >= 9 ? '1' : '0';
          }
        }
        if (bump > 0.004) {
          bump *= Math.pow(0.5, frame.dt / 0.09);
          scoreValue.style.transform = `scale(${(1 + 0.075 * bump).toFixed(4)})`;
          bumped = true;
        } else if (bumped) {
          bumped = false;
          bump = 0;
          scoreValue.style.transform = '';
        }
      }

      if (hud.combo !== shownCombo) {
        shownCombo = hud.combo;
        comboN.textContent = String(hud.combo);
        combo.dataset.cold = hud.combo > 0 ? '0' : '1';
      }
      if (hud.multiplier !== shownMult) {
        shownMult = hud.multiplier;
        mult.textContent = `×${hud.multiplier}`;
        mult.dataset.level = multLevel(hud.multiplier);
      }

      const z = hypeZone(hud.hype, zone);
      if (z !== zone) {
        zone = z;
        hype.dataset.zone = z;
        hypeText.textContent = ZONE_TEXT[z];
      }

      const set = hud.set;
      const si = set ? set.index : -1;
      const sc = set ? set.count : -1;
      if (si !== shownSetIndex || sc !== shownSetCount) {
        shownSetIndex = si;
        shownSetCount = sc;
        setEl.dataset.on = set ? '1' : '0';
        setValue.textContent = set ? `${set.index + 1}/${set.count}` : '';
      }

      const p = hud.progress;
      if ((p !== null) !== hasProgress) {
        hasProgress = p !== null;
        gig.dataset.on = hasProgress ? '1' : '0';
        shownProgress = -1;
      }
      if (p !== null && Math.abs(p - shownProgress) > 0.0005) {
        shownProgress = p;
        const c = Math.min(1, Math.max(0, p));
        gigFill.style.transform = `scaleX(${c.toFixed(4)})`;
        gigDot.style.transform = `translateX(${(c * w).toFixed(1)}px)`;
      }

      mission.update(frame);
      stage.draw(frame, settings.get().lowFx);
    },

    destroy() {
      for (const off of offs) off();
      ro.disconnect();
      root.remove();
    },
  };
}
