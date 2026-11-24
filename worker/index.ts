/**
 * The djhermann Worker. Only /api/* reaches this script (assets.run_worker_first in
 * wrangler.jsonc, plus asset misses that are not navigations); the game itself is served
 * straight from the static assets.
 *
 * POST /api/rooms            → 201 { code }          create a room (the creator connects as host)
 * GET  /api/rooms/:code      → 200 RoomInfo | 404
 * GET  /api/rooms/:code/ws   → 101 WebSocket | 404 (unknown/expired room) | 426 (no Upgrade header)
 * any other /api/*           → 404 (405 for a known path with the wrong method)
 * everything else            → env.ASSETS (the game, with the SPA fallback)
 */
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, isRoomCode } from '../src/core/party';
import type { Env } from './env';

export { Room } from './room';

const CLAIM_ATTEMPTS = 16;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });

const apiError = (status: number, error: string, headers: Record<string, string> = {}): Response =>
  json({ error }, status, headers);

export const randomRoomCode = (): string => {
  const r = new Uint32Array(ROOM_CODE_LENGTH);
  crypto.getRandomValues(r);
  let code = '';
  for (const n of r) code += ROOM_CODE_ALPHABET[n % ROOM_CODE_ALPHABET.length];
  return code;
};

const roomStub = (env: Env, code: string) => env.ROOMS.get(env.ROOMS.idFromName(code));

async function createRoom(env: Env): Promise<Response> {
  for (let i = 0; i < CLAIM_ATTEMPTS; i++) {
    const code = randomRoomCode();
    if (await roomStub(env, code).claim(code)) return json({ code }, 201);
  }
  return apiError(503, 'no free room code, try again');
}

async function handleApi(request: Request, env: Env, path: string): Promise<Response> {
  if (path === '/api/rooms' || path === '/api/rooms/') {
    if (request.method !== 'POST') return apiError(405, 'method not allowed', { Allow: 'POST' });
    return createRoom(env);
  }

  const m = /^\/api\/rooms\/([^/]+)(\/ws)?\/?$/.exec(path);
  if (!m) return apiError(404, 'not-found');
  const code = m[1];
  const ws = m[2] !== undefined;
  if (request.method !== 'GET' && request.method !== 'HEAD') return apiError(405, 'method not allowed', { Allow: 'GET' });
  if (!isRoomCode(code)) return apiError(404, 'not-found');

  if (ws) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return apiError(426, 'expected a WebSocket upgrade', { Upgrade: 'websocket' });
    }
    return roomStub(env, code).fetch(request); // the room answers 101, or 404 if it does not exist
  }

  const info = await roomStub(env, code).info();
  return info ? json(info) : apiError(404, 'not-found');
}

export default {
  async fetch(request, env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/api' || path.startsWith('/api/')) return handleApi(request, env, path);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
