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
import { HalfRateReverb, Limiter, PingPong } from './fx';
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
  /** two cascaded low-pass SVFs per channel: [ic1, ic2, ic1, ic2] */
  lpL: Float64Array;
  lpR: Float64Array;
  cut: AutoPoint[] | undefined;
  gain: AutoPoint[] | undefined;
  /** a voice wrote into this stem in the current chunk */
  touched: boolean;
  /** ... or in the previous one (filter tails and sends still ringing) */
  wasTouched: boolean;
}

/** Q of the two low-pass stages (k = 1 / Q). */
const LP_K1 = 1 / 0.9;
const LP_K2 = 1 / 0.6;
const HP_K = 1 / 0.71;
const DENORM = 1e-20;

/**
 * Two cascaded zero-delay-feedback SVF low-passes over buf[from, to), state in st.
 * With apply = false the state follows the signal but the buffer is left untouched (filter open).
 */
function lowpass2(buf: Float32Array, from: number, to: number, st: Float64Array, g: number, apply: boolean): void {
  const a1 = 1 / (1 + g * (g + LP_K1));
  const a2 = g * a1;
  const a3 = g * a2;
  const b1 = 1 / (1 + g * (g + LP_K2));
  const b2 = g * b1;
  const b3 = g * b2;
  let p1 = st[0];
  let p2 = st[1];
  let q1 = st[2];
  let q2 = st[3];
  for (let i = from; i < to; i++) {
    let v3 = buf[i] - p2;
    let v1 = a1 * p1 + a2 * v3;
    let v2 = p2 + a2 * p1 + a3 * v3;
    // (+ DENORM - DENORM flushes values far below audibility to zero: subnormals are very slow)
    p1 = 2 * v1 - p1 + DENORM - DENORM;
    p2 = 2 * v2 - p2 + DENORM - DENORM;
    v3 = v2 - q2;
    v1 = b1 * q1 + b2 * v3;
    v2 = q2 + b2 * q1 + b3 * v3;
    q1 = 2 * v1 - q1 + DENORM - DENORM;
    q2 = 2 * v2 - q2 + DENORM - DENORM;
    if (apply) buf[i] = v2;
  }
  st[0] = p1;
  st[1] = p2;
  st[2] = q1;
  st[3] = q2;
}

/**
 * A high-passed copy of a sample (one SVF per channel). A loop is filtered circularly: one pass to
 * settle the filter, a second to write, so the copy still loops without a click.
 */
function highpassSample(src: Sample, freq: number, sr: number): Sample {
  const g = svfG(freq, sr);
  const a1 = 1 / (1 + g * (g + HP_K));
  const a2 = g * a1;
  const a3 = g * a2;
  const run = (x: Float32Array): Float32Array => {
    const out = new Float32Array(x.length);
    let p1 = 0;
    let p2 = 0;
    for (let pass = src.loop ? 0 : 1; pass < 2; pass++) {
      for (let i = 0; i < x.length; i++) {
        const v = x[i];
        const v3 = v - p2;
        const v1 = a1 * p1 + a2 * v3;
        const v2 = p2 + a2 * p1 + a3 * v3;
        p1 = 2 * v1 - p1 + DENORM - DENORM;
        p2 = 2 * v2 - p2 + DENORM - DENORM;
        out[i] = v - HP_K * v1 - v2;
      }
    }
    return out;
  };
  return { l: run(src.l), r: src.r ? run(src.r) : null, loop: src.loop };
}

const svfG = (freq: number, sr: number): number => Math.tan((Math.PI * Math.min(Math.max(freq, 10), sr * 0.45)) / sr);

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
  /** per-frame gain of the stem being processed */
  let gbuf = mixL;
  let reverb: HalfRateReverb | null = null;
  let delay: PingPong | null = null;
  const revHp = new Svf();
  revHp.set(240, 0.7, sr);
  /** DC blocker state: yL, yR, previous xL, previous xR */
  const dc = new Float64Array(4);
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
      lpL: new Float64Array(4),
      lpR: new Float64Array(4),
      cut: score.auto[`${id}.cut`],
      gain: score.auto[`${id}.gain`],
      touched: false,
      wasTouched: false,
    }));
    gbuf = new Float32Array(maxChunk);
    mixL = new Float32Array(maxChunk);
    mixR = new Float32Array(maxChunk);
    wetL = new Float32Array(maxChunk);
    wetR = new Float32Array(maxChunk);
    revIn = new Float32Array(maxChunk);
    dlyIn = new Float32Array(maxChunk);
    duck = new Float32Array(maxChunk);
    reverb = new HalfRateReverb(sr, mix.reverb, maxChunk);
    delay = new PingPong({ frames: Math.round(mix.delay.beats * spb * sr), feedback: mix.delay.feedback, damp: mix.delay.damp });

    const fadeLen = Math.round(GATE_FADE * sr);
    // the stems' high-passes are baked into each note once, instead of running on every frame
    const baked = new Map<string, Sample>();
    const sampleFor = (sound: Sound, stem: StemId): Sample => {
      const raw = bank.get(sound)!;
      const hp = mix.stems[stem].hp;
      if (hp <= 0) return raw;
      const key = `${sound.key}|${hp}`;
      let s = baked.get(key);
      if (!s) baked.set(key, (s = highpassSample(raw, hp, sr)));
      return s;
    };
    voices = score.events.map((e) => {
      const sample = sampleFor(e.sound, e.stem);
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
    st.touched = true;
    const from = Math.max(c0, v.start);
    const to = Math.min(c0 + n, v.start + v.len);
    const sl = v.sample.l;
    const sR = v.sample.r ?? sl;
    const dl = st.l;
    const dr = st.r;
    const { gl, gr } = v;
    if (v.sample.loop) {
      // in runs that share one envelope segment and do not wrap the loop
      const size = sl.length;
      let idx = (v.offset + (from - v.start)) % size;
      let f = from;
      while (f < to) {
        const pos = f - v.start;
        let end = Math.min(to, f + size - idx);
        let e0: number;
        let de: number;
        if (pos < v.att) {
          end = Math.min(end, v.start + v.att);
          e0 = pos / v.att;
          de = 1 / v.att;
        } else if (pos < v.gate) {
          end = Math.min(end, v.start + v.gate);
          e0 = 1;
          de = 0;
        } else {
          e0 = 1 - (pos - v.gate) / v.rel;
          de = -1 / v.rel;
        }
        const cnt = end - f;
        const o = f - c0 - idx;
        const al = gl * e0;
        const ar = gr * e0;
        const dal = gl * de;
        const dar = gr * de;
        if (dr) {
          for (let k = 0; k < cnt; k++) {
            const j = idx + k;
            dl[o + j] += sl[j] * (al + dal * k);
            dr[o + j] += sR[j] * (ar + dar * k);
          }
        } else {
          for (let k = 0; k < cnt; k++) dl[o + idx + k] += sl[idx + k] * (al + dal * k);
        }
        f = end;
        idx += cnt;
        if (idx >= size) idx -= size;
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

  const mixLRef = (): Float32Array => mixL;
  const mixRRef = (): Float32Array => mixR;
  const revInRef = (): Float32Array => revIn;
  const dlyInRef = (): Float32Array => dlyIn;
  const beatOfFrame = (f: number): number => ((f / sr - FIRST_BEAT_SEC) * bpm) / 60;

  function processStem(st: StemState, c0: number, n: number): void {
    const wasTouched = st.wasTouched;
    st.wasTouched = st.touched;
    if (!st.touched && !wasTouched) {
      // silent for two chunks: the filter tails have died away, nothing to add
      st.lpL.fill(0);
      st.lpR.fill(0);
      return;
    }
    st.touched = false;
    const bus = mix.stems[st.id];
    const soloed = !opts.solo || opts.solo.includes(st.id);
    const base = soloed ? dbToGain(bus.gainDb) : 0;
    const { l, r, cut, gain } = st;
    const depth = bus.duck;

    // filter sweep, in blocks of CONTROL frames
    if (cut) {
      for (let b = 0; b < n; b += CONTROL) {
        const e = Math.min(n, b + CONTROL);
        const fc = autoValue(cut, beatOfFrame(c0 + b));
        const g = svfG(fc, sr);
        const apply = fc < 19000;
        lowpass2(l, b, e, st.lpL, g, apply);
        if (r) lowpass2(r, b, e, st.lpR, g, apply);
      }
    }

    // gain: automation (interpolated across each block) × bus gain × sidechain
    if (gain) {
      for (let b = 0; b < n; b += CONTROL) {
        const e = Math.min(n, b + CONTROL);
        const gA = autoValue(gain, beatOfFrame(c0 + b));
        const gB = autoValue(gain, beatOfFrame(c0 + b + CONTROL));
        for (let i = b; i < e; i++) gbuf[i] = (gA + ((gB - gA) * (i - b)) / CONTROL) * base * (1 - depth * duck[i]);
      }
    } else if (depth > 0) {
      const dk = duck;
      for (let i = 0; i < n; i++) gbuf[i] = base * (1 - depth * dk[i]);
    } else gbuf.fill(base, 0, n);
    const gbuf2 = gbuf;

    const sendR = bus.reverb;
    const sendD = bus.delay;
    const mixL = mixLRef();
    const mixR = mixRRef();
    const revIn = revInRef();
    const dlyIn = dlyInRef();
    if (r) {
      for (let i = 0; i < n; i++) {
        const g = gbuf2[i];
        const x = l[i] * g;
        const y = r[i] * g;
        mixL[i] += x;
        mixR[i] += y;
        const m = (x + y) * 0.5;
        revIn[i] += m * sendR;
        dlyIn[i] += m * sendD;
      }
    } else {
      for (let i = 0; i < n; i++) {
        const x = l[i] * gbuf2[i];
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
    const rin = revIn;
    for (let i = 0; i < n; i++) rin[i] = revHp.hp(rin[i]);
    reverb!.process(revIn, wetL, wetR, n, dbToGain(mix.reverb.returnDb));
    const rd = mix.reverb.duck;

    // hot loop: everything in locals (captured mutable variables would be boxed on every write)
    const mL = mixL;
    const mR = mixR;
    const wL = wetL;
    const wR = wetR;
    const dk = duck;
    let dcL = dc[0];
    let dcR = dc[1];
    let dcPrevL = dc[2];
    let dcPrevR = dc[3];
    let pk = prePeak;
    for (let i = 0; i < n; i++) {
      const wd = 1 - rd * dk[i];
      let xl = mL[i] + wL[i] * wd;
      let xr = mR[i] + wR[i] * wd;
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
      if (al > pk) pk = al;
      if (ar > pk) pk = ar;
      // soft clip above -2.5 dBFS: rounds off kick transients so the limiter barely moves
      if (al > 0.75) xl = (xl < 0 ? -1 : 1) * (0.75 + 0.25 * Math.tanh((al - 0.75) * 4));
      if (ar > 0.75) xr = (xr < 0 ? -1 : 1) * (0.75 + 0.25 * Math.tanh((ar - 0.75) * 4));
      mL[i] = xl;
      mR[i] = xr;
    }
    prePeak = pk;
    dc[0] = Math.abs(dcL) < 1e-25 ? 0 : dcL;
    dc[1] = Math.abs(dcR) < 1e-25 ? 0 : dcR;
    dc[2] = dcPrevL;
    dc[3] = dcPrevR;
    limiter.process(mixL, mixR, n);
    // the limiter delays by `look` frames: write that much earlier, so the PCM has no latency
    const i0 = Math.max(0, look - c0);
    const i1 = Math.min(n, total + look - c0);
    const oL = outL;
    const oR = outR;
    for (let i = i0; i < i1; i++) {
      const o = c0 + i - look;
      // round to nearest: floor(x + 0.5) on a positive offset, then clamp
      const a = ((mL[i] * 32767 + 32768.5) | 0) - 32768;
      const b = ((mR[i] * 32767 + 32768.5) | 0) - 32768;
      oL[o] = a > 32767 ? 32767 : a < -32768 ? -32768 : a;
      oR[o] = b > 32767 ? 32767 : b < -32768 ? -32768 : b;
    }
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
