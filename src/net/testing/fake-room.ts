/**
 * A RoomClient with no network, for unit tests of the game integration (host link, remote engine,
 * reporter). The test drives it: emit() injects room events, `casts` / `sent` record what went out,
 * and the clock mapping is a plain function.
 */
import { Emitter } from '../../core/events';
import type { HostMsg, PlayerInfo, PlayerMsg, Role, RoomClient, RoomEvents, RoomPhase, RoomStatus } from '../../core/party';
import type { Difficulty, GameParams } from '../../core/types';

export interface FakeRoom extends RoomClient {
  emit<K extends keyof RoomEvents>(type: K, e: RoomEvents[K]): void;
  /** host casts, newest last */
  casts: { m: HostMsg; to?: string }[];
  /** player sends, newest last */
  sent: PlayerMsg[];
  phases: { phase: RoomPhase; params?: GameParams }[];
  setPlayers(players: PlayerInfo[]): void;
  setStatus(s: RoomStatus): void;
  /** override where casts go (e.g. into a simulated network) */
  onCast: ((m: HostMsg, to?: string) => void) | null;
  onSend: ((m: PlayerMsg) => void) | null;
}

export interface FakeRoomOptions {
  role: Role;
  pid?: string;
  /** this device's performance.now() */
  now: () => number;
  /** perf ms → shared ms (default: identity) */
  perfToShared?: (perfMs: number) => number;
  sharedToPerf?: (sharedMs: number) => number;
  players?: PlayerInfo[];
  phase?: RoomPhase;
}

export const fakePlayer = (pid: string, name: string, seat: number, role: Role = 'player', difficulty: Difficulty = 'club'): PlayerInfo => ({
  pid,
  name,
  role,
  connected: true,
  difficulty,
  seat,
});

export function createFakeRoom(opts: FakeRoomOptions): FakeRoom {
  const events = new Emitter<RoomEvents>();
  const toShared = opts.perfToShared ?? ((p: number) => p);
  const toPerf = opts.sharedToPerf ?? ((s: number) => s);
  let players = opts.players ?? [];
  let phase: RoomPhase = opts.phase ?? 'playing';
  let params: GameParams | undefined;
  let status: RoomStatus = 'open';
  const pid = opts.pid ?? (opts.role === 'host' ? 'host' : 'me');

  const room: FakeRoom = {
    code: 'TEST',
    role: opts.role,
    pid,
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
      return true;
    },
    clockReady: true,
    clockErrorMs: 1,
    now: () => toShared(opts.now()),
    perfToShared: toShared,
    sharedToPerf: toPerf,
    setMe() {},
    setPhase(p, prm) {
      phase = p;
      params = prm;
      room.phases.push({ phase: p, params: prm });
      events.emit('phase', { phase: p, params: prm });
    },
    cast(m, to) {
      if (opts.role !== 'host') return;
      room.casts.push(to ? { m, to } : { m });
      room.onCast?.(m, to);
    },
    kick() {},
    send(m) {
      if (opts.role !== 'player') return;
      room.sent.push(m);
      room.onSend?.(m);
    },
    on: (type, fn) => events.on(type, fn),
    leave() {
      status = 'closed';
    },
    emit: (type, e) => events.emit(type, e),
    casts: [],
    sent: [],
    phases: [],
    setPlayers(p) {
      players = p;
      events.emit('players', { players: p });
    },
    setStatus(s) {
      status = s;
      events.emit('status', { status: s });
    },
    onCast: null,
    onSend: null,
  };
  return room;
}
