import { describe, expect, test } from 'vitest';
import type { BeatEnergy, SectionKind, TrackSection } from '../core/types';
import { estimateSections } from './sections';
import { analyzeTrack } from './index';
import { synthTrack } from './synth';

const energyOf = (bar: number[]): BeatEnergy => {
  const empty = new Float32Array(0);
  return { div: 4, low: empty, mid: empty, high: empty, bar: Float32Array.from(bar) };
};

const fill = (n: number, v: number | ((i: number) => number)): number[] =>
  Array.from({ length: n }, (_, i) => (typeof v === 'number' ? v : v(i)));

/**
 * Every bar covered once, in order, with every boundary on the same 4-bar phase (bar 0, or a
 * pickup of 1-3 bars), except at the very end.
 */
function expectTiling(sections: TrackSection[], bars: number): void {
  let next = 0;
  const phase = sections.length > 1 ? (sections[0].startBar + sections[0].bars) % 4 : 0;
  for (const s of sections) {
    expect(s.startBar).toBe(next);
    expect(s.bars).toBeGreaterThan(0);
    expect(s.energy).toBeGreaterThanOrEqual(0);
    expect(s.energy).toBeLessThanOrEqual(1);
    if (s.startBar + s.bars < bars) expect((s.startBar + s.bars) % 4).toBe(phase);
    next += s.bars;
  }
  expect(next).toBe(bars);
}

const kindAt = (sections: TrackSection[], bar: number): SectionKind | undefined =>
  sections.find((s) => bar >= s.startBar && bar < s.startBar + s.bars)?.kind;

const describeSections = (sections: TrackSection[]): string =>
  sections.map((s) => `${s.kind}@${s.startBar}+${s.bars}(${s.energy.toFixed(2)})`).join(' ');

describe('estimateSections', () => {
  test('a typical club arrangement', () => {
    const bar = [
      ...fill(8, 0.4), // intro
      ...fill(8, 0.72), // groove
      ...fill(4, (i) => 0.7 + 0.06 * i), // build
      ...fill(16, 1), // drop
      ...fill(8, 0.3), // break
      ...fill(4, (i) => 0.45 + 0.1 * i), // build
      ...fill(16, 0.98), // drop
      ...fill(8, 0.45), // outro
    ];
    const s = estimateSections(energyOf(bar));
    console.log('[sections] club:', describeSections(s));
    expectTiling(s, bar.length);
    expect(kindAt(s, 0)).toBe('intro');
    expect(kindAt(s, 24)).toBe('drop');
    expect(kindAt(s, 38)).toBe('break');
    expect(kindAt(s, 50)).toBe('drop');
    expect(kindAt(s, bar.length - 1)).toBe('outro');
    expect(kindAt(s, 45)).toBe('build');
    // drops carry the most energy, the break the least
    const drop = s.find((x) => x.kind === 'drop')!;
    const brk = s.find((x) => x.kind === 'break')!;
    expect(drop.energy).toBeGreaterThan(0.9);
    expect(brk.energy).toBeLessThan(0.5);
  });

  test('bar loudness measured on a built-in track (groove nearly as loud as the drop)', () => {
    // energy.bar of "Northbound Signal" from src/music, analysed on its catalog grid;
    // exact: intro 0+8, groove 8+8, build 16+4, drop 20+16, break 36+8, build 44+4, drop 48+8, outro 56+8
    const bar = [0.78, 0.78, 0.78, 0.78, 0.82, 0.83, 0.83, 0.85, 0.94, 0.93, 0.92, 0.94, 0.95, 0.94, 0.93, 0.95, 0.97, 0.96, 0.93, 0.74, 1.00, 0.99, 1.00, 1.00, 1.00, 0.99, 1.00, 0.98, 1.00, 0.99, 1.00, 1.00, 1.00, 0.99, 1.00, 0.99, 0.43, 0.40, 0.40, 0.43, 0.68, 0.66, 0.67, 0.66, 0.95, 0.95, 0.92, 0.76, 1.00, 0.99, 1.00, 1.00, 1.00, 0.99, 1.00, 0.98, 0.94, 0.93, 0.90, 0.85, 0.80, 0.80, 0.80, 0.80, 0.50];
    const s = estimateSections(energyOf(bar));
    console.log('[sections] built-in:', describeSections(s));
    expectTiling(s, bar.length);
    expect(kindAt(s, 0)).toBe('intro');
    expect(kindAt(s, 10)).toBe('groove');
    for (const b of [20, 28, 35, 48, 55]) expect(kindAt(s, b)).toBe('drop');
    expect(kindAt(s, 37)).toBe('break');
    expect(kindAt(s, 46)).toBe('build');
    expect(kindAt(s, 60)).toBe('outro');
  });

  test('a flat track is one groove', () => {
    const bar = fill(40, (i) => 0.8 + 0.02 * Math.sin(i));
    const s = estimateSections(energyOf(bar));
    expectTiling(s, 40);
    expect(s).toHaveLength(1);
    expect(s[0].kind).toBe('groove');
  });

  test('tiny inputs', () => {
    expect(estimateSections(energyOf([]))).toEqual([]);
    const s = estimateSections(energyOf([0.5, 0.6, 0.7]));
    expectTiling(s, 3);
  });

  test('odd lengths and a 2-bar pickup are still tiled without gaps', () => {
    const bar = [...fill(2, 0.2), ...fill(16, 0.5), ...fill(16, 1), ...fill(8, 0.3), ...fill(13, 1), ...fill(3, 0.4)];
    const s = estimateSections(energyOf(bar));
    console.log('[sections] pickup:', describeSections(s));
    expectTiling(s, bar.length);
    expect(kindAt(s, 20)).toBe('drop');
    expect(kindAt(s, 0)).toBe('intro');
  });

  test('random energy never breaks the tiling', () => {
    let seed = 9;
    const rand = (): number => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let k = 0; k < 200; k++) {
      const n = 1 + Math.floor(rand() * 150);
      const bar = fill(n, () => rand());
      expectTiling(estimateSections(energyOf(bar)), n);
    }
  });

  test('on a synthetic track (analysed for real) the sections follow the arrangement', async () => {
    const track = synthTrack({ bpm: 126, firstBeatSec: 0.2, bars: 64, seed: 4 });
    const { energy } = await analyzeTrack(track.pcm, track.grid);
    const s = estimateSections(energy);
    console.log('[sections] synth 64 bars:', describeSections(s));
    console.log('[sections] arrangement:   ', track.parts.map((p) => `${p.kind}+${p.bars}`).join(' '));
    expectTiling(s, energy.bar.length);
    expect(kindAt(s, 0)).toBe('intro'); // pads only
    expect(kindAt(s, 28)).toBe('drop'); // first drop: bars 20-35
    expect(kindAt(s, 40)).toBe('break'); // break: bars 36-43
    expect(kindAt(s, 52)).toBe('drop'); // second drop: bars 48-55
  }, 30000);
});
