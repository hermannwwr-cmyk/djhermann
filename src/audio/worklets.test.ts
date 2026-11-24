import { describe, expect, it } from 'vitest';
import { QUANTUM, createDeckSim, createEchoSim, createLimiterSim } from './worklet-sim';
import type { WorkletSim } from './worklet-sim';

const SR = 48000;

function sine(hz: number, amp: number, sec: number, sr = SR): Int16Array {
  const n = Math.round(sec * sr);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / sr) * amp * 32767);
  return out;
}

function noise(sec: number, seed = 1): Int16Array {
  const n = Math.round(sec * SR);
  const out = new Int16Array(n);
  let a = seed;
  for (let i = 0; i < n; i++) {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
    out[i] = ((a >>> 16) & 0xffff) - 32768;
  }
  // band-limit a little so the interpolator's job is realistic (still full of high frequencies)
  for (let i = 1; i < n; i++) out[i] = Math.round(out[i] * 0.5 + out[i - 1] * 0.5);
  return out;
}

function deckWith(ch: Int16Array[], pos = 0): WorkletSim {
  const sim = createDeckSim(SR);
  sim.send({ t: 'load', gen: 1, q: 1, ch, len: ch[0].length, sr: SR, pos, tempo: 1, nudge: 0 });
  sim.render(QUANTUM);
  return sim;
}

type Report = { frame: number; pos: number; rate: number; flag: number };
function reports(sim: WorkletSim): Report[] {
  return sim.messages
    .map((m) => m.data as number[])
    .filter((d) => Array.isArray(d) && d[0] === 0)
    .map((d) => ({ frame: d[3], pos: d[4], rate: d[5], flag: d[6] }));
}

/** Largest sample-to-sample step. */
function maxStep(x: Float32Array, from = 1, to = x.length): number {
  let m = 0;
  for (let i = Math.max(1, from); i < to; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
  return m;
}

/** Frequency from interpolated rising zero crossings. */
function freqOf(x: Float32Array, from: number, to: number, sr = SR): number {
  let first = -1;
  let last = -1;
  let count = 0;
  for (let i = from + 1; i < to; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) {
      const t = i - 1 + -x[i - 1] / (x[i] - x[i - 1]);
      if (first < 0) first = t;
      last = t;
      count++;
    }
  }
  return count > 1 ? ((count - 1) * sr) / (last - first) : 0;
}

describe('deck worklet', () => {
  it('reproduces the source exactly at rate 1', () => {
    const src = noise(2);
    const sim = deckWith([src, src], 0.1);
    sim.send({ t: 'play', q: 2 });
    const start = sim.frame;
    const [L] = sim.render(SR);
    // after spin-up and the slide onto whole frames, every sample is a copy of the source
    const r = reports(sim).filter((x) => x.frame >= start + 0.4 * SR);
    expect(r.length).toBeGreaterThan(20);
    let worst = 0;
    for (const rep of r) {
      expect(rep.rate).toBe(1);
      const srcPos = Math.round(rep.pos * SR);
      expect(Math.abs(rep.pos * SR - srcPos)).toBeLessThan(1e-6);
      for (let k = 1; k <= 128; k++) {
        const outIdx = rep.frame - k - start;
        if (outIdx < 0 || outIdx >= L.length) continue;
        worst = Math.max(worst, Math.abs(L[outIdx] - src[srcPos - k] / 32768));
      }
    }
    expect(worst).toBeLessThan(1e-7);
  });

  it('interpolates accurately off the whole frames (error near the 16-bit floor)', () => {
    // a 1 kHz tone at rate 1.06: compare against the ideal tone at 1060 Hz
    const src = sine(1000, 0.8, 2);
    const sim = deckWith([src, src], 0);
    sim.send({ t: 'tempo', q: 2, v: 1.06, now: true });
    sim.send({ t: 'play', q: 3 });
    const start = sim.frame;
    const [L] = sim.render(SR);
    const r = reports(sim).filter((x) => x.frame >= start + 0.3 * SR);
    let worst = 0;
    for (const rep of r) {
      expect(rep.rate).toBeCloseTo(1.06, 9);
      for (let k = 1; k <= 300; k++) {
        const idx = rep.frame - k - start;
        const p = rep.pos * SR - k * 1.06;
        const ideal = Math.sin((2 * Math.PI * 1000 * p) / SR) * 0.8;
        worst = Math.max(worst, Math.abs(L[idx] - ideal));
      }
    }
    // 16-bit quantisation of the source is 1.5e-5; the kernel adds well under that again
    expect(worst).toBeLessThan(1e-4);
    expect(freqOf(L, 0.4 * SR, 0.9 * SR)).toBeCloseTo(1060, 0);
  });

  it('spins up in about 50 ms and brakes in about 150 ms', () => {
    const src = sine(100, 0.5, 3);
    const sim = deckWith([src, src], 0.5);
    sim.send({ t: 'play', q: 2 });
    const t0 = sim.frame;
    sim.render(SR * 0.5);
    const up = reports(sim).find((x) => x.frame > t0 && x.rate >= 1);
    expect(up).toBeDefined();
    expect((up!.frame - t0) / SR).toBeGreaterThan(0.04);
    expect((up!.frame - t0) / SR).toBeLessThan(0.06);
    sim.send({ t: 'pause', q: 3 });
    const t1 = sim.frame;
    sim.render(SR * 0.5);
    const down = reports(sim).find((x) => x.frame > t1 && x.rate === 0);
    expect((down!.frame - t1) / SR).toBeGreaterThan(0.14);
    expect((down!.frame - t1) / SR).toBeLessThan(0.17);
    // the rate falls steadily (pitch drop), it does not cut
    const mid = reports(sim).find((x) => x.frame > t1 + 0.07 * SR)!;
    expect(mid.rate).toBeGreaterThan(0.4);
    expect(mid.rate).toBeLessThan(0.6);
  });

  it('starts, stops, seeks, cues and ends without clicks', () => {
    const amp = 0.8;
    const natural = (amp * 2 * Math.PI * 100) / SR; // largest step of the tone itself
    const src = sine(100, amp, 2.2);
    const sim = deckWith([src, src], 0.3);
    const out: Float32Array[] = [];
    const go = (sec: number): void => {
      out.push(sim.render(Math.round(sec * SR))[0]);
    };
    go(0.05);
    sim.send({ t: 'play', q: 2 });
    go(0.3);
    sim.send({ t: 'seek', q: 3, pos: 1.2052 }); // lands on the opposite phase
    go(0.2);
    sim.send({ t: 'tempo', q: 4, v: 0.92 });
    go(0.2);
    sim.send({ t: 'stopAt', q: 5, pos: 0.3 }); // CUE while playing
    go(0.1);
    sim.send({ t: 'play', q: 6 });
    go(0.2);
    sim.send({ t: 'pause', q: 7 });
    go(0.3);
    sim.send({ t: 'seek', q: 8, pos: 1.9 });
    sim.send({ t: 'play', q: 9 });
    go(0.6); // runs off the end
    const all = new Float32Array(out.reduce((a, b) => a + b.length, 0));
    let o = 0;
    for (const b of out) {
      all.set(b, o);
      o += b.length;
    }
    expect(maxStep(all)).toBeLessThan(natural * 1.6);
    expect(sim.messages.some((m) => Array.isArray(m.data) && (m.data as number[])[0] === 1)).toBe(true);
    // silence after the end
    expect(maxStep(all, all.length - 1000)).toBe(0);
    expect(Math.abs(all[all.length - 1])).toBe(0);
  });

  it('plays backwards when the record is pulled back', () => {
    // a rising chirp played backwards falls
    const n = 2 * SR;
    const src = new Int16Array(n);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const f = 200 + (800 * i) / n;
      ph += (2 * Math.PI * f) / SR;
      src[i] = Math.round(Math.sin(ph) * 0.7 * 32767);
    }
    const sim = deckWith([src, src], 1.5);
    sim.send({ t: 'scratchStart', q: 2 });
    sim.render(QUANTUM);
    // hand moves backwards at exactly native speed, a move every 512 frames
    const parts: Float32Array[] = [];
    for (let k = 0; k < 80; k++) {
      sim.send({ t: 'scratchMove', q: 3 + k, d: -512 / SR, dt: 512 / SR });
      parts.push(sim.render(512)[0]);
    }
    const L = new Float32Array(parts.length * 512);
    parts.forEach((p, i) => L.set(p, i * 512));
    const r = reports(sim).filter((x) => x.frame > sim.frame - 0.5 * SR && x.frame < sim.frame - 0.1 * SR);
    expect(r.length).toBeGreaterThan(30);
    for (const x of r) expect(x.rate).toBeCloseTo(-1, 1);
    const early = freqOf(L, 0.15 * SR, 0.3 * SR);
    const late = freqOf(L, 0.6 * SR, 0.75 * SR);
    // position 1.5 s → about 0.7 s: source frequency there is 800 → 480 Hz, falling
    expect(early).toBeGreaterThan(late + 100);
  });

  it('follows an irregular scratch gesture smoothly and is silent when the hand stops', () => {
    const amp = 0.8;
    const src = sine(100, amp, 4);
    const sim = deckWith([src, src], 2);
    let rnd = 7;
    const rand = (): number => {
      rnd = (Math.imul(rnd, 1103515245) + 12345) >>> 0;
      return rnd / 4294967296;
    };
    sim.send({ t: 'scratchStart', q: 2 });
    let hand = 0; // hand position, track seconds relative to the grab
    let t = 0;
    let q = 3;
    const parts: Float32Array[] = [];
    // two back-and-forth strokes (±0.25 s of record, 4 Hz), pointer events every 8..16 ms
    while (t < 0.5) {
      const frames = QUANTUM * (3 + Math.floor(rand() * 4)); // 8..16 ms
      t += frames / SR;
      const next = 0.25 * Math.sin(2 * Math.PI * 4 * Math.min(t, 0.5));
      sim.send({ t: 'scratchMove', q: q++, d: next - hand, dt: frames / SR });
      hand = next;
      parts.push(sim.render(frames)[0]);
    }
    parts.push(sim.render(0.4 * SR)[0]); // hand held still
    const L = new Float32Array(parts.reduce((a, b) => a + b.length, 0));
    let o = 0;
    for (const p of parts) {
      L.set(p, o);
      o += p.length;
    }
    // peak hand speed is 0.25 * 2π * 4 ≈ 6.3× native: the tone's own step at that speed
    const peakRate = 0.25 * 2 * Math.PI * 4;
    const natural = (amp * 2 * Math.PI * 100 * peakRate) / SR;
    expect(maxStep(L)).toBeLessThan(natural * 1.25);
    // no zipper: the playhead's speed (second difference of the phase) changes smoothly. The
    // output's second difference is bounded by the tone's own at the peak speed plus a little.
    let worst2 = 0;
    for (let i = 2; i < L.length; i++) worst2 = Math.max(worst2, Math.abs(L[i] - 2 * L[i - 1] + L[i - 2]));
    const natural2 = amp * Math.pow((2 * Math.PI * 100 * peakRate) / SR, 2);
    expect(worst2).toBeLessThan(natural2 * 2 + 0.002);
    // the record ends where the hand left it, and is silent
    const last = reports(sim).at(-1)!;
    expect(last.pos).toBeCloseTo(2 + hand, 3);
    expect(last.rate).toBe(0);
    expect(maxStep(L, L.length - 4800)).toBe(0);
  });

  it('stays put when a paused record is released, spins back up when playing', () => {
    const src = sine(100, 0.5, 4);
    const sim = deckWith([src, src], 1);
    sim.send({ t: 'scratchStart', q: 2 });
    for (let k = 0; k < 10; k++) {
      sim.send({ t: 'scratchMove', q: 3 + k, d: 0.05, dt: 0.01 }); // flung forwards at 5×
      sim.render(480);
    }
    sim.send({ t: 'scratchEnd', q: 20 });
    sim.render(0.6 * SR);
    const r = reports(sim);
    const end = r.at(-1)!;
    expect(end.rate).toBe(0);
    // it went where the hand took it, it did not coast on for a second
    expect(end.pos).toBeGreaterThan(1.49);
    expect(end.pos).toBeLessThan(1.52);

    sim.send({ t: 'play', q: 21 });
    sim.render(0.2 * SR);
    sim.send({ t: 'scratchStart', q: 22 });
    sim.render(0.1 * SR);
    sim.send({ t: 'scratchEnd', q: 23 });
    sim.render(0.2 * SR);
    expect(reports(sim).at(-1)!.rate).toBe(1);
  });

  it('reports at least every 512 frames', () => {
    const src = sine(100, 0.5, 2);
    const sim = deckWith([src, src], 0);
    sim.send({ t: 'play', q: 2 });
    sim.render(SR);
    const r = reports(sim);
    for (let i = 1; i < r.length; i++) expect(r[i].frame - r[i - 1].frame).toBeLessThanOrEqual(512);
  });

  it('press-time alignment starts the playhead as if it had been running since the anchor', () => {
    const src = sine(100, 0.5, 4);
    const sim = deckWith([src, src], 1);
    sim.render(QUANTUM * 4);
    const anchor = sim.frame - 0.04 * SR; // the frame that was at the speaker at the press
    sim.send({ t: 'tempo', q: 2, v: 1.04, now: true });
    sim.send({ t: 'play', q: 3, anchor });
    sim.render(0.4 * SR);
    const r = reports(sim).at(-1)!;
    const expected = 1 + ((r.frame - anchor) / SR) * 1.04;
    expect(Math.abs(r.pos - expected) * SR).toBeLessThan(0.5);
  });

  it('syncTo lands the playhead on the requested line', () => {
    const src = sine(100, 0.5, 4);
    const sim = deckWith([src, src], 1);
    sim.send({ t: 'play', q: 2 });
    sim.render(0.3 * SR);
    const f = sim.frame;
    sim.send({ t: 'syncTo', q: 3, frame: f, pos: 2, tempo: 1.02 });
    sim.render(0.3 * SR);
    const r = reports(sim).at(-1)!;
    expect(Math.abs(r.pos - (2 + ((r.frame - f) / SR) * 1.02)) * SR).toBeLessThan(0.5);
  });

  it('frees the track on eject', () => {
    const src = sine(100, 0.5, 1);
    const sim = deckWith([src, src], 0);
    sim.send({ t: 'play', q: 2 });
    sim.render(0.2 * SR);
    sim.send({ t: 'eject', gen: 2, q: 3 });
    const [L] = sim.render(0.1 * SR);
    expect(maxStep(L)).toBeLessThan((0.5 * 2 * Math.PI * 100) / SR + 1e-3);
    expect(L[L.length - 1]).toBe(0);
    const r = reports(sim).at(-1)!;
    expect(r.pos).toBe(0);
  });
});

describe('master limiter', () => {
  it('never exceeds the ceiling and passes quiet audio untouched', () => {
    const lookahead = 72;
    const ceiling = 0.944;
    const sim = createLimiterSim(SR, { lookahead, ceiling, release: 0.12 });
    const n = SR;
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      // two full-scale tracks plus a pad hit: up to 3.0
      const pad = i > 20000 && i < 24000 ? Math.sin(i * 0.3) : 0;
      L[i] = Math.sin(i * 0.013) + Math.sin(i * 0.021 + 1) + pad;
      R[i] = Math.sin(i * 0.017) + (i % 4000 < 3 ? 1 : 0) + pad;
    }
    const [oL, oR] = sim.render(n, [L, R]);
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(oL[i]), Math.abs(oR[i]));
    expect(peak).toBeLessThanOrEqual(ceiling + 1e-6);
    expect(peak).toBeGreaterThan(0.9);

    const quiet = createLimiterSim(SR, { lookahead, ceiling, release: 0.12 });
    const q = new Float32Array(n);
    for (let i = 0; i < n; i++) q[i] = 0.5 * Math.sin(i * 0.05);
    const [qL] = quiet.render(n, [q, q]);
    for (let i = lookahead; i < n; i++) expect(qL[i]).toBe(q[i - lookahead]);
  });
});

describe('echo worklet', () => {
  it('repeats exactly every delay, decays by the feedback and rings on after the send closes', () => {
    const sim = createEchoSim(SR);
    sim.params.delay = 0.375;
    sim.params.send = 1;
    const n = 3 * SR;
    const L = new Float32Array(n);
    L[0] = 1;
    // send open for the impulse only, then closed (the button released / fader cut)
    const first = sim.render(QUANTUM, [L.subarray(0, QUANTUM), L.subarray(0, QUANTUM)]);
    sim.params.send = 0;
    const rest = sim.render(n - QUANTUM);
    const out = new Float32Array(n);
    out.set(first[0]);
    out.set(rest[0], QUANTUM);
    const D = 0.375 * SR;
    const energy: number[] = [];
    for (let k = 1; k <= 6; k++) {
      // the repeat starts exactly k * D frames later (the one-pole filter smears it forwards only)
      expect(Math.abs(out[k * D - 1])).toBeLessThan(1e-9);
      expect(Math.abs(out[k * D])).toBeGreaterThan(1e-4);
      let e = 0;
      for (let i = k * D; i < k * D + 400; i++) e += out[i] * out[i];
      energy.push(e);
    }
    // each repeat is quieter than the last, by about the feedback (darkening takes a little more)
    for (let k = 1; k < energy.length; k++) {
      const ratio = Math.sqrt(energy[k] / energy[k - 1]);
      expect(ratio).toBeLessThan(0.56);
      expect(ratio).toBeGreaterThan(0.3);
    }
    // and dies away to exact silence, after which it costs nothing
    const tail = sim.render(20 * SR)[0];
    expect(tail[tail.length - 1]).toBe(0);
  });
});
