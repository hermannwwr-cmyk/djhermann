import { it } from 'vitest';
import { appendFileSync } from 'node:fs';
const L = '/tmp/claude-0/-home-user-djhermann/a1d9e4ef-e7bb-5789-8c58-0f9b25715ff4/scratchpad/gig-work/explore2.log';
const log = (...a: unknown[]) => appendFileSync(L, a.map(String).join(' ') + '\n');
import { createSim, createNotePlayer, createChaosBot, createPatientBot } from './testkit';
import type { Sim } from './testkit';
import type { Difficulty } from '../../core/types';

function trace(sim: Sim) {
  sim.bus.on('mission:start', ({ mission }) => log(`[${(sim.t/1000).toFixed(1)}] START ${mission.kind} "${mission.title}" | ${mission.hint}`));
  sim.bus.on('mission:end', ({ result }) => log(`[${(sim.t/1000).toFixed(1)}] END ${result.kind} ${result.rating} ${result.points} ${result.label}`));
  sim.bus.on('callout', (c) => log(`[${(sim.t/1000).toFixed(1)}] CALLOUT ${c.kind} ${c.text}`));
}
function summary(sim: Sim, name: string) {
  sim.restoreConsole();
  const r = sim.gig.getResults();
  log(`== ${name}: ended=${sim.gig.ended} t=${(sim.t/1000).toFixed(0)} completed=${r.completed} score=${r.score} grade=${r.grade} stars=${r.stars} hypeAvg=${r.hypeAvg.toFixed(2)} tw=${r.trainwrecks} dead=${r.deadAirSec.toFixed(1)} missions=${r.missions.map(m=>m.kind+':'+m.rating).join(',')}`);
  log('violations', sim.violations.slice(0,5), 'errors', sim.errors.length, sim.errors.slice(0,3).map(e=>e.map(String).join(' ')));
}
for (const difficulty of ['chill', 'club', 'festival'] as Difficulty[]) {
it(`idle ${difficulty}`, async () => {
  const sim = await createSim({ difficulty });
  await sim.prepare();
  log(`#### idle ${difficulty}`); trace(sim);
  const notes = createNotePlayer(sim, () => 'miss');
  let pressed = false;
  await sim.run(1200, (f) => { if (!pressed && f.hud.mission) { sim.engine.play('A'); pressed = true; } notes.act(f); }, () => sim.gig.ended);
  summary(sim, `idle ${difficulty}`);
}, 120000);
}
for (const difficulty of ['chill', 'club'] as Difficulty[]) for (const seed of [1,2,3]) {
it(`chaos ${difficulty} ${seed}`, async () => {
  const sim = await createSim({ difficulty });
  await sim.prepare();
  log(`#### chaos ${difficulty} ${seed}`); trace(sim);
  const bot = createChaosBot(sim, seed);
  const notes = createNotePlayer(sim, () => 'good');
  sim.engine.play('A');
  await sim.run(1500, (f) => { bot.act(f); notes.act(f); }, () => sim.gig.ended);
  summary(sim, `chaos ${difficulty} ${seed}`);
}, 120000);
}
it('tutorial patient', async () => {
  const sim = await createSim({ tutorial: true, setlist: ['mock-golden', 'mock-lanterns'] });
  await sim.prepare();
  log(`#### tutorial`); trace(sim);
  const bot = createPatientBot(sim, 40);
  const notes = createNotePlayer(sim, () => 'perfect');
  let started = false;
  await sim.run(3000, (f) => { if (!started && f.hud.mission) { sim.engine.play('A'); started = true; } bot.act(f); if (sim.t % 20000 < 20) notes.act(f); else notes.act(f); if (Math.round(sim.t) % 10000 < 17) log(`[${(sim.t/1000).toFixed(0)}] status=${f.hud.status} mission=${f.hud.mission?.title} A=${f.decks.A.beat.toFixed(0)} B=${f.decks.B.beat.toFixed(0)}`) }, () => sim.gig.ended);
  summary(sim, 'tutorial');
  log('tutorialDone', sim.settings.get().tutorialDone);
}, 120000);
