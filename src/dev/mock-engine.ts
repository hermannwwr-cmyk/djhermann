/**
 * A silent, simulated AudioEngine. It keeps deck and mixer state and moves the playheads with a
 * clock, so UI and game logic can be built and tested without real audio.
 * In tests pass your own `now` clock and advance it by hand.
 */
import { Emitter } from '../core/events';
import { beatAtSec, secAtBeat } from '../core/beatgrid';
import { clamp, clamp01, damp, fract } from '../core/math';
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
  TrackMeta,
} from '../core/types';

export interface MockEngineOptions {
  /** millisecond clock; default performance.now */
  now?: () => number;
  sampleRate?: number;
  /** pretend output latency in ms (default 0) */
  latencyMs?: number;
}

export interface MockEngine extends AudioEngine {
  /** every playSound() call, newest last (for assertions) */
  readonly soundLog: { name: string; atMs: number }[];
  /** advance the simulation to the current clock (getters do this for you) */
  step(): void;
}

interface SimDeck {
  loaded: LoadedTrack | null;
  track: TrackMeta | null;
  playing: boolean;
  scratching: boolean;
  pos: number;
  rate: number;
  tempo: number;
  nudge: number;
  synced: boolean;
  cueSec: number;
  scratchVel: number;
  cuePreview: boolean;
}

const newDeck = (): SimDeck => ({
  loaded: null,
  track: null,
  playing: false,
  scratching: false,
  pos: 0,
  rate: 0,
  tempo: 1,
  nudge: 0,
  synced: false,
  cueSec: 0,
  scratchVel: 0,
  cuePreview: false,
});

const newChannel = (): ChannelSnapshot => ({
  eq: { low: 0.5, mid: 0.5, high: 0.5 },
  filter: 0,
  fader: 1,
  echo: false,
});

export function createMockEngine(opts: MockEngineOptions = {}): MockEngine {
  const clock = opts.now ?? (() => performance.now());
  const events = new Emitter<EngineEvents>();
  const decks: Record<DeckId, SimDeck> = { A: newDeck(), B: newDeck() };
  const channels: Record<DeckId, ChannelSnapshot> = { A: newChannel(), B: newChannel() };
  let crossfader = -1;
  let unlocked = false;
  let suspended = false;
  let lastMs = clock();
  let latencyOverride: number | null = null;
  const autoLatencyMs = opts.latencyMs ?? 0;
  const soundLog: { name: string; atMs: number }[] = [];

  function step(): void {
    const now = clock();
    const dt = Math.max(0, (now - lastMs) / 1000);
    lastMs = now;
    if (suspended || dt === 0) return;
    for (const id of ['A', 'B'] as DeckId[]) {
      const d = decks[id];
      if (!d.track) continue;
      if (d.scratching) {
        // position is moved by scratchMove(); the rate follows the hand and relaxes when it stops
        d.rate = d.scratchVel;
        d.scratchVel = damp(d.scratchVel, 0, 0.04, dt);
        continue;
      }
      const running = d.playing || d.cuePreview;
      const target = running ? d.tempo * (1 + d.nudge * NUDGE_AMOUNT) : 0;
      d.rate = damp(d.rate, target, running ? 0.02 : 0.04, dt);
      if (Math.abs(d.rate - target) < 0.001) d.rate = target;
      d.pos += d.rate * dt;
      if (d.pos >= d.track.durationSec) {
        d.pos = d.track.durationSec;
        d.rate = 0;
        d.cuePreview = false;
        if (d.playing) {
          d.playing = false;
          events.emit('deck:end', { deck: id });
        }
      }
      if (d.pos < 0) d.pos = 0;
    }
  }

  function gain(id: DeckId): number {
    const d = decks[id];
    if (!d.track) return 0;
    const moving = d.playing || d.cuePreview || d.scratching || Math.abs(d.rate) > 0.01;
    return moving ? channelGain(id, channels[id].fader, crossfader) : 0;
  }

  function snapshot(id: DeckId): DeckSnapshot {
    step();
    const d = decks[id];
    const grid = d.track?.grid;
    const audibility = gain(id);
    const beat = grid ? beatAtSec(grid, d.pos) : 0;
    return {
      id,
      track: d.track,
      playing: d.playing,
      scratching: d.scratching,
      positionSec: d.pos,
      rate: d.rate,
      tempo: d.tempo,
      bpm: grid ? grid.bpm * d.tempo : 0,
      beat,
      cueSec: d.cueSec,
      durationSec: d.track?.durationSec ?? 0,
      nudge: d.nudge,
      cuePreview: d.cuePreview,
      synced: d.synced,
      audibility,
      level: audibility * clamp01(Math.abs(d.rate)) * (0.45 + 0.5 * Math.pow(1 - fract(beat), 2)),
    };
  }

  const engine: MockEngine = {
    sampleRate: opts.sampleRate ?? 48000,
    get unlocked() {
      return unlocked;
    },
    soundLog,
    step,

    async unlock() {
      unlocked = true;
    },
    async suspend() {
      step();
      suspended = true;
    },
    async resume() {
      lastMs = clock();
      suspended = false;
    },

    async loadTrack(deck, track: LoadedTrack) {
      step();
      const d = decks[deck];
      d.loaded = track;
      d.track = track.meta;
      d.cuePreview = false;
      d.playing = false;
      d.scratching = false;
      d.rate = 0;
      d.tempo = 1;
      d.nudge = 0;
      d.synced = false;
      d.cueSec = track.meta.grid.firstBeatSec;
      d.pos = d.cueSec;
      events.emit('deck:load', { deck, track: track.meta });
    },
    eject(deck) {
      step();
      Object.assign(decks[deck], newDeck());
      events.emit('deck:eject', { deck });
    },
    play(deck) {
      step();
      const d = decks[deck];
      if (!d.track || d.playing) return;
      if (d.pos >= d.track.durationSec - 0.01) d.pos = d.cueSec;
      d.cuePreview = false; // PLAY during a cue preview latches playback, as on a CDJ
      d.playing = true;
      events.emit('deck:play', { deck, perfMs: clock() });
    },
    pause(deck) {
      step();
      const d = decks[deck];
      if (!d.track || !d.playing) return;
      d.playing = false;
      events.emit('deck:pause', { deck, perfMs: clock() });
    },
    togglePlay(deck) {
      if (decks[deck].playing) engine.pause(deck);
      else engine.play(deck);
    },
    cueDown(deck) {
      step();
      const d = decks[deck];
      if (!d.track) return;
      if (d.playing) {
        d.playing = false;
        d.rate = 0;
        d.pos = d.cueSec;
      } else if (Math.abs(d.pos - d.cueSec) < 0.02) {
        d.cuePreview = true;
      } else {
        d.cueSec = d.pos;
      }
      events.emit('deck:cue', { deck, perfMs: clock() });
    },
    cueUp(deck) {
      step();
      const d = decks[deck];
      if (!d.cuePreview) return;
      d.cuePreview = false;
      d.rate = 0;
      d.pos = d.cueSec;
    },
    seek(deck, sec) {
      step();
      const d = decks[deck];
      if (!d.track) return;
      d.pos = clamp(sec, 0, d.track.durationSec);
    },
    setTempo(deck, tempo) {
      step();
      decks[deck].tempo = clamp(tempo, TEMPO_MIN, TEMPO_MAX);
      decks[deck].synced = false;
    },
    setNudge(deck, amount) {
      step();
      decks[deck].nudge = clamp(amount, -1, 1);
      if (amount !== 0) decks[deck].synced = false;
    },
    sync(deck) {
      step();
      const d = decks[deck];
      const o = decks[otherDeck(deck)];
      let ok = false;
      if (d.track && o.track) {
        const tempo = (o.track.grid.bpm * o.tempo) / d.track.grid.bpm;
        if (tempo >= TEMPO_MIN - 1e-6 && tempo <= TEMPO_MAX + 1e-6) {
          d.tempo = clamp(tempo, TEMPO_MIN, TEMPO_MAX);
          d.synced = true;
          ok = true;
          if (o.playing) {
            // slide to the nearest beat so both decks' beats land together
            const mine = beatAtSec(d.track.grid, d.pos);
            const theirs = beatAtSec(o.track.grid, o.pos);
            let diff = fract(theirs - mine);
            if (diff > 0.5) diff -= 1;
            d.pos = clamp(secAtBeat(d.track.grid, mine + diff), 0, d.track.durationSec);
          }
        }
      }
      events.emit('deck:sync', { deck, ok });
      return ok;
    },
    scratchStart(deck) {
      step();
      const d = decks[deck];
      if (!d.track || d.scratching) return;
      d.scratching = true;
      d.scratchVel = 0;
      events.emit('deck:scratch', { deck, active: true });
    },
    scratchMove(deck, deltaSec) {
      const before = lastMs;
      step();
      const d = decks[deck];
      if (!d.track || !d.scratching) return;
      d.pos = clamp(d.pos + deltaSec, 0, d.track.durationSec);
      const dt = Math.max(0.004, (lastMs - before) / 1000);
      d.scratchVel = clamp(deltaSec / dt, -8, 8);
    },
    scratchEnd(deck) {
      step();
      const d = decks[deck];
      if (!d.scratching) return;
      d.scratching = false;
      events.emit('deck:scratch', { deck, active: false });
    },

    setEq(deck, band: EqBand, value) {
      channels[deck].eq[band] = clamp01(value);
    },
    setFilter(deck, value) {
      channels[deck].filter = clamp(value, -1, 1);
    },
    setFader(deck, value) {
      channels[deck].fader = clamp01(value);
    },
    setCrossfader(value) {
      crossfader = clamp(value, -1, 1);
    },
    setEcho(deck, on) {
      channels[deck].echo = on;
    },
    setMasterVolume() {
      /* silent */
    },

    registerSound(_name: string, _pcm: PcmData) {
      /* silent */
    },
    playSound(name: string, _opts?: PlaySoundOptions) {
      soundLog.push({ name, atMs: clock() });
      if (soundLog.length > 200) soundLog.shift();
    },

    getDeck: snapshot,
    getLoadedTrack: (deck) => decks[deck].loaded,
    getMixer(): MixerSnapshot {
      const a = snapshot('A');
      const b = snapshot('B');
      const level = clamp01(Math.max(a.level, b.level));
      return {
        channels: {
          A: { ...channels.A, eq: { ...channels.A.eq } },
          B: { ...channels.B, eq: { ...channels.B.eq } },
        },
        crossfader,
        masterLevel: level,
        bands: { low: level, mid: level * 0.7, high: level * 0.5 },
      };
    },
    positionAt(deck, perfMs) {
      step();
      const d = decks[deck];
      return d.pos + ((perfMs - lastMs) / 1000) * d.rate;
    },

    ctxTime: () => clock() / 1000,
    perfToCtx: (perfMs) => perfMs / 1000,
    getLatency: () => (latencyOverride ?? autoLatencyMs) / 1000,
    getAutoLatencyMs: () => autoLatencyMs,
    setLatencyMs(ms) {
      latencyOverride = ms;
    },

    on: (type, fn) => events.on(type, fn),
    destroy() {
      events.clear();
    },
  };
  return engine;
}
