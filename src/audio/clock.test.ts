import { describe, expect, it } from 'vitest';
import { ClockSync, lowerEnvelope } from './clock';

/**
 * A simulated audio device: callbacks every `period` seconds (with jitter) render one buffer each;
 * currentTime is the end of the last rendered buffer. The "render line" is the context time just
 * before each callback, which is what ClockSync must recover.
 */
function device(opts: { period: number; offset: number; driftPpm?: number; jitterMs?: number; seed?: number }) {
  let s = opts.seed ?? 3;
  const rand = (): number => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 4294967296;
  };
  const drift = (opts.driftPpm ?? 0) * 1e-6;
  // context time on the render line at a perf time
  const line = (perfMs: number): number => (perfMs / 1000) * (1 + drift) + opts.offset;
  // callback k happens at perf time cb[k]; jitter is a delay, never early
  const cbTimes: number[] = [];
  const P = opts.period;
  return {
    line,
    currentTime(perfMs: number): number {
      // newest callback at or before perfMs
      const k = Math.floor((line(perfMs) - opts.offset) / P);
      let kk = k;
      // callbacks run late by up to jitterMs
      const jitter = (i: number): number => {
        while (cbTimes.length <= i) cbTimes.push(rand() * (opts.jitterMs ?? 0));
        return cbTimes[i];
      };
      while (kk >= 0 && line(perfMs - jitter(kk)) - opts.offset < kk * P) kk--;
      return opts.offset + (kk + 1) * P;
    },
    rand,
  };
}

describe('lowerEnvelope', () => {
  it('recovers the bottom of a uniform sawtooth', () => {
    const n = 192;
    const v = new Float64Array(n);
    for (let i = 0; i < n; i++) v[i] = 5 + (((i * 0.6180339887) % 1) * 0.01);
    v.sort();
    expect(lowerEnvelope(v)).toBeCloseTo(5, 4);
  });
});

describe('ClockSync', () => {
  it('locks onto the render line from currentTime staircase samples', () => {
    // the estimate is within 5 % of one callback period (a statistical error of the robust lower
    // envelope); late callbacks pull the bottom of the staircase down by up to the jitter on top
    for (const [period, jitterMs] of [
      [128 / 48000, 0],
      [512 / 48000, 0],
      [1024 / 44100, 0],
      [512 / 48000, 1.5],
    ]) {
      const bound = period * 1000 * 0.05 + jitterMs;
      const dev = device({ period, offset: 12.345, jitterMs });
      const clock = new ClockSync();
      let t = 1000;
      for (let i = 0; i < 400; i++) {
        t += 17 + dev.rand() * 26;
        clock.addStaircase(t, dev.currentTime(t));
      }
      const err = Math.abs(clock.perfToCtx(t) - dev.line(t)) * 1000;
      expect(err).toBeLessThan(bound);
    }
  });

  it('glides instead of jumping, so positions drawn from it stay smooth', () => {
    const dev = device({ period: 256 / 48000, offset: 3, driftPpm: 40, jitterMs: 2 });
    const clock = new ClockSync();
    let t = 0;
    let prev = NaN;
    let worst = 0;
    for (let i = 0; i < 3000; i++) {
      t += 5 + dev.rand() * 30;
      clock.addStaircase(t, dev.currentTime(t));
      if (i > 50) {
        const o = clock.getOffset();
        if (!Number.isNaN(prev)) worst = Math.max(worst, Math.abs(o - prev));
        prev = o;
      }
    }
    // each correction is tiny (sub-0.05 ms per sample at ~50 samples per second)
    expect(worst * 1000).toBeLessThan(0.05);
    // and it tracks the drifting clock
    expect(Math.abs(clock.perfToCtx(t) - dev.line(t)) * 1000).toBeLessThan(2);
  });

  it('uses output timestamps for the shape and measures the output latency', () => {
    const dev = device({ period: 128 / 48000, offset: 1, jitterMs: 0.5 });
    const outLat = 0.023;
    const clock = new ClockSync();
    let t = 500;
    for (let i = 0; i < 300; i++) {
      t += 17 + dev.rand() * 26;
      clock.addStaircase(t, dev.currentTime(t));
      // the device clock: what is at the speaker now, reported a few ms stale
      const pt = t - 3;
      clock.addTimestamp(t, dev.line(pt) - outLat, pt);
    }
    expect(clock.usingTimestamps).toBe(true);
    const lat = clock.measuredOutputLatency();
    expect(lat).not.toBeNull();
    expect(Math.abs(lat! - outLat) * 1000).toBeLessThan(0.8);
    expect(Math.abs(clock.perfToCtx(t) - dev.line(t)) * 1000).toBeLessThan(0.8);
  });

  it('ignores garbage timestamps', () => {
    const dev = device({ period: 128 / 48000, offset: 1 });
    const clock = new ClockSync();
    let t = 500;
    for (let i = 0; i < 100; i++) {
      t += 20 + dev.rand() * 20;
      clock.addStaircase(t, dev.currentTime(t));
      clock.addTimestamp(t, 0, 0);
      clock.addTimestamp(t, dev.rand() * 10, t - dev.rand() * 100);
    }
    expect(clock.usingTimestamps).toBe(false);
    expect(Math.abs(clock.perfToCtx(t) - dev.line(t)) * 1000).toBeLessThan(1);
  });

  it('follows a real discontinuity (suspend / resume) quickly', () => {
    const clock = new ClockSync();
    let t = 0;
    let off = 5;
    for (let i = 0; i < 100; i++) {
      t += 25;
      clock.addStaircase(t, t / 1000 + off);
    }
    off = 4.2; // context time stood still for 0.8 s
    for (let i = 0; i < 10; i++) {
      t += 25;
      clock.addStaircase(t, t / 1000 + off);
    }
    expect(Math.abs(clock.getOffset() - off)).toBeLessThan(0.001);
  });
});
