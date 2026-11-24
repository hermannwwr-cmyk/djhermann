/**
 * Simulated devices on simulated links to a FakePartyServer, on a SimScheduler. Each device gets a
 * NetEnv (its own performance.now() origin, timers, fetch, WebSockets, sessionStorage, wake-ups)
 * that the real room client runs on unchanged.
 *
 * A link has a one-way delay function per direction (called per message, so it can jitter); delivery
 * is in order per socket and direction, like TCP. `cut` makes the link silently drop everything and
 * hang new connections (a phone that walked out of Wi-Fi range).
 */
import type { HttpResponseLike, NetEnv, SocketLike, WakeReason } from '../env';
import type { FakePartyServer, ServerConn, ServerSocketHandler } from './fake-server';
import type { SimScheduler } from './sim';

export interface Link {
  /** client → server delay in ms for a message sent now */
  up: () => number;
  /** server → client */
  down: () => number;
  cut: boolean;
}

export interface SimDevice {
  env: NetEnv;
  link: Link;
  /** this device's performance.now() */
  perf(): number;
  /** fire the page's wake-up signals (visibilitychange → visible, online …) */
  wake(reason: WakeReason): void;
  /** sockets this device opened, newest last */
  readonly sockets: FakeSocket[];
  storage: Map<string, string>;
}

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

export class FakeSocket implements SocketLike {
  readyState = CONNECTING;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  private server: ServerSocketHandler | null = null;
  private upFree = 0;
  private downFree = 0;
  /** messages the client sent / received (counts, for assertions) */
  sent = 0;
  received = 0;
  /** this one connection is dead (the phone changed networks): everything on it is lost silently */
  dead = false;

  constructor(
    readonly url: string,
    private readonly sched: SimScheduler,
    private readonly srv: FakePartyServer,
    private readonly link: Link,
  ) {
    if (link.cut) return; // hangs: never opens (the client's connect timeout handles it)
    const path = url.replace(/^wss?:\/\/[^/]+/, '');
    const rtt = link.up() + link.down();
    sched.setTimeout(() => {
      if (this.readyState !== CONNECTING) return;
      if (this.link.cut) return;
      const conn: ServerConn = {
        send: (text) => this.deliverDown(text),
        close: (code, reason) => this.serverClose(code, reason),
      };
      this.server = this.srv.accept(path, conn);
      if (!this.server) {
        this.readyState = CLOSED;
        this.onerror?.({});
        this.onclose?.({ code: 1006, reason: '' });
        return;
      }
      this.readyState = OPEN;
      this.onopen?.({});
    }, rtt);
  }

  /** ordered delivery time for a message sent now */
  private when(dir: 'up' | 'down'): number {
    const d = dir === 'up' ? this.link.up() : this.link.down();
    const t = this.sched.t + Math.max(0, d);
    if (dir === 'up') return (this.upFree = Math.max(this.upFree, t));
    return (this.downFree = Math.max(this.downFree, t));
  }

  send(data: string): void {
    if (this.readyState === CONNECTING) throw new Error('InvalidStateError: still connecting');
    if (this.readyState !== OPEN) return;
    this.sent++;
    if (this.link.cut || this.dead) return;
    const srv = this.server;
    this.sched.at(this.when('up'), () => {
      if (srv && this.readyState !== CLOSED && !this.dead) srv.message(data);
    });
  }

  private deliverDown(text: string): void {
    if (this.link.cut || this.dead || this.readyState === CLOSED) return;
    this.sched.at(this.when('down'), () => {
      if (this.readyState !== OPEN || this.dead) return;
      this.received++;
      this.onmessage?.({ data: text });
    });
  }

  private serverClose(code: number, reason: string): void {
    const srv = this.server;
    this.server = null;
    srv?.close();
    if (this.link.cut || this.dead) return; // the client never hears about it
    this.sched.at(this.when('down'), () => {
      if (this.readyState === CLOSED) return;
      this.readyState = CLOSED;
      this.onclose?.({ code, reason });
    });
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === CLOSING || this.readyState === CLOSED) return;
    const wasConnecting = this.readyState === CONNECTING;
    this.readyState = CLOSING;
    const srv = this.server;
    this.server = null;
    if (srv && !this.link.cut && !this.dead) this.sched.at(this.when('up'), () => srv.close());
    this.sched.setTimeout(() => {
      this.readyState = CLOSED;
      this.onclose?.({ code: wasConnecting ? 1006 : code, reason });
    }, 1);
  }

  /** kill this connection silently (no close on either side), like a phone switching Wi-Fi → 4G */
  kill(): void {
    this.dead = true;
  }

  /** the server side forgets this socket without telling anyone (for "server noticed the drop" tests) */
  serverDrop(): void {
    const srv = this.server;
    this.server = null;
    srv?.close();
  }
}

export interface DeviceOptions {
  /** this device's performance.now() at sim time 0 */
  perfOrigin: number;
  up?: () => number;
  down?: () => number;
  origin?: string;
  random?: () => number;
}

export function createSimNetwork(sched: SimScheduler, server: FakePartyServer) {
  function device(opts: DeviceOptions): SimDevice {
    const link: Link = { up: opts.up ?? (() => 10), down: opts.down ?? (() => 10), cut: false };
    const storage = new Map<string, string>();
    const wakeFns = new Set<(r: WakeReason) => void>();
    const sockets: FakeSocket[] = [];
    const perf = (): number => sched.t + opts.perfOrigin;
    const env: NetEnv = {
      now: perf,
      setTimeout: (fn, ms) => sched.setTimeout(fn, ms),
      clearTimeout: (id) => sched.clearTimeout(id),
      fetch(url, init) {
        return new Promise<HttpResponseLike>((resolve, reject) => {
          if (link.cut) {
            sched.setTimeout(() => reject(new TypeError('Failed to fetch')), 1000);
            return;
          }
          const path = url.replace(/^https?:\/\/[^/]+/, '');
          const res = server.http(init?.method ?? 'GET', path);
          sched.setTimeout(
            () =>
              resolve({
                ok: res.status >= 200 && res.status < 300,
                status: res.status,
                json: async () => res.body,
              }),
            link.up() + link.down(),
          );
        });
      },
      openSocket(url) {
        const s = new FakeSocket(url, sched, server, link);
        sockets.push(s);
        return s;
      },
      origin: opts.origin ?? 'https://party.test',
      storage: {
        getItem: (k) => storage.get(k) ?? null,
        setItem: (k, v) => void storage.set(k, v),
        removeItem: (k) => void storage.delete(k),
      },
      onWake(fn) {
        wakeFns.add(fn);
        return () => void wakeFns.delete(fn);
      },
      random: opts.random ?? (() => 0.5),
    };
    return {
      env,
      link,
      perf,
      wake: (r) => {
        for (const fn of [...wakeFns]) fn(r);
      },
      sockets,
      storage,
    };
  }
  return { device };
}

/** Let pending promise callbacks run (fetch resolutions etc.) between sim steps. */
export const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** Advance the sim in small steps, letting promises settle in between. */
export async function runFor(sched: SimScheduler, ms: number, step = 5): Promise<void> {
  const end = sched.t + ms;
  while (sched.t < end) {
    sched.runUntil(Math.min(end, sched.t + step));
    await flushMicrotasks();
  }
}
