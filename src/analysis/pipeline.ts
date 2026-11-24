/**
 * The whole analysis of one track, from PCM to waveform + beat energy (+ beat grid), as one
 * job that runs either in the analysis Worker or, as a fallback, on the main thread.
 *
 *   PCM ─ mixdown ─ band power ─┬─ waveform
 *                               ├─ onsets ─┬─ beat grid (when not given)
 *                               │          └─ beat energy (on the grid)
 *                               └─ loudness envelope (stored, to re-estimate sections later)
 */
import type { BeatGrid, PcmData, ProgressFn, TrackAnalysis } from '../core/types';
import { computeBandPower, mixdown } from './bands';
import { computeBeatEnergy, loudnessEnvelope } from './energy';
import type { LoudnessEnvelope } from './energy';
import { detectGridFromOnsets } from './grid';
import type { GridHint, GridResult } from './grid';
import { computeOnsets, ENERGY_HOLDS, GRID_HOLDS } from './onsets';
import { computeWaveform } from './waveform';

/** Rate of the stored loudness envelope (frames per second). */
export const ENVELOPE_RATE = 100;

/** Progress stage labels reported by the analysis (short, for a loading line). */
export const STAGE_LISTEN = 'Listening';
export const STAGE_BEAT = 'Finding the beat';
export const STAGE_WAVE = 'Drawing the waveform';

export interface AnalysisJob {
  pcm: PcmData;
  /** the beat grid, or null to detect it */
  grid: BeatGrid | null;
  /** tempo hint for the detection */
  hint?: GridHint | null;
  /** compute the waveform and beat energy (false: only detect the grid) */
  analysis: boolean;
}

export interface AnalysisOutput {
  grid: BeatGrid;
  /** 1 when the grid was given */
  confidence: number;
  /** present when the job asked for it */
  analysis: TrackAnalysis | null;
  envelope: LoudnessEnvelope | null;
  /** diagnostics of the detection (null when the grid was given) */
  details: GridResult['details'] | null;
}

/**
 * Run an analysis job. `pause` (when given) is awaited between stages so the main thread can
 * breathe when this runs there; the Worker passes nothing and the job runs straight through.
 */
export async function runAnalysis(
  job: AnalysisJob,
  onProgress?: ProgressFn,
  pause?: () => Promise<void>,
): Promise<AnalysisOutput> {
  const detect = !job.grid;
  // share of the progress bar: band split, onsets, grid, energy + waveform
  const wBands = detect ? 0.62 : 0.8;
  const wOnsets = detect ? 0.08 : 0;
  const wGrid = detect ? 0.18 : 0;
  const report = (p: number, stage: string): void => onProgress?.(Math.min(1, Math.max(0, p)), stage);

  report(0, STAGE_LISTEN);
  const mix = mixdown(job.pcm);
  if (pause) await pause();
  const bands = computeBandPower(mix, (p) => report(p * wBands, STAGE_LISTEN));
  if (pause) await pause();

  let grid: BeatGrid;
  let confidence = 1;
  let details: GridResult['details'] | null = null;
  if (job.grid) {
    grid = job.grid;
  } else {
    const onsets = computeOnsets(bands, GRID_HOLDS);
    report(wBands + wOnsets, STAGE_BEAT);
    if (pause) await pause();
    const result = detectGridFromOnsets(onsets, bands, job.hint ?? undefined);
    grid = result.grid;
    confidence = result.confidence;
    details = result.details;
    report(wBands + wOnsets + wGrid, STAGE_WAVE);
    if (pause) await pause();
  }

  let analysis: TrackAnalysis | null = null;
  let envelope: LoudnessEnvelope | null = null;
  if (job.analysis) {
    const waveform = computeWaveform(bands);
    const energy = computeBeatEnergy(bands, computeOnsets(bands, ENERGY_HOLDS), grid);
    analysis = { waveform, energy };
    envelope = loudnessEnvelope(bands, ENVELOPE_RATE);
  }
  report(1, STAGE_WAVE);
  return { grid, confidence, analysis, envelope, details };
}

/** Every buffer of an output, for transferring it out of the Worker. */
export function outputBuffers(out: AnalysisOutput): ArrayBuffer[] {
  const list: ArrayBuffer[] = [];
  if (out.analysis) {
    const { waveform, energy } = out.analysis;
    for (const a of [waveform.low, waveform.mid, waveform.high, energy.low, energy.mid, energy.high, energy.bar]) {
      list.push(a.buffer as ArrayBuffer);
    }
  }
  if (out.envelope) list.push(out.envelope.data.buffer as ArrayBuffer);
  return list;
}
