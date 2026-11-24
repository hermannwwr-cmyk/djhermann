/**
 * Arrangement template and beat/frame maths shared by every built-in track. Pure.
 *
 * Every track is 64 bars of 4/4. Beat 0 (the first kick) sits at exactly FIRST_BEAT_SEC and
 * beat n at FIRST_BEAT_SEC + n * 60 / bpm; events are placed on the nearest sample frame.
 */
import { BEATS_PER_BAR } from '../core/types';
import type { SectionKind, TrackSection } from '../core/types';

export const FIRST_BEAT_SEC = 0.1;
/** Ring-out after the last bar. Shorter than one bar at every tempo, so a track is exactly 64 bars. */
export const TAIL_SEC = 1.8;
export const TOTAL_BARS = 64;
export const TOTAL_BEATS = TOTAL_BARS * BEATS_PER_BAR;
export const STEPS_PER_BEAT = 4;
export const STEPS_PER_BAR = 16;

/** kind, bars, energy: in play order. */
export const SECTION_TEMPLATE: readonly (readonly [SectionKind, number, number])[] = [
  ['intro', 8, 0.35],
  ['groove', 8, 0.55],
  ['build', 4, 0.7],
  ['drop', 16, 1],
  ['break', 8, 0.3],
  ['build', 4, 0.75],
  ['drop', 8, 1],
  ['outro', 8, 0.4],
];

/** First bar of each section, by name, for arranging. */
export const BAR = { intro: 0, groove: 8, build1: 16, drop1: 20, breakdown: 36, build2: 44, drop2: 48, outro: 56, end: 64 } as const;

export function buildSections(): TrackSection[] {
  let bar = 0;
  return SECTION_TEMPLATE.map(([kind, bars, energy]) => {
    const s: TrackSection = { kind, startBar: bar, bars, energy };
    bar += bars;
    return s;
  });
}

export const beatToSec = (bpm: number, beat: number): number => FIRST_BEAT_SEC + (beat * 60) / bpm;

/** Sample frame of a (fractional) beat. The same musical time at any sample rate, to half a sample. */
export const beatToFrame = (bpm: number, sampleRate: number, beat: number): number =>
  Math.round(beatToSec(bpm, beat) * sampleRate);

export const trackDurationSec = (bpm: number): number => FIRST_BEAT_SEC + (TOTAL_BEATS * 60) / bpm + TAIL_SEC;

export const trackFrames = (bpm: number, sampleRate: number): number => Math.round(trackDurationSec(bpm) * sampleRate);

/**
 * Position of a sixteenth-note step with swing. `swing` is the share of the eighth note taken by its
 * first sixteenth: 0.5 = straight, 0.58 = lazy. Only the odd sixteenths move, so beats stay on the grid.
 */
export function swungStep(step: number, swing: number): number {
  const whole = Math.floor(step);
  const frac = step - whole;
  return whole % 2 === 1 && frac === 0 ? whole + (swing - 0.5) * 2 : step;
}
