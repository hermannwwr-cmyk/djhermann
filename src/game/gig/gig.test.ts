/**
 * Whole gigs, frame by frame at 60 fps of simulated time, on the mock engine, played by bots that
 * act through the engine exactly as the console would. Every frame the testkit checks the
 * invariants: getHud() never throws, an active mission has a title, a non-empty hint within the
 * HUD's length and at least one target, hype / progress / timeLeft stay in 0..1.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { BEATS_PER_BAR } from '../../core/types';
import type { DeckId, Difficulty, FrameState, Judgment } from '../../core/types';
import { mockMeta } from '../../dev/mocks';
import { TUNING } from './tuning';
import {
  createChaosBot,
  createInstantLibrary,
  createNotePlayer,
  createPatientBot,
  createPerfectBot,
  createSim,
} from './testkit';
import type { Bot, Sim } from './testkit';

let current: Sim | null = null;
afterEach(() => {
  current?.restoreConsole();
  current = null;
});

async function sim(o: Parameters<typeof createSim>[0] = {}): Promise<Sim> {
  const s = await createSim(o);
  current = s;
  await s.prepare();
  return s;
}

/** Run until the gig ends (or maxSec), with the given bots acting every frame. */
async function play(s: Sim, bots: Bot[], maxSec = 1200, extra?: (f: FrameState) => void): Promise<void> {
  await s.run(
    maxSec,
    (f) => {
      for (const b of bots) b.act(f);
      extra?.(f);
    },
    () => s.gig.ended,
  );
}

function expectClean(s: Sim): void {
  expect(s.violations).toEqual([]);
  expect(s.errors.map((e) => e.map(String).join(' '))).toEqual([]);
}

const statuses = (s: Sim): Set<string> => {
  const seen = new Set<string>();
  s.loop.add((f) => void seen.add(f.hud.status.replace(/\d+/g, 'n')));
  return seen;
};

const notes = (s: Sim, j: Judgment | (() => Judgment)): Bot => createNotePlayer(s, typeof j === 'function' ? j : () => j);

describe('perfect player', () => {
  for (const difficulty of ['chill', 'club', 'festival'] as Difficulty[]) {
    it(`finishes a 3-track ${difficulty} gig with a top grade`, async () => {
      const s = await sim({ difficulty });
      const seen = statuses(s);
      await play(s, [createPerfectBot(s, { manual: difficulty !== 'chill' }), notes(s, 'perfect')]);
      expectClean(s);
      expect(s.gig.ended).toBe(true);
      const r = s.gig.getResults();
      expect(r.completed).toBe(true);
      expect(r.grade).toBe('S');
      expect(r.stars).toBe(5);
      expect(r.trainwrecks).toBe(0);
      expect(r.deadAirSec).toBe(0);
      expect(r.missions.every((m) => m.rating !== 'fail')).toBe(true);
      // one start, two whole transitions, tricks, and the finale
      const kinds = r.missions.map((m) => m.kind);
      expect(kinds[0]).toBe('start-set');
      expect(kinds.filter((k) => k === 'start-deck')).toHaveLength(2);
      expect(kinds.filter((k) => k === 'beatmatch')).toHaveLength(2);
      expect(kinds.filter((k) => k === 'crossfade')).toHaveLength(2);
      expect(kinds.filter((k) => k === 'stop-deck')).toHaveLength(2);
      expect(kinds.at(-1)).toBe('echo-out');
      expect(kinds).toContain('bass-drop');
      expect(kinds).toContain('filter-sweep');
      expect(kinds).toContain('scratch');
      // every start-deck was on the one, every crossfade a bass swap
      expect(r.missions.filter((m) => m.kind === 'start-deck').every((m) => m.rating === 'perfect')).toBe(true);
      expect(r.missions.filter((m) => m.kind === 'crossfade').every((m) => m.label === 'BASS SWAP')).toBe(true);
      const bm = r.missions.filter((m) => m.kind === 'beatmatch');
      expect(bm.every((m) => m.label === (difficulty === 'chill' ? 'IN SYNC' : 'BY HAND'))).toBe(true);
      // results are complete
      expect(r.setlist.map((t) => t.id)).toEqual(['mock-golden', 'mock-lanterns', 'mock-coast']);
      expect(r.difficulty).toBe(difficulty);
      expect(r.hypeAvg).toBeGreaterThan(0.85);
      expect(r.hypePeak).toBeLessThanOrEqual(1);
      expect(r.rhythm.perfect).toBeGreaterThan(200);
      const bars = (r.durationSec * 122) / 60 / BEATS_PER_BAR;
      expect(r.hypeHistory.length).toBeGreaterThan(bars * 0.8);
      expect(r.hypeHistory.length).toBeLessThan(bars * 1.3);
      expect(r.score).toBeGreaterThan(r.rhythm.points);
      expect(r.durationSec).toBeGreaterThan(250);
      expect(r.durationSec).toBeLessThan(400);
      // events
      expect(s.events['gig:start']).toHaveLength(1);
      expect(s.events['gig:end']).toHaveLength(1);
      expect(s.events['gig:end'][0].results).toEqual(r);
      expect(s.events.callout.filter((c) => c.kind === 'drop').length).toBeGreaterThanOrEqual(5);
      expect(s.events.section.length).toBeGreaterThan(15);
      expect(s.gig.getHud().progress).toBe(1);
      // the HUD said what is coming
      expect(seen.has('MIX IN n BARS')).toBe(true);
      expect(seen.has('CROSSFADE IN n BARS')).toBe(true);
    }, 60000);
  }

  it('the new track plays its intro under the old one before the crossfade', async () => {
    const s = await sim({ difficulty: 'club' });
    const at: number[] = [];
    s.bus.on('mission:start', ({ mission }) => {
      if (mission.kind === 'crossfade') at.push(s.engine.getDeck(mission.targets.at(-1)!.gesture === 'right' ? 'B' : 'A').beat);
    });
    await play(s, [createPerfectBot(s, { manual: true }), notes(s, 'perfect')]);
    expect(at.length).toBe(2);
    for (const b of at) expect(b).toBeGreaterThanOrEqual(TUNING.transition.fadeAtBars * BEATS_PER_BAR - 0.1);
  }, 60000);
});

describe('idle player (presses PLAY once, then nothing)', () => {
  it('chill: the gig still ends, through rescues, with a low grade', async () => {
    const s = await sim({ difficulty: 'chill' });
    await play(s, [notes(s, 'miss')], 1200, () => {
      if (s.gig.getHud().mission?.kind === 'start-set') s.engine.play('A');
    });
    expectClean(s);
    expect(s.gig.ended).toBe(true);
    const r = s.gig.getResults();
    expect(r.completed).toBe(true); // chill cannot be lost
    expect(r.grade).toBe('D');
    expect(r.stars).toBeLessThanOrEqual(1);
    expect(r.missions.slice(1).every((m) => m.rating === 'fail')).toBe(true);
    const rescues = s.events.callout.filter((c) => c.kind === 'rescue').map((c) => c.text);
    expect(rescues).toContain('STARTED DECK B FOR YOU');
    expect(rescues).toContain('SYNCED DECK B FOR YOU');
    expect(rescues).toContain('FADING TO DECK B FOR YOU');
    expect(rescues).toContain('STARTED DECK A FOR YOU');
    expect(rescues).toContain('ENDED THE SET FOR YOU');
    // all three tracks were played
    expect(s.gig.getHud().set).toEqual({ index: 2, count: 3 });
    expect(r.durationSec).toBeLessThan(400);
    expect(r.deadAirSec).toBe(0);
  }, 60000);

  for (const difficulty of ['club', 'festival'] as Difficulty[]) {
    it(`${difficulty}: the crowd walks out and the gig ends`, async () => {
      const s = await sim({ difficulty });
      await play(s, [notes(s, 'miss')], 1200, () => {
        if (s.gig.getHud().mission?.kind === 'start-set') s.engine.play('A');
      });
      expectClean(s);
      expect(s.gig.ended).toBe(true);
      const r = s.gig.getResults();
      expect(r.completed).toBe(false);
      expect(r.grade).toBe('D');
      expect(r.stars).toBeLessThanOrEqual(TUNING.grade.starsWhenLost);
      expect(s.events.callout.some((c) => c.text === 'THE CROWD IS LEAVING!')).toBe(true);
      // not instantly: the crowd gives a struggling player time
      expect(r.durationSec).toBeGreaterThan(40);
    }, 60000);
  }

  it('club, hitting the notes but doing no missions: rescued all the way to the end', async () => {
    const s = await sim({ difficulty: 'club' });
    await play(s, [notes(s, 'perfect')], 1200, () => {
      if (s.gig.getHud().mission?.kind === 'start-set') s.engine.play('A');
    });
    expectClean(s);
    const r = s.gig.getResults();
    expect(r.completed).toBe(true);
    expect(['C', 'D']).toContain(r.grade);
  }, 60000);
});

describe('chaos player', () => {
  const seeds = Array.from({ length: 10 }, (_, i) => i + 1);
  for (const difficulty of ['chill', 'club', 'festival'] as Difficulty[]) {
    it(`${difficulty}: never throws, never hangs, always ends (${seeds.length} seeds)`, async () => {
      for (const seed of seeds) {
        const s = await sim({ difficulty });
        s.engine.play('A');
        const bot = createChaosBot(s, seed * 7919 + difficulty.length);
        const judge = ((): (() => Judgment) => {
          let n = seed;
          return () => (['perfect', 'great', 'good', 'miss'] as const)[n++ % 4];
        })();
        await play(s, [bot, notes(s, judge)], 1500);
        expectClean(s);
        expect(s.gig.ended, `seed ${seed}`).toBe(true);
        const r = s.gig.getResults();
        // the curfew is the backstop: no gig runs on and on
        expect(r.durationSec).toBeLessThan(700);
        expect(r.hypeAvg).toBeGreaterThanOrEqual(0);
        expect(r.hypeAvg).toBeLessThanOrEqual(1);
        expect(s.events['gig:end']).toHaveLength(1);
        s.restoreConsole();
      }
    }, 240000);
  }

  it('scratching for a whole minute does not stall the gig', async () => {
    const s = await sim({ difficulty: 'chill' });
    s.engine.play('A');
    await s.run(10);
    s.engine.scratchStart('A');
    let n = 0;
    await s.run(60, () => s.engine.scratchMove('A', (n++ % 20 < 10 ? 1 : -1) * 0.03));
    s.engine.scratchEnd('A');
    await play(s, [createPerfectBot(s, { manual: false }), notes(s, 'good')]);
    expectClean(s);
    expect(s.gig.ended).toBe(true);
    expect(s.gig.getResults().completed).toBe(true);
  }, 60000);

  it('every control dragged to an extreme, then left alone: the gig still ends', async () => {
    const s = await sim({ difficulty: 'chill' });
    s.engine.play('A');
    await s.run(5);
    for (const d of ['A', 'B'] as DeckId[]) {
      for (const b of ['low', 'mid', 'high'] as const) s.engine.setEq(d, b, 0);
      s.engine.setFilter(d, -1);
      s.engine.setFader(d, 0);
      s.engine.setTempo(d, 2);
      s.engine.setEcho(d, true);
    }
    s.engine.setCrossfader(1);
    await play(s, [notes(s, 'miss')], 1500);
    expectClean(s);
    expect(s.gig.ended).toBe(true);
    // chill: the game brought the music back by itself
    expect(s.events.callout.some((c) => c.text === 'MUSIC BACK ON FOR YOU')).toBe(true);
  }, 60000);
});

describe('trouble', () => {
  it('dead air is called after about 1.5 s and drains the hype; on club the crowd leaves', async () => {
    const s = await sim({ difficulty: 'club' });
    s.engine.play('A');
    await s.run(10);
    const hype0 = s.gig.getHud().hype;
    s.engine.pause('A');
    const t0 = s.t;
    await s.run(1.4);
    expect(s.events.callout.filter((c) => c.kind === 'deadair')).toHaveLength(0);
    await s.run(0.3);
    expect(s.events.callout.filter((c) => c.kind === 'deadair')).toHaveLength(1);
    // the player is told what to do about it
    const m = s.gig.getHud().mission!;
    expect(m.title).toBe('BRING THE MUSIC BACK');
    expect(m.targets[0]).toEqual({ control: 'A.play', gesture: 'tap' });
    expect(s.gig.getHud().status).toBe('DEAD AIR · PRESS PLAY ON DECK A');
    await s.run(3);
    expect(s.gig.getHud().hype).toBeLessThan(hype0 - 0.2);
    await play(s, [], 60);
    expect(s.gig.ended).toBe(true);
    expect(s.gig.getResults().completed).toBe(false);
    expect((s.t - t0) / 1000).toBeLessThan(30);
    expectClean(s);
  }, 60000);

  it('dead air on chill is rescued: the music comes back by itself', async () => {
    const s = await sim({ difficulty: 'chill' });
    s.engine.play('A');
    await s.run(10);
    s.engine.setFader('A', 0);
    await s.run(6);
    expect(s.events.callout.some((c) => c.text === 'MUSIC BACK ON FOR YOU')).toBe(true);
    expect(s.engine.getMixer().channels.A.fader).toBe(1);
    expectClean(s);
  });

  it('a trainwreck during the crossfade is called and costs the mix its rating', async () => {
    const s = await sim({ difficulty: 'club' });
    const perfect = createPerfectBot(s, { manual: true });
    let detuned = false;
    await play(s, [perfect, notes(s, 'perfect')], 200, (f) => {
      const m = f.hud.mission;
      if (m?.kind === 'crossfade' && !detuned) {
        detuned = true;
        s.engine.setTempo('B', 1.05);
      }
      if (m?.kind === 'stop-deck') s.restoreConsole();
    });
    const tw = s.events.callout.filter((c) => c.kind === 'trainwreck');
    expect(tw.length).toBeGreaterThanOrEqual(1);
    const fade = s.events['mission:end'].find((e) => e.result.kind === 'crossfade');
    expect(fade?.result.label).toBe('TRAINWRECK');
    expect(fade?.result.rating).not.toBe('perfect');
    expect(s.gig.getResults().trainwrecks).toBeGreaterThanOrEqual(1);
  }, 60000);

  it('no trainwreck while the new deck is silent behind the crossfader', async () => {
    const s = await sim({ difficulty: 'club' });
    s.engine.play('A');
    s.engine.play('B');
    s.engine.setTempo('B', 1.05);
    await s.run(30);
    expect(s.events.callout.filter((c) => c.kind === 'trainwreck')).toHaveLength(0);
    s.engine.setCrossfader(0);
    await s.run(10);
    expect(s.events.callout.filter((c) => c.kind === 'trainwreck')).toHaveLength(1);
  });
});

describe('missions in the gig', () => {
  /** run a perfect gig until the first mission of `kind`, then let `act` take over for it */
  async function until(s: Sim, kind: string): Promise<void> {
    const bot = createPerfectBot(s, { manual: true });
    await s.run(300, (f) => f.hud.mission?.kind !== kind && bot.act(f), () => s.gig.getHud().mission?.kind === kind);
    expect(s.gig.getHud().mission?.kind).toBe(kind);
  }

  async function startDeckAt(offsetMs: number): Promise<string> {
    const s = await sim({ difficulty: 'club' });
    await until(s, 'start-deck');
    expect(s.gig.getHud().mission!.hint).toMatch(/Get ready/);
    // wait for the mix-in bar line, then press `offsetMs` after (or before) it
    const ref = (): number => s.engine.getDeck('A').beat;
    const bpm = s.engine.getDeck('A').bpm;
    const target = Math.ceil(ref() / 4) * 4 + 4;
    const pressBeat = target + offsetMs / (60000 / bpm);
    let hints = new Set<string>();
    await s.run(20, (f) => void hints.add(f.hud.mission?.hint ?? ''), () => ref() >= pressBeat - 0.0005);
    s.engine.play('B');
    await s.frame();
    const r = s.events['mission:end'].at(-1)!.result;
    expect(r.kind).toBe('start-deck');
    hints = new Set([...hints].map((h) => h.replace(/\d/, 'k')));
    expect(hints.has('Get ready to press PLAY on deck B …  k')).toBe(true);
    s.restoreConsole();
    return `${r.rating}:${r.label}`;
  }

  it('START DECK: rated by the distance of the press from the bar line', async () => {
    expect(await startDeckAt(5)).toBe('perfect:ON THE ONE');
    expect(await startDeckAt(100)).toBe('great:CLOSE TO THE ONE');
    expect(await startDeckAt(-100)).toBe('great:CLOSE TO THE ONE');
    expect(await startDeckAt(-250)).toBe('ok:A BIT EARLY');
    expect(await startDeckAt(250)).toBe('ok:A BIT LATE');
  }, 60000);

  async function bassDropAt(offsetBeats: number): Promise<string> {
    const s = await sim({ difficulty: 'club' });
    await until(s, 'bass-drop');
    s.engine.setEq('A', 'low', 0);
    await s.frame();
    const d = s.engine.getDeck('A');
    const drop = d.track!.sections.find((x) => x.kind === 'drop' && x.startBar * 4 > d.beat)!.startBar * 4;
    await s.run(20, undefined, () => s.engine.getDeck('A').beat >= drop + offsetBeats);
    s.engine.setEq('A', 'low', 0.5);
    await s.frame();
    const r = s.events['mission:end'].at(-1)!.result;
    expect(r.kind).toBe('bass-drop');
    s.restoreConsole();
    return `${r.rating}:${r.label}`;
  }

  it('BASS DROP: rated by how close to the downbeat the bass came back', async () => {
    expect(await bassDropAt(0)).toBe('perfect:ON THE DROP');
    expect(await bassDropAt(-1)).toBe('ok:TOO EARLY');
    expect(await bassDropAt(0.3)).toBe('great:CLOSE');
    expect(await bassDropAt(1.5)).toBe('ok:TOO LATE');
  }, 60000);

  it('BEATMATCH on club asks for TEMPO (down = faster) then PITCH BEND, and SYNC scores less', async () => {
    const s = await sim({ difficulty: 'club' });
    await until(s, 'beatmatch');
    // deck B (124) runs faster than deck A (122): slide TEMPO up to slow it down
    const m = s.gig.getHud().mission!;
    expect(m.title).toBe('MATCH THE BEATS');
    expect(m.targets[0]).toEqual({ control: 'B.tempo', gesture: 'up' });
    expect(m.hint).toBe('Slide TEMPO on deck B up: 124.0 → 122.0 BPM');
    // the tip about SYNC comes up now and then
    const hints = new Set<string>();
    await s.run(5, (f) => void hints.add(f.hud.mission?.hint ?? ''));
    expect(hints.has('Tip: SYNC on deck B works too, for fewer points')).toBe(true);
    // tempo right, phase off: PITCH BEND
    s.engine.setTempo('B', 122 / 124);
    s.engine.seek('B', s.engine.getDeck('B').positionSec + 0.12);
    await s.frame();
    const m2 = s.gig.getHud().mission!;
    expect(m2.targets[0].control).toBe('B.nudge-');
    expect(m2.targets[0].gesture).toBe('hold');
    s.engine.sync('B');
    await s.run(5, undefined, () => s.gig.getHud().mission?.kind !== 'beatmatch');
    const r = s.events['mission:end'].at(-1)!.result;
    expect(r).toMatchObject({ kind: 'beatmatch', rating: 'ok', label: 'USED SYNC' });
  }, 60000);

  it('BEATMATCH is done at once when the beats already match', async () => {
    const s = await sim({ difficulty: 'chill' });
    await until(s, 'start-deck');
    // the player syncs deck B and starts it on a bar line, before being asked
    s.engine.sync('B');
    const bot = createPerfectBot(s, { manual: false });
    await s.run(30, (f) => bot.act(f), () => s.events['mission:end'].some((e) => e.result.kind === 'beatmatch'));
    const bm = s.events['mission:end'].find((e) => e.result.kind === 'beatmatch')!;
    expect(bm.result.rating).toBe('perfect');
    const started = s.events['mission:start'].find((e) => e.mission.kind === 'beatmatch')!;
    expect(started.mission.id).toBe(bm.mission.id);
  }, 60000);

  it('SCRATCH waits for the record to be let go', async () => {
    const s = await sim({ difficulty: 'festival' });
    await until(s, 'scratch');
    s.engine.scratchStart('A');
    for (let i = 0; i < 12; i++) {
      s.engine.scratchMove('A', (i % 2 ? -1 : 1) * 0.08);
      for (let k = 0; k < 4; k++) await s.frame();
    }
    const m = s.gig.getHud().mission!;
    expect(m.kind).toBe('scratch');
    expect(m.hint).toBe('Nice! Now let go of the record on deck A');
    s.engine.scratchEnd('A');
    await s.frame();
    expect(s.events['mission:end'].at(-1)!.result).toMatchObject({ kind: 'scratch', rating: 'perfect' });
    expectClean(s);
  }, 60000);

  it('a failed trick puts the knob back', async () => {
    const s = await sim({ difficulty: 'club' });
    await until(s, 'filter-sweep');
    s.engine.setFilter('A', -0.9); // turned, never brought back
    await s.run(30, undefined, () => s.gig.getHud().mission?.kind !== 'filter-sweep');
    expect(s.events['mission:end'].at(-1)!.result).toMatchObject({ kind: 'filter-sweep', rating: 'fail' });
    expect(s.engine.getMixer().channels.A.filter).toBe(0);
    expect(s.events.callout.at(-1)!.text).toBe('FILTER RESET FOR YOU');
  }, 60000);
});

describe('odd sets', () => {
  it('tracks too far apart in speed are cut, not beatmatched', async () => {
    const slow = mockMeta('slow', 'Slow Jam', 90, 0, 0);
    const s = await sim({ difficulty: 'club', setlist: ['mock-golden', 'slow'], library: createInstantLibrary([slow]) });
    await play(s, [createPerfectBot(s, { manual: true }), notes(s, 'perfect')]);
    expectClean(s);
    const r = s.gig.getResults();
    expect(r.completed).toBe(true);
    expect(r.missions.some((m) => m.kind === 'beatmatch')).toBe(false);
    const fade = r.missions.find((m) => m.kind === 'crossfade')!;
    expect(fade.title).toBe('CUT TO DECK B');
  }, 60000);

  it('the next track will not load: the gig goes on and ends with the tracks it has', async () => {
    const s = await sim({
      difficulty: 'club',
      setlist: ['mock-golden', 'mock-lanterns', 'mock-coast'],
      library: createInstantLibrary([], ['mock-coast']),
    });
    await play(s, [createPerfectBot(s, { manual: true }), notes(s, 'perfect')]);
    s.restoreConsole();
    expect(s.violations).toEqual([]);
    expect(s.gig.ended).toBe(true);
    const r = s.gig.getResults();
    expect(r.completed).toBe(true);
    expect(r.setlist.map((t) => t.id)).toEqual(['mock-golden', 'mock-lanterns']);
    expect(s.events.callout.some((c) => c.text === 'NEXT TRACK WOULD NOT LOAD')).toBe(true);
    expect(r.missions.at(-1)!.kind).toBe('echo-out');
  }, 60000);

  it('a setlist of one unknown id is filled up from the library', async () => {
    const s = await sim({ setlist: ['nope'] });
    expect(s.engine.getDeck('A').track).not.toBeNull();
    expect(s.engine.getDeck('B').track).not.toBeNull();
    expect(s.gig.getHud().set).toEqual({ index: 0, count: 2 });
  });

  it('prepare() resets the mixer: EQ flat, filter off, faders up, crossfader on A, tempos 0 %', async () => {
    const s = await createSim({});
    current = s;
    s.engine.setEq('A', 'low', 0);
    s.engine.setFilter('B', 0.7);
    s.engine.setFader('B', 0);
    s.engine.setCrossfader(1);
    s.engine.setTempo('A', 1.05);
    s.engine.setEcho('A', true);
    expect(() => s.gig.getHud()).not.toThrow();
    await s.prepare();
    const mx = s.engine.getMixer();
    expect(mx.channels.A.eq).toEqual({ low: 0.5, mid: 0.5, high: 0.5 });
    expect(mx.channels.B.filter).toBe(0);
    expect(mx.channels.B.fader).toBe(1);
    expect(mx.channels.A.echo).toBe(false);
    expect(mx.crossfader).toBe(-1);
    expect(s.engine.getDeck('A').tempo).toBe(1);
    expect(s.rhythm.density).toBe(0);
    expect(s.rhythm.difficulty).toBe('chill');
    await s.frame();
    expect(s.gig.getHud().mission).toMatchObject({
      kind: 'start-set',
      targets: [{ control: 'A.play', gesture: 'tap' }],
      timeLeft: 1,
    });
    // no time limit: nothing happens while the player waits
    await s.run(120);
    expect(s.gig.getHud().mission?.kind).toBe('start-set');
    expect(s.events['gig:start']).toHaveLength(0);
    s.engine.play('A');
    await s.frame();
    expect(s.events['gig:start']).toHaveLength(1);
    await expect(s.gig.loadTrack('A', 'mock-coast')).rejects.toThrow();
  });

  it('the player mixes the next deck in on their own: the gig goes with it', async () => {
    const s = await sim({ difficulty: 'club' });
    s.engine.play('A');
    await s.run(20);
    s.engine.sync('B');
    s.engine.play('B');
    await s.run(4);
    s.engine.setCrossfader(1);
    s.engine.pause('A');
    await s.run(20);
    expect(s.gig.getHud().set).toEqual({ index: 1, count: 3 });
    expect(s.engine.getDeck('A').track?.id).toBe('mock-coast');
    expectClean(s);
  });

  it('destroy() mid-gig: later frames do nothing and nothing throws', async () => {
    const s = await sim({});
    s.engine.play('A');
    await s.run(10);
    s.gig.destroy();
    await s.run(5);
    expect(() => s.gig.getHud()).not.toThrow();
    expect(() => s.gig.getResults()).not.toThrow();
    expectClean(s);
  });
});

describe('tutorial', () => {
  it('a player who waits a long time on every step still finishes', async () => {
    const s = await sim({ tutorial: true, setlist: ['mock-golden', 'mock-lanterns'] });
    const bot = createPatientBot(s, 75);
    let calm = 0;
    await play(s, [bot, notes(s, 'perfect')], 3600, (f) => {
      if (f.hud.mission?.kind === 'start-set' && calm++ > 600) s.engine.play('A');
    });
    expectClean(s);
    expect(s.gig.ended).toBe(true);
    const r = s.gig.getResults();
    expect(r.completed).toBe(true);
    expect(s.settings.get().tutorialDone).toBe(true);
    // one control at a time, in this order
    expect(r.missions.map((m) => m.kind)).toEqual([
      'start-set',
      'bass-drop',
      'filter-sweep',
      'scratch',
      'start-deck',
      'beatmatch',
      'crossfade',
      'stop-deck',
    ]);
    expect(r.missions.every((m) => m.rating !== 'fail')).toBe(true);
    // the music never ran out, nothing was penalised
    expect(r.deadAirSec).toBe(0);
    expect(r.hypeHistory.every((h, i) => i === 0 || h >= r.hypeHistory[i - 1] - 1e-9)).toBe(true);
    expect(s.events.callout.filter((c) => c.tone === 'bad')).toHaveLength(0);
    expect(r.durationSec).toBeGreaterThan(8 * 60);
  }, 120000);

  it('the pads lesson moves on even if no note is hit; the SYNC lesson asks for SYNC', async () => {
    const s = await sim({ tutorial: true, setlist: ['mock-golden', 'mock-lanterns'] });
    const seen = statuses(s);
    const bot = createPatientBot(s, 1);
    await play(s, [bot], 3600);
    expectClean(s);
    expect(s.gig.getResults().completed).toBe(true);
    expect(seen.has('TAP A PAD WHEN A NOTE REACHES THE LINE · n/n')).toBe(true);
    const sync = s.events['mission:start'].find((e) => e.mission.kind === 'beatmatch')!;
    expect(sync.mission.targets[0]).toEqual({ control: 'B.sync', gesture: 'tap' });
  }, 120000);
});

describe('free play', () => {
  it('two tracks cued, no missions, no end; hype follows the mix', async () => {
    const s = await sim({ mode: 'free' });
    expect(s.engine.getDeck('A').track?.id).toBe('mock-golden');
    expect(s.engine.getDeck('B').track?.id).toBe('mock-lanterns');
    expect(s.engine.getDeck('A').playing).toBe(false);
    s.engine.play('A');
    await s.run(10);
    const solo = s.gig.getHud().hype;
    expect(s.gig.getHud().mission).toBeNull();
    expect(s.gig.getHud().progress).toBeNull();
    expect(s.gig.getHud().set).toBeNull();
    expect(s.gig.getHud().status).toBe('GOLDEN HOUR DRIVE');
    s.engine.sync('B');
    s.engine.play('B');
    s.engine.setCrossfader(0);
    await s.run(20);
    expect(s.gig.getHud().hype).toBeGreaterThan(solo);
    expect(s.events.callout.some((c) => c.text === 'IN THE MIX')).toBe(true);
    s.engine.setTempo('B', 1.06);
    await s.run(10);
    expect(s.events.callout.some((c) => c.kind === 'trainwreck')).toBe(true);
    expect(s.gig.getHud().hype).toBeLessThan(solo);
    // loading stops the deck first
    await s.gig.loadTrack('B', 'mock-skyline');
    expect(s.engine.getDeck('B').track?.id).toBe('mock-skyline');
    expect(s.engine.getDeck('B').playing).toBe(false);
    await s.run(600);
    expect(s.gig.ended).toBe(false);
    expect(s.rhythm.density).toBe(0);
    expect(s.gig.getResults().missions).toEqual([]);
    expectClean(s);
  }, 60000);
});
