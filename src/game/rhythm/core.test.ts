import { describe, expect, it } from 'vitest';
import { secAtBeat } from '../../core/beatgrid';
import { createGameBus } from '../../core/events';
import { createFrameLoop } from '../../core/frame';
import type { DeckId, Difficulty, GameEvents, Lane } from '../../core/types';
import { createMockEngine } from '../../dev/mock-engine';
import { MOCK_CATALOG, mockTrack } from '../../dev/mocks';
import { generateChart } from './chart';
import type { Note } from './chart';
import { GUARD_BEATS, HIDDEN, HIT, RhythmCore, SHOWN, WINDOW_MS, multiplierFor } from './core';
import type { JudgeFx } from './core';

/** A playfield brain on a mock engine with a hand-driven clock. Deck A: 122 bpm, deck B: 124 bpm. */
async function setup(difficulty: Difficulty = 'club') {
  let t = 1000;
  const engine = createMockEngine({ now: () => t });
  const bus = createGameBus();
  const loop = createFrameLoop(engine);
  const judged: GameEvents['judge'][] = [];
  const breaks: GameEvents['combo:break'][] = [];
  const milestones: GameEvents['combo:milestone'][] = [];
  const fx: JudgeFx[] = [];
  bus.on('judge', (e) => judged.push(e));
  bus.on('combo:break', (e) => breaks.push(e));
  bus.on('combo:milestone', (e) => milestones.push(e));
  const core = new RhythmCore({ engine, bus, difficulty, onJudge: (e) => fx.push({ ...e }) });
  const tracks = { A: mockTrack(MOCK_CATALOG[0]), B: mockTrack(MOCK_CATALOG[1]) };
  await engine.unlock();
  await engine.loadTrack('A', tracks.A);
  await engine.loadTrack('B', tracks.B);
  engine.setCrossfader(-1);
  const charts = { A: generateChart(tracks.A, difficulty), B: generateChart(tracks.B, difficulty) };

  const frame = (): void => core.update(loop.tick(t));
  /** run the game for `ms` in 5 ms frames */
  const run = (ms: number): void => {
    const end = t + ms;
    while (t < end) {
      t = Math.min(end, t + 5);
      frame();
    }
  };
  const beatOf = (deck: DeckId): number => engine.getDeck(deck).beat;
  /** ms until the deck reaches `beat` at its current rate */
  const msToBeat = (deck: DeckId, beat: number): number => {
    const snap = engine.getDeck(deck);
    return ((secAtBeat(tracks[deck].meta.grid, beat) - snap.positionSec) / snap.rate) * 1000;
  };
  /** run frames until `offsetMs` relative to the moment the deck is on `beat` (no frame at the end) */
  const runTo = (deck: DeckId, beat: number, offsetMs = 0): void => {
    for (let guard = 0; ; guard++) {
      if (guard > 200000) throw new Error(`runTo(${deck}, ${beat}) never got there`);
      const snap = engine.getDeck(deck);
      if (Math.abs(snap.rate - snap.tempo) > 0.001) {
        // still spinning up: no way to tell when it gets there yet
        t += 5;
        frame();
        continue;
      }
      const left = msToBeat(deck, beat) + offsetMs;
      if (left <= 5) {
        t += Math.max(0, left);
        return;
      }
      t += 5;
      frame();
    }
  };
  const started: Record<DeckId, number> = { A: 0, B: 0 };
  /**
   * Start a deck half a beat before `beat`. Its notes get lined up on the first frame, with a
   * clear beat ahead, so the first note that is due is the first one from `beat + 0.75` on.
   */
  const start = (deck: DeckId, beat: number, settleMs = 300): void => {
    started[deck] = beat;
    engine.seek(deck, secAtBeat(tracks[deck].meta.grid, beat - 0.5));
    engine.play(deck);
    run(settleMs);
  };
  const tap = (lane: Lane): ReturnType<RhythmCore['tap']> => core.tap(lane, t);
  /** tap a note `offsetMs` away from its exact time */
  const hit = (deck: DeckId, note: Note, offsetMs = 0): ReturnType<RhythmCore['tap']> => {
    runTo(deck, note.beat, offsetMs);
    return tap(note.lane);
  };
  /** notes of a deck's chart from `fromBeat` on */
  const notesFrom = (deck: DeckId, fromBeat: number): Note[] => charts[deck].notes.filter((n) => n.beat >= fromBeat);
  /** the notes that are due after start(), first one first */
  const due = (deck: DeckId): Note[] => notesFrom(deck, started[deck] + 0.75);
  const stateOf = (deck: DeckId, note: Note): number => {
    const notes = core.decks[deck]!;
    for (let i = 0; i < notes.count; i++) {
      if (notes.beat[i] === note.beat && notes.lane[i] === note.lane) return notes.state[i];
    }
    return -1;
  };

  return {
    engine,
    bus,
    core,
    tracks,
    charts,
    judged,
    breaks,
    milestones,
    fx,
    frame,
    run,
    runTo,
    start,
    tap,
    hit,
    notesFrom,
    due,
    stateOf,
    beatOf,
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** first drop of the mock arrangement starts at bar 20 */
const DROP = 80;

describe('judging', () => {
  it('judges a tap against the note by its timing error, in the windows of the difficulty', async () => {
    const cases: [Difficulty, number, string | null][] = [
      ['club', 0, 'perfect'],
      ['club', 39, 'perfect'],
      ['club', -39, 'perfect'],
      ['club', 41, 'great'],
      ['club', -79, 'great'],
      ['club', 81, 'good'],
      ['club', -124, 'good'],
      ['club', 126, null],
      ['club', -126, null],
      ['chill', 49, 'perfect'],
      ['chill', 99, 'great'],
      ['chill', 155, 'good'],
      ['chill', 158, null],
      ['festival', 33, 'perfect'],
      ['festival', 35, 'great'],
      ['festival', 67, 'great'],
      ['festival', 69, 'good'],
      ['festival', 105, 'good'],
      ['festival', 108, null],
    ];
    for (const [difficulty, offset, expected] of cases) {
      const g = await setup(difficulty);
      g.start('A', DROP);
      const note = g.due('A')[0];
      expect(g.hit('A', note, offset), `${difficulty} ${offset} ms`).toBe(expected);
      if (expected) {
        expect(g.judged).toHaveLength(1);
        expect(g.judged[0].lane).toBe(note.lane);
        expect(g.judged[0].errorMs).toBeCloseTo(offset, 3);
      } else if (offset < 0) {
        expect(g.judged).toHaveLength(0); // too early: a free hit, the note is still coming
        expect(g.stateOf('A', note)).toBe(SHOWN);
      } else {
        g.frame(); // too late: the note is gone
        expect(g.judged.map((e) => e.judgment)).toEqual(['miss']);
      }
    }
  });

  it('converts the beat error to milliseconds at the tempo the deck is running at', async () => {
    for (const tempo of [0.92, 1, 1.08]) {
      const g = await setup('club');
      g.engine.setTempo('A', tempo);
      g.start('A', DROP);
      const bpm = 122 * tempo;
      const [first, second] = g.due('A');
      // a tenth of a beat late is a different number of milliseconds at each tempo
      g.runTo('A', first.beat + 0.1);
      expect(g.tap(first.lane)).toBe('great');
      expect(g.judged[0].errorMs).toBeCloseTo((0.1 * 60000) / bpm, 2);
      // …and the same 35 ms is perfect at every tempo
      expect(g.hit('A', second, 35)).toBe('perfect');
      expect(g.judged[1].errorMs).toBeCloseTo(35, 2);
    }
    // 0.09 beats: great on a fast deck, good on a slow one
    const fast = await setup('club');
    fast.engine.setTempo('A', 1.08);
    fast.start('A', DROP);
    const nf = fast.due('A')[0];
    fast.runTo('A', nf.beat + 0.175);
    expect(fast.tap(nf.lane)).toBe('great'); // 79.7 ms
    const slow = await setup('club');
    slow.engine.setTempo('A', 0.92);
    slow.start('A', DROP);
    const ns = slow.due('A')[0];
    slow.runTo('A', ns.beat + 0.175);
    expect(slow.tap(ns.lane)).toBe('good'); // 93.6 ms
  });

  it('judges each note once, only in its own lane, and picks the nearest note', async () => {
    const g = await setup('club');
    g.start('A', DROP);
    const [a, b] = g.due('A');
    g.runTo('A', a.beat);
    const wrong = ((a.lane + 2) % 4) as Lane;
    expect(g.tap(wrong)).toBeNull();
    expect(g.tap(a.lane)).toBe('perfect');
    expect(g.tap(a.lane)).toBeNull(); // already judged: a free hit
    expect(g.stateOf('A', a)).toBe(HIT);
    expect(g.judged).toHaveLength(1);
    expect(g.hit('A', b, -20)).toBe('perfect');
    expect(g.judged[1].errorMs).toBeCloseTo(-20, 3);
    expect(g.judged[1].errorMs).toBeLessThan(0); // early is negative
  });

  it('uses event time, not the time the handler runs', async () => {
    const g = await setup('club');
    g.start('A', DROP);
    const note = g.due('A')[0];
    g.runTo('A', note.beat, 60);
    // the finger landed 55 ms ago; the handler is late
    expect(g.core.tap(note.lane, g.now() - 55)).toBe('perfect');
    expect(g.judged[0].errorMs).toBeCloseTo(5, 3);
  });

  it('misses a note once it is past the hit line by more than the good window', async () => {
    const g = await setup('club');
    g.start('A', DROP);
    const note = g.due('A')[0];
    g.runTo('A', note.beat, WINDOW_MS.good - 10);
    g.frame();
    expect(g.judged).toHaveLength(0);
    g.run(25);
    expect(g.judged).toEqual([{ lane: note.lane, judgment: 'miss', errorMs: 0, combo: 0, multiplier: 1, points: 0 }]);
    expect(g.breaks).toHaveLength(0); // there was no combo to break
    expect(g.tap(note.lane)).toBeNull();
    g.run(60);
    expect(g.judged.filter((e) => e.lane === note.lane)).toHaveLength(1);
    expect(g.core.getStats().miss).toBeGreaterThanOrEqual(1);
  });

  it('a tap with no note in the window is a free hit and breaks nothing', async () => {
    const g = await setup('chill');
    g.start('A', DROP);
    const [a, b] = g.due('A');
    expect(g.hit('A', a)).toBe('perfect');
    g.runTo('A', (a.beat + b.beat) / 2);
    for (const lane of [0, 1, 2, 3] as Lane[]) expect(g.tap(lane)).toBeNull();
    expect(g.breaks).toHaveLength(0);
    expect(g.core.getStats().combo).toBe(1);
    expect(g.hit('A', b)).toBe('perfect');
    expect(g.core.getStats().combo).toBe(2);
  });
});

describe('combo, multiplier and score', () => {
  it('has the multiplier steps at 10, 25 and 50', () => {
    expect([0, 9, 10, 24, 25, 49, 50, 500].map(multiplierFor)).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
  });

  it('scores with the multiplier, announces milestones and breaks on a miss', async () => {
    const g = await setup('club');
    g.start('A', DROP);
    const notes = g.due('A').slice(0, 53);
    let expected = 0;
    notes.slice(0, 52).forEach((n, i) => {
      expect(g.hit('A', n)).toBe('perfect');
      const combo = i + 1;
      const mult = combo >= 50 ? 4 : combo >= 25 ? 3 : combo >= 10 ? 2 : 1;
      expected += 100 * mult;
      expect(g.judged[i]).toMatchObject({ judgment: 'perfect', combo, multiplier: mult, points: 100 * mult });
    });
    expect(g.milestones).toEqual([
      { combo: 10, multiplier: 2 },
      { combo: 25, multiplier: 3 },
      { combo: 50, multiplier: 4 },
    ]);
    expect(g.fx.filter((f) => f.milestone).map((f) => f.combo)).toEqual([10, 25, 50]);
    let stats = g.core.getStats();
    expect(stats).toMatchObject({ perfect: 52, combo: 52, maxCombo: 52, multiplier: 4, points: expected, accuracy: 1 });

    // let the next one go by
    g.runTo('A', notes[52].beat, 200);
    g.frame();
    expect(g.breaks).toEqual([{ combo: 52 }]);
    expect(g.fx[g.fx.length - 1]).toMatchObject({ judgment: 'miss', broken: 52, combo: 0 });
    stats = g.core.getStats();
    expect(stats).toMatchObject({ miss: 1, combo: 0, maxCombo: 52, multiplier: 1, points: expected });
  });

  it('weights accuracy: (perfect + 0.7 great + 0.4 good) / judged', async () => {
    const g = await setup('chill');
    expect(g.core.getStats().accuracy).toBe(1);
    g.start('A', DROP);
    const n = g.due('A');
    expect(g.hit('A', n[0])).toBe('perfect');
    expect(g.hit('A', n[1], 10)).toBe('perfect');
    expect(g.hit('A', n[2], 70)).toBe('great');
    expect(g.hit('A', n[3], -130)).toBe('good');
    g.runTo('A', n[4].beat, 250);
    g.frame();
    const stats = g.core.getStats();
    expect(stats).toMatchObject({ perfect: 2, great: 1, good: 1, miss: 1, combo: 0, maxCombo: 4 });
    expect(stats.accuracy).toBeCloseTo((2 + 0.7 + 0.4) / 5, 10);
    expect(stats.points).toBe(100 + 100 + 70 + 40);

    g.core.reset();
    expect(g.core.getStats()).toEqual({
      perfect: 0,
      great: 0,
      good: 0,
      miss: 0,
      combo: 0,
      maxCombo: 0,
      multiplier: 1,
      points: 0,
      accuracy: 1,
    });
  });
});

describe('notes ride the record', () => {
  it('misses nothing while the record is held for a scratch, and a note can come back', async () => {
    const g = await setup('chill');
    g.start('A', DROP);
    const note = g.due('A')[0];
    const beatSec = 60 / 122;
    g.runTo('A', note.beat - 0.5);
    g.engine.scratchStart('A');
    // push the record a whole beat forwards, past the note, and hold it there
    for (let i = 0; i < 10; i++) {
      g.engine.scratchMove('A', 0.1 * beatSec);
      g.run(10);
    }
    expect(g.beatOf('A')).toBeGreaterThan(note.beat + 0.4);
    g.run(400);
    expect(g.judged).toHaveLength(0);
    // pull it back (the record runs backwards) to before the note and let go
    for (let i = 0; i < 10; i++) {
      g.engine.scratchMove('A', -0.12 * beatSec);
      g.run(10);
    }
    expect(g.judged).toHaveLength(0);
    g.engine.scratchEnd('A');
    g.run(60);
    expect(g.judged).toHaveLength(0);
    expect(g.stateOf('A', note)).toBe(SHOWN);
    expect(g.hit('A', note)).toBe('perfect');
  });

  it('lets a note go, unjudged, when it was passed during a scratch', async () => {
    const g = await setup('chill');
    g.start('A', DROP);
    const [note, next] = g.due('A');
    g.runTo('A', note.beat - 0.4);
    g.engine.scratchStart('A');
    for (let i = 0; i < 8; i++) {
      g.engine.scratchMove('A', (0.1 * 60) / 122);
      g.run(10);
    }
    g.engine.scratchEnd('A');
    g.runTo('A', next.beat, -200);
    expect(g.judged).toHaveLength(0);
    expect(g.tap(note.lane)).toBeNull();
    expect(g.hit('A', next)).toBe('perfect');
  });

  it('misses nothing while the deck is paused', async () => {
    const g = await setup('chill');
    g.start('A', DROP);
    const [note, next] = g.due('A');
    // the note is 60 ms past the line, still hittable, when the DJ stops the deck
    g.runTo('A', note.beat, 60);
    g.frame();
    g.engine.pause('A');
    g.run(800);
    expect(g.core.live).toBeNull(); // dead air
    // the stopped record is moved on by hand, well past the note
    g.engine.seek('A', g.engine.getDeck('A').positionSec + (0.5 * 60) / 122);
    g.run(200);
    g.engine.play('A');
    g.run(120);
    expect(g.judged).toHaveLength(0);
    expect(g.core.getStats().miss).toBe(0);
    expect(g.hit('A', next)).toBe('perfect');
  });

  it('keeps judged notes judged when the player rewinds', async () => {
    const g = await setup('chill');
    g.start('A', DROP);
    const [a, b] = g.due('A');
    expect(g.hit('A', a)).toBe('perfect');
    // spin the record back a beat and a half by hand
    g.engine.scratchStart('A');
    for (let i = 0; i < 15; i++) {
      g.engine.scratchMove('A', (-0.1 * 60) / 122);
      g.run(10);
    }
    g.engine.scratchEnd('A');
    g.run(40);
    expect(g.beatOf('A')).toBeLessThan(a.beat - 0.5);
    expect(g.hit('A', a)).toBeNull();
    expect(g.stateOf('A', a)).toBe(HIT);
    // a jump back (CUE, seek) does not bring it back either
    g.engine.seek('A', secAtBeat(g.tracks.A.meta.grid, a.beat - 3));
    g.run(40);
    expect(g.hit('A', a)).toBeNull();
    expect(g.stateOf('A', a)).toBe(HIT);
    expect(g.core.getStats().perfect).toBe(1);
    expect(g.hit('A', b)).toBe('perfect');
  });

  it('does not punish a jump of the playhead: no note is due within a beat of where it lands', async () => {
    const g = await setup('club');
    g.start('A', 40);
    g.run(500);
    const target = DROP + 8.3;
    g.engine.seek('A', secAtBeat(g.tracks.A.meta.grid, target));
    g.frame();
    g.run(1500);
    const ahead = g.notesFrom('A', target);
    const guarded = ahead.filter((n) => n.beat < target + GUARD_BEATS);
    expect(guarded.length).toBeGreaterThan(0);
    const missedLanes = g.judged.map((e) => e.lane);
    const expectedMisses = ahead.filter(
      (n) => n.beat >= target + GUARD_BEATS && n.beat < g.beatOf('A') - (125 * 122) / 60000,
    );
    expect(g.judged.every((e) => e.judgment === 'miss')).toBe(true);
    expect(missedLanes).toEqual(expectedMisses.map((n) => n.lane));
    expect(expectedMisses.length).toBeGreaterThan(0);
  });
});

describe('the density gate', () => {
  it('density 0 is an empty highway: nothing to hit, nothing to miss', async () => {
    const g = await setup('festival');
    g.core.setDensity(0);
    g.start('A', DROP);
    const note = g.due('A')[0];
    expect(g.hit('A', note)).toBeNull();
    g.run(4000);
    expect(g.judged).toHaveLength(0);
    expect(g.core.getStats()).toMatchObject({ miss: 0, combo: 0, accuracy: 1 });
  });

  it('shows the notes with priority <= density', async () => {
    const g = await setup('club');
    g.core.setDensity(0.4);
    g.start('A', DROP);
    g.run(6000);
    const until = g.beatOf('A') - (125 * 122) / 60000;
    const due = g.due('A').filter((n) => n.beat < until);
    const shown = due.filter((n) => n.priority <= 0.4);
    expect(shown.length).toBeGreaterThan(5);
    expect(shown.length).toBeLessThan(due.length * 0.6);
    expect(g.judged.map((e) => e.lane)).toEqual(shown.map((n) => n.lane));
  });

  it('applies only to notes that have not appeared yet', async () => {
    const g = await setup('chill');
    g.core.setLookahead(3);
    g.start('A', DROP);
    const due = g.due('A');
    g.runTo('A', due[0].beat - 1);
    g.frame();
    // some notes are on the highway already, the rest is still beyond its far end
    const onHighway = due.filter((n) => g.stateOf('A', n) === SHOWN);
    const later = due[onHighway.length];
    expect(onHighway.length).toBeGreaterThanOrEqual(2);
    expect(later.beat - g.beatOf('A')).toBeGreaterThan(3);
    g.core.setDensity(0);
    for (const n of onHighway) expect(g.hit('A', n)).toBe('perfect');
    g.runTo('A', later.beat);
    expect(g.stateOf('A', later)).toBe(HIDDEN);
    expect(g.tap(later.lane)).toBeNull();
    g.run(500);
    expect(g.judged).toHaveLength(onHighway.length);
    expect(g.core.getStats().miss).toBe(0);

    // and the other way round: a note that was kept off the highway does not pop in
    const rest = g.notesFrom('A', g.beatOf('A') + 3.2);
    g.runTo('A', rest[0].beat - 1);
    g.frame();
    const kept = rest.filter((n) => g.stateOf('A', n) === HIDDEN);
    const after = rest[kept.length];
    expect(kept.length).toBeGreaterThanOrEqual(2);
    g.core.setDensity(1);
    for (const n of kept) expect(g.hit('A', n)).toBeNull();
    expect(g.hit('A', after)).toBe('perfect');
    expect(g.core.getStats().miss).toBe(0);
  });

  it('a note that left the highway over the far end is decided again when it returns', async () => {
    const g = await setup('chill');
    g.core.setLookahead(4);
    g.start('A', DROP);
    const note = g.due('A')[2];
    g.runTo('A', note.beat - 3.6);
    g.frame();
    expect(g.stateOf('A', note)).toBe(SHOWN);
    g.core.setLookahead(2); // the console drawer opened: the highway got shorter
    g.frame();
    g.core.setDensity(0);
    g.runTo('A', note.beat - 1);
    g.frame();
    expect(g.stateOf('A', note)).toBe(HIDDEN);
  });
});

describe('the live deck', () => {
  it('charts whatever is on each deck and follows load and eject', async () => {
    const g = await setup('club');
    expect(g.core.decks.A!.chart).toEqual(g.charts.A);
    expect(g.core.decks.B!.chart).toEqual(g.charts.B);
    const other = mockTrack(MOCK_CATALOG[3]);
    await g.engine.loadTrack('B', other);
    expect(g.core.decks.B!.chart).toEqual(generateChart(other, 'club'));
    g.engine.eject('B');
    expect(g.core.decks.B).toBeNull();
    g.core.setDifficulty('festival');
    expect(g.core.decks.A!.chart).toEqual(generateChart(g.tracks.A, 'festival'));

    // a playfield created after the tracks were loaded finds them too
    const late = new RhythmCore({ engine: g.engine, bus: g.bus, difficulty: 'chill' });
    expect(late.decks.A!.chart.trackId).toBe(g.tracks.A.meta.id);
    late.destroy();
  });

  it('on a crossfade the old notes fade out unjudged and nothing is due within a beat', async () => {
    const g = await setup('club');
    g.start('A', DROP);
    g.engine.seek('B', secAtBeat(g.tracks.B.meta.grid, DROP + 16));
    g.engine.play('B');
    g.run(200);
    expect(g.core.shown).toBe('A');
    const pendingA = g.notesFrom('A', g.beatOf('A')).filter((n) => g.stateOf('A', n) === SHOWN);
    expect(pendingA.length).toBeGreaterThan(2);
    expect(g.judged).toHaveLength(0);

    g.engine.setCrossfader(1);
    g.frame();
    const switchBeat = g.beatOf('B');
    expect(g.core.shown).toBe('B');
    expect(g.core.fadeDeck).toBe('A');
    // the old deck's notes can no longer be hit…
    expect(g.hit('A', pendingA[0])).toBeNull();
    // …and no note of the new deck is due within a beat of the switch
    const guarded = g.notesFrom('B', switchBeat - GUARD_BEATS).filter((n) => n.beat < switchBeat + GUARD_BEATS);
    expect(guarded.length).toBeGreaterThan(0);
    for (const n of guarded.filter((x) => x.beat > g.beatOf('B'))) expect(g.hit('B', n)).toBeNull();

    // from one beat after the switch the new deck plays as usual
    const [first, second] = g.notesFrom('B', switchBeat + GUARD_BEATS);
    expect(g.hit('B', first)).toBe('perfect');
    g.runTo('B', second.beat, 300);
    g.frame();
    expect(g.judged.map((e) => e.judgment)).toEqual(['perfect', 'miss']);
    expect(g.judged[1].lane).toBe(second.lane);
    // deck A played on the whole time: none of its notes was ever judged
    expect(g.core.getStats()).toMatchObject({ perfect: 1, miss: 1 });
  });

  it('coming back to a deck starts fresh, a beat ahead', async () => {
    const g = await setup('club');
    g.start('A', DROP);
    g.engine.seek('B', secAtBeat(g.tracks.B.meta.grid, DROP));
    g.engine.play('B');
    g.run(300);
    g.engine.setCrossfader(1);
    g.run(1000);
    g.engine.setCrossfader(-1);
    g.frame();
    expect(g.core.shown).toBe('A');
    const back = g.beatOf('A');
    const [first] = g.notesFrom('A', back + GUARD_BEATS);
    for (const n of g.notesFrom('A', back).filter((x) => x.beat < back + GUARD_BEATS)) {
      expect(g.stateOf('A', n)).not.toBe(SHOWN);
    }
    const before = g.judged.length;
    expect(g.hit('A', first)).toBe('perfect');
    expect(g.judged.length).toBe(before + 1);
  });

  it('waits in dead air: taps are free hits and nothing is missed', async () => {
    const g = await setup('club');
    g.start('A', DROP);
    g.run(1500);
    const missesBefore = g.core.getStats().miss;
    const judgedBefore = g.judged.length;
    g.engine.setFader('A', 0); // the deck plays on, but nobody hears it
    g.frame();
    expect(g.core.live).toBeNull();
    expect(g.core.shown).toBe('A');
    const during = g.notesFrom('A', g.beatOf('A') + 0.5)[0];
    expect(g.hit('A', during)).toBeNull();
    g.run(3000);
    expect(g.judged.length).toBe(judgedBefore);
    g.engine.setFader('A', 1);
    g.frame();
    expect(g.core.live).toBe('A');
    g.run(100);
    expect(g.core.getStats().miss).toBe(missesBefore);
    const next = g.notesFrom('A', g.beatOf('A') + GUARD_BEATS + 0.1)[0];
    expect(g.hit('A', next)).toBe('perfect');
  });

  it('reset() forgets the judgments so the notes can be played again', async () => {
    const g = await setup('chill');
    g.start('A', DROP);
    const note = g.due('A')[0];
    expect(g.hit('A', note)).toBe('perfect');
    g.core.reset();
    expect(g.core.getStats().perfect).toBe(0);
    g.engine.seek('A', secAtBeat(g.tracks.A.meta.grid, note.beat - 3));
    g.run(100);
    expect(g.hit('A', note)).toBe('perfect');
    expect(g.core.getStats()).toMatchObject({ perfect: 1, combo: 1 });
  });
});
