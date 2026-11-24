/**
 * The room client: one WebSocket to a room, the shared clock, and automatic reconnection to the
 * same seat. Implements RoomClient (core/party.ts).
 *
 * Connection life: connecting → open (first welcome) → reconnecting ↔ open … → closed (leave() or a
 * fatal error). While open it pings (burst of 8, then every 0.5 s until the clock has 12 samples,
 * then every 2 s), and a socket that has said nothing for DEAD_MS is treated as dead and replaced.
 * When the page comes back to the foreground or the network changes, a probe ping must be answered
 * within PROBE_MS or the socket is replaced at once (a phone that switched Wi-Fi → 4G keeps a dead
 * socket open for a long time otherwise).
 */
import { Emitter } from '../core/events';
import { MAX_MESSAGE_BYTES, RoomError } from '../core/party';
import type {
  ClientMsg,
  ErrorCode,
  HostMsg,
  PlayerInfo,
  PlayerMsg,
  Role,
  RoomClient,
  RoomEvents,
  RoomPhase,
  RoomStatus,
  ServerMsg,
} from '../core/party';
import type { Difficulty, GameParams } from '../core/types';
import { ClockSync } from './clock';
import { WS_OPEN, roomSocketUrl } from './env';
import type { NetEnv, SocketLike, TimerId, WakeReason } from './env';
import { forgetSeat, saveSeat } from './seat';
import type { Seat } from './seat';

export const ROOM_NET = {
  burstCount: 8,
  burstSpacingMs: 50,
  pingFastMs: 500,
  pingSlowMs: 2000,
  /** ping fast until the clock has this many samples, or while its error is above poorErrorMs */
  fastUntilSamples: 12,
  poorErrorMs: 40,
  /** no message at all for this long → the socket is dead */
  deadMs: 4500,
  watchdogMs: 1000,
  /** after a wake-up (visible / online), the probe ping must be answered within this */
  probeMs: 1500,
  /** a socket that has not been welcomed within this is given up */
  connectTimeoutMs: 5000,
  /** reconnect delays (±20 % jitter); the last one repeats */
  backoffMs: [100, 300, 700, 1500, 3000, 5000],
  /** while reconnecting, ask over HTTP whether the room still exists after every this many failures */
  checkRoomEvery: 3,
  /** the first connection fails with RoomError('network') after this many failed attempts */
  initialAttempts: 3,
} as const;

const FATAL: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['not-found', 'full', 'host-taken', 'kicked']);

export interface OpenRoomOptions {
  env: NetEnv;
  code: string;
  role: Role;
  name: string;
  difficulty: Difficulty;
  /** a seat to reclaim (from sessionStorage) */
  seat?: Seat | null;
}

/** RoomClient plus handles the store and tests use. */
export interface RoomClientImpl extends RoomClient {
  /** resolves on the first welcome; rejects with RoomError (fatal error, or no connection) */
  readonly ready: Promise<RoomClientImpl>;
  readonly clock: ClockSync;
  /** check the connection now (what a 'visible' / 'online' event does) */
  wake(reason: WakeReason): void;
}

const samePhase = (a: RoomPhase, ap: GameParams | undefined, b: RoomPhase, bp: GameParams | undefined): boolean =>
  a === b && JSON.stringify(ap ?? null) === JSON.stringify(bp ?? null);

export function openRoom(opts: OpenRoomOptions): RoomClientImpl {
  const { env, code } = opts;
  const events = new Emitter<RoomEvents>();
  const clock = new ClockSync();
  const url = roomSocketUrl(env.origin, code);

  let role: Role = opts.role;
  let seat: Seat | null = opts.seat ?? null;
  let name = opts.name;
  let difficulty = opts.difficulty;
  let pid = '';
  let status: RoomStatus = 'connecting';
  let players: PlayerInfo[] = [];
  let phase: RoomPhase = 'lobby';
  let params: GameParams | undefined;
  /** host: this client has set the phase; it is the authority (re-sent if the server missed it) */
  let phaseSet = false;

  let sock: SocketLike | null = null;
  let welcomed = false;
  let everWelcomed = false;
  let closed = false;
  let retries = 0;
  let initialFailures = 0;
  let lastRx = 0;
  let pingsSent = 0;

  let retryTimer: TimerId | null = null;
  let connectTimer: TimerId | null = null;
  let pingTimer: TimerId | null = null;
  let watchdogTimer: TimerId | null = null;
  let probeTimer: TimerId | null = null;

  let resolveReady!: (r: RoomClientImpl) => void;
  let rejectReady!: (e: RoomError) => void;
  let settled = false;
  const ready = new Promise<RoomClientImpl>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  ready.catch(() => undefined); // nobody has to listen

  const clear = (id: TimerId | null): null => {
    if (id !== null) env.clearTimeout(id);
    return null;
  };
  function clearSocketTimers(): void {
    connectTimer = clear(connectTimer);
    pingTimer = clear(pingTimer);
    watchdogTimer = clear(watchdogTimer);
    probeTimer = clear(probeTimer);
  }

  function setStatus(s: RoomStatus): void {
    if (s === status) return;
    status = s;
    events.emit('status', { status: s });
  }

  function rawSend(msg: ClientMsg): boolean {
    if (!sock || sock.readyState !== WS_OPEN) return false;
    const data = JSON.stringify(msg);
    if (data.length > MAX_MESSAGE_BYTES) {
      console.warn(`[net] message too large (${data.length} bytes), not sent`, msg.t);
      return false;
    }
    try {
      sock.send(data);
      return true;
    } catch {
      return false;
    }
  }
  /** game messages only go out on a welcomed socket */
  const send = (msg: ClientMsg): boolean => welcomed && rawSend(msg);

  // ───────────── connection ─────────────

  function connect(): void {
    retryTimer = clear(retryTimer);
    if (closed) return;
    welcomed = false;
    let s: SocketLike;
    try {
      s = env.openSocket(url);
    } catch {
      sock = null;
      onLost();
      return;
    }
    sock = s;
    s.onopen = () => {
      if (s !== sock) return;
      lastRx = env.now();
      const hello: ClientMsg = { t: 'hello', role, name, difficulty };
      if (seat) {
        hello.pid = seat.pid;
        hello.secret = seat.secret;
      }
      rawSend(hello);
    };
    s.onmessage = (ev) => {
      if (s !== sock) return;
      lastRx = env.now();
      let msg: ServerMsg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) as ServerMsg;
      } catch {
        return;
      }
      handle(msg);
    };
    s.onclose = () => drop(s);
    s.onerror = () => drop(s);
    connectTimer = env.setTimeout(() => {
      if (s === sock && !welcomed) drop(s);
    }, ROOM_NET.connectTimeoutMs);
  }

  /** this socket is finished: clean it up and (unless we are done) try again */
  function drop(s: SocketLike): void {
    if (s !== sock) return;
    sock = null;
    welcomed = false;
    clearSocketTimers();
    s.onopen = s.onmessage = s.onclose = s.onerror = null;
    try {
      s.close();
    } catch {
      /* already closed */
    }
    onLost();
  }

  function onLost(): void {
    if (closed) return;
    if (!everWelcomed) {
      initialFailures++;
      if (initialFailures >= ROOM_NET.initialAttempts) {
        fail('network', 'Could not connect to the room.');
        return;
      }
    } else {
      setStatus('reconnecting');
      // several attempts failed: is the room still there? (it expires when nobody is connected)
      if (retries > 0 && retries % ROOM_NET.checkRoomEvery === 0) void checkRoomGone();
    }
    const steps = ROOM_NET.backoffMs;
    const base = steps[Math.min(retries, steps.length - 1)];
    retries++;
    retryTimer = env.setTimeout(connect, base * (0.8 + 0.4 * env.random()));
  }

  async function checkRoomGone(): Promise<void> {
    try {
      const res = await env.fetch(`${env.origin}/api/rooms/${encodeURIComponent(code)}`, { method: 'GET' });
      if (res.status === 404 && !closed && !welcomed) fail('not-found', 'The room has closed.');
    } catch {
      /* no network: keep trying */
    }
  }

  function fail(codeIn: ErrorCode | 'network', message: string): void {
    if (closed) return;
    closed = true;
    const s = sock;
    sock = null;
    welcomed = false;
    clearSocketTimers();
    retryTimer = clear(retryTimer);
    offWake();
    if (s) {
      s.onopen = s.onmessage = s.onclose = s.onerror = null;
      try {
        s.close(1000, codeIn);
      } catch {
        /* ignore */
      }
    }
    if (codeIn !== 'network') forgetSeat(env.storage, code);
    setStatus('closed');
    if (codeIn !== 'network') events.emit('error', { code: codeIn, message });
    if (!settled) {
      settled = true;
      rejectReady(new RoomError(codeIn, message));
    }
  }

  // ───────────── clock ─────────────

  function ping(): void {
    if (rawSend({ t: 'ping', c: env.now() })) pingsSent++;
  }

  function schedulePing(first: boolean): void {
    pingTimer = clear(pingTimer);
    if (first) pingsSent = 0;
    let delay: number;
    if (pingsSent < ROOM_NET.burstCount) delay = first ? 0 : ROOM_NET.burstSpacingMs;
    else {
      const poor = clock.sampleCount < ROOM_NET.fastUntilSamples || clock.errorMs > ROOM_NET.poorErrorMs;
      delay = poor ? ROOM_NET.pingFastMs : ROOM_NET.pingSlowMs;
    }
    pingTimer = env.setTimeout(() => {
      pingTimer = null;
      if (!welcomed) return;
      ping();
      schedulePing(false);
    }, delay);
  }

  function watchdog(): void {
    watchdogTimer = env.setTimeout(() => {
      watchdogTimer = null;
      if (!welcomed || !sock) return;
      if (env.now() - lastRx > ROOM_NET.deadMs) {
        drop(sock);
        return;
      }
      watchdog();
    }, ROOM_NET.watchdogMs);
  }

  // ───────────── messages ─────────────

  function handle(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome': {
        pid = msg.pid;
        role = msg.role;
        seat = { pid: msg.pid, secret: msg.secret, role: msg.role };
        saveSeat(env.storage, code, seat);
        welcomed = true;
        everWelcomed = true;
        retries = 0;
        initialFailures = 0;
        connectTimer = clear(connectTimer);
        players = msg.players ?? [];
        if (role === 'host' && phaseSet && !samePhase(phase, params, msg.phase, msg.params)) {
          // set while the socket was down (or lost with a dead socket): the host's word counts
          rawSend({ t: 'phase', phase, ...(params ? { params } : {}) });
        } else if (!samePhase(phase, params, msg.phase, msg.params)) {
          phase = msg.phase;
          params = msg.params;
          events.emit('phase', { phase, params });
        }
        events.emit('players', { players });
        setStatus('open');
        schedulePing(true);
        watchdogTimer = clear(watchdogTimer);
        watchdog();
        if (!settled) {
          settled = true;
          resolveReady(client);
        }
        break;
      }
      case 'pong':
        clock.add(msg.c, msg.s, env.now());
        break;
      case 'players':
        players = msg.players ?? [];
        events.emit('players', { players });
        break;
      case 'phase':
        if (!samePhase(phase, params, msg.phase, msg.params)) {
          phase = msg.phase;
          params = msg.params;
          events.emit('phase', { phase, params });
        }
        break;
      case 'cast':
        events.emit('cast', { m: msg.m });
        break;
      case 'from':
        events.emit('from', { pid: msg.pid, m: msg.m });
        break;
      case 'error':
        if (FATAL.has(msg.code)) fail(msg.code, msg.message);
        else console.warn(`[net] server: ${msg.code}: ${msg.message}`);
        break;
    }
  }

  // ───────────── wake-ups ─────────────

  function wake(_reason: WakeReason): void {
    if (closed) return;
    if (!sock) {
      // waiting out a backoff: try now, from the shortest delay again
      retries = 0;
      connect();
      return;
    }
    if (!welcomed) return; // a connection attempt is under way (it has its own timeout)
    const s = sock;
    const before = lastRx;
    ping();
    probeTimer = clear(probeTimer);
    probeTimer = env.setTimeout(() => {
      probeTimer = null;
      if (s === sock && lastRx === before) {
        retries = 0;
        drop(s);
      }
    }, ROOM_NET.probeMs);
  }
  const offWake = env.onWake(wake);

  // ───────────── public ─────────────

  const client: RoomClientImpl = {
    code,
    get role() {
      return role;
    },
    get pid() {
      return pid;
    },
    get status() {
      return status;
    },
    get players() {
      return players;
    },
    get phase() {
      return phase;
    },
    get params() {
      return params;
    },
    get me() {
      return players.find((p) => p.pid === pid);
    },
    get hostConnected() {
      if (role === 'host') return status === 'open';
      return players.some((p) => p.role === 'host' && p.connected);
    },
    get clockReady() {
      return clock.ready;
    },
    get clockErrorMs() {
      return clock.errorMs;
    },
    now: () => {
      const t = env.now();
      return t + clock.offset(t);
    },
    perfToShared: (perfMs) => perfMs + clock.offset(env.now()),
    sharedToPerf: (sharedMs) => sharedMs - clock.offset(env.now()),

    setMe(patch) {
      if (patch.name !== undefined) name = patch.name;
      if (patch.difficulty !== undefined) difficulty = patch.difficulty;
      send({ t: 'me', ...patch });
    },
    setPhase(p, prm) {
      if (role !== 'host' || closed) return;
      const changed = !samePhase(phase, params, p, prm);
      phase = p;
      params = prm;
      phaseSet = true;
      send({ t: 'phase', phase: p, ...(prm ? { params: prm } : {}) });
      if (changed) events.emit('phase', { phase, params });
    },
    cast(m: HostMsg, to?: string) {
      if (role !== 'host') return;
      send(to ? { t: 'cast', m, to } : { t: 'cast', m });
    },
    kick(target: string) {
      if (role !== 'host') return;
      send({ t: 'kick', pid: target });
    },
    send(m: PlayerMsg) {
      if (role !== 'player') return;
      send({ t: 'send', m });
    },
    on: (type, fn) => events.on(type, fn),
    leave() {
      if (closed) return;
      closed = true;
      const s = sock;
      sock = null;
      welcomed = false;
      clearSocketTimers();
      retryTimer = clear(retryTimer);
      offWake();
      if (s) {
        s.onopen = s.onmessage = s.onclose = s.onerror = null;
        try {
          s.close(1000, 'leave');
        } catch {
          /* ignore */
        }
      }
      forgetSeat(env.storage, code);
      setStatus('closed');
      if (!settled) {
        settled = true;
        rejectReady(new RoomError('network', 'Left the room.'));
      }
    },

    ready,
    clock,
    wake,
  };

  connect();
  return client;
}
