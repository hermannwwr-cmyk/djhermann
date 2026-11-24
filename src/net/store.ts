/**
 * PartyStore: the (at most one) room this app is in. host() creates a room over HTTP and connects
 * as its host; join() checks the room over HTTP and connects as a player, or as the host again
 * when this tab holds the host's seat of that room (a reloaded host gets its room back by joining
 * its own code).
 */
import { RoomError, isRoomCode, normalizeRoomCode } from '../core/party';
import type { PartyStore, RoomClient, RoomInfo } from '../core/party';
import type { Difficulty } from '../core/types';
import { browserEnv } from './env';
import type { NetEnv } from './env';
import { openRoom } from './room';
import type { RoomClientImpl } from './room';
import { lastRoomIn, loadSeat } from './seat';

export interface PartyStoreImpl extends PartyStore {
  /** the room this tab was last in (code + role), from sessionStorage, to offer a rejoin */
  lastRoom(): { code: string; role: 'host' | 'player' } | null;
}

export function createPartyStore(envIn?: NetEnv): PartyStoreImpl {
  let env: NetEnv | null = envIn ?? null;
  const getEnv = (): NetEnv => (env ??= browserEnv());
  const subs = new Set<(room: RoomClient | null) => void>();
  let room: RoomClientImpl | null = null;
  let offRoom: (() => void) | null = null;
  /** bumps on every host/join/leave so a stale attempt never installs its room */
  let gen = 0;

  function notify(): void {
    for (const fn of [...subs]) {
      try {
        fn(room);
      } catch (err) {
        console.error('[net] party subscriber threw', err);
      }
    }
  }

  function setRoom(r: RoomClientImpl | null): void {
    offRoom?.();
    offRoom = null;
    room = r;
    if (r) {
      // a fatal error closes the room for good: drop it from the store (the 'error' event has been emitted)
      offRoom = r.on('status', ({ status }) => {
        if (status === 'closed' && room === r) {
          offRoom?.();
          offRoom = null;
          room = null;
          notify();
        }
      });
    }
    notify();
  }

  function dropCurrent(): void {
    gen++;
    const r = room;
    if (r) {
      setRoom(null);
      r.leave();
    }
  }

  async function http(url: string, method: 'GET' | 'POST'): Promise<{ status: number; body: unknown }> {
    const e = getEnv();
    let res;
    try {
      res = await e.fetch(`${e.origin}${url}`, {
        method,
        headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
        body: method === 'POST' ? '{}' : undefined,
      });
    } catch {
      throw new RoomError('network', 'No connection to the server.');
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  }

  async function connect(code: string, role: 'host' | 'player', opts: { name: string; difficulty: Difficulty }, myGen: number) {
    const e = getEnv();
    const seat = loadSeat(e.storage, code);
    const r = openRoom({
      env: e,
      code,
      role: seat?.role ?? role,
      name: opts.name,
      difficulty: opts.difficulty,
      seat,
    });
    if (myGen !== gen) {
      r.leave();
      throw new RoomError('network', 'Cancelled.');
    }
    setRoom(r);
    try {
      await r.ready;
    } catch (err) {
      if (room === r) setRoom(null);
      throw err;
    }
    if (myGen !== gen) {
      // left (or started another room) while connecting
      r.leave();
      throw new RoomError('network', 'Cancelled.');
    }
    return r;
  }

  const store: PartyStoreImpl = {
    get room() {
      return room;
    },

    async host(opts) {
      dropCurrent();
      const myGen = gen;
      const { status, body } = await http('/api/rooms', 'POST');
      const code = normalizeRoomCode(String((body as { code?: unknown } | null)?.code ?? ''));
      if (status < 200 || status >= 300 || !isRoomCode(code)) {
        throw new RoomError('network', `Could not create a room (${status}).`);
      }
      if (myGen !== gen) throw new RoomError('network', 'Cancelled.');
      return connect(code, 'host', opts, myGen);
    },

    async join(codeIn, opts) {
      dropCurrent();
      const myGen = gen;
      const code = normalizeRoomCode(codeIn);
      if (!isRoomCode(code)) throw new RoomError('not-found', 'That is not a room code.');
      const { status, body } = await http(`/api/rooms/${code}`, 'GET');
      if (status === 404) throw new RoomError('not-found', 'There is no room with that code.');
      if (status < 200 || status >= 300) throw new RoomError('network', `The server answered ${status}.`);
      const info = body as Partial<RoomInfo> | null;
      const seat = loadSeat(getEnv().storage, code);
      // a full room still lets a seat holder back in
      if (info?.full && !seat) throw new RoomError('full', 'That room is full.');
      if (myGen !== gen) throw new RoomError('network', 'Cancelled.');
      return connect(code, 'player', opts, myGen);
    },

    leave() {
      dropCurrent();
    },

    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },

    lastRoom() {
      return lastRoomIn(getEnv().storage);
    },
  };
  return store;
}
