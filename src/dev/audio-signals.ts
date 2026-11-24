/**
 * Test signals and tracks for the audio harness: a synthetic groove (so the harness sounds like
 * music), click tracks (for timing measurements), tones and noise.
 */
import { BEATS_PER_BAR } from '../core/types';
import type { LoadedTrack, PcmData, TrackMeta } from '../core/types';
import { mockEnergy, mockSections, mockWaveform } from './mocks';

export function toPcm(L: Float32Array, R: Float32Array, sampleRate: number): PcmData {
  const n = L.length;
  const a = new Int16Array(n);
  const b = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    a[i] = Math.max(-32768, Math.min(32767, Math.round(L[i] * 32767)));
    b[i] = Math.max(-32768, Math.min(32767, Math.round(R[i] * 32767)));
  }
  return { sampleRate, length: n, channels: [a, b] };
}

/** A short click every beat (accented on the one): 2 kHz burst of 4 ms with a hard onset. */
export function clickTrack(sampleRate: number, bpm: number, firstBeatSec: number, sec: number, hz = 2000): PcmData {
  const n = Math.round(sec * sampleRate);
  const L = new Float32Array(n);
  const spb = 60 / bpm;
  const clickLen = Math.round(0.004 * sampleRate);
  for (let k = 0; ; k++) {
    const start = Math.round((firstBeatSec + k * spb) * sampleRate);
    if (start >= n) break;
    const amp = k % BEATS_PER_BAR === 0 ? 0.9 : 0.6;
    for (let i = 0; i < clickLen && start + i < n; i++) {
      // starts at full level on a rising sine: the onset is exactly `start`
      L[start + i] = amp * Math.sin((2 * Math.PI * hz * (i + 0.25 * (sampleRate / hz))) / sampleRate) * (1 - i / clickLen);
    }
  }
  return toPcm(L, L, sampleRate);
}

export function tone(sampleRate: number, hz: number, amp: number, sec: number): PcmData {
  const n = Math.round(sec * sampleRate);
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = amp * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return toPcm(L, L, sampleRate);
}

/** A small, recognisable groove: kick, offbeat hat, clap, rolling bass and a chord stab. */
export function groove(sampleRate: number, bpm: number, firstBeatSec: number, bars: number, seed = 1): PcmData {
  const spb = 60 / bpm;
  const sec = firstBeatSec + bars * BEATS_PER_BAR * spb + 0.5;
  const n = Math.round(sec * sampleRate);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  let s = seed >>> 0 || 1;
  const rand = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
  const roots = [55, 55 * 1.189, 55 * 0.891, 55 * 1.335];
  for (let beat = 0; beat < bars * BEATS_PER_BAR; beat++) {
    const t0 = firstBeatSec + beat * spb;
    const i0 = Math.round(t0 * sampleRate);
    const root = roots[Math.floor(beat / 8) % roots.length];
    // kick
    let ph = 0;
    for (let i = 0; i < 0.25 * sampleRate && i0 + i < n; i++) {
      const t = i / sampleRate;
      ph += (2 * Math.PI * (48 + 110 * Math.exp(-t * 30))) / sampleRate;
      const v = Math.sin(ph) * Math.exp(-t * 9) * 0.75;
      L[i0 + i] += v;
      R[i0 + i] += v;
    }
    // offbeat hat
    const ih = Math.round((t0 + spb / 2) * sampleRate);
    let hp = 0;
    for (let i = 0; i < 0.05 * sampleRate && ih + i < n; i++) {
      const x = rand();
      const v = (x - hp) * Math.exp(-i / (0.012 * sampleRate)) * 0.25;
      hp = x;
      L[ih + i] += v * 0.8;
      R[ih + i] += v;
    }
    // clap on 2 and 4
    if (beat % 2 === 1) {
      for (let i = 0; i < 0.12 * sampleRate && i0 + i < n; i++) {
        const v = rand() * Math.exp(-i / (0.03 * sampleRate)) * 0.3;
        L[i0 + i] += v;
        R[i0 + i] += v * 0.9;
      }
    }
    // bass: two eighths per beat
    for (let e = 0; e < 2; e++) {
      const ib = Math.round((t0 + (e * spb) / 2) * sampleRate);
      const f = root * (e === 1 ? 2 : 1);
      for (let i = 0; i < (spb / 2) * sampleRate * 0.9 && ib + i < n; i++) {
        const t = i / sampleRate;
        const x = (f * t) % 1;
        const v = (2 * x - 1) * 0.18 * Math.min(1, t * 400) * Math.exp(-t * 6);
        L[ib + i] += v;
        R[ib + i] += v;
      }
    }
    // chord stab on the offbeat of every other beat
    if (beat % 2 === 0) {
      for (let i = 0; i < 0.18 * sampleRate && ih + i < n; i++) {
        const t = i / sampleRate;
        const env = Math.min(1, t * 300) * Math.exp(-t * 14) * 0.07;
        const v = (Math.sin(2 * Math.PI * root * 8 * t) + Math.sin(2 * Math.PI * root * 8 * 1.26 * t) + Math.sin(2 * Math.PI * root * 8 * 1.5 * t)) * env;
        L[ih + i] += v * 1.1;
        R[ih + i] += v * 0.9;
      }
    }
  }
  return toPcm(L, R, sampleRate);
}

export function trackFrom(pcm: PcmData, id: string, title: string, bpm: number, firstBeatSec: number, hue = 200): LoadedTrack {
  const meta: TrackMeta = {
    id,
    title,
    artist: 'Audio harness',
    source: 'builtin',
    durationSec: pcm.length / pcm.sampleRate,
    grid: { bpm, firstBeatSec },
    key: null,
    sections: mockSections(),
    art: { hueA: hue, hueB: (hue + 120) % 360, seed: id.length * 31 + Math.round(bpm) },
  };
  return { meta, pcm, waveform: mockWaveform(meta), energy: mockEnergy(meta) };
}
