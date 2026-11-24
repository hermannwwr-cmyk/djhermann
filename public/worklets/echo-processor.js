/*
 * DJ Hermann: beat-synced echo (AudioWorklet, plain JavaScript, no imports).
 *
 * A stereo feedback delay with a darkening filter inside the loop:
 *
 *   in ─► × send ─► (+) ─► one-pole low-pass ─► delay line ─┬─► × level ─► out
 *                    ▲                                       │
 *                    └──────────────── × feedback ◄──────────┘
 *
 * Built as a worklet rather than from a DelayNode cycle because a cycle of nodes gets one extra
 * render quantum (128 frames) per pass in some browsers, so the repeats would drift off the beat.
 * Here every repeat is exactly `delay` seconds after the one before.
 *
 * AudioParams: send (a-rate, 0..1), delay (seconds, k-rate, glides with a 60 ms time constant like
 * tape), feedback, level, damp (Hz). The tail rings on after send goes to 0; once it has died away
 * (and nothing is being sent) the processor outputs silence without computing anything.
 *
 * processorOptions: { maxDelay: seconds }
 */
const T_DELAY_GLIDE = 0.06;
const SILENCE = 1e-6;

class EchoProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'send', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'delay', defaultValue: 0.369, minValue: 0.001, maxValue: 4, automationRate: 'k-rate' },
      { name: 'feedback', defaultValue: 0.55, minValue: 0, maxValue: 0.95, automationRate: 'k-rate' },
      { name: 'level', defaultValue: 0.65, minValue: 0, maxValue: 2, automationRate: 'k-rate' },
      { name: 'damp', defaultValue: 4200, minValue: 100, maxValue: 20000, automationRate: 'k-rate' },
    ];
  }

  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    const maxDelay = o.maxDelay > 0 ? o.maxDelay : 1.5;
    this.size = Math.ceil(maxDelay * sampleRate) + 8;
    this.bl = new Float32Array(this.size);
    this.br = new Float32Array(this.size);
    this.w = 0;
    this.d = -1; // current delay in frames (glides towards the parameter)
    this.lpl = 0;
    this.lpr = 0;
    this.kGlide = 1 - Math.exp(-1 / (T_DELAY_GLIDE * sampleRate));
    this.quiet = this.size; // frames of silence written into the line in a row
  }

  process(inputs, outputs, params) {
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const oL = out[0];
    const oR = out.length > 1 ? out[1] : null;
    const n = oL.length;
    const inp = inputs[0];
    const iL = inp && inp.length > 0 ? inp[0] : null;
    const iR = inp && inp.length > 1 ? inp[1] : iL;
    const send = params.send;
    const sendK = send.length === 1;

    // nothing sent and the line has fully decayed: silence for free
    let sending = false;
    if (iL) {
      if (sendK) sending = send[0] > 0;
      else for (let i = 0; i < n && !sending; i++) sending = send[i] > 0;
    }
    if (!sending && this.quiet >= this.size) {
      // outputs are zero-filled by the engine
      return true;
    }

    const target = Math.min(Math.max(params.delay[0] * sampleRate, 1), this.size - 4);
    if (this.d < 0) this.d = target;
    const fb = params.feedback[0];
    const level = params.level[0];
    const kLp = 1 - Math.exp((-2 * Math.PI * Math.min(params.damp[0], sampleRate * 0.45)) / sampleRate);
    const size = this.size;
    const bl = this.bl;
    const br = this.br;
    const kGlide = this.kGlide;
    let w = this.w;
    let d = this.d;
    let lpl = this.lpl;
    let lpr = this.lpr;
    let quiet = this.quiet;

    for (let i = 0; i < n; i++) {
      d += (target - d) * kGlide;
      // read the line `d` frames back (4-point Hermite)
      let rp = w - d;
      if (rp < 0) rp += size;
      const i1 = rp | 0;
      const f = rp - i1;
      const i0 = i1 === 0 ? size - 1 : i1 - 1;
      const i2 = i1 + 1 >= size ? i1 + 1 - size : i1 + 1;
      const i3 = i2 + 1 >= size ? i2 + 1 - size : i2 + 1;
      let a = bl[i0];
      let b = bl[i1];
      let c = bl[i2];
      let e = bl[i3];
      const yl = b + 0.5 * f * (c - a + f * (2 * a - 5 * b + 4 * c - e + f * (3 * (b - c) + e - a)));
      a = br[i0];
      b = br[i1];
      c = br[i2];
      e = br[i3];
      const yr = b + 0.5 * f * (c - a + f * (2 * a - 5 * b + 4 * c - e + f * (3 * (b - c) + e - a)));

      const s = sendK ? send[0] : send[i];
      const xl = iL ? iL[i] * s : 0;
      const xr = iL ? iR[i] * s : 0;
      lpl += (xl + yl * fb - lpl) * kLp;
      lpr += (xr + yr * fb - lpr) * kLp;
      // flush denormals and count how long the line has been silent
      if (lpl < SILENCE && lpl > -SILENCE && lpr < SILENCE && lpr > -SILENCE) {
        lpl = 0;
        lpr = 0;
        quiet++;
      } else quiet = 0;
      bl[w] = lpl;
      br[w] = lpr;
      if (++w >= size) w = 0;

      oL[i] = yl * level;
      if (oR) oR[i] = yr * level;
    }

    this.w = w;
    this.d = d;
    this.lpl = lpl;
    this.lpr = lpr;
    this.quiet = quiet;
    return true;
  }
}

registerProcessor('echo-processor', EchoProcessor);
