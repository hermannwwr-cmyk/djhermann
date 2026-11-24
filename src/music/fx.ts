/**
 * Streaming effects for the mix bus: plate reverb, ping-pong delay and the look-ahead limiter.
 * All of them keep their state between calls, so a track can be processed in chunks of any size
 * and give the same result as one pass.
 */

const pow2 = (n: number): number => {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
};

/** Delay line on a power-of-two ring buffer. */
class Line {
  readonly buf: Float32Array;
  readonly mask: number;
  constructor(maxFrames: number) {
    const size = pow2(maxFrames + 4);
    this.buf = new Float32Array(size);
    this.mask = size - 1;
  }
}

export interface PlateParams {
  /** tank feedback 0..0.9: longer tail */
  decay: number;
  /** 0..1 high-frequency damping in the tank */
  damping: number;
  /** seconds before the reverb starts */
  preDelay: number;
}

/**
 * Plate reverb after Dattorro ("Effect Design, Part 1", 1997): four input diffusers into a
 * figure-of-eight tank of two modulated all-passes, two delays, two damping filters and two more
 * all-passes. Mono in, decorrelated stereo out, no dry signal.
 */
export class PlateReverb {
  private readonly k: number;
  private readonly lines: Line[];
  private readonly len: number[];
  private readonly taps: number[];
  private readonly pre: Line;
  private readonly preLen: number;
  private w = 0;
  private bw = 0;
  private lpA = 0;
  private lpB = 0;
  private fbA = 0;
  private fbB = 0;
  private lfo = 0;
  private readonly lfoInc: number;
  private readonly exc: number;

  constructor(
    sampleRate: number,
    private readonly p: PlateParams,
  ) {
    this.k = sampleRate / 29761;
    const L = [142, 107, 379, 277, 672, 4453, 1800, 3720, 908, 4217, 2656, 3163];
    this.len = L.map((v) => Math.round(v * this.k));
    this.exc = 12 * this.k;
    this.lines = this.len.map((v) => new Line(v + Math.ceil(this.exc) + 2));
    const T = [266, 2974, 1913, 1996, 1990, 187, 1066, 353, 3627, 1228, 2673, 2111, 335, 121];
    this.taps = T.map((v) => Math.round(v * this.k));
    this.preLen = Math.max(1, Math.round(p.preDelay * sampleRate));
    this.pre = new Line(this.preLen);
    this.lfoInc = (2 * Math.PI * 0.9) / sampleRate;
  }

  /** Reads `n` mono samples from `input` and ADDS the wet signal × gain into outL / outR. */
  process(input: Float32Array, outL: Float32Array, outR: Float32Array, n: number, gain: number): void {
    const [a0, a1, a2, a3, m1, d1, p1, d2, m2, d3, p2, d4] = this.lines.map((l) => l.buf);
    const [k0, k1, k2, k3, km1, kd1, kp1, kd2, km2, kd3, kp2, kd4] = this.lines.map((l) => l.mask);
    const [n0, n1, n2, n3, nm1, nd1, np1, nd2, nm2, nd3, np2, nd4] = this.len;
    const t = this.taps;
    const pre = this.pre.buf;
    const kpre = this.pre.mask;
    const { decay, damping } = this.p;
    const g = 0.6 * gain;
    let { w, bw, lpA, lpB, fbA, fbB, lfo } = this;
    for (let i = 0; i < n; i++) {
      pre[w & kpre] = input[i];
      let v = pre[(w - this.preLen) & kpre];
      bw += 0.85 * (v - bw);
      v = bw;
      // input diffusion
      let d = a0[(w - n0) & k0];
      let u = v - 0.75 * d;
      a0[w & k0] = u;
      v = d + 0.75 * u;
      d = a1[(w - n1) & k1];
      u = v - 0.75 * d;
      a1[w & k1] = u;
      v = d + 0.75 * u;
      d = a2[(w - n2) & k2];
      u = v - 0.625 * d;
      a2[w & k2] = u;
      v = d + 0.625 * u;
      d = a3[(w - n3) & k3];
      u = v - 0.625 * d;
      a3[w & k3] = u;
      v = d + 0.625 * u;

      // slow modulation of the first tank all-passes (linear-interpolated read)
      lfo += this.lfoInc;
      if (lfo > 2 * Math.PI) lfo -= 2 * Math.PI;
      const ex = this.exc * (0.5 + 0.5 * Math.sin(lfo));
      const ei = ex | 0;
      const ef = ex - ei;

      // tank half A
      let xa = v + decay * fbB;
      let r0 = (w - nm1 - ei) & km1;
      d = m1[r0] + ef * (m1[(r0 - 1) & km1] - m1[r0]);
      u = xa + 0.7 * d;
      m1[w & km1] = u;
      xa = d - 0.7 * u;
      d1[w & kd1] = xa;
      xa = d1[(w - nd1) & kd1];
      lpA = xa * (1 - damping) + lpA * damping;
      xa = lpA * decay;
      d = p1[(w - np1) & kp1];
      u = xa - 0.5 * d;
      p1[w & kp1] = u;
      xa = d + 0.5 * u;
      d2[w & kd2] = xa;
      fbA = d2[(w - nd2) & kd2];

      // tank half B
      let xb = v + decay * fbA;
      r0 = (w - nm2 - (this.exc - ex | 0)) & km2;
      d = m2[r0];
      u = xb + 0.7 * d;
      m2[w & km2] = u;
      xb = d - 0.7 * u;
      d3[w & kd3] = xb;
      xb = d3[(w - nd3) & kd3];
      lpB = xb * (1 - damping) + lpB * damping;
      xb = lpB * decay;
      d = p2[(w - np2) & kp2];
      u = xb - 0.5 * d;
      p2[w & kp2] = u;
      xb = d + 0.5 * u;
      d4[w & kd4] = xb;
      fbB = d4[(w - nd4) & kd4];

      outL[i] +=
        g *
        (d3[(w - t[0]) & kd3] + d3[(w - t[1]) & kd3] - p2[(w - t[2]) & kp2] + d4[(w - t[3]) & kd4] - d1[(w - t[4]) & kd1] - p1[(w - t[5]) & kp1] - d2[(w - t[6]) & kd2]);
      outR[i] +=
        g *
        (d1[(w - t[7]) & kd1] + d1[(w - t[8]) & kd1] - p1[(w - t[9]) & kp1] + d2[(w - t[10]) & kd2] - d3[(w - t[11]) & kd3] - p2[(w - t[12]) & kp2] - d4[(w - t[13]) & kd4]);
      w++;
    }
    // keep the write index small; every mask divides 2^20
    this.w = w & 0xfffff;
    this.bw = bw;
    this.lpA = Math.abs(lpA) < 1e-20 ? 0 : lpA;
    this.lpB = Math.abs(lpB) < 1e-20 ? 0 : lpB;
    this.fbA = fbA;
    this.fbB = fbB;
    this.lfo = lfo;
  }
}

export interface DelayParams {
  /** delay time in frames (one echo; left and right alternate) */
  frames: number;
  feedback: number;
  /** one-pole low-pass in the loop, 0..1 (higher = darker) */
  damp: number;
}

/** Ping-pong delay: mono in, echoes alternate left / right. No dry signal. */
export class PingPong {
  private readonly a: Line;
  private readonly b: Line;
  private w = 0;
  private lpA = 0;
  private lpB = 0;
  private hp = 0;

  constructor(private readonly p: DelayParams) {
    this.a = new Line(p.frames);
    this.b = new Line(p.frames);
  }

  /** ADDS the echoes × gain into outL / outR and × toSend into `send` (the reverb input). */
  process(input: Float32Array, outL: Float32Array, outR: Float32Array, send: Float32Array, n: number, gain: number, toSend: number): void {
    const a = this.a.buf;
    const b = this.b.buf;
    const mask = this.a.mask;
    const { frames, feedback, damp } = this.p;
    let { w, lpA, lpB, hp } = this;
    for (let i = 0; i < n; i++) {
      const ea = a[(w - frames) & mask];
      const eb = b[(w - frames) & mask];
      lpA = ea * (1 - damp) + lpA * damp;
      lpB = eb * (1 - damp) + lpB * damp;
      // gentle high-pass on what goes round, so the echoes thin out instead of building up mud
      const x = input[i];
      hp += 0.03 * (lpB - hp);
      a[w & mask] = x + (lpB - hp) * feedback;
      b[w & mask] = lpA * feedback;
      outL[i] += ea * gain;
      outR[i] += eb * gain;
      send[i] += (ea + eb) * toSend;
      w++;
    }
    this.w = w & 0xfffff;
    this.lpA = Math.abs(lpA) < 1e-20 ? 0 : lpA;
    this.lpB = Math.abs(lpB) < 1e-20 ? 0 : lpB;
    this.hp = Math.abs(hp) < 1e-20 ? 0 : hp;
  }
}

/**
 * Stereo look-ahead peak limiter. The signal is delayed by `lookahead` frames while the gain
 * reaches its target, and `process` reports that delay so the caller can write the output
 * `lookahead` frames earlier: the result has no latency at all.
 *
 * Gain = sliding minimum of the required gain over the look-ahead window, with an exponential
 * release, then a moving average over the same window. The average of values that are all at or
 * under the required gain cannot overshoot, so the ceiling is a hard guarantee.
 */
export class Limiter {
  readonly lookahead: number;
  private readonly size: number;
  private readonly dl: Float32Array;
  private readonly dr: Float32Array;
  private readonly req: Float32Array;
  private readonly sm: Float32Array;
  private w = 0;
  private minVal = 1;
  private minAge = 0;
  private rel = 1;
  private sum: number;
  private readonly relCoef: number;
  /** largest gain reduction applied so far, as a linear gain (1 = never limited) */
  minGain = 1;

  constructor(
    sampleRate: number,
    private readonly ceiling: number,
    lookaheadSec = 0.002,
    releaseSec = 0.08,
  ) {
    this.lookahead = Math.max(8, Math.round(lookaheadSec * sampleRate));
    this.size = this.lookahead + 1;
    this.dl = new Float32Array(this.size);
    this.dr = new Float32Array(this.size);
    this.req = new Float32Array(this.size).fill(1);
    this.sm = new Float32Array(this.size).fill(1);
    this.sum = this.size;
    this.relCoef = 1 - Math.exp(-1 / (releaseSec * sampleRate));
  }

  /** In place. Output sample i is input sample i - lookahead. */
  process(l: Float32Array, r: Float32Array, n: number): void {
    const { size, dl, dr, req, sm, ceiling, relCoef } = this;
    let { w, minVal, minAge, rel, sum, minGain } = this;
    for (let i = 0; i < n; i++) {
      const xl = l[i];
      const xr = r[i];
      const al = xl < 0 ? -xl : xl;
      const ar = xr < 0 ? -xr : xr;
      const pk = al > ar ? al : ar;
      const need = pk > ceiling ? ceiling / pk : 1;
      // sliding minimum of `need` over the last `size` samples
      req[w] = need;
      if (need <= minVal) {
        minVal = need;
        minAge = 0;
      } else if (++minAge >= size) {
        minVal = 1;
        minAge = 0;
        for (let j = 0; j < size; j++) {
          const idx = w - j < 0 ? w - j + size : w - j;
          if (req[idx] < minVal) {
            minVal = req[idx];
            minAge = j;
          }
        }
      }
      rel += (1 - rel) * relCoef;
      if (rel > minVal) rel = minVal;
      // moving average of the released minimum
      // (single precision values summed in double precision: the running sum stays exact)
      const rf = Math.fround(rel);
      sum += rf - sm[w];
      sm[w] = rf;
      const gain = sum / size;
      if (gain < minGain) minGain = gain;
      const outIdx = w + 1 === size ? 0 : w + 1; // oldest sample = the one `lookahead` frames back
      const ol = dl[outIdx];
      const or = dr[outIdx];
      dl[w] = xl;
      dr[w] = xr;
      // (dl[w] is written after the read: with size = lookahead + 1 the oldest slot is w + 1)
      l[i] = ol * gain;
      r[i] = or * gain;
      w = outIdx;
    }
    this.sum = sum;
    this.w = w;
    this.minVal = minVal;
    this.minAge = minAge;
    this.rel = rel;
    this.minGain = minGain;
  }
}
