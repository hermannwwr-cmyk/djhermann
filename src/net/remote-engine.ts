/**
 * The player's engine: decks that mirror the host's, as heard from the host's speaker, in this
 * phone's time. Feed it to createRhythm + createFrameLoop and the normal note highway runs in time
 * with the host's music. See RemoteEngine in core/party.ts.
 */
import { Emitter } from '../core/events';
import { AUDIBLE_MIN } from '../core/frame';
import { beatAtSec } from '../core/beatgrid';
import { clamp01, fract } from '../core/math';
import type { BoardEntry, DeckTick, HostMsg, RemoteEngine, RemoteEngineDeps, RemoteHud } from '../core/party';
import type {
  ChannelSnapshot,
  DeckId,
  DeckSnapshot,
  EngineEvents,
  GigResults,
  LoadedTrack,
  MixerSnapshot,
} from '../core/types';
import { DECK_IDS } from '../core/types';
import { DeckFollower } from './follow';
import { remoteTrack } from './wire';

export const REMOTE = {
  /** hostLive goes false after this long without a tick */
  liveTimeoutMs: 2000,
  /** joined mid-gig and no track after this long: ask the host */
  needAfterMs: 1000,
  /** at most one 'need' per this long */
  needEveryMs: 3000,
} as const;

export interface RemoteEngineOptions extends RemoteEngineDeps {
  /** performance.now (tests pass a virtual clock) */
  now?: () => number;
}

/** RemoteEngine plus diagnostics for tests and dev pages. */
export interface RemoteEngineImpl extends RemoteEngine {
  readonly followers: Record<DeckId, DeckFollower>;
  /** how many 'need' messages were sent */
  readonly needsSent: number;
}

const channel = (fader: number): ChannelSnapshot => ({
  eq: { low: 0.5, mid: 0.5, high: 0.5 },
  filter: 0,
  fader,
  echo: false,
});

/**
 * Shape the host's audibility so the frame loop on this phone picks the host's live deck (its
 * pickLive has hysteresis, so equal inputs at different moments could pick differently).
 */
export function shapeAudibility(live: DeckId | null, a: number, b: number): Record<DeckId, number> {
  if (!live) return { A: Math.min(a, AUDIBLE_MIN * 0.9), B: Math.min(b, AUDIBLE_MIN * 0.9) };
  const lv = Math.max(live === 'A' ? a : b, AUDIBLE_MIN);
  const cap = Math.max(0, (lv - 0.05) / 1.25 - 0.01);
  const other = Math.min(live === 'A' ? b : a, cap, lv * 0.99);
  return live === 'A' ? { A: lv, B: other } : { A: other, B: lv };
}

export function createRemoteEngine(deps: RemoteEngineOptions): RemoteEngineImpl {
  const { room, local } = deps;
  const now = deps.now ?? (() => performance.now());
  const events = new Emitter<EngineEvents>();
  const followers: Record<DeckId, DeckFollower> = { A: new DeckFollower(), B: new DeckFollower() };
  const loaded: Record<DeckId, LoadedTrack | null> = { A: null, B: null };
  const ticks: Record<DeckId, DeckTick | null> = { A: null, B: null };
  let live: DeckId | null = null;
  let hostAud: Record<DeckId, number> = { A: 0, B: 0 };
  let hud: RemoteHud | null = null;
  let density = 0;
  let board: BoardEntry[] = [];
  let results: { results: GigResults; board: BoardEntry[] } | null = null;
  let lastTickPerf = -Infinity;
  let lastTickAt = -Infinity;
  let anyTrack = false;
  const createdAt = now();
  let lastNeed = -Infinity;
  let needsSent = 0;
  let destroyed = false;

  function sendNeed(): void {
    const t = now();
    if (t - lastNeed < REMOTE.needEveryMs) return;
    lastNeed = t;
    needsSent++;
    room.send({ k: 'need' });
  }

  function load(deck: DeckId, m: Extract<HostMsg, { k: 'track' }>): void {
    const cur = loaded[deck];
    if (cur && cur.meta.id === m.meta.id) return; // a re-send
    loaded[deck] = remoteTrack(m.meta, m.energy, local.sampleRate);
    anyTrack = true;
    followers[deck].reset();
    followers[deck].durationSec = m.meta.durationSec;
    ticks[deck] = null;
    events.emit('deck:load', { deck, track: m.meta });
  }

  function eject(deck: DeckId): void {
    if (!loaded[deck]) return;
    loaded[deck] = null;
    followers[deck].reset();
    ticks[deck] = null;
    events.emit('deck:eject', { deck });
  }

  function onTick(m: Extract<HostMsg, { k: 'tick' }>): void {
    if (!(m.at > lastTickAt - 5000)) return; // garbage
    if (m.at <= lastTickAt) return; // out of date (cannot happen on one socket, but cheap)
    lastTickAt = m.at;
    lastTickPerf = now();
    const sharedNow = room.perfToShared(lastTickPerf);
    live = m.live;
    density = Number.isFinite(m.density) ? m.density : 0;
    hud = m.hud ?? null;
    for (const deck of DECK_IDS) {
      const d = m.decks?.[deck] ?? null;
      const mine = loaded[deck];
      if (!d) {
        if (mine) eject(deck); // the host has nothing there (we missed an eject)
        hostAud[deck] = 0;
        continue;
      }
      if (!mine || mine.meta.id !== d.trackId) {
        hostAud[deck] = 0;
        sendNeed(); // we are missing that track
        continue;
      }
      const prev = ticks[deck];
      ticks[deck] = d;
      hostAud[deck] = clamp01(d.audibility);
      followers[deck].push(d, m.at, sharedNow);
      if (prev) {
        const perfMs = room.sharedToPerf(m.at);
        if (d.playing && !prev.playing) events.emit('deck:play', { deck, perfMs });
        else if (!d.playing && prev.playing) events.emit('deck:pause', { deck, perfMs });
        if (d.scratching !== prev.scratching) events.emit('deck:scratch', { deck, active: d.scratching });
      }
    }
  }

  const offCast = room.on('cast', ({ m }) => {
    if (destroyed) return;
    switch (m.k) {
      case 'track':
        if (m.deck === 'A' || m.deck === 'B') load(m.deck, m);
        break;
      case 'eject':
        if (m.deck === 'A' || m.deck === 'B') eject(m.deck);
        break;
      case 'tick':
        onTick(m);
        break;
      case 'board':
        board = m.entries ?? [];
        break;
      case 'results':
        results = { results: m.results, board: m.board ?? [] };
        board = m.board ?? board;
        break;
    }
  });

  /** joined mid-gig: no track after a moment → ask */
  function maintain(t: number): void {
    if (anyTrack || t - createdAt < REMOTE.needAfterMs || needsSent > 0) return;
    if (room.phase === 'loading' || room.phase === 'playing') sendNeed();
  }

  function snapshot(deck: DeckId): DeckSnapshot {
    const t = now();
    maintain(t);
    const track = loaded[deck]?.meta ?? null;
    const f = followers[deck];
    const tk = ticks[deck];
    if (!track || !tk) {
      return {
        id: deck,
        track,
        playing: false,
        scratching: false,
        positionSec: track ? track.grid.firstBeatSec : 0,
        rate: 0,
        tempo: tk?.tempo ?? 1,
        bpm: track ? track.grid.bpm : 0,
        beat: 0,
        cueSec: track ? track.grid.firstBeatSec : 0,
        durationSec: track?.durationSec ?? 0,
        nudge: 0,
        cuePreview: false,
        synced: false,
        audibility: 0,
        level: 0,
      };
    }
    const s = room.perfToShared(t);
    const pos = f.position(s);
    const rate = f.rate(s);
    const beat = beatAtSec(track.grid, pos);
    const aud = shapeAudibility(live, hostAud.A, hostAud.B)[deck];
    return {
      id: deck,
      track,
      playing: tk.playing,
      scratching: tk.scratching,
      positionSec: pos,
      rate,
      tempo: tk.tempo,
      bpm: track.grid.bpm * tk.tempo,
      beat,
      cueSec: track.grid.firstBeatSec,
      durationSec: track.durationSec,
      nudge: 0,
      cuePreview: !tk.playing && Math.abs(rate) > 0.01 && !tk.scratching,
      synced: false,
      audibility: aud,
      level: aud * clamp01(Math.abs(rate)) * (0.45 + 0.5 * Math.pow(1 - fract(beat), 2)),
    };
  }

  const noop = (): void => undefined;

  const engine: RemoteEngineImpl = {
    get sampleRate() {
      return local.sampleRate;
    },
    get unlocked() {
      return local.unlocked;
    },
    unlock: () => local.unlock(),
    suspend: () => local.suspend(),
    resume: () => local.resume(),

    // transport + mixer: the host's job
    loadTrack: async () => undefined,
    eject: noop,
    play: noop,
    pause: noop,
    togglePlay: noop,
    cueDown: noop,
    cueUp: noop,
    seek: noop,
    setTempo: noop,
    setNudge: noop,
    sync: () => false,
    scratchStart: noop,
    scratchMove: noop,
    scratchEnd: noop,
    setEq: noop,
    setFilter: noop,
    setFader: noop,
    setCrossfader: noop,
    setEcho: noop,
    setMasterVolume: (v) => local.setMasterVolume(v),

    registerSound: (name, pcm) => local.registerSound(name, pcm),
    playSound: (name, opts) => local.playSound(name, opts),

    getDeck: snapshot,
    getLoadedTrack: (deck) => loaded[deck],
    getMixer(): MixerSnapshot {
      const a = snapshot('A');
      const b = snapshot('B');
      const level = clamp01(Math.max(a.level, b.level));
      const xf = live === 'A' ? -1 : live === 'B' ? 1 : 0;
      return {
        channels: { A: channel(a.audibility > 0 ? 1 : 0), B: channel(b.audibility > 0 ? 1 : 0) },
        crossfader: xf,
        masterLevel: level,
        bands: { low: level, mid: level * 0.7, high: level * 0.5 },
      };
    },
    positionAt(deck, perfMs) {
      if (!loaded[deck] || !ticks[deck]) return 0;
      return followers[deck].position(room.perfToShared(perfMs));
    },

    ctxTime: () => local.ctxTime(),
    perfToCtx: (p) => local.perfToCtx(p),
    getLatency: () => local.getLatency(),
    getAutoLatencyMs: () => local.getAutoLatencyMs(),
    setLatencyMs: (ms) => local.setLatencyMs(ms),

    on: (type, fn) => events.on(type, fn),
    destroy() {
      destroyed = true;
      offCast();
      events.clear();
    },

    get hud() {
      return hud;
    },
    get density() {
      return density;
    },
    get board() {
      return board;
    },
    get results() {
      return results;
    },
    get hostLive() {
      return now() - lastTickPerf < REMOTE.liveTimeoutMs;
    },
    followers,
    get needsSent() {
      return needsSent;
    },
  };
  return engine;
}
