import { describe, expect, test } from 'vitest';
import { BEATS_PER_BAR } from '../core/types';
import type { BeatGrid, PcmData } from '../core/types';
import { computeBandPower, mixdown } from './bands';
import { detectGridFromOnsets } from './grid';
import type { GridResult } from './grid';
import { computeOnsets } from './onsets';
import { synthNoise, synthTrack } from './synth';
import type { SynthOptions } from './synth';

function detect(pcm: PcmData): { result: GridResult; ms: number } {
  const t0 = performance.now();
  const bands = computeBandPower(mixdown(pcm));
  const result = detectGridFromOnsets(computeOnsets(bands), bands);
  return { result, ms: performance.now() - t0 };
}

interface Errors {
  bpmErr: number;
  /** beat phase error at the first beat, ms */
  phaseMs: number;
  /** grid error at the end of the track, ms (tempo error × length + phase error) */
  endMs: number;
  /** 0 = the detected beat 0 is a true downbeat */
  downbeatOffset: number;
}

function errors(truth: BeatGrid, got: BeatGrid, durationSec: number): Errors {
  const beat = 60 / truth.bpm;
  const dBeats = (got.firstBeatSec - truth.firstBeatSec) / beat;
  const nearest = Math.round(dBeats);
  const phaseMs = (dBeats - nearest) * beat * 1000;
  const beatsTotal = (durationSec - got.firstBeatSec) / beat;
  const endMs = phaseMs + (60 / got.bpm - beat) * beatsTotal * 1000;
  return {
    bpmErr: got.bpm - truth.bpm,
    phaseMs,
    endMs,
    downbeatOffset: ((nearest % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR,
  };
}

function check(name: string, opts: SynthOptions, minConfidence = 0.6): void {
  const track = synthTrack(opts);
  const duration = track.pcm.length / track.pcm.sampleRate;
  const { result, ms } = detect(track.pcm);
  const e = errors(track.grid, result.grid, duration);
  console.log(
    `[grid] ${name.padEnd(24)} true ${track.grid.bpm} @${track.grid.firstBeatSec}s → ${result.grid.bpm.toFixed(4)} @${result.grid.firstBeatSec.toFixed(4)}s` +
      ` | bpm err ${e.bpmErr.toFixed(4)} phase ${e.phaseMs.toFixed(2)} ms end ${e.endMs.toFixed(2)} ms downbeat +${e.downbeatOffset}` +
      ` | conf ${result.confidence.toFixed(2)} | ${duration.toFixed(0)} s audio in ${ms.toFixed(0)} ms`,
  );
  expect(Math.abs(e.bpmErr)).toBeLessThanOrEqual(0.02);
  expect(Math.abs(e.phaseMs)).toBeLessThanOrEqual(12);
  expect(Math.abs(e.endMs)).toBeLessThanOrEqual(12);
  expect(e.downbeatOffset).toBe(0);
  expect(result.confidence).toBeGreaterThanOrEqual(minConfidence);
}

const T = 60000;

describe('detectGrid: four-on-the-floor (intro without drums, quiet break)', () => {
  const cases: [number, number, number][] = [
    [90, 0.25, 44100],
    [100, 0.05, 48000],
    [120, 0.731, 44100],
    [124.5, 0.02, 48000],
    [128, 0.1, 44100],
    [140, 0.333, 48000],
    [174, 0.18, 44100],
  ];
  for (const [bpm, first, sr] of cases) {
    test(`house ${bpm} BPM, first beat ${first}s`, () => check(`house ${bpm}`, { bpm, firstBeatSec: first, sampleRate: sr, bars: 64, seed: bpm }), T);
  }
  test('house without the off-beat bass, 124.5', () =>
    check('house no bass 124.5', { bpm: 124.5, firstBeatSec: 0.4, bars: 64, offbeatBass: false, seed: 3 }), T);
  test('house at a fractional tempo (127.83) is not snapped', () =>
    check('house 127.83', { bpm: 127.83, firstBeatSec: 0.21, bars: 64 }), T);
  test('house with a lot of noise', () => check('house noisy 128', { bpm: 128, firstBeatSec: 0.3, bars: 64, noise: 0.05 }), T);
  test('very quiet house', () => check('house quiet 122', { bpm: 122, firstBeatSec: 0.3, bars: 64, gain: 0.05, noise: 0.0005 }), T);
  test('first downbeat after several seconds of silence', () =>
    check('house late start 126', { bpm: 126, firstBeatSec: 4.37, bars: 64 }), T);
});

describe('detectGrid: click tracks', () => {
  for (const [bpm, first] of [
    [90, 0.25],
    [120, 0.731],
    [124.5, 0.02],
    [174, 0.18],
  ] as const) {
    test(`click ${bpm}`, () => check(`click ${bpm}`, { bpm, firstBeatSec: first, bars: 32, pattern: 'click', seed: bpm }), T);
  }
});

describe('detectGrid: other drum patterns', () => {
  test('drum & bass breakbeat at 174 is not halved', () =>
    check('breakbeat 174', { bpm: 174, firstBeatSec: 0.3, bars: 64, pattern: 'breakbeat' }, 0.5), T);
  test('kick-snare backbeat at 150', () => check('backbeat 150', { bpm: 150, firstBeatSec: 0.3, bars: 64, pattern: 'backbeat' }, 0.5), T);
  test('kick-snare backbeat at 96', () => check('backbeat 96', { bpm: 96, firstBeatSec: 0.3, bars: 64, pattern: 'backbeat' }, 0.5), T);
});

describe('detectGrid: honesty', () => {
  test('noise has no beat: confidence is low', () => {
    const { result } = detect(synthNoise(60));
    console.log(`[grid] noise → ${result.grid.bpm.toFixed(2)} conf ${result.confidence.toFixed(2)}`);
    expect(result.confidence).toBeLessThan(0.2);
  }, T);

  test('silence gives no grid and zero confidence', () => {
    const n = 44100 * 30;
    const { result } = detect({ sampleRate: 44100, length: n, channels: [new Int16Array(n), new Int16Array(n)] });
    expect(result.confidence).toBe(0);
  }, T);

  test('a tempo that drifts (live drummer) gets a lower confidence than a steady one', () => {
    // two halves at slightly different tempos, spliced together
    const a = synthTrack({ bpm: 120, firstBeatSec: 0.1, bars: 32, tailSec: 0 });
    const b = synthTrack({ bpm: 121.5, firstBeatSec: 0, bars: 32, parts: [{ kind: 'drop', bars: 32, kick: true, hat: true, clap: true, bass: true }] });
    const n = a.pcm.length + b.pcm.length;
    const channels = [0, 1].map((c) => {
      const out = new Int16Array(n);
      out.set(a.pcm.channels[c]);
      out.set(b.pcm.channels[c], a.pcm.length);
      return out;
    });
    const { result } = detect({ sampleRate: 44100, length: n, channels });
    const steady = detect(synthTrack({ bpm: 120, firstBeatSec: 0.1, bars: 64 }).pcm).result;
    console.log(`[grid] drifting → ${result.grid.bpm.toFixed(3)} conf ${result.confidence.toFixed(2)} (steady ${steady.confidence.toFixed(2)})`);
    expect(result.confidence).toBeLessThan(steady.confidence - 0.2);
  }, T);
});

describe('detectGrid: speed', () => {
  test('a five-minute track analyses in a few seconds', () => {
    const track = synthTrack({ bpm: 128, firstBeatSec: 0.12, bars: 160, sampleRate: 48000 });
    const duration = track.pcm.length / track.pcm.sampleRate;
    const { result, ms } = detect(track.pcm);
    const e = errors(track.grid, result.grid, duration);
    console.log(`[grid] 5 min track (${duration.toFixed(0)} s): ${ms.toFixed(0)} ms, end error ${e.endMs.toFixed(2)} ms`);
    expect(duration).toBeGreaterThan(290);
    expect(Math.abs(e.endMs)).toBeLessThan(5);
    expect(ms).toBeLessThan(5000);
  }, T);
});
