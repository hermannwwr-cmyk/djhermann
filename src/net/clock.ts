/**
 * Shared clock: NTP-style estimate of the offset between this device's performance.now() and the
 * server's Date.now() ("shared ms").
 *
 * One ping/pong gives a sample: the client sends c = perf at send, the server answers with s = its
 * clock when it handled the ping, the reply lands at perf `now`. If both directions took equally
 * long, the server read s at perf (c + now)/2, so offset = s - (c + now)/2. The error of that
 * sample is (up - down)/2, at most rtt/2. Samples with a small round trip are the ones that did not
 * sit in a queue anywhere, so the estimate comes from the lowest-RTT samples of a recent window.
 *
 * The estimator is pure (estimateClock); ClockSync adds the window and the slewing: once the clock
 * is ready the applied offset only glides towards a new estimate (SLEW_RATE), so anything driven by
 * it (a note highway) never jerks.
 */

export interface ClockSample {
  /** server ms − client perf ms */
  offset: number;
  /** round trip in ms */
  rtt: number;
  /** client perf ms when the pong arrived */
  at: number;
}

export interface ClockEstimate {
  offset: number;
  /** half the best round trip in the window: a bound on the error if the route is not wildly asymmetric */
  errorMs: number;
  /** how many samples the estimate was made from */
  used: number;
}

export const CLOCK = {
  /** samples kept */
  window: 30,
  /** samples older than this (ms) are dropped: clocks drift (tens of ppm) */
  maxAgeMs: 90_000,
  /** fraction of the window (lowest RTT first) the estimate is made from */
  bestFraction: 0.25,
  /** samples needed before the clock is ready */
  readySamples: 5,
  /** after ready, the applied offset moves towards the estimate at most this fast (ms per ms) */
  slewRate: 0.02,
  /** …unless the estimate is this far off, then it jumps (only after a gross change) */
  jumpMs: 120,
  /** a round trip longer than this is ignored (the device was asleep, the tab was frozen …) */
  maxRttMs: 5000,
} as const;

export function clockSample(c: number, s: number, now: number): ClockSample | null {
  const rtt = now - c;
  if (!(rtt >= 0) || rtt > CLOCK.maxRttMs || !Number.isFinite(s)) return null;
  return { offset: s - (c + now) / 2, rtt, at: now };
}

/**
 * Estimate from a window of samples: the best quarter by round trip, averaged with weights that
 * favour the very best ones. Returns null for no samples.
 */
export function estimateClock(samples: readonly ClockSample[], bestFraction: number = CLOCK.bestFraction): ClockEstimate | null {
  const n = samples.length;
  if (n === 0) return null;
  const sorted = [...samples].sort((a, b) => a.rtt - b.rtt);
  const k = Math.max(1, Math.min(n, Math.ceil(n * bestFraction)));
  const minRtt = sorted[0].rtt;
  let sw = 0;
  let so = 0;
  for (let i = 0; i < k; i++) {
    const s = sorted[i];
    // a sample whose rtt is 10 ms worse than the best one counts half as much
    const w = 1 / (1 + (s.rtt - minRtt) / 10);
    sw += w;
    so += w * s.offset;
  }
  return { offset: so / sw, errorMs: minRtt / 2, used: k };
}

/** The window + slew around estimateClock. Times are this device's perf ms. */
export class ClockSync {
  private samples: ClockSample[] = [];
  private target = 0;
  private cur = 0;
  private lastAdvance = 0;
  private hasOffset = false;
  private est: ClockEstimate | null = null;

  get ready(): boolean {
    return this.samples.length >= CLOCK.readySamples;
  }

  get sampleCount(): number {
    return this.samples.length;
  }

  get errorMs(): number {
    return this.est ? this.est.errorMs : Infinity;
  }

  /** the raw (unslewed) estimate */
  get estimate(): ClockEstimate | null {
    return this.est;
  }

  /** Feed a pong. Returns false if the sample was unusable. */
  add(c: number, s: number, now: number): boolean {
    const sample = clockSample(c, s, now);
    if (!sample) return false;
    this.advance(now);
    this.samples.push(sample);
    const minAt = now - CLOCK.maxAgeMs;
    while (this.samples.length > CLOCK.window || (this.samples.length > 1 && this.samples[0].at < minAt)) {
      this.samples.shift();
    }
    this.est = estimateClock(this.samples);
    if (!this.est) return true;
    this.target = this.est.offset;
    if (!this.hasOffset || !this.ready || Math.abs(this.target - this.cur) > CLOCK.jumpMs) {
      // not ready yet (nothing should be driven by it), or a gross change: take it as it is
      this.cur = this.target;
      this.hasOffset = true;
    }
    return true;
  }

  /** The applied offset at perf `now` (advances the slew; call with a non-decreasing clock). */
  offset(now: number): number {
    this.advance(now);
    return this.cur;
  }

  /** Forget every sample (e.g. the server moved). */
  reset(): void {
    this.samples = [];
    this.est = null;
    this.hasOffset = false;
  }

  private advance(now: number): void {
    const dt = now - this.lastAdvance;
    if (dt <= 0) return;
    this.lastAdvance = now;
    const diff = this.target - this.cur;
    if (diff === 0) return;
    const max = CLOCK.slewRate * dt;
    this.cur += diff > max ? max : diff < -max ? -max : diff;
  }
}
