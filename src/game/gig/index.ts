/**
 * The game director. `createGig` runs a gig (missions, hype, score, results), the guided tutorial
 * (params.tutorial) or a free-play session (params.mode === 'free'). No UI in here: the HUD draws
 * `getHud()`, the guide spotlights the controls named in the active mission.
 */
import type { GigController } from '../../core/types';
import { createDirector } from './director';
import type { GigDeps } from './director';
import { createFreePlay } from './freeplay';

export type { GigDeps } from './director';
export { TUNING } from './tuning';
export { TEXT } from './text';

export function createGig(deps: GigDeps): GigController {
  return deps.params.mode === 'free' ? createFreePlay(deps) : createDirector(deps);
}
