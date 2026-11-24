/**
 * The mapping between performance.now() and AudioContext time.
 *
 *   ctx(perfMs) = perfMs / 1000 + offset
 *
 * Two kinds of observation feed it:
 *
 * 1. Staircase samples (performance.now(), ctx.currentTime). currentTime only moves when the audio
 *    callback runs, so `currentTime - now` is a sawtooth lying 0..one callback ABOVE the line we
 *    want (the render clock just before each callback). The estimate is therefore the lower
 *    envelope of the samples, taken robustly (percentiles, so a late callback or a busy main thread
 *    cannot drag it), and the samples must be taken at times that are not locked to the display
 *    refresh (the engine uses a randomised timer) or the sawtooth aliases.
 *
 * 2. Output timestamps from ctx.getOutputTimestamp(): pairs (contextTime, performanceTime) that lie
 *    on the line of the DEVICE clock (which context sample is at the output right now), with no
 *    sawtooth at all. Where the browser provides sane ones they define the short-term shape of the
 *    clock (drift, smoothness); the staircase then only supplies the constant distance between the
 *    render clock and the device clock, which is the browser's own output latency, unrounded.
 *
 * Either way the offset in use only ever glides (exponentially, with a minimum slew), so positions
 * drawn from it are smooth and monotonic; a real discontinuity (suspend, glitch, route change) is
 * followed quickly.
 */

const STAIR_N = 192;
const TS_N = 31;
/** minimum correction speed: 0.5 ms per second, far above real clock drift, invisible on screen */
const SLEW_PER_SEC = 0.0005;
/**
 * larger errors (a fresh lock settling) shrink exponentially with this time constant: a 4 ms
 * error moves the clock by under 0.07 ms per frame, still invisible
 */
const SETTLE_TC_SEC = 1;
/** an error above this is a real discontinuity and is chased quickly */
const FAST_ERR_SEC = 0.004;
const FAST_TC_SEC = 0.08;
/** timestamps must agree this closely to be trusted */
const TS_TOLERANCE_SEC = 0.003;

/** Median of the first n values of a scratch array (sorts it in place). */
function sortedPrefix(src: Float64Array, n: number, scratch: Float64Array): Float64Array {
  const v = scratch.subarray(0, n);
  v.set(src.subarray(0, n));
  v.sort();
  return v;
}

/**
 * Lower envelope of sawtooth-shaped samples, robust against outliers on both sides: for a uniform
 * distribution between `low` and `low + A`, p05 - (p50 - p05) / 9 is exactly `low`.
 */
export function lowerEnvelope(sorted: Float64Array): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n < 8) return sorted[0];
  const q = (f: number): number => {
    const x = f * (n - 1);
    const i = Math.floor(x);
    return i >= n - 1 ? sorted[n - 1] : sorted[i] + (sorted[i + 1] - sorted[i]) * (x - i);
  };
  const p05 = q(0.05);
  const p50 = q(0.5);
  return p05 - (p50 - p05) / 9;
}

export class ClockSync {
  /** render-clock offset in use (seconds): ctx = perf/1000 + offset */
  private offset = 0;
  private locked = false;
  private lastUpdateMs = 0;

  private readonly stair = new Float64Array(STAIR_N);
  private stairN = 0;
  private stairW = 0;
  private stairTarget = 0;

  private readonly ts = new Float64Array(TS_N);
  private tsN = 0;
  private tsW = 0;
  private lastTsPerf = -1;
  private lastTsSeenMs = -1e9;
  /** device-clock offset in use (slewed like `offset`), valid while devOk */
  private dev = 0;
  private devOk = false;
  private devTarget = 0;
  /** residuals: staircase sample minus device clock (a sawtooth above the output latency) */
  private readonly resid = new Float64Array(STAIR_N);
  private residN = 0;
  private residW = 0;
  private lambda = 0;
  private lambdaOk = false;

  private outliers = 0;
  private readonly scratch = new Float64Array(STAIR_N);

  /** true once at least one observation arrived since the last reset */
  get isLocked(): boolean {
    return this.locked;
  }

  reset(): void {
    this.locked = false;
    this.stairN = this.stairW = 0;
    this.tsN = this.tsW = 0;
    this.residN = this.residW = 0;
    this.devOk = false;
    this.lambdaOk = false;
    this.lastTsPerf = -1;
    this.lastTsSeenMs = -1e9;
    this.outliers = 0;
  }

  /** Convert a performance.now() value to AudioContext time (seconds). */
  perfToCtx(perfMs: number): number {
    return perfMs / 1000 + this.offset;
  }

  /** The offset in use (for tests and diagnostics). */
  getOffset(): number {
    return this.offset;
  }

  /**
   * The browser's own output latency as seen by this clock (seconds): how far the device clock
   * runs behind the render clock. null when there are no trustworthy output timestamps.
   */
  measuredOutputLatency(): number | null {
    if (!this.devOk || !this.lambdaOk) return null;
    const l = this.offset - this.dev;
    return l >= 0 && l < 1.5 ? l : null;
  }

  /** true while output timestamps are driving the clock */
  get usingTimestamps(): boolean {
    return this.devOk;
  }

  /**
   * A (performance.now(), ctx.currentTime) pair read at the same instant. Feed these at times that
   * are not synchronised to requestAnimationFrame.
   */
  addStaircase(perfMs: number, ctxTime: number): void {
    const o = ctxTime - perfMs / 1000;
    if (this.locked) {
      // a run of samples far from the model on the same side means the clock itself has jumped
      const err = o - this.offset;
      if (Math.abs(err) > 0.2) {
        if (++this.outliers >= 4) {
          this.reset();
        } else return;
      } else this.outliers = 0;
    }
    this.stair[this.stairW] = o;
    this.stairW = (this.stairW + 1) % STAIR_N;
    if (this.stairN < STAIR_N) this.stairN++;
    this.stairTarget = lowerEnvelope(sortedPrefix(this.stair, this.stairN, this.scratch));

    if (this.devOk) {
      this.resid[this.residW] = o - this.dev;
      this.residW = (this.residW + 1) % STAIR_N;
      if (this.residN < STAIR_N) this.residN++;
      this.lambda = lowerEnvelope(sortedPrefix(this.resid, this.residN, this.scratch));
      this.lambdaOk = this.residN >= 8 && this.lambda > -0.005 && this.lambda < 1.5;
    }
    this.update(perfMs);
  }

  /**
   * An output timestamp from ctx.getOutputTimestamp(), with the performance.now() of the call.
   * Insane or stale values are ignored; repeated values are free.
   */
  addTimestamp(nowMs: number, contextTime: number, performanceTime: number): void {
    if (!(contextTime > 0) || !(performanceTime > 0) || !isFinite(contextTime) || !isFinite(performanceTime)) return;
    const age = nowMs - performanceTime;
    if (age < -200 || age > 1000) return;
    if (performanceTime === this.lastTsPerf) {
      this.lastTsSeenMs = nowMs;
      return;
    }
    this.lastTsPerf = performanceTime;
    this.lastTsSeenMs = nowMs;
    this.ts[this.tsW] = contextTime - performanceTime / 1000;
    this.tsW = (this.tsW + 1) % TS_N;
    if (this.tsN < TS_N) this.tsN++;

    // trustworthy when most of the recent pairs agree: garbage (clamped zeros at start-up, jumping
    // estimates) does not
    const sorted = sortedPrefix(this.ts, this.tsN, this.scratch);
    const med = sorted[sorted.length >> 1];
    let agree = 0;
    for (let i = 0; i < sorted.length; i++) if (Math.abs(sorted[i] - med) <= TS_TOLERANCE_SEC) agree++;
    const ok = this.tsN >= 7 && agree >= Math.ceil(this.tsN * 0.7);
    if (ok) {
      this.devTarget = med;
      if (!this.devOk || Math.abs(med - this.dev) > 0.2) {
        this.dev = med;
        this.devOk = true;
        this.residN = this.residW = 0;
        this.lambdaOk = false;
      }
    } else if (this.devOk && this.tsN >= TS_N) {
      this.dropTimestamps();
    }
    this.update(nowMs);
  }

  private dropTimestamps(): void {
    this.devOk = false;
    this.lambdaOk = false;
    this.residN = this.residW = 0;
  }

  private update(nowMs: number): void {
    // timestamps that stopped arriving are no longer evidence of anything
    if (this.devOk && nowMs - this.lastTsSeenMs > 3000) this.dropTimestamps();

    const dt = this.locked ? Math.min(Math.max((nowMs - this.lastUpdateMs) / 1000, 0), 1) : 0;
    this.lastUpdateMs = nowMs;

    if (this.devOk) this.dev = this.approach(this.dev, this.devTarget, dt);

    let target: number;
    if (this.devOk && this.lambdaOk) target = this.dev + this.lambda;
    else if (this.stairN > 0) target = this.stairTarget;
    else if (this.devOk) target = this.dev;
    else return;

    if (!this.locked) {
      this.offset = target;
      this.locked = true;
      return;
    }
    // while only a handful of samples exist the estimate is still settling: follow it directly
    if (this.stairN > 0 && this.stairN < 12 && !(this.devOk && this.lambdaOk)) {
      this.offset = target;
      return;
    }
    this.offset = this.approach(this.offset, target, dt);
  }

  private approach(cur: number, target: number, dt: number): number {
    const err = target - cur;
    const a = Math.abs(err);
    if (a === 0) return cur;
    if (a > 0.2) return target;
    if (a > FAST_ERR_SEC) return cur + err * (1 - Math.exp(-dt / FAST_TC_SEC));
    const max = Math.max(SLEW_PER_SEC * dt, a * (1 - Math.exp(-dt / SETTLE_TC_SEC)));
    return a <= max ? target : cur + Math.sign(err) * max;
  }
}
