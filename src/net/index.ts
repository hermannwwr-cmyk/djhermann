/**
 * Networking for party mode (step 2): the room client + party store, the shared clock, and the game
 * integration (host link, remote engine, player reporter). Contract: src/core/party.ts.
 */
export { createPartyStore } from './store';
export type { PartyStoreImpl } from './store';
export { createHostLink, HOST } from './host-link';
export type { HostLinkImpl } from './host-link';
export { createRemoteEngine, shapeAudibility, REMOTE } from './remote-engine';
export type { RemoteEngineImpl, RemoteEngineOptions } from './remote-engine';
export { createPlayerReporter } from './reporter';

// lower-level pieces (tests, dev pages)
export { openRoom, ROOM_NET } from './room';
export type { OpenRoomOptions, RoomClientImpl } from './room';
export { ClockSync, CLOCK, clockSample, estimateClock } from './clock';
export type { ClockSample, ClockEstimate } from './clock';
export { DeckFollower, FOLLOW } from './follow';
export { browserEnv, roomSocketUrl } from './env';
export type { NetEnv, SocketLike, WakeReason } from './env';
export { energyToWire, energyFromWire, remoteTrack } from './wire';
export { loadSeat, saveSeat, forgetSeat, lastRoomIn } from './seat';
