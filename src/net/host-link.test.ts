import { describe, expect, it } from 'vitest';
import { createGameBus } from '../core/events';
import { createFrameLoop } from '../core/frame';
import { TICK_HZ } from '../core/party';
import type { HostMsg } from '../core/party';
import type { GameEvents, GigResults, RhythmStats } from '../core/types';
import { createMockEngine } from '../dev/mock-engine';
import { MOCK_CATALOG, mockHud, mockTrack } from '../dev/mocks';
import { createHostLink } from './host-link';
import { createFakeRoom, fakePlayer } from './testing/fake-room';
import { fakeRhythm } from './testing/party-sim';

const stats = (points: number, extra: Partial<RhythmStats> = {}): RhythmStats => ({
  perfect: 1,
  great: 0,
  good: 0,
  miss: 0,
  combo: 3,
  maxCombo: 5,
  multiplier: 2,
  points,
  accuracy: 0.9,
  ...extra,
});

function setup(phase: 'lobby' | 'playing' = 'playing') {
  let now = 1000;
  const clock = () => now;
  const engine = createMockEngine({ now: clock });
  const room = createFakeRoom({
    role: 'host',
    now: clock,
    perfToShared: (p) => p + 1_000_000,
    phase,
    players: [fakePlayer('host', 'DJ Ana', 0, 'host'), fakePlayer('p1', 'Bo', 1), fakePlayer('p2', 'Cy', 2)],
  });
  const bus = createGameBus();
  const rhythm = fakeRhythm(0.7, { points: 500 });
  const loop = createFrameLoop(engine, () => mockHud());
  return {
    engine,
    room,
    bus,
    rhythm,
    loop,
    advance(ms: number) {
      now += ms;
      return now;
    },
    get now() {
      return now;
    },
  };
}

const kinds = (casts: { m: HostMsg; to?: string }[]) => casts.map((c) => `${c.m.k}${'deck' in c.m ? c.m.deck : ''}${c.to ? '>' + c.to : ''}`);

describe('createHostLink', () => {
  it('casts what is on the decks at creation and on every load / eject, with rounded energy', async () => {
    const s = setup();
    await s.engine.loadTrack('A', mockTrack(MOCK_CATALOG[0]));
    const link = createHostLink({ room: s.room, engine: s.engine, bus: s.bus, rhythm: s.rhythm, getHud: () => mockHud() });
    expect(kinds(s.room.casts)).toEqual(['trackA', 'ejectB']);
    const m = s.room.casts[0].m as Extract<HostMsg, { k: 'track' }>;
    expect(m.meta.id).toBe(MOCK_CATALOG[0].id);
    expect(m.energy.low.every((v) => Math.round(v * 100) / 100 === v)).toBe(true);
    const bytes = JSON.stringify(m).length;
    expect(bytes).toBeLessThan(40_000);

    s.room.casts.length = 0;
    await s.engine.loadTrack('B', mockTrack(MOCK_CATALOG[1]));
    s.engine.eject('A');
    expect(kinds(s.room.casts)).toEqual(['trackB', 'ejectA']);
    link.destroy();
    s.engine.eject('B');
    expect(kinds(s.room.casts)).toEqual(['trackB', 'ejectA']);
  });

  it('re-sends tracks on need, to players who join or come back mid-gig, and after its own reconnect', async () => {
    const s = setup();
    await s.engine.loadTrack('A', mockTrack(MOCK_CATALOG[0]));
    createHostLink({ room: s.room, engine: s.engine, bus: s.bus, rhythm: s.rhythm, getHud: () => mockHud() });
    s.room.casts.length = 0;
    s.room.emit('from', { pid: 'p2', m: { k: 'need' } });
    expect(kinds(s.room.casts)).toEqual(['trackA>p2', 'ejectB>p2']);

    s.room.casts.length = 0;
    const players = s.room.players.map((p) => (p.pid === 'p1' ? { ...p, connected: false } : p));
    s.room.setPlayers(players);
    expect(s.room.casts).toEqual([]);
    s.room.setPlayers([...players.map((p) => ({ ...p, connected: true })), fakePlayer('p3', 'Di', 3)]);
    expect(kinds(s.room.casts).sort()).toEqual(['ejectB>p1', 'ejectB>p3', 'trackA>p1', 'trackA>p3']);

    s.room.casts.length = 0;
    s.room.setStatus('reconnecting');
    s.room.setStatus('open');
    expect(kinds(s.room.casts)).toEqual(['trackA', 'ejectB']);
  });

  it(`ticks at ${TICK_HZ} Hz with the decks as heard, stamped in shared time, plus the HUD slice`, async () => {
    const s = setup();
    await s.engine.loadTrack('A', mockTrack(MOCK_CATALOG[1]));
    const link = createHostLink({
      room: s.room,
      engine: s.engine,
      bus: s.bus,
      rhythm: s.rhythm,
      getHud: () => mockHud({ hype: 0.61234 }),
    });
    s.loop.add((f) => link.update(f));
    s.engine.play('A');
    s.room.casts.length = 0;
    // 2 s of 60 fps with steady playback (after the motor is up)
    for (let i = 0; i < 120; i++) s.loop.tick(s.advance(1000 / 60));
    const ticks = s.room.casts.filter((c) => c.m.k === 'tick').map((c) => c.m as Extract<HostMsg, { k: 'tick' }>);
    // 24 regular ticks + a few extra while the motor spun up
    expect(ticks.length).toBeGreaterThanOrEqual(2 * TICK_HZ);
    expect(ticks.length).toBeLessThanOrEqual(2 * TICK_HZ + 8);
    const last = ticks[ticks.length - 1];
    expect(last.live).toBe('A');
    expect(last.density).toBe(0.7);
    expect(last.hud).toEqual({ hype: 0.612, progress: 0.4, status: 'NEXT MIX IN 8 BARS', set: { index: 0, count: 3 }, djAction: 'START DECK B' });
    expect(last.decks.B).toBeNull();
    const a = last.decks.A!;
    // the tick's position is the engine's position at the stamped time
    const at = last.at - 1_000_000;
    expect(a.pos).toBeCloseTo(s.engine.positionAt('A', at), 3);
    expect(a.playing).toBe(true);
    expect(a.rate).toBe(1);
    expect(a.trackId).toBe(MOCK_CATALOG[1].id);

    // steady playback: only the regular ticks
    s.room.casts.length = 0;
    for (let i = 0; i < 120; i++) s.loop.tick(s.advance(1000 / 60));
    expect(s.room.casts.filter((c) => c.m.k === 'tick').length).toBe(2 * TICK_HZ);
    // a pause goes out at once
    s.room.casts.length = 0;
    s.engine.pause('A');
    s.loop.tick(s.advance(1000 / 60));
    expect(s.room.casts.filter((c) => c.m.k === 'tick').length).toBe(1);
  });

  it("re-emits players' judgments on the host's bus and keeps the board", () => {
    const s = setup();
    const link = createHostLink({ room: s.room, engine: s.engine, bus: s.bus, rhythm: s.rhythm, getHud: () => mockHud() });
    s.loop.add((f) => link.update(f));
    const judged: GameEvents['judge'][] = [];
    s.bus.on('judge', (e) => judged.push(e));
    s.room.emit('from', { pid: 'p1', m: { k: 'judge', lane: 2, judgment: 'great', errorMs: -12.5 } });
    s.room.emit('from', { pid: 'p1', m: { k: 'judge', lane: 9 as 0, judgment: 'great', errorMs: 0 } }); // junk: ignored
    expect(judged).toHaveLength(1);
    expect(judged[0]).toMatchObject({ lane: 2, judgment: 'great', errorMs: -12.5, points: 0 });

    s.room.emit('from', { pid: 'p1', m: { k: 'stats', stats: stats(900) } });
    s.room.emit('from', { pid: 'p2', m: { k: 'stats', stats: stats(100) } });
    expect(link.getBoard().map((e) => `${e.name}:${e.score}`)).toEqual(['Bo:900', 'DJ Ana:500', 'Cy:100']);

    // board goes out at STATS_HZ
    s.room.casts.length = 0;
    for (let i = 0; i < 125; i++) s.loop.tick(s.advance(1000 / 60));
    const boards = s.room.casts.filter((c) => c.m.k === 'board');
    expect(boards.length).toBeGreaterThanOrEqual(1);
    expect(boards.length).toBeLessThanOrEqual(3);

    // p2 leaves for good: stays on the board, marked
    s.room.setPlayers(s.room.players.filter((p) => p.pid !== 'p2'));
    const cy = link.getBoard().find((e) => e.pid === 'p2')!;
    expect(cy.connected).toBe(false);
    expect(cy.score).toBe(100);
    s.room.casts.length = 0;
    s.loop.tick(s.advance(150));
    expect(s.room.casts.some((c) => c.m.k === 'board')).toBe(true);

    const results = { score: 1234, grade: 'A' } as unknown as GigResults;
    link.finish(results);
    const fin = s.room.casts.find((c) => c.m.k === 'results')!.m as Extract<HostMsg, { k: 'results' }>;
    expect(fin.results).toBe(results);
    expect(fin.board[0].name).toBe('Bo');
    expect(s.room.phase).toBe('results');
    // no more ticks after the end
    s.room.casts.length = 0;
    for (let i = 0; i < 30; i++) s.loop.tick(s.advance(1000 / 60));
    expect(s.room.casts).toEqual([]);
  });
});
