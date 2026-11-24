import { describe, expect, it } from 'vitest';
import { computeLayout, laneCenter, padRowHeight, scaleAt, yAtScale } from './layout';

describe('playfield layout', () => {
  const sizes: [number, number][] = [
    [360, 150],
    [390, 150],
    [390, 250],
    [390, 430],
    [430, 560],
    [520, 430],
  ];

  it('fits the pads and a usable highway in every slot from 150 px up', () => {
    for (const [w, h] of sizes) {
      const padH = padRowHeight(w, h);
      expect(padH).toBeGreaterThanOrEqual(58);
      expect(h - padH).toBeGreaterThanOrEqual(80);
      for (const d of ['chill', 'club', 'festival'] as const) {
        const L = computeLayout(w, h, padH, d);
        expect(L.hitY).toBeGreaterThan(40);
        expect(L.hitY).toBeLessThan(L.h);
        expect(L.lookahead).toBeGreaterThanOrEqual(2);
        expect(L.lookahead).toBeLessThanOrEqual(6);
        expect(L.noteH).toBeGreaterThanOrEqual(10);
      }
    }
  });

  it('the pads get taller with the slot (drawer closed) but stay about square', () => {
    const small = padRowHeight(390, 150);
    const big = padRowHeight(390, 430);
    expect(big).toBeGreaterThan(small + 30);
    const padW = (390 - 20 - 24) / 4;
    expect(big).toBeLessThanOrEqual(Math.round(padW + 24));
  });

  it('perspective: scale 1 at the hit line, the far end at the top edge, lanes centred', () => {
    const L = computeLayout(390, 430 - padRowHeight(390, 430), 0, 'club');
    expect(scaleAt(L, 0)).toBeCloseTo(1, 6);
    expect(yAtScale(L, 1)).toBeCloseTo(L.hitY, 4);
    expect(yAtScale(L, scaleAt(L, L.lookahead))).toBeCloseTo(0, 3);
    // monotonic: further notes are smaller and higher
    expect(scaleAt(L, 1)).toBeLessThan(scaleAt(L, 0.5));
    expect(laneCenter(L, 0) + laneCenter(L, 3)).toBeCloseTo(L.w, 4);
  });
});
