import { describe, expect, it } from 'vitest';
import { sectionAtBar, totalBars } from '../../core/beatgrid';
import type { Difficulty, LoadedTrack, SectionKind, TrackSection } from '../../core/types';
import { MOCK_CATALOG, mockMeta, mockTrack } from '../../dev/mocks';
import { LANE_BOOM, LANE_CLAP, LANE_HORN, LANE_ZAP, RULES, generateChart, handOf } from './chart';
import type { Chart, Note } from './chart';

const DIFFICULTIES: Difficulty[] = ['chill', 'club', 'festival'];
const track = (): LoadedTrack => mockTrack(MOCK_CATALOG[0]);

const notesPerBar = (chart: Chart, t: LoadedTrack, kind: SectionKind): number => {
  let bars = 0;
  let notes = 0;
  for (const s of t.meta.sections) if (s.kind === kind) bars += s.bars;
  for (const n of chart.notes) if (sectionAtBar(t.meta, Math.floor(n.beat / 4))?.kind === kind) notes++;
  return notes / bars;
};

/** smallest gap in beats between consecutive notes that satisfy `pick` */
const minGap = (notes: Note[], pick: (n: Note) => boolean): number => {
  let last = -Infinity;
  let min = Infinity;
  for (const n of notes) {
    if (!pick(n)) continue;
    if (n.beat !== last) min = Math.min(min, n.beat - last);
    last = n.beat;
  }
  return min;
};

describe('generateChart: basics', () => {
  it('is deterministic for a given track and difficulty', () => {
    for (const d of DIFFICULTIES) {
      expect(generateChart(track(), d)).toEqual(generateChart(track(), d));
    }
    const other = generateChart(mockTrack(MOCK_CATALOG[2]), 'club');
    expect(other.trackId).toBe(MOCK_CATALOG[2].id);
    expect(generateChart(track(), 'club').notes).not.toEqual(generateChart(track(), 'festival').notes);
  });

  it('returns sorted notes on the grid of the difficulty with a priority in (0, 1]', () => {
    for (const d of DIFFICULTIES) {
      const { notes } = generateChart(track(), d);
      expect(notes.length).toBeGreaterThan(50);
      const step = RULES[d].grid / 4;
      for (let i = 0; i < notes.length; i++) {
        const n = notes[i];
        expect([0, 1, 2, 3]).toContain(n.lane);
        expect(n.priority).toBeGreaterThan(0);
        expect(n.priority).toBeLessThanOrEqual(1);
        expect(Number.isInteger(n.beat / step)).toBe(true);
        if (i > 0) {
          const p = notes[i - 1];
          expect(n.beat > p.beat || (n.beat === p.beat && n.lane > p.lane)).toBe(true);
        }
      }
    }
  });

  it('leaves the first two beats and the last bar empty', () => {
    const t = track();
    const lastBarStart = (totalBars(t.meta) - 1) * 4;
    for (const d of DIFFICULTIES) {
      const { notes } = generateChart(t, d);
      expect(notes[0].beat).toBeGreaterThanOrEqual(2);
      expect(notes[notes.length - 1].beat).toBeLessThan(lastBarStart);
    }
  });

  it('survives tracks without sections, without onsets, and tracks that are too short', () => {
    const bare = mockTrack(mockMeta('bare', 'Bare', 120, 0, 0));
    bare.meta.sections = [];
    bare.energy.low.fill(0);
    bare.energy.mid.fill(0);
    bare.energy.high.fill(0);
    bare.energy.bar.fill(0.6);
    for (const d of DIFFICULTIES) {
      const { notes } = generateChart(bare, d);
      expect(notes.length).toBeGreaterThan(40);
      expect(minGap(notes, (n) => handOf(n.lane) === 0)).toBeGreaterThanOrEqual(RULES[d].sameHand / 4);
    }

    const short = mockTrack(mockMeta('short', 'Short', 120, 0, 0));
    short.meta.durationSec = 3; // one bar and a half
    expect(generateChart(short, 'festival').notes).toEqual([]);
    short.meta.durationSec = 0;
    expect(generateChart(short, 'festival').notes).toEqual([]);
  });

  it('reads onset energy at any subdivision', () => {
    const t = track();
    const eighths = mockTrack(MOCK_CATALOG[0]);
    const pick = (src: Float32Array): Float32Array => src.filter((_, i) => i % 2 === 0);
    eighths.energy = {
      div: 2,
      low: pick(t.energy.low),
      mid: pick(t.energy.mid),
      high: pick(t.energy.high),
      bar: t.energy.bar,
    };
    // the mock has its syncopation on the eighths, so the club chart is the same from either grid
    expect(generateChart(eighths, 'club').notes).toEqual(generateChart(t, 'club').notes);
  });
});

describe('generateChart: density follows difficulty and section energy', () => {
  it('gets busier with the difficulty', () => {
    const t = track();
    const [chill, club, festival] = DIFFICULTIES.map((d) => generateChart(t, d).notes.length);
    expect(club).toBeGreaterThan(chill * 1.3);
    expect(festival).toBeGreaterThan(club * 1.3);
  });

  it('keeps intros and breaks sparse and drops the busiest, at every difficulty', () => {
    const t = track();
    const sparseMax: Record<Difficulty, number> = { chill: 1.5, club: 2.25, festival: 3.75 };
    for (const d of DIFFICULTIES) {
      const chart = generateChart(t, d);
      const intro = notesPerBar(chart, t, 'intro');
      const brk = notesPerBar(chart, t, 'break');
      const groove = notesPerBar(chart, t, 'groove');
      const build = notesPerBar(chart, t, 'build');
      const drop = notesPerBar(chart, t, 'drop');
      expect(intro).toBeLessThanOrEqual(sparseMax[d]);
      expect(brk).toBeLessThanOrEqual(sparseMax[d]);
      expect(notesPerBar(chart, t, 'outro')).toBeLessThanOrEqual(sparseMax[d]);
      expect(groove).toBeGreaterThan(Math.max(intro, brk) * 1.5);
      expect(build).toBeGreaterThan(groove);
      expect(drop).toBeGreaterThanOrEqual(build);
      expect(drop).toBeGreaterThan(intro * 2.5);
    }
    // a chill drop is still calm: under one note per beat
    expect(notesPerBar(generateChart(t, 'chill'), t, 'drop')).toBeLessThan(4);
  });

  it('chill: quarter notes at most, never two notes at once, with rests', () => {
    const t = track();
    const { notes } = generateChart(t, 'chill');
    expect(minGap(notes, () => true)).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < notes.length; i++) expect(notes[i].beat).not.toBe(notes[i - 1].beat);
    // rests: far fewer notes than beats, even in a drop
    const beats = totalBars(t.meta) * 4;
    expect(notes.length).toBeLessThan(beats * 0.75);
  });

  it('club: some eighth notes, no sixteenths, no chords', () => {
    const { notes } = generateChart(track(), 'club');
    const eighths = notes.filter((n) => n.beat % 1 === 0.5).length;
    expect(eighths).toBeGreaterThan(notes.length * 0.1);
    expect(eighths).toBeLessThan(notes.length * 0.45);
    expect(notes.some((n) => n.beat % 0.5 !== 0)).toBe(false);
    expect(minGap(notes, () => true)).toBeGreaterThanOrEqual(0.5);
    for (let i = 1; i < notes.length; i++) expect(notes[i].beat).not.toBe(notes[i - 1].beat);
  });

  it('festival: eighth and sixteenth runs and two-lane chords', () => {
    const { notes } = generateChart(track(), 'festival');
    const sixteenths = notes.filter((n) => n.beat % 0.5 !== 0);
    expect(sixteenths.length).toBeGreaterThan(8);
    // a run: at least three notes in a row a sixteenth apart, thumbs alternating
    let run = 1;
    let longest = 1;
    for (let i = 1; i < notes.length; i++) {
      const gap = notes[i].beat - notes[i - 1].beat;
      if (gap === 0) continue;
      if (gap === 0.25) {
        expect(handOf(notes[i].lane)).not.toBe(handOf(notes[i - 1].lane));
        run++;
      } else run = 1;
      longest = Math.max(longest, run);
    }
    expect(longest).toBeGreaterThanOrEqual(3);
    // chords: exactly two notes, one per thumb
    const byBeat = new Map<number, Note[]>();
    for (const n of notes) byBeat.set(n.beat, [...(byBeat.get(n.beat) ?? []), n]);
    const chords = [...byBeat.values()].filter((g) => g.length > 1);
    expect(chords.length).toBeGreaterThan(8);
    for (const g of chords) {
      expect(g.length).toBe(2);
      expect(handOf(g[0].lane)).not.toBe(handOf(g[1].lane));
    }
  });

  it('festival drops the sixteenth runs on very fast tracks', () => {
    const fast = mockTrack(mockMeta('fast', 'Fast', 172, 0, 0));
    const { notes } = generateChart(fast, 'festival');
    expect(notes.some((n) => n.beat % 0.5 !== 0)).toBe(false);
  });
});

describe('generateChart: playable with two thumbs', () => {
  it('never asks one thumb for a fast repeat', () => {
    for (const t of MOCK_CATALOG.map((m) => mockTrack(m))) {
      for (const d of DIFFICULTIES) {
        const { notes } = generateChart(t, d);
        const same = RULES[d].sameHand / 4;
        expect(minGap(notes, (n) => handOf(n.lane) === 0)).toBeGreaterThanOrEqual(same);
        expect(minGap(notes, (n) => handOf(n.lane) === 1)).toBeGreaterThanOrEqual(same);
        // one thumb is never in two lanes at the same time
        for (let i = 1; i < notes.length; i++) {
          if (notes[i].beat === notes[i - 1].beat) {
            expect(handOf(notes[i].lane)).not.toBe(handOf(notes[i - 1].lane));
          }
        }
      }
    }
    // the lower difficulties: a thumb gets at least a whole beat between its notes
    expect(RULES.chill.sameHand).toBeGreaterThanOrEqual(4);
    expect(RULES.club.sameHand).toBeGreaterThanOrEqual(4);
  });
});

describe('generateChart: the lanes have musical jobs', () => {
  it('CLAP sits on the backbeat', () => {
    for (const d of DIFFICULTIES) {
      const claps = generateChart(track(), d).notes.filter((n) => n.lane === LANE_CLAP);
      const onBackbeat = claps.filter((n) => n.beat % 2 === 1).length;
      expect(claps.length).toBeGreaterThan(60);
      expect(onBackbeat / claps.length).toBeGreaterThanOrEqual(d === 'festival' ? 0.85 : 1);
    }
  });

  it('BOOM sits on downbeats, and on beat 3 at the harder difficulties', () => {
    const chill = generateChart(track(), 'chill').notes.filter((n) => n.lane === LANE_BOOM);
    expect(chill.every((n) => n.beat % 4 === 0)).toBe(true);
    const club = generateChart(track(), 'club').notes.filter((n) => n.lane === LANE_BOOM);
    expect(club.every((n) => n.beat % 2 === 0)).toBe(true);
    expect(club.some((n) => n.beat % 4 === 2)).toBe(true);
  });

  it('every phrase of a drop starts on a BOOM or a HORN', () => {
    const t = track();
    for (const d of DIFFICULTIES) {
      const { notes } = generateChart(t, d);
      for (const s of t.meta.sections.filter((x) => x.kind === 'drop')) {
        for (let bar = s.startBar; bar < s.startBar + s.bars; bar += 4) {
          const onOne = notes.filter((n) => n.beat === bar * 4).map((n) => n.lane);
          expect(onOne.includes(LANE_BOOM) || onOne.includes(LANE_HORN)).toBe(true);
        }
      }
    }
  });

  it('ZAP plays the syncopations', () => {
    const club = generateChart(track(), 'club').notes.filter((n) => n.lane === LANE_ZAP);
    expect(club.length).toBeGreaterThan(30);
    expect(club.every((n) => n.beat % 1 === 0.5)).toBe(true);
    const festival = generateChart(track(), 'festival').notes.filter((n) => n.lane === LANE_ZAP);
    expect(festival.filter((n) => n.beat % 1 !== 0).length / festival.length).toBeGreaterThan(0.85);
  });

  it('ZAP follows the strong mid/high onsets of the track', () => {
    const t = track();
    // put the only strong syncopation of every bar on the "and" of beat 2
    for (let i = 0; i < t.energy.high.length; i++) {
      const slot = i % 16;
      t.energy.high[i] = slot === 6 ? 1 : slot % 4 === 0 ? 0.2 : 0;
      t.energy.mid[i] = slot === 4 || slot === 12 ? 0.9 : 0;
    }
    const zaps = generateChart(t, 'club').notes.filter(
      (n) => n.lane === LANE_ZAP && sectionAtBar(t.meta, Math.floor(n.beat / 4))?.kind === 'groove',
    );
    expect(zaps.length).toBeGreaterThanOrEqual(6);
    // one zap per groove bar, and it lands on that onset (phrase ends may lean late)
    expect(zaps.filter((n) => n.beat % 4 === 1.5).length / zaps.length).toBeGreaterThanOrEqual(0.75);
  });

  it('festival moves a syncopated kick to the BOOM pad', () => {
    const t = track();
    for (let i = 0; i < t.energy.low.length; i++) if (i % 16 === 6) t.energy.low[i] = 1;
    const groove = t.meta.sections.find((s) => s.kind === 'groove') as TrackSection;
    const bar = groove.startBar + 1;
    const notes = generateChart(t, 'festival').notes;
    expect(notes.some((n) => n.beat === bar * 4 + 1.5 && n.lane === LANE_BOOM)).toBe(true);
    expect(notes.some((n) => n.beat === bar * 4 + 1.5 && n.lane === LANE_ZAP)).toBe(false);
  });

  it('HORN is rare: drop phrases and the last beat before a drop', () => {
    const t = track();
    const drops = t.meta.sections.filter((s) => s.kind === 'drop');
    for (const d of DIFFICULTIES) {
      const { notes } = generateChart(t, d);
      const horns = notes.filter((n) => n.lane === LANE_HORN);
      expect(horns.length).toBeGreaterThanOrEqual(drops.length);
      expect(horns.length / notes.length).toBeLessThan(0.03);
      for (const h of horns) {
        const bar = Math.floor(h.beat / 4);
        const here = sectionAtBar(t.meta, bar);
        const next = sectionAtBar(t.meta, bar + 1);
        const beforeDrop = here?.kind !== 'drop' && next?.kind === 'drop' && h.beat % 4 === 3;
        const phraseStart = here?.kind === 'drop' && h.beat % 4 === 0 && (bar - here.startBar) % 8 === 0;
        expect(beforeDrop || phraseStart).toBe(true);
      }
      // every drop is announced on the last beat before it
      for (const s of drops) {
        expect(horns.some((h) => h.beat === s.startBar * 4 - 1)).toBe(true);
      }
    }
  });
});

describe('generateChart: priority and the density gate', () => {
  it('ranks the backbone low and the fills high', () => {
    const mean = (ns: Note[]): number => ns.reduce((sum, n) => sum + n.priority, 0) / ns.length;
    for (const d of DIFFICULTIES) {
      const { notes } = generateChart(track(), d);
      const backbeat = notes.filter((n) => n.lane === LANE_CLAP && n.beat % 2 === 1);
      const booms = notes.filter((n) => n.lane === LANE_BOOM && n.beat % 4 === 0);
      const zaps = notes.filter((n) => n.lane === LANE_ZAP);
      expect(mean(backbeat)).toBeLessThan(mean(booms));
      expect(mean(booms)).toBeLessThan(mean(zaps));
      expect(Math.max(...notes.map((n) => n.priority))).toBe(1);
      // the special notes are among the first to show
      expect(Math.max(...notes.filter((n) => n.lane === LANE_HORN).map((n) => n.priority))).toBeLessThan(0.2);
    }
    // sixteenth-note fills are the last notes to appear
    const festival = generateChart(track(), 'festival').notes;
    expect(mean(festival.filter((n) => n.beat % 0.5 !== 0))).toBeGreaterThan(0.9);
  });

  it('density d shows about the d-fraction of every section, and everything at 1', () => {
    const t = track();
    for (const d of DIFFICULTIES) {
      const chart = generateChart(t, d);
      expect(chart.notes.filter((n) => n.priority <= 0).length).toBe(0);
      expect(chart.notes.filter((n) => n.priority <= 1).length).toBe(chart.notes.length);
      for (const density of [0.25, 0.5, 0.75]) {
        const shown: Chart = { ...chart, notes: chart.notes.filter((n) => n.priority <= density) };
        expect(shown.notes.length / chart.notes.length).toBeGreaterThan(density - 0.06);
        expect(shown.notes.length / chart.notes.length).toBeLessThanOrEqual(density);
        // sections keep their contrast when the chart is thinned
        expect(notesPerBar(shown, t, 'drop')).toBeGreaterThan(notesPerBar(shown, t, 'break') * 2);
      }
      // a thin chart is the backbone: mostly backbeat claps
      const thin = chart.notes.filter((n) => n.priority <= 0.25);
      const claps = thin.filter((n) => n.lane === LANE_CLAP && n.beat % 2 === 1).length;
      expect(claps / thin.length).toBeGreaterThan(0.85);
    }
  });

  it('a thinned section stays evenly spread over its bars', () => {
    const t = track();
    const drop = t.meta.sections.find((s) => s.kind === 'drop') as TrackSection;
    const chart = generateChart(t, 'club');
    const thin = chart.notes.filter(
      (n) => n.priority <= 0.12 && n.beat >= drop.startBar * 4 && n.beat < (drop.startBar + drop.bars) * 4,
    );
    const firstHalf = thin.filter((n) => n.beat < (drop.startBar + drop.bars / 2) * 4).length;
    expect(thin.length).toBeGreaterThanOrEqual(8);
    expect(Math.abs(firstHalf - thin.length / 2)).toBeLessThanOrEqual(2);
  });
});
