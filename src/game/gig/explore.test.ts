import { it } from 'vitest';
import { appendFileSync } from 'node:fs';
const log = (...a: unknown[]) => appendFileSync('/tmp/claude-0/-home-user-djhermann/a1d9e4ef-e7bb-5789-8c58-0f9b25715ff4/scratchpad/gig-work/explore.log', a.map(String).join(' ') + '\n');
import { createSim, createPerfectBot, createNotePlayer } from './testkit';
import type { Difficulty } from '../../core/types';

for (const difficulty of ['chill', 'club', 'festival'] as Difficulty[]) {
it(`explore perfect ${difficulty}`, async () => {
  const sim = await createSim({ difficulty });
  await sim.prepare();
  const bot = createPerfectBot(sim, { manual: difficulty !== 'chill' });
  const notes = createNotePlayer(sim, () => 'perfect');
  sim.bus.on('mission:start', ({ mission }) => log(`[${(sim.t/1000).toFixed(1)}] START ${mission.kind} "${mission.title}" | ${mission.hint}`));
  sim.bus.on('mission:end', ({ result }) => log(`[${(sim.t/1000).toFixed(1)}] END ${result.kind} ${result.rating} ${result.points} ${result.label}`));
  sim.bus.on('callout', (c) => log(`[${(sim.t/1000).toFixed(1)}] CALLOUT ${c.kind} ${c.text}`));
  await sim.run(900, (f) => { bot.act(f); notes.act(f); }, () => sim.gig.ended);
  sim.restoreConsole();
  const r = sim.gig.getResults();
  log(JSON.stringify({ ...r, hypeHistory: r.hypeHistory.length }, null, 0));
  log('violations', sim.violations, 'errors', sim.errors.length, sim.errors.slice(0,3));
}, 120000);
}
