/*
 * DJ Hermann: deck playback processor (AudioWorklet, plain JavaScript, no imports).
 *
 * One instance per deck. It holds the track as 16-bit PCM and plays it at a variable rate like a
 * record on a platter:
 *   - 16-tap Kaiser-windowed sinc interpolation (an interpolating kernel: exact on whole frames),
 *     forwards and backwards; at exactly native speed the playhead locks onto whole frames and the
 *     output is a bit-exact copy of the source;
 *   - a motor: spin-up in ~50 ms, brake in ~150 ms (linear ramps of the rate, so the pitch drops
 *     like a stopping record);
 *   - tempo and pitch bend, both smoothed;
 *   - scratching: the main thread sends the hand's movement as (delta, dt) segments, the processor
 *     rebuilds a continuous hand trajectory from them and a critically damped follower makes the
 *     playhead chase it;
 *   - click-free everywhere: amplitude follows |rate| near standstill (a stopped record is silent),
 *     jumps are cross-faded against a "ghost" playhead, track ends are tapered.
 *
 * Messages in (object, `at` = optional context frame to apply it at, `q` = sequence number):
 *   load {gen, ch:[Int16Array..], len, sr, pos, tempo, nudge}   eject {gen}
 *   play {anchor?}      pause      stopAt {pos}      seek {pos}
 *   syncTo {frame, pos, tempo}     tempo {v, now?}   nudge {v}
 *   scratchStart        scratchMove {d, dt}          scratchEnd
 *   ping {id}
 * Messages out (arrays):
 *   [0, gen, seq, frame, posSec, rate, flag]   report: the sample at context frame `frame` is read
 *                                              from track position posSec, moving at `rate`.
 *                                              flag 1 = jump before this report, 2 = silent jump
 *   [1, gen]                                   ran off the end while the motor was on
 *   [2, id, frame]                             pong
 */

const TAPS = 16;
const HALF = 8;
const PHASES = 256;
const KAISER_BETA = 7.5;
const NUDGE_AMOUNT = 0.035; // must match core/types.ts
const SCALE = 1 / 32768;

const T_SPIN_UP = 0.05; // seconds from 0 to rate 1
const T_BRAKE = 0.15; // seconds from rate 1 to 0
const T_XFADE = 0.005; // jump cross-fade
const T_EDGE = 0.002; // taper at both ends of the track
const RATE_GATE = 0.06; // below this |rate| the output fades to silence
const T_TEMPO = 0.012; // tempo smoothing time constant
const T_NUDGE = 0.02; // pitch-bend smoothing time constant
const SCRATCH_W = 160; // follower natural frequency, rad/s (lag ≈ 2/W = 12.5 ms)
const SCRATCH_CUSHION = 0.012; // playout delay of the hand trajectory
const SCRATCH_HMAX = 0.07; // never run further behind the hand than this
const SCRATCH_MAX_RATE = 32;
const UNITY_SLIDE = 1e-4; // frames per sample used to pull the playhead onto whole frames
const REPORT_BLOCKS = 3; // 384 frames
const MAX_GHOSTS = 4;
const MAX_ADVANCE = 1.0; // seconds: sanity cap for press-time alignment

function bessI0(x) {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 40; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

/** (PHASES + 1) rows of TAPS coefficients; row p is the kernel for a fraction of p / PHASES. */
const KERNEL = (() => {
  const k = new Float64Array((PHASES + 2) * TAPS);
  const norm = bessI0(KAISER_BETA);
  for (let p = 0; p <= PHASES; p++) {
    const frac = p / PHASES;
    let sum = 0;
    for (let t = 0; t < TAPS; t++) {
      const x = t - (HALF - 1) - frac;
      const r = x / HALF;
      const w = r * r >= 1 ? 0 : bessI0(KAISER_BETA * Math.sqrt(1 - r * r)) / norm;
      const s = Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      k[p * TAPS + t] = s * w;
      sum += s * w;
    }
    for (let t = 0; t < TAPS; t++) k[p * TAPS + t] /= sum;
  }
  return k;
})();

/** Band-limited read of channel data `d` at frame i0 + fr (0 <= fr < 1). Outside the track is silence. */
function interp(d, len, i0, fr) {
  if (fr === 0) return i0 >= 0 && i0 < len ? d[i0] : 0;
  const ph = fr * PHASES;
  const p = ph | 0;
  const a = ph - p;
  let o = p * TAPS;
  let i = i0 - (HALF - 1);
  let s = 0;
  if (i >= 0 && i + TAPS <= len) {
    for (let t = 0; t < TAPS; t++, o++, i++) {
      const c = KERNEL[o];
      s += d[i] * (c + a * (KERNEL[o + TAPS] - c));
    }
  } else {
    for (let t = 0; t < TAPS; t++, o++, i++) {
      if (i >= 0 && i < len) {
        const c = KERNEL[o];
        s += d[i] * (c + a * (KERNEL[o + TAPS] - c));
      }
    }
  }
  return s;
}

class DeckProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = null; // { c0, c1, len, sr, ratio, edge }
    this.gen = 0;
    this.seq = 0;
    this.pos = 0; // source frames
    this.rate = 0; // 1 = native speed
    this.running = false;
    this.tempo = 1;
    this.tempoSm = 1;
    this.nudge = 0;
    this.nudgeSm = 0;
    this.mainGain = 1;
    this.scratch = false;
    this.vel = 0; // source frames per output sample (scratch follower)
    this.tgt = 0;
    this.tgtEnd = 0;
    this.tgtVel = 0;
    this.horizon = 0;
    this.ghosts = [];
    this.queue = []; // commands waiting for their `at` frame
    this.pendingNow = []; // commands to apply at the start of the next block
    this.startAt = -1; // pending anchored start (context frame)
    this.blocks = 0;
    this.dirty = false;

    this.accUp = 1 / (T_SPIN_UP * sampleRate);
    this.accBrake = 1 / (T_BRAKE * sampleRate);
    this.xfStep = 1 / Math.max(8, Math.round(T_XFADE * sampleRate));
    this.kTempo = 1 - Math.exp(-128 / (T_TEMPO * sampleRate));
    this.kNudge = 1 - Math.exp(-128 / (T_NUDGE * sampleRate));
    this.w = SCRATCH_W / sampleRate;

    this.port.onmessage = (e) => {
      const m = e.data;
      if (!m || typeof m !== 'object') return;
      if (typeof m.at === 'number' && m.at > currentFrame) this.queue.push(m);
      else this.pendingNow.push(m);
    };
  }

  // ───────────────────────── helpers ─────────────────────────

  report(frame, flag) {
    const b = this.buf;
    this.port.postMessage([0, this.gen, this.seq, frame, b ? this.pos / b.sr : 0, b ? this.rate : 0, flag]);
  }

  audible() {
    return this.buf !== null && this.rate !== 0 && this.mainGain > 0;
  }

  gate(rate) {
    const a = rate < 0 ? -rate : rate;
    if (a >= RATE_GATE) return 1;
    const x = a / RATE_GATE;
    return x * x * (3 - 2 * x);
  }

  /** Let what is sounding now fade out on its own playhead, so the main playhead may jump. */
  spawnGhost() {
    if (!this.audible()) return;
    const b = this.buf;
    const g = this.gate(this.rate) * this.mainGain;
    if (g <= 0) return;
    if (this.ghosts.length >= MAX_GHOSTS) this.ghosts.shift();
    this.ghosts.push({ buf: b, pos: this.pos, inc: this.rate * b.ratio, gain: g, step: g * this.xfStep });
    this.mainGain = 0;
  }

  /** Move the playhead to `pos` (source frames) without a click. Emits the report pair. */
  jump(frame, pos) {
    const b = this.buf;
    if (!b) return;
    const wasAudible = this.audible();
    if (wasAudible) {
      this.report(frame, 0);
      this.spawnGhost();
    }
    this.pos = pos < 0 ? 0 : pos > b.len - 1 ? b.len - 1 : pos;
    if (this.scratch) {
      this.tgt = this.tgtEnd = this.pos + this.vel / this.w;
      this.tgtVel = 0;
      this.horizon = 0;
    }
    this.report(frame, wasAudible ? 1 : 2);
  }

  baseTarget() {
    return this.tempo * (1 + this.nudge * NUDGE_AMOUNT);
  }

  startMotor(frame, anchor) {
    const b = this.buf;
    this.running = true;
    this.startAt = -1;
    if (!b || this.scratch || typeof anchor !== 'number' || !isFinite(anchor)) return;
    // Press-time alignment: behave as if the motor had been started at context frame `anchor`
    // and had been at full speed ever since.
    let elapsed = (frame - anchor) / sampleRate;
    if (elapsed < 0) elapsed = 0;
    if (elapsed > MAX_ADVANCE) elapsed = MAX_ADVANCE;
    this.tempoSm = this.tempo;
    this.nudgeSm = this.nudge;
    const target = this.baseTarget();
    const d = target - this.rate;
    if (d <= 0) return;
    const adv = d * elapsed + d * d * T_SPIN_UP * 0.5; // track seconds: time lost so far + lost in the ramp
    let pos = this.pos + adv * b.sr;
    if (this.rate === 0 && target * b.ratio === 1) pos = Math.round(pos);
    if (pos > b.len - 1) pos = b.len - 1;
    this.jump(frame, pos);
  }

  apply(m, frame) {
    if (typeof m.q === 'number') this.seq = m.q;
    const b = this.buf;
    switch (m.t) {
      case 'load': {
        if (this.audible()) {
          this.report(frame, 0);
          this.spawnGhost();
        }
        const c0 = m.ch[0];
        const c1 = m.ch.length > 1 ? m.ch[1] : m.ch[0];
        const sr = m.sr > 0 ? m.sr : sampleRate;
        const len = Math.min(m.len, c0.length, c1.length);
        this.buf = len > 0 ? { c0, c1, len, sr, ratio: sr / sampleRate, edge: Math.max(8, T_EDGE * sr) } : null;
        this.gen = m.gen;
        this.pos = this.buf ? Math.min(Math.max(0, m.pos * sr), len - 1) : 0;
        this.rate = 0;
        this.vel = 0;
        this.running = false;
        this.scratch = false;
        this.startAt = -1;
        this.mainGain = 1;
        this.tempo = this.tempoSm = typeof m.tempo === 'number' ? m.tempo : 1;
        this.nudge = this.nudgeSm = typeof m.nudge === 'number' ? m.nudge : 0;
        this.report(frame, 2);
        break;
      }
      case 'eject': {
        if (this.audible()) {
          this.report(frame, 0);
          this.spawnGhost();
        }
        this.buf = null;
        this.gen = m.gen;
        this.pos = 0;
        this.rate = 0;
        this.vel = 0;
        this.running = false;
        this.scratch = false;
        this.startAt = -1;
        this.mainGain = 1;
        this.report(frame, 2);
        break;
      }
      case 'play': {
        if (typeof m.anchor === 'number' && m.anchor > frame && m.anchor - frame < 0.25 * sampleRate) {
          this.startAt = m.anchor; // the press maps to a frame that has not been rendered yet: wait for it
        } else {
          this.startMotor(frame, m.anchor);
        }
        break;
      }
      case 'pause':
        this.running = false;
        this.startAt = -1;
        break;
      case 'stopAt': {
        // CUE: stop dead and return to the cue point
        this.running = false;
        this.startAt = -1;
        if (!b) break;
        const wasAudible = this.audible();
        if (wasAudible) {
          this.report(frame, 0);
          this.spawnGhost();
        }
        this.rate = 0;
        this.vel = 0;
        this.mainGain = 1;
        this.pos = Math.min(Math.max(0, m.pos * b.sr), b.len - 1);
        if (this.scratch) {
          this.tgt = this.tgtEnd = this.pos;
          this.tgtVel = 0;
          this.horizon = 0;
        }
        this.report(frame, wasAudible ? 1 : 2);
        break;
      }
      case 'seek':
        if (b) this.jump(frame, m.pos * b.sr);
        break;
      case 'syncTo': {
        if (typeof m.tempo === 'number') this.tempo = this.tempoSm = m.tempo;
        if (b && typeof m.pos === 'number') {
          const rate = this.baseTarget();
          const pos = (m.pos + ((frame - m.frame) / sampleRate) * rate) * b.sr;
          if (pos >= 0 && pos < b.len - 1) this.jump(frame, pos);
        }
        break;
      }
      case 'tempo':
        this.tempo = m.v;
        if (m.now) this.tempoSm = m.v;
        break;
      case 'nudge':
        this.nudge = m.v;
        break;
      case 'scratchStart':
        if (b && !this.scratch) {
          this.scratch = true;
          this.vel = this.rate * b.ratio;
          // put the grab point just far enough ahead that the follower stops without swinging back
          this.tgt = this.tgtEnd = Math.min(Math.max(0, this.pos + this.vel / this.w), b.len - 1);
          this.tgtVel = 0;
          this.horizon = 0;
        }
        break;
      case 'scratchMove':
        if (b && this.scratch) {
          let end = this.tgtEnd + m.d * b.sr;
          end = end < 0 ? 0 : end > b.len - 1 ? b.len - 1 : end;
          this.tgtEnd = end;
          const h = Math.max(0, m.dt) * sampleRate;
          if (this.horizon <= 0) this.horizon = SCRATCH_CUSHION * sampleRate + h;
          else this.horizon = Math.min(this.horizon + h, SCRATCH_HMAX * sampleRate);
          if (this.horizon < 1) this.horizon = 1;
          this.tgtVel = (this.tgtEnd - this.tgt) / this.horizon;
        }
        break;
      case 'scratchEnd':
        if (this.scratch) {
          this.scratch = false;
          this.rate = b ? this.vel / b.ratio : 0;
          this.vel = 0;
          this.horizon = 0;
        }
        break;
      case 'ping':
        this.port.postMessage([2, m.id, frame]);
        break;
      default:
        break;
    }
  }

  runCommands(frame) {
    let ran = false;
    if (this.pendingNow.length) {
      const list = this.pendingNow;
      this.pendingNow = [];
      for (let i = 0; i < list.length; i++) this.apply(list[i], frame);
      ran = true;
    }
    if (this.queue.length) {
      let keep = null;
      for (let i = 0; i < this.queue.length; i++) {
        const m = this.queue[i];
        if (m.at <= frame) {
          this.apply(m, frame);
          ran = true;
        } else (keep || (keep = [])).push(m);
      }
      this.queue = keep || [];
    }
    if (this.startAt >= 0 && frame >= this.startAt) {
      this.startMotor(frame, this.startAt);
      ran = true;
    }
    return ran;
  }

  renderGhosts(L, R, n) {
    const ghosts = this.ghosts;
    for (let k = ghosts.length - 1; k >= 0; k--) {
      const g = ghosts[k];
      const b = g.buf;
      const last = b.len - 1;
      let pos = g.pos;
      let gain = g.gain;
      for (let i = 0; i < n && gain > 0; i++) {
        let e = pos < last - pos ? pos : last - pos;
        e = e >= b.edge ? 1 : e <= 0 ? 0 : e / b.edge;
        if (e > 0) {
          const i0 = Math.floor(pos);
          const fr = pos - i0;
          const a = gain * e * SCALE;
          L[i] += interp(b.c0, b.len, i0, fr) * a;
          R[i] += interp(b.c1, b.len, i0, fr) * a;
        }
        pos += g.inc;
        gain -= g.step;
      }
      if (gain <= 0) ghosts.splice(k, 1);
      else {
        g.pos = pos;
        g.gain = gain;
      }
    }
  }

  // ───────────────────────── render ─────────────────────────

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const L = out[0];
    const R = out.length > 1 ? out[1] : out[0];
    const n = L.length;
    const frame = currentFrame;

    const ran = this.runCommands(frame);
    if (ran && !this.dirty) this.report(frame, 0);
    this.dirty = false;

    const b = this.buf;
    let ended = false;
    if (b) {
      // block-rate smoothing of tempo and pitch bend; the motor's slew limit makes it sample-smooth
      let d = this.tempo - this.tempoSm;
      this.tempoSm = d < 1e-7 && d > -1e-7 ? this.tempo : this.tempoSm + d * this.kTempo;
      d = this.nudge - this.nudgeSm;
      this.nudgeSm = d < 1e-6 && d > -1e-6 ? this.nudge : this.nudgeSm + d * this.kNudge;
      const base = this.tempoSm * (1 + this.nudgeSm * NUDGE_AMOUNT);

      const c0 = b.c0;
      const c1 = b.c1;
      const len = b.len;
      const last = len - 1;
      const ratio = b.ratio;
      const edge = b.edge;
      let pos = this.pos;
      let rate = this.rate;
      let mg = this.mainGain;
      const mgStep = this.xfStep;

      if (this.scratch) {
        // ── hand on the record: rebuild the hand's path, let the playhead chase it ──
        const w = this.w;
        const w2 = w * w;
        const maxVel = SCRATCH_MAX_RATE * ratio;
        let vel = this.vel;
        let tgt = this.tgt;
        let tgtVel = this.tgtVel;
        let horizon = this.horizon;
        const tgtEnd = this.tgtEnd;
        const resting = horizon <= 0 && vel === 0 && pos === tgt;
        if (!resting) {
          for (let i = 0; i < n; i++) {
            const a = vel < 0 ? -vel / ratio : vel / ratio;
            let g = 1;
            if (a < RATE_GATE) {
              const x = a / RATE_GATE;
              g = x * x * (3 - 2 * x);
            }
            let e = pos < last - pos ? pos : last - pos;
            if (e < edge) g *= e <= 0 ? 0 : e / edge;
            if (mg < 1) {
              g *= mg;
              mg += mgStep;
              if (mg > 1) mg = 1;
            }
            if (g > 0) {
              const i0 = Math.floor(pos);
              const fr = pos - i0;
              g *= SCALE;
              L[i] = interp(c0, len, i0, fr) * g;
              R[i] = c1 === c0 ? L[i] : interp(c1, len, i0, fr) * g;
            }
            if (horizon > 0) {
              tgt += tgtVel;
              horizon -= 1;
              if (horizon <= 0) {
                tgt = tgtEnd;
                tgtVel = 0;
                horizon = 0;
              }
            }
            vel += w2 * (tgt - pos) - 2 * w * vel;
            if (vel > maxVel) vel = maxVel;
            else if (vel < -maxVel) vel = -maxVel;
            pos += vel;
            if (pos <= 0) {
              pos = 0;
              if (vel < 0) vel = 0;
            } else if (pos >= last) {
              pos = last;
              if (vel > 0) vel = 0;
            }
          }
          // settle exactly, so a still hand is exact silence and costs nothing
          if (horizon <= 0) {
            const err = tgt - pos;
            if (vel < 1e-7 && vel > -1e-7 && err < 1e-3 && err > -1e-3) {
              vel = 0;
              pos = tgt;
            }
          }
          this.vel = vel;
          this.tgt = tgt;
          this.tgtVel = tgtVel;
          this.horizon = horizon;
          rate = vel / ratio;
        }
      } else {
        // ── motor ──
        let target = this.running ? base : 0;
        let step = this.running ? this.accUp : this.accBrake;
        if (rate === 0 && target === 0) {
          // parked: silence
        } else if (
          rate === target &&
          rate * ratio === 1 &&
          mg === 1 &&
          pos === Math.floor(pos) &&
          pos >= edge &&
          pos + n < last - edge
        ) {
          // locked at native speed on whole frames: a straight copy
          const p = pos;
          for (let i = 0; i < n; i++) {
            L[i] = c0[p + i] * SCALE;
            R[i] = c1[p + i] * SCALE;
          }
          pos += n;
        } else {
          for (let i = 0; i < n; i++) {
            const dr = target - rate;
            rate = dr > step ? rate + step : dr < -step ? rate - step : target;
            const a = rate < 0 ? -rate : rate;
            let g = 1;
            if (a < RATE_GATE) {
              const x = a / RATE_GATE;
              g = x * x * (3 - 2 * x);
            }
            const e = pos < last - pos ? pos : last - pos;
            if (e < edge) g *= e <= 0 ? 0 : e / edge;
            if (mg < 1) {
              g *= mg;
              mg += mgStep;
              if (mg > 1) mg = 1;
            }
            if (g > 0) {
              const i0 = Math.floor(pos);
              const fr = pos - i0;
              g *= SCALE;
              L[i] = interp(c0, len, i0, fr) * g;
              R[i] = c1 === c0 ? L[i] : interp(c1, len, i0, fr) * g;
            }
            const inc = rate * ratio;
            pos += inc;
            if (inc === 1 && rate === target) {
              // native speed: slide the playhead onto whole frames (100 ppm, inaudible)
              const fr = pos - Math.floor(pos);
              if (fr !== 0) {
                if (fr < 0.5) pos = fr <= UNITY_SLIDE ? Math.floor(pos) : pos - UNITY_SLIDE;
                else pos = 1 - fr <= UNITY_SLIDE ? Math.floor(pos) + 1 : pos + UNITY_SLIDE;
              }
            }
            if (pos >= last) {
              pos = last;
              if (rate > 0) rate = 0;
              if (this.running) {
                this.running = false;
                ended = true;
              }
              target = 0;
              step = this.accBrake;
            } else if (pos < 0) {
              pos = 0;
              if (rate < 0) rate = 0;
            }
          }
        }
      }
      this.pos = pos;
      this.rate = rate;
      this.mainGain = mg;
    }

    if (this.ghosts.length) this.renderGhosts(L, R, n);

    if (ended) {
      this.report(frame + n, 0);
      this.port.postMessage([1, this.gen]);
      this.dirty = true;
      this.blocks = 0;
    } else if (++this.blocks >= REPORT_BLOCKS) {
      this.blocks = 0;
      this.report(frame + n, 0);
      this.dirty = true;
    }
    return true;
  }
}

registerProcessor('deck-processor', DeckProcessor);
