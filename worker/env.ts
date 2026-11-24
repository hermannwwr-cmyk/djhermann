import type { Room } from './room';

/** Bindings declared in wrangler.jsonc. */
export interface Env {
  /** the built game (dist/) */
  ASSETS: Fetcher;
  /** one Durable Object per room, addressed by idFromName(code) */
  ROOMS: DurableObjectNamespace<Room>;
}
