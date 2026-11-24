import { describe, expect, it } from 'vitest';
import { AUDIBLE_MIN, createFrameLoop } from '../core/frame';
import { MOCK_CATALOG, mockTrack } from '../dev/mocks';
import { createMockEngine } from '../dev/mock-engine';
import { DeckFollower, FOLLOW } from './follow';
import { createRemoteEngine, shapeAudibility } from './remote-engine';
import { createFakeRoom } from './testing/fake-room';
import { createPartySim, jitteryLink } from './testing/party-sim';
import type { PartySim } from './testing/party-sim';
import { SimScheduler } from './testing/sim';
import { energyToWire } from './wire';
import type { DeckTick } from '../core/party';

const META = MOCK_CATALOG[1]; // 124 bpm

const tick = (pos: number, rate: number, extra: Partial<DeckTick> = {}): DeckTick => ({
  trackId: 'x',
  playing: true,
  scratching: false,
  pos,
  rate,
  tempo: rate,
  bpm: 124 * rate,
  beat: 0,
  audibility: 1,
  ...extra,
});

describe('DeckFollower', () => {
  it('extrapolates exactly when ticks agree, blends small corrections, snaps on a seek', () => {
    const f = new DeckFollower(300);
    expect(f.push(tick(10, 1), 1000, 1050)).toBe('snap');
    expect(f.position(1100)).toBeCloseTo(10.1, 9);
    // a tick 8 ms off: no jump, the correction fades out
    expect(f.push(tick(10.083 - 0.008, 1), 1083, 1130)).toBe('blend');
    expect(f.position(1130)).toBeCloseTo(10.13, 6); // continuous at the moment it arrived
    expect(f.position(1130 + FOLLOW.blendMs + 1)).toBeCloseTo(10.075 + (1130 + FOLLOW.blendMs + 1 - 1083) / 1000, 6);
    // a seek
    expect(f.push(tick(42, 1), 1166, 1200)).toBe('snap');
    expect(f.position(1200)).toBeCloseTo(42.034, 6);
  });

  it('never runs backwards while blending, even for a large correction', () => {
    const f = new DeckFollower(300);
    f.push(tick(10, 1), 0, 50);
    f.push(tick(10.083 - 0.2, 1), 83, 120); // 200 ms behind: still under snapSec
    let prev = f.position(120);
    for (let t = 121; t < 1080; t++) {
      const p = f.position(t);
      expect(p).toBeGreaterThan(prev);
      prev = p;
    }
  });

  it('holds still past the horizon (host gone) and reports rate 0', () => {
    const f = new DeckFollower(300);
    f.push(tick(10, 1), 0, 50);
    expect(f.rate(500)).toBe(1);
    expect(f.position(5000)).toBeCloseTo(10 + FOLLOW.horizonMs / 1000, 6);
    expect(f.rate(5000)).toBe(0);
  });
});

describe('shapeAudibility', () => {
  it("makes the frame loop pick the host's live deck", () => {
    const pick = (live: 'A' | 'B' | null, a: number, b: number): void => {
      const s = shapeAudibility(live, a, b);
      if (!live) {
        expect(s.A).toBeLessThan(AUDIBLE_MIN);
        expect(s.B).toBeLessThan(AUDIBLE_MIN);
        return;
      }
      const lv = s[live];
      const other = s[live === 'A' ? 'B' : 'A'];
      expect(lv).toBeGreaterThanOrEqual(AUDIBLE_MIN);
      expect(other).toBeLessThan(lv);
      expect(other).toBeLessThanOrEqual((lv - 0.05) / 1.25);
    };
    pick('A', 1, 1);
    pick('B', 1, 1);
    pick('B', 0.9, 0.6);
    pick('A', 0.05, 0.02);
    pick(null, 0.05, 0.01);
  });
});

describe('createRemoteEngine', () => {
  it('mirrors track / eject, sends need when a tick names a track it does not have', () => {
    let now = 1000;
    const room = createFakeRoom({ role: 'player', now: () => now, phase: 'playing' });
    const remote = createRemoteEngine({ room, local: createMockEngine({ now: () => now }), now: () => now });
    const log: string[] = [];
    remote.on('deck:load', (e) => log.push(`load ${e.deck} ${e.track.id}`));
    remote.on('deck:eject', (e) => log.push(`eject ${e.deck}`));

    const t = mockTrack(META);
    room.emit('cast', { m: { k: 'track', deck: 'A', meta: META, energy: energyToWire(t.energy) } });
    room.emit('cast', { m: { k: 'track', deck: 'A', meta: META, energy: energyToWire(t.energy) } }); // re-send: ignored
    const lt = remote.getLoadedTrack('A')!;
    expect(lt.meta.id).toBe(META.id);
    expect(lt.energy.low).toBeInstanceOf(Float32Array);
    expect(lt.energy.low.length).toBe(t.energy.low.length);
    expect(lt.waveform.length).toBeGreaterThan(0);
    expect(lt.pcm.length).toBe(1);

    const hud = { hype: 0.7, progress: 0.2, status: 'X', set: null, djAction: 'START DECK B' };
    const tk = (trackId: string) => ({
      k: 'tick' as const,
      at: now,
      live: 'A' as const,
      decks: { A: { ...tick(5, 1), trackId }, B: { ...tick(1, 0, { playing: false }), trackId: 'other' } },
      density: 0.4,
      hud,
    });
    room.emit('cast', { m: tk(META.id) });
    expect(room.sent).toEqual([{ k: 'need' }]); // deck B's track is missing
    expect(remote.hud?.djAction).toBe('START DECK B');
    expect(remote.density).toBe(0.4);
    expect(remote.hostLive).toBe(true);
    now += 20;
    const snap = remote.getDeck('A');
    expect(snap.positionSec).toBeCloseTo(5.02, 6);
    expect(snap.playing).toBe(true);
    expect(snap.bpm).toBeCloseTo(META.grid.bpm, 6);
    expect(remote.positionAt('A', now - 10)).toBeCloseTo(5.01, 6);
    now += 2500;
    expect(remote.hostLive).toBe(false);

    room.emit('cast', { m: { k: 'eject', deck: 'A' } });
    expect(log).toEqual([`load A ${META.id}`, 'eject A']);
    expect(remote.getLoadedTrack('A')).toBeNull();

    room.emit('cast', { m: { k: 'board', entries: [] } });
    expect(remote.board).toEqual([]);
    expect(remote.results).toBeNull();
  });

  it("asks for the tracks once when it joined mid-gig and none came", () => {
    let now = 0;
    const room = createFakeRoom({ role: 'player', now: () => now, phase: 'playing' });
    const remote = createRemoteEngine({ room, local: createMockEngine({ now: () => now }), now: () => now });
    remote.getDeck('A');
    expect(room.sent).toEqual([]);
    now = 1100;
    remote.getDeck('A');
    remote.getDeck('B');
    now = 5000;
    remote.getDeck('A');
    expect(room.sent).toEqual([{ k: 'need' }]);
  });
});

// ───────────────────────────── a minute of play ─────────────────────────────

interface Window {
  from: number;
  to: number;
}

/** the tempo fader jumping 6 % at once: nobody can know before the tick arrives (measured apart) */
const TEMPO_JUMP: Window = { from: 15_000, to: 16_000 };

function measure(sim: PartySim, sched: SimScheduler, untilMs: number, exclude: Window[]) {
  const res = sim.players.map(() => ({ worst: 0, sum: 0, n: 0, backwards: 0, maxSpeedDev: 0, worstAt: 0, jump: 0 }));
  const prev = sim.players.map(() => ({ pos: NaN, t: 0 }));
  const run = (): void => {
    const t = sched.t;
    const steady = !exclude.some((w) => t >= w.from && t < w.to);
    const truth = sim.host.engine.positionAt('A', sim.host.perf());
    const hostSnap = sim.host.engine.getDeck('A');
    sim.players.forEach((pl, i) => {
      const snap = pl.engine.getDeck('A');
      if (!snap.track) return;
      const p = prev[i];
      if (t >= TEMPO_JUMP.from && t < TEMPO_JUMP.to) {
        res[i].jump = Math.max(res[i].jump, Math.abs(snap.positionSec - truth) * 1000);
        if (!Number.isNaN(p.pos) && snap.positionSec < p.pos) res[i].backwards++;
      }
      if (steady && hostSnap.playing && hostSnap.rate > 0.5) {
        const err = (snap.positionSec - truth) * 1000;
        const r = res[i];
        if (Math.abs(err) > r.worst) {
          r.worst = Math.abs(err);
          r.worstAt = t;
        }
        r.sum += Math.abs(err);
        r.n++;
        if (!Number.isNaN(p.pos)) {
          if (snap.positionSec < p.pos) r.backwards++;
          const speed = (snap.positionSec - p.pos) / ((t - p.t) / 1000);
          r.maxSpeedDev = Math.max(r.maxSpeedDev, Math.abs(speed / hostSnap.rate - 1));
        }
      }
      p.pos = snap.positionSec;
      p.t = t;
    });
  };
  // players render at 60 Hz
  while (sched.t < untilMs) {
    sched.advance(1000 / 60);
    run();
  }
  return res.map((r) => ({ ...r, mean: r.n ? r.sum / r.n : 0 }));
}

function script(sim: PartySim, sched: SimScheduler): Window[] {
  const e = sim.host.engine;
  void e.loadTrack('A', mockTrack(META));
  sched.at(500, () => e.play('A'));
  // tempo fader jumped
  sched.at(15_000, () => e.setTempo('A', 1.06));
  // pitch bend held for 1 s
  sched.at(20_000, () => e.setNudge('A', 1));
  sched.at(21_000, () => e.setNudge('A', 0));
  // tempo fader dragged slowly from 1.06 to 0.95 over 3 s
  for (let i = 0; i <= 180; i++) sched.at(25_000 + i * (3000 / 180), () => e.setTempo('A', 1.06 - (0.11 * i) / 180));
  // pause, play
  sched.at(35_000, () => e.pause('A'));
  sched.at(37_000, () => e.play('A'));
  // scratch for a second
  sched.at(42_000, () => e.scratchStart('A'));
  for (let i = 0; i < 100; i++) sched.at(42_000 + i * 10, () => e.scratchMove('A', i % 20 < 10 ? 0.02 : -0.02));
  sched.at(43_000, () => e.scratchEnd('A'));
  // seek
  sched.at(50_000, () => e.seek('A', 40));
  // host pause menu: its loop stops (no ticks) and the audio is suspended
  sched.at(55_000, () => {
    sim.hostRunning = false;
    void e.suspend();
  });
  sched.at(58_000, () => {
    void e.resume();
    sim.hostRunning = true;
  });
  // discontinuities: excluded from the steady-state error (each one + network delay + settling)
  return [
    TEMPO_JUMP,
    { from: 0, to: 1500 },
    { from: 35_000, to: 38_000 },
    { from: 42_000, to: 44_000 },
    { from: 50_000, to: 51_000 },
    { from: 55_000, to: 59_000 },
  ];
}

describe('remote engine following a host over a jittery network (a minute of play)', () => {
  it('stays within a few ms of the host and never steps backwards in steady play', () => {
    const sched = new SimScheduler();
    const sim = createPartySim({
      sched,
      players: [
        { link: jitteryLink(25, 8), clockErrMs: 0 }, // good Wi-Fi
        { link: jitteryLink(60, 25, 0.03, 250), clockErrMs: 0 }, // 4G with spikes
        { link: jitteryLink(40, 15, 0.05, 400), clockErrMs: -3 }, // spiky, clock 3 ms off
      ],
      hostClockErrMs: 2,
      seed: 4,
    });
    const exclude = script(sim, sched);
    const res = measure(sim, sched, 62_000, exclude);
    const lines = res.map(
      (r, i) =>
        `player ${i}: worst ${r.worst.toFixed(2)} ms (at ${(r.worstAt / 1000).toFixed(1)} s), mean ${r.mean.toFixed(2)} ms, backwards steps ${r.backwards}, max speed deviation ${(r.maxSpeedDev * 100).toFixed(1)} %; sudden 6 % tempo jump: worst ${r.jump.toFixed(1)} ms`,
    );
    console.log(
      `[remote] steady-state playhead error vs the host's heard position (host clock +2 ms; player 2 clock −3 ms):\n  ${lines.join('\n  ')}\n  host ticks sent: ${sim.host.link.ticksSent} in 62 s`,
    );
    // players 0/1 have exact clocks except the host's +2 ms: they sit ~2 ms ahead
    expect(res[0].worst).toBeLessThan(5);
    expect(res[1].worst).toBeLessThan(8);
    // player 2: −3 ms own error, +2 ms host error → ~5 ms total bias
    expect(res[2].worst).toBeLessThan(10);
    for (const r of res) {
      expect(r.backwards).toBe(0);
      expect(r.maxSpeedDev).toBeLessThan(0.45);
    }
    // hostLive dropped during the host's pause menu and came back
    expect(sim.players[0].engine.hostLive).toBe(true);
  });

  it("with perfect clocks, the extrapolation error alone stays within a few ms (spiky link)", () => {
    const sched = new SimScheduler();
    const sim = createPartySim({
      sched,
      players: [{ link: jitteryLink(50, 20, 0.05, 300), clockErrMs: 0 }],
      hostClockErrMs: 0,
      seed: 11,
    });
    const exclude = script(sim, sched);
    const res = measure(sim, sched, 62_000, exclude);
    console.log(
      `[remote] perfect clocks, spiky 50+20 ms link: worst ${res[0].worst.toFixed(2)} ms at ${(res[0].worstAt / 1000).toFixed(1)} s, mean ${res[0].mean.toFixed(3)} ms, backwards ${res[0].backwards}; tempo jump transient ${res[0].jump.toFixed(1)} ms`,
    );
    expect(res[0].worst).toBeLessThan(5);
    expect(res[0].backwards).toBe(0);
  });

  it('hostLive goes false while the host is paused, and the playhead holds', () => {
    const sched = new SimScheduler();
    const sim = createPartySim({ sched, players: [{ link: jitteryLink(30, 5), clockErrMs: 0 }] });
    void sim.host.engine.loadTrack('A', mockTrack(META));
    sched.at(200, () => sim.host.engine.play('A'));
    sched.runUntil(5000);
    const remote = sim.players[0].engine;
    expect(remote.hostLive).toBe(true);
    sim.hostRunning = false;
    void sim.host.engine.suspend();
    sched.runUntil(6500);
    const p1 = remote.getDeck('A').positionSec;
    sched.runUntil(8000);
    expect(remote.hostLive).toBe(false);
    expect(remote.getDeck('A').positionSec).toBe(p1);
    expect(remote.getDeck('A').rate).toBe(0);
    // a frame loop on the player keeps the live deck while held (no misses: rate 0)
    const loop = createFrameLoop(remote);
    expect(loop.tick(sim.players[0].perf()).liveDeck).toBe('A');
  });
});
