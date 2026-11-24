import { describe, expect, it } from 'vitest';
import { totalBars } from '../../core/beatgrid';
import { BEATS_PER_BAR } from '../../core/types';
import type { Difficulty, TrackMeta } from '../../core/types';
import { MOCK_CATALOG, mockMeta } from '../../dev/mocks';
import { canMatch, planTrack, trackEndBar } from './plan';
import { TUNING } from './tuning';
import { shortMeta } from './testkit';

const golden = MOCK_CATALOG[0]; // 122 BPM, 64 bars: intro 8, groove 8, build 4, drop 16, break 8, build 4, drop 8, outro 8

describe('track plan', () => {
  it('ends at the end of the last section and mixes the next track in 16 bars before', () => {
    expect(trackEndBar(golden)).toBe(64);
    const p = planTrack(golden, { difficulty: 'club', last: false, nextBpm: 124 });
    expect(p.endBeat).toBe(64 * BEATS_PER_BAR);
    expect(p.mixInBeat).toBe((64 - TUNING.transition.overlapBars) * BEATS_PER_BAR);
    expect(p.announceBeat).toBe(p.mixInBeat! - TUNING.transition.announceBeats);
    expect(p.finaleBeat).toBeNull();
    expect(p.cut).toBe(false);
  });

  it('the last track gets an echo-out finale instead of a transition', () => {
    const p = planTrack(golden, { difficulty: 'club', last: true });
    expect(p.mixInBeat).toBeNull();
    expect(p.finaleBeat).toBe((64 - TUNING.tricks.echoOut.bars) * BEATS_PER_BAR);
  });

  it('tempos out of the TEMPO fader range are cut instead of blended', () => {
    expect(canMatch(122, 124)).toBe(true);
    expect(canMatch(122, 90)).toBe(false);
    expect(canMatch(0, 120)).toBe(false);
    const p = planTrack(golden, { difficulty: 'club', last: false, nextBpm: 90 });
    expect(p.cut).toBe(true);
    expect(p.mixInBeat).toBe((64 - TUNING.transition.cutOverlapBars) * BEATS_PER_BAR);
  });

  for (const difficulty of ['chill', 'club', 'festival'] as Difficulty[]) {
    it(`tricks on ${difficulty}: in order, apart, clear of the mix, in sensible sections`, () => {
      for (const last of [false, true]) {
        const p = planTrack(golden, { difficulty, last, nextBpm: 124 });
        expect(p.tricks.length).toBeGreaterThan(0);
        expect(p.tricks.length).toBeLessThanOrEqual(TUNING.tricks.perTrack[difficulty]);
        const limit = (last ? p.finaleBeat! : p.announceBeat!) - TUNING.tricks.clearBeforeMixBeats;
        const gap = TUNING.tricks.minGapBeats[difficulty];
        for (let i = 0; i < p.tricks.length; i++) {
          const t = p.tricks[i];
          expect(t.startBeat).toBeGreaterThanOrEqual(TUNING.tricks.settleBeats);
          expect(t.endBeat).toBeLessThanOrEqual(limit);
          if (i > 0) expect(t.startBeat).toBeGreaterThanOrEqual(p.tricks[i - 1].endBeat + gap);
          const bar = Math.floor(t.startBeat / BEATS_PER_BAR);
          const sec = golden.sections.find((s) => bar >= s.startBar && bar < s.startBar + s.bars)!;
          if (t.kind === 'bass-drop') {
            // appears in the build, lands on a drop's downbeat
            expect(sec.kind).toBe('build');
            const drop = golden.sections.find((s) => s.startBar * BEATS_PER_BAR === t.targetBeat);
            expect(drop?.kind).toBe('drop');
          }
          if (t.kind === 'filter-sweep') expect(['break', 'build']).toContain(sec.kind);
          if (t.kind === 'scratch') expect(['drop', 'groove']).toContain(sec.kind);
        }
        const scratches = p.tricks.filter((t) => t.kind === 'scratch').length;
        expect(scratches).toBeLessThanOrEqual(TUNING.tricks.scratchesPerTrack[difficulty]);
      }
    });
  }

  it('short tracks: the overlap never takes more than half the track', () => {
    const short = shortMeta('s', 124);
    expect(totalBars(short)).toBe(32);
    const p = planTrack(short, { difficulty: 'club', last: false, nextBpm: 124 });
    expect(p.endBeat - p.mixInBeat!).toBeLessThanOrEqual(16 * BEATS_PER_BAR);
    expect(p.mixInBeat).toBeGreaterThanOrEqual(16 * BEATS_PER_BAR);
  });

  it('a track without sections still gets something to do', () => {
    const bare: TrackMeta = { ...mockMeta('bare', 'Bare', 120, 0, 0), sections: [] };
    const p = planTrack(bare, { difficulty: 'club', last: false, nextBpm: 120 });
    expect(p.endBeat).toBe(totalBars(bare) * BEATS_PER_BAR);
    expect(p.tricks.length).toBeGreaterThan(0);
  });
});
