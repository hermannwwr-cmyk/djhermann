/**
 * The pieces of the network module the party screens need, injected so the screens can run on
 * the real module (src/net, wired in ./index.ts) or on the pretend party (./mock.ts) in a harness.
 */
import type { PlayerReporter, PlayerReporterDeps, RemoteEngine, RemoteEngineDeps } from '../../core/party';

export interface PartyNet {
  createRemoteEngine(deps: RemoteEngineDeps): RemoteEngine;
  createPlayerReporter(deps: PlayerReporterDeps): PlayerReporter;
}
