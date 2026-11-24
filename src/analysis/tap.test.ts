import { describe, expect, test } from 'vitest';
import { tapTempo } from './tap';

const taps = (bpm: number, count: number, start = 1000, jitterMs = 0, seed = 1): number[] => {
  let s = seed;
  const rand = (): number => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  return Array.from({ length: count }, (_, i) => start + (i * 60000) / bpm + (rand() * 2 - 1) * jitterMs);
};

describe('tapTempo', () => {
  test('null until there are four taps', () => {
    expect(tapTempo([])).toBeNull();
    expect(tapTempo(taps(120, 3))).toBeNull();
    expect(tapTempo(taps(120, 4))).toBeCloseTo(120, 1);
  });

  test('exact taps give the exact tempo', () => {
    for (const bpm of [72, 98.5, 124, 128, 140, 174]) expect(tapTempo(taps(bpm, 12))).toBeCloseTo(bpm, 1);
  });

  test('human jitter of ±25 ms over 16 taps stays within 1 BPM', () => {
    for (const seed of [1, 2, 3, 4, 5]) expect(Math.abs(tapTempo(taps(126, 16, 0, 25, seed))! - 126)).toBeLessThan(1);
  });

  test('only the last run counts: a pause of over two seconds starts again', () => {
    const first = taps(90, 8, 0);
    const second = taps(128, 6, first[first.length - 1] + 3000);
    expect(tapTempo([...first, ...second])).toBeCloseTo(128, 1);
    // three taps after the pause are not enough yet
    expect(tapTempo([...first, ...second.slice(0, 3)])).toBeNull();
  });

  test('a missed tap or a double tap does not throw the tempo off', () => {
    const t = taps(120, 12);
    const missed = t.filter((_, i) => i !== 5);
    expect(tapTempo(missed)).toBeCloseTo(120, 1);
    const doubled = [...t.slice(0, 6), t[5] + 30, ...t.slice(6)];
    expect(tapTempo(doubled)).toBeCloseTo(120, 1);
  });

  test('folds into the 70-180 BPM range', () => {
    expect(tapTempo(taps(62, 8))).toBeCloseTo(124, 1);
    expect(tapTempo(taps(240, 8))).toBeCloseTo(120, 1);
  });

  test('follows a tempo change: only the last 16 taps count', () => {
    const slow = taps(100, 20, 0);
    const fast = taps(130, 16, slow[slow.length - 1] + 60000 / 130);
    expect(tapTempo([...slow, ...fast])).toBeCloseTo(130, 1);
  });
});
