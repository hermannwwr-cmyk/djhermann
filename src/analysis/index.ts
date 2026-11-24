/**
 * Audio analysis: beat grid, three-band waveform, beat-energy map, sections, tap tempo and file
 * decoding. The heavy work runs in a module Worker (main-thread fallback); the pure functions
 * underneath are exported too, for tests and tools.
 */
import type { BeatEnergy, BeatGrid, PcmData, ProgressFn, TrackAnalysis, TrackSection } from '../core/types';
import { runJob } from './client';
import { barLevels, beatCount, ENERGY_DIV } from './energy';
import type { LoudnessEnvelope } from './energy';
import type { GridHint } from './grid';
import { estimateSections as estimate } from './sections';

/** Waveform + beat energy of a track on a known grid. The caller's PCM is left untouched. */
export async function analyzeTrack(pcm: PcmData, grid: BeatGrid, onProgress?: ProgressFn): Promise<TrackAnalysis> {
  const out = await runJob({ pcm, grid, analysis: true }, onProgress);
  return out.analysis!;
}

/**
 * Detect the beat grid of steady-tempo music (70-180 BPM, 4/4). `confidence` is 0..1 (low when
 * the result is shaky: no clear beat, a drifting tempo, a guessed downbeat). `hint` limits the
 * search to ±4 % around a tempo (the player's tap tempo, or a ½× / 2× correction).
 */
export async function detectGrid(
  pcm: PcmData,
  onProgress?: ProgressFn,
  hint?: GridHint,
): Promise<{ grid: BeatGrid; confidence: number }> {
  const out = await runJob({ pcm, grid: null, hint: hint ?? null, analysis: false }, onProgress);
  return { grid: out.grid, confidence: out.confidence };
}

export interface FullAnalysis {
  grid: BeatGrid;
  confidence: number;
  analysis: TrackAnalysis;
  /** loudness envelope to keep with the track: re-estimates the sections after a grid fix */
  envelope: LoudnessEnvelope;
}

/** detectGrid + analyzeTrack in one pass (the band split runs once). Used when importing a file. */
export async function detectAndAnalyze(pcm: PcmData, onProgress?: ProgressFn, hint?: GridHint): Promise<FullAnalysis> {
  const out = await runJob({ pcm, grid: null, hint: hint ?? null, analysis: true }, onProgress);
  return { grid: out.grid, confidence: out.confidence, analysis: out.analysis!, envelope: out.envelope! };
}

/** Intro / groove / build / drop / break / outro from the bar loudness, on 4-bar boundaries. */
export function estimateSections(energy: BeatEnergy): TrackSection[] {
  return estimate(energy);
}

/**
 * Sections for a (corrected) grid from a stored loudness envelope, without decoding the file again.
 * Gives the same bar levels as the full analysis.
 */
export function sectionsFromEnvelope(envelope: LoudnessEnvelope, grid: BeatGrid, durationSec: number): TrackSection[] {
  const bars = Math.ceil(beatCount(grid, durationSec) / 4);
  const empty = new Float32Array(0);
  return estimate({ div: ENERGY_DIV, low: empty, mid: empty, high: empty, bar: barLevels(envelope, grid, bars) });
}

export { tapTempo, TAP_MIN_TAPS } from './tap';
export { decodeAudioFile, audioBufferToPcm, checkDuration, floatToInt16, MIN_TRACK_SEC, MAX_TRACK_SEC } from './decode';

// synchronous building blocks (pure; run anywhere)
export { runAnalysis, ENVELOPE_RATE, STAGE_BEAT, STAGE_LISTEN, STAGE_WAVE } from './pipeline';
export type { AnalysisJob, AnalysisOutput } from './pipeline';
export { runOnMainThread, setWorkerEnabled } from './client';
export { mixdown, computeBandPower, ENV_RATE, LOW_HZ, HIGH_HZ } from './bands';
export type { BandPower, MonoMix } from './bands';
export { computeOnsets } from './onsets';
export type { OnsetStrength } from './onsets';
export { detectGridFromOnsets, MIN_BPM, MAX_BPM } from './grid';
export type { GridHint, GridResult, GridDetails } from './grid';
export { computeWaveform, displayLevel, WAVEFORM_RATE } from './waveform';
export { computeBeatEnergy, loudnessEnvelope, barLevels, beatCount, ENERGY_DIV } from './energy';
export type { LoudnessEnvelope } from './energy';
