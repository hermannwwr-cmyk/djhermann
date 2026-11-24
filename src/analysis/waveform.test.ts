import { describe, expect, test } from 'vitest';
import type { PcmData, WaveformData } from '../core/types';
import { computeBandPower, mixdown } from './bands';
import { computeBeatEnergy } from './energy';
import { computeOnsets } from './onsets';
import { synthTrack } from './synth';
import { computeWaveform, displayLevel, WAVEFORM_RATE } from './waveform';

function tone(freqs: number[], sec = 3, sampleRate = 48000, amp = 0.3): PcmData {
  const n = sec * sampleRate;
  const ch = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const f of freqs) v += Math.sin((2 * Math.PI * f * i) / sampleRate);
    ch[i] = Math.round((v / freqs.length) * amp * 32767);
  }
  return { sampleRate, length: n, channels: [ch, ch.slice()] };
}

const mean = (a: Uint8Array, from = 0, to = a.length): number => {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i];
  return s / Math.max(1, to - from);
};

const quantile = (a: Uint8Array, p: number): number => {
  const s = Array.from(a).sort((x, y) => x - y);
  return s[Math.floor(p * (s.length - 1))];
};

describe('waveform', () => {
  test('at least 200 buckets per second, covering the track', () => {
    const pcm = tone([440], 4);
    const wf = computeWaveform(computeBandPower(mixdown(pcm)));
    expect(wf.rate).toBeGreaterThanOrEqual(200);
    expect(WAVEFORM_RATE).toBeGreaterThanOrEqual(200);
    expect(Math.abs(wf.length - 4 * wf.rate)).toBeLessThanOrEqual(2);
  });

  test('the three bands split at about 180 Hz and 2.5 kHz', () => {
    // a mixture: each band hears its own tone; the others stay far below it
    const bandOf = (freq: number): Record<'low' | 'mid' | 'high', number> => {
      const pcm = tone([freq, 20]); // the 20 Hz partner sits under the low band's rumble filter
      const bands = computeBandPower(mixdown(pcm));
      const rms = (a: Float32Array): number => Math.sqrt(a.reduce((s, v) => s + v, 0) / a.length);
      return { low: rms(bands.low), mid: rms(bands.mid), high: rms(bands.high) };
    };
    const low = bandOf(70);
    expect(low.low).toBeGreaterThan(20 * low.mid);
    expect(low.low).toBeGreaterThan(20 * low.high);
    const mid = bandOf(800);
    expect(mid.mid).toBeGreaterThan(20 * mid.low);
    expect(mid.mid).toBeGreaterThan(20 * mid.high);
    const high = bandOf(6000);
    expect(high.high).toBeGreaterThan(20 * high.mid);
    expect(high.high).toBeGreaterThan(20 * high.low);
  });

  test('display scaling: monotonic, reference at about 90 %, never pinned by a slightly louder peak', () => {
    expect(displayLevel(0)).toBe(0);
    expect(displayLevel(-1)).toBe(0);
    expect(displayLevel(1)).toBeGreaterThan(200);
    expect(displayLevel(1)).toBeLessThan(240);
    expect(displayLevel(1.5)).toBeLessThan(255);
    let prev = -1;
    for (let r = 0; r <= 4; r += 0.01) {
      const v = displayLevel(r);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    // quiet parts stay visible: -20 dB is still about a quarter of the height
    expect(displayLevel(0.1)).toBeGreaterThan(50);
  });

  test('a real-sounding track fills the range: quiet intro visible, loud drop not pinned', () => {
    const track = synthTrack({ bpm: 128, firstBeatSec: 0.1, bars: 64, seed: 2 });
    const wf: WaveformData = computeWaveform(computeBandPower(mixdown(track.pcm)));
    const barSec = (60 / 128) * 4;
    const bucket = (bar: number): number => Math.round((0.1 + bar * barSec) * wf.rate);
    const introMid = mean(wf.mid, bucket(0), bucket(8));
    const dropLow = quantile(wf.low.subarray(bucket(20), bucket(36)), 0.9);
    const pinned = (a: Uint8Array): number => a.reduce((n, v) => n + (v >= 254 ? 1 : 0), 0) / a.length;
    console.log(
      `[waveform] intro mid ${introMid.toFixed(0)}, drop low p90 ${dropLow}, pinned low ${(pinned(wf.low) * 100).toFixed(2)}% mid ${(pinned(wf.mid) * 100).toFixed(2)}% high ${(pinned(wf.high) * 100).toFixed(2)}%`,
    );
    expect(introMid).toBeGreaterThan(40); // the pad intro is clearly visible
    expect(dropLow).toBeGreaterThan(170); // kicks reach high
    for (const b of [wf.low, wf.mid, wf.high]) expect(pinned(b)).toBeLessThan(0.01);
    // kicks are drawn on the kicks: the low band peaks within 15 ms after each beat in the drop
    let onTime = 0;
    const beats = 64;
    for (let k = 0; k < beats; k++) {
      const t = 0.1 + (20 * 4 + k) * (60 / 128);
      const from = Math.round(t * wf.rate) - 6;
      let best = from;
      for (let i = from; i < from + 40; i++) if (wf.low[i] > wf.low[best]) best = i;
      const dt = best / wf.rate - t;
      if (dt > -0.005 && dt < 0.03) onTime++;
    }
    expect(onTime).toBeGreaterThanOrEqual(beats - 2);
  });

  test('silence draws as silence', () => {
    const n = 48000 * 2;
    const wf = computeWaveform(computeBandPower(mixdown({ sampleRate: 48000, length: n, channels: [new Int16Array(n)] })));
    expect(Math.max(...wf.low, ...wf.mid, ...wf.high)).toBe(0);
  });
});

describe('beat energy', () => {
  const track = synthTrack({ bpm: 124, firstBeatSec: 0.37, bars: 64, seed: 5 });
  const bands = computeBandPower(mixdown(track.pcm));
  const onsets = computeOnsets(bands);
  const energy = computeBeatEnergy(bands, onsets, track.grid);
  // first drop: bars 20..35
  const dropFrom = 20 * 4 * 4;
  const dropTo = 36 * 4 * 4;
  const avgAt = (a: Float32Array, sub: number): number => {
    let s = 0;
    let n = 0;
    for (let i = dropFrom + sub; i < dropTo; i += 4) {
      s += a[i];
      n++;
    }
    return s / n;
  };

  test('shape: sixteenths, bars, values 0..1', () => {
    expect(energy.div).toBe(4);
    const beats = Math.floor(((track.pcm.length / track.pcm.sampleRate - track.grid.firstBeatSec) * 124) / 60);
    expect(energy.low.length).toBe(beats * 4);
    expect(energy.bar.length).toBe(Math.ceil(beats / 4));
    for (const a of [energy.low, energy.mid, energy.high, energy.bar]) {
      for (const v of a) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  test('kicks on the beat, hats on the off-beat, claps on 2 and 4', () => {
    const low = [0, 1, 2, 3].map((s) => avgAt(energy.low, s));
    const high = [0, 1, 2, 3].map((s) => avgAt(energy.high, s));
    console.log(`[energy] drop low by sixteenth ${low.map((v) => v.toFixed(2)).join(' ')} | high ${high.map((v) => v.toFixed(2)).join(' ')}`);
    expect(low[0]).toBeGreaterThan(0.8);
    expect(low[0]).toBeGreaterThan(3 * Math.max(low[1], low[3]));
    expect(high[2]).toBeGreaterThan(0.6);
    expect(high[2]).toBeGreaterThan(3 * Math.max(high[1], high[3]));
    // clap: beats 2 and 4 of the bar (odd beats) are stronger in the mid band than beats 1 and 3
    let odd = 0;
    let even = 0;
    for (let i = dropFrom; i < dropTo; i += 4) {
      if (Math.floor(i / 4) % 2 === 1) odd += energy.mid[i];
      else even += energy.mid[i];
    }
    expect(odd).toBeGreaterThan(1.5 * even);
  });

  test('bar loudness: the drop is loud, the break and intro quiet', () => {
    const avg = (from: number, to: number): number => energy.bar.slice(from, to).reduce((s, v) => s + v, 0) / (to - from);
    expect(avg(20, 36)).toBeGreaterThan(0.85);
    expect(avg(36, 44)).toBeLessThan(0.5);
    expect(avg(0, 8)).toBeLessThan(0.5);
  });

  test('normalised by percentile: one huge hit does not flatten the rest', () => {
    // add one very loud click in the middle of the drop
    const pcm = { ...track.pcm, channels: track.pcm.channels.map((c) => c.slice()) };
    const at = Math.round((track.grid.firstBeatSec + 100.25 * (60 / 124)) * pcm.sampleRate);
    for (let i = 0; i < 400; i++) for (const c of pcm.channels) c[at + i] = i % 2 ? 32000 : -32000;
    const b2 = computeBandPower(mixdown(pcm));
    const e2 = computeBeatEnergy(b2, computeOnsets(b2), track.grid);
    let s = 0;
    let n = 0;
    for (let i = dropFrom; i < dropTo; i += 4) {
      s += e2.low[i];
      n++;
    }
    expect(s / n).toBeGreaterThan(0.8);
  });
});
