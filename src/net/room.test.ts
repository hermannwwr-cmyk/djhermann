import { describe, expect, it } from 'vitest';
import { MAX_PLAYERS, RoomError } from '../core/party';
import type { RoomStatus } from '../core/party';
import { createPartyStore } from './store';
import type { RoomClientImpl } from './room';
import { ROOM_NET } from './room';
import { FakePartyServer } from './testing/fake-server';
import { createSimNetwork, runFor } from './testing/network';
import { SimScheduler } from './testing/sim';

const SERVER_EPOCH = 1_750_000_000_000;

function world() {
  const sched = new SimScheduler();
  const server = new FakePartyServer({ now: () => SERVER_EPOCH + sched.t });
  const net = createSimNetwork(sched, server);
  return { sched, server, net };
}

/** resolve a store promise while the sim runs */
async function settle<T>(sched: SimScheduler, p: Promise<T>, maxMs = 20_000): Promise<T> {
  let done = false;
  let value: T | undefined;
  let error: unknown;
  p.then(
    (v) => {
      done = true;
      value = v;
    },
    (e) => {
      done = true;
      error = e;
    },
  );
  const end = sched.t + maxMs;
  while (!done && sched.t < end) await runFor(sched, 5);
  if (!done) throw new Error('timed out');
  if (error) throw error;
  return value as T;
}

const me = { name: 'Ana', difficulty: 'club' as const };

describe('PartyStore + room client', () => {
  it('hosts a room, syncs the clock, and a player joins', async () => {
    const { sched, net } = world();
    const hostDev = net.device({ perfOrigin: 5000, up: () => 12, down: () => 12 });
    const store = createPartyStore(hostDev.env);
    const host = (await settle(sched, store.host(me))) as RoomClientImpl;
    expect(host.status).toBe('open');
    expect(host.role).toBe('host');
    expect(host.code).toMatch(/^[A-Z]{4}$/);
    expect(store.room).toBe(host);
    expect(host.hostConnected).toBe(true);

    await runFor(sched, 1000);
    expect(host.clockReady).toBe(true);
    // shared time = server Date.now: exact here (symmetric link)
    const trueShared = SERVER_EPOCH + sched.t;
    expect(Math.abs(host.now() - trueShared)).toBeLessThan(0.5);
    expect(host.clockErrorMs).toBeCloseTo(12, 0);

    const pDev = net.device({ perfOrigin: 99_000, up: () => 30, down: () => 20 });
    const pStore = createPartyStore(pDev.env);
    const player = (await settle(sched, pStore.join(host.code.toLowerCase(), { name: 'Bo', difficulty: 'chill' }))) as RoomClientImpl;
    expect(player.role).toBe('player');
    expect(player.me?.name).toBe('Bo');
    await runFor(sched, 100);
    expect(host.players.map((p) => p.name)).toEqual(['Ana', 'Bo']);
    expect(player.hostConnected).toBe(true);

    // messages both ways
    const got: string[] = [];
    player.on('cast', ({ m }) => got.push(m.k));
    host.on('from', ({ pid, m }) => got.push(`${pid === player.pid ? 'bo' : '?'}:${m.k}`));
    host.cast({ k: 'eject', deck: 'A' });
    player.send({ k: 'need' });
    player.cast({ k: 'eject', deck: 'A' }); // ignored: players can't cast
    await runFor(sched, 200);
    expect(got.sort()).toEqual(['bo:need', 'eject']);

    // phase reaches the player once
    const phases: string[] = [];
    player.on('phase', ({ phase }) => phases.push(phase));
    host.setPhase('loading', { mode: 'gig', setlist: ['x'], difficulty: 'club', party: true });
    await runFor(sched, 200);
    expect(phases).toEqual(['loading']);
    expect(player.params?.setlist).toEqual(['x']);

    // asymmetric link (30 up / 20 down): error = 5 ms, as the maths says
    await runFor(sched, 1000);
    expect(Math.abs(player.now() - (SERVER_EPOCH + sched.t) - 5)).toBeLessThan(0.5);
  });

  it('join: not-found, full and network errors', async () => {
    const { sched, server, net } = world();
    const dev = net.device({ perfOrigin: 0 });
    const store = createPartyStore(dev.env);
    await expect(settle(sched, store.join('ZZZZ', me))).rejects.toMatchObject({ code: 'not-found' });
    await expect(settle(sched, store.join('12', me))).rejects.toMatchObject({ code: 'not-found' });

    const code = server.createRoom();
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const d = net.device({ perfOrigin: i * 1000 });
      await settle(sched, createPartyStore(d.env).join(code, { name: `P${i}`, difficulty: 'club' }));
    }
    const err = await settle(sched, store.join(code, me)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RoomError);
    expect((err as RoomError).code).toBe('full');

    dev.link.cut = true;
    const err2 = await settle(sched, store.join(code, me)).catch((e: unknown) => e);
    expect((err2 as RoomError).code).toBe('network');
    expect(store.room).toBeNull();
  });

  it('reconnects to the same seat after the server drops the socket, with fast first retries', async () => {
    const { sched, net } = world();
    const hDev = net.device({ perfOrigin: 0 });
    const host = (await settle(sched, createPartyStore(hDev.env).host(me))) as RoomClientImpl;
    const pDev = net.device({ perfOrigin: 0, up: () => 40, down: () => 40 });
    const player = (await settle(sched, createPartyStore(pDev.env).join(host.code, me))) as RoomClientImpl;
    const pid = player.pid;
    const statuses: RoomStatus[] = [];
    player.on('status', ({ status }) => statuses.push(status));

    const t0 = sched.t;
    pDev.sockets[pDev.sockets.length - 1].serverDrop();
    // the client only notices a server-side drop by its watchdog here (no close frame): ≤ deadMs + watchdog
    while (player.status === 'open' && sched.t - t0 < 10_000) await runFor(sched, 10);
    while (player.status !== 'open' && sched.t - t0 < 20_000) await runFor(sched, 10);
    expect(player.pid).toBe(pid);
    expect(statuses).toEqual(['reconnecting', 'open']);
    expect(sched.t - t0).toBeLessThan(ROOM_NET.deadMs + ROOM_NET.watchdogMs + 500);
    expect(host.players.find((p) => p.pid === pid)?.connected).toBe(true);
  });

  it('a phone switching Wi-Fi → 4G (dead socket + online event) is back within 2 s', async () => {
    const { sched, net } = world();
    const host = (await settle(sched, createPartyStore(net.device({ perfOrigin: 0 }).env).host(me))) as RoomClientImpl;
    const pDev = net.device({ perfOrigin: 0, up: () => 8, down: () => 8 });
    const player = (await settle(sched, createPartyStore(pDev.env).join(host.code, me))) as RoomClientImpl;
    await runFor(sched, 3000);
    const pid = player.pid;

    // the old connection dies silently; the new network is slower
    pDev.sockets[pDev.sockets.length - 1].kill();
    pDev.link.up = () => 45;
    pDev.link.down = () => 35;
    const t0 = sched.t;
    pDev.wake('online');
    let reopenedAt = -1;
    player.on('status', ({ status }) => {
      if (status === 'open' && reopenedAt < 0) reopenedAt = sched.t;
    });
    await runFor(sched, 4000);
    expect(reopenedAt).toBeGreaterThan(0);
    const recovery = reopenedAt - t0;
    console.log(`[room] Wi-Fi → 4G: back open after ${recovery} ms (probe ${ROOM_NET.probeMs} ms + reconnect)`);
    expect(recovery).toBeLessThan(2000);
    expect(player.pid).toBe(pid);

    // and with no wake-up event at all, the watchdog catches it
    pDev.sockets[pDev.sockets.length - 1].kill();
    const t1 = sched.t;
    let again = -1;
    player.on('status', ({ status }) => {
      if (status === 'open' && again < 0 && sched.t > t1) again = sched.t;
    });
    await runFor(sched, 10_000);
    expect(again - t1).toBeGreaterThan(ROOM_NET.deadMs - ROOM_NET.pingSlowMs - 1);
    expect(again - t1).toBeLessThan(ROOM_NET.deadMs + ROOM_NET.watchdogMs + 1000);
  });

  it('backs off while the network is gone, and retries at once when it comes back', async () => {
    const { sched, net } = world();
    const host = (await settle(sched, createPartyStore(net.device({ perfOrigin: 0 }).env).host(me))) as RoomClientImpl;
    const pDev = net.device({ perfOrigin: 0 });
    const player = (await settle(sched, createPartyStore(pDev.env).join(host.code, me))) as RoomClientImpl;
    pDev.link.cut = true;
    pDev.sockets[pDev.sockets.length - 1].kill();
    const before = pDev.sockets.length;
    await runFor(sched, 30_000);
    expect(player.status).toBe('reconnecting');
    const attempts = pDev.sockets.length - before;
    // dead after ≤ 5.5 s, then attempts each hang for connectTimeoutMs + backoff: a handful, not hundreds
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(attempts).toBeLessThan(8);
    pDev.link.cut = false;
    // hidden page → visible: retry immediately instead of waiting out the backoff
    const t0 = sched.t;
    pDev.wake('visible');
    while (player.status !== 'open' && sched.t - t0 < 10_000) await runFor(sched, 10);
    expect(sched.t - t0).toBeLessThan(ROOM_NET.connectTimeoutMs + 200);
  });

  it('a reload reclaims the seat (player and host) from sessionStorage', async () => {
    const { sched, net } = world();
    const hDev = net.device({ perfOrigin: 0 });
    const host = (await settle(sched, createPartyStore(hDev.env).host(me))) as RoomClientImpl;
    const hostPid = host.pid;
    const pDev = net.device({ perfOrigin: 0 });
    const player = (await settle(sched, createPartyStore(pDev.env).join(host.code, me))) as RoomClientImpl;
    const pid = player.pid;

    // "reload": the old page's socket just dies, a new store on the same sessionStorage joins again
    pDev.sockets[pDev.sockets.length - 1].kill();
    const store2 = createPartyStore(pDev.env);
    expect(store2.lastRoom()).toEqual({ code: host.code, role: 'player' });
    const again = await settle(sched, store2.join(host.code, me));
    expect(again.pid).toBe(pid);
    expect(host.players.filter((p) => p.role === 'player')).toHaveLength(1);

    hDev.sockets[hDev.sockets.length - 1].kill();
    const hStore2 = createPartyStore(hDev.env);
    const hostAgain = await settle(sched, hStore2.join(host.code, me));
    expect(hostAgain.role).toBe('host');
    expect(hostAgain.pid).toBe(hostPid);

    // a different tab can't take the host seat
    const other = createPartyStore(net.device({ perfOrigin: 0 }).env);
    const p2 = await settle(sched, other.join(host.code, me));
    expect(p2.role).toBe('player');
  });

  it('kick is fatal: error event, closed, store empties, no reconnect', async () => {
    const { sched, net } = world();
    const host = (await settle(sched, createPartyStore(net.device({ perfOrigin: 0 }).env).host(me))) as RoomClientImpl;
    const pDev = net.device({ perfOrigin: 0 });
    const pStore = createPartyStore(pDev.env);
    const player = await settle(sched, pStore.join(host.code, me));
    const errors: string[] = [];
    player.on('error', ({ code }) => errors.push(code));
    let storeRoom: unknown = 'unset';
    pStore.subscribe((r) => (storeRoom = r));
    host.kick(player.pid);
    await runFor(sched, 500);
    expect(errors).toEqual(['kicked']);
    expect(player.status).toBe('closed');
    expect(storeRoom).toBeNull();
    const n = pDev.sockets.length;
    await runFor(sched, 10_000);
    expect(pDev.sockets.length).toBe(n);
    expect(pDev.storage.size).toBe(0); // seat forgotten
  });

  it('leave() closes for good; the host re-sends a phase set while it was offline', async () => {
    const { sched, net } = world();
    const hDev = net.device({ perfOrigin: 0 });
    const hStore = createPartyStore(hDev.env);
    const host = (await settle(sched, hStore.host(me))) as RoomClientImpl;
    const pDev = net.device({ perfOrigin: 0 });
    const player = await settle(sched, createPartyStore(pDev.env).join(host.code, me));

    hDev.sockets[hDev.sockets.length - 1].kill();
    host.setPhase('playing', { mode: 'gig', setlist: ['a', 'b'], difficulty: 'club', party: true });
    expect(host.phase).toBe('playing');
    hDev.wake('visible');
    await runFor(sched, 3000);
    expect(host.status).toBe('open');
    expect(player.phase).toBe('playing');

    hStore.leave();
    expect(host.status).toBe('closed');
    expect(hStore.room).toBeNull();
    const n = hDev.sockets.length;
    await runFor(sched, 10_000);
    expect(hDev.sockets.length).toBe(n);
    expect(player.hostConnected).toBe(false);
  });

  it('gives up with not-found when the room is gone while reconnecting', async () => {
    const { sched, server, net } = world();
    const host = (await settle(sched, createPartyStore(net.device({ perfOrigin: 0 }).env).host(me))) as RoomClientImpl;
    const pDev = net.device({ perfOrigin: 0 });
    const player = await settle(sched, createPartyStore(pDev.env).join(host.code, me));
    const errors: string[] = [];
    player.on('error', ({ code }) => errors.push(code));
    server.rooms.delete(host.code);
    pDev.sockets[pDev.sockets.length - 1].kill();
    pDev.wake('visible');
    await runFor(sched, 15_000);
    expect(player.status).toBe('closed');
    expect(errors).toEqual(['not-found']);
  });
});
