/**
 * Room logic, independent of the Workers runtime (unit-tested in Node with fake sockets/storage).
 * `worker/room.ts` is the thin Durable Object adapter around it.
 *
 * Model
 * - The room record (code, claim time, phase + params, seats with their secrets) lives in storage
 *   under one key and is written on every change, so it survives hibernation and eviction.
 * - Per-socket data ({ cid, pid }) lives in the socket's attachment (serializeAttachment), so it
 *   survives hibernation too. Whether a seat is "connected" is derived from the open sockets,
 *   never stored, so it cannot go stale.
 * - Everything here is synchronous (SQLite-backed Durable Objects have a synchronous KV API);
 *   alarm / deleteAll calls are fire-and-forget from the logic's point of view.
 */
import {
  MAX_MESSAGE_BYTES,
  MAX_NAME_LENGTH,
  MAX_PLAYERS,
  ROOM_IDLE_TTL_MS,
  type ClientMsg,
  type ErrorCode,
  type PlayerInfo,
  type Role,
  type RoomInfo,
  type RoomPhase,
  type ServerMsg,
} from '../src/core/party';
import type { Difficulty, GameParams } from '../src/core/types';

// ───────────────────────────── injected interfaces ─────────────────────────────

/** The subset of a Workers (hibernatable) WebSocket the room uses. */
export interface RoomSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
  /** 1 = OPEN. Optional so fakes can omit it (then the socket counts as open). */
  readonly readyState?: number;
}

export interface RoomStorage {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  deleteAll(): void | Promise<void>;
  setAlarm(at: number): void | Promise<void>;
}

export interface RoomDeps<S extends RoomSocket> {
  storage: RoomStorage;
  /** every socket accepted by this room (after hibernation: as restored by the runtime) */
  sockets(): S[];
  /** the shared clock (Date.now() in the Durable Object) */
  now(): number;
  /** random hex string of `bytes` bytes (defaults to crypto.getRandomValues) */
  randomHex?(bytes: number): string;
}

// ───────────────────────────── constants ─────────────────────────────

/** WebSocket close codes the server uses (4000-4999 is the application range). */
export const CLOSE = {
  notFound: 4404,
  full: 4409,
  hostTaken: 4403,
  kicked: 4401,
  /** the same seat connected again on another socket */
  replaced: 4000,
} as const;

/** A client that closes with this code + reason gives up its seat (a player's seat is freed). */
export const LEAVE_CLOSE_CODE = 1000;
export const LEAVE_CLOSE_REASON = 'leave';

/**
 * When a full room gets a new player, the seat of a player who has been disconnected for at least
 * this long is given away (oldest first). Shorter gaps (a locked phone, a tunnel) keep the seat.
 */
export const SEAT_HOLD_MS = 60_000;

const STORAGE_KEY = 'room';
const PHASES: readonly RoomPhase[] = ['lobby', 'loading', 'playing', 'results'];
const DIFFICULTIES: readonly Difficulty[] = ['chill', 'club', 'festival'];
const DEFAULT_DIFFICULTY: Difficulty = 'club';
const HOST_DEFAULT_NAME = 'DJ';

const FATAL_CLOSE: Partial<Record<ErrorCode, number>> = {
  'not-found': CLOSE.notFound,
  full: CLOSE.full,
  'host-taken': CLOSE.hostTaken,
  kicked: CLOSE.kicked,
};

// ───────────────────────────── stored state ─────────────────────────────

export interface Seat {
  pid: string;
  secret: string;
  name: string;
  role: Role;
  difficulty: Difficulty;
  seat: number;
  /** shared ms when the seat's last socket closed (null while connected or never connected) */
  leftAt: number | null;
}

export interface RoomRecord {
  v: 1;
  code: string;
  claimedAt: number;
  phase: RoomPhase;
  params?: GameParams;
  seats: Seat[];
  /** shared ms since which no socket is connected (null while any socket is open) */
  idleSince: number | null;
}

interface SocketData {
  /** connection id, unique per socket */
  cid: string;
  /** set once the socket was welcomed into a seat */
  pid?: string;
}

// ───────────────────────────── helpers ─────────────────────────────

const defaultRandomHex = (bytes: number): string => {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  let s = '';
  for (const b of a) s += b.toString(16).padStart(2, '0');
  return s;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const isDifficulty = (v: unknown): v is Difficulty => typeof v === 'string' && (DIFFICULTIES as readonly string[]).includes(v);

const isPhase = (v: unknown): v is RoomPhase => typeof v === 'string' && (PHASES as readonly string[]).includes(v);

const safeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

/** UTF-8 byte length of a string, without allocating for the common small case. */
export const utf8Length = (s: string): number => {
  if (s.length * 3 <= MAX_MESSAGE_BYTES) return s.length; // cannot exceed the limit: exact size irrelevant
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
};

/** Trim, collapse whitespace, drop control characters, at most MAX_NAME_LENGTH code points. */
export const cleanName = (raw: unknown): string => {
  if (typeof raw !== 'string') return '';
  const s = raw
    .normalize('NFC')
    .replace(/[\p{Cc}\u2028\u2029]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...s].slice(0, MAX_NAME_LENGTH).join('').trim();
};

/** `name`, or `name 2`, `name 3`… (shortened to fit) so no other seat has it (case-insensitive). */
export const uniqueName = (name: string, taken: Iterable<string>): string => {
  const used = new Set([...taken].map((n) => n.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const base = [...name].slice(0, MAX_NAME_LENGTH - suffix.length).join('').trimEnd();
    const candidate = base + suffix;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
};

// ───────────────────────────── the room ─────────────────────────────

export class RoomCore<S extends RoomSocket> {
  private rec: RoomRecord | null | undefined = undefined; // undefined = not loaded yet
  private readonly randomHex: (bytes: number) => string;

  constructor(private readonly deps: RoomDeps<S>) {
    this.randomHex = deps.randomHex ?? defaultRandomHex;
  }

  // ── lifecycle (HTTP side) ──

  /** Claim this (so far unused) room for `code`. False if the room is already in use. */
  claim(code: string): boolean {
    if (this.load()) return false;
    const now = this.deps.now();
    this.rec = { v: 1, code, claimedAt: now, phase: 'lobby', seats: [], idleSince: now };
    this.save();
    // a room nobody ever connects to expires like an abandoned one
    void this.deps.storage.setAlarm(now + ROOM_IDLE_TTL_MS);
    return true;
  }

  exists(): boolean {
    return this.load() !== null;
  }

  info(): RoomInfo | null {
    const rec = this.load();
    if (!rec) return null;
    const online = this.connectedPids();
    const host = rec.seats.find((s) => s.role === 'host');
    return {
      code: rec.code,
      phase: rec.phase,
      players: rec.seats.length,
      hostConnected: !!host && online.has(host.pid),
      full: this.isFull(rec, online),
    };
  }

  // ── sockets ──

  /**
   * A socket was accepted (the adapter called ctx.acceptWebSocket on it). Cancels a pending idle
   * deletion. The alarm itself stays armed as a watchdog (re-armed every ROOM_IDLE_TTL_MS while
   * sockets are open), because a runtime restart can drop sockets without any close event, and a
   * room with no alarm and no sockets would otherwise never be cleaned up.
   */
  accept(ws: S): void {
    const data: SocketData = { cid: this.randomHex(8) };
    ws.serializeAttachment(data);
    const rec = this.load();
    if (rec && rec.idleSince !== null) {
      rec.idleSince = null;
      this.save();
      void this.deps.storage.setAlarm(this.deps.now() + ROOM_IDLE_TTL_MS);
    }
  }

  message(ws: S, data: string | ArrayBuffer | ArrayBufferView): void {
    if (typeof data !== 'string') return this.error(ws, 'bad-message', 'binary messages are not supported');
    if (utf8Length(data) > MAX_MESSAGE_BYTES) return this.error(ws, 'bad-message', `message larger than ${MAX_MESSAGE_BYTES} bytes`);
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      return this.error(ws, 'bad-message', 'not JSON');
    }
    if (!isObject(msg) || typeof msg.t !== 'string') return this.error(ws, 'bad-message', 'expected an object with a string "t"');

    // clock sync works before hello, so a client can start syncing as soon as the socket opens
    if (msg.t === 'ping') {
      if (typeof msg.c !== 'number' || !Number.isFinite(msg.c)) return this.error(ws, 'bad-message', 'ping: c must be a number');
      return this.send(ws, { t: 'pong', c: msg.c, s: this.deps.now() });
    }

    const rec = this.load();
    if (!rec) return this.fatal(ws, 'not-found', 'this room does not exist any more');
    const att = this.attachment(ws);

    if (msg.t === 'hello') {
      if (att.pid) return this.error(ws, 'bad-message', 'already joined');
      return this.hello(ws, att, rec, msg);
    }

    const seat = att.pid ? rec.seats.find((s) => s.pid === att.pid) : undefined;
    if (!seat) return this.error(ws, 'bad-message', 'send hello first');

    switch (msg.t as ClientMsg['t']) {
      case 'me':
        return this.me(ws, rec, seat, msg);
      case 'phase':
        return this.phase(ws, rec, seat, msg);
      case 'cast':
        return this.cast(ws, rec, seat, msg);
      case 'send':
        return this.sendToHost(ws, seat, msg);
      case 'kick':
        return this.kick(ws, rec, seat, msg);
      default:
        return this.error(ws, 'bad-message', `unknown message type "${String(msg.t).slice(0, 32)}"`);
    }
  }

  /** The socket closed (or errored). `code`/`reason` as received from the client. */
  close(ws: S, code = 1006, reason = ''): void {
    const att = this.attachment(ws);
    const rec = this.load();
    if (rec && att.pid) {
      const pid = att.pid;
      try {
        ws.serializeAttachment({ cid: att.cid } satisfies SocketData); // a second close/error event is then a no-op
      } catch {
        // some runtimes refuse attachments on closed sockets; the exclusion below covers it
      }
      const seat = rec.seats.find((s) => s.pid === pid);
      if (seat && !this.connectedPids(ws).has(pid)) {
        if (code === LEAVE_CLOSE_CODE && reason === LEAVE_CLOSE_REASON && seat.role === 'player') {
          rec.seats = rec.seats.filter((s) => s !== seat);
        } else {
          seat.leftAt = this.deps.now();
        }
        this.save();
        this.broadcastPlayers(ws);
      }
    }
    this.checkIdle(ws);
  }

  /** The idle alarm fired: delete the room if it has been empty for ROOM_IDLE_TTL_MS, else re-arm. */
  alarm(): void | Promise<void> {
    const rec = this.load();
    if (!rec) return;
    const now = this.deps.now();
    if (this.live().length > 0) {
      // in use: just keep the watchdog going
      void this.deps.storage.setAlarm(now + ROOM_IDLE_TTL_MS);
      return;
    }
    const idleSince = rec.idleSince ?? now;
    if (rec.idleSince === null) {
      rec.idleSince = now;
      this.save();
    }
    if (now >= idleSince + ROOM_IDLE_TTL_MS) {
      this.rec = null;
      return this.deps.storage.deleteAll();
    }
    void this.deps.storage.setAlarm(idleSince + ROOM_IDLE_TTL_MS);
  }

  // ── messages ──

  private hello(ws: S, att: SocketData, rec: RoomRecord, msg: Record<string, unknown>): void {
    if (msg.role !== 'host' && msg.role !== 'player') return this.error(ws, 'bad-message', 'hello: role must be "host" or "player"');
    const role: Role = msg.role;
    const name = cleanName(msg.name);
    const difficulty = isDifficulty(msg.difficulty) ? msg.difficulty : undefined;

    let seat: Seat | undefined;
    if (typeof msg.pid === 'string' && typeof msg.secret === 'string') {
      const pid = msg.pid;
      const secret = msg.secret;
      seat = rec.seats.find((s) => s.pid === pid && safeEqual(s.secret, secret));
    }

    if (seat) {
      // reconnect: take the seat back (from a stale socket of the same seat, if any)
      for (const other of this.live(ws)) {
        if (this.attachment(other).pid === seat.pid) this.drop(other, CLOSE.replaced, 'replaced by a new connection');
      }
      seat.leftAt = null;
      if (name && name !== seat.name) seat.name = uniqueName(name, this.otherNames(rec, seat));
      if (difficulty) seat.difficulty = difficulty;
    } else if (role === 'host') {
      if (rec.seats.some((s) => s.role === 'host')) return this.fatal(ws, 'host-taken', 'this room already has a host');
      seat = this.newSeat(rec, 'host', 0, name || HOST_DEFAULT_NAME, difficulty);
    } else {
      const online = this.connectedPids(ws);
      if (rec.seats.filter((s) => s.role === 'player').length >= MAX_PLAYERS - 1) {
        const stale = this.staleSeat(rec, online);
        if (!stale) return this.fatal(ws, 'full', `this room is full (${MAX_PLAYERS} players)`);
        rec.seats = rec.seats.filter((s) => s !== stale);
      }
      const number = this.freeSeatNumber(rec);
      seat = this.newSeat(rec, 'player', number, name || `Player ${number}`, difficulty);
    }

    ws.serializeAttachment({ cid: att.cid, pid: seat.pid } satisfies SocketData);
    this.save();
    const welcome: ServerMsg = {
      t: 'welcome',
      code: rec.code,
      pid: seat.pid,
      secret: seat.secret,
      role: seat.role,
      players: this.playerList(),
      phase: rec.phase,
    };
    if (rec.params !== undefined) welcome.params = rec.params;
    this.send(ws, welcome);
    this.broadcastPlayers();
  }

  private me(ws: S, rec: RoomRecord, seat: Seat, msg: Record<string, unknown>): void {
    if (msg.name !== undefined && typeof msg.name !== 'string') return this.error(ws, 'bad-message', 'me: name must be a string');
    if (msg.difficulty !== undefined && !isDifficulty(msg.difficulty)) return this.error(ws, 'bad-message', 'me: unknown difficulty');
    let changed = false;
    if (typeof msg.name === 'string') {
      const name = cleanName(msg.name);
      // an empty name is ignored (keeps the current one)
      if (name && name !== seat.name) {
        const unique = uniqueName(name, this.otherNames(rec, seat));
        if (unique !== seat.name) {
          seat.name = unique;
          changed = true;
        }
      }
    }
    if (isDifficulty(msg.difficulty) && msg.difficulty !== seat.difficulty) {
      seat.difficulty = msg.difficulty;
      changed = true;
    }
    if (!changed) return;
    this.save();
    this.broadcastPlayers();
  }

  private phase(ws: S, rec: RoomRecord, seat: Seat, msg: Record<string, unknown>): void {
    if (seat.role !== 'host') return this.error(ws, 'not-allowed', 'only the host can change the phase');
    if (!isPhase(msg.phase)) return this.error(ws, 'bad-message', 'phase: unknown phase');
    if (msg.params !== undefined && !isObject(msg.params)) return this.error(ws, 'bad-message', 'phase: params must be an object');
    rec.phase = msg.phase;
    // params given: store them. Not given: keep the gig's params while it runs, clear them in the lobby.
    if (msg.params !== undefined) rec.params = msg.params as unknown as GameParams;
    else if (msg.phase === 'lobby') delete rec.params;
    this.save();
    const out: ServerMsg = { t: 'phase', phase: rec.phase };
    if (rec.params !== undefined) out.params = rec.params;
    this.broadcast(JSON.stringify(out));
  }

  private cast(ws: S, rec: RoomRecord, seat: Seat, msg: Record<string, unknown>): void {
    if (seat.role !== 'host') return this.error(ws, 'not-allowed', 'only the host can cast');
    if (!isObject(msg.m) || typeof msg.m.k !== 'string') return this.error(ws, 'bad-message', 'cast: m must be an object with a string "k"');
    if (msg.to !== undefined && typeof msg.to !== 'string') return this.error(ws, 'bad-message', 'cast: to must be a pid');
    const to = msg.to;
    if (to !== undefined && !rec.seats.some((s) => s.pid === to && s.role === 'player')) {
      return this.error(ws, 'bad-message', 'cast: no such player');
    }
    const data = JSON.stringify({ t: 'cast', m: msg.m });
    const players = new Set(rec.seats.filter((s) => s.role === 'player').map((s) => s.pid));
    for (const s of this.live()) {
      const pid = this.attachment(s).pid;
      if (pid && players.has(pid) && (to === undefined || pid === to)) this.sendRaw(s, data);
    }
  }

  private sendToHost(ws: S, seat: Seat, msg: Record<string, unknown>): void {
    if (seat.role !== 'player') return this.error(ws, 'not-allowed', 'only players can send to the host');
    if (!isObject(msg.m) || typeof msg.m.k !== 'string') return this.error(ws, 'bad-message', 'send: m must be an object with a string "k"');
    const host = this.load()?.seats.find((s) => s.role === 'host');
    if (!host) return;
    const data = JSON.stringify({ t: 'from', pid: seat.pid, m: msg.m });
    for (const s of this.live()) if (this.attachment(s).pid === host.pid) this.sendRaw(s, data);
  }

  private kick(ws: S, rec: RoomRecord, seat: Seat, msg: Record<string, unknown>): void {
    if (seat.role !== 'host') return this.error(ws, 'not-allowed', 'only the host can kick');
    if (typeof msg.pid !== 'string') return this.error(ws, 'bad-message', 'kick: pid must be a string');
    const target = rec.seats.find((s) => s.pid === msg.pid);
    if (!target) return this.error(ws, 'bad-message', 'kick: no such player');
    if (target.role === 'host') return this.error(ws, 'not-allowed', 'the host cannot be kicked');
    rec.seats = rec.seats.filter((s) => s !== target);
    this.save();
    for (const s of this.live()) {
      if (this.attachment(s).pid === target.pid) this.fatal(s, 'kicked', 'the host removed you from the room');
    }
    this.broadcastPlayers();
  }

  // ── state ──

  private load(): RoomRecord | null {
    if (this.rec === undefined) {
      const rec = this.deps.storage.get<RoomRecord>(STORAGE_KEY) ?? null;
      this.rec = rec;
      // belt and braces: an idle room whose alarm did not run yet is already gone
      if (rec && rec.idleSince !== null && this.deps.now() >= rec.idleSince + ROOM_IDLE_TTL_MS && this.live().length === 0) {
        this.rec = null;
        void this.deps.storage.deleteAll();
      }
    }
    return this.rec;
  }

  private save(): void {
    if (this.rec) this.deps.storage.put(STORAGE_KEY, this.rec);
  }

  private newSeat(rec: RoomRecord, role: Role, number: number, name: string, difficulty: Difficulty | undefined): Seat {
    let pid: string;
    do pid = this.randomHex(6);
    while (rec.seats.some((s) => s.pid === pid));
    const seat: Seat = {
      pid,
      secret: this.randomHex(16),
      name: uniqueName(name, rec.seats.map((s) => s.name)),
      role,
      difficulty: difficulty ?? DEFAULT_DIFFICULTY,
      seat: number,
      leftAt: null,
    };
    rec.seats.push(seat);
    rec.seats.sort((a, b) => a.seat - b.seat);
    return seat;
  }

  private freeSeatNumber(rec: RoomRecord): number {
    const used = new Set(rec.seats.map((s) => s.seat));
    let n = 1;
    while (used.has(n)) n++;
    return n;
  }

  private isFull(rec: RoomRecord, online: Set<string>): boolean {
    const players = rec.seats.filter((s) => s.role === 'player');
    if (players.length < MAX_PLAYERS - 1) return false; // one seat is always the host's
    return !this.staleSeat(rec, online);
  }

  /** The player seat disconnected longest ago, if that was at least SEAT_HOLD_MS ago. */
  private staleSeat(rec: RoomRecord, online: Set<string>): Seat | undefined {
    const now = this.deps.now();
    let best: Seat | undefined;
    for (const s of rec.seats) {
      if (s.role !== 'player' || online.has(s.pid) || s.leftAt === null || now - s.leftAt < SEAT_HOLD_MS) continue;
      if (!best || s.leftAt < (best.leftAt ?? 0)) best = s;
    }
    return best;
  }

  private otherNames(rec: RoomRecord, seat: Seat): string[] {
    return rec.seats.filter((s) => s !== seat).map((s) => s.name);
  }

  private playerList(exclude?: S): PlayerInfo[] {
    const rec = this.rec;
    if (!rec) return [];
    const online = this.connectedPids(exclude);
    return rec.seats.map((s) => ({
      pid: s.pid,
      name: s.name,
      role: s.role,
      connected: online.has(s.pid),
      difficulty: s.difficulty,
      seat: s.seat,
    }));
  }

  private checkIdle(exclude?: S): void {
    const rec = this.load();
    if (!rec || rec.idleSince !== null || this.live(exclude).length > 0) return;
    const now = this.deps.now();
    rec.idleSince = now;
    this.save();
    void this.deps.storage.setAlarm(now + ROOM_IDLE_TTL_MS);
  }

  // ── sockets ──

  private attachment(ws: S): SocketData {
    const a = ws.deserializeAttachment();
    if (isObject(a) && typeof a.cid === 'string') return { cid: a.cid, pid: typeof a.pid === 'string' ? a.pid : undefined };
    return { cid: '' };
  }

  /** Open sockets, optionally without `exclude` (the one that is closing). */
  private live(exclude?: S): S[] {
    const ex = exclude ? this.attachment(exclude).cid : undefined;
    return this.deps.sockets().filter((s) => {
      if (s === exclude) return false;
      if (s.readyState !== undefined && s.readyState !== 1) return false;
      return ex === undefined || ex === '' || this.attachment(s).cid !== ex;
    });
  }

  private connectedPids(exclude?: S): Set<string> {
    const set = new Set<string>();
    for (const s of this.live(exclude)) {
      const pid = this.attachment(s).pid;
      if (pid) set.add(pid);
    }
    return set;
  }

  private broadcastPlayers(exclude?: S): void {
    this.broadcast(JSON.stringify({ t: 'players', players: this.playerList(exclude) } satisfies ServerMsg), exclude);
  }

  /** to every welcomed socket */
  private broadcast(data: string, exclude?: S): void {
    for (const s of this.live(exclude)) if (this.attachment(s).pid) this.sendRaw(s, data);
  }

  private send(ws: S, msg: ServerMsg): void {
    this.sendRaw(ws, JSON.stringify(msg));
  }

  private sendRaw(ws: S, data: string): void {
    try {
      ws.send(data);
    } catch {
      // the socket is closing; its close event cleans up
    }
  }

  private error(ws: S, code: ErrorCode, message: string): void {
    this.send(ws, { t: 'error', code, message });
  }

  /** Send a fatal error and close the socket (it no longer holds a seat). */
  private fatal(ws: S, code: ErrorCode, message: string): void {
    this.error(ws, code, message);
    this.drop(ws, FATAL_CLOSE[code] ?? 4000, code);
  }

  private drop(ws: S, closeCode: number, reason: string): void {
    const att = this.attachment(ws);
    ws.serializeAttachment({ cid: att.cid } satisfies SocketData);
    try {
      ws.close(closeCode, reason);
    } catch {
      // already closing
    }
    this.checkIdle(ws);
  }
}
