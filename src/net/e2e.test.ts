/**
 * End to end over the in-memory fake server: a host phone running a gig on the mock engine, two
 * players with remote engines, every link with its own latency and jitter, every device with its
 * own performance.now() origin. The real clients run unchanged on the simulated network.
 */
import { describe, expect, it } from 'vitest';
import { createGameBus } from '../core/events';
import { createFrameLoop } from '../core/frame';
import { rng } from '../core/math';
import type { GigResults, RhythmStats } from '../core/types';
import { createMockEngine } from '../dev/mock-engine';
import { MOCK_CATALOG, mockHud, mockTrack } from '../dev/mocks';
import { createHostLink } from './host-link';
import { createPlayerReporter } from './reporter';
import { createRemoteEngine } from './remote-engine';
import { createPartyStore } from './store';
import type { RoomClientImpl } from './room';
import { FakePartyServer } from './testing/fake-server';
import { createSimNetwork, flushMicrotasks, runFor } from './testing/network';
import { fakeRhythm } from './testing/party-sim';
import { SimScheduler } from './testing/sim';

const SERVER_EPOCH = 1_765_000_000_000;

async function settle<T>(sched: SimScheduler, p: Promise<T>): Promise<T> {
  let out: { v?: T; e?: unknown } | null = null;
  p.then(
    (v) => (out = { v }),
    (e) => (out = { e }),
  );
  while (!out) await runFor(sched, 5);
  const o = out as { v?: T; e?: unknown };
  if (o.e) throw o.e;
  return o.v as T;
}

describe('party over the fake server', () => {
  it("each player's beat matches the host's heard beat in shared time", async () => {
    const sched = new SimScheduler();
    const server = new FakePartyServer({ now: () => SERVER_EPOCH + sched.t });
    const net = createSimNetwork(sched, server);
    const r = rng(77);
    const exp = (mean: number) => -Math.log(1 - r()) * mean;

    // host on good Wi-Fi; player 1 on Wi-Fi with spikes; player 2 on 4G with an asymmetric route
    const hostDev = net.device({ perfOrigin: 4_321.5, up: () => 12 + exp(3), down: () => 12 + exp(3) });
    const p1Dev = net.device({
      perfOrigin: 98_765.25,
      up: () => 18 + exp(6) + (r() < 0.05 ? 150 : 0),
      down: () => 18 + exp(6) + (r() < 0.05 ? 150 : 0),
    });
    const p2Dev = net.device({ perfOrigin: 55.75, up: () => 48 + exp(12), down: () => 36 + exp(12) });

    // ── host: room, engine, gig-ish loop ──
    const hostStore = createPartyStore(hostDev.env);
    const hostRoom = (await settle(sched, hostStore.host({ name: 'DJ Ana', difficulty: 'club' }))) as RoomClientImpl;
    const hostEngine = createMockEngine({ now: hostDev.perf });
    const hostBus = createGameBus();
    const hostRhythm = fakeRhythm(0.65, { points: 1500, combo: 12, maxCombo: 30, accuracy: 0.93 });
    const hud = mockHud({ hype: 0.55 });

    // ── players join in the lobby ──
    const players = await Promise.all(
      [p1Dev, p2Dev].map(async (dev, i) => {
        const store = createPartyStore(dev.env);
        const room = (await settle(sched, store.join(hostRoom.code, { name: `P${i + 1}`, difficulty: 'chill' }))) as RoomClientImpl;
        const local = createMockEngine({ now: dev.perf });
        const engine = createRemoteEngine({ room, local, now: dev.perf });
        const bus = createGameBus();
        let points = 0;
        const rhythm = fakeRhythm(0.5);
        rhythm.getStats = () => ({ ...fakeRhythm().getStats(), points } as RhythmStats);
        const reporter = createPlayerReporter({ room, bus, rhythm });
        const loop = createFrameLoop(engine);
        loop.add((f) => reporter.update(f));
        return { dev, store, room, engine, bus, loop, reporter, addPoints: (n: number) => (points += n) };
      }),
    );

    // ── the gig starts: phase loading, tracks go on the decks, then playing ──
    hostRoom.setPhase('loading', { mode: 'gig', setlist: [MOCK_CATALOG[1].id, MOCK_CATALOG[2].id], difficulty: 'club', party: true });
    const link = createHostLink({ room: hostRoom, engine: hostEngine, bus: hostBus, rhythm: hostRhythm, getHud: () => hud });
    const hostLoop = createFrameLoop(hostEngine, () => hud);
    hostLoop.add((f) => link.update(f));
    await hostEngine.loadTrack('A', mockTrack(MOCK_CATALOG[1]));
    await hostEngine.loadTrack('B', mockTrack(MOCK_CATALOG[2]));
    hostRoom.setPhase('playing', hostRoom.params);
    hostEngine.setCrossfader(-1);
    hostEngine.play('A');

    // frames: host ~60 fps, players ~60 fps (each on its own phase), audio stepped every ms
    const step = (): void => {
      hostEngine.step();
      sched.setTimeout(step, 1);
    };
    step();
    const frames = (fn: (t: number) => void, offset: number): void => {
      const run = (): void => {
        fn(sched.t);
        sched.setTimeout(run, 1000 / 60 + (r() - 0.5) * 3);
      };
      sched.setTimeout(run, offset);
    };
    frames(() => hostLoop.tick(hostDev.perf()), 3);
    players.forEach((p, i) => frames(() => p.loop.tick(p.dev.perf()), 7 + i * 5));

    // host judges arrive on the host bus
    let hostJudges = 0;
    hostBus.on('judge', () => hostJudges++);

    // ── a minute of the set: mix A → B at 30 s, measured all along ──
    const errs = players.map(() => ({ worst: 0, sum: 0, n: 0 }));
    const sharedTrue = (): number => SERVER_EPOCH + sched.t; // the server's clock = shared time
    let measured = 0;
    for (let t = 0; t < 60_000; t += 50) {
      await runFor(sched, 50, 25);
      if (t === 20_000) {
        void hostEngine.sync('B');
        hostEngine.play('B');
      }
      if (t >= 30_000 && t < 32_000) hostEngine.setCrossfader(-1 + (2 * (t - 30_000)) / 2000);
      if (t === 34_000) hostEngine.pause('A');
      if (t % 1000 === 0) {
        // a player hits a note now and then
        players.forEach((p) => {
          p.bus.emit('judge', { lane: 1, judgment: 'perfect', errorMs: 3, combo: 1, multiplier: 1, points: 100 });
          p.addPoints(100);
        });
      }
      if (t < 3000) continue; // clocks settle, first ticks arrive
      // at this exact true instant: the host's heard beat vs each player's displayed beat
      const live = t < 31_000 ? 'A' : 'B';
      const hs = hostEngine.getDeck(live);
      players.forEach((p, i) => {
        const ps = p.engine.getDeck(live);
        expect(ps.track?.id).toBe(hs.track?.id);
        const errMs = ((ps.beat - hs.beat) * 60_000) / hs.bpm;
        const e = errs[i];
        e.worst = Math.max(e.worst, Math.abs(errMs));
        e.sum += Math.abs(errMs);
        e.n++;
      });
      measured++;
    }

    const lines = errs.map(
      (e, i) =>
        `P${i + 1}: worst ${e.worst.toFixed(2)} ms, mean ${(e.sum / e.n).toFixed(2)} ms (clockErrorMs ${players[i].room.clockErrorMs.toFixed(1)})`,
    );
    console.log(
      `[e2e] player beat vs host heard beat, ${measured} samples over 57 s (host 12/12 ms Wi-Fi; P1 18/18 ms + 5 % 150 ms spikes; P2 48 up / 36 down 4G):\n  ${lines.join('\n  ')}\n  host clock error vs server: ${(hostRoom.now() - sharedTrue()).toFixed(2)} ms; P1 ${(players[0].room.now() - sharedTrue()).toFixed(2)} ms; P2 ${(players[1].room.now() - sharedTrue()).toFixed(2)} ms`,
    );
    // P1: symmetric route, only spikes and jitter → a few ms
    expect(errs[0].worst).toBeLessThan(6);
    // P2: the route is 12 ms asymmetric → 6 ms unobservable clock bias + jitter
    expect(errs[1].worst).toBeLessThan(12);

    // live deck followed the host's crossfade
    const pf = players[0].loop.tick(players[0].dev.perf());
    expect(pf.liveDeck).toBe('B');
    // density + HUD reached the players
    expect(players[0].engine.density).toBe(0.65);
    expect(players[1].engine.hud?.djAction).toBe('START DECK B');
    // judgments reached the host's bus (2 players × ~60 s)
    expect(hostJudges).toBeGreaterThanOrEqual(110);
    // board: host + 2 players, best first, on the players' phones
    // (equal scores: seat order)
    expect(players[1].engine.board.map((e) => e.name)).toEqual(['P1', 'P2', 'DJ Ana']);
    const board = link.getBoard();
    expect(board).toHaveLength(3);
    expect(board[0].score).toBeGreaterThanOrEqual(board[1].score);
    expect(board.find((e) => e.name === 'P1')!.score).toBeGreaterThan(5000);

    // ── a player drops for a moment mid-gig: seat kept, decks re-sent, back in time ──
    const p = players[1];
    p.dev.sockets[p.dev.sockets.length - 1].kill();
    p.dev.wake('online');
    await runFor(sched, 3000, 25);
    expect(p.room.status).toBe('open');
    const hs = hostEngine.getDeck('B');
    const ps = p.engine.getDeck('B');
    expect(Math.abs(((ps.beat - hs.beat) * 60_000) / hs.bpm)).toBeLessThan(15);

    // ── the gig ends ──
    link.finish({ score: 99, grade: 'A' } as unknown as GigResults);
    await runFor(sched, 1000, 25);
    for (const pl of players) {
      expect(pl.room.phase).toBe('results');
      expect(pl.engine.results?.results.score).toBe(99);
      expect(pl.engine.results?.board).toHaveLength(3);
    }
    await flushMicrotasks();
  });
});
