import { BEATS_PER_BAR } from './types';
import type { BeatGrid, DeckSnapshot, TrackMeta, TrackSection } from './types';
import { fract } from './math';

/** Fractional beat at a track time. Beat 0 is the grid's first downbeat; earlier audio is negative. */
export const beatAtSec = (grid: BeatGrid, sec: number): number => ((sec - grid.firstBeatSec) * grid.bpm) / 60;

export const secAtBeat = (grid: BeatGrid, beat: number): number => grid.firstBeatSec + (beat * 60) / grid.bpm;

export const secPerBeat = (bpm: number): number => (bpm > 0 ? 60 / bpm : 0);

export const barAtBeat = (beat: number): number => Math.floor(beat / BEATS_PER_BAR);

/** 0..1 inside the current beat. */
export const beatPhase = (beat: number): number => fract(beat);

/** 0..1 inside the current bar. */
export const barPhase = (beat: number): number => fract(beat / BEATS_PER_BAR);

/** Total whole beats / bars from the first downbeat to the end of the track. */
export const totalBeats = (meta: TrackMeta): number => Math.floor(beatAtSec(meta.grid, meta.durationSec));
export const totalBars = (meta: TrackMeta): number => Math.floor(totalBeats(meta) / BEATS_PER_BAR);

/**
 * Signed distance from `beat` to the nearest multiple of `every` beats, in beats.
 * Negative = the grid line is still ahead (early), positive = already passed (late).
 */
export function distToGrid(beat: number, every = 1): number {
  const p = fract(beat / every);
  return (p > 0.5 ? p - 1 : p) * every;
}

/**
 * Beat-phase offset between two decks in beats, wrapped to -0.5..0.5.
 * 0 = their beats land together. Positive = deck `a` is ahead of deck `b`.
 */
export function phaseOffsetBeats(a: DeckSnapshot, b: DeckSnapshot): number {
  const d = fract(a.beat - b.beat);
  return d > 0.5 ? d - 1 : d;
}

/** The same offset as time, using the slower deck's beat length (worst case), in ms. */
export function phaseOffsetMs(a: DeckSnapshot, b: DeckSnapshot): number {
  const bpm = Math.min(a.bpm, b.bpm);
  return bpm > 0 ? phaseOffsetBeats(a, b) * (60000 / bpm) : 0;
}

/** Section containing a bar, or null. */
export function sectionAtBar(meta: TrackMeta, bar: number): TrackSection | null {
  for (const s of meta.sections) {
    if (bar >= s.startBar && bar < s.startBar + s.bars) return s;
  }
  return null;
}

export const sectionAtBeat = (meta: TrackMeta, beat: number): TrackSection | null =>
  sectionAtBar(meta, barAtBeat(beat));
