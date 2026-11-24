/**
 * Note charts. A chart is generated from a track's sections and its onset energy, so every track
 * (built-in or the player's own) gets notes that follow its music.
 *
 * The four lanes have musical jobs:
 *   CLAP  the backbeat (beats 2 and 4): the backbone of every chart
 *   BOOM  downbeats and phrase starts (and beat 3 where the kick is)
 *   ZAP   syncopations, where the mid/high onsets are strong
 *   HORN  rare: phrase starts in a drop and the last beat before a drop
 *
 * Lanes 0–1 belong to the left thumb, lanes 2–3 to the right thumb. Every chart obeys the
 * per-difficulty spacing rules in RULES, whatever density it is played at.
 */
import { sectionAtBar, totalBars } from '../../core/beatgrid';
import { clamp01, hashString } from '../../core/math';
import type { BeatEnergy, Difficulty, Lane, LoadedTrack, TrackSection } from '../../core/types';

export interface Note {
  /** position on the track's beat grid (beat 0 = grid.firstBeatSec); always a multiple of 1/4 */
  beat: number;
  lane: Lane;
  /**
   * 0..1 importance for the density gate: the backbone (backbeat claps) is low, fills approach 1.
   * `setDensity(d)` shows the notes with `priority <= d`.
   */
  priority: number;
}

export interface Chart {
  trackId: string;
  difficulty: Difficulty;
  /** sorted by beat, then lane */
  notes: Note[];
}

export const LANE_BOOM: Lane = 0;
export const LANE_CLAP: Lane = 1;
export const LANE_ZAP: Lane = 2;
export const LANE_HORN: Lane = 3;

/** 0 = left thumb (BOOM, CLAP), 1 = right thumb (ZAP, HORN) */
export const handOf = (lane: number): 0 | 1 => (lane < 2 ? 0 : 1);

const SLOTS_PER_BEAT = 4; // the chart grid is sixteenth notes
const SLOTS_PER_BAR = 16;
/** no notes in the first two beats of a track */
const FIRST_SLOT = 2 * SLOTS_PER_BEAT;
/** above this tempo sixteenth-note runs are too fast for thumbs */
const MAX_BPM_FOR_SIXTEENTHS = 140;

export interface ChartRules {
  /** smallest note value in sixteenths: 4 = quarter notes, 2 = eighths, 1 = sixteenths */
  grid: number;
  /** smallest distance in sixteenths between two notes of the same thumb */
  sameHand: number;
  /** smallest distance in sixteenths between notes of different thumbs; 0 = chords are allowed */
  otherHand: number;
}

/** The playability contract of each difficulty. generateChart never breaks it. */
export const RULES: Record<Difficulty, ChartRules> = {
  chill: { grid: 4, sameHand: 4, otherHand: 4 },
  club: { grid: 2, sameHand: 4, otherHand: 2 },
  festival: { grid: 1, sameHand: 2, otherHand: 0 },
};

/**
 * Musical importance of every kind of note, most important first. It decides who wins when two
 * candidates collide and, through `priority`, which notes survive at a low density.
 */
const TIER = {
  /** rare and special: shown first, and nothing may push it out */
  horn: 0,
  /** the backbeat */
  clap4: 1,
  clap2: 2,
  /** downbeats */
  boomPhrase: 3,
  boom: 4,
  /** syncopated zaps, strongest onset first, with the kick on beat 3 in between */
  zap: [5, 7, 8, 9],
  boom3: 6,
  /** a syncopated kick */
  kick: 6.5,
  /** fills: run notes on the eighths, the second note of a chord, run notes on the sixteenths */
  runOn: 10,
  chord: 11,
  runOff: 12,
} as const;

/** How busy a bar may be: 0 sparse (intro, break, outro), 1 groove, 2 build, 3 drop. */
type Level = 0 | 1 | 2 | 3;

function levelOf(section: TrackSection | null, barLoudness: number): Level {
  if (!section) return barLoudness >= 0.75 ? 2 : barLoudness >= 0.45 ? 1 : 0;
  switch (section.kind) {
    case 'drop':
      return 3;
    case 'build':
      return 2;
    case 'groove':
      return section.energy >= 0.8 ? 2 : 1;
    default:
      return 0; // intro, break, outro: sparse at every difficulty
  }
}

/** Deterministic 0..1 hash of two integers. */
function hash01(seed: number, a: number, b: number): number {
  let h = (seed ^ Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 1, 0x85ebca6b)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Onset strength per sixteenth, normalised to the track's own strong onsets (0..1). */
function makeOnsets(energy: BeatEnergy, slots: number): { low: Float32Array; hi: Float32Array } {
  const div = energy.div > 0 ? energy.div : SLOTS_PER_BEAT;
  const at = (arr: Float32Array, slot: number): number => {
    const i = Math.round((slot * div) / SLOTS_PER_BEAT);
    const v = i >= 0 && i < arr.length ? arr[i] : 0;
    return v > 0 ? v : 0;
  };
  const low = new Float32Array(slots);
  const hi = new Float32Array(slots);
  for (let s = 0; s < slots; s++) {
    low[s] = at(energy.low, s);
    hi[s] = Math.max(at(energy.mid, s), at(energy.high, s));
  }
  normalise(low);
  normalise(hi);
  return { low, hi };
}

/** Divide by the 90th percentile so "strong" means strong for this track. */
function normalise(values: Float32Array): void {
  if (values.length === 0) return;
  const sorted = Float32Array.from(values).sort();
  const ref = sorted[Math.floor((sorted.length - 1) * 0.9)];
  if (!(ref > 1e-4)) {
    values.fill(0);
    return;
  }
  for (let i = 0; i < values.length; i++) values[i] = clamp01(values[i] / ref);
}

interface Candidate {
  slot: number;
  lane: Lane;
  /** musical importance (TIER): lower is placed first and survives at lower densities */
  tier: number;
}

/** Bit-reversed bar number, 0..1: sorts the bars of a section so that any prefix is evenly spread. */
function spread(bar: number): number {
  let v = 0;
  let x = bar & 0xffff;
  for (let i = 0; i < 16; i++) {
    v = (v << 1) | (x & 1);
    x >>= 1;
  }
  return v / 65536;
}

const OFFBEATS = [2, 6, 10, 14] as const;

export function generateChart(track: LoadedTrack, difficulty: Difficulty): Chart {
  const meta = track.meta;
  const chart: Chart = { trackId: meta.id, difficulty, notes: [] };
  const bars = totalBars(meta);
  const endSlot = (bars - 1) * SLOTS_PER_BAR; // nothing in the last bar
  if (!(endSlot > FIRST_SLOT)) return chart;

  const rules = RULES[difficulty];
  const chill = difficulty === 'chill';
  const club = difficulty === 'club';
  const festival = difficulty === 'festival';
  const sixteenths = festival && meta.grid.bpm <= MAX_BPM_FOR_SIXTEENTHS;
  const seed = hashString(meta.id);
  const totalSlots = bars * SLOTS_PER_BAR;
  const onsets = makeOnsets(track.energy, totalSlots);
  const loudness = track.energy.bar;

  const sections: (TrackSection | null)[] = [];
  const levels: Level[] = [];
  for (let bar = 0; bar < bars; bar++) {
    const section = sectionAtBar(meta, bar);
    sections.push(section);
    levels.push(levelOf(section, bar < loudness.length ? loudness[bar] : 0));
  }

  const candidates: Candidate[] = [];
  const add = (slot: number, lane: Lane, tier: number): void => {
    if (slot < FIRST_SLOT || slot >= endSlot) return;
    candidates.push({ slot, lane, tier });
  };

  const scored: { slot: number; score: number }[] = [];

  for (let bar = 0; bar < bars - 1; bar++) {
    const base = bar * SLOTS_PER_BAR;
    const section = sections[bar];
    const level = levels[bar];
    const sectionId = section ? section.startBar : -1;
    const barInSec = section ? bar - section.startBar : bar;
    const phraseBar = barInSec % 4;
    const progress = section && section.bars > 0 ? barInSec / section.bars : 0;
    const late = progress >= 0.5; // second half of the section (builds get busier)
    const preDrop = level < 3 && levels[bar + 1] === 3;
    /** the last slot that may hold a note: the bar before a drop ends on its horn, then a breath */
    const lastSlot = preDrop ? 12 : 15;

    // ── HORN: rare and special ──
    let hornOnOne = false;
    if (preDrop) add(base + 12, LANE_HORN, TIER.horn);
    if (level === 3 && barInSec % 8 === 0) {
      // a drop that was announced by a horn one beat earlier: below festival (no chords) its
      // first downbeat belongs to the BOOM
      const announced = bar > 0 && levels[bar - 1] < 3;
      if (festival || !announced) {
        add(base, LANE_HORN, TIER.horn);
        hornOnOne = true;
      }
    }

    // ── CLAP: the backbeat ──
    if (level === 0 && chill) {
      add(base + 12, LANE_CLAP, TIER.clap4);
    } else if (level === 0 && club) {
      add(base + 12, LANE_CLAP, TIER.clap4);
      if (barInSec % 2 === 1) add(base + 4, LANE_CLAP, TIER.clap2);
    } else {
      add(base + 4, LANE_CLAP, TIER.clap2);
      add(base + 12, LANE_CLAP, TIER.clap4);
    }

    // ── BOOM: downbeats and phrase starts ──
    let boomOnOne: boolean;
    if (level === 0) boomOnOne = chill ? phraseBar === 0 : club ? barInSec % 2 === 0 : true;
    else if (level === 1) boomOnOne = chill ? barInSec % 2 === 0 : true;
    else boomOnOne = true;
    if (boomOnOne) add(base, LANE_BOOM, phraseBar === 0 ? TIER.boomPhrase : TIER.boom);

    // beat 3, where the kick is
    let boomOnThree = false;
    if (club) boomOnThree = level === 3 || (level === 2 && late) || (level === 1 && phraseBar === 3);
    else if (festival) boomOnThree = level >= 1;
    boomOnThree = boomOnThree && onsets.low[base + 8] >= 0.3;
    if (boomOnThree) add(base + 8, LANE_BOOM, TIER.boom3);

    // ── festival: sixteenth-note trill at the end of a phrase ──
    let runFrom = 16;
    let runTo = -1;
    if (sixteenths) {
      if (preDrop) {
        // the end of a build rolls into the horn on beat 4
        if (level === 2) {
          runFrom = 8;
          runTo = 11;
        }
      } else if (
        (level === 3 && phraseBar === 3) ||
        (level === 2 && late && barInSec % 2 === 1) ||
        (level === 1 && barInSec % 8 === 7)
      ) {
        runFrom = 12;
        runTo = 15;
      }
      for (let s = runFrom; s <= runTo; s++) {
        if (s % 2 === 1) {
          add(base + s, LANE_ZAP, TIER.runOff + 0.1 * ((s - runFrom) >> 1));
        } else if (s % 4 !== 0) {
          // the left thumb stays on the pad it is already on
          add(base + s, s < 12 ? LANE_BOOM : LANE_CLAP, TIER.runOn);
        } else if (s === 8 && !boomOnThree) {
          add(base + s, LANE_BOOM, TIER.runOn);
        }
      }
    }

    // ── ZAP: syncopations where the mid/high onsets are strong ──
    if (chill) {
      // quarter notes only: the zap answers on beat 3
      if (level === 3 && barInSec % 2 === 1) add(base + 8, LANE_ZAP, TIER.zap[0]);
      else if (level === 2 && late) add(base + 8, LANE_ZAP, TIER.zap[0]);
      else if (level === 1 && phraseBar === 3) add(base + 8, LANE_ZAP, TIER.zap[1]);
    } else {
      let budget: number;
      if (club) budget = level === 3 ? 2 : level === 2 ? (late ? 2 : 1) : level === 1 ? 1 : 0;
      else budget = level === 3 ? 4 : level === 2 ? (late ? 4 : 3) : level === 1 ? 2 + (barInSec % 2) : barInSec % 2;
      if (budget > 0) {
        scored.length = 0;
        for (const off of OFFBEATS) {
          if (off > lastSlot || (off >= runFrom && off <= runTo)) continue;
          const slot = base + off;
          const strength = onsets.hi[slot];
          // sparse sections only get a zap where the music really has something
          if (level === 0 && strength < 0.2) continue;
          // festival: a syncopated kick goes to the BOOM pad instead
          if (festival && level >= 1 && onsets.low[slot] >= 0.6 && onsets.low[slot] > strength) {
            add(slot, LANE_BOOM, TIER.kick);
            continue;
          }
          // the pattern repeats every two bars inside a section, so it can be learned
          let score = strength + 0.3 * hash01(seed, sectionId * 2 + (barInSec % 2), off);
          // phrase ends lean on the second half of the bar: an eighth-note run into the next phrase
          if (phraseBar === 3 && off >= 10) score += 0.5;
          scored.push({ slot, score });
        }
        scored.sort((a, b) => b.score - a.score || a.slot - b.slot);
        const n = Math.min(budget, scored.length);
        for (let i = 0; i < n; i++) {
          add(scored[i].slot, LANE_ZAP, TIER.zap[Math.min(i, TIER.zap.length - 1)]);
        }
      }
    }

    // ── festival: two-lane chords on the accents of a drop ──
    if (festival && level === 3) {
      if (barInSec % 2 === 0 && !hornOnOne) add(base, LANE_ZAP, TIER.chord);
      if (phraseBar === 1) add(base + 12, LANE_ZAP, TIER.chord + 0.5);
    }
  }

  // ── place the candidates, most important first, never breaking the two-thumb rules ──
  candidates.sort((a, b) => a.tier - b.tier || a.slot - b.slot || a.lane - b.lane);
  const taken: [Uint8Array, Uint8Array] = [new Uint8Array(totalSlots), new Uint8Array(totalSlots)];
  const free = (hand: 0 | 1, slot: number, gap: number): boolean => {
    const occupied = taken[hand];
    const from = Math.max(0, slot - gap + 1);
    const to = Math.min(totalSlots - 1, slot + gap - 1);
    for (let s = from; s <= to; s++) if (occupied[s]) return false;
    return true;
  };
  const placed: Candidate[] = [];
  for (const c of candidates) {
    if (c.slot % rules.grid !== 0) continue;
    const hand = handOf(c.lane);
    // one thumb cannot be in two places: never two notes of one hand at once
    if (!free(hand, c.slot, Math.max(1, rules.sameHand))) continue;
    if (rules.otherHand > 0 && !free(hand === 0 ? 1 : 0, c.slot, rules.otherHand)) continue;
    taken[hand][c.slot] = 1;
    placed.push(c);
  }

  // ── priority: inside every section the notes are ranked by importance, evenly spread over its
  // bars, so density d shows the d-fraction that matters most and every section thins alike ──
  const groups = new Map<number, Candidate[]>();
  for (const c of placed) {
    const section = sections[Math.floor(c.slot / SLOTS_PER_BAR)];
    const key = section ? section.startBar : -1;
    const group = groups.get(key);
    if (group) group.push(c);
    else groups.set(key, [c]);
  }
  const notes: Note[] = [];
  for (const [key, group] of groups) {
    const firstBar = key < 0 ? 0 : key;
    const rank = (c: Candidate): number => spread(Math.floor(c.slot / SLOTS_PER_BAR) - firstBar);
    group.sort((a, b) => a.tier - b.tier || rank(a) - rank(b) || a.slot - b.slot || a.lane - b.lane);
    for (let i = 0; i < group.length; i++) {
      const c = group[i];
      notes.push({ beat: c.slot / SLOTS_PER_BEAT, lane: c.lane, priority: (i + 1) / group.length });
    }
  }
  notes.sort((a, b) => a.beat - b.beat || a.lane - b.lane);
  chart.notes = notes;
  return chart;
}
