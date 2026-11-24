/**
 * Measurements of the real audio engine, run in a browser (the dev harness exposes them on
 * window.__audio.measure). Nobody can listen to a headless browser, so everything is a number:
 *
 * - worklet: the deck processor rendered deterministically through OfflineAudioContexts;
 * - mixer: impulse responses of the mixer graph through OfflineAudioContexts;
 * - clock / alignment / soak: the live engine on the realtime AudioContext.
 */
import { buildMixer, loadWorklets } from '../audio';
import type { Mixer, RealAudioEngine } from '../audio';
import { echoDelaySec, LIMITER_CEILING } from '../audio/params';
import { channelGain } from '../core/mixmath';
import type { DeckId, LoadedTrack, PcmData } from '../core/types';
import { clickTrack, toPcm, tone } from './audio-signals';

const BASE = import.meta.env.BASE_URL;
const SR = 48000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const round = (v: number, d = 3): number => Math.round(v * 10 ** d) / 10 ** d;
const dB = (g: number): number => 20 * Math.log10(Math.max(g, 1e-12));

// ───────────────────────────── helpers ─────────────────────────────

interface Report {
  frame: number;
  pos: number;
  rate: number;
  flag: number;
}

interface Cmd {
  /** context frame to apply it at */
  at: number;
  msg: Record<string, unknown>;
}

/** Render the deck worklet offline: load `src` at `posSec`, apply timed commands. */
async function offlineDeck(src: PcmData, posSec: number, sec: number, cmds: Cmd[]): Promise<{ L: Float32Array; reps: Report[]; ended: boolean }> {
  const frames = Math.round(sec * SR);
  const ctx = new OfflineAudioContext(2, frames, SR);
  await ctx.audioWorklet.addModule(`${BASE}worklets/deck-processor.js`);
  const node = new AudioWorkletNode(ctx, 'deck-processor', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
  node.connect(ctx.destination);
  const reps: Report[] = [];
  let ended = false;
  node.port.onmessage = (e: MessageEvent) => {
    const d = e.data as number[];
    if (d[0] === 0) reps.push({ frame: d[3], pos: d[4], rate: d[5], flag: d[6] });
    else if (d[0] === 1) ended = true;
  };
  const ch = src.channels.map((c) => c.slice());
  node.port.postMessage({ t: 'load', gen: 1, q: 1, ch, len: src.length, sr: src.sampleRate, pos: posSec, tempo: 1, nudge: 0 }, ch.map((c) => c.buffer));
  let q = 2;
  for (const c of cmds) node.port.postMessage({ ...c.msg, at: c.at, q: q++ });
  await sleep(60); // let the messages arrive before the render starts
  const buf = await ctx.startRendering();
  await sleep(150); // and the reports come back
  return { L: buf.getChannelData(0), reps, ended };
}

function maxStep(x: Float32Array, from = 1, to = x.length): number {
  let m = 0;
  for (let i = Math.max(1, from); i < to; i++) {
    const d = Math.abs(x[i] - x[i - 1]);
    if (d > m) m = d;
  }
  return m;
}

function maxAbs(x: Float32Array, from = 0, to = x.length): number {
  let m = 0;
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(x[i]));
  return m;
}

function freqOf(x: Float32Array, from: number, to: number): number {
  let first = -1;
  let last = -1;
  let count = 0;
  for (let i = Math.max(1, Math.round(from)); i < Math.min(x.length, Math.round(to)); i++) {
    if (x[i - 1] < 0 && x[i] >= 0) {
      const t = i - 1 + -x[i - 1] / (x[i] - x[i - 1]);
      if (first < 0) first = t;
      last = t;
      count++;
    }
  }
  return count > 1 ? ((count - 1) * SR) / (last - first) : 0;
}

/** In-place radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const ai = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k + len / 2] = re[i + k] - ar;
        im[i + k + len / 2] = im[i + k] - ai;
        re[i + k] += ar;
        im[i + k] += ai;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

/** Magnitude response of an impulse response, as a function of frequency (linear interpolation). */
function response(ir: Float32Array): (hz: number) => number {
  const n = 1 << Math.ceil(Math.log2(ir.length));
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(ir);
  fft(re, im);
  const mag = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
  return (hz: number) => {
    const b = (hz / SR) * n;
    const i = Math.floor(b);
    const f = b - i;
    return mag[i] * (1 - f) + mag[Math.min(i + 1, mag.length - 1)] * f;
  };
}

const logFreqs = (lo: number, hi: number, n: number): number[] => Array.from({ length: n }, (_, i) => lo * Math.pow(hi / lo, i / (n - 1)));

/** Impulse response of the mixer from one deck input to the output. */
async function mixerIR(setup: (m: Mixer, ctx: OfflineAudioContext) => void, opts: { deck?: DeckId; sec?: number; limiter?: boolean } = {}): Promise<Float32Array> {
  const frames = Math.round((opts.sec ?? 1.3653) * SR);
  const ctx = new OfflineAudioContext(2, frames, SR);
  await loadWorklets(ctx);
  const m = buildMixer(ctx, { limiter: opts.limiter === true, instant: true });
  m.out.connect(ctx.destination);
  setup(m, ctx);
  const buf = ctx.createBuffer(1, 1, SR);
  buf.getChannelData(0)[0] = 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(m.input[opts.deck ?? 'A']);
  src.start(0);
  const out = await ctx.startRendering();
  return out.getChannelData(0);
}

// ───────────────────────────── 1. worklet ─────────────────────────────

export async function measureWorklet(): Promise<Record<string, unknown>> {
  const res: Record<string, unknown> = {};

  // rate 1: bit-exact copy of a noise source
  {
    const n = 2 * SR;
    const L = new Float32Array(n);
    let s = 9;
    for (let i = 0; i < n; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      L[i] = (s / 4294967296 - 0.5) * 1.6;
    }
    const src = toPcm(L, L, SR);
    const r = await offlineDeck(src, 0.1, 1.2, [{ at: 0, msg: { t: 'play' } }]);
    let worst = 0;
    let checked = 0;
    for (const rep of r.reps.filter((x) => x.frame >= 0.4 * SR && x.frame <= 1.19 * SR)) {
      const p = rep.pos * SR;
      for (let k = 1; k <= 384; k++) {
        const v = src.channels[0][Math.round(p) - k] / 32768;
        worst = Math.max(worst, Math.abs(r.L[rep.frame - k] - v));
        checked++;
      }
    }
    res.rate1 = { samplesChecked: checked, maxErrorLsb: round(worst * 32768, 4) };
  }

  // rate 1.06: a 1 kHz tone must come out at 1060 Hz; error against the ideal tone
  {
    const src = tone(SR, 1000, 0.8, 2);
    const r = await offlineDeck(src, 0, 1, [
      { at: 0, msg: { t: 'tempo', v: 1.06, now: true } },
      { at: 0, msg: { t: 'play' } },
    ]);
    let worst = 0;
    for (const rep of r.reps.filter((x) => x.frame >= 0.3 * SR && x.frame < 0.99 * SR)) {
      for (let k = 1; k <= 384; k++) {
        const p = rep.pos * SR - k * 1.06;
        worst = Math.max(worst, Math.abs(r.L[rep.frame - k] - 0.8 * Math.sin((2 * Math.PI * 1000 * p) / SR)));
      }
    }
    res.rate106 = { freqHz: round(freqOf(r.L, 0.3 * SR, 0.95 * SR), 2), maxErrorDbfs: round(dB(worst), 1), maxErrorLsb: round(worst * 32768, 2) };
  }

  // reverse: pull a rising chirp backwards at native speed: the pitch falls
  {
    const n = 2 * SR;
    const L = new Float32Array(n);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      ph += (2 * Math.PI * (200 + (800 * i) / n)) / SR;
      L[i] = 0.7 * Math.sin(ph);
    }
    const cmds: Cmd[] = [{ at: 0, msg: { t: 'scratchStart' } }];
    for (let k = 0; k < 90; k++) cmds.push({ at: 128 + k * 512, msg: { t: 'scratchMove', d: -512 / SR, dt: 512 / SR } });
    const r = await offlineDeck(toPcm(L, L, SR), 1.5, 1, cmds);
    const steady = r.reps.filter((x) => x.frame > 0.15 * SR && x.frame < 0.9 * SR);
    const rates = steady.map((x) => x.rate);
    res.reverse = {
      rateMin: round(Math.min(...rates)),
      rateMax: round(Math.max(...rates)),
      pitchEarlyHz: round(freqOf(r.L, 0.15 * SR, 0.3 * SR), 1),
      pitchLateHz: round(freqOf(r.L, 0.75 * SR, 0.9 * SR), 1),
      expectedEarlyHz: round(200 + (800 * (1.5 - 0.225)) / 2, 1),
      expectedLateHz: round(200 + (800 * (1.5 - 0.825)) / 2, 1),
    };
  }

  // clicks: start, seek to the opposite phase, tempo change, CUE while playing, play, pause,
  // seek + play, run off the end. A 100 Hz tone at 0.8: any click would be a step far above its own.
  {
    const amp = 0.8;
    const natural = (amp * 2 * Math.PI * 100) / SR;
    const f = (s: number): number => Math.round(s * SR);
    const r = await offlineDeck(tone(SR, 100, amp, 2.2), 0.3, 2.1, [
      { at: f(0.05), msg: { t: 'play' } },
      { at: f(0.35), msg: { t: 'seek', pos: 1.2052 } },
      { at: f(0.55), msg: { t: 'tempo', v: 0.92 } },
      { at: f(0.75), msg: { t: 'stopAt', pos: 0.3 } },
      { at: f(0.85), msg: { t: 'play' } },
      { at: f(1.05), msg: { t: 'pause' } },
      { at: f(1.35), msg: { t: 'seek', pos: 1.95 } },
      { at: f(1.35), msg: { t: 'play' } },
    ]);
    res.clicks = {
      naturalStep: round(natural, 5),
      worstStep: round(maxStep(r.L), 5),
      worstOverNatural: round(maxStep(r.L) / natural, 3),
      endedEvent: r.ended,
      tailPeakAfterEnd: maxAbs(r.L, r.L.length - f(0.2)),
    };
  }

  // scratch: an irregular back-and-forth gesture (pointer moves every 7..17 ms, not on block
  // boundaries), then the hand holds still
  {
    const amp = 0.8;
    let s = 5;
    const rand = (): number => {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      return s / 4294967296;
    };
    const cmds: Cmd[] = [{ at: 0, msg: { t: 'scratchStart' } }];
    let t = 0;
    let hand = 0;
    while (t < 0.6) {
      const dt = (7 + rand() * 10) / 1000;
      t += dt;
      const next = 0.25 * Math.sin(2 * Math.PI * 4 * Math.min(t, 0.5));
      cmds.push({ at: Math.round(t * SR), msg: { t: 'scratchMove', d: next - hand, dt } });
      hand = next;
    }
    const r = await offlineDeck(tone(SR, 100, amp, 4), 2, 1.2, cmds);
    const peakRate = 0.25 * 2 * Math.PI * 4;
    const natural = (amp * 2 * Math.PI * 100 * peakRate) / SR;
    let worst2 = 0;
    const gestureEnd = Math.round(0.65 * SR);
    for (let i = 2; i < gestureEnd; i++) worst2 = Math.max(worst2, Math.abs(r.L[i] - 2 * r.L[i - 1] + r.L[i - 2]));
    const natural2 = amp * Math.pow((2 * Math.PI * 100 * peakRate) / SR, 2);
    const last = r.reps[r.reps.length - 1];
    const rates = r.reps.map((x) => x.rate);
    res.scratch = {
      moves: cmds.length - 1,
      peakRateSeen: round(Math.max(...rates.map(Math.abs)), 2),
      worstStepOverNatural: round(maxStep(r.L, 1, gestureEnd) / natural, 3),
      worstSecondDiffOverNatural: round(worst2 / natural2, 3),
      endPosErrorMs: round((last.pos - (2 + hand)) * 1000, 4),
      silentWhenStill: maxAbs(r.L, r.L.length - Math.round(0.3 * SR)) === 0,
    };
  }

  // a paused record let go after a fling stays put; a playing one spins back up
  {
    const cmds: Cmd[] = [{ at: 0, msg: { t: 'scratchStart' } }];
    for (let k = 1; k <= 10; k++) cmds.push({ at: k * 480, msg: { t: 'scratchMove', d: 0.05, dt: 0.01 } });
    cmds.push({ at: 11 * 480, msg: { t: 'scratchEnd' } });
    const r = await offlineDeck(tone(SR, 100, 0.5, 4), 1, 0.8, cmds);
    const settle = r.reps.find((x) => x.frame > 11 * 480 && x.rate === 0);
    const r2 = await offlineDeck(tone(SR, 100, 0.5, 4), 1, 0.8, [
      { at: 0, msg: { t: 'play' } },
      { at: Math.round(0.2 * SR), msg: { t: 'scratchStart' } },
      { at: Math.round(0.3 * SR), msg: { t: 'scratchEnd' } },
    ]);
    const back = r2.reps.find((x) => x.frame > 0.3 * SR && x.rate === 1);
    res.release = {
      pausedEndPos: round(r.reps[r.reps.length - 1].pos, 4),
      pausedHandEndPos: 1.5,
      pausedSettleMs: settle ? round(((settle.frame - 11 * 480) / SR) * 1000, 1) : null,
      playingBackToSpeedMs: back ? round(((back.frame - 0.3 * SR) / SR) * 1000, 1) : null,
    };
  }

  // reports: interval between position reports
  {
    const r = await offlineDeck(tone(SR, 100, 0.5, 2), 0, 1, [{ at: 0, msg: { t: 'play' } }]);
    let worst = 0;
    for (let i = 1; i < r.reps.length; i++) worst = Math.max(worst, r.reps[i].frame - r.reps[i - 1].frame);
    res.reportIntervalMaxFrames = worst;
  }
  return res;
}

// ───────────────────────────── 2. mixer ─────────────────────────────

export async function measureMixer(): Promise<Record<string, unknown>> {
  const res: Record<string, unknown> = {};
  const band = logFreqs(30, 16000, 240);

  const flatIr = await mixerIR(() => undefined);
  const flat = response(flatIr);
  let worst = 0;
  for (const f of band) worst = Math.max(worst, Math.abs(dB(flat(f))));
  res.eqFlatMaxErrorDb = round(worst, 4);

  const lowKill = response(await mixerIR((m) => m.setEq('A', 'low', 0)));
  const midKill = response(await mixerIR((m) => m.setEq('A', 'mid', 0)));
  const highKill = response(await mixerIR((m) => m.setEq('A', 'high', 0)));
  const lowBoost = response(await mixerIR((m) => m.setEq('A', 'low', 1)));
  const highBoost = response(await mixerIR((m) => m.setEq('A', 'high', 1)));
  res.eq = {
    lowKillAt60HzDb: round(dB(lowKill(60)), 1),
    lowKillAt100HzDb: round(dB(lowKill(100)), 1),
    lowKillAt1kHzDb: round(dB(lowKill(1000)), 2),
    midKillAt1kHzDb: round(dB(midKill(1000)), 1),
    highKillAt8kHzDb: round(dB(highKill(8000)), 1),
    lowBoostAt60HzDb: round(dB(lowBoost(60)), 2),
    highBoostAt10kHzDb: round(dB(highBoost(10000)), 2),
  };

  // filter: centre and dead zone must be bit-transparent (same samples as with no filter path)
  {
    const ir0 = await mixerIR((m) => m.setFilter('A', 0));
    const irDz = await mixerIR((m) => m.setFilter('A', 0.02));
    let d0 = 0;
    let dz = 0;
    for (let i = 0; i < flatIr.length; i++) {
      d0 = Math.max(d0, Math.abs(ir0[i] - flatIr[i]));
      dz = Math.max(dz, Math.abs(irDz[i] - flatIr[i]));
    }
    const lp = response(await mixerIR((m) => m.setFilter('A', -1)));
    const hp = response(await mixerIR((m) => m.setFilter('A', 1)));
    const lpHalf = response(await mixerIR((m) => m.setFilter('A', -0.5)));
    const peak = (h: (hz: number) => number, lo: number, hi: number): number => {
      let best = lo;
      for (const f of logFreqs(lo, hi, 400)) if (h(f) > h(best)) best = f;
      return best;
    };
    /** first frequency (scanning in `dir`) where the response is 3 dB below the pass level */
    const corner = (h: (hz: number) => number, pass: number, from: number, to: number): number => {
      for (const f of logFreqs(from, to, 600)) if (dB(h(f)) < dB(pass) - 3) return f;
      return NaN;
    };
    res.filter = {
      centreMaxDiff: d0,
      deadZoneMaxDiff: dz,
      lpAtMinus1: { resonancePeakHz: round(peak(lp, 40, 1000), 0), peakDb: round(dB(lp(peak(lp, 40, 1000))), 1), corner3dbHz: round(corner(lp, lp(30), 60, 5000), 0), at1kHzDb: round(dB(lp(1000)), 1) },
      lpAtMinusHalf: { corner3dbHz: round(corner(lpHalf, lpHalf(30), 60, 18000), 0) },
      hpAtPlus1: { resonancePeakHz: round(peak(hp, 1000, 15000), 0), peakDb: round(dB(hp(peak(hp, 1000, 15000))), 1), corner3dbHz: round(corner(hp, hp(16000), 15000, 500), 0), at500HzDb: round(dB(hp(500)), 1) },
    };
  }

  // fader and crossfader gains against core/mixmath
  {
    let worstFader = 0;
    const rows: string[] = [];
    for (const deck of ['A', 'B'] as DeckId[]) {
      for (const fader of [1, 0.75, 0.5, 0.25]) {
        for (const xf of [-1, -0.5, 0, 0.5, 0.9]) {
          const want = channelGain(deck, fader, xf);
          if (want < 1e-4) continue;
          const ir = await mixerIR(
            (m) => {
              m.setFader(deck, fader);
              m.setCrossfader(xf);
            },
            { deck, sec: 0.1 },
          );
          const got = response(ir)(1000);
          const err = Math.abs(dB(got) - dB(want));
          worstFader = Math.max(worstFader, err);
          if (err > 0.05) rows.push(`${deck} f=${fader} x=${xf}: ${got} vs ${want}`);
        }
      }
    }
    res.faderCrossfaderMaxErrorDb = round(worstFader, 4);
    if (rows.length) res.faderMismatches = rows;
  }

  // echo: repeat spacing at 120 BPM, decay, and the tail ringing on after the send and fader close
  {
    const delay = echoDelaySec(120);
    const frames = Math.round(3 * SR);
    const ctx = new OfflineAudioContext(1, frames, SR);
    await loadWorklets(ctx);
    const m = buildMixer(ctx, { instant: true });
    m.out.connect(ctx.destination);
    m.setEchoTime('A', delay);
    m.setEcho('A', true);
    void ctx.suspend(0.1).then(() => {
      m.setEcho('A', false);
      m.setFader('A', 0);
      void ctx.resume();
    });
    const buf = ctx.createBuffer(1, 1, SR);
    buf.getChannelData(0)[0] = 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(m.input.A);
    src.start(0);
    const out = (await ctx.startRendering()).getChannelData(0);
    const peaks: { t: number; db: number }[] = [];
    for (let k = 1; k <= 6; k++) {
      const c = Math.round(k * delay * SR);
      let bi = c;
      for (let i = c - 960; i < c + 960 && i < out.length; i++) if (Math.abs(out[i]) > Math.abs(out[bi])) bi = i;
      if (bi < out.length) peaks.push({ t: bi / SR, db: dB(Math.abs(out[bi])) });
    }
    const spacing = peaks.slice(1).map((p, i) => round((p.t - peaks[i].t) * 1000, 2));
    res.echo = {
      expectedSpacingMs: round(delay * 1000, 2),
      firstRepeatMs: round(peaks[0].t * 1000, 2),
      spacingMs: spacing,
      repeatLevelsDb: peaks.map((p) => round(p.db, 1)),
      repeatsAfterSendOffAndFaderDown: peaks.filter((p) => p.t > 0.1 && p.db > -60).length,
    };
  }

  // master: two full-scale decks with every EQ band boosted, plus four full-scale pads at once
  {
    const run = async (limiter: boolean): Promise<number> => {
      const frames = 2 * SR;
      const ctx = new OfflineAudioContext(2, frames, SR);
      await loadWorklets(ctx);
      const m = buildMixer(ctx, { limiter, instant: true });
      m.out.connect(ctx.destination);
      m.setCrossfader(0);
      const mk = (fn: (i: number) => number, len = frames): AudioBufferSourceNode => {
        const b = ctx.createBuffer(2, len, SR);
        for (let c = 0; c < 2; c++) {
          const d = b.getChannelData(c);
          for (let i = 0; i < len; i++) d[i] = fn(i + c * 7);
        }
        const s = ctx.createBufferSource();
        s.buffer = b;
        return s;
      };
      for (const id of ['A', 'B'] as DeckId[]) {
        m.setEq(id, 'low', 1);
        m.setEq(id, 'mid', 1);
        m.setEq(id, 'high', 1);
        const f = id === 'A' ? 50 : 61;
        const s = mk((i) => (Math.sin((2 * Math.PI * f * i) / SR) >= 0 ? 1 : -1));
        s.connect(m.input[id]);
        s.start(0);
      }
      for (let p = 0; p < 4; p++) {
        let x = p + 1;
        const s = mk(() => {
          x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
          return x & 1 ? 1 : -1;
        }, Math.round(0.3 * SR));
        s.connect(m.soundIn);
        s.start(0.5 + p * 0.002);
      }
      const out = await ctx.startRendering();
      return Math.max(maxAbs(out.getChannelData(0)), maxAbs(out.getChannelData(1)));
    };
    const withLimiter = await run(true);
    const without = await run(false);
    res.master = {
      ceilingDbfs: round(dB(LIMITER_CEILING), 2),
      peakWithLimiterDbfs: round(dB(withLimiter), 3),
      peakWithoutLimiterDbfs: round(dB(without), 1),
      neverAboveFullScale: withLimiter <= 1,
    };
  }

  // cost: 10 s of two decks at tempo 1.04 (interpolating path) through the whole mixer and limiter
  {
    const sec = 10;
    const ctx = new OfflineAudioContext(2, sec * SR, SR);
    await loadWorklets(ctx);
    const m = buildMixer(ctx, { limiter: true, instant: true });
    m.out.connect(ctx.destination);
    m.setCrossfader(0);
    m.setFilter('B', -0.4);
    m.setEcho('A', true);
    for (const id of ['A', 'B'] as DeckId[]) {
      const node = new AudioWorkletNode(ctx, 'deck-processor', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      node.connect(m.input[id]);
      const src = tone(SR, 220, 0.4, sec + 2);
      const ch = src.channels.map((c) => c.slice());
      node.port.postMessage({ t: 'load', gen: 1, q: 1, ch, len: src.length, sr: SR, pos: 0, tempo: 1.04, nudge: 0 }, ch.map((c) => c.buffer));
      node.port.postMessage({ t: 'play', q: 2 });
    }
    await sleep(60);
    const t0 = performance.now();
    await ctx.startRendering();
    const ms = performance.now() - t0;
    res.renderCost = { audioSec: sec, wallMs: round(ms, 0), realtimeFactor: round((sec * 1000) / ms, 1) };
  }
  return res;
}

// ───────────────────────────── 3. clock ─────────────────────────────

export async function measureClock(engine: RealAudioEngine, track: LoadedTrack, sec = 10): Promise<Record<string, unknown>> {
  await engine.unlock();
  await engine.loadTrack('A', track);
  engine.setCrossfader(-1);
  engine.play('A');
  await sleep(1500);
  const t: number[] = [];
  const pos: number[] = [];
  const atDiff: number[] = [];
  const lat: number[] = [];
  await new Promise<void>((resolve) => {
    const start = performance.now();
    const frame = (): void => {
      const now = performance.now();
      const d = engine.getDeck('A');
      const p2 = engine.positionAt('A', now);
      t.push(now);
      pos.push(d.positionSec);
      atDiff.push(Math.abs(d.positionSec - p2));
      lat.push(engine.getLatency());
      if (now - start < sec * 1000) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });
  const n = t.length;
  // least-squares line pos = a + b * t
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  const t0 = t[0];
  for (let i = 0; i < n; i++) {
    const x = (t[i] - t0) / 1000;
    sx += x;
    sy += pos[i];
    sxx += x * x;
    sxy += x * pos[i];
  }
  const b = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const a = (sy - b * sx) / n;
  let resid = 0;
  let jitter = 0;
  let backwards = 0;
  for (let i = 0; i < n; i++) {
    resid = Math.max(resid, Math.abs(pos[i] - (a + (b * (t[i] - t0)) / 1000)));
    if (i > 0) {
      const dp = pos[i] - pos[i - 1];
      if (dp <= 0) backwards++;
      // against the ideal at native speed (tempo 1)
      jitter = Math.max(jitter, Math.abs(dp - (t[i] - t[i - 1]) / 1000));
    }
  }
  const frameMs = t.slice(1).map((v, i) => v - t[i]);
  frameMs.sort((x, y) => x - y);
  const stats = engine.debug.stats();
  engine.pause('A');
  return {
    frames: n,
    medianFrameMs: round(frameMs[frameMs.length >> 1], 2),
    rateFromFit: round(b, 7),
    driftPpm: round((b - 1) * 1e6, 1),
    maxDeviationFromLineMs: round(resid * 1000, 3),
    maxFrameToFrameJitterMs: round(jitter * 1000, 3),
    nonIncreasingFrames: backwards,
    positionAtVsGetDeckMaxMs: round(Math.max(...atDiff) * 1000, 4),
    latencyMs: round(lat[lat.length - 1] * 1000, 2),
    latencyRangeMs: round((Math.max(...lat) - Math.min(...lat)) * 1000, 3),
    asHeardBehindRawMs: round((engine.debug.rawPosition('A') - engine.getDeck('A').positionSec) * 1000, 1),
    stats,
  };
}

// ───────────────────────────── 4. press-time alignment ─────────────────────────────

const CAPTURE_SRC = `
class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.on = true; this.port.onmessage = () => { this.on = false; }; }
  process(inputs, outputs) {
    if (!this.on) return true;
    const a = inputs[0] && inputs[0][0];
    const b = inputs[1] && inputs[1][0];
    if (a || b) this.port.postMessage([currentFrame, a ? a.slice() : null, b ? b.slice() : null]);
    return true;
  }
}
registerProcessor('harness-capture', Capture);
`;

interface Capture {
  stop(): Promise<{ start: number; a: Float32Array; b: Float32Array }>;
}

let captureLoaded: Promise<void> | null = null;

/** Record two nodes' outputs sample-accurately side by side. */
async function capture(ctx: AudioContext, a: AudioNode, b: AudioNode): Promise<Capture> {
  if (!captureLoaded) {
    const url = URL.createObjectURL(new Blob([CAPTURE_SRC], { type: 'application/javascript' }));
    captureLoaded = ctx.audioWorklet.addModule(url);
  }
  await captureLoaded;
  const node = new AudioWorkletNode(ctx, 'harness-capture', { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [1] });
  const sink = ctx.createGain();
  sink.gain.value = 0;
  a.connect(node, 0, 0);
  b.connect(node, 0, 1);
  node.connect(sink).connect(ctx.destination);
  const chunks: [number, Float32Array | null, Float32Array | null][] = [];
  node.port.onmessage = (e: MessageEvent) => chunks.push(e.data as [number, Float32Array | null, Float32Array | null]);
  return {
    async stop() {
      node.port.postMessage('stop');
      await sleep(100);
      a.disconnect(node);
      b.disconnect(node);
      node.disconnect();
      sink.disconnect();
      const start = chunks[0][0];
      const len = chunks[chunks.length - 1][0] + 128 - start;
      const A = new Float32Array(len);
      const B = new Float32Array(len);
      for (const [f, x, y] of chunks) {
        if (x) A.set(x, f - start);
        if (y) B.set(y, f - start);
      }
      return { start, a: A, b: B };
    },
  };
}

function onsets(x: Float32Array, sr: number): number[] {
  const out: number[] = [];
  const quiet = Math.round(0.01 * sr);
  let lastLoud = -Infinity;
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i]) > 0.05) {
      if (i - lastLoud > quiet) out.push(i);
      lastLoud = i;
    }
  }
  return out;
}

/** Offsets (ms) of each B click from the nearest A click; positive = B later. */
function clickOffsets(a: Float32Array, b: Float32Array, sr: number, skipFirst: boolean): number[] {
  const oa = onsets(a, sr);
  const ob = onsets(b, sr).slice(skipFirst ? 1 : 0);
  return ob.map((fb) => {
    let best = Infinity;
    for (const fa of oa) if (Math.abs(fb - fa) < Math.abs(best)) best = fb - fa;
    return (best / sr) * 1000;
  });
}

const summary = (v: number[]): { n: number; meanMs: number; minMs: number; maxMs: number } => ({
  n: v.length,
  meanMs: round(v.reduce((s, x) => s + x, 0) / Math.max(1, v.length), 3),
  minMs: round(Math.min(...v), 3),
  maxMs: round(Math.max(...v), 3),
});

/**
 * Deck A plays a click track. At the moment one of A's beats is HEARD (as the engine reports it),
 * PLAY is pressed on deck B (cued on its first beat). B's clicks must then line up with A's in the
 * rendered output: the engine moved B's start back by one output latency.
 */
export async function measureAlignment(engine: RealAudioEngine, latencyMs: number): Promise<Record<string, unknown>> {
  const sr = engine.sampleRate;
  const bpm = 120;
  const first = 0.1;
  const spb = 60 / bpm;
  const clicks = clickTrack(sr, bpm, first, 40);
  const mk = (id: string): LoadedTrack => ({
    meta: {
      id,
      title: id,
      artist: 'harness',
      source: 'builtin',
      durationSec: clicks.length / sr,
      grid: { bpm, firstBeatSec: first },
      key: null,
      sections: [],
      art: { hueA: 0, hueB: 0, seed: 1 },
    },
    pcm: clicks,
    waveform: { rate: 1, length: 0, low: new Uint8Array(0), mid: new Uint8Array(0), high: new Uint8Array(0) },
    energy: { div: 4, low: new Float32Array(0), mid: new Float32Array(0), high: new Float32Array(0), bar: new Float32Array(0) },
  });
  await engine.unlock();
  engine.setLatencyMs(latencyMs);
  await engine.loadTrack('A', mk('clicks-a'));
  await engine.loadTrack('B', mk('clicks-b'));
  engine.setCrossfader(0);
  const m = engine.debug.mixer()!;
  const cap = await capture(engine.debug.ctx, m.channelOut.A, m.channelOut.B);
  engine.play('A');
  await sleep(1500);

  // the press: exactly when A's beat k is heard
  const now = performance.now();
  const posA = engine.positionAt('A', now);
  const k = Math.ceil((posA - first) / spb) + 2;
  const beatSec = first + k * spb;
  const target = now + (beatSec - posA) * 1000;
  await sleep(target - performance.now() - 15);
  while (performance.now() < target) {
    /* spin to the exact moment */
  }
  const pressed = performance.now();
  engine.play('B');
  const heardAtPress = engine.positionAt('A', pressed);
  const pressErrorMs = (heardAtPress - beatSec) * 1000;
  await sleep(2600);

  // then detune B and SYNC it back
  engine.setTempo('B', 1.03);
  await sleep(700);
  engine.sync('B');
  const syncAt = engine.debug.ctx.currentTime;
  await sleep(1600);
  const rec = await cap.stop();
  engine.pause('A');
  engine.pause('B');
  await sleep(300);
  engine.setLatencyMs(null);

  const syncFrame = Math.round(syncAt * sr) - rec.start + Math.round(0.1 * sr);
  // from the press until just before the tempo change (0.7 s before SYNC)
  const detuneFrame = syncFrame - Math.round(0.9 * sr);
  const pressPart = clickOffsets(rec.a.subarray(0, detuneFrame), rec.b.subarray(0, detuneFrame), sr, false);
  const syncPart = clickOffsets(rec.a.subarray(syncFrame), rec.b.subarray(syncFrame), sr, false);
  return {
    latencyMs,
    pressErrorMs: round(pressErrorMs, 3),
    afterPress: summary(pressPart),
    afterPressMinusPressErrorMs: round(summary(pressPart).meanMs - pressErrorMs, 3),
    afterSync: summary(syncPart),
  };
}

// ───────────────────────────── 5. soak ─────────────────────────────

export async function soak(engine: RealAudioEngine, tracks: LoadedTrack[], sec = 60): Promise<Record<string, unknown>> {
  await engine.unlock();
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
    origError.apply(console, args);
  };
  const onErr = (e: ErrorEvent): void => {
    errors.push(e.message);
  };
  const onRej = (e: PromiseRejectionEvent): void => {
    errors.push(String(e.reason));
  };
  window.addEventListener('error', onErr);
  window.addEventListener('unhandledrejection', onRej);
  const mem = (): number | null => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null;
  const before = { ...engine.debug.stats(), heap: mem() };

  let s = 11;
  const rand = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rand() * a.length)];
  const decks: DeckId[] = ['A', 'B'];
  let ops = 0;
  let loads = 0;
  let raf = 0;
  let frames = 0;
  const frame = (): void => {
    engine.getDeck('A');
    engine.getDeck('B');
    engine.getMixer();
    frames++;
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  const end = performance.now() + sec * 1000;
  while (performance.now() < end) {
    const d = pick(decks);
    const r = rand();
    try {
      if (r < 0.08) {
        loads++;
        void engine.loadTrack(d, pick(tracks)).catch((e: unknown) => errors.push(`load: ${String(e)}`));
      } else if (r < 0.12) engine.eject(d);
      else if (r < 0.3) engine.togglePlay(d);
      else if (r < 0.36) {
        engine.cueDown(d);
        await sleep(rand() * 200);
        engine.cueUp(d);
      } else if (r < 0.46) {
        engine.scratchStart(d);
        for (let i = 0; i < 12; i++) {
          engine.scratchMove(d, (rand() - 0.5) * 0.08);
          await sleep(8 + rand() * 8);
        }
        engine.scratchEnd(d);
      } else if (r < 0.52) engine.sync(d);
      else if (r < 0.58) engine.setTempo(d, 0.9 + rand() * 0.2);
      else if (r < 0.62) engine.setNudge(d, rand() < 0.5 ? 0 : rand() * 2 - 1);
      else if (r < 0.66) engine.seek(d, rand() * 30);
      else if (r < 0.72) engine.setEq(d, pick(['low', 'mid', 'high'] as const), rand());
      else if (r < 0.76) engine.setFilter(d, rand() * 2 - 1);
      else if (r < 0.8) engine.setFader(d, rand());
      else if (r < 0.84) engine.setCrossfader(rand() * 2 - 1);
      else if (r < 0.88) engine.setEcho(d, rand() < 0.5);
      else if (r < 0.96) engine.playSound(pick(['boom', 'clap']), { gain: rand(), rate: 0.8 + rand() * 0.4 });
      else if (r < 0.98) await engine.suspend().then(() => engine.resume());
      else engine.positionAt(d, performance.now() - rand() * 100);
      ops++;
    } catch (e) {
      errors.push(`threw: ${String(e)}`);
    }
    await sleep(15 + rand() * 40);
  }
  cancelAnimationFrame(raf);
  for (const d of decks) {
    engine.scratchEnd(d);
    engine.pause(d);
    engine.setEcho(d, false);
  }
  await sleep(1500);
  const after = { ...engine.debug.stats(), heap: mem() };
  console.error = origError;
  window.removeEventListener('error', onErr);
  window.removeEventListener('unhandledrejection', onRej);
  return { sec, ops, loads, frames, errors: errors.slice(0, 10), errorCount: errors.length, before, after };
}
