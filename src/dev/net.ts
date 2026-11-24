/**
 * Net harness (no UI polish: a measuring page). Needs the room server: `npm run dev:worker` (8787)
 * and this page through Vite (which proxies /api to it).
 *   /dev/net.html?host          host a room, play a mock track, broadcast ticks
 *   /dev/net.html?join=CODE     join as a player with a remote engine
 * Each page records [wall-clock ms, beat] every frame in window.__samples (wall clock =
 * performance.timeOrigin + performance.now(), comparable across pages on one machine), so a
 * Playwright script can compare a player's beat with the host's.
 */
import { createGameBus } from '../core/events';
import { createFrameLoop } from '../core/frame';
import type { RoomClient } from '../core/party';
import { createMockEngine } from './mock-engine';
import { MOCK_CATALOG, mockHud, mockTrack } from './mocks';
import { createHostLink, createPartyStore, createPlayerReporter, createRemoteEngine } from '../net';
import type { AudioEngine, RhythmController } from '../core/types';

declare global {
  interface Window {
    __samples: [number, number][];
    __room: RoomClient | null;
    __status: string[];
  }
}

const out = document.getElementById('app')!;
const q = new URLSearchParams(location.search);
window.__samples = [];
window.__room = null;
window.__status = [];

const rhythm: RhythmController = {
  el: document.createElement('div'),
  setDifficulty() {},
  setDensity() {},
  density: 0.7,
  getStats: () => ({ perfect: 3, great: 1, good: 0, miss: 1, combo: 2, maxCombo: 4, multiplier: 1, points: 400, accuracy: 0.8 }),
  reset() {},
  update() {},
  destroy() {},
};

async function main(): Promise<void> {
  const store = createPartyStore();
  const join = q.get('join');
  const room = join ? await store.join(join, { name: 'Tester', difficulty: 'club' }) : await store.host({ name: 'Host', difficulty: 'club' });
  window.__room = room;
  room.on('status', ({ status }) => window.__status.push(`${Math.round(performance.now())}:${status}`));
  let engine: AudioEngine;
  const bus = createGameBus();
  if (!join) {
    const mock = createMockEngine();
    engine = mock;
    room.setPhase('playing', { mode: 'gig', setlist: [MOCK_CATALOG[0].id], difficulty: 'club', party: true });
    const link = createHostLink({ room, engine, bus, rhythm, getHud: () => mockHud() });
    await mock.loadTrack('A', mockTrack(MOCK_CATALOG[0]));
    mock.play('A');
    const loop = createFrameLoop(engine, () => mockHud());
    loop.add((f) => link.update(f));
    loop.add(record);
    loop.start();
  } else {
    engine = createRemoteEngine({ room, local: createMockEngine() });
    const reporter = createPlayerReporter({ room, bus, rhythm });
    const loop = createFrameLoop(engine);
    loop.add((f) => reporter.update(f));
    loop.add(record);
    loop.start();
  }

  function record(): void {
    const t = performance.now();
    const d = engine.getDeck('A');
    if (d.track) window.__samples.push([performance.timeOrigin + t, d.beat]);
    if (window.__samples.length > 20000) window.__samples.splice(0, 10000);
    const r = room;
    out.textContent = [
      `room ${r.code}  role ${r.role}  status ${r.status}  pid ${r.pid}`,
      `clock ready ${r.clockReady}  error ±${r.clockErrorMs.toFixed(1)} ms`,
      `players ${r.players.map((p) => `${p.name}${p.connected ? '' : ' (away)'}`).join(', ')}`,
      `deck A beat ${d.beat.toFixed(3)}  bpm ${d.bpm.toFixed(1)}  ${d.playing ? 'playing' : 'stopped'}`,
      'hostLive' in engine ? `host live ${(engine as unknown as { hostLive: boolean }).hostLive}` : '',
    ].join('\n');
  }
}

main().catch((err) => {
  out.textContent = `failed: ${String(err?.code ?? '')} ${String(err?.message ?? err)}`;
});
