/**
 * A short history of what a deck's worklet reported: (context time, track position, rate).
 *
 * The UI needs the position "as heard", which is the position the worklet had one output latency
 * ago. That time is usually a little older than the newest report, so the history is interpolated
 * (cubic Hermite through positions and rates: exact for steady playback and for the linear rate
 * ramps of the motor); only past the newest report is the position extrapolated with the last rate.
 */

export interface HistorySample {
  pos: number;
  rate: number;
}

/** Never extrapolate further than this past the newest report (seconds). */
export const MAX_EXTRAPOLATE_SEC = 0.25;

export class ReportHistory {
  private readonly cap: number;
  private readonly t: Float64Array;
  private readonly p: Float64Array;
  private readonly r: Float64Array;
  private readonly j: Uint8Array;
  private head = 0; // index of the oldest entry
  private n = 0;

  /** 512 entries cover about 4 s at one report per 384 frames. */
  constructor(capacity = 512) {
    this.cap = capacity;
    this.t = new Float64Array(capacity);
    this.p = new Float64Array(capacity);
    this.r = new Float64Array(capacity);
    this.j = new Uint8Array(capacity);
  }

  get size(): number {
    return this.n;
  }

  clear(): void {
    this.head = 0;
    this.n = 0;
  }

  /**
   * Add a report. `jump` marks a discontinuity: the playhead was moved just before this report, so
   * nothing is interpolated across it. Reports that go back in time restart the history.
   */
  push(timeSec: number, posSec: number, rate: number, jump = false): void {
    if (this.n > 0 && timeSec < this.t[this.at(this.n - 1)]) this.clear();
    let i: number;
    if (this.n < this.cap) {
      i = (this.head + this.n) % this.cap;
      this.n++;
    } else {
      i = this.head;
      this.head = (this.head + 1) % this.cap;
    }
    this.t[i] = timeSec;
    this.p[i] = posSec;
    this.r[i] = rate;
    this.j[i] = jump ? 1 : 0;
  }

  /** Context time of the newest report, or -Infinity when empty. */
  newestTime(): number {
    return this.n ? this.t[this.at(this.n - 1)] : -Infinity;
  }

  oldestTime(): number {
    return this.n ? this.t[this.head] : Infinity;
  }

  /**
   * Position and rate at a context time. Returns false (and leaves `out` alone) when empty.
   * Before the oldest report the oldest position is held; after the newest it is extrapolated.
   */
  sample(timeSec: number, out: HistorySample): boolean {
    const n = this.n;
    if (n === 0) return false;
    const first = this.head;
    if (timeSec <= this.t[first]) {
      out.pos = this.p[first];
      out.rate = this.r[first];
      return true;
    }
    // last entry with t <= timeSec
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.t[this.at(mid)] <= timeSec) lo = mid;
      else hi = mid - 1;
    }
    const a = this.at(lo);
    const t0 = this.t[a];
    const p0 = this.p[a];
    const r0 = this.r[a];
    if (lo === n - 1) {
      out.pos = p0 + r0 * Math.min(timeSec - t0, MAX_EXTRAPOLATE_SEC);
      out.rate = r0;
      return true;
    }
    const b = this.at(lo + 1);
    const h = this.t[b] - t0;
    if (this.j[b] || h <= 0) {
      // a jump follows: the old playhead simply carried on until then
      out.pos = p0 + r0 * (timeSec - t0);
      out.rate = r0;
      return true;
    }
    const u = (timeSec - t0) / h;
    const u2 = u * u;
    const u3 = u2 * u;
    const p1 = this.p[b];
    const r1 = this.r[b];
    out.pos = (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * h * r0 + (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * h * r1;
    out.rate = r0 + (r1 - r0) * u;
    return true;
  }

  private at(k: number): number {
    return (this.head + k) % this.cap;
  }
}
