/**
 * Multiplayer (step 2: rooms + party mode). Shared contract between the server (worker/), the
 * client networking (src/net/) and the party screens (src/ui/party/). Pure types + constants only:
 * the worker imports this file too, so it must not touch the DOM or any browser API.
 *
 * Party mode: one phone (the HOST) runs the gig and plays the audio, ideally into a speaker.
 * Every other phone (a PLAYER) is a controller: it shows its own note highway and pads, in time
 * with the host's music, and its hits count towards the crowd's hype and a shared leaderboard.
 * Only timing and game state travel over the network, never audio.
 *
 * Times: "shared ms" is the server's clock (Date.now() in the Durable Object). Each client
 * estimates its offset to it NTP-style (ping/pong, best-RTT samples).
 */
import type { GameBus } from './events';
import type {
  AudioEngine,
  DeckId,
  Difficulty,
  FrameState,
  GameParams,
  GigResults,
  HudState,
  Judgment,
  Lane,
  RhythmController,
  RhythmStats,
  TrackMeta,
} from './types';

// ───────────────────────────── constants ─────────────────────────────

/** Room codes: 4 letters, no I or O (easy to read out loud and type). */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const ROOM_CODE_LENGTH = 4;
export const MAX_PLAYERS = 8; // host included
export const MAX_NAME_LENGTH = 16;
/** Largest message either side may send (bytes of JSON). A track message is the largest (~40 kB). */
export const MAX_MESSAGE_BYTES = 128 * 1024;
/** How often the host broadcasts a tick while playing. */
export const TICK_HZ = 12;
/** How often players report their stats and the host broadcasts the board. */
export const STATS_HZ = 1;
/** A room with nobody connected is deleted after this long. */
export const ROOM_IDLE_TTL_MS = 15 * 60 * 1000;

export const isRoomCode = (s: string): boolean =>
  s.length === ROOM_CODE_LENGTH && [...s].every((c) => ROOM_CODE_ALPHABET.includes(c));

/** Normalise what a player typed: upper case, keep letters only, at most 4. */
export const normalizeRoomCode = (s: string): string => s.toUpperCase().replace(/[^A-Z]/g, '').slice(0, ROOM_CODE_LENGTH);

// ───────────────────────────── HTTP API (worker) ─────────────────────────────
//
// POST /api/rooms                 → 201 { code }                    create a room (the creator then connects as host)
// GET  /api/rooms/:code           → 200 RoomInfo | 404              does the room exist / can I join
// GET  /api/rooms/:code/ws        → 101 WebSocket upgrade | 404     the room connection
// Everything else is served from the static assets (the game).

export interface RoomInfo {
  code: string;
  phase: RoomPhase;
  players: number;
  hostConnected: boolean;
  full: boolean;
}

// ───────────────────────────── room state ─────────────────────────────

export type Role = 'host' | 'player';
export type RoomPhase = 'lobby' | 'loading' | 'playing' | 'results';

export interface PlayerInfo {
  pid: string;
  name: string;
  role: Role;
  connected: boolean;
  /** the difficulty this player picked for their own notes */
  difficulty: Difficulty;
  /** join order, 0 = host */
  seat: number;
}

// ───────────────────────────── wire: client → server ─────────────────────────────

export type ClientMsg =
  /** First message after the socket opens. pid + secret reclaim a seat after a reconnect. */
  | { t: 'hello'; role: Role; name: string; difficulty: Difficulty; pid?: string; secret?: string }
  /** Clock sync. c = client's performance.now() at send. */
  | { t: 'ping'; c: number }
  /** Update my own name / difficulty. */
  | { t: 'me'; name?: string; difficulty?: Difficulty }
  /** host only: change the room phase (stored, and sent to everyone, also to late joiners). */
  | { t: 'phase'; phase: RoomPhase; params?: GameParams }
  /** host only: send a game message to every player, or to one (to = pid). */
  | { t: 'cast'; m: HostMsg; to?: string }
  /** player only: send a game message to the host. */
  | { t: 'send'; m: PlayerMsg }
  /** host only: remove a player. */
  | { t: 'kick'; pid: string };

// ───────────────────────────── wire: server → client ─────────────────────────────

export type ErrorCode = 'not-found' | 'full' | 'host-taken' | 'kicked' | 'bad-message' | 'not-allowed';

export type ServerMsg =
  | {
      t: 'welcome';
      code: string;
      pid: string;
      /** keep it (sessionStorage) to reclaim this seat after a reconnect */
      secret: string;
      role: Role;
      players: PlayerInfo[];
      phase: RoomPhase;
      params?: GameParams;
    }
  /** s = server Date.now() when the ping was handled; c echoed back. */
  | { t: 'pong'; c: number; s: number }
  /** Sent to everyone whenever anyone joins, leaves, reconnects or changes name/difficulty. */
  | { t: 'players'; players: PlayerInfo[] }
  | { t: 'phase'; phase: RoomPhase; params?: GameParams }
  /** to players: a message from the host */
  | { t: 'cast'; m: HostMsg }
  /** to the host: a message from a player */
  | { t: 'from'; pid: string; m: PlayerMsg }
  /** fatal ones (not-found, full, host-taken, kicked) are followed by the server closing the socket */
  | { t: 'error'; code: ErrorCode; message: string };

// ───────────────────────────── game messages ─────────────────────────────

/** BeatEnergy with plain arrays (JSON). Values rounded to 2 decimals to keep it small. */
export interface WireEnergy {
  div: number;
  low: number[];
  mid: number[];
  high: number[];
  bar: number[];
}

/** One deck as heard on the host, at shared time `tick.at`. */
export interface DeckTick {
  trackId: string;
  playing: boolean;
  scratching: boolean;
  /** track seconds */
  pos: number;
  /** instantaneous playback rate (1 = native, negative = backwards) */
  rate: number;
  tempo: number;
  /** effective bpm (grid.bpm × tempo) */
  bpm: number;
  /** fractional beat (as DeckSnapshot.beat) */
  beat: number;
  audibility: number;
}

/** The slice of the host's HUD the players show. */
export type RemoteHud = Pick<HudState, 'hype' | 'progress' | 'status' | 'set'> & {
  /** the host's current mission title (what the DJ is doing), or null */
  djAction: string | null;
};

export type HostMsg =
  /** a track went on a deck (sent on deck:load, and again to late joiners / on 'need') */
  | { k: 'track'; deck: DeckId; meta: TrackMeta; energy: WireEnergy }
  | { k: 'eject'; deck: DeckId }
  /** TICK_HZ while playing. Players extrapolate between ticks: pos(t) = pos + (t - at)/1000 × rate. */
  | {
      k: 'tick';
      /** shared ms the snapshot is valid at */
      at: number;
      live: DeckId | null;
      decks: Record<DeckId, DeckTick | null>;
      /** note density the host's gig wants right now (players apply it too) */
      density: number;
      hud: RemoteHud;
    }
  | { k: 'board'; entries: BoardEntry[] }
  /** the gig ended */
  | { k: 'results'; results: GigResults; board: BoardEntry[] };

export type PlayerMsg =
  | { k: 'judge'; lane: Lane; judgment: Judgment; errorMs: number }
  | { k: 'stats'; stats: RhythmStats }
  /** "I'm missing the tracks / state": the host re-sends 'track' messages to this player */
  | { k: 'need' };

export interface BoardEntry {
  pid: string;
  name: string;
  role: Role;
  score: number;
  combo: number;
  maxCombo: number;
  /** 0..1 */
  accuracy: number;
  connected: boolean;
}

// ───────────────────────────── client API (implemented in src/net) ─────────────────────────────

export type RoomStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface RoomEvents {
  status: { status: RoomStatus };
  players: { players: PlayerInfo[] };
  phase: { phase: RoomPhase; params?: GameParams };
  /** players receive host messages */
  cast: { m: HostMsg };
  /** the host receives player messages */
  from: { pid: string; m: PlayerMsg };
  /** fatal: the room is gone, full, or this player was kicked. status becomes 'closed'. */
  error: { code: ErrorCode; message: string };
}

/** A live connection to a room. Reconnects by itself (same seat) until leave() or a fatal error. */
export interface RoomClient {
  readonly code: string;
  readonly role: Role;
  /** '' until the first welcome */
  readonly pid: string;
  readonly status: RoomStatus;
  readonly players: PlayerInfo[];
  readonly phase: RoomPhase;
  readonly params: GameParams | undefined;
  readonly me: PlayerInfo | undefined;
  readonly hostConnected: boolean;

  // shared clock
  /** true once enough ping samples were taken (≈ 1 s after connecting) */
  readonly clockReady: boolean;
  /** estimated error of the clock offset in ms (half the best round trip) */
  readonly clockErrorMs: number;
  /** shared ms now */
  now(): number;
  perfToShared(perfMs: number): number;
  sharedToPerf(sharedMs: number): number;

  setMe(patch: { name?: string; difficulty?: Difficulty }): void;
  // host only (ignored for players)
  setPhase(phase: RoomPhase, params?: GameParams): void;
  cast(m: HostMsg, to?: string): void;
  kick(pid: string): void;
  // player only (ignored for the host)
  send(m: PlayerMsg): void;

  on<K extends keyof RoomEvents>(type: K, fn: (e: RoomEvents[K]) => void): () => void;
  /** close for good (no reconnect) */
  leave(): void;
}

export type RoomErrorCode = ErrorCode | 'network';

export class RoomError extends Error {
  constructor(
    public code: RoomErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RoomError';
  }
}

/** Holds the room this app is in (at most one). Lives in AppContext. */
export interface PartyStore {
  readonly room: RoomClient | null;
  /** create a room and connect as its host */
  host(opts: { name: string; difficulty: Difficulty }): Promise<RoomClient>;
  /** join an existing room as a player. Rejects with RoomError. */
  join(code: string, opts: { name: string; difficulty: Difficulty }): Promise<RoomClient>;
  /** leave the current room (if any) */
  leave(): void;
  subscribe(fn: (room: RoomClient | null) => void): () => void;
}

// ───────────────────────────── game integration (implemented in src/net) ─────────────────────────────
//
// src/net/index.ts exports:
//   createPartyStore(): PartyStore
//   createHostLink(deps: HostLinkDeps): HostLink
//   createRemoteEngine(deps: RemoteEngineDeps): RemoteEngine
//   createPlayerReporter(deps: PlayerReporterDeps): PlayerReporter

/** Host side: runs inside the host's game screen while a party gig is on. */
export interface HostLinkDeps {
  room: RoomClient;
  engine: AudioEngine;
  bus: GameBus;
  rhythm: RhythmController;
  getHud: () => HudState;
}

export interface HostLink {
  /**
   * Call every frame (render phase). Sends 'track'/'eject' when decks change, TICK_HZ ticks,
   * the board at STATS_HZ; re-sends tracks on 'need' and to players who join mid-gig.
   * Player 'judge' messages are re-emitted on the host's bus (they move the crowd's hype).
   */
  update(frame: FrameState): void;
  /** host + players, best score first */
  getBoard(): BoardEntry[];
  /** the gig ended: send 'results' and set the phase to 'results' */
  finish(results: GigResults): void;
  destroy(): void;
}

export interface RemoteEngineDeps {
  room: RoomClient;
  /** the phone's real engine: used for pad and UI sounds only (no decks are loaded on it) */
  local: AudioEngine;
}

/**
 * Player side: an AudioEngine whose decks mirror the host's, as heard from the host's speaker,
 * in this phone's time (via the shared clock). Feed it to createRhythm and createFrameLoop and
 * the normal note highway runs in time with the host's music. Transport and mixer methods are
 * no-ops; playSound plays through `local`. Emits deck:load / deck:eject as the host's decks change.
 */
export interface RemoteEngine extends AudioEngine {
  /** host's HUD slice from the last tick, or null before the first one */
  readonly hud: RemoteHud | null;
  /** density from the last tick (0 before the first one) */
  readonly density: number;
  readonly board: BoardEntry[];
  /** set when the host sent 'results' */
  readonly results: { results: GigResults; board: BoardEntry[] } | null;
  /** false when no tick arrived for 2 s (host paused, backgrounded or offline) */
  readonly hostLive: boolean;
}

/** Player side: sends this player's judgments and stats to the host. */
export interface PlayerReporterDeps {
  room: RoomClient;
  bus: GameBus;
  rhythm: RhythmController;
}

export interface PlayerReporter {
  /** call every frame; sends 'stats' at STATS_HZ (judgments are sent as they happen) */
  update(frame: FrameState): void;
  destroy(): void;
}
