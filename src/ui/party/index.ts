/**
 * Party mode screens (step 2): play together, one phone plays the music, every other phone is a
 * controller with its own notes and pads.
 *
 *   registerPartyScreens(ctx)   'party' (host or join), 'lobby' (the room), 'controller' (a player's game)
 *   createBoardChip(deps)       a compact live leaderboard for a corner of the host's playfield
 *   renderBoardList(board, me)  the full leaderboard (the host's results use it)
 *   roomParam(location.search)  the room code an invite link (?room=CODE) opened the page with
 */
import './party.css';
import type { NavController } from '../../core/nav';
import type { AppContext } from '../../core/types';
import { createPlayerReporter, createRemoteEngine } from '../../net';
import { registerPartyScreensWith } from './screens';

export { createBoardChip, renderBoardList } from './board';
export type { BoardChipDeps, BoardListOptions } from './board';
export { roomParam } from './logic';
export type { PartyNet } from './net';
export { registerPartyScreensWith } from './screens';

/** Registers 'party', 'lobby' and 'controller' with the navigator, on the real network module. */
export function registerPartyScreens(ctx: AppContext & { nav: NavController }): void {
  registerPartyScreensWith(ctx, { createRemoteEngine, createPlayerReporter });
}
