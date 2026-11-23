/**
 * The mission line under the stage: the player's instruction. Shows the active mission's title and
 * hint, its progress (a wash that fills the strip) and its time left (a bar that drains along the
 * bottom edge); the status when there is no mission; and, for a moment, the result of the mission
 * that just ended.
 */
import { damp } from '../../core/math';
import { parseControl } from '../../core/controls';
import type { FrameState, Gesture, MissionResult, MissionView } from '../../core/types';
import { formatScore } from './counter';
import { el, iconEl, play } from './dom';
import { GESTURE_ICON, RATING_ICON } from './icons';
import { MissionLineState, RATING_WORD, splitInstruction, timeUrgency } from './mission-state';
import type { LineMode } from './mission-state';

export interface MissionLine {
  readonly el: HTMLElement;
  update(frame: FrameState): void;
  /** a mission ended: flash its result before moving on */
  showResult(result: MissionResult): void;
  /** the strip's width changed */
  resize(width: number): void;
}

const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)';

function setRich(target: HTMLElement, text: string, emphasiseCaps: boolean): void {
  target.textContent = '';
  for (const part of splitInstruction(text, emphasiseCaps)) {
    if (part.kind === 'plain') {
      target.appendChild(document.createTextNode(part.text));
    } else {
      const cls = part.kind === 'deckA' ? 'hud-deck-a' : part.kind === 'deckB' ? 'hud-deck-b' : 'hud-key';
      target.appendChild(el('span', cls, part.text));
    }
  }
}

/** Step the font down (data-fit 1, 2) until the line fits; past that it ends in an ellipsis. */
function fit(target: HTMLElement): void {
  target.dataset.fit = '0';
  if (target.scrollWidth <= target.clientWidth) return;
  target.dataset.fit = '1';
  if (target.scrollWidth <= target.clientWidth) return;
  target.dataset.fit = '2';
}

export function createMissionLine(): MissionLine {
  const root = el('div', 'hud-mission');
  root.dataset.mode = 'empty';
  const fill = el('div', 'hud-mission__fill');
  const edge = el('div', 'hud-mission__edge');
  const flash = el('div', 'hud-mission__flash');
  const body = el('div', 'hud-mission__body');
  const chip = el('div', 'hud-mission__chip');
  const chipIcon = iconEl('', 'hud-mission__icon');
  const eq = el('span', 'hud-mission__eq');
  eq.append(el('i'), el('i'), el('i'));
  chip.append(chipIcon, eq);
  const text = el('div', 'hud-mission__text');
  const title = el('div', 'hud-mission__title');
  const hint = el('div', 'hud-mission__hint');
  text.append(title, hint);
  const side = el('div', 'hud-mission__side');
  const pts = el('div', 'hud-mission__pts');
  const tag = el('div', 'hud-mission__tag');
  side.append(pts, tag);
  body.append(chip, text, side);
  const time = el('div', 'hud-mission__time');
  const timeBar = el('i');
  time.appendChild(timeBar);
  root.append(fill, edge, flash, body, time);
  root.setAttribute('role', 'status');

  const state = new MissionLineState();
  /** a result was rendered by an event; its clock starts at the next frame (one time base: frame.now) */
  let resultPending = false;
  let width = 0;
  let mode: LineMode = 'empty';
  // what is on the line now
  let shownId = -1;
  let shownTitle = '';
  let shownHint = '';
  let shownGesture: Gesture | '' = '';
  let shownPoints = -1;
  let shownStatus = '';
  let shownUrgency = '';
  let shownTime = -1;
  let shownDeck = '';
  // progress wash
  let prog = 0;
  let progShown = -1;
  let progOn = false;

  function setIcon(svg: string): void {
    chipIcon.innerHTML = svg;
  }

  function intro(strong: boolean): void {
    void play(body, [{ transform: 'translateY(10px)', opacity: 0 }, { transform: 'none', opacity: 1 }], {
      duration: 260,
      easing: EASE_OUT,
    });
    void play(
      flash,
      [
        { transform: 'translateX(-110%) skewX(-18deg)', opacity: strong ? 0.95 : 0.55 },
        { transform: 'translateX(110%) skewX(-18deg)', opacity: 0 },
      ],
      { duration: strong ? 620 : 460, easing: 'cubic-bezier(0.3, 0.6, 0.3, 1)' },
    );
  }

  function setMode(next: LineMode): void {
    if (next === mode) return;
    mode = next;
    root.dataset.mode = next;
    if (next !== 'result') delete root.dataset.rating;
    if (next !== 'mission') {
      setProgress(null, 0);
      setTime(1);
      shownId = -1;
      shownDeck = '';
      delete root.dataset.deck;
      chip.style.transform = '';
    }
    if (next !== 'status') shownStatus = '';
  }

  function setProgress(target: number | null, dt: number): void {
    const on = target !== null;
    if (on !== progOn) {
      progOn = on;
      root.dataset.progress = on ? '1' : '0';
      if (on) prog = target ?? 0;
    }
    if (!on) return;
    prog = damp(prog, Math.min(1, Math.max(0, target ?? 0)), 0.06, dt);
    if (Math.abs(prog - progShown) < 0.0008) return;
    progShown = prog;
    fill.style.transform = `scaleX(${prog.toFixed(4)})`;
    edge.style.transform = `translateX(${(prog * width).toFixed(1)}px)`;
  }

  function setTime(timeLeft: number): void {
    const u = timeUrgency(timeLeft);
    if (u !== shownUrgency) {
      shownUrgency = u;
      root.dataset.time = u;
    }
    if (u === 'none') return;
    const t = Math.min(1, Math.max(0, timeLeft));
    if (Math.abs(t - shownTime) < 0.0008) return;
    shownTime = t;
    timeBar.style.transform = `scaleX(${t.toFixed(4)})`;
  }

  function renderMission(m: MissionView, animate: boolean): void {
    const gesture = m.targets.length ? m.targets[0].gesture : '';
    if (m.title !== shownTitle || mode !== 'mission') {
      setRich(title, m.title, false);
    }
    if (m.hint !== shownHint || mode !== 'mission') {
      setRich(hint, m.hint, true);
    }
    if (gesture !== shownGesture || mode !== 'mission') {
      setIcon(gesture ? GESTURE_ICON[gesture] : GESTURE_ICON.tap);
      chip.dataset.gesture = gesture;
    }
    // which side of the console the mission is on tints the strip's edge: A cyan, B pink
    const first = m.targets.length ? parseControl(m.targets[0].control) : null;
    const deck = first ? first.deck : '';
    if (deck !== shownDeck) {
      shownDeck = deck;
      if (deck) root.dataset.deck = deck;
      else delete root.dataset.deck;
    }
    shownId = m.id;
    shownTitle = m.title;
    shownHint = m.hint;
    shownGesture = gesture;
    shownPoints = -1;
    setMode('mission');
    fit(title);
    fit(hint);
    if (animate) intro(true);
  }

  return {
    el: root,

    showResult(result) {
      resultPending = true;
      setMode('result');
      root.dataset.rating = result.rating;
      setIcon(RATING_ICON[result.rating]);
      delete chip.dataset.gesture;
      const label = result.label || RATING_WORD[result.rating];
      title.textContent = label;
      hint.textContent = result.title && result.title !== label ? result.title : '';
      pts.textContent = `+${formatScore(result.points)}`;
      tag.textContent = RATING_WORD[result.rating];
      shownTitle = '';
      shownHint = '';
      shownGesture = '';
      shownPoints = -1;
      fit(title);
      fit(hint);
      void play(
        body,
        [
          { transform: 'scale(0.9)', opacity: 0 },
          { transform: 'scale(1.03)', opacity: 1, offset: 0.6 },
          { transform: 'none', opacity: 1 },
        ],
        { duration: 300, easing: EASE_OUT },
      );
      void play(
        flash,
        [
          { transform: 'translateX(-110%) skewX(-18deg)', opacity: 1 },
          { transform: 'translateX(110%) skewX(-18deg)', opacity: 0 },
        ],
        { duration: 700, easing: 'cubic-bezier(0.3, 0.6, 0.3, 1)' },
      );
    },

    resize(nw) {
      width = nw;
      progShown = -1;
      if (mode === 'mission' || mode === 'result' || mode === 'status') {
        fit(title);
        fit(hint);
      }
    },

    update(frame) {
      const hud = frame.hud;
      const m = hud.mission;
      if (resultPending) {
        resultPending = false;
        state.showResult(frame.now);
      }
      const next = state.resolve(frame.now, m !== null, hud.status !== '');

      if (next === 'mission' && m) {
        const gesture = m.targets.length ? m.targets[0].gesture : '';
        const textChanged = m.id !== shownId || m.title !== shownTitle || m.hint !== shownHint;
        if (mode !== 'mission' || textChanged || gesture !== shownGesture) {
          renderMission(m, mode !== 'mission' || textChanged);
        }
        if (m.points !== shownPoints) {
          shownPoints = m.points;
          pts.textContent = m.points > 0 ? `+${formatScore(m.points)}` : '';
          tag.textContent = m.points > 0 ? 'POINTS' : '';
        }
        setProgress(m.progress, frame.dt);
        setTime(m.timeLeft);
        chip.style.transform = `scale(${(1 + 0.08 * frame.pulse).toFixed(3)})`;
      } else if (next === 'status') {
        if (mode !== 'status' || hud.status !== shownStatus) {
          const animate = mode !== 'status';
          setMode('status');
          shownStatus = hud.status;
          setRich(title, hud.status, false);
          hint.textContent = '';
          fit(title);
          if (animate) intro(false);
        }
      } else if (next === 'empty') {
        setMode('empty');
      }
      // 'result' was rendered by showResult()
    },
  };
}
