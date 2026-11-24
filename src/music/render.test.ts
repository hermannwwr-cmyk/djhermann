import { describe, expect, it } from 'vitest';
import type { PcmData } from '../core/types';
import { HalfRateReverb, Limiter, PlateReverb } from './fx';
import { renderTrackSync } from './render';
import { SONGS } from './songs';
import { beatToFrame, trackFrames } from './timeline';
import { SOUND_NAMES, renderSound } from './sounds';
import { createBuiltinMusic } from './index';

const SR = 8000; // low rate keeps the full renders fast; the maths is the same at 44.1 / 48 kHz

function peakOf(p: PcmData): number {
  let m = 0;
  for (const ch of p.channels) for (let i = 0; i < ch.length; i++) m = Math.max(m, Math.abs(ch[i]));
  return m / 32768;
}

describe('track render', () => {
  const song = SONGS[2];
  const a = renderTrackSync(song, SR);

  it('is the right length, stereo, under -1 dBFS and DC free', () => {
    expect(a.sampleRate).toBe(SR);
    expect(a.length).toBe(trackFrames(song.bpm, SR));
    expect(a.channels).toHaveLength(2);
    expect(peakOf(a)).toBeLessThanOrEqual(0.8913);
    for (const ch of a.channels) {
      let s = 0;
      for (let i = 0; i < ch.length; i++) s += ch[i];
      expect(Math.abs(s / ch.length / 32768)).toBeLessThan(1e-3);
    }
  });

  it('is bit-identical when rendered again', () => {
    const b = renderTrackSync(song, SR);
    expect(Buffer.from(b.channels[0].buffer).equals(Buffer.from(a.channels[0].buffer))).toBe(true);
    expect(Buffer.from(b.channels[1].buffer).equals(Buffer.from(a.channels[1].buffer))).toBe(true);
  });

  it('puts the kick onsets exactly on the grid', () => {
    const k = renderTrackSync(song, SR, { solo: ['kick'] }).channels[0];
    for (const bar of [0, 16, 32, 63]) {
      const at = beatToFrame(song.bpm, SR, bar * 4);
      expect(k[at - 1], `bar ${bar} before`).toBe(0);
      let first = -1;
      for (let i = at - 20; i < at + 20; i++) {
        if (Math.abs(k[i]) > 200) {
          first = i;
          break;
        }
      }
      expect(first - at, `bar ${bar}`).toBeGreaterThanOrEqual(0);
      expect(first - at, `bar ${bar}`).toBeLessThanOrEqual(1);
    }
  });

  it('starts with the kick alone on beat 0', () => {
    const from = beatToFrame(song.bpm, SR, 0);
    let pre = 0;
    for (let i = 0; i < from; i++) pre = Math.max(pre, Math.abs(a.channels[0][i]));
    expect(pre).toBe(0);
  });
});

describe('effects', () => {
  it('the limiter never lets a sample past its ceiling', () => {
    const lim = new Limiter(SR, 0.5);
    const n = 4000;
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      l[i] = Math.sin(i * 0.3) * (i % 700 < 30 ? 3 : 0.4);
      r[i] = -l[i] * 0.8;
    }
    lim.process(l, r, n);
    for (let i = 0; i < n; i++) expect(Math.abs(l[i])).toBeLessThanOrEqual(0.5 + 1e-6);
  });

  it('the half-rate reverb gives the same result for any chunking', () => {
    const p = { decay: 0.7, damping: 0.4, preDelay: 0.01 };
    const input = new Float32Array(3001);
    input[0] = 1;
    input[1500] = -0.5;
    const one = new HalfRateReverb(SR, p, 4000);
    const l1 = new Float32Array(3001);
    const r1 = new Float32Array(3001);
    one.process(input, l1, r1, 3001, 1);
    const two = new HalfRateReverb(SR, p, 4000);
    const l2 = new Float32Array(3001);
    const r2 = new Float32Array(3001);
    let at = 0;
    for (const size of [7, 300, 1, 1001, 1692]) {
      const lo = new Float32Array(size);
      const ro = new Float32Array(size);
      two.process(input.subarray(at, at + size), lo, ro, size, 1);
      l2.set(lo, at);
      r2.set(ro, at);
      at += size;
    }
    expect(Array.from(l2)).toEqual(Array.from(l1));
    expect(Array.from(r2)).toEqual(Array.from(r1));
    expect(Math.max(...l1.map(Math.abs))).toBeGreaterThan(0.001);
  });

  it('the plate tail decays instead of building up', () => {
    const rev = new PlateReverb(SR, { decay: 0.75, damping: 0.4, preDelay: 0 });
    const n = SR * 6;
    const input = new Float32Array(n);
    input[0] = 1;
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    rev.process(input, l, r, n, 1);
    const energy = (from: number, to: number) => l.subarray(from, to).reduce((s, x) => s + x * x, 0);
    expect(energy(SR * 4, SR * 5)).toBeLessThan(energy(SR / 4, SR) * 0.01);
  });
});

describe('one-shot sounds', () => {
  for (const sr of [44100, 48000]) {
    it(`renders every sound at ${sr} Hz, from sample 0, normalised, ending in silence`, () => {
      const limits: Record<string, number> = { boom: 1.2, clap: 0.35, zap: 0.35, horn: 0.7, tick: 0.06, tock: 0.06, success: 1.2, fail: 0.6, cheer: 1.6, whoosh: 0.9 };
      for (const name of SOUND_NAMES) {
        const p = renderSound(name, sr);
        expect(p.sampleRate).toBe(sr);
        expect(p.length / sr, name).toBeLessThanOrEqual(limits[name]);
        const pk = peakOf(p);
        expect(pk, name).toBeGreaterThan(0.4);
        expect(pk, name).toBeLessThanOrEqual(0.9);
        const ch = p.channels[0];
        // onset inside the first millisecond (cheer swells in, so it gets 30 ms)
        const firstMs = name === 'cheer' ? 0.03 : 0.001;
        let early = 0;
        for (let i = 0; i < Math.round(firstMs * sr); i++) early = Math.max(early, Math.abs(ch[i]));
        expect(early, name).toBeGreaterThan(name === 'cheer' || name === 'whoosh' ? 0 : 100);
        expect(Math.abs(ch[p.length - 1]), name).toBeLessThan(40);
      }
    });
  }
});

describe('createBuiltinMusic', () => {
  it('exposes the catalog and renders on the main thread with progress', async () => {
    const music = createBuiltinMusic({ worker: false });
    expect(music.catalog).toHaveLength(6);
    const seen: number[] = [];
    const pcm = await music.renderTrack(music.catalog[5].id, SR, (p) => seen.push(p));
    expect(pcm.length).toBe(trackFrames(128, SR));
    expect(seen[0]).toBe(0);
    expect(seen[seen.length - 1]).toBe(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    await expect(music.renderTrack('nope', SR)).rejects.toThrow();
    const sounds = await music.renderSounds(SR);
    expect(Object.keys(sounds).sort()).toEqual([...SOUND_NAMES].sort());
  });
});
