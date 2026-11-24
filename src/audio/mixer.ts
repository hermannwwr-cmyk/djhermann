/**
 * The mixer as a Web Audio node graph. Works on any BaseAudioContext, so the very same graph can
 * be rendered through an OfflineAudioContext and measured.
 *
 *   deck in ─► 3-band isolator EQ ─► filter (dry | low-pass | high-pass) ─► fader ─► crossfader ─┬─► bus
 *                                                                                               └─► echo (worklet) ─► bus
 *   one-shot sounds ───────────────────────────────────────────────────────────────────────────────► bus
 *   bus ─► master volume ─► look-ahead limiter ─► out
 *
 * EQ: Linkwitz-Riley crossovers at 250 Hz and 2.5 kHz. The three bands add back up to an all-pass
 * (flat magnitude) when their gains are equal, and a band at gain 0 is gone at 24 dB/octave.
 *
 * The echo and the limiter are AudioWorklets: call loadWorklets(ctx) before buildMixer(ctx).
 */
import { clamp, clamp01 } from '../core/math';
import { crossfaderGain, faderGain } from '../core/mixmath';
import type { DeckId, EqBand } from '../core/types';
import {
  ALLPASS_Q,
  BUTTERWORTH_Q_DB,
  ECHO_DAMP_HZ,
  ECHO_DEFAULT_SEC,
  ECHO_FEEDBACK,
  ECHO_LEVEL,
  ECHO_MAX_SEC,
  EQ_HIGH_HZ,
  EQ_LOW_HZ,
  LIMITER_CEILING,
  LIMITER_RELEASE_SEC,
  PARAM_SMOOTH_SEC,
  eqBandGain,
  filterSettings,
  limiterLookaheadFrames,
  masterVolumeGain,
} from './params';

/** Every worklet module the engine uses, relative to the app's base URL. */
export const WORKLET_MODULES = ['worklets/deck-processor.js', 'worklets/echo-processor.js', 'worklets/limiter-processor.js'] as const;

/** Load the worklet modules into a context (realtime or offline). */
export async function loadWorklets(ctx: BaseAudioContext, base: string = import.meta.env.BASE_URL): Promise<void> {
  await Promise.all(WORKLET_MODULES.map((m) => ctx.audioWorklet.addModule(`${base}${m}`)));
}

export interface MixerOptions {
  /**
   * Insert the look-ahead limiter (needs the 'master-limiter' worklet module to be loaded).
   * Without it the master volume feeds `out` directly.
   */
  limiter?: boolean;
  /** Apply parameter changes instantly instead of smoothing them (offline rendering, tests). */
  instant?: boolean;
}

interface Channel {
  input: GainNode;
  eq: Record<EqBand, GainNode>;
  dry: GainNode;
  lp: BiquadFilterNode;
  lpGain: GainNode;
  hp: BiquadFilterNode;
  hpGain: GainNode;
  fader: GainNode;
  xfade: GainNode;
  echo: AudioWorkletNode;
}

export interface Mixer {
  /** connect a deck's source here */
  readonly input: Record<DeckId, AudioNode>;
  /** post-fader, post-crossfader signal of a channel (for its level meter) */
  readonly channelOut: Record<DeckId, AudioNode>;
  /** connect one-shot sounds here */
  readonly soundIn: AudioNode;
  /** the summed mix before master volume and limiter (for the master meters) */
  readonly bus: AudioNode;
  /** final output: connect to the destination */
  readonly out: AudioNode;
  /** delay the mixer itself adds between `bus` and `out`, in seconds */
  readonly delaySec: number;
  /** number of AudioNodes this mixer created */
  readonly nodeCount: number;
  setEq(deck: DeckId, band: EqBand, value: number): void;
  setFilter(deck: DeckId, value: number): void;
  setFader(deck: DeckId, value: number): void;
  setCrossfader(value: number): void;
  setEcho(deck: DeckId, on: boolean): void;
  /** delay time of a channel's echo in seconds (3/4 beat of the deck's tempo) */
  setEchoTime(deck: DeckId, seconds: number): void;
  setMasterVolume(value: number): void;
  dispose(): void;
}

function echoParam(node: AudioWorkletNode, name: 'send' | 'delay' | 'feedback' | 'level' | 'damp'): AudioParam {
  return (node.parameters as unknown as Map<string, AudioParam>).get(name)!;
}

export function buildMixer(ctx: BaseAudioContext, opts: MixerOptions = {}): Mixer {
  const nodes: AudioNode[] = [];
  const instant = opts.instant === true;
  const sr = ctx.sampleRate;

  const gain = (value = 1): GainNode => {
    const g = ctx.createGain();
    g.gain.value = value;
    nodes.push(g);
    return g;
  };
  const biquad = (type: BiquadFilterType, hz: number, q: number): BiquadFilterNode => {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = Math.min(hz, sr * 0.49);
    f.Q.value = q;
    nodes.push(f);
    return f;
  };
  /** Glide a parameter to a value (never a step, so knob moves cannot zipper). */
  const set = (param: AudioParam, value: number, tc = PARAM_SMOOTH_SEC): void => {
    if (instant) {
      param.value = value;
      return;
    }
    const t = ctx.currentTime;
    try {
      param.cancelScheduledValues(t);
      param.setTargetAtTime(value, t, tc);
    } catch {
      param.value = value;
    }
  };

  const bus = gain(1);
  const master = gain(masterVolumeGain(1));
  bus.connect(master);
  let out: AudioNode = master;
  let delaySec = 0;
  if (opts.limiter) {
    const lookahead = limiterLookaheadFrames(sr);
    const limiter = new AudioWorkletNode(ctx, 'master-limiter', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { lookahead, ceiling: LIMITER_CEILING, release: LIMITER_RELEASE_SEC },
    });
    nodes.push(limiter);
    master.connect(limiter);
    out = limiter;
    delaySec = lookahead / sr;
  }
  const soundIn = gain(1);
  soundIn.connect(bus);

  let crossfader = -1;
  const state: Record<DeckId, { fader: number; filter: number }> = {
    A: { fader: 1, filter: 0 },
    B: { fader: 1, filter: 0 },
  };

  function channel(id: DeckId): Channel {
    const input = gain(1);

    // ── isolator EQ ──
    // low  = LR4 low-pass(250)  → all-pass(2.5k)  (the all-pass keeps it in phase with mid + high)
    // rest = LR4 high-pass(250) → mid = LR4 low-pass(2.5k), high = LR4 high-pass(2.5k)
    const low1 = biquad('lowpass', EQ_LOW_HZ, BUTTERWORTH_Q_DB);
    const low2 = biquad('lowpass', EQ_LOW_HZ, BUTTERWORTH_Q_DB);
    const lowAp = biquad('allpass', EQ_HIGH_HZ, ALLPASS_Q);
    const rest1 = biquad('highpass', EQ_LOW_HZ, BUTTERWORTH_Q_DB);
    const rest2 = biquad('highpass', EQ_LOW_HZ, BUTTERWORTH_Q_DB);
    const mid1 = biquad('lowpass', EQ_HIGH_HZ, BUTTERWORTH_Q_DB);
    const mid2 = biquad('lowpass', EQ_HIGH_HZ, BUTTERWORTH_Q_DB);
    const high1 = biquad('highpass', EQ_HIGH_HZ, BUTTERWORTH_Q_DB);
    const high2 = biquad('highpass', EQ_HIGH_HZ, BUTTERWORTH_Q_DB);
    const eq: Record<EqBand, GainNode> = { low: gain(1), mid: gain(1), high: gain(1) };
    const eqOut = gain(1);
    input.connect(low1).connect(low2).connect(lowAp).connect(eq.low).connect(eqOut);
    input.connect(rest1).connect(rest2);
    rest2.connect(mid1).connect(mid2).connect(eq.mid).connect(eqOut);
    rest2.connect(high1).connect(high2).connect(eq.high).connect(eqOut);

    // ── filter: three parallel paths, only the dry one is open at the centre ──
    const f0 = filterSettings(0, sr);
    const dry = gain(1);
    const lp = biquad('lowpass', f0.lpHz, f0.qDb);
    const lpGain = gain(0);
    const hp = biquad('highpass', f0.hpHz, f0.qDb);
    const hpGain = gain(0);
    const filterOut = gain(1);
    eqOut.connect(dry).connect(filterOut);
    eqOut.connect(lp).connect(lpGain).connect(filterOut);
    eqOut.connect(hp).connect(hpGain).connect(filterOut);

    // ── fader, crossfader ──
    const fader = gain(faderGain(1));
    const xfade = gain(crossfaderGain(id, crossfader));
    filterOut.connect(fader).connect(xfade).connect(bus);

    // ── echo: post-fader send into a damped feedback delay that returns straight to the bus, so
    //    the tail rings on after the send, the fader or the deck stops ──
    const echo = new AudioWorkletNode(ctx, 'echo-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { maxDelay: ECHO_MAX_SEC },
    });
    nodes.push(echo);
    echoParam(echo, 'delay').value = ECHO_DEFAULT_SEC;
    echoParam(echo, 'feedback').value = ECHO_FEEDBACK;
    echoParam(echo, 'level').value = ECHO_LEVEL;
    echoParam(echo, 'damp').value = ECHO_DAMP_HZ;
    echoParam(echo, 'send').value = 0;
    xfade.connect(echo).connect(bus);

    return { input, eq, dry, lp, lpGain, hp, hpGain, fader, xfade, echo };
  }

  const ch: Record<DeckId, Channel> = { A: channel('A'), B: channel('B') };

  return {
    input: { A: ch.A.input, B: ch.B.input },
    channelOut: { A: ch.A.xfade, B: ch.B.xfade },
    soundIn,
    bus,
    out,
    delaySec,
    nodeCount: nodes.length,

    setEq(deck, band, value) {
      set(ch[deck].eq[band].gain, eqBandGain(value));
    },
    setFilter(deck, value) {
      const c = ch[deck];
      const prev = filterSettings(state[deck].filter, sr);
      const f = filterSettings(value, sr);
      state[deck].filter = clamp(value, -1, 1);
      set(c.dry.gain, f.dry);
      set(c.lpGain.gain, f.lp);
      set(c.hpGain.gain, f.hp);
      // a path that was closed may move its cutoff at once; an open one glides
      if (instant || prev.lp === 0) c.lp.frequency.value = f.lpHz;
      else set(c.lp.frequency, f.lpHz, PARAM_SMOOTH_SEC * 1.5);
      if (instant || prev.hp === 0) c.hp.frequency.value = f.hpHz;
      else set(c.hp.frequency, f.hpHz, PARAM_SMOOTH_SEC * 1.5);
      if (f.lp > 0 || instant) set(c.lp.Q, f.qDb);
      if (f.hp > 0 || instant) set(c.hp.Q, f.qDb);
    },
    setFader(deck, value) {
      state[deck].fader = clamp01(value);
      set(ch[deck].fader.gain, faderGain(value));
    },
    setCrossfader(value) {
      crossfader = clamp(value, -1, 1);
      set(ch.A.xfade.gain, crossfaderGain('A', crossfader));
      set(ch.B.xfade.gain, crossfaderGain('B', crossfader));
    },
    setEcho(deck, on) {
      set(echoParam(ch[deck].echo, 'send'), on ? 1 : 0, 0.004);
    },
    setEchoTime(deck, seconds) {
      // the worklet glides to a new delay time by itself
      echoParam(ch[deck].echo, 'delay').value = clamp(seconds, 0.02, ECHO_MAX_SEC - 0.02);
    },
    setMasterVolume(value) {
      set(master.gain, masterVolumeGain(value), 0.015);
    },
    dispose() {
      for (const n of nodes) {
        try {
          n.disconnect();
        } catch {
          /* already gone */
        }
      }
      nodes.length = 0;
    },
  };
}
