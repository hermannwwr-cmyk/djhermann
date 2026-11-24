/**
 * A pretend party for dev harnesses (never imported by the game): a fake PartyStore whose rooms
 * live in memory, a simulated host that loads tracks, plays them on a silent mock engine and sends
 * ticks, boards and results, and fake friends who join, score and drop out. The party screens run
 * on it exactly as they would on the real network module.
 *
 *   const party = createMockParty({ local: engine });
 *   ctx.party = party.store;
 *   registerPartyScreensWith(ctx, party.net);
 *   party.sim()?.startGig();        // drive the current room from a harness
 */
import { Emitter } from '../../core/events';
import { MAX_PLAYERS, RoomError, STATS_HZ } from '../../core/party';
import type {
  BoardEntry,
  ErrorCode,
  HostMsg,
  PartyStore,
  PlayerInfo,
  PlayerMsg,
  PlayerReporter,
  PlayerReporterDeps,
  RemoteEngine,
  RemoteEngineDeps,
  RemoteHud,
  Role,
  RoomClient,
  RoomErrorCode,
  RoomEvents,
  RoomPhase,
  RoomStatus,
} from '../../core/party';
import type { AudioEngine, DeckId, Difficulty, GameParams, GigResults, RhythmStats } from '../../core/types';
import { createMockEngine } from '../../dev/mock-engine';
import type { MockEngine } from '../../dev/mock-engine';
import { MOCK_CATALOG, mockTrack } from '../../dev/mocks';
import type { PartyNet } from './net';

const FRIENDS: [string, Difficulty][] = [
  ['Mia', 'club'],
  ['Jonas', 'chill'],
  ['Priya', 'festival'],
  ['Leo', 'club'],
  ['Disco Llama', 'chill'],
  ['Ana', 'club'],
  ['Kofi', 'festival'],
];

const DJ_ACTIONS = ['START DECK B', 'MATCH THE SPEED', 'CROSSFADE TO DECK B', null, 'KILL THE BASS, THEN DROP IT', null, 'SCRATCH DECK B'];

export interface MockPartyOptions {
  /** the phone's own engine (pad sounds) */
  local: AudioEngine;
  /** fake network delay for host() / join(), ms (default 700) */
  delayMs?: number;
  /** codes that fail to join, and how (defaults: ZZZZ not-found, FULL full, NETW network) */
  failures?: Record<string, RoomErrorCode>;
  /** every join fails like this */
  failAll?: RoomErrorCode | null;
  /** friends already in a room when it is created/joined (default 2) */
  friends?: number;
  /** friends keep arriving every few seconds in a hosted room (default false) */
  trickle?: boolean;
  /** the simulated host's name when joining (default "Sam") */
  hostName?: string;
}

export interface MockParty {
  store: PartyStore;
  net: PartyNet;
  /** the simulation behind the current room, if any */
  sim(): PartySim | null;
}

interface Friend {
  info: PlayerInfo;
  skill: number;
  stats: { score: number; combo: number; maxCombo: number; accuracy: number };
}

/** Drives one pretend room. */
export class PartySim {
  readonly room: MockRoom;
  /** the host's decks (silent): a remote engine mirrors these */
  readonly hostEngine: MockEngine;
  hud: RemoteHud | null = null;
  density = 0;
  hostLive = false;
  results: { results: GigResults; board: BoardEntry[] } | null = null;
  private friends: Friend[] = [];
  private myStats: RhythmStats | null = null;
  private hostScore = 0;
  private timers: number[] = [];
  private tickTimer = 0;
  private startedAt = 0;
  private seatNext = 1;
  private nameNext = 0;

  constructor(room: MockRoom) {
    this.room = room;
    this.hostEngine = createMockEngine();
    void this.hostEngine.unlock();
  }

  // ── players ──

  addFriend(name?: string, difficulty?: Difficulty): PlayerInfo | null {
    if (this.room.players.length >= MAX_PLAYERS) return null;
    const [n, d] = FRIENDS[this.nameNext++ % FRIENDS.length];
    const info: PlayerInfo = {
      pid: `p${this.seatNext}`,
      name: name ?? n,
      role: 'player',
      connected: true,
      difficulty: difficulty ?? d,
      seat: this.seatNext++,
    };
    this.friends.push({ info, skill: 0.55 + Math.random() * 0.45, stats: { score: 0, combo: 0, maxCombo: 0, accuracy: 1 } });
    this.room._setPlayers([...this.room.players, info]);
    return info;
  }

  removeFriend(pid?: string): void {
    const f = pid ? this.friends.find((x) => x.info.pid === pid) : this.friends[this.friends.length - 1];
    if (!f) return;
    this.friends = this.friends.filter((x) => x !== f);
    this.room._setPlayers(this.room.players.filter((p) => p.pid !== f.info.pid));
  }

  setFriendConnected(pid: string, connected: boolean): void {
    this.room._setPlayers(this.room.players.map((p) => (p.pid === pid ? { ...p, connected } : p)));
  }

  /** the host's phone drops out (players only) */
  setHostConnected(connected: boolean): void {
    this.room._setPlayers(this.room.players.map((p) => (p.role === 'host' ? { ...p, connected } : p)));
    if (!connected) this.setLive(false);
  }

  /** the room is gone / this phone was removed */
  fatal(code: ErrorCode): void {
    this.stopTicks();
    this.room._fatal(code);
  }

  setStatus(status: RoomStatus): void {
    this.room._setStatus(status);
  }

  // ── the gig (host side, simulated) ──

  /** As the host's START: loading, tracks on the decks, then the music. */
  startGig(params?: GameParams): void {
    this.results = null;
    this.hud = null;
    this.density = 0;
    this.hostLive = false;
    this.myStats = null;
    this.hostScore = 0;
    for (const f of this.friends) f.stats = { score: 0, combo: 0, maxCombo: 0, accuracy: 1 };
    const p = params ?? { mode: 'gig', setlist: ['mock-golden', 'mock-lanterns', 'mock-coast'], difficulty: 'club', party: true };
    this.room._setPhase('loading', p);
    this.later(1400, () => {
      const e = this.hostEngine;
      e.eject('A');
      e.eject('B');
      void e.loadTrack('A', mockTrack(MOCK_CATALOG[0])).then(() => e.loadTrack('B', mockTrack(MOCK_CATALOG[1])));
    });
    this.later(2600, () => {
      this.room._setPhase('playing', p);
      this.hostEngine.setCrossfader(-1);
      this.hostEngine.play('A');
      this.startedAt = performance.now();
      this.setLive(true);
    });
  }

  /** jump the music forward (screenshots mid-song) */
  seekBeats(beats: number): void {
    const t = this.hostEngine.getDeck('A');
    if (!t.track) return;
    this.hostEngine.seek('A', t.track.grid.firstBeatSec + (beats * 60) / t.track.grid.bpm);
  }

  /** the host paused (or went to the background): ticks stop */
  setLive(live: boolean): void {
    this.hostLive = live;
    if (live) {
      this.hostEngine.play('A');
      this.startTicks();
    } else {
      this.hostEngine.pause('A');
      this.hostEngine.pause('B');
      this.stopTicks();
    }
  }

  finishGig(completed = true): void {
    this.setLive(false);
    const board = this.board();
    const results = fakeGigResults(completed);
    this.results = { results, board };
    this.room._cast({ k: 'results', results, board });
    this.room._setPhase('results', this.room.params);
  }

  backToLobby(): void {
    this.setLive(false);
    this.room._setPhase('lobby');
  }

  board(): BoardEntry[] {
    const out: BoardEntry[] = [];
    const host = this.room.players.find((p) => p.role === 'host');
    if (host) {
      out.push({
        pid: host.pid,
        name: host.name,
        role: 'host',
        score: this.hostScore,
        combo: 12,
        maxCombo: 40,
        accuracy: 0.91,
        connected: host.connected,
      });
    }
    const me = this.room.me;
    if (me && me.role === 'player') {
      const s = this.myStats;
      out.push({
        pid: me.pid,
        name: me.name,
        role: 'player',
        score: s?.points ?? 0,
        combo: s?.combo ?? 0,
        maxCombo: s?.maxCombo ?? 0,
        accuracy: s?.accuracy ?? 1,
        connected: this.room.status === 'open',
      });
    }
    for (const f of this.friends) {
      const live = this.room.players.find((p) => p.pid === f.info.pid);
      if (!live) continue;
      out.push({ pid: f.info.pid, name: live.name, role: 'player', ...f.stats, connected: live.connected });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  /** give everybody a score, as if `sec` seconds of music had been played */
  fastForward(sec: number): void {
    for (let i = 0; i < sec * STATS_HZ; i++) this.scoreStep();
  }

  // ── messages from this phone ──

  _fromMe(m: PlayerMsg): void {
    if (m.k === 'stats') this.myStats = m.stats;
  }

  _fromHost(m: HostMsg): void {
    if (m.k === 'results') this.results = { results: m.results, board: m.board };
  }

  destroy(): void {
    this.stopTicks();
    for (const t of this.timers) window.clearTimeout(t);
    this.timers = [];
    this.hostEngine.destroy();
  }

  // ── internals ──

  later(ms: number, fn: () => void): void {
    this.timers.push(window.setTimeout(fn, ms));
  }

  private startTicks(): void {
    if (this.tickTimer) return;
    let n = 0;
    this.tickTimer = window.setInterval(() => {
      n++;
      const t = (performance.now() - this.startedAt) / 1000;
      const prevHype = this.hud?.hype ?? 0.55;
      const djAction = DJ_ACTIONS[Math.floor(t / 9) % DJ_ACTIONS.length];
      this.hud = {
        hype: Math.max(0.15, Math.min(1, prevHype + (Math.random() - 0.45) * 0.03)),
        progress: Math.min(1, t / 240),
        status: djAction ? '' : 'NEXT MIX IN 8 BARS',
        set: { index: Math.min(2, Math.floor(t / 80)), count: 3 },
        djAction,
      };
      this.density = 0.85;
      if (n % 12 === 0) this.scoreStep();
    }, 1000 / 12);
  }

  private stopTicks(): void {
    window.clearInterval(this.tickTimer);
    this.tickTimer = 0;
  }

  private scoreStep(): void {
    this.hostScore += Math.round(300 + Math.random() * 500);
    for (const f of this.friends) {
      const s = f.stats;
      const hit = Math.random() < f.skill;
      if (hit) {
        s.combo += 2 + Math.floor(Math.random() * 3);
        s.maxCombo = Math.max(s.maxCombo, s.combo);
        s.score += Math.round(140 * f.skill * (1 + Math.min(3, s.combo / 25)));
      } else s.combo = 0;
      s.accuracy = Math.max(0.4, Math.min(1, s.accuracy * 0.9 + f.skill * 0.1 + (Math.random() - 0.5) * 0.04));
    }
  }
}

/** A RoomClient that lives in memory. */
export class MockRoom implements RoomClient {
  readonly code: string;
  readonly role: Role;
  pid = '';
  status: RoomStatus = 'connecting';
  players: PlayerInfo[] = [];
  phase: RoomPhase = 'lobby';
  params: GameParams | undefined = undefined;
  readonly clockReady = true;
  readonly clockErrorMs = 6;
  readonly sim: PartySim;
  private events = new Emitter<RoomEvents>();
  private left = false;
  private onLeave: () => void;

  constructor(code: string, role: Role, me: { name: string; difficulty: Difficulty }, opts: { friends: number; hostName: string }, onLeave: () => void) {
    this.code = code;
    this.role = role;
    this.onLeave = onLeave;
    this.sim = new PartySim(this);
    if (role === 'host') {
      this.pid = 'h0';
      this.players = [{ pid: 'h0', name: me.name, role: 'host', connected: true, difficulty: me.difficulty, seat: 0 }];
    } else {
      this.players = [{ pid: 'h0', name: opts.hostName, role: 'host', connected: true, difficulty: 'club', seat: 0 }];
    }
    for (let i = 0; i < opts.friends; i++) this.sim.addFriend();
    if (role === 'player') {
      this.pid = 'me';
      this.players = [...this.players, { pid: 'me', name: me.name, role: 'player', connected: true, difficulty: me.difficulty, seat: 90 }];
    }
    this.status = 'open';
  }

  get me(): PlayerInfo | undefined {
    return this.players.find((p) => p.pid === this.pid);
  }

  get hostConnected(): boolean {
    return this.players.some((p) => p.role === 'host' && p.connected);
  }

  now(): number {
    return Date.now();
  }

  perfToShared(perfMs: number): number {
    return Date.now() - performance.now() + perfMs;
  }

  sharedToPerf(sharedMs: number): number {
    return performance.now() - Date.now() + sharedMs;
  }

  setMe(patch: { name?: string; difficulty?: Difficulty }): void {
    this._setPlayers(this.players.map((p) => (p.pid === this.pid ? { ...p, ...patch } : p)));
  }

  setPhase(phase: RoomPhase, params?: GameParams): void {
    if (this.role !== 'host') return;
    this._setPhase(phase, params);
  }

  cast(m: HostMsg): void {
    if (this.role === 'host') this.sim._fromHost(m);
  }

  kick(pid: string): void {
    if (this.role === 'host') this.sim.removeFriend(pid);
  }

  send(m: PlayerMsg): void {
    if (this.role === 'player') this.sim._fromMe(m);
  }

  on<K extends keyof RoomEvents>(type: K, fn: (e: RoomEvents[K]) => void): () => void {
    return this.events.on(type, fn);
  }

  leave(): void {
    if (this.left) return;
    this.left = true;
    this.sim.destroy();
    this._setStatus('closed');
    this.events.clear();
    this.onLeave();
  }

  // ── simulation hooks ──

  _setPlayers(players: PlayerInfo[]): void {
    this.players = players;
    this.events.emit('players', { players });
  }

  _setPhase(phase: RoomPhase, params?: GameParams): void {
    this.phase = phase;
    if (params) this.params = params;
    this.events.emit('phase', { phase, params: this.params });
  }

  _setStatus(status: RoomStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.events.emit('status', { status });
  }

  _cast(m: HostMsg): void {
    this.events.emit('cast', { m });
  }

  _fatal(code: ErrorCode): void {
    this.events.emit('error', { code, message: code });
    this._setStatus('closed');
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function newCode(): string {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let s = '';
  for (let i = 0; i < 4; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

export function createMockParty(opts: MockPartyOptions): MockParty {
  const delay = opts.delayMs ?? 700;
  const failures: Record<string, RoomErrorCode> = opts.failures ?? { ZZZZ: 'not-found', FULL: 'full', NETW: 'network' };
  const subs = new Set<(room: RoomClient | null) => void>();
  let room: MockRoom | null = null;
  let trickle = 0;

  const set = (r: MockRoom | null): void => {
    room = r;
    for (const fn of [...subs]) fn(r);
  };

  const store: PartyStore = {
    get room() {
      return room;
    },
    async host(me) {
      store.leave();
      await sleep(delay);
      if (opts.failAll === 'network') throw new RoomError('network', 'offline');
      const r: MockRoom = new MockRoom(newCode(), 'host', me, { friends: opts.friends ?? 0, hostName: me.name }, () => {
        window.clearInterval(trickle);
        if (room === r) set(null);
      });
      if (opts.trickle) {
        trickle = window.setInterval(() => {
          if (r.players.length < 5) r.sim.addFriend();
        }, 2500);
      }
      set(r);
      return r;
    },
    async join(code, me) {
      store.leave();
      await sleep(delay);
      const fail = opts.failAll ?? failures[code];
      if (fail) throw new RoomError(fail, fail);
      const r: MockRoom = new MockRoom(code, 'player', me, { friends: opts.friends ?? 2, hostName: opts.hostName ?? 'Sam' }, () => {
        if (room === r) set(null);
      });
      set(r);
      return r;
    },
    leave() {
      room?.leave();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };

  const net: PartyNet = {
    createRemoteEngine: (deps) => createMockRemoteEngine(deps),
    createPlayerReporter: (deps) => createMockReporter(deps),
  };

  return { store, net, sim: () => room?.sim ?? null };
}

/** The player's view of the host's decks: the simulated host engine, read through. */
function createMockRemoteEngine(deps: RemoteEngineDeps): RemoteEngine {
  const room = deps.room as MockRoom;
  const sim = room.sim;
  const host = sim.hostEngine;
  const local = deps.local;
  const noop = (): void => undefined;
  return {
    get sampleRate() {
      return local.sampleRate;
    },
    get unlocked() {
      return local.unlocked;
    },
    unlock: () => local.unlock(),
    suspend: () => local.suspend(),
    resume: () => local.resume(),
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
    setMasterVolume: noop,
    registerSound: (name, pcm) => local.registerSound(name, pcm),
    playSound: (name, o) => local.playSound(name, o),
    getDeck: (d: DeckId) => host.getDeck(d),
    getLoadedTrack: (d: DeckId) => host.getLoadedTrack(d),
    getMixer: () => host.getMixer(),
    positionAt: (d: DeckId, perfMs: number) => host.positionAt(d, perfMs),
    ctxTime: () => local.ctxTime(),
    perfToCtx: (p) => local.perfToCtx(p),
    getLatency: () => local.getLatency(),
    getAutoLatencyMs: () => local.getAutoLatencyMs(),
    setLatencyMs: (ms) => local.setLatencyMs(ms),
    on: (type, fn) => host.on(type, fn),
    destroy: noop,
    get hud() {
      return sim.hud;
    },
    get density() {
      return sim.density;
    },
    get board() {
      return sim.board();
    },
    get results() {
      return sim.results;
    },
    get hostLive() {
      return sim.hostLive;
    },
  };
}

function createMockReporter(deps: PlayerReporterDeps): PlayerReporter {
  let last = 0;
  const off = deps.bus.on('judge', (e) => deps.room.send({ k: 'judge', lane: e.lane, judgment: e.judgment, errorMs: e.errorMs }));
  return {
    update(frame) {
      if (frame.now - last < 1000 / STATS_HZ / 4) return;
      last = frame.now;
      deps.room.send({ k: 'stats', stats: deps.rhythm.getStats() });
    },
    destroy: off,
  };
}

/** Plausible host results for the end of a pretend gig. */
export function fakeGigResults(completed = true): GigResults {
  const hist = Array.from({ length: 48 }, (_, i) => Math.min(1, 0.45 + 0.45 * (i / 47) + 0.08 * Math.sin(i * 0.7)));
  return {
    completed,
    score: completed ? 96300 : 18200,
    grade: completed ? 'A' : 'D',
    stars: completed ? 4 : 0,
    rhythm: { perfect: 150, great: 62, good: 22, miss: 11, combo: 12, maxCombo: 84, multiplier: 2, points: 61200, accuracy: 0.89 },
    missions: [
      { kind: 'start-set', title: 'START THE SET', rating: 'perfect', points: 1000, label: 'ON THE ONE' },
      { kind: 'start-deck', title: 'START DECK B', rating: 'great', points: 1200, label: 'A TOUCH LATE' },
      { kind: 'crossfade', title: 'CROSSFADE TO DECK B', rating: 'perfect', points: 2500, label: 'SMOOTH MIX' },
    ],
    hypeAvg: 0.74,
    hypePeak: 0.96,
    hypeHistory: completed ? hist : hist.slice(0, 20).map((v, i) => v - i * 0.03),
    trainwrecks: 0,
    deadAirSec: 0.8,
    setlist: [
      { id: 'mock-golden', title: 'Golden Hour Drive' },
      { id: 'mock-lanterns', title: 'Paper Lanterns' },
      { id: 'mock-coast', title: 'Northern Coast' },
    ],
    difficulty: 'club',
    durationSec: 238,
  };
}
