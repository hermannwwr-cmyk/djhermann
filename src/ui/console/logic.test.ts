import { describe, expect, it } from 'vitest';
import { SCRATCH_SEC_PER_REV, TEMPO_MAX, TEMPO_MIN } from '../../core/types';
import {
  KNOB_DETENT,
  TAU,
  angleDelta,
  angleToSec,
  clampRaw,
  eqToNorm,
  fineGain,
  formatPitch,
  formatRemain,
  fromRaw,
  knobArcPath,
  meterFall,
  meterSegments,
  normToEq,
  normToTempo,
  platterAngle,
  platterZone,
  ringNudge,
  tempoToNorm,
  toRaw,
  wavePxPerTrackSec,
  METER_SEGMENTS,
  RING_INNER,
} from './logic';

describe('detent travel', () => {
  it('round-trips values outside the dead zone', () => {
    for (const v of [-1, -0.5, -0.01, 0, 0.01, 0.3, 1]) expect(fromRaw(toRaw(v, 0.05), 0.05)).toBeCloseTo(v, 12);
  });
  it('rests on 0 inside the dead zone', () => {
    expect(fromRaw(0.049, 0.05)).toBe(0);
    expect(fromRaw(-0.05, 0.05)).toBe(0);
    expect(fromRaw(0.06, 0.05)).toBeCloseTo(0.01, 12);
  });
  it('hits both ends exactly after a long drag', () => {
    let raw = toRaw(0, KNOB_DETENT);
    for (let i = 0; i < 40; i++) raw = clampRaw(raw - 0.0937, KNOB_DETENT);
    expect(fromRaw(raw, KNOB_DETENT)).toBe(-1);
    expect(normToEq(fromRaw(raw, KNOB_DETENT))).toBe(0);
    for (let i = 0; i < 80; i++) raw = clampRaw(raw + 0.0937, KNOB_DETENT);
    expect(fromRaw(raw, KNOB_DETENT)).toBe(1);
  });
});

describe('tempo fader', () => {
  it('puts faster at the bottom (+1) and slower at the top (-1)', () => {
    expect(tempoToNorm(TEMPO_MAX)).toBe(1);
    expect(tempoToNorm(TEMPO_MIN)).toBe(-1);
    expect(tempoToNorm(1)).toBe(0);
    expect(normToTempo(1)).toBeCloseTo(TEMPO_MAX, 12);
    expect(normToTempo(-1)).toBeCloseTo(TEMPO_MIN, 12);
  });
  it('round-trips and clamps', () => {
    for (const t of [0.93, 0.99, 1.0005, 1.07]) expect(normToTempo(tempoToNorm(t))).toBeCloseTo(t, 12);
    expect(tempoToNorm(2)).toBe(1);
  });
  it('slow fingers move in fine steps', () => {
    expect(fineGain(0)).toBeCloseTo(0.3);
    expect(fineGain(1000)).toBe(1);
    // 1 px at the slowest gain on a ~110 px half-travel is well under 0.05 %
    const pctPerPx = ((TEMPO_MAX - 1) * 100 * fineGain(5)) / 110;
    expect(pctPerPx).toBeLessThan(0.05);
  });
  it('formats pitch with a real minus sign', () => {
    expect(formatPitch(1)).toBe('0.00%');
    expect(formatPitch(1.0164)).toBe('+1.64%');
    expect(formatPitch(0.995)).toBe('−0.50%');
  });
});

describe('platter', () => {
  it('turns once per SCRATCH_SEC_PER_REV of audio', () => {
    expect(platterAngle(SCRATCH_SEC_PER_REV)).toBeCloseTo(TAU);
    expect(angleToSec(TAU)).toBeCloseTo(SCRATCH_SEC_PER_REV);
  });
  it('takes the short way across the ±π seam', () => {
    expect(angleDelta(Math.PI - 0.1, -Math.PI + 0.1)).toBeCloseTo(0.2);
    expect(angleDelta(-Math.PI + 0.1, Math.PI - 0.1)).toBeCloseTo(-0.2);
    expect(angleDelta(0, 0.3)).toBeCloseTo(0.3);
  });
  it('splits the record top from the grip ring', () => {
    expect(platterZone(50, 100)).toBe('top');
    expect(platterZone(RING_INNER * 100 + 1, 100)).toBe('ring');
    expect(platterZone(110, 100)).toBe('outside');
  });
  it('bends in proportion to ring speed, clamped', () => {
    expect(ringNudge(0)).toBe(0);
    expect(ringNudge(0.225)).toBeCloseTo(0.5);
    expect(ringNudge(-5)).toBe(-1);
  });
});

describe('knobs', () => {
  it('maps EQ 0..1 to -1..1 with flat at 12 o’clock', () => {
    expect(eqToNorm(0.5)).toBe(0);
    expect(normToEq(-1)).toBe(0);
    expect(normToEq(1)).toBe(1);
  });
  it('draws no arc at the detent and a clockwise arc above it', () => {
    expect(knobArcPath(0, 48)).toBe('');
    expect(knobArcPath(0.5, 48)).toMatch(/A48 48 0 0 1 /);
    expect(knobArcPath(-0.5, 48)).toMatch(/A48 48 0 0 0 /);
  });
});

describe('meters', () => {
  it('lights more segments for louder signals, all of them at 0 dBFS', () => {
    expect(meterSegments(0)).toBe(0);
    expect(meterSegments(0.1)).toBeGreaterThan(0);
    expect(meterSegments(0.5)).toBeGreaterThan(meterSegments(0.1));
    expect(meterSegments(1)).toBe(METER_SEGMENTS);
  });
  it('attacks instantly and falls back slowly', () => {
    expect(meterFall(0.2, 0.9, 0.016)).toBe(0.9);
    const f = meterFall(0.9, 0, 0.1);
    expect(f).toBeLessThan(0.9);
    expect(f).toBeGreaterThan(0.6);
  });
});

describe('waveform scale', () => {
  it('gives equal beat spacing to decks at the same effective BPM', () => {
    // deck 1: 120 bpm native at tempo 1.05 → 126; deck 2: 126 native at tempo 1
    const beatPx = (nativeBpm: number, tempo: number): number => (60 / nativeBpm) * wavePxPerTrackSec(tempo);
    expect(beatPx(120, 1.05)).toBeCloseTo(beatPx(126, 1), 9);
  });
  it('formats the time left', () => {
    expect(formatRemain(10, 190.2)).toBe('−3:01');
    expect(formatRemain(200, 190)).toBe('−0:00');
  });
});
