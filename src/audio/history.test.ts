import { describe, expect, it } from 'vitest';
import { MAX_EXTRAPOLATE_SEC, ReportHistory } from './history';
import type { HistorySample } from './history';

const out: HistorySample = { pos: 0, rate: 0 };
const BLOCK = 384 / 48000;

describe('ReportHistory', () => {
  it('is exact for steady playback', () => {
    const h = new ReportHistory();
    for (let i = 0; i < 100; i++) h.push(10 + i * BLOCK, 2 + i * BLOCK * 1.04, 1.04);
    for (const t of [10.1, 10.2345, 10.5]) {
      h.sample(t, out);
      expect(out.pos).toBeCloseTo(2 + (t - 10) * 1.04, 10);
      expect(out.rate).toBeCloseTo(1.04, 10);
    }
  });

  it('is exact for the linear rate ramps of the motor', () => {
    // rate ramps 0 → 1 over 50 ms: position is a parabola
    const h = new ReportHistory();
    const pos = (t: number): number => (t < 0.05 ? (t * t) / 0.1 : 0.025 + (t - 0.05));
    const rate = (t: number): number => (t < 0.05 ? t / 0.05 : 1);
    for (let i = 0; i < 40; i++) {
      const t = i * BLOCK;
      h.push(t, pos(t), rate(t));
    }
    for (let t = 0.001; t < 0.045; t += 0.0037) {
      // within one block of the knee the cubic is not exact; everywhere else it is
      if (Math.abs(t - 0.05) < BLOCK) continue;
      h.sample(t, out);
      expect(Math.abs(out.pos - pos(t))).toBeLessThan(1e-9);
    }
  });

  it('never interpolates across a jump', () => {
    const h = new ReportHistory();
    h.push(1, 5, 1);
    h.push(1.008, 5.008, 1);
    h.push(1.016, 30, 1, true); // seek
    h.sample(1.012, out);
    expect(out.pos).toBeCloseTo(5.012, 9); // the old playhead carried on until the jump
    h.sample(1.02, out);
    expect(out.pos).toBeCloseTo(30.004, 9);
  });

  it('extrapolates with the last rate only past the newest report, and not forever', () => {
    const h = new ReportHistory();
    h.push(1, 5, 1);
    h.push(1.008, 5.008, 1);
    h.sample(1.1, out);
    expect(out.pos).toBeCloseTo(5.1, 9);
    h.sample(5, out);
    expect(out.pos).toBeCloseTo(5.008 + MAX_EXTRAPOLATE_SEC, 9);
    h.sample(0.5, out);
    expect(out.pos).toBe(5);
  });

  it('wraps around and restarts when time goes backwards', () => {
    const h = new ReportHistory(16);
    for (let i = 0; i < 100; i++) h.push(i * 0.01, i * 0.01, 1);
    expect(h.size).toBe(16);
    expect(h.oldestTime()).toBeCloseTo(0.84, 9);
    h.sample(0.905, out);
    expect(out.pos).toBeCloseTo(0.905, 9);
    h.push(0.1, 7, 0);
    expect(h.size).toBe(1);
  });
});
