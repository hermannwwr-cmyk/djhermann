import { describe, expect, test } from 'vitest';
import { ImportError } from '../core/types';
import { audioBufferToPcm, checkDuration, floatToInt16 } from './decode';
import { analyzeTrack, detectAndAnalyze, detectGrid, sectionsFromEnvelope } from './index';
import { estimateSections } from './sections';
import { synthTrack } from './synth';

const checksum = (a: Int16Array): number => {
  let h = 0;
  for (let i = 0; i < a.length; i += 7) h = (h * 31 + a[i]) | 0;
  return h;
};

describe('analysis entry points (main-thread fallback in Node)', () => {
  const track = synthTrack({ bpm: 132, firstBeatSec: 0.27, bars: 32, seed: 11 });

  test('never touch the caller’s PCM', async () => {
    const sums = track.pcm.channels.map(checksum);
    const lengths = track.pcm.channels.map((c) => c.length);
    await analyzeTrack(track.pcm, track.grid);
    await detectGrid(track.pcm);
    expect(track.pcm.channels.map(checksum)).toEqual(sums);
    expect(track.pcm.channels.map((c) => c.length)).toEqual(lengths);
  }, 30000);

  test('detectAndAnalyze = detectGrid + analyzeTrack, with an envelope that gives the same sections', async () => {
    const progress: number[] = [];
    const full = await detectAndAnalyze(track.pcm, (p) => progress.push(p));
    const alone = await detectGrid(track.pcm);
    expect(full.grid).toEqual(alone.grid);
    expect(full.confidence).toBe(alone.confidence);
    expect(progress[progress.length - 1]).toBe(1);
    const duration = track.pcm.length / track.pcm.sampleRate;
    const fromEnvelope = sectionsFromEnvelope(full.envelope, full.grid, duration);
    expect(fromEnvelope.map((s) => [s.kind, s.startBar, s.bars])).toEqual(
      estimateSections(full.analysis.energy).map((s) => [s.kind, s.startBar, s.bars]),
    );
  }, 30000);

  test('a tempo hint keeps the detection near it (½× fix)', async () => {
    const { grid } = await detectGrid(track.pcm, undefined, { bpm: 66 });
    expect(grid.bpm).toBeCloseTo(66, 1);
  }, 30000);
});

describe('decoding helpers', () => {
  test('float to 16-bit with clipping', () => {
    expect(Array.from(floatToInt16(Float32Array.from([0, 1, -1, 2, -2, 0.5])))).toEqual([0, 32767, -32768, 32767, -32768, 16384]);
  });

  test('mono becomes two independent channels; stereo stays stereo', () => {
    const mono = Float32Array.from([0, 0.5, -0.5]);
    const pcm = audioBufferToPcm({ sampleRate: 48000, length: 3, numberOfChannels: 1, getChannelData: () => mono });
    expect(pcm.channels).toHaveLength(2);
    expect(Array.from(pcm.channels[1])).toEqual(Array.from(pcm.channels[0]));
    expect(pcm.channels[1]).not.toBe(pcm.channels[0]);
    expect(pcm.channels[0].buffer).not.toBe(pcm.channels[1].buffer);
    const st = audioBufferToPcm({
      sampleRate: 44100,
      length: 2,
      numberOfChannels: 2,
      getChannelData: (c) => Float32Array.from(c === 0 ? [0.25, 0.25] : [-0.25, -0.25]),
    });
    expect(st.channels[0][0]).toBeGreaterThan(0);
    expect(st.channels[1][0]).toBeLessThan(0);
  });

  test('durations outside 20 s .. 12 min are refused with the right code', () => {
    const code = (sec: number): string | null => {
      try {
        checkDuration(sec);
        return null;
      } catch (e) {
        return e instanceof ImportError ? e.code : 'other';
      }
    };
    expect(code(5)).toBe('too-short');
    expect(code(19.9)).toBe('too-short');
    expect(code(Number.NaN)).toBe('too-short');
    expect(code(20)).toBeNull();
    expect(code(720)).toBeNull();
    expect(code(721)).toBe('too-long');
  });
});
