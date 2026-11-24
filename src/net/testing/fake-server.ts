/**
 * An in-memory implementation of the party server protocol (core/party.ts), for tests and dev
 * pages: the HTTP API and the room WebSocket, transport-agnostic. testing/network.ts connects
 * simulated devices to it over simulated links.
 *
 * Behaviour (what the real worker is expected to do too):
 * - POST /api/rooms creates an empty room; the first hello with role 'host' takes the host seat.
 * - hello with the pid + secret of an existing seat reclaims it (also while the old socket still
 *   looks connected: that one is closed), keeping its role and seat number.
 * - a second host → 'host-taken'; a new player when MAX_PLAYERS seats are taken → 'full'.
 *   Disconnected players keep their seat (and count towards full) until kicked.
 * - phase is stored and broadcast to everyone (the host included); late joiners get it in welcome.
 * - 'cast' goes to every connected player (or to one), 'send' to the host as 'from'.
 * - fatal errors are followed by a close.
 */
import { MAX_MESSAGE_BYTES, MAX_NAME_LENGTH, MAX_PLAYERS, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, isRoomCode } from '../../core/party';
import type { ClientMsg, ErrorCode, PlayerInfo, RoomInfo, RoomPhase, ServerMsg } from '../../core/party';
import type { Difficulty, GameParams } from '../../core/types';
import { rng } from '../../core/math';

/** How the server talks to one connected socket. */
export interface ServerConn {
  send(text: string): void;
  close(code: number, reason: string): void;
}

/** What the transport calls on the server for one socket. */
export interface ServerSocketHandler {
  message(text: string): void;
  close(): void;
}

interface Seat {
  info: PlayerInfo;
  secret: string;
  conn: ServerConn | null;
}

interface Room {
  code: string;
  phase: RoomPhase;
  params?: GameParams;
  seats: Map<string, Seat>;
  nextSeat: number;
  lastActive: number;
}

export interface FakeServerOptions {
  /** the server's Date.now() */
  now: () => number;
  seed?: number;
}

export interface FakeHttpResponse {
  status: number;
  body: unknown;
}

const DIFFICULTIES: readonly Difficulty[] = ['chill', 'club', 'festival'];
const PHASES: readonly RoomPhase[] = ['lobby', 'loading', 'playing', 'results'];

export class FakePartyServer {
  readonly rooms = new Map<string, Room>();
  /** every message received (for assertions) */
  readonly log: { code: string; pid: string; msg: ClientMsg }[] = [];
  logMessages = false;
  private readonly rand: () => number;

  constructor(private readonly opts: FakeServerOptions) {
    this.rand = rng(opts.seed ?? 42);
  }

  private newCode(): string {
    for (;;) {
      let c = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) c += ROOM_CODE_ALPHABET[Math.floor(this.rand() * ROOM_CODE_ALPHABET.length)];
      if (!this.rooms.has(c)) return c;
    }
  }

  private token(n: number): string {
    let s = '';
    for (let i = 0; i < n; i++) s += Math.floor(this.rand() * 36).toString(36);
    return s;
  }

  createRoom(): string {
    const code = this.newCode();
    this.rooms.set(code, { code, phase: 'lobby', seats: new Map(), nextSeat: 1, lastActive: this.opts.now() });
    return code;
  }

  info(code: string): RoomInfo | null {
    const r = this.rooms.get(code);
    if (!r) return null;
    const seats = [...r.seats.values()];
    return {
      code,
      phase: r.phase,
      players: seats.length,
      hostConnected: seats.some((s) => s.info.role === 'host' && s.conn !== null),
      full: seats.length >= MAX_PLAYERS,
    };
  }

  /** The HTTP API. Unknown paths → 404. */
  http(method: string, path: string): FakeHttpResponse {
    const p = path.replace(/[?#].*$/, '').replace(/\/+$/, '');
    if (p === '/api/rooms' && method === 'POST') return { status: 201, body: { code: this.createRoom() } };
    const m = /^\/api\/rooms\/([^/]+)$/.exec(p);
    if (m && method === 'GET') {
      const info = this.info(decodeURIComponent(m[1]).toUpperCase());
      return info ? { status: 200, body: info } : { status: 404, body: { error: 'not-found' } };
    }
    return { status: 404, body: { error: 'not-found' } };
  }

  /** A WebSocket upgrade on `path`. null = 404 (no such room). */
  accept(path: string, conn: ServerConn): ServerSocketHandler | null {
    const m = /^\/api\/rooms\/([^/]+)\/ws$/.exec(path.replace(/[?#].*$/, ''));
    const code = m ? decodeURIComponent(m[1]).toUpperCase() : '';
    const room = isRoomCode(code) ? this.rooms.get(code) : undefined;
    if (!room) return null;
    let me: Seat | null = null;
    const send = (msg: ServerMsg): void => {
      try {
        conn.send(JSON.stringify(msg));
      } catch {
        /* gone */
      }
    };
    const fatal = (code: ErrorCode, message: string): void => {
      send({ t: 'error', code, message });
      conn.close(4000, code);
    };
    return {
      message: (text) => {
        room.lastActive = this.opts.now();
        if (text.length > MAX_MESSAGE_BYTES) {
          send({ t: 'error', code: 'bad-message', message: 'too large' });
          return;
        }
        let msg: ClientMsg;
        try {
          msg = JSON.parse(text) as ClientMsg;
        } catch {
          send({ t: 'error', code: 'bad-message', message: 'not JSON' });
          return;
        }
        if (this.logMessages) this.log.push({ code: room.code, pid: me?.info.pid ?? '', msg });
        if (msg.t === 'ping') {
          send({ t: 'pong', c: msg.c, s: this.opts.now() });
          return;
        }
        if (msg.t === 'hello') {
          if (me) return; // only once
          me = this.hello(room, msg, conn, fatal);
          if (!me) return;
          send({
            t: 'welcome',
            code: room.code,
            pid: me.info.pid,
            secret: me.secret,
            role: me.info.role,
            players: this.playerList(room),
            phase: room.phase,
            ...(room.params ? { params: room.params } : {}),
          });
          this.broadcastPlayers(room, me);
          return;
        }
        if (!me || me.conn !== conn) {
          send({ t: 'error', code: 'not-allowed', message: 'say hello first' });
          return;
        }
        this.handle(room, me, msg, send);
      },
      close: () => {
        if (me && me.conn === conn) {
          me.conn = null;
          me.info = { ...me.info, connected: false };
          this.broadcastPlayers(room, null);
        }
      },
    };
  }

  private hello(
    room: Room,
    msg: Extract<ClientMsg, { t: 'hello' }>,
    conn: ServerConn,
    fatal: (code: ErrorCode, message: string) => void,
  ): Seat | null {
    const name = String(msg.name ?? '').slice(0, MAX_NAME_LENGTH) || 'Player';
    const difficulty = DIFFICULTIES.includes(msg.difficulty) ? msg.difficulty : 'club';
    if (msg.pid && msg.secret) {
      const seat = room.seats.get(msg.pid);
      if (seat && seat.secret === msg.secret) {
        const old = seat.conn;
        seat.conn = conn;
        seat.info = { ...seat.info, name, difficulty, connected: true };
        if (old && old !== conn) old.close(4001, 'replaced');
        return seat;
      }
    }
    const seats = [...room.seats.values()];
    if (msg.role === 'host') {
      if (seats.some((s) => s.info.role === 'host')) {
        fatal('host-taken', 'This room already has a host.');
        return null;
      }
    } else if (seats.length >= MAX_PLAYERS) {
      fatal('full', 'This room is full.');
      return null;
    }
    const pid = this.token(8);
    const seat: Seat = {
      info: {
        pid,
        name,
        role: msg.role === 'host' ? 'host' : 'player',
        connected: true,
        difficulty,
        seat: msg.role === 'host' ? 0 : room.nextSeat++,
      },
      secret: this.token(16),
      conn,
    };
    room.seats.set(pid, seat);
    return seat;
  }

  private handle(room: Room, me: Seat, msg: ClientMsg, send: (m: ServerMsg) => void): void {
    const isHost = me.info.role === 'host';
    switch (msg.t) {
      case 'me': {
        const patch: Partial<PlayerInfo> = {};
        if (typeof msg.name === 'string') patch.name = msg.name.slice(0, MAX_NAME_LENGTH) || me.info.name;
        if (msg.difficulty && DIFFICULTIES.includes(msg.difficulty)) patch.difficulty = msg.difficulty;
        me.info = { ...me.info, ...patch };
        this.broadcastPlayers(room, null);
        return;
      }
      case 'phase':
        if (!isHost) return send({ t: 'error', code: 'not-allowed', message: 'host only' });
        if (!PHASES.includes(msg.phase)) return send({ t: 'error', code: 'bad-message', message: 'phase' });
        room.phase = msg.phase;
        room.params = msg.params;
        for (const s of room.seats.values()) {
          if (s.conn) s.conn.send(JSON.stringify({ t: 'phase', phase: room.phase, ...(room.params ? { params: room.params } : {}) }));
        }
        return;
      case 'cast': {
        if (!isHost) return send({ t: 'error', code: 'not-allowed', message: 'host only' });
        const text = JSON.stringify({ t: 'cast', m: msg.m });
        for (const s of room.seats.values()) {
          if (s.info.role !== 'player' || !s.conn) continue;
          if (msg.to && s.info.pid !== msg.to) continue;
          s.conn.send(text);
        }
        return;
      }
      case 'send': {
        if (isHost) return send({ t: 'error', code: 'not-allowed', message: 'players only' });
        const host = [...room.seats.values()].find((s) => s.info.role === 'host');
        host?.conn?.send(JSON.stringify({ t: 'from', pid: me.info.pid, m: msg.m }));
        return;
      }
      case 'kick': {
        if (!isHost) return send({ t: 'error', code: 'not-allowed', message: 'host only' });
        const target = room.seats.get(msg.pid);
        if (!target || target === me) return;
        room.seats.delete(msg.pid);
        if (target.conn) {
          target.conn.send(JSON.stringify({ t: 'error', code: 'kicked', message: 'The host removed you.' }));
          target.conn.close(4000, 'kicked');
        }
        this.broadcastPlayers(room, null);
        return;
      }
      default:
        send({ t: 'error', code: 'bad-message', message: 'unknown message' });
    }
  }

  private playerList(room: Room): PlayerInfo[] {
    return [...room.seats.values()].map((s) => s.info).sort((a, b) => a.seat - b.seat);
  }

  /** 'players' to everyone connected except `except` (who got a welcome) */
  private broadcastPlayers(room: Room, except: Seat | null): void {
    const text = JSON.stringify({ t: 'players', players: this.playerList(room) });
    for (const s of room.seats.values()) {
      if (s === except || !s.conn) continue;
      s.conn.send(text);
    }
  }
}
