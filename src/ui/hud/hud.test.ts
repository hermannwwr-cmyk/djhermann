import { describe, expect, it } from 'vitest';
import type { MissionTarget, MissionView } from '../../core/types';
import { formatScore, stepCount } from './counter';
import { CUE_PERIOD, cuePose, travel } from './gestures';
import { StepTracker, panelToOpen, planPointers, visibleFraction } from './guide-logic';
import { MissionLineState, RESULT_MIN_MS, RESULT_MS, splitInstruction, timeUrgency } from './mission-state';
import { StageMood, hypeZone, stageLook } from './stage-model';

const mission = (id: number, targets: MissionTarget[]): MissionView => ({
  id,
  kind: 'start-deck',
  title: 'START DECK B',
  hint: 'Press the green PLAY button on deck B',
  targets,
  progress: null,
  timeLeft: 1,
  points: 1000,
});

describe('score counter', () => {
  it('groups thousands without locale', () => {
    expect(formatScore(0)).toBe('0');
    expect(formatScore(999)).toBe('999');
    expect(formatScore(1000)).toBe('1,000');
    expect(formatScore(48250)).toBe('48,250');
    expect(formatScore(1002003)).toBe('1,002,003');
    expect(formatScore(-5)).toBe('0');
  });

  it('counts up smoothly, never overshoots, lands exactly', () => {
    let shown = 0;
    let prev = 0;
    for (let i = 0; i < 120; i++) {
      shown = stepCount(shown, 5000, 1 / 60);
      expect(shown).toBeGreaterThanOrEqual(prev);
      expect(shown).toBeLessThanOrEqual(5000);
      prev = shown;
    }
    expect(shown).toBe(5000);
    // a lower target (new gig) is taken at once
    expect(stepCount(5000, 0, 1 / 60)).toBe(0);
  });

  it('is frame-rate independent', () => {
    let a = 0;
    for (let i = 0; i < 6; i++) a = stepCount(a, 10000, 1 / 60);
    const b = stepCount(stepCount(0, 10000, 0.05), 10000, 0.05);
    expect(Math.abs(a - b)).toBeLessThan(1);
  });
});

describe('stage look', () => {
  it('rises monotonically with hype', () => {
    let prev = stageLook(0);
    for (let h = 0.05; h <= 1.0001; h += 0.05) {
      const l = stageLook(h);
      for (const k of ['light', 'presence', 'arms', 'bounce', 'beams', 'sweep', 'lasers', 'confetti', 'fire'] as const) {
        expect(l[k]).toBeGreaterThanOrEqual(prev[k] - 1e-9);
      }
      expect(l.danger).toBeLessThanOrEqual(prev.danger + 1e-9);
      prev = l;
    }
  });

  it('low hype is dim and still, high hype is full on', () => {
    const lo = stageLook(0.05);
    expect(lo.light).toBeLessThan(0.3);
    expect(lo.arms).toBe(0);
    expect(lo.lasers).toBe(0);
    expect(lo.danger).toBe(1);
    const hi = stageLook(0.95);
    expect(hi.light).toBeGreaterThan(0.95);
    expect(hi.lasers).toBe(1);
    expect(hi.confetti).toBeGreaterThan(0.5);
    expect(hi.danger).toBe(0);
  });

  it('hype zone has hysteresis', () => {
    expect(hypeZone(0.1)).toBe('low');
    expect(hypeZone(0.5)).toBe('mid');
    expect(hypeZone(0.9)).toBe('fire');
    // hovering around a threshold does not flicker
    expect(hypeZone(0.24, 'low')).toBe('low');
    expect(hypeZone(0.24, 'mid')).toBe('mid');
    expect(hypeZone(0.84, 'fire')).toBe('fire');
    expect(hypeZone(0.84, 'mid')).toBe('mid');
  });
});

describe('stage mood', () => {
  it('sick is held, then released', () => {
    const m = new StageMood();
    m.sicken(1);
    for (let i = 0; i < 30; i++) m.step(1 / 60);
    expect(m.sick).toBeGreaterThan(0.9);
    for (let i = 0; i < 60 * 4; i++) m.step(1 / 60);
    expect(m.sick).toBe(0);
  });

  it('a cheer cuts the sick look short; recover() lets go at once', () => {
    const m = new StageMood();
    m.sicken(5);
    m.step(0.5);
    m.applaud(1);
    for (let i = 0; i < 120; i++) m.step(1 / 60);
    expect(m.sick).toBeLessThan(0.2);
    m.sicken(5);
    m.step(0.5);
    m.recover();
    for (let i = 0; i < 120; i++) m.step(1 / 60);
    expect(m.sick).toBeLessThan(0.2);
  });

  it('bursts and dips decay to zero', () => {
    const m = new StageMood();
    m.flash(1);
    m.sag(1);
    m.applaud(1);
    for (let i = 0; i < 60 * 8; i++) m.step(1 / 60);
    expect(m.burst).toBe(0);
    expect(m.dip).toBe(0);
    expect(m.cheer).toBe(0);
  });
});

describe('mission line', () => {
  it('shows a result for a moment, shorter when the next mission is waiting', () => {
    const s = new MissionLineState();
    s.showResult(1000);
    expect(s.resolve(1000 + RESULT_MIN_MS - 1, true, false)).toBe('result');
    expect(s.resolve(1000 + RESULT_MIN_MS + 1, true, false)).toBe('mission');
    const t = new MissionLineState();
    t.showResult(0);
    expect(t.resolve(RESULT_MS - 1, false, true)).toBe('result');
    expect(t.resolve(RESULT_MS + 1, false, true)).toBe('status');
    expect(t.resolve(RESULT_MS + 2, false, false)).toBe('empty');
  });

  it('time urgency', () => {
    expect(timeUrgency(1)).toBe('none');
    expect(timeUrgency(0.8)).toBe('calm');
    expect(timeUrgency(0.4)).toBe('soon');
    expect(timeUrgency(0.1)).toBe('now');
  });

  it('colours decks and marks hardware legends', () => {
    const parts = splitInstruction('Press the green PLAY button on deck B', true);
    expect(parts.map((p) => p.text).join('')).toBe('Press the green PLAY button on deck B');
    expect(parts.find((p) => p.text === 'PLAY')?.kind).toBe('key');
    expect(parts.find((p) => p.text === 'deck B')?.kind).toBe('deckB');
    const title = splitInstruction('START DECK A', false);
    expect(title.map((p) => p.kind)).toEqual(['plain', 'deckA']);
  });
});

describe('guide logic', () => {
  it('opens the panel of the first hidden target, none when visible', () => {
    expect(panelToOpen([{ control: 'B.play', gesture: 'tap' }], null)).toBe('deckB');
    expect(panelToOpen([{ control: 'B.play', gesture: 'tap' }], 'deckB')).toBe(null);
    expect(panelToOpen([{ control: 'A.eq.low', gesture: 'turn-left' }], 'deckA')).toBe('mixer');
    expect(panelToOpen([{ control: 'xfader', gesture: 'right' }], null)).toBe(null);
  });

  it('points at the tab of a panel that is not open, once per panel', () => {
    const p = planPointers(
      [
        { control: 'A.eq.low', gesture: 'turn-left' },
        { control: 'B.eq.low', gesture: 'turn-right' },
        { control: 'xfader', gesture: 'right' },
      ],
      'deckA',
    );
    expect(p).toEqual([
      { kind: 'tab', panel: 'mixer' },
      { kind: 'control', control: 'xfader', gesture: 'right' },
    ]);
    const q = planPointers([{ control: 'A.eq.low', gesture: 'turn-left' }], 'mixer');
    expect(q).toEqual([{ kind: 'control', control: 'A.eq.low', gesture: 'turn-left' }]);
  });

  it('notices a new step: a new mission or new targets, not the same frame again', () => {
    const t = new StepTracker();
    const m = mission(1, [{ control: 'B.play', gesture: 'tap' }]);
    expect(t.observe(m)).toBe(true);
    t.autoOpened = true;
    expect(t.observe(m)).toBe(false);
    expect(t.autoOpened).toBe(true);
    // same mission, next step
    expect(t.observe({ ...m, targets: [{ control: 'xfader', gesture: 'right' }] })).toBe(true);
    expect(t.autoOpened).toBe(false);
    expect(t.observe(mission(2, [{ control: 'xfader', gesture: 'right' }]))).toBe(true);
    expect(t.observe(null)).toBe(true);
    expect(t.observe(null)).toBe(false);
  });

  it('visible fraction of a rectangle', () => {
    expect(visibleFraction(0, 0, 10, 10, 0, 0, 100, 100)).toBe(1);
    expect(visibleFraction(0, 0, 10, 10, 5, 0, 100, 100)).toBe(0.5);
    expect(visibleFraction(0, 0, 10, 10, 20, 20, 5, 5)).toBe(0);
  });
});

describe('gesture cue', () => {
  it('every loop starts pressing within the first fifth', () => {
    for (const g of Object.keys(CUE_PERIOD) as (keyof typeof CUE_PERIOD)[]) {
      const p = cuePose(g, CUE_PERIOD[g] * 0.2, 60, 60);
      expect(p.press).toBeGreaterThan(0.95);
    }
  });

  it('slides travel the way they say', () => {
    const start = cuePose('up', CUE_PERIOD.up * 0.12, 30, 160);
    const end = cuePose('up', CUE_PERIOD.up * 0.66, 30, 160);
    expect(end.y).toBeLessThan(start.y);
    expect(start.y - end.y).toBeCloseTo(travel('up', 30, 160), 0);
    const r0 = cuePose('right', CUE_PERIOD.right * 0.12, 200, 30);
    const r1 = cuePose('right', CUE_PERIOD.right * 0.66, 200, 30);
    expect(r1.x).toBeGreaterThan(r0.x);
  });

  it('knob turns rotate the right way; scratch rocks both ways', () => {
    expect(cuePose('turn-right', CUE_PERIOD['turn-right'] * 0.6, 46, 46).turn).toBeGreaterThan(0);
    expect(cuePose('turn-left', CUE_PERIOD['turn-left'] * 0.6, 46, 46).turn).toBeLessThan(0);
    let min = 0;
    let max = 0;
    for (let i = 0; i < 100; i++) {
      const p = cuePose('scratch', (CUE_PERIOD.scratch * i) / 100, 180, 180);
      min = Math.min(min, p.turn);
      max = Math.max(max, p.turn);
    }
    expect(min).toBeLessThan(-0.3);
    expect(max).toBeGreaterThan(0.3);
  });

  it('a tap ripples after the press', () => {
    const early = cuePose('tap', CUE_PERIOD.tap * 0.05, 50, 50);
    expect(early.ripple).toBe(-1);
    const mid = cuePose('tap', CUE_PERIOD.tap * 0.4, 50, 50);
    expect(mid.ripple).toBeGreaterThan(0);
  });
});
