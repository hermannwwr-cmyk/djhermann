/**
 * Small DSP toolbox for the analysis: radix-2 FFT, autocorrelation, biquad design, percentiles.
 * Everything here is pure and allocation-light; it runs in the analysis Worker.
 */

export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

interface FftTables {
  cos: Float64Array;
  sin: Float64Array;
  rev: Uint32Array;
}

const fftTables = new Map<number, FftTables>();

function tablesFor(n: number): FftTables {
  let t = fftTables.get(n);
  if (t) return t;
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    const a = (2 * Math.PI * i) / n;
    cos[i] = Math.cos(a);
    sin[i] = Math.sin(a);
  }
  const rev = new Uint32Array(n);
  let bits = 0;
  while (1 << bits < n) bits++;
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >>> b) & 1) << (bits - 1 - b);
    rev[i] = r >>> 0;
  }
  t = { cos, sin, rev };
  // keep only a couple of sizes around: the tables are as big as the transform
  if (fftTables.size >= 3) fftTables.clear();
  fftTables.set(n, t);
  return t;
}

/** In-place forward FFT of a complex signal. The length must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n < 2) return;
  const { cos, sin, rev } = tablesFor(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let size = 2; size <= n; size *= 2) {
    const half = size / 2;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const wr = cos[k];
        const wi = -sin[k];
        const a = start + j;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

/**
 * Autocorrelation of a real signal for lags 0..maxLag (mean removed, unbiased: every lag is
 * scaled as if all `n` products were available). Uses the FFT, so it costs O(n log n).
 */
export function autocorrelate(signal: ArrayLike<number>, maxLag: number): Float64Array {
  const n = signal.length;
  const out = new Float64Array(maxLag + 1);
  if (n < 2) return out;
  const size = nextPow2(n + maxLag + 1);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += signal[i];
  mean /= n;
  for (let i = 0; i < n; i++) re[i] = signal[i] - mean;
  fft(re, im);
  for (let i = 0; i < size; i++) {
    re[i] = re[i] * re[i] + im[i] * im[i];
    im[i] = 0;
  }
  fft(re, im); // the power spectrum is real and even, so forward = inverse × size
  for (let lag = 0; lag <= maxLag; lag++) {
    out[lag] = lag < n ? re[lag] / size / (n - lag) : 0;
  }
  return out;
}

/** The p-quantile (0..1) of a list of numbers; linear interpolation between neighbours. */
export function percentile(values: ArrayLike<number>, p: number): number {
  const n = values.length;
  if (n === 0) return 0;
  const sorted = Float64Array.from(values as ArrayLike<number>).sort();
  const x = Math.min(1, Math.max(0, p)) * (n - 1);
  const i = Math.floor(x);
  const f = x - i;
  return i + 1 < n ? sorted[i] * (1 - f) + sorted[i + 1] * f : sorted[i];
}

/** Several quantiles of the same data with one sort. */
export function percentiles(values: ArrayLike<number>, ps: number[]): number[] {
  const n = values.length;
  if (n === 0) return ps.map(() => 0);
  const sorted = Float64Array.from(values as ArrayLike<number>).sort();
  return ps.map((p) => {
    const x = Math.min(1, Math.max(0, p)) * (n - 1);
    const i = Math.floor(x);
    const f = x - i;
    return i + 1 < n ? sorted[i] * (1 - f) + sorted[i + 1] * f : sorted[i];
  });
}

/** Normalised biquad coefficients [b0, b1, b2, a1, a2] (a0 = 1). */
export type Biquad = [number, number, number, number, number];

/** Second-order low-pass or high-pass section (RBJ cookbook). */
export function biquad(kind: 'lp' | 'hp', freq: number, sampleRate: number, q: number): Biquad {
  const f = Math.min(freq, sampleRate * 0.45);
  const w = (2 * Math.PI * f) / sampleRate;
  const cosw = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  if (kind === 'lp') {
    const b = (1 - cosw) / 2;
    return [b / a0, (2 * b) / a0, b / a0, (-2 * cosw) / a0, (1 - alpha) / a0];
  }
  const b = (1 + cosw) / 2;
  return [b / a0, (-2 * b) / a0, b / a0, (-2 * cosw) / a0, (1 - alpha) / a0];
}

/** The two Q values of a fourth-order Butterworth filter built from two biquads. */
export const BUTTER4_Q: readonly [number, number] = [0.5411961, 1.306563];

/** Group delay in seconds of a cascade of biquads at a frequency. */
export function groupDelay(sections: Biquad[], freq: number, sampleRate: number): number {
  const phaseAt = (f: number): number => {
    const w = (2 * Math.PI * f) / sampleRate;
    let phase = 0;
    for (const [b0, b1, b2, a1, a2] of sections) {
      // H(e^jw) = (b0 + b1 z^-1 + b2 z^-2) / (1 + a1 z^-1 + a2 z^-2)
      const c1 = Math.cos(w);
      const s1 = -Math.sin(w);
      const c2 = Math.cos(2 * w);
      const s2 = -Math.sin(2 * w);
      const nr = b0 + b1 * c1 + b2 * c2;
      const ni = b1 * s1 + b2 * s2;
      const dr = 1 + a1 * c1 + a2 * c2;
      const di = a1 * s1 + a2 * s2;
      phase += Math.atan2(ni, nr) - Math.atan2(di, dr);
    }
    return phase;
  };
  const df = Math.max(0.5, freq * 0.01);
  let d = phaseAt(freq + df) - phaseAt(freq - df);
  // unwrap the difference
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return -d / (2 * Math.PI * 2 * df);
}

/** Symmetric Hann kernel of odd length, normalised to sum 1. */
export function hannKernel(length: number): Float64Array {
  const n = Math.max(1, length | 1);
  const k = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    k[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 1)) / (n + 1));
    sum += k[i];
  }
  for (let i = 0; i < n; i++) k[i] /= sum;
  return k;
}

/** Zero-phase smoothing of `src` with a symmetric kernel (edges use the available samples). */
export function smooth(src: ArrayLike<number>, kernel: Float64Array, out: Float32Array | Float64Array): void {
  const n = src.length;
  const half = (kernel.length - 1) / 2;
  for (let i = 0; i < n; i++) {
    let acc = 0;
    let wsum = 0;
    const lo = i - half < 0 ? 0 : i - half;
    const hi = i + half >= n ? n - 1 : i + half;
    if (lo === i - half && hi === i + half) {
      for (let j = lo, k = 0; j <= hi; j++, k++) acc += src[j] * kernel[k];
      out[i] = acc;
    } else {
      for (let j = lo; j <= hi; j++) {
        const w = kernel[j - i + half];
        acc += src[j] * w;
        wsum += w;
      }
      out[i] = wsum > 0 ? acc / wsum : 0;
    }
  }
}
