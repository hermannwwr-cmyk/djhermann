import { describe, expect, it } from 'vitest';
import { clashes, createDeadAirDetector, createTrainwreckDetector } from './detectors';
import type { TrainwreckInput } from './detectors';
import { TUNING } from './tuning';

describe('dead air', () => {
  it('is called after the silence lasts long enough, and counted from the first silent frame', () => {
    const d = createDeadAirDetector(1.5);
    const edges: string[] = [];
    for (let i = 0; i < 60; i++) {
      const e = d.update(1 / 60, true);
      if (e) edges.push(e);
    }
    // 1.4 s of silence: not yet
    for (let i = 0; i < 84; i++) {
      const e = d.update(1 / 60, false);
      if (e) edges.push(e);
    }
    expect(d.active).toBe(false);
    // a sound in between restarts the wait
    d.update(1 / 60, true);
    for (let i = 0; i < 84; i++) d.update(1 / 60, false);
    expect(d.active).toBe(false);
    for (let i = 0; i < 12; i++) {
      const e = d.update(1 / 60, false);
      if (e) edges.push(e);
    }
    expect(d.active).toBe(true);
    expect(edges).toEqual(['start']);
    // 3 more seconds
    for (let i = 0; i < 180; i++) d.update(1 / 60, false);
    expect(d.activeSec).toBeCloseTo(3, 1);
    expect(d.totalSec).toBeCloseTo(1.5 + 3 + 1 / 60, 1);
    d.snooze();
    expect(d.activeSec).toBe(0);
    expect(d.update(1 / 60, true)).toBe('end');
    expect(d.active).toBe(false);
  });
});

describe('trainwreck', () => {
  const T = TUNING.trainwreck;
  const frame = (o: Partial<TrainwreckInput> = {}): TrainwreckInput => ({
    dtBeats: 0.04,
    bothAudible: true,
    bpmDiff: 0,
    offsetMs: 0,
    grace: false,
    ...o,
  });
  const run = (det: ReturnType<typeof createTrainwreckDetector>, beats: number, o: Partial<TrainwreckInput>) => {
    const edges: string[] = [];
    for (let b = 0; b < beats; b += 0.04) {
      const e = det.update(frame(o));
      if (e) edges.push(e);
    }
    return edges;
  };

  it('clash thresholds: tempo or phase', () => {
    expect(clashes(0, 0)).toBe(false);
    expect(clashes(T.bpm - 0.01, T.offsetMs - 1)).toBe(false);
    expect(clashes(T.bpm + 0.01, 0)).toBe(true);
    expect(clashes(0, -(T.offsetMs + 1))).toBe(true);
  });

  it('is called only after the clash lasts a couple of beats', () => {
    const det = createTrainwreckDetector();
    expect(run(det, T.afterBeats - 0.2, { offsetMs: 120 })).toEqual([]);
    expect(det.active).toBe(false);
    expect(run(det, 0.5, { offsetMs: 120 })).toEqual(['start']);
    expect(det.count).toBe(1);
  });

  it('a brief clash that clears in time is forgiven', () => {
    const det = createTrainwreckDetector();
    run(det, T.afterBeats - 0.5, { bpmDiff: 2 });
    run(det, 1, {});
    expect(run(det, T.afterBeats - 0.5, { bpmDiff: 2 })).toEqual([]);
    expect(det.count).toBe(0);
  });

  it('ends when the beats are back together, or at once when a deck is gone', () => {
    const det = createTrainwreckDetector();
    run(det, 3, { offsetMs: 200 });
    expect(det.active).toBe(true);
    expect(run(det, T.clearBeats - 0.2, {})).toEqual([]);
    expect(run(det, 0.4, {})).toEqual(['end']);
    run(det, 3, { offsetMs: 200 });
    expect(det.update(frame({ bothAudible: false }))).toBe('end');
    expect(det.count).toBe(2);
  });

  it('nothing is judged during the grace after a deck starts, or with one deck', () => {
    const det = createTrainwreckDetector();
    expect(run(det, 10, { offsetMs: 200, grace: true })).toEqual([]);
    expect(run(det, 10, { offsetMs: 200, bothAudible: false })).toEqual([]);
    expect(det.count).toBe(0);
  });
});
