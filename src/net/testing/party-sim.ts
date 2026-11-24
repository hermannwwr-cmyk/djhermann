/**
 * A host and players without a server: the host's mock engine + frame loop + host link, its casts
 * delivered to each player's remote engine over a jittery, ordered link, every device on its own
 * performance.now() origin and clock error. Used by the remote engine tests to measure how well a
 * player's playhead follows the host's.
 */
import { createGameBus } from '../../core/events';
import { createFrameLoop } from '../../core/frame';
import type { FrameLoop } from '../../core/frame';
import { rng } from '../../core/math';
import type { HostMsg } from '../../core/party';
import type { RhythmController, RhythmStats } from '../../core/types';
import { createMockEngine } from '../../dev/mock-engine';
import type { MockEngine } from '../../dev/mock-engine';
import { mockHud } from '../../dev/mocks';
import { createHostLink } from '../host-link';
import type { HostLinkImpl } from '../host-link';
import { createRemoteEngine } from '../remote-engine';
import type { RemoteEngineImpl } from '../remote-engine';
import { createFakeRoom, fakePlayer } from './fake-room';
import type { FakeRoom } from './fake-room';
import type { SimScheduler } from './sim';

export const SHARED0 = 1_760_000_000_000;

export function fakeRhythm(density = 0.6, stats?: Partial<RhythmStats>): RhythmController {
  const s: RhythmStats = {
    perfect: 0,
    great: 0,
    good: 0,
    miss: 0,
    combo: 0,
    maxCombo: 0,
    multiplier: 1,
    points: 0,
    accuracy: 1,
    ...stats,
  };
  return {
    el: null as unknown as HTMLElement,
    setDifficulty() {},
    setDensity() {},
    density,
    getStats: () => ({ ...s }),
    reset() {},
    update() {},
    destroy() {},
  };
}

export interface LinkModel {
  /** one-way delay in ms for a message sent now */
  delay(r: () => number): number;
}

export const jitteryLink = (base: number, jitterMean: number, spikeP = 0, spikeMs = 0): LinkModel => ({
  delay: (r) => base + -Math.log(1 - r()) * jitterMean + (r() < spikeP ? spikeMs * (0.5 + r()) : 0),
});

export interface SimPlayer {
  room: FakeRoom;
  engine: RemoteEngineImpl;
  perf(): number;
}

export interface PartySim {
  host: { engine: MockEngine; room: FakeRoom; link: HostLinkImpl; loop: FrameLoop; perf(): number };
  players: SimPlayer[];
  /** host frames run while this is true (false = the host's loop is stopped, e.g. pause menu) */
  hostRunning: boolean;
}

export interface PartySimOptions {
  sched: SimScheduler;
  /** per player: link from the host to it, and its clock error in ms (perfToShared bias) */
  players: { link: LinkModel; clockErrMs: number }[];
  hostClockErrMs?: number;
  seed?: number;
  /** host frame interval jitter (ms, ±) and the chance of a 50 ms stall per frame */
  frameJitterMs?: number;
  stallP?: number;
}

export function createPartySim(opts: PartySimOptions): PartySim {
  const { sched } = opts;
  const r = rng(opts.seed ?? 9);
  const H0 = 31_337.25;
  const hostPerf = (): number => sched.t + H0;
  const hostErr = opts.hostClockErrMs ?? 0;
  const hostRoom = createFakeRoom({
    role: 'host',
    now: hostPerf,
    perfToShared: (p) => p - H0 + SHARED0 + hostErr,
    sharedToPerf: (s) => s - SHARED0 - hostErr + H0,
    players: [fakePlayer('host', 'DJ', 0, 'host'), ...opts.players.map((_, i) => fakePlayer(`p${i}`, `P${i}`, i + 1))],
  });
  const engine = createMockEngine({ now: hostPerf });
  const bus = createGameBus();
  const rhythm = fakeRhythm();
  const link = createHostLink({ room: hostRoom, engine, bus, rhythm, getHud: () => mockHud() });
  const loop = createFrameLoop(engine, () => mockHud());
  loop.add((f) => link.update(f), 'render');

  const players: SimPlayer[] = opts.players.map((p, i) => {
    const P0 = 1000 * (i + 1) + 0.5;
    const perf = (): number => sched.t + P0;
    const room = createFakeRoom({
      role: 'player',
      pid: `p${i}`,
      now: perf,
      perfToShared: (x) => x - P0 + SHARED0 + p.clockErrMs,
      sharedToPerf: (s) => s - SHARED0 - p.clockErrMs + P0,
    });
    const local = createMockEngine({ now: perf });
    const remote = createRemoteEngine({ room, local, now: perf });
    return { room, engine: remote, perf, link: p.link, free: 0 } as SimPlayer & { link: LinkModel; free: number };
  });

  hostRoom.onCast = (m: HostMsg, to?: string) => {
    const text = JSON.stringify(m);
    players.forEach((pl, i) => {
      if (to && to !== `p${i}`) return;
      const x = pl as SimPlayer & { link: LinkModel; free: number };
      const at = Math.max(x.free, sched.t + x.link.delay(r));
      x.free = at;
      sched.at(at, () => pl.room.emit('cast', { m: JSON.parse(text) as HostMsg }));
    });
  };

  const sim: PartySim = {
    host: { engine, room: hostRoom, link, loop, perf: hostPerf },
    players,
    hostRunning: true,
  };

  // the host's audio runs continuously (1 ms steps keep the mock's integration exact) …
  const stepAudio = (): void => {
    engine.step();
    sched.setTimeout(stepAudio, 1);
  };
  stepAudio();
  // … and its frames come at ~60 Hz with jitter and the odd stall
  const jit = opts.frameJitterMs ?? 2;
  const stallP = opts.stallP ?? 0.01;
  const frame = (): void => {
    if (sim.hostRunning) loop.tick(hostPerf());
    const stall = r() < stallP ? 50 : 0;
    sched.setTimeout(frame, 1000 / 60 + (r() * 2 - 1) * jit + stall);
  };
  sched.setTimeout(frame, 5);
  return sim;
}
