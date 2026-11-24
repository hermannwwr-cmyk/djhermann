/*
 * DJ Hermann: master look-ahead peak limiter (AudioWorklet, plain JavaScript, no imports).
 *
 * Keeps the master below `ceiling` however many full-level sources are summed, without clipping:
 *   required gain  ->  instant attack / slow release envelope  ->  sliding minimum over the
 *   look-ahead window  ->  box average of the same length  ->  applied to the delayed signal.
 * The box average of the sliding minimum is never above the gain the delayed sample needs, so the
 * ceiling is exact; the gain glides down over the look-ahead instead of stepping, so it does not
 * click. The only cost is `lookahead` frames of delay, which the engine counts as latency.
 *
 * processorOptions: { lookahead: frames, ceiling: linear, release: seconds }
 */
class MasterLimiter extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    const d = Math.max(8, Math.min(2048, Math.round(o.lookahead || 0.0015 * sampleRate)));
    this.d = d;
    this.n = d + 1; // window length of the minimum and of the average
    this.ceiling = o.ceiling > 0 ? o.ceiling : 0.944;
    this.rel = 1 - Math.exp(-1 / ((o.release > 0 ? o.release : 0.12) * sampleRate));
    this.dl = new Float32Array(d);
    this.dr = new Float32Array(d);
    this.w = 0; // write index into the delay lines
    this.env = 1;
    // monotonic deque for the sliding minimum
    this.qv = new Float64Array(this.n + 1);
    this.qi = new Float64Array(this.n + 1);
    this.qh = 0;
    this.qc = 0;
    this.k = 0; // sample counter
    // box average
    this.ring = new Float64Array(this.n).fill(1);
    this.ri = 0;
    this.sum = this.n;
    this.calm = 0; // samples since the gain was last below 1 anywhere in the pipeline
    this.silent = 0; // samples of pure silence in a row (to stop early)
  }

  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const oL = out[0];
    const oR = out.length > 1 ? out[1] : null;
    const inp = inputs[0];
    const iL = inp && inp.length > 0 ? inp[0] : null;
    const iR = inp && inp.length > 1 ? inp[1] : iL;
    const n = oL.length;
    const d = this.d;
    const N = this.n;
    const C = this.ceiling;
    const dl = this.dl;
    const dr = this.dr;
    let w = this.w;

    // block peak decides whether the fast path (pure delay) is safe
    let peak = 0;
    if (iL) {
      for (let i = 0; i < n; i++) {
        const a = iL[i] < 0 ? -iL[i] : iL[i];
        const b = iR[i] < 0 ? -iR[i] : iR[i];
        if (a > peak) peak = a;
        if (b > peak) peak = b;
      }
    }

    if (peak <= C && this.calm > 2 * N) {
      // nothing to limit and the gain has fully recovered: just the delay
      for (let i = 0; i < n; i++) {
        const l = iL ? iL[i] : 0;
        const r = iL ? iR[i] : 0;
        oL[i] = dl[w];
        if (oR) oR[i] = dr[w];
        dl[w] = l;
        dr[w] = r;
        if (++w >= d) w = 0;
      }
      this.w = w;
      this.k += n;
      this.calm += n;
      return true;
    }

    const qv = this.qv;
    const qi = this.qi;
    const QN = qv.length;
    const ring = this.ring;
    let qh = this.qh;
    let qc = this.qc;
    let k = this.k;
    let env = this.env;
    let ri = this.ri;
    let sum = this.sum;
    let calm = this.calm;
    const rel = this.rel;

    for (let i = 0; i < n; i++) {
      const l = iL ? iL[i] : 0;
      const r = iL ? iR[i] : 0;
      const a = l < 0 ? -l : l;
      const b = r < 0 ? -r : r;
      const p = a > b ? a : b;
      const need = p > C ? C / p : 1;
      // instant attack, exponential release
      env += (1 - env) * rel;
      if (env > 0.999999) env = 1;
      if (need < env) env = need;

      // sliding minimum of env over the last N samples
      while (qc > 0) {
        const t = (qh + qc - 1) % QN;
        if (qv[t] >= env) qc--;
        else break;
      }
      const t = (qh + qc) % QN;
      qv[t] = env;
      qi[t] = k;
      qc++;
      if (qi[qh] <= k - N) {
        qh = (qh + 1) % QN;
        qc--;
      }
      const m = qv[qh];

      // box average of the minimum over N samples
      sum += m - ring[ri];
      ring[ri] = m;
      if (++ri >= N) ri = 0;
      let g = sum / N;
      if (m === 1 && env === 1) {
        if (++calm > 2 * N) {
          g = 1;
          sum = N; // every entry is exactly 1 again: drop accumulated rounding
        }
      } else calm = 0;
      if (g > 1) g = 1;

      let yl = dl[w] * g;
      let yr = dr[w] * g;
      // safety net: rounding can never push a sample over full scale
      if (yl > 1) yl = 1;
      else if (yl < -1) yl = -1;
      if (yr > 1) yr = 1;
      else if (yr < -1) yr = -1;
      oL[i] = yl;
      if (oR) oR[i] = yr;
      dl[w] = l;
      dr[w] = r;
      if (++w >= d) w = 0;
      k++;
    }

    this.w = w;
    this.qh = qh;
    this.qc = qc;
    this.k = k;
    this.env = env;
    this.ri = ri;
    this.sum = sum;
    this.calm = calm;
    return true;
  }
}

registerProcessor('master-limiter', MasterLimiter);
