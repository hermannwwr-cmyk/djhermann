/**
 * The real Web Audio engine.
 *
 *   deck worklet ─► mixer (EQ ─► filter ─► fader ─► crossfader, echo) ─► master ─► limiter ─► out
 *
 * Who owns what:
 * - Transport state (playing, cue, tempo, …) lives here on the main thread and changes
 *   synchronously with every call, exactly like the mock engine.
 * - Playheads live in the deck worklets. They report (context frame, position, rate) every 384
 *   frames; a short history of those reports is interpolated to answer "where was the playhead at
 *   context time T", which with T = perfToCtx(now) - latency is the position as heard.
 * - The clock (clock.ts) maps performance.now() to context time without jitter.
 */
import { beatAtSec } from '../core/beatgrid';
import { Emitter } from '../core/events';
import { clamp, clamp01, fract } from '../core/math';
import { channelGain } from '../core/mixmath';
import { NUDGE_AMOUNT, TEMPO_MAX, TEMPO_MIN, otherDeck } from '../core/types';
import type {
  AudioEngine,
  ChannelSnapshot,
  DeckId,
  DeckSnapshot,
  EngineEvents,
  EqBand,
  LoadedTrack,
  MixerSnapshot,
  PcmData,
  PlaySoundOptions,
} from '../core/types';
import { ClockSync } from './clock';
import { ReportHistory } from './history';
import type { HistorySample } from './history';
import { BAND_SCALE, analyseBlock, ballistic, bandToUnit, blockPeak } from './meters';
import type { BlockLevels } from './meters';
import { buildMixer } from './mixer';
import type { Mixer } from './mixer';
import { detectPlatform, echoDelaySec, estimateLatencySec, limiterLookaheadFrames } from './params';
import { createUnmute } from './unmute';

export { buildMixer } from './mixer';
export type { Mixer, MixerOptions } from './mixer';

const DECKS: readonly DeckId[] = ['A', 'B'];
const METER_FFT = 1024;
const MAX_VOICES = 32;
/** samples copied per step when a track is handed to its worklet (keeps the main thread responsive) */
const COPY_CHUNK = 1 << 20;

/** Diagnostics for the dev harness and tests. Not part of the game's contract. */
export interface AudioEngineDebug {
  readonly ctx: AudioContext;
  /** the node that feeds ctx.destination (null until the graph is built) */
  output(): AudioNode | null;
  mixer(): Mixer | null;
  /** resolves when the worklets are loaded and the graph is built */
  ready(): Promise<void>;
  /** the worklet's own playhead right now (not latency compensated) */
  rawPosition(deck: DeckId): number;
  stats(): {
    state: string;
    graphNodes: number;
    voices: number;
    reports: number;
    historySize: Record<DeckId, number>;
    clockLocked: boolean;
    clockUsesTimestamps: boolean;
    measuredOutputLatencyMs: number | null;
    outputLatencyMs: number | null;
    baseLatencyMs: number | null;
    limiterDelayMs: number;
  };
}

export interface RealAudioEngine extends AudioEngine {
  readonly debug: AudioEngineDebug;
}

interface Deck {
  id: DeckId;
  node: AudioWorkletNode | null;
  loaded: LoadedTrack | null;
  playing: boolean;
  scratching: boolean;
  cuePreview: boolean;
  tempo: number;
  nudge: number;
  synced: boolean;
  cueSec: number;
  durationSec: number;
  /** bumped on every load / eject; reports of an older generation are ignored */
  gen: number;
  /** bumped on every loadTrack / eject call, to drop a load that was overtaken */
  loadToken: number;
  /** messages waiting for the graph, or for a load in progress */
  held: { msg: Record<string, unknown>; transfer?: Transferable[] }[];
  loading: boolean;
  seq: number;
  /** reports older than this sequence number describe a playhead that has since been moved */
  minSeq: number;
  /** where the playhead is parked, used until the worklet's first report arrives */
  parkPos: number;
  history: ReportHistory;
  lastMoveMs: number;
  level: number;
}

interface Voice {
  src: AudioBufferSourceNode;
  gain: GainNode;
}

const newChannel = (): ChannelSnapshot => ({ eq: { low: 0.5, mid: 0.5, high: 0.5 }, filter: 0, fader: 1, echo: false });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Yield to the event loop without the 4 ms / background clamp of setTimeout. */
function yieldTask(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof MessageChannel === 'undefined') {
      setTimeout(resolve, 0);
      return;
    }
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      resolve();
    };
    ch.port2.postMessage(0);
  });
}

/** A private copy of a channel, made in slices so a long track does not freeze a frame. */
async function copyChannel(src: Int16Array): Promise<Int16Array> {
  if (src.length <= COPY_CHUNK) return src.slice();
  const out = new Int16Array(src.length);
  for (let i = 0; i < src.length; i += COPY_CHUNK) {
    out.set(src.subarray(i, Math.min(src.length, i + COPY_CHUNK)), i);
    await yieldTask();
  }
  return out;
}

export function createAudioEngine(): AudioEngine {
  const AC: typeof AudioContext =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AC({ latencyHint: 'interactive' });
  const sr = ctx.sampleRate;
  const events = new Emitter<EngineEvents>();
  const clock = new ClockSync();
  const platform = detectPlatform(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);
  const unmute = createUnmute(platform);

  const newDeck = (id: DeckId): Deck => ({
    id,
    node: null,
    loaded: null,
    playing: false,
    scratching: false,
    cuePreview: false,
    tempo: 1,
    nudge: 0,
    synced: false,
    cueSec: 0,
    durationSec: 0,
    gen: 0,
    loadToken: 0,
    held: [],
    loading: false,
    seq: 0,
    minSeq: 0,
    parkPos: 0,
    history: new ReportHistory(),
    lastMoveMs: 0,
    level: 0,
  });
  const decks: Record<DeckId, Deck> = { A: newDeck('A'), B: newDeck('B') };
  const channels: Record<DeckId, ChannelSnapshot> = { A: newChannel(), B: newChannel() };
  let crossfader = -1;
  let masterVolume = 1;

  let mixer: Mixer | null = null;
  let analysers: { A: AnalyserNode; B: AnalyserNode; bus: AnalyserNode } | null = null;
  const meterNodes: AudioNode[] = [];
  const meterBuf = new Float32Array(METER_FFT);
  const levels: BlockLevels = { peak: 0, low: 0, mid: 0, high: 0 };
  let masterLevel = 0;
  const bands: Record<EqBand, number> = { low: 0, mid: 0, high: 0 };
  let meterToken = -1;
  let meterMs = 0;

  const sounds = new Map<string, AudioBuffer>();
  const voices = new Set<Voice>();

  let unlocked = false;
  let userSuspended = false;
  let destroyed = false;
  let latencyOverrideMs: number | null = null;
  let reportCount = 0;

  // ───────────────────────────── graph ─────────────────────────────

  const base = import.meta.env.BASE_URL;
  const ready: Promise<void> = (async () => {
    if (!ctx.audioWorklet) throw new Error('AudioWorklet is not available in this browser');
    await Promise.all([
      ctx.audioWorklet.addModule(`${base}worklets/deck-processor.js`),
      ctx.audioWorklet.addModule(`${base}worklets/limiter-processor.js`),
    ]);
    if (destroyed) return;
    buildGraph();
  })();
  ready.catch((err) => console.error('[audio] the audio graph could not be built', err));

  function buildGraph(): void {
    const m = buildMixer(ctx, { limiter: true });
    m.out.connect(ctx.destination);
    // restore whatever was set before the graph existed
    for (const id of DECKS) {
      const c = channels[id];
      m.setEq(id, 'low', c.eq.low);
      m.setEq(id, 'mid', c.eq.mid);
      m.setEq(id, 'high', c.eq.high);
      m.setFilter(id, c.filter);
      m.setFader(id, c.fader);
      m.setEcho(id, c.echo);
      m.setEchoTime(id, echoDelaySec(bpmOf(decks[id])));
    }
    m.setCrossfader(crossfader);
    m.setMasterVolume(masterVolume);

    // meters: analysers are read on demand; a muted sink keeps them pulled in every browser
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);
    meterNodes.push(sink);
    const analyser = (src: AudioNode): AnalyserNode => {
      const a = ctx.createAnalyser();
      a.fftSize = METER_FFT;
      a.smoothingTimeConstant = 0;
      src.connect(a);
      a.connect(sink);
      meterNodes.push(a);
      return a;
    };
    analysers = { A: analyser(m.channelOut.A), B: analyser(m.channelOut.B), bus: analyser(m.bus) };

    for (const id of DECKS) {
      const d = decks[id];
      const node = new AudioWorkletNode(ctx, 'deck-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      node.port.onmessage = (e: MessageEvent) => onDeckMessage(d, e.data as number[]);
      node.connect(m.input[id]);
      d.node = node;
    }
    mixer = m;
    for (const id of DECKS) flush(decks[id]);
  }

  // ───────────────────────────── worklet messaging ─────────────────────────────

  /** Send a command to a deck's worklet. Returns its sequence number. */
  function post(d: Deck, msg: Record<string, unknown>, transfer?: Transferable[]): number {
    const q = ++d.seq;
    if (destroyed) return q;
    msg.q = q;
    if (!d.node || d.loading || d.held.length) d.held.push({ msg, transfer });
    else send(d, msg, transfer);
    return q;
  }

  function send(d: Deck, msg: Record<string, unknown>, transfer?: Transferable[]): void {
    try {
      if (transfer) d.node!.port.postMessage(msg, transfer);
      else d.node!.port.postMessage(msg);
    } catch (err) {
      console.error('[audio] could not reach the deck worklet', err);
    }
  }

  function flush(d: Deck): void {
    if (!d.node || d.loading) return;
    const list = d.held;
    d.held = [];
    for (const h of list) send(d, h.msg, h.transfer);
  }

  function onDeckMessage(d: Deck, m: number[]): void {
    if (!Array.isArray(m)) return;
    if (m[0] === 0) {
      // report: [0, gen, seq, frame, posSec, rate, flag]
      if (m[1] !== d.gen || m[2] < d.minSeq) return;
      reportCount++;
      if (m[6] === 2) d.history.clear();
      d.history.push(m[3] / sr, m[4], m[5], m[6] === 1);
    } else if (m[0] === 1) {
      if (m[1] !== d.gen) return;
      d.cuePreview = false;
      if (d.playing) {
        d.playing = false;
        events.emit('deck:end', { deck: d.id });
      }
    }
  }

  // ───────────────────────────── clock ─────────────────────────────

  let clockTimer: ReturnType<typeof setTimeout> | null = null;
  let clockBurst = 0;

  function sampleTimestamp(now: number): void {
    if (typeof ctx.getOutputTimestamp !== 'function') return;
    try {
      const ts = ctx.getOutputTimestamp();
      if (ts && typeof ts.contextTime === 'number' && typeof ts.performanceTime === 'number') {
        clock.addTimestamp(now, ts.contextTime, ts.performanceTime);
      }
    } catch {
      /* fall back to the staircase */
    }
  }

  function sampleClock(): void {
    if (ctx.state !== 'running') return;
    const now = performance.now();
    clock.addStaircase(now, ctx.currentTime);
    sampleTimestamp(now);
  }

  function scheduleClock(): void {
    if (clockTimer !== null || destroyed) return;
    // random intervals: samples must not lock to the display refresh or to the audio callback
    const delay = clockBurst > 0 ? 3 + Math.random() * 6 : 17 + Math.random() * 26;
    if (clockBurst > 0) clockBurst--;
    clockTimer = setTimeout(() => {
      clockTimer = null;
      if (ctx.state !== 'running') return;
      sampleClock();
      scheduleClock();
    }, delay);
  }

  function relockClock(): void {
    clock.reset();
    clockBurst = 24;
    if (clockTimer !== null) {
      clearTimeout(clockTimer);
      clockTimer = null;
    }
    if (ctx.state === 'running') {
      sampleClock();
      scheduleClock();
    }
  }

  const onStateChange = (): void => {
    if (destroyed) return;
    relockClock();
  };
  ctx.addEventListener('statechange', onStateChange);
  if (ctx.state === 'running') relockClock();

  function perfToCtx(perfMs: number): number {
    if (ctx.state !== 'running') return ctx.currentTime; // frozen
    if (!clock.isLocked) return ctx.currentTime + (perfMs - performance.now()) / 1000;
    return clock.perfToCtx(perfMs);
  }

  function limiterDelaySec(): number {
    return mixer ? mixer.delaySec : limiterLookaheadFrames(sr) / sr;
  }

  function autoLatencySec(): number {
    return estimateLatencySec({
      outputLatency: (ctx as unknown as { outputLatency?: number }).outputLatency,
      baseLatency: (ctx as unknown as { baseLatency?: number }).baseLatency,
      measured: clock.measuredOutputLatency(),
      platform,
      graphDelay: limiterDelaySec(),
    });
  }

  function latencySec(): number {
    return latencyOverrideMs !== null ? latencyOverrideMs / 1000 : autoLatencySec();
  }

  // ───────────────────────────── deck helpers ─────────────────────────────

  const tmp: HistorySample = { pos: 0, rate: 0 };

  function bpmOf(d: Deck): number {
    return d.loaded ? d.loaded.meta.grid.bpm * d.tempo : 0;
  }

  /** Playhead and rate at a context time, from the report history. */
  function sampleAt(d: Deck, ctxTime: number): HistorySample {
    if (!d.loaded || !d.history.sample(ctxTime, tmp)) {
      tmp.pos = d.parkPos;
      tmp.rate = 0;
    }
    if (tmp.pos < 0) tmp.pos = 0;
    else if (tmp.pos > d.durationSec) tmp.pos = d.durationSec;
    if (tmp.rate < 1e-6 && tmp.rate > -1e-6) tmp.rate = 0;
    return tmp;
  }

  /** The worklet's playhead right now (what the next rendered sample will be). */
  function rawNow(d: Deck): number {
    return sampleAt(d, ctx.currentTime).pos;
  }

  function rawRateNow(d: Deck): number {
    return sampleAt(d, ctx.currentTime).rate;
  }

  /** The playhead has been put somewhere while nothing was sounding: forget the old history. */
  function park(d: Deck, pos: number, seq: number): void {
    d.history.clear();
    d.parkPos = pos;
    d.minSeq = seq;
  }

  function updateEchoTime(d: Deck): void {
    if (mixer && d.loaded) mixer.setEchoTime(d.id, echoDelaySec(bpmOf(d)));
  }

  /**
   * Press-time alignment. When the other deck is playing, the player presses PLAY in time with
   * what they HEAR. Sound started now would come out one latency later, so the worklet is told
   * which context frame was at the speaker at the press and starts as if it had been running
   * since then (it also makes up for its own spin-up and for the time the message takes).
   */
  function startAnchor(d: Deck, perfMs: number): number | undefined {
    const o = decks[otherDeck(d.id)];
    if (!o.loaded || !o.playing || ctx.state !== 'running') return undefined;
    return (perfToCtx(perfMs) - latencySec()) * sr;
  }

  function resetDeckState(d: Deck): void {
    d.playing = false;
    d.scratching = false;
    d.cuePreview = false;
    d.tempo = 1;
    d.nudge = 0;
    d.synced = false;
  }

  // ───────────────────────────── meters ─────────────────────────────

  function refreshMeters(now: number): void {
    let token: number;
    const tl = typeof document !== 'undefined' && document.timeline ? document.timeline.currentTime : null;
    token = typeof tl === 'number' ? tl : Math.floor(now / 8);
    if (token === meterToken && now - meterMs < 100) return;
    const dt = meterMs ? (now - meterMs) / 1000 : 0;
    meterToken = token;
    meterMs = now;
    const live = analysers !== null && ctx.state === 'running';
    for (const id of DECKS) {
      let peak = 0;
      if (live) {
        analysers![id].getFloatTimeDomainData(meterBuf);
        peak = clamp01(blockPeak(meterBuf));
      }
      decks[id].level = ballistic(decks[id].level, peak, dt, 0.22);
    }
    if (live) {
      analysers!.bus.getFloatTimeDomainData(meterBuf);
      analyseBlock(meterBuf, sr, levels);
    } else {
      levels.peak = levels.low = levels.mid = levels.high = 0;
    }
    masterLevel = ballistic(masterLevel, clamp01(levels.peak), dt, 0.22);
    bands.low = ballistic(bands.low, bandToUnit(levels.low, BAND_SCALE.low), dt, 0.11);
    bands.mid = ballistic(bands.mid, bandToUnit(levels.mid, BAND_SCALE.mid), dt, 0.11);
    bands.high = ballistic(bands.high, bandToUnit(levels.high, BAND_SCALE.high), dt, 0.09);
  }

  // ───────────────────────────── unlock / suspend ─────────────────────────────

  function waitRunning(ms: number): Promise<void> {
    if (ctx.state === 'running') return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        ctx.removeEventListener('statechange', check);
        clearTimeout(timer);
        resolve();
      };
      const check = (): void => {
        if (ctx.state === 'running') done();
      };
      const timer = setTimeout(done, ms);
      ctx.addEventListener('statechange', check);
    });
  }

  /** After an interruption (call, route change, background) any tap brings the audio back. */
  const onGesture = (): void => {
    if (destroyed || !unlocked || userSuspended) return;
    if (ctx.state === 'running' || ctx.state === 'closed') return;
    unmute.arm();
    void ctx.resume().catch(() => undefined);
  };
  const onVisible = (): void => {
    if (typeof document !== 'undefined' && !document.hidden) onGesture();
  };
  const gestureEvents = ['pointerup', 'touchend', 'click', 'keydown'] as const;
  for (const type of gestureEvents) window.addEventListener(type, onGesture, { capture: true, passive: true });
  document.addEventListener('visibilitychange', onVisible);

  // ───────────────────────────── the engine ─────────────────────────────

  const engine: RealAudioEngine = {
    sampleRate: sr,
    get unlocked() {
      return unlocked;
    },

    unlock() {
      if (destroyed) return Promise.resolve();
      // everything up to the first await runs inside the caller's tap: iOS insists on that
      userSuspended = false;
      unmute.arm();
      let resumed: Promise<void>;
      try {
        resumed = ctx.state === 'closed' ? Promise.resolve() : ctx.resume();
      } catch (err) {
        resumed = Promise.reject(err);
      }
      return (async () => {
        await Promise.race([resumed.catch(() => undefined), sleep(3000)]);
        await ready;
        if (destroyed) return;
        await waitRunning(1500);
        if (ctx.state !== 'running') {
          throw new Error('The AudioContext did not start. unlock() has to be called from a tap.');
        }
        unlocked = true;
        if (!clock.isLocked) relockClock();
      })();
    },

    async suspend() {
      userSuspended = true;
      if (destroyed || ctx.state === 'closed') return;
      unmute.pause();
      try {
        await Promise.race([ctx.suspend(), sleep(1000)]);
      } catch {
        /* already suspended or closed */
      }
    },

    async resume() {
      userSuspended = false;
      if (destroyed || ctx.state === 'closed') return;
      if (unlocked) unmute.arm();
      try {
        // without a gesture some browsers leave this pending: do not hang the caller
        await Promise.race([ctx.resume(), sleep(1500)]);
      } catch {
        /* needs a tap: unlock() or the next gesture will resume */
      }
    },

    // ── decks ──

    async loadTrack(deck, track) {
      const d = decks[deck];
      const token = ++d.loadToken;
      const meta = track.meta;
      const pcm = track.pcm;
      // main-thread state changes at once, like putting a record on the platter
      const durationSec = Math.max(0, meta.durationSec);
      d.loaded = track;
      d.durationSec = durationSec;
      resetDeckState(d);
      d.cueSec = clamp(meta.grid.firstBeatSec, 0, durationSec);
      d.gen++;
      d.loading = true; // later commands queue up behind the track
      const gen = d.gen;
      const seq = ++d.seq;
      park(d, d.cueSec, seq);
      updateEchoTime(d);
      events.emit('deck:load', { deck, track: meta });

      let ch: Int16Array[] = [];
      try {
        const src = pcm.channels.slice(0, 2);
        for (const c of src) ch.push(await copyChannel(c));
      } catch (err) {
        console.error('[audio] could not copy the track', err);
        ch = [];
      }
      await ready.catch(() => undefined);
      if (token !== d.loadToken || destroyed) return; // overtaken by another load or an eject
      d.loading = false;
      if (d.node && ch.length > 0) {
        const len = Math.min(pcm.length, ...ch.map((c) => c.length));
        send(
          d,
          { t: 'load', q: seq, gen, ch, len, sr: pcm.sampleRate, pos: d.cueSec, tempo: 1, nudge: 0 },
          ch.map((c) => c.buffer as ArrayBuffer),
        );
      }
      flush(d);
    },

    eject(deck) {
      const d = decks[deck];
      d.loadToken++;
      d.loading = false;
      d.held = [];
      d.loaded = null;
      d.durationSec = 0;
      d.cueSec = 0;
      resetDeckState(d);
      d.gen++;
      const seq = post(d, { t: 'eject', gen: d.gen });
      park(d, 0, seq);
      events.emit('deck:eject', { deck });
    },

    play(deck) {
      const d = decks[deck];
      if (!d.loaded || d.playing) return;
      const now = performance.now();
      const latched = d.cuePreview; // PLAY during a cue preview keeps it running, as on a CDJ
      d.cuePreview = false;
      d.playing = true;
      if (!latched) {
        if (!d.scratching && rawNow(d) >= d.durationSec - 0.01) {
          const seq = post(d, { t: 'stopAt', pos: d.cueSec });
          park(d, d.cueSec, seq);
        }
        post(d, { t: 'play', anchor: d.scratching ? undefined : startAnchor(d, now) });
      }
      events.emit('deck:play', { deck, perfMs: now });
    },

    pause(deck) {
      const d = decks[deck];
      if (!d.loaded || !d.playing) return;
      d.playing = false;
      post(d, { t: 'pause' });
      events.emit('deck:pause', { deck, perfMs: performance.now() });
    },

    togglePlay(deck) {
      if (decks[deck].playing) engine.pause(deck);
      else engine.play(deck);
    },

    cueDown(deck) {
      const d = decks[deck];
      if (!d.loaded) return;
      const now = performance.now();
      if (d.playing) {
        d.playing = false;
        post(d, { t: 'stopAt', pos: d.cueSec });
      } else if (!d.cuePreview) {
        const pos = rawNow(d);
        if (Math.abs(pos - d.cueSec) < 0.02) {
          d.cuePreview = true;
          if (pos !== d.cueSec && rawRateNow(d) === 0 && !d.scratching) {
            const seq = post(d, { t: 'stopAt', pos: d.cueSec });
            park(d, d.cueSec, seq);
          }
          post(d, { t: 'play', anchor: d.scratching ? undefined : startAnchor(d, now) });
        } else {
          d.cueSec = clamp(pos, 0, d.durationSec);
        }
      }
      events.emit('deck:cue', { deck, perfMs: now });
    },

    cueUp(deck) {
      const d = decks[deck];
      if (!d.cuePreview) return;
      d.cuePreview = false;
      post(d, { t: 'stopAt', pos: d.cueSec });
    },

    seek(deck, sec) {
      const d = decks[deck];
      if (!d.loaded || !isFinite(sec)) return;
      const pos = clamp(sec, 0, d.durationSec);
      const still = !d.playing && !d.cuePreview && !d.scratching && rawRateNow(d) === 0;
      const seq = post(d, { t: 'seek', pos });
      if (still) park(d, pos, seq);
    },

    setTempo(deck, tempo) {
      const d = decks[deck];
      if (!isFinite(tempo)) return;
      d.tempo = clamp(tempo, TEMPO_MIN, TEMPO_MAX);
      d.synced = false;
      post(d, { t: 'tempo', v: d.tempo });
      updateEchoTime(d);
    },

    setNudge(deck, amount) {
      const d = decks[deck];
      if (!isFinite(amount)) return;
      d.nudge = clamp(amount, -1, 1);
      if (amount !== 0) d.synced = false;
      post(d, { t: 'nudge', v: d.nudge });
    },

    sync(deck) {
      const d = decks[deck];
      const o = decks[otherDeck(deck)];
      let ok = false;
      if (d.loaded && o.loaded) {
        const gridD = d.loaded.meta.grid;
        const gridO = o.loaded.meta.grid;
        const tempo = (gridO.bpm * o.tempo) / gridD.bpm;
        if (tempo >= TEMPO_MIN - 1e-6 && tempo <= TEMPO_MAX + 1e-6) {
          d.tempo = clamp(tempo, TEMPO_MIN, TEMPO_MAX);
          d.synced = true;
          ok = true;
          const moving = (d.playing || d.cuePreview) && !d.scratching && o.playing && !o.scratching;
          if (moving && d.history.size > 0 && o.history.size > 0) {
            // Both playheads at one and the same context time, then slide this deck to the nearest
            // beat. The worklet extrapolates from that time to the frame it applies the move at.
            const t = Math.max(d.history.newestTime(), o.history.newestTime());
            const mine = sampleAt(d, t).pos;
            const theirs = sampleAt(o, t).pos;
            let diff = fract(beatAtSec(gridO, theirs) - beatAtSec(gridD, mine));
            if (diff > 0.5) diff -= 1;
            const beatSec = 60 / gridD.bpm;
            let pos = mine + diff * beatSec;
            while (pos < 0) pos += beatSec;
            while (pos > d.durationSec - 0.05 && pos >= beatSec) pos -= beatSec;
            post(d, { t: 'syncTo', frame: t * sr, pos, tempo: d.tempo });
          } else {
            post(d, { t: 'tempo', v: d.tempo, now: true });
          }
          updateEchoTime(d);
        }
      }
      events.emit('deck:sync', { deck, ok });
      return ok;
    },

    scratchStart(deck) {
      const d = decks[deck];
      if (!d.loaded || d.scratching) return;
      d.scratching = true;
      d.lastMoveMs = performance.now();
      post(d, { t: 'scratchStart' });
      events.emit('deck:scratch', { deck, active: true });
    },

    scratchMove(deck, deltaSec) {
      const d = decks[deck];
      if (!d.loaded || !d.scratching || !isFinite(deltaSec)) return;
      // the time since the last move tells the worklet how fast the hand went
      const now = performance.now();
      const dt = clamp((now - d.lastMoveMs) / 1000, 0, 0.025);
      d.lastMoveMs = now;
      post(d, { t: 'scratchMove', d: deltaSec, dt });
    },

    scratchEnd(deck) {
      const d = decks[deck];
      if (!d.scratching) return;
      d.scratching = false;
      post(d, { t: 'scratchEnd' });
      events.emit('deck:scratch', { deck, active: false });
    },

    // ── mixer ──

    setEq(deck, band: EqBand, value) {
      if (!isFinite(value)) return;
      channels[deck].eq[band] = clamp01(value);
      mixer?.setEq(deck, band, channels[deck].eq[band]);
    },
    setFilter(deck, value) {
      if (!isFinite(value)) return;
      channels[deck].filter = clamp(value, -1, 1);
      mixer?.setFilter(deck, channels[deck].filter);
    },
    setFader(deck, value) {
      if (!isFinite(value)) return;
      channels[deck].fader = clamp01(value);
      mixer?.setFader(deck, channels[deck].fader);
    },
    setCrossfader(value) {
      if (!isFinite(value)) return;
      crossfader = clamp(value, -1, 1);
      mixer?.setCrossfader(crossfader);
    },
    setEcho(deck, on) {
      channels[deck].echo = !!on;
      mixer?.setEcho(deck, channels[deck].echo);
    },
    setMasterVolume(value) {
      if (!isFinite(value)) return;
      masterVolume = clamp01(value);
      mixer?.setMasterVolume(masterVolume);
    },

    // ── one-shot sounds ──

    registerSound(name: string, pcm: PcmData) {
      try {
        const nch = Math.min(2, Math.max(1, pcm.channels.length));
        const length = Math.max(1, Math.min(pcm.length, pcm.channels[0].length));
        const buffer = ctx.createBuffer(nch, length, pcm.sampleRate);
        const f = new Float32Array(length);
        for (let c = 0; c < nch; c++) {
          const src = pcm.channels[c];
          for (let i = 0; i < length; i++) f[i] = src[i] / 32768;
          buffer.copyToChannel(f, c);
        }
        sounds.set(name, buffer);
      } catch (err) {
        console.error(`[audio] could not register the sound "${name}"`, err);
      }
    },

    playSound(name: string, opts?: PlaySoundOptions) {
      const buffer = sounds.get(name);
      // a suspended context would play everything queued at once when it resumes: drop instead
      if (!buffer || !mixer || destroyed || ctx.state !== 'running') return;
      try {
        if (voices.size >= MAX_VOICES) {
          const oldest = voices.values().next().value as Voice;
          voices.delete(oldest);
          const t = ctx.currentTime;
          oldest.gain.gain.setTargetAtTime(0, t, 0.004);
          oldest.src.stop(t + 0.03);
        }
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        const rate = opts?.rate;
        if (typeof rate === 'number' && isFinite(rate) && rate !== 1) src.playbackRate.value = clamp(rate, 0.05, 8);
        const gain = ctx.createGain();
        const g = opts?.gain;
        gain.gain.value = typeof g === 'number' && isFinite(g) ? Math.max(0, g) : 1;
        src.connect(gain).connect(mixer.soundIn);
        const voice: Voice = { src, gain };
        voices.add(voice);
        src.onended = () => {
          voices.delete(voice);
          src.disconnect();
          gain.disconnect();
        };
        const at = opts?.atCtxTime;
        src.start(typeof at === 'number' && isFinite(at) && at > ctx.currentTime ? at : 0);
      } catch (err) {
        console.error(`[audio] could not play the sound "${name}"`, err);
      }
    },

    // ── state ──

    getDeck(deck): DeckSnapshot {
      const d = decks[deck];
      const now = performance.now();
      if (ctx.state === 'running') sampleTimestamp(now);
      refreshMeters(now);
      const meta = d.loaded ? d.loaded.meta : null;
      const s = sampleAt(d, perfToCtx(now) - latencySec());
      const positionSec = meta ? s.pos : 0;
      const rate = meta ? s.rate : 0;
      const moving = meta !== null && (d.playing || d.cuePreview || d.scratching || Math.abs(rate) > 0.01);
      return {
        id: deck,
        track: meta,
        playing: d.playing,
        scratching: d.scratching,
        positionSec,
        rate,
        tempo: d.tempo,
        bpm: meta ? meta.grid.bpm * d.tempo : 0,
        beat: meta ? beatAtSec(meta.grid, positionSec) : 0,
        cueSec: d.cueSec,
        durationSec: d.durationSec,
        nudge: d.nudge,
        cuePreview: d.cuePreview,
        synced: d.synced,
        audibility: moving ? channelGain(deck, channels[deck].fader, crossfader) : 0,
        level: d.level,
      };
    },

    getLoadedTrack: (deck) => decks[deck].loaded,

    getMixer(): MixerSnapshot {
      refreshMeters(performance.now());
      return {
        channels: {
          A: { ...channels.A, eq: { ...channels.A.eq } },
          B: { ...channels.B, eq: { ...channels.B.eq } },
        },
        crossfader,
        masterLevel,
        bands: { low: bands.low, mid: bands.mid, high: bands.high },
      };
    },

    positionAt(deck, perfMs) {
      const d = decks[deck];
      if (!d.loaded) return 0;
      return sampleAt(d, perfToCtx(perfMs) - latencySec()).pos;
    },

    // ── clock ──

    ctxTime: () => perfToCtx(performance.now()),
    perfToCtx,
    getLatency: latencySec,
    getAutoLatencyMs: () => autoLatencySec() * 1000,
    setLatencyMs(ms) {
      latencyOverrideMs = typeof ms === 'number' && isFinite(ms) ? clamp(ms, 0, 2000) : null;
    },

    on: (type, fn) => events.on(type, fn),

    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (clockTimer !== null) clearTimeout(clockTimer);
      clockTimer = null;
      ctx.removeEventListener('statechange', onStateChange);
      for (const type of gestureEvents) window.removeEventListener(type, onGesture, { capture: true });
      document.removeEventListener('visibilitychange', onVisible);
      for (const v of voices) {
        try {
          v.src.onended = null;
          v.src.stop();
          v.src.disconnect();
          v.gain.disconnect();
        } catch {
          /* ignore */
        }
      }
      voices.clear();
      sounds.clear();
      for (const id of DECKS) {
        const d = decks[id];
        d.held = [];
        d.loaded = null;
        d.history.clear();
        if (d.node) {
          d.node.port.onmessage = null;
          try {
            d.node.port.postMessage({ t: 'eject', gen: ++d.gen });
            d.node.disconnect();
          } catch {
            /* ignore */
          }
          d.node = null;
        }
      }
      for (const n of meterNodes) {
        try {
          n.disconnect();
        } catch {
          /* ignore */
        }
      }
      meterNodes.length = 0;
      analysers = null;
      mixer?.dispose();
      mixer = null;
      unmute.dispose();
      events.clear();
      if (ctx.state !== 'closed') void ctx.close().catch(() => undefined);
    },

    debug: {
      ctx,
      output: () => (mixer ? mixer.out : null),
      mixer: () => mixer,
      ready: () => ready,
      rawPosition: (deck) => rawNow(decks[deck]),
      stats: () => {
        const measured = clock.measuredOutputLatency();
        const ol = (ctx as unknown as { outputLatency?: number }).outputLatency;
        const bl = (ctx as unknown as { baseLatency?: number }).baseLatency;
        return {
          state: ctx.state,
          graphNodes: (mixer ? mixer.nodeCount : 0) + meterNodes.length + (decks.A.node ? 1 : 0) + (decks.B.node ? 1 : 0),
          voices: voices.size,
          reports: reportCount,
          historySize: { A: decks.A.history.size, B: decks.B.history.size },
          clockLocked: clock.isLocked,
          clockUsesTimestamps: clock.usingTimestamps,
          measuredOutputLatencyMs: measured === null ? null : measured * 1000,
          outputLatencyMs: typeof ol === 'number' ? ol * 1000 : null,
          baseLatencyMs: typeof bl === 'number' ? bl * 1000 : null,
          limiterDelayMs: limiterDelaySec() * 1000,
        };
      },
    },
  };

  return engine;
}

/** The fields the harness and the tests use beyond the AudioEngine contract. */
export const NUDGE_RATE = NUDGE_AMOUNT;
