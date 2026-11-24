/**
 * Following a remote deck from its ticks: where is the host's playhead (as heard from the host's
 * speaker) at a given shared time?
 *
 * The latest tick is extrapolated: target(t) = pos + (t − at)/1000 × rate. Each new tick moves that
 * line a little (jitter on the host, a tempo change, a nudge); instead of jumping, the displayed
 * position keeps a correction that fades out linearly over BLEND_MS (longer for a big correction:
 * the fade never runs faster than MAX_CORR_SPEED × rate, so the playhead never stops or runs
 * backwards during steady playback). Real discontinuities snap: another track, start/stop, a
 * scratch, a seek or anything more than SNAP_SEC off.
 *
 * Pure: no clock of its own, every call gets the shared time.
 */
import type { DeckTick } from '../core/party';
import { clamp } from '../core/math';

export const FOLLOW = {
  /** a correction fades out over at least this long (shared ms) */
  blendMs: 160,
  /** the fade never changes the playhead's speed by more than this fraction of its rate */
  maxCorrSpeed: 0.4,
  /** a correction bigger than this (track seconds) is a jump: snap */
  snapSec: 0.25,
  /** a rate change bigger than this between ticks (scratch, brake) snaps */
  snapRate: 0.25,
  /** extrapolate at most this far past the last tick (host paused / offline): then hold */
  horizonMs: 600,
} as const;

export interface FollowRef {
  at: number;
  trackId: string;
  pos: number;
  rate: number;
  playing: boolean;
  scratching: boolean;
}

export class DeckFollower {
  ref: FollowRef | null = null;
  /** the last tick as received */
  tick: DeckTick | null = null;
  private corr = 0;
  private corrAt = 0;
  private corrMs = 0;
  /** number of snaps / blends so far (diagnostics) */
  snaps = 0;
  blends = 0;

  constructor(public durationSec = Infinity) {}

  reset(): void {
    this.ref = null;
    this.tick = null;
    this.corr = 0;
  }

  /** extrapolated host position at shared time t (no smoothing) */
  target(t: number): number {
    const r = this.ref;
    if (!r) return 0;
    const dt = Math.min(t - r.at, FOLLOW.horizonMs);
    return clamp(r.pos + (dt / 1000) * r.rate, 0, this.durationSec);
  }

  /** the correction still applied at t */
  private correction(t: number): number {
    if (this.corr === 0) return 0;
    const k = this.corrMs > 0 ? (t - this.corrAt) / this.corrMs : 1;
    if (k >= 1) return 0;
    return this.corr * (k <= 0 ? 1 : 1 - k);
  }

  /** displayed position at shared time t */
  position(t: number): number {
    if (!this.ref) return 0;
    return clamp(this.target(t) + this.correction(t), 0, this.durationSec);
  }

  /** the rate to report at t (0 once the extrapolation has run past its horizon) */
  rate(t: number): number {
    const r = this.ref;
    if (!r) return 0;
    if (t - r.at > FOLLOW.horizonMs) return 0;
    const p = r.pos + ((t - r.at) / 1000) * r.rate;
    if (p >= this.durationSec || p <= 0) return 0;
    return r.rate;
  }

  /** true while the extrapolation is past its horizon (no tick for too long) */
  stale(t: number): boolean {
    return !this.ref || t - this.ref.at > FOLLOW.horizonMs;
  }

  /**
   * A new tick, valid at shared time `at`, received at shared time `now`.
   * Returns 'snap' | 'blend' | 'old' (ignored: older than the current one).
   */
  push(tick: DeckTick, at: number, now: number): 'snap' | 'blend' | 'old' {
    const old = this.ref;
    if (old && at <= old.at && old.trackId === tick.trackId) return 'old';
    const next: FollowRef = {
      at,
      trackId: tick.trackId,
      pos: tick.pos,
      rate: Number.isFinite(tick.rate) ? tick.rate : 0,
      playing: tick.playing,
      scratching: tick.scratching,
    };
    this.tick = tick;
    let snap =
      !old ||
      old.trackId !== next.trackId ||
      old.playing !== next.playing ||
      old.scratching ||
      next.scratching ||
      Math.abs(old.rate - next.rate) > FOLLOW.snapRate ||
      this.stale(now) ||
      Math.abs(next.rate) < 0.05;
    const before = old ? this.position(now) : 0;
    this.ref = next;
    const after = this.target(now);
    const corr = before - after;
    if (!snap && Math.abs(corr) > FOLLOW.snapSec) snap = true;
    if (snap) {
      this.corr = 0;
      this.snaps++;
      return 'snap';
    }
    this.corr = corr;
    this.corrAt = now;
    this.corrMs = Math.max(FOLLOW.blendMs, (Math.abs(corr) * 1000) / (FOLLOW.maxCorrSpeed * Math.abs(next.rate)));
    this.blends++;
    return 'blend';
  }
}
