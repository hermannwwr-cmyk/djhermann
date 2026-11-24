/**
 * The logic behind the stage, kept free of drawing so it can be tested:
 * what a given hype looks like, and the short-lived moods that game events put the room in.
 */
import { clamp01, damp, smoothstep } from '../../core/math';

/** Everything the stage derives from the hype, each 0..1. */
export interface StageLook {
  /** overall light level; never fully dark, so the room is still a room at zero hype */
  light: number;
  /** share of the crowd that is on the floor */
  presence: number;
  /** share of the crowd with hands in the air */
  arms: number;
  /** how hard the crowd bounces on the beat */
  bounce: number;
  /** share of the beams that are lit */
  beams: number;
  /** how fast the beams sweep; 0 = still */
  sweep: number;
  lasers: number;
  confetti: number;
  /** phone lights and camera flashes in the crowd */
  sparkle: number;
  /** the hype meter is on fire */
  fire: number;
  /** the hype meter is urgent */
  danger: number;
}

export const newLook = (): StageLook => ({
  light: 0,
  presence: 0,
  arms: 0,
  bounce: 0,
  beams: 0,
  sweep: 0,
  lasers: 0,
  confetti: 0,
  sparkle: 0,
  fire: 0,
  danger: 0,
});

/** Hype 0..1 → the look of the room. Low: dim, thin, still. High: hands up, sweeping beams, lasers, confetti. */
export function stageLook(hype: number, out: StageLook = newLook()): StageLook {
  const h = clamp01(hype);
  out.light = 0.2 + 0.8 * smoothstep(0.02, 0.8, h);
  out.presence = 0.32 + 0.68 * smoothstep(0.04, 0.62, h);
  out.arms = smoothstep(0.3, 0.88, h);
  out.bounce = smoothstep(0.14, 0.8, h);
  out.beams = 0.18 + 0.82 * smoothstep(0.08, 0.72, h);
  out.sweep = smoothstep(0.16, 0.9, h);
  out.lasers = smoothstep(0.76, 0.9, h);
  out.confetti = smoothstep(0.86, 0.97, h);
  out.sparkle = smoothstep(0.45, 0.9, h);
  out.fire = smoothstep(0.8, 0.93, h);
  out.danger = 1 - smoothstep(0.16, 0.3, h);
  return out;
}

export type HypeZone = 'low' | 'mid' | 'fire';

/** Which label the hype meter wears. `prev` gives hysteresis so it does not flicker on a threshold. */
export function hypeZone(hype: number, prev: HypeZone = 'mid'): HypeZone {
  const lowAt = prev === 'low' ? 0.26 : 0.22;
  const fireAt = prev === 'fire' ? 0.82 : 0.86;
  if (hype < lowAt) return 'low';
  if (hype >= fireAt) return 'fire';
  return 'mid';
}

const decay = (v: number, halfLifeSec: number, dt: number): number => {
  const next = v * Math.pow(0.5, dt / halfLifeSec);
  return next < 0.003 ? 0 : next;
};

/**
 * Short-lived moods on top of the hype, each an envelope 0..1:
 * - sick: a trainwreck or dead air: lights turn sickly, the crowd goes flat. Held, then released.
 * - cheer: a mission went well: every hand goes up.
 * - burst: a drop: one big flash of light.
 * - dip: a mission failed: the room sags for a moment.
 */
export class StageMood {
  sick = 0;
  cheer = 0;
  burst = 0;
  dip = 0;
  private sickHold = 0;

  sicken(holdSec = 2.2): void {
    this.sickHold = Math.max(this.sickHold, holdSec);
    this.cheer = 0;
  }

  /** the player fixed it: let go of the sick look now */
  recover(): void {
    this.sickHold = 0;
  }

  applaud(strength = 1): void {
    this.cheer = Math.max(this.cheer, clamp01(strength));
    // a crowd that cheers is over it
    this.sickHold = Math.min(this.sickHold, 0.15);
  }

  flash(strength = 1): void {
    this.burst = Math.max(this.burst, clamp01(strength));
  }

  sag(strength = 1): void {
    this.dip = Math.max(this.dip, clamp01(strength));
  }

  step(dt: number): void {
    if (this.sickHold > 0) {
      this.sickHold = Math.max(0, this.sickHold - dt);
      this.sick = damp(this.sick, 1, 0.07, dt);
    } else {
      this.sick = decay(this.sick, 0.4, dt);
    }
    this.cheer = decay(this.cheer, 0.6, dt);
    this.burst = decay(this.burst, 0.2, dt);
    this.dip = decay(this.dip, 0.45, dt);
  }
}
