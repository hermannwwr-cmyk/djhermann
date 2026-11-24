/**
 * A virtual clock with timers, for deterministic network simulations. Sim time is in ms and starts
 * at 0; every simulated device maps it to its own performance.now() with an origin of its own.
 */
interface Timer {
  at: number;
  seq: number;
  id: number;
  fn: () => void;
}

export class SimScheduler {
  t = 0;
  private q: Timer[] = [];
  private seq = 0;
  private ids = 0;
  private cancelled = new Set<number>();

  setTimeout(fn: () => void, ms: number): number {
    const id = ++this.ids;
    this.insert({ at: this.t + Math.max(0, Number.isFinite(ms) ? ms : 0), seq: ++this.seq, id, fn });
    return id;
  }

  /** run fn at absolute sim time `at` (or now, if that is past) */
  at(at: number, fn: () => void): number {
    return this.setTimeout(fn, at - this.t);
  }

  clearTimeout(id: unknown): void {
    if (typeof id === 'number') this.cancelled.add(id);
  }

  private insert(tm: Timer): void {
    const q = this.q;
    let lo = 0;
    let hi = q.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const m = q[mid];
      if (m.at < tm.at || (m.at === tm.at && m.seq < tm.seq)) lo = mid + 1;
      else hi = mid;
    }
    q.splice(lo, 0, tm);
  }

  /** run everything due up to and including sim time `to`; the clock ends at `to` */
  runUntil(to: number): void {
    while (this.q.length > 0 && this.q[0].at <= to) {
      const tm = this.q.shift()!;
      if (this.cancelled.delete(tm.id)) continue;
      this.t = Math.max(this.t, tm.at);
      tm.fn();
    }
    this.t = Math.max(this.t, to);
  }

  advance(ms: number): void {
    this.runUntil(this.t + ms);
  }
}
