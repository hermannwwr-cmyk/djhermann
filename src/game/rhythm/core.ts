/**
 * The rules of the playfield, without any drawing: which notes are on the highway, how a tap is
 * judged, when a note is missed, the combo and the score. Notes live on a deck's beat grid and are
 * always measured against the live deck's beat, so they slow down, stop and run backwards with
 * the record.
 */
import { beatAtSec } from '../../core/beatgrid';
import type { GameBus } from '../../core/events';
import { clamp, clamp01 } from '../../core/math';
import type {
  AudioEngine,
  DeckId,
  Difficulty,
  FrameState,
  Judgment,
  Lane,
  LoadedTrack,
  RhythmStats,
} from '../../core/types';
import { DECK_IDS } from '../../core/types';
import { generateChart } from './chart';
import type { Chart } from './chart';

// ───────────── note states ─────────────
/** not decided yet: still beyond the far end of the highway */
export const UNSEEN = 0;
/** on the highway, waiting to be hit */
export const SHOWN = 1;
/** kept off the highway by the density gate */
export const HIDDEN = 2;
/** let go without a judgment (a jump, a deck switch, passed while the record was held) */
export const SKIPPED = 3;
/** the old deck's pending notes after a switch: fading out, never judged */
export const FADING = 4;
/** judged. These two never change again until reset(). */
export const HIT = 5;
export const MISSED = 6;

// ───────────── tuning ─────────────
export const WINDOW_MS = { perfect: 40, great: 80, good: 125 } as const;
export const WINDOW_SCALE: Record<Difficulty, number> = { chill: 1.25, club: 1, festival: 0.85 };
export const POINTS: Record<Judgment, number> = { perfect: 100, great: 70, good: 40, miss: 0 };
/** combo needed for ×2, ×3, ×4 */
export const COMBO_STEPS = [10, 25, 50] as const;
export const ACCURACY_WEIGHT = { perfect: 1, great: 0.7, good: 0.4 } as const;
/** No note is due within this many beats of a deck switch or a jump of the playhead. */
export const GUARD_BEATS = 1;
/** A playhead move of more than this in one frame is a jump (seek, cue), not playback. */
const JUMP_BEATS = 1;
/** how far behind the miss line stale notes are still tidied up */
const SCAN_BACK_BEATS = 2;
/** a note decided this far inside the highway fades in instead of sliding in over the far end */
const APPEAR_INSIDE_BEATS = 0.3;

export const multiplierFor = (combo: number): number =>
  combo >= COMBO_STEPS[2] ? 4 : combo >= COMBO_STEPS[1] ? 3 : combo >= COMBO_STEPS[0] ? 2 : 1;

/** The notes of one deck with their state, in typed arrays for the frame loop. */
export interface DeckNotes {
  chart: Chart;
  count: number;
  /** sorted ascending */
  beat: Float32Array;
  lane: Uint8Array;
  priority: Float32Array;
  state: Uint8Array;
  /** frame time at which a note faded in inside the highway; 0 = it came in over the far end */
  appear: Float64Array;
  /** every note up to this beat has been decided */
  frontier: number;
  /** the deck's beat on its last live frame */
  lastBeat: number;
  /** that frame was normal forward playback */
  lastNormal: boolean;
  /** the notes must be lined up with the playhead again before anything is judged */
  stale: boolean;
}

export interface JudgeFx {
  lane: Lane;
  judgment: Judgment;
  /** signed, negative = early; 0 for a miss */
  errorMs: number;
  combo: number;
  multiplier: number;
  /** the combo that was lost (misses only) */
  broken: number;
  /** the multiplier went up with this hit */
  milestone: boolean;
}

export interface CoreOptions {
  engine: AudioEngine;
  bus: GameBus;
  difficulty?: Difficulty;
  /** called for every judgment, after the bus events (for the effects) */
  onJudge?: (fx: JudgeFx) => void;
}

/** first index with beat >= value */
function lowerBound(beats: Float32Array, count: number, value: number): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (beats[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** first index with beat > value */
function upperBound(beats: Float32Array, count: number, value: number): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (beats[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function buildDeckNotes(track: LoadedTrack, difficulty: Difficulty): DeckNotes {
  const chart = generateChart(track, difficulty);
  const count = chart.notes.length;
  const notes: DeckNotes = {
    chart,
    count,
    beat: new Float32Array(count),
    lane: new Uint8Array(count),
    priority: new Float32Array(count),
    state: new Uint8Array(count),
    appear: new Float64Array(count),
    frontier: -Infinity,
    lastBeat: 0,
    lastNormal: false,
    stale: true,
  };
  for (let i = 0; i < count; i++) {
    const n = chart.notes[i];
    notes.beat[i] = n.beat;
    notes.lane[i] = n.lane;
    notes.priority[i] = n.priority;
  }
  return notes;
}

export class RhythmCore {
  /** the notes of whatever track is on each deck */
  readonly decks: Record<DeckId, DeckNotes | null> = { A: null, B: null };
  /** the deck whose notes are on the highway: the live deck, or the last one in dead air */
  shown: DeckId | null = null;
  /** the live deck on the last frame; null = dead air */
  live: DeckId | null = null;
  /** the deck whose pending notes are fading out after a switch, and when that started */
  fadeDeck: DeckId | null = null;
  fadeAt = 0;
  /** beats from the hit line to the far end of the highway (set by the view) */
  lookahead = 4;
  density = 1;
  difficulty: Difficulty;

  private readonly engine: AudioEngine;
  private readonly bus: GameBus;
  private readonly onJudge: ((fx: JudgeFx) => void) | undefined;
  private readonly offs: (() => void)[] = [];
  private now = 0;
  private perfect = 0;
  private great = 0;
  private good = 0;
  private miss = 0;
  private combo = 0;
  private maxCombo = 0;
  private points = 0;
  private readonly fx: JudgeFx = {
    lane: 0,
    judgment: 'miss',
    errorMs: 0,
    combo: 0,
    multiplier: 1,
    broken: 0,
    milestone: false,
  };

  constructor(opts: CoreOptions) {
    this.engine = opts.engine;
    this.bus = opts.bus;
    this.onJudge = opts.onJudge;
    this.difficulty = opts.difficulty ?? 'chill';
    this.offs.push(
      this.engine.on('deck:load', (e) => this.chartDeck(e.deck)),
      this.engine.on('deck:eject', (e) => {
        this.decks[e.deck] = null;
      }),
    );
    for (const deck of DECK_IDS) this.chartDeck(deck);
  }

  /** (Re)build the notes for the track that is on a deck now. */
  private chartDeck(deck: DeckId): void {
    const track = this.engine.getLoadedTrack(deck);
    this.decks[deck] = track ? buildDeckNotes(track, this.difficulty) : null;
  }

  get goodWindowMs(): number {
    return WINDOW_MS.good * WINDOW_SCALE[this.difficulty];
  }

  setDifficulty(difficulty: Difficulty): void {
    if (difficulty === this.difficulty) return;
    this.difficulty = difficulty;
    for (const deck of DECK_IDS) this.chartDeck(deck);
  }

  /** Applies to notes that have not appeared yet: what is on the highway stays. */
  setDensity(density: number): void {
    this.density = Number.isFinite(density) ? clamp01(density) : 0;
  }

  setLookahead(beats: number): void {
    this.lookahead = clamp(beats, 1.5, 8);
  }

  getStats(): RhythmStats {
    const judged = this.perfect + this.great + this.good + this.miss;
    return {
      perfect: this.perfect,
      great: this.great,
      good: this.good,
      miss: this.miss,
      combo: this.combo,
      maxCombo: this.maxCombo,
      multiplier: multiplierFor(this.combo),
      points: this.points,
      accuracy:
        judged === 0
          ? 1
          : (this.perfect * ACCURACY_WEIGHT.perfect +
              this.great * ACCURACY_WEIGHT.great +
              this.good * ACCURACY_WEIGHT.good) /
            judged,
    };
  }

  reset(): void {
    this.perfect = this.great = this.good = this.miss = 0;
    this.combo = this.maxCombo = this.points = 0;
    this.fadeDeck = null;
    for (const deck of DECK_IDS) {
      const notes = this.decks[deck];
      if (!notes) continue;
      notes.state.fill(UNSEEN);
      notes.appear.fill(0);
      notes.frontier = -Infinity;
      notes.stale = true;
    }
  }

  destroy(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
  }

  // ───────────── per frame ─────────────

  update(frame: FrameState): void {
    this.now = frame.now;
    const live = frame.liveDeck;
    this.live = live;
    if (!live) {
      // dead air: the highway waits. Nothing appears, nothing is judged, nothing is missed.
      const waiting = this.shown ? this.decks[this.shown] : null;
      if (waiting) waiting.lastNormal = false;
      return;
    }
    const snap = frame.decks[live];
    const beat = snap.beat;
    if (this.shown !== live) this.switchTo(live, beat);
    const notes = this.decks[live];
    if (!notes) return;

    // a fresh chart or a jump of the playhead: line the notes up again, with a clear beat ahead
    if (notes.stale || (!snap.scratching && Math.abs(beat - notes.lastBeat) > JUMP_BEATS)) {
      this.align(notes, beat);
    }

    // notes come in over the far end of the highway; notes that leave it there are undecided again
    const edge = beat + this.lookahead;
    if (edge > notes.frontier) this.decide(notes, beat, edge);
    else if (edge < notes.frontier) this.undecide(notes, edge);

    // misses: only in normal forward playback, and only notes that slid out of the window now
    const normal = snap.playing && !snap.scratching && snap.rate > 0 && snap.bpm > 0;
    if (normal) {
      const windowBeats = (this.goodWindowMs * snap.bpm) / 60000;
      const missLine = beat - windowBeats;
      const wasInside = notes.lastBeat - windowBeats - 1e-4;
      const from = lowerBound(notes.beat, notes.count, missLine - SCAN_BACK_BEATS);
      for (let i = from; i < notes.count && notes.beat[i] < missLine; i++) {
        if (notes.state[i] !== SHOWN) continue;
        if (notes.lastNormal && notes.beat[i] >= wasInside) {
          notes.state[i] = MISSED;
          this.applyMiss(notes.lane[i] as Lane);
        } else {
          // it went past while the record was stopped, held or inaudible: not the player's miss
          notes.state[i] = SKIPPED;
        }
      }
    }
    notes.lastBeat = beat;
    notes.lastNormal = normal;
  }

  /** The DJ crossfaded: the old deck's pending notes fade out unjudged, the new deck's fade in. */
  private switchTo(deck: DeckId, beat: number): void {
    const old = this.shown;
    if (old) {
      const oldNotes = this.decks[old];
      if (oldNotes) {
        let fading = false;
        for (let i = 0; i < oldNotes.count; i++) {
          if (oldNotes.state[i] === SHOWN) {
            oldNotes.state[i] = FADING;
            fading = true;
          }
        }
        oldNotes.stale = true;
        oldNotes.lastNormal = false;
        if (fading) {
          this.fadeDeck = old;
          this.fadeAt = this.now;
        }
      }
    }
    this.shown = deck;
    const notes = this.decks[deck];
    if (notes) this.align(notes, beat);
  }

  /**
   * Line a deck's notes up with its playhead after a switch, a jump or a new chart. Everything
   * closer than GUARD_BEATS (and everything behind) is let go; the rest is decided afresh as it
   * comes into view. Judged notes stay judged.
   */
  private align(notes: DeckNotes, beat: number): void {
    const guard = beat + GUARD_BEATS;
    const { state, count } = notes;
    for (let i = 0; i < count; i++) {
      if (state[i] >= HIT) continue;
      state[i] = notes.beat[i] < guard ? SKIPPED : UNSEEN;
    }
    notes.frontier = guard;
    notes.lastBeat = beat;
    notes.lastNormal = false;
    notes.stale = false;
  }

  private decide(notes: DeckNotes, beat: number, edge: number): void {
    const guard = beat + GUARD_BEATS;
    const inside = edge - APPEAR_INSIDE_BEATS;
    const { state, count } = notes;
    for (let i = upperBound(notes.beat, count, notes.frontier); i < count && notes.beat[i] <= edge; i++) {
      if (state[i] !== UNSEEN) continue;
      const b = notes.beat[i];
      if (b < guard) {
        state[i] = SKIPPED; // too close to be fair
      } else if (notes.priority[i] <= this.density) {
        state[i] = SHOWN;
        notes.appear[i] = b < inside ? this.now : 0;
      } else {
        state[i] = HIDDEN;
      }
    }
    notes.frontier = edge;
  }

  private undecide(notes: DeckNotes, edge: number): void {
    const { state, count } = notes;
    const to = upperBound(notes.beat, count, notes.frontier);
    for (let i = upperBound(notes.beat, count, edge); i < to; i++) {
      if (state[i] < HIT) state[i] = UNSEEN;
    }
    notes.frontier = edge;
  }

  // ───────────── taps ─────────────

  /**
   * Judge a pad press at event time `perfMs`. Returns the judgment, or null for a free hit
   * (no live deck, or no pending note of that lane inside the window).
   */
  tap(lane: Lane, perfMs: number): Judgment | null {
    const live = this.live;
    if (!live) return null;
    const notes = this.decks[live];
    if (!notes || notes.stale) return null;
    const snap = this.engine.getDeck(live);
    if (!snap.track || !(snap.bpm > 0)) return null;
    const tapBeat = beatAtSec(snap.track.grid, this.engine.positionAt(live, perfMs));
    const msPerBeat = 60000 / snap.bpm;
    const windowMs = this.goodWindowMs;
    const windowBeats = windowMs / msPerBeat + 1e-6;

    let best = -1;
    let bestDist = Infinity;
    const to = tapBeat + windowBeats;
    for (let i = lowerBound(notes.beat, notes.count, tapBeat - windowBeats); i < notes.count; i++) {
      const b = notes.beat[i];
      if (b > to) break;
      if (notes.lane[i] !== lane || notes.state[i] !== SHOWN) continue;
      const dist = Math.abs(b - tapBeat);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    if (best < 0) return null;

    const errorMs = (tapBeat - notes.beat[best]) * msPerBeat;
    const abs = Math.abs(errorMs);
    const scale = WINDOW_SCALE[this.difficulty];
    const judgment: Judgment =
      abs <= WINDOW_MS.perfect * scale ? 'perfect' : abs <= WINDOW_MS.great * scale ? 'great' : 'good';
    notes.state[best] = HIT;
    this.applyHit(lane, judgment, errorMs);
    return judgment;
  }

  private applyHit(lane: Lane, judgment: Exclude<Judgment, 'miss'>, errorMs: number): void {
    if (judgment === 'perfect') this.perfect++;
    else if (judgment === 'great') this.great++;
    else this.good++;
    const before = multiplierFor(this.combo);
    this.combo++;
    if (this.combo > this.maxCombo) this.maxCombo = this.combo;
    const multiplier = multiplierFor(this.combo);
    const points = POINTS[judgment] * multiplier;
    this.points += points;
    const combo = this.combo;
    this.bus.emit('judge', { lane, judgment, errorMs, combo, multiplier, points });
    if (multiplier > before) this.bus.emit('combo:milestone', { combo, multiplier });
    this.emitFx(lane, judgment, errorMs, combo, multiplier, 0, multiplier > before);
  }

  private applyMiss(lane: Lane): void {
    this.miss++;
    const broken = this.combo;
    this.combo = 0;
    this.bus.emit('judge', { lane, judgment: 'miss', errorMs: 0, combo: 0, multiplier: 1, points: 0 });
    if (broken > 0) this.bus.emit('combo:break', { combo: broken });
    this.emitFx(lane, 'miss', 0, 0, 1, broken, false);
  }

  private emitFx(
    lane: Lane,
    judgment: Judgment,
    errorMs: number,
    combo: number,
    multiplier: number,
    broken: number,
    milestone: boolean,
  ): void {
    if (!this.onJudge) return;
    const fx = this.fx;
    fx.lane = lane;
    fx.judgment = judgment;
    fx.errorMs = errorMs;
    fx.combo = combo;
    fx.multiplier = multiplier;
    fx.broken = broken;
    fx.milestone = milestone;
    this.onJudge(fx);
  }
}
