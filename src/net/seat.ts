/**
 * The seat this tab holds in a room (pid + secret), kept in sessionStorage so a reload or a dropped
 * connection reclaims it. sessionStorage is per tab: two tabs on one phone are two players.
 */
import type { Role } from '../core/party';
import type { NetEnv } from './env';

export interface Seat {
  pid: string;
  secret: string;
  role: Role;
}

const SEAT_KEY = (code: string): string => `djh.party.seat.${code}`;
const LAST_KEY = 'djh.party.last';

type Store = NetEnv['storage'];

export function loadSeat(storage: Store, code: string): Seat | null {
  try {
    const raw = storage?.getItem(SEAT_KEY(code));
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<Seat>;
    if (typeof s.pid !== 'string' || typeof s.secret !== 'string' || (s.role !== 'host' && s.role !== 'player')) return null;
    return { pid: s.pid, secret: s.secret, role: s.role };
  } catch {
    return null;
  }
}

export function saveSeat(storage: Store, code: string, seat: Seat): void {
  try {
    storage?.setItem(SEAT_KEY(code), JSON.stringify(seat));
    storage?.setItem(LAST_KEY, JSON.stringify({ code, role: seat.role }));
  } catch {
    /* storage full or blocked: the seat just can't be reclaimed after a reload */
  }
}

export function forgetSeat(storage: Store, code: string): void {
  try {
    storage?.removeItem(SEAT_KEY(code));
    const last = lastRoomIn(storage);
    if (last && last.code === code) storage?.removeItem(LAST_KEY);
  } catch {
    /* ignore */
  }
}

export function lastRoomIn(storage: Store): { code: string; role: Role } | null {
  try {
    const raw = storage?.getItem(LAST_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { code?: unknown; role?: unknown };
    if (typeof v.code !== 'string' || (v.role !== 'host' && v.role !== 'player')) return null;
    return { code: v.code, role: v.role };
  } catch {
    return null;
  }
}
