/**
 * The real client against a real server (wrangler dev or a deployment). Skipped unless LIVE_URL is
 * set:   LIVE_URL=http://localhost:8787 npx vitest run src/net/live.test.ts
 * Everything runs in this one Node process (one performance.now()), so the true shared-clock offset
 * is Date.now() − performance.now() and the players' beats can be compared with the host's directly.
 */
import { describe, expect, it } from 'vitest';
import { createGameBus } from '../core/events';
import { createFrameLoop } from '../core/frame';
import { RoomError } from '../core/party';
import { createMockEngine } from '../dev/mock-engine';
import { MOCK_CATALOG, mockHud, mockTrack } from '../dev/mocks';
import type { NetEnv, SocketLike } from './env';
import { createHostLink } from './host-link';
import { createPlayerReporter } from './reporter';
import { createRemoteEngine } from './remote-engine';
import type { RoomClientImpl } from './room';
import { createPartyStore } from './store';
import { fakeRhythm } from './testing/party-sim';

const LIVE = process.env.LIVE_URL;

function nodeEnv(origin: string): NetEnv & { sockets: SocketLike[]; wakeAll(): void } {
  const store = new Map<string, string>();
  const sockets: SocketLike[] = [];
  const wakes = new Set<(r: 'visible') => void>();
  return {
    now: () => performance.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    fetch: (url, init) => fetch(url, init),
    openSocket: (url) => {
      const s = new WebSocket(url) as unknown as SocketLike;
      sockets.push(s);
      return s;
    },
    origin,
    storage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, v),
      removeItem: (k) => void store.delete(k),
    },
    onWake: (fn) => {
      wakes.add(fn);
      return () => void wakes.delete(fn);
    },
    random: Math.random,
    sockets,
    wakeAll: () => wakes.forEach((fn) => fn('visible')),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const trueOffset = (): number => Date.now() - performance.now();

describe.skipIf(!LIVE)(`live server ${LIVE ?? ''}`, () => {
  it('host + 2 players: clock, tracks, ticks, judgments, board, results, reconnect', async () => {
    const origin = LIVE!.replace(/\/$/, '');
    const hostEnv = nodeEnv(origin);
    const hostStore = createPartyStore(hostEnv);
    const host = (await hostStore.host({ name: 'Host', difficulty: 'club' })) as RoomClientImpl;
    expect(host.code).toMatch(/^[A-Z]{4}$/);
    expect(host.status).toBe('open');

    // errors
    await expect(createPartyStore(nodeEnv(origin)).join('QQQQ', { name: 'x', difficulty: 'club' })).rejects.toBeInstanceOf(RoomError);
    const err = await createPartyStore(nodeEnv(origin))
      .join('QQQQ', { name: 'x', difficulty: 'club' })
      .catch((e: RoomError) => e.code);
    expect(err).toBe('not-found');

    const engine = createMockEngine();
    const bus = createGameBus();
    const hud = mockHud();
    const rhythm = fakeRhythm(0.8, { points: 700 });

    const players = await Promise.all(
      [1, 2].map(async (i) => {
        const env = nodeEnv(origin);
        const room = (await createPartyStore(env).join(host.code, { name: `P${i}`, difficulty: 'chill' })) as RoomClientImpl;
        const remote = createRemoteEngine({ room, local: createMockEngine() });
        const pbus = createGameBus();
        const reporter = createPlayerReporter({ room, bus: pbus, rhythm: fakeRhythm(0.5, { points: 100 * i }) });
        const loop = createFrameLoop(remote);
        loop.add((f) => reporter.update(f));
        return { env, room, remote, pbus, loop };
      }),
    );
    await sleep(300);
    expect(host.players.map((p) => p.name)).toEqual(['Host', 'P1', 'P2']);
    expect(players[0].room.hostConnected).toBe(true);

    host.setPhase('loading', { mode: 'gig', setlist: [MOCK_CATALOG[0].id], difficulty: 'club', party: true });
    const link = createHostLink({ room: host, engine, bus, rhythm, getHud: () => hud });
    const hostLoop = createFrameLoop(engine, () => hud);
    hostLoop.add((f) => link.update(f));
    await engine.loadTrack('A', mockTrack(MOCK_CATALOG[0]));
    host.setPhase('playing', host.params);
    engine.play('A');

    let judges = 0;
    bus.on('judge', () => judges++);
    const timer = setInterval(() => {
      hostLoop.tick(performance.now());
      for (const p of players) p.loop.tick(performance.now());
    }, 16);

    const errs = players.map(() => ({ worst: 0, sum: 0, n: 0 }));
    const start = performance.now();
    while (performance.now() - start < 8000) {
      await sleep(37);
      if (performance.now() - start < 1500) continue;
      const h = engine.getDeck('A');
      players.forEach((p, i) => {
        const s = p.remote.getDeck('A');
        if (!s.track) return;
        const e = Math.abs(((s.beat - h.beat) * 60000) / h.bpm);
        errs[i].worst = Math.max(errs[i].worst, e);
        errs[i].sum += e;
        errs[i].n++;
      });
      if (Math.random() < 0.1) players[0].pbus.emit('judge', { lane: 0, judgment: 'good', errorMs: 20, combo: 1, multiplier: 1, points: 50 });
    }
    const clockErr = [host, ...players.map((p) => p.room)].map((r) => r.now() - performance.now() - trueOffset());
    console.log(
      `[live] ${origin}: clock error vs Date.now (same machine): ${clockErr.map((e) => e.toFixed(2)).join(' / ')} ms; clockErrorMs ${[host, ...players.map((p) => p.room)]
        .map((r) => r.clockErrorMs.toFixed(2))
        .join(' / ')}\n  player beat vs host beat: ${errs.map((e) => `worst ${e.worst.toFixed(2)} ms, mean ${(e.sum / Math.max(1, e.n)).toFixed(2)} ms (${e.n})`).join('; ')}\n  ticks sent ${link.ticksSent}`,
    );
    expect(errs[0].n).toBeGreaterThan(50);
    for (const e of errs) expect(e.worst).toBeLessThan(10);
    expect(judges).toBeGreaterThan(0);
    expect(players[1].remote.board.map((e) => e.name)).toContain('P2');

    // a player's socket drops: back on the same seat
    const p2 = players[1];
    const pid = p2.room.pid;
    (p2.env.sockets[p2.env.sockets.length - 1] as unknown as WebSocket).close();
    const t0 = performance.now();
    while (p2.room.status !== 'open' || performance.now() - t0 < 50) await sleep(20);
    const back = performance.now() - t0;
    expect(p2.room.pid).toBe(pid);
    console.log(`[live] reconnect after a client-side close: ${back.toFixed(0)} ms`);

    // kick P1
    const kicked: string[] = [];
    players[0].room.on('error', (e) => kicked.push(e.code));
    host.kick(players[0].room.pid);
    await sleep(500);
    expect(kicked).toEqual(['kicked']);
    expect(players[0].room.status).toBe('closed');

    link.finish({ score: 1, grade: 'B' } as never);
    await sleep(500);
    expect(p2.room.phase).toBe('results');
    expect(p2.remote.results?.board.length).toBeGreaterThanOrEqual(2);

    clearInterval(timer);
    p2.room.leave();
    hostStore.leave();
  }, 30_000);
});
