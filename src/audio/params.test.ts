import { describe, expect, it } from 'vitest';
import { eqGainDb } from '../core/mixmath';
import { analyseBlock, ballistic } from './meters';
import {
  FILTER_DEAD_ZONE,
  detectPlatform,
  echoDelaySec,
  glideLatency,
  eqBandGain,
  estimateLatencySec,
  filterSettings,
  masterVolumeGain,
} from './params';

const db = (g: number): number => 20 * Math.log10(g);

describe('EQ knob law', () => {
  it('follows core/mixmath and kills for real at 0', () => {
    expect(eqBandGain(0.5)).toBe(1);
    expect(db(eqBandGain(1))).toBeCloseTo(6, 6);
    expect(eqBandGain(0)).toBe(0);
    for (const v of [0.1, 0.25, 0.4, 0.6, 0.9]) expect(db(eqBandGain(v))).toBeCloseTo(eqGainDb(v), 6);
  });
});

describe('filter mapping', () => {
  const sr = 48000;
  it('is exactly transparent in the dead zone', () => {
    for (const v of [0, FILTER_DEAD_ZONE, -FILTER_DEAD_ZONE, 0.01]) {
      const f = filterSettings(v, sr);
      expect(f.dry).toBe(1);
      expect(f.lp).toBe(0);
      expect(f.hp).toBe(0);
    }
  });
  it('sweeps a low-pass down to 120 Hz and a high-pass up to 6 kHz', () => {
    expect(filterSettings(-1, sr).lpHz).toBeCloseTo(120, 6);
    expect(filterSettings(-1, sr).lp).toBe(1);
    expect(filterSettings(-1, sr).dry).toBe(0);
    expect(filterSettings(1, sr).hpHz).toBeCloseTo(6000, 6);
    expect(filterSettings(1, sr).hp).toBe(1);
  });
  it('moves the cutoff exponentially (equal turns, equal musical steps)', () => {
    const r1 = filterSettings(-0.4, sr).lpHz / filterSettings(-0.6, sr).lpHz;
    const r2 = filterSettings(-0.6, sr).lpHz / filterSettings(-0.8, sr).lpHz;
    expect(r1).toBeCloseTo(r2, 6);
    const h1 = filterSettings(0.6, sr).hpHz / filterSettings(0.4, sr).hpHz;
    const h2 = filterSettings(0.8, sr).hpHz / filterSettings(0.6, sr).hpHz;
    expect(h1).toBeCloseTo(h2, 6);
  });
  it('fades the filtered path in continuously out of the dead zone', () => {
    let prev = 1;
    for (let v = FILTER_DEAD_ZONE; v <= 0.2; v += 0.002) {
      const f = filterSettings(-v, sr);
      expect(prev - f.dry).toBeLessThan(0.08);
      expect(f.dry + f.lp).toBeCloseTo(1, 9);
      prev = f.dry;
    }
  });
});

describe('echo, master, latency', () => {
  it('echo is 3/4 of a beat', () => {
    expect(echoDelaySec(120)).toBeCloseTo(0.375, 9);
    expect(echoDelaySec(128 * 1.04)).toBeCloseTo((0.75 * 60) / (128 * 1.04), 9);
    expect(echoDelaySec(0)).toBeGreaterThan(0);
    expect(echoDelaySec(NaN)).toBeGreaterThan(0);
  });
  it('master volume taper', () => {
    expect(masterVolumeGain(1)).toBe(1);
    expect(masterVolumeGain(0)).toBe(0);
    expect(masterVolumeGain(0.5)).toBeCloseTo(0.25, 9);
  });
  it('latency estimate prefers a sane outputLatency, else baseLatency plus an allowance', () => {
    const g = 0.0015;
    expect(estimateLatencySec({ outputLatency: 0.04, baseLatency: 0.01, platform: 'android', graphDelay: g })).toBeCloseTo(0.0415, 9);
    // timestamps agreeing within 12 ms refine it
    expect(estimateLatencySec({ outputLatency: 0.04, measured: 0.035, platform: 'desktop', graphDelay: g })).toBeCloseTo(0.0365, 9);
    // zero / missing outputLatency: base + allowance
    expect(estimateLatencySec({ outputLatency: 0, baseLatency: 0.005, platform: 'ios', graphDelay: g })).toBeCloseTo(0.005 + 0.02 + g, 9);
    expect(estimateLatencySec({ platform: 'desktop', graphDelay: 0 })).toBeCloseTo(0.025, 9);
    // never below what the timestamps imply
    expect(estimateLatencySec({ baseLatency: 0.005, measured: 0.08, platform: 'android', graphDelay: 0 })).toBeCloseTo(0.08, 9);
  });
  it('latency changes glide, route changes jump', () => {
    expect(glideLatency(null, 0.03, 0.016)).toBe(0.03);
    // 2 ms change: a frame moves it by well under 0.1 ms, a few seconds complete it
    const step = glideLatency(0.03, 0.032, 1 / 60) - 0.03;
    expect(step * 1000).toBeLessThan(0.1);
    expect(step).toBeGreaterThan(0);
    let v = 0.03;
    for (let i = 0; i < 180; i++) v = glideLatency(v, 0.032, 1 / 60);
    expect(Math.abs(v - 0.032) * 1000).toBeLessThan(0.01);
    // Bluetooth: 150 ms more at once
    expect(glideLatency(0.03, 0.18, 1 / 60)).toBe(0.18);
  });
  it('detects the platform', () => {
    expect(detectPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('ios');
    expect(detectPlatform('Mozilla/5.0 (Macintosh)', 'MacIntel', 5)).toBe('ios');
    expect(detectPlatform('Mozilla/5.0 (Linux; Android 14)')).toBe('android');
    expect(detectPlatform('Mozilla/5.0 (X11; Linux x86_64)')).toBe('desktop');
  });
});

describe('meters', () => {
  const sr = 48000;
  const tone = (hz: number): Float32Array => {
    const a = new Float32Array(1024);
    for (let i = 0; i < a.length; i++) a[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / sr);
    return a;
  };
  it('puts energy in the right band', () => {
    const out = { peak: 0, low: 0, mid: 0, high: 0 };
    analyseBlock(tone(60), sr, out);
    expect(out.low).toBeGreaterThan(out.mid * 2);
    expect(out.low).toBeGreaterThan(out.high * 5);
    analyseBlock(tone(9000), sr, out);
    expect(out.high).toBeGreaterThan(out.mid * 2);
    expect(out.peak).toBeCloseTo(0.5, 2);
  });
  it('ballistics: instant attack, exponential release', () => {
    expect(ballistic(0.2, 0.8, 0.016, 0.2)).toBe(0.8);
    expect(ballistic(0.8, 0, 0.2, 0.2)).toBeCloseTo(0.8 * Math.exp(-1), 9);
  });
});
