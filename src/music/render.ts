/**
 * The renderer: score → stereo 16-bit PCM.
 *
 * 1. Every distinct sound of the score is synthesised once (the "bank").
 * 2. The track is mixed in chunks of a few bars: events are added into eight stems like a
 *    sampler, each stem goes through its bus (filter automation, gain, sidechain), the delay and
 *    the plate reverb take their sends, and the sum goes through the limiter into Int16.
 *
 * Filters, delay, reverb and limiter carry their state from chunk to chunk, so chunking changes
 * nothing in the output; memory stays at one chunk of stems plus the finished PCM. A job is driven
 * with step() so the caller can report progress and yield between steps.
 */
import type { PcmData } from '../core/types';
import { Svf, dbToGain } from './dsp';
import type { Sample } from './dsp';
import { Limiter, PingPong, PlateReverb } from './fx';
import { Arranger, STEMS, autoValue } from './score';
import type { AutoPoint, MixSettings, Score, Sound, StemId } from './score';
import { FIRST_BEAT_SEC, TOTAL_BARS, TOTAL_BEATS, beatToFrame, trackFrames } from './timeline';
import type { TrackArt } from '../core/types';

export interface SongDef {
  id: string;
  title: string;
  bpm: number;
  key: string;
  art: TrackArt;
  seed: number;
  /** share of each eighth taken by its first sixteenth: 0.5 straight .. 0.6 swung */
  swing: number;
  mix: MixSettings;
  arrange(a: Arranger): void;
}

const scores = new WeakMap<SongDef, Score>();
export function scoreOf(song: SongDef): Score {
  let s = scores.get(song);
  if (!s) {
    const a = new Arranger(song.bpm, song.seed, song.swing);
    song.arrange(a);
    scores.set(song, (s = a.finish()));
  }
  return s;
}

export interface RenderOptions {
  /** bars per chunk (default 2). The output does not depend on it. */
  chunkBars?: number;
  /** render only these stems (and their share of delay and reverb) */
  solo?: StemId[];
  /** override the song's master gain in dB */
  masterDb?: number;
}

export interface TrackJob {
  /** Do the next slice of work. Returns true when the track is finished. */
  step(): boolean;
  /** 0..1 */
  readonly progress: number;
  result(): PcmData;
  /** linear gain of the deepest limiting so far (1 = the limiter never worked) */
  readonly limiterMinGain: number;
  /** peak of the mix going into the limiter */
  readonly prePeak: number;
}

/** Peak ceiling of the limiter: -1 dBFS with a little room for rounding. */
export const CEILING = 0.885;
const CONTROL = 32;
const DUCK_HOLD = 0.03;
const DUCK_PRE = 0.006;
const GATE_FADE = 0.008;
const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

interface Voice {
  start: number;
  /** frames the event plays for */
  len: number;
  sample: Sample;
  stem: number;
  gl: number;
  gr: number;
  /** one-shots: frame at which the gate fade starts (len if not gated) */
  gate: number;
  att: number;
  rel: number;
  offset: number;
}

interface StemState {
  id: StemId;
  l: Float32Array;
  r: Float32Array | null;
  lp: Svf[];
  hp: Svf[];
  cut: AutoPoint[] | undefined;
  gain: AutoPoint[] | undefined;
}

export function createTrackJob(song: SongDef, sampleRate: number, opts: RenderOptions = {}): TrackJob {
  const sr = sampleRate;
  const { bpm, mix } = song;
  const score = scoreOf(song);
  const env = { sr, bpm };
  const total = trackFrames(bpm, sr);
  const outL = new Int16Array(total);
  const outR = new Int16Array(total);
  const limiter = new Limiter(sr, CEILING);
  const look = limiter.lookahead;

  // the bank
  const sounds: Sound[] = [];
  const seen = new Set<Sound>();
  for (const e of score.events) {
    if (!seen.has(e.sound)) {
      seen.add(e.sound);
      sounds.push(e.sound);
    }
  }
  const bank = new Map<Sound, Sample>();
  let soundIdx = 0;

  // chunk plan
  const chunkBars = Math.max(1, Math.min(8, opts.chunkBars ?? 2));
  const bounds: number[] = [0];
  for (let bar = chunkBars; bar < TOTAL_BARS; bar += chunkBars) bounds.push(beatToFrame(bpm, sr, bar * 4));
  bounds.push(beatToFrame(bpm, sr, TOTAL_BEATS), total + look);
  let maxChunk = 0;
  for (let i = 1; i < bounds.length; i++) maxChunk = Math.max(maxChunk, bounds[i] - bounds[i - 1]);
  let chunkIdx = 0;

  // state created once the bank is ready
  let voices: Voice[] = [];
  let nextVoice = 0;
  let active: Voice[] = [];
  let stems: StemState[] = [];
  let mixL = new Float32Array(0);
  let mixR = mixL;
  let wetL = mixL;
  let wetR = mixL;
  let revIn = mixL;
  let dlyIn = mixL;
  let duck = mixL;
  let reverb: PlateReverb | null = null;
  let delay: PingPong | null = null;
  const revHp = new Svf();
  revHp.set(240, 0.7, sr);
  let dcL = 0;
  let dcR = 0;
  let dcPrevL = 0;
  let dcPrevR = 0;
  const dcR1 = 1 - (2 * Math.PI * 16) / sr;
  let prePeak = 0;
  let done = false;

  const master = dbToGain(opts.masterDb ?? mix.masterDb);
  const fadeFrom = total - Math.round(0.3 * sr);
  const spb = 60 / bpm;
  const duckRel = Math.min(0.28, 0.58 * spb);

  function prepare(): void {
    const mono = (id: StemId): boolean => id === 'kick' || id === 'bass';
    stems = STEMS.map((id) => ({
      id,
      l: new Float32Array(maxChunk),
      r: mono(id) ? null : new Float32Array(maxChunk),
      lp: [new Svf(), new Svf(), new Svf(), new Svf()],
      hp: [new Svf(), new Svf()],
      cut: score.auto[`${id}.cut`],
      gain: score.auto[`${id}.gain`],
    }));
    for (const st of stems) for (const f of st.hp) f.set(Math.max(10, mix.stems[st.id].hp), 0.71, sr);
    mixL = new Float32Array(maxChunk);
    mixR = new Float32Array(maxChunk);
    wetL = new Float32Array(maxChunk);
    wetR = new Float32Array(maxChunk);
    revIn = new Float32Array(maxChunk);
    dlyIn = new Float32Array(maxChunk);
    duck = new Float32Array(maxChunk);
    reverb = new PlateReverb(sr, mix.reverb);
    delay = new PingPong({ frames: Math.round(mix.delay.beats * spb * sr), feedback: mix.delay.feedback, damp: mix.delay.damp });

    const fadeLen = Math.round(GATE_FADE * sr);
    voices = score.events.map((e) => {
      const sample = bank.get(e.sound)!;
      const stem = STEMS.indexOf(e.stem);
      const ang = ((e.pan + 1) * Math.PI) / 4;
      const start = beatToFrame(bpm, sr, e.beat);
      const durFrames = e.dur === undefined ? -1 : Math.max(1, beatToFrame(bpm, sr, e.beat + e.dur) - start);
      const v: Voice = { start, len: sample.l.length, sample, stem, gl: e.gain * Math.SQRT2 * Math.cos(ang), gr: e.gain * Math.SQRT2 * Math.sin(ang), gate: sample.l.length, att: 0, rel: 0, offset: 0 };
      if (stems[stem].r === null) v.gl = v.gr = e.gain;
      if (sample.loop) {
        v.att = Math.max(1, Math.round((e.attack ?? 0.01) * sr));
        v.rel = Math.max(1, Math.round((e.release ?? 0.08) * sr));
        v.gate = Math.max(v.att, durFrames);
        v.len = v.gate + v.rel;
        v.offset = Math.floor((e.offset ?? 0) * sample.l.length) % sample.l.length;
      } else if (durFrames > 0 && durFrames + fadeLen < sample.l.length) {
        v.gate = durFrames;
        v.len = durFrames + fadeLen;
      }
      return v;
    });
    bank.clear();
  }

  /** Add one voice into its stem for the window [c0, c0 + n). */
  function mixVoice(v: Voice, c0: number, n: number): void {
    const st = stems[v.stem];
    const from = Math.max(c0, v.start);
    const to = Math.min(c0 + n, v.start + v.len);
    const sl = v.sample.l;
    const sR = v.sample.r ?? sl;
    const dl = st.l;
    const dr = st.r;
    const { gl, gr } = v;
    if (v.sample.loop) {
      const size = sl.length;
      let idx = (v.offset + (from - v.start)) % size;
      for (let f = from; f < to; f++) {
        const pos = f - v.start;
        const e = pos < v.att ? pos / v.att : pos < v.gate ? 1 : 1 - (pos - v.gate) / v.rel;
        const o = f - c0;
        dl[o] += sl[idx] * gl * e;
        if (dr) dr[o] += sR[idx] * gr * e;
        if (++idx === size) idx = 0;
      }
      return;
    }
    const gateEnd = v.start + v.gate;
    const plain = Math.min(to, gateEnd);
    let f = from;
    if (dr) {
      for (; f < plain; f++) {
        const pos = f - v.start;
        dl[f - c0] += sl[pos] * gl;
        dr[f - c0] += sR[pos] * gr;
      }
    } else {
      for (; f < plain; f++) dl[f - c0] += sl[f - v.start] * gl;
    }
    for (; f < to; f++) {
      const pos = f - v.start;
      const e = 1 - (pos - v.gate) / (v.len - v.gate);
      dl[f - c0] += sl[pos] * gl * e;
      if (dr) dr[f - c0] += sR[pos] * gr * e;
    }
  }

  /** Sidechain amount 0..1 for every frame of the window. */
  function fillDuck(c0: number, n: number): void {
    const hold = Math.round(DUCK_HOLD * sr);
    const rel = Math.round(duckRel * sr);
    const pre = Math.round(DUCK_PRE * sr);
    duck.fill(0, 0, n);
    const firstBeat = Math.max(0, Math.floor(((c0 / sr - FIRST_BEAT_SEC) * bpm) / 60) - 1);
    for (let b = firstBeat; b < score.duck.length; b++) {
      const depth = score.duck[b];
      const fb = beatToFrame(bpm, sr, b);
      if (fb - pre >= c0 + n) break;
      if (depth <= 0) continue;
      const from = Math.max(c0, fb - pre);
      const to = Math.min(c0 + n, fb + hold + rel);
      for (let f = from; f < to; f++) {
        const since = f - fb;
        let d: number;
        if (since < 0) d = 1 + since / pre;
        else if (since < hold) d = 1;
        else {
          const u = 1 - (since - hold) / rel;
          d = u * u * (3 - 2 * u) * u;
        }
        d *= depth;
        if (d > duck[f - c0]) duck[f - c0] = d;
      }
    }
  }

  const beatOfFrame = (f: number): number => ((f / sr - FIRST_BEAT_SEC) * bpm) / 60;

  function processStem(st: StemState, c0: number, n: number): void {
    const bus = mix.stems[st.id];
    const soloed = !opts.solo || opts.solo.includes(st.id);
    const base = soloed ? dbToGain(bus.gainDb) : 0;
    const { l, r, cut, gain } = st;
    const useHp = bus.hp > 0;
    const depth = bus.duck;
    const sendR = bus.reverb;
    const sendD = bus.delay;
    const [lpA, lpB, lpC, lpD] = st.lp;
    const [hpA, hpB] = st.hp;
    let gA = 1;
    let gB = 1;
    let open = !cut;
    for (let i = 0; i < n; i++) {
      const f = c0 + i;
      const ph = f & (CONTROL - 1);
      if (ph === 0 || i === 0) {
        const blockBeat = beatOfFrame(f - ph);
        if (cut) {
          const fc = autoValue(cut, blockBeat);
          open = fc >= 19000;
          lpA.set(fc, 0.9, sr);
          lpB.set(fc, 0.6, sr);
          lpC.set(fc, 0.9, sr);
          lpD.set(fc, 0.6, sr);
        }
        if (gain) {
          gA = autoValue(gain, blockBeat);
          gB = autoValue(gain, beatOfFrame(f - ph + CONTROL));
        }
      }
      const g = (gA + ((gB - gA) * ph) / CONTROL) * base * (1 - depth * duck[i]);
      let x = l[i];
      // the low-pass always runs so its state follows the signal; fully open it is bypassed
      if (cut) {
        const y = lpB.lp(lpA.lp(x));
        if (!open) x = y;
      }
      if (useHp) x = hpA.hp(x);
      x *= g;
      if (r) {
        let y = r[i];
        if (cut) {
          const z = lpD.lp(lpC.lp(y));
          if (!open) y = z;
        }
        if (useHp) y = hpB.hp(y);
        y *= g;
        mixL[i] += x;
        mixR[i] += y;
        const m = (x + y) * 0.5;
        revIn[i] += m * sendR;
        dlyIn[i] += m * sendD;
      } else {
        mixL[i] += x;
        mixR[i] += x;
        revIn[i] += x * sendR;
        dlyIn[i] += x * sendD;
      }
    }
  }

  function renderChunk(): void {
    const c0 = bounds[chunkIdx];
    const n = bounds[chunkIdx + 1] - c0;
    for (const st of stems) {
      st.l.fill(0, 0, n);
      st.r?.fill(0, 0, n);
    }
    mixL.fill(0, 0, n);
    mixR.fill(0, 0, n);
    wetL.fill(0, 0, n);
    wetR.fill(0, 0, n);
    revIn.fill(0, 0, n);
    dlyIn.fill(0, 0, n);

    while (nextVoice < voices.length && voices[nextVoice].start < c0 + n) active.push(voices[nextVoice++]);
    const still: Voice[] = [];
    for (const v of active) {
      mixVoice(v, c0, n);
      if (v.start + v.len > c0 + n) still.push(v);
    }
    active = still;

    fillDuck(c0, n);
    for (const st of stems) processStem(st, c0, n);

    delay!.process(dlyIn, mixL, mixR, revIn, n, dbToGain(mix.delay.returnDb), mix.delay.toReverb);
    for (let i = 0; i < n; i++) revIn[i] = revHp.hp(revIn[i]);
    reverb!.process(revIn, wetL, wetR, n, dbToGain(mix.reverb.returnDb));
    const rd = mix.reverb.duck;

    for (let i = 0; i < n; i++) {
      const wd = 1 - rd * duck[i];
      let xl = mixL[i] + wetL[i] * wd;
      let xr = mixR[i] + wetR[i] * wd;
      // DC blocker (16 Hz)
      dcL = xl - dcPrevL + dcR1 * dcL;
      dcPrevL = xl;
      dcR = xr - dcPrevR + dcR1 * dcR;
      dcPrevR = xr;
      xl = dcL * master;
      xr = dcR * master;
      const f = c0 + i;
      if (f >= fadeFrom) {
        const u = f >= total ? 0 : (total - f) / (total - fadeFrom);
        xl *= u * u;
        xr *= u * u;
      }
      const al = xl < 0 ? -xl : xl;
      const ar = xr < 0 ? -xr : xr;
      if (al > prePeak) prePeak = al;
      if (ar > prePeak) prePeak = ar;
      // soft clip above -2.5 dBFS: rounds off kick transients so the limiter barely moves
      if (al > 0.75) xl = (xl < 0 ? -1 : 1) * (0.75 + 0.25 * Math.tanh((al - 0.75) * 4));
      if (ar > 0.75) xr = (xr < 0 ? -1 : 1) * (0.75 + 0.25 * Math.tanh((ar - 0.75) * 4));
      mixL[i] = xl;
      mixR[i] = xr;
    }
    limiter.process(mixL, mixR, n);
    // the limiter delays by `look` frames: write that much earlier, so the PCM has no latency
    for (let i = 0; i < n; i++) {
      const o = c0 + i - look;
      if (o < 0 || o >= total) continue;
      const a = Math.round(mixL[i] * 32767);
      const b = Math.round(mixR[i] * 32767);
      outL[o] = a > 32767 ? 32767 : a < -32768 ? -32768 : a;
      outR[o] = b > 32767 ? 32767 : b < -32768 ? -32768 : b;
    }
    if (Math.abs(dcL) < 1e-25) dcL = 0;
    if (Math.abs(dcR) < 1e-25) dcR = 0;
  }

  return {
    step(): boolean {
      if (done) return true;
      if (soundIdx < sounds.length) {
        const t0 = now();
        do {
          const s = sounds[soundIdx++];
          bank.set(s, s.make(env));
        } while (soundIdx < sounds.length && now() - t0 < 12);
        if (soundIdx === sounds.length) prepare();
        return false;
      }
      if (stems.length === 0) prepare();
      renderChunk();
      chunkIdx++;
      if (chunkIdx >= bounds.length - 1) {
        done = true;
        voices = [];
        active = [];
        stems = [];
      }
      return done;
    },
    get progress(): number {
      if (done) return 1;
      const a = sounds.length ? soundIdx / sounds.length : 1;
      return 0.22 * a + 0.78 * (chunkIdx / (bounds.length - 1));
    },
    result(): PcmData {
      if (!done) throw new Error('render not finished');
      return { sampleRate: sr, length: total, channels: [outL, outR] };
    },
    get limiterMinGain(): number {
      return limiter.minGain;
    },
    get prePeak(): number {
      return prePeak;
    },
  };
}

/** Run a job to the end in one go (tests, the worker). */
export function renderTrackSync(song: SongDef, sampleRate: number, opts?: RenderOptions, onProgress?: (p: number) => void): PcmData {
  const job = createTrackJob(song, sampleRate, opts);
  while (!job.step()) onProgress?.(job.progress);
  onProgress?.(1);
  return job.result();
}
