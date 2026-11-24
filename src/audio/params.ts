/**
 * Pure parameter mappings of the mixer and the latency estimate. No Web Audio in here, so all of
 * it is unit-tested.
 */
import { clamp, clamp01, smoothstep } from '../core/math';
import { eqGainDb } from '../core/mixmath';

// ───────────────────────────── EQ ─────────────────────────────

/** Crossover frequencies of the three-band isolator (Linkwitz-Riley, 24 dB/octave). */
export const EQ_LOW_HZ = 250;
export const EQ_HIGH_HZ = 2500;
/** BiquadFilterNode low-pass / high-pass take their Q in dB: this is a Butterworth section. */
export const BUTTERWORTH_Q_DB = -3.0102999566398116;
export const ALLPASS_Q = Math.SQRT1_2;

/** EQ knob 0..1 → linear gain of that band. 0.5 = 1, 1 = +6 dB, 0 = exactly 0 (a true kill). */
export function eqBandGain(value: number): number {
  const v = clamp01(value);
  if (v <= 0.001) return 0;
  return Math.pow(10, eqGainDb(v) / 20);
}

// ───────────────────────────── filter ─────────────────────────────

export const FILTER_DEAD_ZONE = 0.03;
export const FILTER_LP_MIN_HZ = 120;
export const FILTER_LP_MAX_HZ = 20000;
export const FILTER_HP_MIN_HZ = 20;
export const FILTER_HP_MAX_HZ = 6000;
/** resonance at the cutoff once the filter is well engaged, in dB */
export const FILTER_RESONANCE_DB = 7;

export interface FilterSettings {
  /** gain of the unfiltered path: exactly 1 in the dead zone */
  dry: number;
  /** gain of the low-pass path */
  lp: number;
  /** gain of the high-pass path */
  hp: number;
  lpHz: number;
  hpHz: number;
  /** Q of the active filter in dB */
  qDb: number;
}

/**
 * Filter knob -1..1 → what the three parallel paths do. Inside the dead zone the signal takes the
 * dry path only (bit-transparent). Outside it the frequency moves exponentially with the knob, so
 * equal turns sound like equal steps; the filtered path fades in over the first few percent while
 * its cutoff is still outside the audible band, and the resonance grows from none to full.
 */
export function filterSettings(value: number, sampleRate: number): FilterSettings {
  const v = clamp(value, -1, 1);
  const a = Math.abs(v);
  const top = Math.min(FILTER_LP_MAX_HZ, sampleRate * 0.45);
  if (a <= FILTER_DEAD_ZONE) {
    return { dry: 1, lp: 0, hp: 0, lpHz: top, hpHz: FILTER_HP_MIN_HZ, qDb: BUTTERWORTH_Q_DB };
  }
  const x = (a - FILTER_DEAD_ZONE) / (1 - FILTER_DEAD_ZONE); // 0..1 through the active range
  const wet = smoothstep(0, 0.06, x);
  const qDb = BUTTERWORTH_Q_DB + (FILTER_RESONANCE_DB - BUTTERWORTH_Q_DB) * smoothstep(0, 0.25, x);
  if (v < 0) {
    const lpHz = top * Math.pow(FILTER_LP_MIN_HZ / top, x);
    return { dry: 1 - wet, lp: wet, hp: 0, lpHz, hpHz: FILTER_HP_MIN_HZ, qDb };
  }
  const hpHz = FILTER_HP_MIN_HZ * Math.pow(FILTER_HP_MAX_HZ / FILTER_HP_MIN_HZ, x);
  return { dry: 1 - wet, lp: 0, hp: wet, lpHz: top, hpHz, qDb };
}

// ───────────────────────────── echo ─────────────────────────────

export const ECHO_BEATS = 0.75;
export const ECHO_FEEDBACK = 0.55;
/** level of the first repeat relative to the signal that was sent */
export const ECHO_LEVEL = 0.65;
/** low-pass inside the loop: every repeat is a little darker than the one before */
export const ECHO_DAMP_HZ = 4200;
export const ECHO_MAX_SEC = 1.5;
export const ECHO_DEFAULT_SEC = (ECHO_BEATS * 60) / 122;

/** Delay time of the echo for an effective tempo in BPM (3/4 of a beat). */
export function echoDelaySec(bpm: number): number {
  if (!(bpm > 0) || !isFinite(bpm)) return ECHO_DEFAULT_SEC;
  return clamp((ECHO_BEATS * 60) / bpm, 0.05, ECHO_MAX_SEC - 0.05);
}

// ───────────────────────────── master ─────────────────────────────

/** Master volume 0..1 → linear gain (squared taper, like a volume slider should feel). */
export function masterVolumeGain(value: number): number {
  const v = clamp01(value);
  return v * v;
}

/** Look-ahead of the master limiter. */
export const LIMITER_LOOKAHEAD_SEC = 0.0015;
/** The master never exceeds this (-0.5 dBFS). */
export const LIMITER_CEILING = 0.944;
export const LIMITER_RELEASE_SEC = 0.12;

export const limiterLookaheadFrames = (sampleRate: number): number =>
  Math.max(8, Math.round(LIMITER_LOOKAHEAD_SEC * sampleRate));

/** Time constant used to smooth every mixer parameter (seconds). */
export const PARAM_SMOOTH_SEC = 0.007;

// ───────────────────────────── latency ─────────────────────────────

export type Platform = 'ios' | 'android' | 'desktop';

export function detectPlatform(userAgent: string, platform = '', maxTouchPoints = 0): Platform {
  if (/iPad|iPhone|iPod/.test(userAgent)) return 'ios';
  if (platform === 'MacIntel' && maxTouchPoints > 1) return 'ios'; // iPadOS pretending to be a Mac
  if (/Android/i.test(userAgent)) return 'android';
  return 'desktop';
}

/**
 * What to add to baseLatency when the browser does not report an output latency: the part of the
 * path it does not know about (mixer, driver, converter). Typical figures for the built-in
 * speaker or wired headphones; Bluetooth is far beyond any of these and needs calibration.
 */
export const PLATFORM_ALLOWANCE_SEC: Record<Platform, number> = { ios: 0.02, android: 0.06, desktop: 0.015 };
/** Hardware delay the output timestamps of Safari do not include. */
export const TIMESTAMP_HW_ALLOWANCE_SEC: Record<Platform, number> = { ios: 0.012, android: 0, desktop: 0 };

export interface LatencyInputs {
  /** ctx.outputLatency (seconds), if the browser has it */
  outputLatency?: number | null;
  /** ctx.baseLatency (seconds), if the browser has it */
  baseLatency?: number | null;
  /** output latency measured from output timestamps (ClockSync.measuredOutputLatency) */
  measured?: number | null;
  platform: Platform;
  /** delay added by our own graph (limiter look-ahead), seconds */
  graphDelay: number;
}

const sane = (v: number | null | undefined, lo: number, hi: number): v is number =>
  typeof v === 'number' && isFinite(v) && v >= lo && v <= hi;

/**
 * The automatic estimate of the total output latency, in seconds: something rendered at context
 * time T is heard at T + this.
 *
 * - The browser reports a sane outputLatency: use it. If output timestamps give the same figure
 *   (within 12 ms) use theirs instead: it is the same quantity, continuous and unrounded.
 * - Otherwise: baseLatency plus an allowance for the platform; never less than what the output
 *   timestamps imply.
 * - Plus the delay of our own graph.
 */
export function estimateLatencySec(i: LatencyInputs): number {
  let out: number;
  if (sane(i.outputLatency, 0.0005, 0.5)) {
    out = i.outputLatency;
    if (sane(i.measured, 0, 0.6) && Math.abs(i.measured - i.outputLatency) <= 0.012) out = i.measured;
  } else {
    const base = sane(i.baseLatency, 0, 0.2) ? i.baseLatency : 0.01;
    out = base + PLATFORM_ALLOWANCE_SEC[i.platform];
    if (sane(i.measured, 0, 0.6)) out = Math.max(out, i.measured + TIMESTAMP_HW_ALLOWANCE_SEC[i.platform]);
  }
  return out + Math.max(0, i.graphDelay);
}

/** Changes of the automatic latency estimate glide with this time constant… */
export const LATENCY_GLIDE_SEC = 0.5;
/** …unless they are this large (a new output route, Bluetooth): then they apply at once. */
export const LATENCY_JUMP_SEC = 0.04;

/**
 * Move the latency in use towards a new estimate. Small changes (the estimate switching between
 * sources, settling) glide so as-heard positions do not step; a new output route jumps.
 */
export function glideLatency(current: number | null, target: number, dtSec: number): number {
  if (current === null || !isFinite(current) || Math.abs(target - current) > LATENCY_JUMP_SEC) return target;
  const dt = clamp(dtSec, 0, 1);
  return current + (target - current) * (1 - Math.exp(-dt / LATENCY_GLIDE_SEC));
}
