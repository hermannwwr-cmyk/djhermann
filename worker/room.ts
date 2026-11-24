/**
 * The room Durable Object: one instance per room code (idFromName(code)). A thin adapter that
 * wires the Workers runtime (hibernatable WebSockets, SQLite-backed storage, alarms) into
 * RoomCore, which holds all the logic.
 */
import { DurableObject } from 'cloudflare:workers';
import type { RoomInfo } from '../src/core/party';
import { RoomCore } from './room-core';
import type { Env } from './env';

export class Room extends DurableObject<Env> {
  private readonly core: RoomCore<WebSocket>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const storage = ctx.storage;
    this.core = new RoomCore<WebSocket>({
      storage: {
        // the synchronous KV API of SQLite-backed Durable Objects
        get: <T>(key: string) => storage.kv.get<T>(key),
        put: <T>(key: string, value: T) => storage.kv.put(key, value),
        deleteAll: () => storage.deleteAll(),
        setAlarm: (at) => storage.setAlarm(at),
      },
      sockets: () => ctx.getWebSockets(),
      now: () => Date.now(),
    });
  }

  // ── RPC from the Worker ──

  /** Claim this room for `code`. False if it is in use. */
  async claim(code: string): Promise<boolean> {
    return this.core.claim(code);
  }

  async info(): Promise<RoomInfo | null> {
    return this.core.info();
  }

  // ── WebSocket upgrade (forwarded by the Worker) ──

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected a WebSocket upgrade', { status: 426 });
    }
    if (!this.core.exists()) {
      return Response.json({ error: 'not-found' }, { status: 404 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server); // hibernatable: the object may sleep while sockets stay open
    this.core.accept(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ── hibernation API handlers ──

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.core.message(ws, message);
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    this.core.close(ws, code, reason);
    try {
      ws.close(1000, 'bye'); // complete the close handshake (a no-op where the runtime already did)
    } catch {
      // already closed
    }
  }

  override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    this.core.close(ws, 1006, '');
  }

  override async alarm(): Promise<void> {
    await this.core.alarm();
  }
}
