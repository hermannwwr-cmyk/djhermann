/**
 * Player side: sends this player's judgments (as they happen) and stats (STATS_HZ) to the host.
 * See PlayerReporter in core/party.ts.
 */
import { STATS_HZ } from '../core/party';
import type { PlayerReporter, PlayerReporterDeps } from '../core/party';
import type { FrameState, RhythmStats } from '../core/types';
import { round } from './wire';

/** stats are re-sent at least this often even when unchanged (the host may have reconnected) */
const STATS_REFRESH_MS = 5000;

export function createPlayerReporter(deps: PlayerReporterDeps): PlayerReporter {
  const { room, bus, rhythm } = deps;
  let next = 0;
  let lastJson = '';
  let lastSent = -Infinity;

  const off = bus.on('judge', ({ lane, judgment, errorMs }) => {
    room.send({ k: 'judge', lane, judgment, errorMs: round(errorMs, 1) });
  });

  function sendStats(now: number, force: boolean): void {
    let stats: RhythmStats;
    try {
      stats = rhythm.getStats();
    } catch {
      return;
    }
    const json = JSON.stringify(stats);
    if (!force && json === lastJson && now - lastSent < STATS_REFRESH_MS) return;
    lastJson = json;
    lastSent = now;
    room.send({ k: 'stats', stats: { ...stats, accuracy: round(stats.accuracy, 4) } });
  }

  return {
    update(frame: FrameState) {
      if (frame.now < next) return;
      next = frame.now + 1000 / STATS_HZ;
      sendStats(frame.now, false);
    },
    destroy() {
      off();
      sendStats(0, true); // the final numbers
    },
  };
}
