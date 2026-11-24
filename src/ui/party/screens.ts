/**
 * Registers the party screens with the navigator, on whichever network module is handed in (the
 * real one from ./index.ts, or the pretend party from ./mock.ts in a harness).
 */
import './party.css';
import type { NavController } from '../../core/nav';
import type { AppContext } from '../../core/types';
import { createControllerScreen } from './controller';
import { createHubScreen } from './hub';
import { createLobbyScreen } from './lobby';
import type { PartyNet } from './net';

export function registerPartyScreensWith(ctx: AppContext & { nav: NavController }, net: PartyNet): void {
  const { nav } = ctx;
  nav.register('party', () => createHubScreen(ctx));
  nav.register('lobby', () => createLobbyScreen(ctx));
  nav.register('controller', () => createControllerScreen(ctx, net));
}
