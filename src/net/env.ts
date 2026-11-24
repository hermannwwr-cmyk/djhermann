/**
 * Everything the room client needs from the platform, injectable so tests can run it against a
 * simulated network and a virtual clock (see testing/). browserEnv() is the real thing.
 */

/** The subset of a browser WebSocket the client uses. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface HttpResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type TimerId = unknown;

/** Why the client should check its connection right now. */
export type WakeReason = 'visible' | 'online' | 'network-change';

export interface NetEnv {
  /** performance.now() */
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerId;
  clearTimeout(id: TimerId): void;
  fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<HttpResponseLike>;
  openSocket(url: string): SocketLike;
  /** http(s)://host[:port] the API lives on */
  origin: string;
  /** sessionStorage (or null when it is unavailable) */
  storage: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } | null;
  /** page became visible / network came back / changed. Returns an unsubscribe function. */
  onWake(fn: (reason: WakeReason) => void): () => void;
  random(): number;
}

export const WS_OPEN = 1;

function safeSessionStorage(): NetEnv['storage'] {
  try {
    const s = window.sessionStorage;
    const k = '__djh_probe';
    s.setItem(k, '1');
    s.removeItem(k);
    return s;
  } catch {
    return null; // private mode, blocked storage
  }
}

export function browserEnv(): NetEnv {
  return {
    now: () => performance.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (id) => window.clearTimeout(id as number),
    fetch: (url, init) => fetch(url, { ...init, cache: 'no-store' }),
    openSocket: (url) => new WebSocket(url) as unknown as SocketLike,
    origin: location.origin,
    storage: safeSessionStorage(),
    onWake(fn) {
      const onVis = (): void => {
        if (document.visibilityState === 'visible') fn('visible');
      };
      const onOnline = (): void => fn('online');
      const onPageShow = (e: PageTransitionEvent): void => {
        if (e.persisted) fn('visible'); // back from the bfcache
      };
      const conn = (navigator as unknown as { connection?: EventTarget }).connection;
      const onConn = (): void => fn('network-change');
      document.addEventListener('visibilitychange', onVis);
      window.addEventListener('online', onOnline);
      window.addEventListener('pageshow', onPageShow);
      conn?.addEventListener?.('change', onConn);
      return () => {
        document.removeEventListener('visibilitychange', onVis);
        window.removeEventListener('online', onOnline);
        window.removeEventListener('pageshow', onPageShow);
        conn?.removeEventListener?.('change', onConn);
      };
    },
    random: Math.random,
  };
}

/** ws(s)://host/api/rooms/CODE/ws for an http(s) origin. */
export function roomSocketUrl(origin: string, code: string): string {
  return `${origin.replace(/^http/, 'ws')}/api/rooms/${encodeURIComponent(code)}/ws`;
}
