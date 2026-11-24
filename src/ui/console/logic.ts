/**
 * Pure maths behind the console controls: detents, the tempo fader, the platter, meters.
 * No DOM in here, so it can be unit-tested.
 */
import { SCRATCH_SEC_PER_REV, TEMPO_MAX, TEMPO_MIN } from '../../core/types';
import { clamp, clamp01 } from '../../core/math';

export const TAU = Math.PI * 2;

// ───────────── detents ─────────────
// A control with a centre detent keeps a "raw" travel value while it is dragged. The detent is a
// dead zone in that travel: the value rests on 0 for `zone` of travel either side, and every value
// outside it is still reachable. That is how a mechanical detent feels, and fine moves stay possible.

/** Raw travel that corresponds to value `v` (-1..1, detent at 0). */
export const toRaw = (v: number, zone: number): number => (v === 0 ? 0 : v + Math.sign(v) * zone);

/** Value for a raw travel position. */
export function fromRaw(raw: number, zone: number): number {
  if (Math.abs(raw) <= zone) return 0;
  const v = raw - Math.sign(raw) * zone;
  // snap the ends exactly (a full-down EQ must read 0, not 5e-17)
  return Math.abs(v) >= 1 - 1e-9 ? Math.sign(v) : v;
}

export const clampRaw = (raw: number, zone: number): number => clamp(raw, -1 - zone, 1 + zone);

// ───────────── tempo fader ─────────────

/** Tempo multiplier → fader travel -1..1. +1 is the fastest setting, which sits at the BOTTOM of the fader. */
export function tempoToNorm(tempo: number): number {
  const t = clamp(tempo, TEMPO_MIN, TEMPO_MAX);
  return t >= 1 ? (t - 1) / (TEMPO_MAX - 1) : (t - 1) / (1 - TEMPO_MIN);
}

export function normToTempo(n: number): number {
  const x = clamp(n, -1, 1);
  return x >= 0 ? 1 + x * (TEMPO_MAX - 1) : 1 + x * (1 - TEMPO_MIN);
}

/** Pitch in percent, e.g. 1.0164 → 1.64 */
export const pitchPercent = (tempo: number): number => (tempo - 1) * 100;

/** "+1.64%" / "−0.50%" / "0.00%" (a real minus sign, fixed width with tabular figures). */
export function formatPitch(tempo: number): string {
  const p = Math.round(pitchPercent(tempo) * 100) / 100;
  if (p === 0) return '0.00%';
  return `${p > 0 ? '+' : '−'}${Math.abs(p).toFixed(2)}%`;
}

/**
 * Drag gain for the tempo fader: a slow finger moves the cap less than 1:1, so a beatmatch can be
 * trimmed in steps of a few hundredths of a percent; a fast finger moves it 1:1.
 */
export function fineGain(speedPxPerSec: number): number {
  const t = clamp01((Math.abs(speedPxPerSec) - 25) / 175);
  return 0.3 + 0.7 * t * t * (3 - 2 * t);
}

// ───────────── platter ─────────────

/** Platter angle in radians for a track position: one revolution per SCRATCH_SEC_PER_REV. */
export const platterAngle = (positionSec: number): number => (positionSec / SCRATCH_SEC_PER_REV) * TAU;

/** Shortest signed difference between two angles, -π..π. Clockwise on screen is positive. */
export function angleDelta(prev: number, next: number): number {
  let d = (next - prev) % TAU;
  if (d > Math.PI) d -= TAU;
  else if (d < -Math.PI) d += TAU;
  return d;
}

/** Track seconds the record moves when the finger turns it by `rad`. */
export const angleToSec = (rad: number): number => (rad / TAU) * SCRATCH_SEC_PER_REV;

/** The grip ring starts at this fraction of the platter radius. Inside it is the record. */
export const RING_INNER = 0.845;
/** Inside this fraction a finger is on the spindle: too close to the centre to read an angle. */
export const HUB_RADIUS = 0.09;

export type PlatterZone = 'top' | 'ring' | 'outside';

export function platterZone(dist: number, radius: number): PlatterZone {
  if (dist > radius * 1.04) return 'outside';
  return dist >= radius * RING_INNER ? 'ring' : 'top';
}

/** Ring speed (revolutions per second) that gives a full pitch bend. */
export const RING_FULL_REV_PER_SEC = 0.45;

/** Pitch bend -1..1 for a ring turned at `revPerSec` (clockwise = faster). */
export const ringNudge = (revPerSec: number): number => clamp(revPerSec / RING_FULL_REV_PER_SEC, -1, 1);

// ───────────── knobs ─────────────

/** Knob travel either side of 12 o'clock, in degrees (300° in total). */
export const KNOB_SWEEP_DEG = 150;
/** Vertical drag in px for the whole range. */
export const KNOB_DRAG_PX = 180;
export const KNOB_DETENT = 0.055;

export const eqToNorm = (v: number): number => clamp01(v) * 2 - 1;
export const normToEq = (n: number): number => clamp01((n + 1) / 2);

/** SVG path of the value arc from 12 o'clock to the pointer, in a 100×100 box. Empty at the detent. */
export function knobArcPath(n: number, r: number): string {
  if (n === 0) return '';
  const a = (clamp(n, -1, 1) * KNOB_SWEEP_DEG * Math.PI) / 180;
  const x = 50 + r * Math.sin(a);
  const y = 50 - r * Math.cos(a);
  return `M50 ${(50 - r).toFixed(2)}A${r} ${r} 0 0 ${n > 0 ? 1 : 0} ${x.toFixed(2)} ${y.toFixed(2)}`;
}

// ───────────── meters ─────────────

/** Level (0..1 peak) at which each of the ten LED segments lights: 7 green, 2 amber, 1 red (clip). */
const METER_DB = [-30, -24, -19, -15, -12, -9, -6.5, -4, -2, -0.3];
export const METER_SEGMENTS = METER_DB.length;
const METER_LEVELS = METER_DB.map((db) => Math.pow(10, db / 20));

/** Number of lit segments for a peak level. */
export function meterSegments(level: number): number {
  let n = 0;
  while (n < METER_SEGMENTS && level >= METER_LEVELS[n]) n++;
  return n;
}

/** Meter ballistics: instant attack, steady release (full scale in about 0.6 s). */
export const meterFall = (shown: number, level: number, dt: number): number =>
  level >= shown ? level : Math.max(level, shown - dt * 1.7);

// ───────────── display ─────────────

/** Time left on the track as "−3:07". */
export function formatRemain(positionSec: number, durationSec: number): string {
  const s = Math.max(0, Math.ceil(durationSec - positionSec));
  return `−${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Shared blink clock so every blinking LED on the console blinks together. */
export const blinkOn = (nowMs: number, periodMs = 900): boolean => nowMs % periodMs < periodMs * 0.5;

/** Beats within this phase offset count as "lined up" on the phase meter and the waveforms. */
export const PHASE_LOCK_BEATS = 0.035;

// ───────────── waveform ─────────────

/** Scroll speed of both waveforms at native tempo, in CSS px per second. */
export const WAVE_PX_PER_SEC = 92;

/**
 * Pixels per second of TRACK time for a deck. The picture is stretched by 1/tempo so that
 * pixels always mean real time: two decks at the same effective BPM get the same beat spacing
 * and scroll at the same speed, whatever their native tempos are.
 */
export const wavePxPerTrackSec = (tempo: number, base = WAVE_PX_PER_SEC): number =>
  base / clamp(tempo || 1, TEMPO_MIN, TEMPO_MAX);
