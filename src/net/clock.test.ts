import { describe, expect, it } from 'vitest';
import { rng } from '../core/math';
import { CLOCK, ClockSync, clockSample, estimateClock } from './clock';

/**
 * Simulated networks. Sim time t (ms) is "true" time. The server clock is t + SERVER, the client's
 * perf clock is (t + CLIENT) × (1 + drift). The client pings like the room client does (a burst of
 * 8 at 50 ms, then every 500 ms until 12 samples, then every 2 s), and we watch the applied offset.
 */
interface Net {
  /** one-way delays in ms for a ping sent at sim time t */
  up(t: number, r: () => number): number;
  down(t: number, r: () => number): number;
  driftPpm?: number;
}

const SERVER = 1_700_000_000_000;
const CLIENT = 12_345.678;

function simulate(net: Net, durationMs: number, seed = 1) {
  const r = rng(seed);
  const drift = (net.driftPpm ?? 0) * 1e-6;
  const perf = (t: number): number => (t + CLIENT) * (1 + drift);
  const trueOffset = (t: number): number => t + SERVER - perf(t);
  const sync = new ClockSync();
  // ping schedule
  const sends: number[] = [];
  let t = 100;
  for (let i = 0; i < 8; i++) sends.push(t + i * 50);
  t += 8 * 50;
  while (t < durationMs) {
    sends.push(t);
    t += sends.length < 12 ? 500 : 2000;
  }
  // pongs, in arrival order
  const pongs = sends
    .map((ts) => {
      const up = net.up(ts, r);
      const down = net.down(ts + up, r);
      return { c: perf(ts), s: ts + up + SERVER, arrive: ts + up + down };
    })
    .sort((a, b) => a.arrive - b.arrive);

  let readyAt = -1;
  let worst = 0;
  let sumAbs = 0;
  let n = 0;
  let maxFrameStep = 0;
  let prev: number | null = null;
  let pi = 0;
  const errAt: { t: number; err: number }[] = [];
  for (let ft = 0; ft < durationMs; ft += 16) {
    while (pi < pongs.length && pongs[pi].arrive <= ft) {
      const p = pongs[pi++];
      sync.add(p.c, p.s, perf(p.arrive));
    }
    const off = sync.offset(perf(ft));
    if (!sync.ready) continue;
    if (readyAt < 0) readyAt = ft;
    if (prev !== null) maxFrameStep = Math.max(maxFrameStep, Math.abs(off - prev));
    prev = off;
    const err = off - trueOffset(ft);
    errAt.push({ t: ft, err });
    if (ft > readyAt + 1000) {
      worst = Math.max(worst, Math.abs(err));
      sumAbs += Math.abs(err);
      n++;
    }
  }
  return { readyAt, worst, mean: sumAbs / n, maxFrameStep, errorMs: sync.errorMs, errAt, sync };
}

const jitter = (r: () => number, mean: number): number => -Math.log(1 - r()) * mean; // exponential

describe('clockSample / estimateClock', () => {
  it('computes the NTP offset and round trip', () => {
    const s = clockSample(1000, 5050, 1100)!;
    expect(s.rtt).toBe(100);
    expect(s.offset).toBe(5050 - 1050);
    expect(clockSample(1000, 5000, 900)).toBeNull();
  });

  it('uses the lowest-rtt samples', () => {
    const samples = [
      { offset: 100, rtt: 20, at: 0 },
      { offset: 160, rtt: 300, at: 1 },
      { offset: 60, rtt: 280, at: 2 },
      { offset: 101, rtt: 22, at: 3 },
      { offset: 140, rtt: 200, at: 4 },
      { offset: 30, rtt: 400, at: 5 },
      { offset: 99, rtt: 21, at: 6 },
      { offset: 170, rtt: 350, at: 7 },
    ];
    const e = estimateClock(samples)!;
    expect(e.used).toBe(2);
    expect(e.offset).toBeGreaterThan(99.5);
    expect(e.offset).toBeLessThan(101);
    expect(e.errorMs).toBe(10);
  });
});

describe('ClockSync under simulated networks', () => {
  const report: string[] = [];
  const log = (name: string, res: ReturnType<typeof simulate>): void => {
    report.push(
      `${name.padEnd(34)} ready ${String(res.readyAt).padStart(4)} ms  worst ${res.worst.toFixed(2).padStart(6)} ms  mean ${res.mean
        .toFixed(2)
        .padStart(5)} ms  max step/frame ${res.maxFrameStep.toFixed(3)} ms  clockErrorMs ${res.errorMs.toFixed(1)}`,
    );
  };

  it('symmetric Wi-Fi (15 ms each way + jitter)', () => {
    const res = simulate({ up: (_t, r) => 15 + jitter(r, 4), down: (_t, r) => 15 + jitter(r, 4) }, 120_000);
    log('symmetric 15/15 ms, jitter 4', res);
    expect(res.readyAt).toBeLessThan(1000);
    expect(res.worst).toBeLessThan(3);
    expect(res.maxFrameStep).toBeLessThan(0.5);
  });

  it('asymmetric route (25 ms up, 8 ms down): error is the unobservable asymmetry/2', () => {
    const res = simulate({ up: (_t, r) => 25 + jitter(r, 3), down: (_t, r) => 8 + jitter(r, 3) }, 120_000);
    log('asymmetric 25/8 ms (bias 8.5 ms)', res);
    // half the asymmetry (8.5 ms) can't be seen by any ping-based method; the error must not exceed it by much
    expect(res.worst).toBeLessThan(8.5 + 2.5);
    expect(res.worst).toBeLessThanOrEqual(res.errorMs + 1);
  });

  it('spiky Wi-Fi (25 % of packets delayed 30–400 ms in one direction)', () => {
    const spike = (r: () => number): number => (r() < 0.25 ? 30 + r() * 370 : 0);
    const res = simulate(
      { up: (_t, r) => 12 + jitter(r, 5) + spike(r), down: (_t, r) => 12 + jitter(r, 5) + spike(r) },
      180_000,
      7,
    );
    log('spiky 12/12 ms, 25 % spikes ≤400', res);
    expect(res.worst).toBeLessThan(4);
    expect(res.maxFrameStep).toBeLessThan(0.5);
  });

  it('a sudden route change (Wi-Fi → 4G) at 60 s, with 40 ppm drift', () => {
    const net: Net = {
      up: (t, r) => (t < 60_000 ? 8 + jitter(r, 3) : 45 + jitter(r, 15)),
      down: (t, r) => (t < 60_000 ? 8 + jitter(r, 3) : 25 + jitter(r, 15)),
      driftPpm: 40,
    };
    const res = simulate(net, 200_000, 3);
    log('route change 8/8 → 45/25 ms, 40 ppm', res);
    // after the switch the old (better) samples are kept until they age out; the error stays within
    // the new route's asymmetry/2 (10 ms) plus drift
    expect(res.worst).toBeLessThan(13);
    expect(res.maxFrameStep).toBeLessThan(0.5);
  });

  it('drift alone (60 ppm) is tracked', () => {
    const res = simulate({ up: (_t, r) => 10 + jitter(r, 2), down: (_t, r) => 10 + jitter(r, 2), driftPpm: 60 }, 300_000, 5);
    log('symmetric 10/10 ms, 60 ppm drift', res);
    expect(res.worst).toBeLessThan(4);
  });

  it('reports', () => {
    console.log(`\n[clock] estimation error of the applied (slewed) offset, after ready + 1 s:\n  ${report.join('\n  ')}`);
    expect(report.length).toBe(5);
    expect(CLOCK.readySamples).toBe(5);
  });
});
