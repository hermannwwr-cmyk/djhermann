/**
 * The score: what plays when. A song's `arrange` function fills an Arranger with note events
 * (in beats), automation and the sidechain pattern; the renderer turns that into audio.
 * Everything here is pure and deterministic, with no sample rate in sight.
 */
import { rng } from '../core/math';
import type { Sample } from './dsp';
import { clap, crash, downlifter, hat, impact, kick, reverseCrash, riserNoise, riserTone, snap, snare, tom } from './synth';
import type { ClapParams, KickParams } from './synth';
import { BAR, STEPS_PER_BAR, STEPS_PER_BEAT, TOTAL_BARS, TOTAL_BEATS, swungStep } from './timeline';

export const STEMS = ['kick', 'drums', 'tops', 'bass', 'chords', 'pluck', 'lead', 'fx'] as const;
export type StemId = (typeof STEMS)[number];

export interface SynthEnv {
  sr: number;
  bpm: number;
}

/** A distinct sound of a track. `make` runs once per render; events share the result. */
export interface Sound {
  key: string;
  make: (env: SynthEnv) => Sample;
}

export interface NoteEvent {
  stem: StemId;
  sound: Sound;
  /** onset in beats from the first downbeat (may be fractional) */
  beat: number;
  /** linear gain on top of the stem's gain */
  gain: number;
  /** -1 (left) .. 1 (right) */
  pan: number;
  /** gate in beats: a loop plays this long, a one-shot is cut here; undefined = ring out */
  dur?: number;
  /** loops only: fade-in / fade-out in seconds */
  attack?: number;
  release?: number;
  /** loops only: where in the loop to start, 0..1 */
  offset?: number;
}

export type AutoCurve = 'lin' | 'exp' | 'step';
export interface AutoPoint {
  beat: number;
  value: number;
  /** how the value travels from the previous point to this one */
  curve: AutoCurve;
}
export type AutoParam = `${StemId}.cut` | `${StemId}.gain`;

export interface BusSettings {
  gainDb: number;
  /** high-pass corner in Hz, 0 = none */
  hp: number;
  /** send levels (linear) */
  reverb: number;
  delay: number;
  /** 0..1 how far the kick pushes this stem down */
  duck: number;
}

export interface MixSettings {
  stems: Record<StemId, BusSettings>;
  reverb: { decay: number; damping: number; preDelay: number; returnDb: number; duck: number };
  delay: { beats: number; feedback: number; damp: number; returnDb: number; toReverb: number };
  /** gain into the limiter; calibrated per track so every drop lands at the same loudness */
  masterDb: number;
}

export interface Score {
  events: NoteEvent[];
  auto: Partial<Record<AutoParam, AutoPoint[]>>;
  /** sidechain depth per beat, 0..1 (1 where a kick plays) */
  duck: Float32Array;
}

/** Value of an automation lane at a beat. Before the first point: the first value. */
export function autoValue(points: AutoPoint[], beat: number): number {
  const n = points.length;
  if (beat <= points[0].beat) return points[0].value;
  for (let i = 1; i < n; i++) {
    const b = points[i];
    if (beat < b.beat) {
      const a = points[i - 1];
      if (b.curve === 'step') return a.value;
      const u = (beat - a.beat) / (b.beat - a.beat);
      return b.curve === 'exp' && a.value > 0 && b.value > 0 ? a.value * Math.pow(b.value / a.value, u) : a.value + (b.value - a.value) * u;
    }
  }
  return points[n - 1].value;
}

const NOTE_OFFSETS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** 'A4' → 69, 'Bb3' → 58, 'F#5' → 78. */
export function note(name: string): number {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  if (!m) throw new Error(`bad note name ${name}`);
  return 12 * (Number(m[3]) + 1) + NOTE_OFFSETS[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}
export const notes = (names: string): number[] => names.trim().split(/\s+/).map(note);

export interface HitOptions {
  pan?: number;
  /** gate in sixteenths */
  dur?: number;
  /** set false to keep an odd sixteenth straight in a swung song */
  swing?: boolean;
}

export class Arranger {
  readonly events: NoteEvent[] = [];
  readonly auto: Partial<Record<AutoParam, AutoPoint[]>> = {};
  readonly duck = new Float32Array(TOTAL_BEATS + 8);
  readonly rand: () => number;
  private readonly sounds = new Map<string, Sound>();

  constructor(
    readonly bpm: number,
    seed: number,
    readonly swing = 0.5,
  ) {
    this.rand = rng(seed);
  }

  /** Register (or fetch) a sound by key. */
  sound(key: string, make: (env: SynthEnv) => Sample): Sound {
    let s = this.sounds.get(key);
    if (!s) this.sounds.set(key, (s = { key, make }));
    return s;
  }

  /** One-shot at an absolute sixteenth step. */
  hit(stem: StemId, sound: Sound, step: number, gain: number, o: HitOptions = {}): void {
    const pos = o.swing === false ? step : swungStep(step, this.swing);
    this.events.push({ stem, sound, beat: pos / STEPS_PER_BEAT, gain, pan: o.pan ?? 0, dur: o.dur === undefined ? undefined : o.dur / STEPS_PER_BEAT });
  }

  /** Sustained loop (a supersaw chord note) from a step for `dur` sixteenths. */
  hold(stem: StemId, sound: Sound, step: number, dur: number, gain: number, attack = 0.012, release = 0.09, pan = 0): void {
    this.events.push({ stem, sound, beat: step / STEPS_PER_BEAT, gain, pan, dur: dur / STEPS_PER_BEAT, attack, release, offset: this.rand() });
  }

  /** Kick on a step; kicks on the beat also drive the sidechain. */
  kick(sound: Sound, step: number, gain = 1): void {
    this.events.push({ stem: 'kick', sound, beat: step / STEPS_PER_BEAT, gain, pan: 0 });
    if (step % STEPS_PER_BEAT === 0) this.duck[step / STEPS_PER_BEAT] = Math.max(this.duck[step / STEPS_PER_BEAT], gain);
  }

  /** Sidechain without a kick (keeps the pump alive in a breakdown). */
  ghost(barFrom: number, barTo: number, depth: number): void {
    for (let b = barFrom * 4; b < barTo * 4; b++) this.duck[b] = Math.max(this.duck[b], depth);
  }

  /** Automation: jump to a value at a bar. */
  set(param: AutoParam, bar: number, value: number): void {
    this.point(param, bar * 4, value, 'step');
  }

  /** Automation: travel from one value to another between two bars. */
  ramp(param: AutoParam, barFrom: number, from: number, barTo: number, to: number, curve: AutoCurve = 'lin'): void {
    this.point(param, barFrom * 4, from, 'step');
    this.point(param, barTo * 4, to, curve);
  }

  private point(param: AutoParam, beat: number, value: number, curve: AutoCurve): void {
    (this.auto[param] ??= []).push({ beat, value, curve });
  }

  finish(): Score {
    for (const lane of Object.values(this.auto)) {
      // by beat; where a ramp ends and a jump starts on the same beat, the ramp's end comes first
      lane.sort((a, b) => a.beat - b.beat || Number(a.curve === 'step') - Number(b.curve === 'step'));
    }
    this.events.sort((a, b) => a.beat - b.beat);
    return { events: this.events, auto: this.auto, duck: this.duck };
  }
}

// ───────────────────────────── drum kit and transitions ─────────────────────────────

export interface KitParams {
  kick: KickParams;
  clap: ClapParams;
  /** closed-hat decay in seconds */
  hatDecay: number;
  hatHp: number;
  openDecay: number;
  snareTune: number;
  /** tom pitches in Hz, high then low */
  toms: [number, number];
  seed: number;
}

export interface Kit {
  kick: Sound;
  clap: Sound;
  /** three round-robin closed hats */
  hat: Sound[];
  open: Sound;
  /** accented and ghost shaker */
  shaker: Sound[];
  /** six snares, rising in pitch (for rolls) */
  snare: Sound[];
  snap: Sound;
  tomHi: Sound;
  tomLo: Sound;
  crash: Sound;
  impact: Sound;
  riser(bars: number): Sound;
  riserTone(bars: number, midi: number): Sound;
  downlifter(bars: number): Sound;
  reverse(beats: number): Sound;
}

export function makeKit(a: Arranger, p: KitParams): Kit {
  const s = p.seed;
  const barSec = (e: SynthEnv, bars: number): number => (bars * 240) / e.bpm;
  return {
    kick: a.sound('kick', (e) => kick(e.sr, p.kick)),
    clap: a.sound('clap', (e) => clap(e.sr, p.clap)),
    hat: [0, 1, 2].map((i) => a.sound(`hat${i}`, (e) => hat(e.sr, { decay: p.hatDecay * (1 + i * 0.12), len: 0.09, hp: p.hatHp, attack: 0.0003, seed: s + i * 13 }))),
    open: a.sound('open', (e) => hat(e.sr, { decay: p.openDecay, len: 0.34, hp: p.hatHp * 0.85, attack: 0.0005, seed: s + 99 })),
    shaker: [0, 1].map((i) => a.sound(`shaker${i}`, (e) => hat(e.sr, { decay: 0.032, len: 0.13, hp: 4200, attack: i ? 0.014 : 0.007, seed: s + 200 + i }))),
    snare: [0, 1, 2, 3, 4, 5].map((i) => a.sound(`snare${i}`, (e) => snare(e.sr, p.snareTune * (1 + i * 0.07), s + 300 + i))),
    snap: a.sound('snap', (e) => snap(e.sr, s + 400)),
    tomHi: a.sound('tomHi', (e) => tom(e.sr, p.toms[0], 0.09, s + 500)),
    tomLo: a.sound('tomLo', (e) => tom(e.sr, p.toms[1], 0.11, s + 501)),
    crash: a.sound('crash', (e) => crash(e.sr, s + 600)),
    impact: a.sound('impact', (e) => impact(e.sr, s + 700)),
    riser: (bars) => a.sound(`riser${bars}`, (e) => riserNoise(e.sr, barSec(e, bars), s + 800)),
    riserTone: (bars, midi) => a.sound(`riserTone${bars}:${midi}`, (e) => riserTone(e.sr, barSec(e, bars), midi, 24)),
    downlifter: (bars) => a.sound(`down${bars}`, (e) => downlifter(e.sr, barSec(e, bars), s + 900)),
    reverse: (beats) => a.sound(`reverse${beats}`, (e) => reverseCrash(e.sr, (beats * 60) / e.bpm, s + 1000)),
  };
}

// ───────────────────────────── the shared 64-bar skeleton ─────────────────────────────

export type Level = 'introA' | 'introB' | 'groove' | 'build' | 'drop' | 'drop2' | 'break' | 'outroA' | 'outroB';

export interface Chord {
  /** bass note (the sub plays this) */
  bass: number;
  /** supersaw voicing, low to high */
  notes: number[];
  /** tones for arpeggios and riffs, low to high */
  tones: number[];
}

export interface BarCtx {
  bar: number;
  /** absolute sixteenth step of the bar's downbeat */
  s: number;
  level: Level;
  /** bar index inside its section */
  idx: number;
  /** bars in the section */
  len: number;
  chord: Chord;
}

export interface SongParts {
  kit: Kit;
  /** tonic around octave 5, where the pitched riser lands */
  riserNote: number;
  chordAt(bar: number, level: Level): Chord;
  drums(a: Arranger, c: BarCtx): void;
  bass(a: Arranger, c: BarCtx): void;
  chords(a: Arranger, c: BarCtx): void;
  pluck(a: Arranger, c: BarCtx): void;
  lead(a: Arranger, c: BarCtx): void;
  /** chord low-pass cutoffs in Hz through the arrangement */
  cut: { intro: [number, number]; groove: number; build: [number, number]; breakdown: [number, number]; outro: number };
  /** leave the last beat of each build empty (for a vocal pick-up) */
  buildGap: boolean;
}

const LEVELS: [number, number, Level][] = [
  [BAR.intro, 4, 'introA'],
  [BAR.intro + 4, 4, 'introB'],
  [BAR.groove, 8, 'groove'],
  [BAR.build1, 4, 'build'],
  [BAR.drop1, 16, 'drop'],
  [BAR.breakdown, 8, 'break'],
  [BAR.build2, 4, 'build'],
  [BAR.drop2, 8, 'drop2'],
  [BAR.outro, 4, 'outroA'],
  [BAR.outro + 4, 4, 'outroB'],
];

export function levelAt(bar: number): { level: Level; idx: number; len: number } {
  for (const [start, len, level] of LEVELS) {
    if (bar >= start && bar < start + len) return { level, idx: bar - start, len };
  }
  throw new Error(`bar ${bar} out of range`);
}

/** Snare fill on the last beat of a bar, with a reverse cymbal into the next one. */
export function fill(a: Arranger, kit: Kit, bar: number, big: boolean): void {
  const s = bar * STEPS_PER_BAR;
  const vel = [0.45, 0.55, 0.7, 0.9];
  for (let i = 0; i < 4; i++) {
    a.hit('drums', kit.snare[big ? i + 1 : i], s + 12 + i, vel[i] * 0.8, { swing: false });
    if (big && i % 2 === 0) a.hit('drums', i ? kit.tomLo : kit.tomHi, s + 10 + i, 0.6, { pan: i ? 0.3 : -0.3, swing: false });
  }
  if (big) a.hit('drums', kit.snare[0], s + 10, 0.4, { swing: false });
  a.hit('fx', kit.reverse(2), s + 8, big ? 0.55 : 0.4);
}

/** The drums and effects of a four-bar build: kick thins out, snare roll accelerates, risers climb. */
export function build(a: Arranger, p: SongParts, bar: number, bigger: boolean): void {
  const { kit } = p;
  const s0 = bar * STEPS_PER_BAR;
  for (let b = 0; b < 3; b++) for (let q = 0; q < 4; q++) a.kick(kit.kick, s0 + b * 16 + q * 4, b === 2 ? 0.9 : 1);
  for (let b = 0; b < 2; b++) for (const q of [4, 12]) a.hit('drums', kit.clap, s0 + b * 16 + q, 0.9);
  for (let i = 0; i < 48; i++) a.hit('tops', kit.hat[i % 3], s0 + i, (i % 4 === 2 ? 0.6 : 0.3) * (0.7 + (0.3 * i) / 48), { pan: 0.15, swing: false });
  // the roll: eighths, sixteenths, then thirty-seconds, getting louder and higher
  const end = s0 + 64 - (p.buildGap ? 4 : 2);
  const rollFrom = s0 + (bigger ? 0 : 16);
  for (let st = rollFrom; st < end; ) {
    const u = (st - rollFrom) / (end - rollFrom);
    const rate = st < s0 + 32 ? 2 : st < s0 + 56 ? 1 : 0.5;
    a.hit('drums', kit.snare[Math.min(5, Math.floor(u * 6))], st, 0.22 + 0.68 * u * u, { swing: false });
    st += rate;
  }
  a.hit('fx', kit.riser(4), s0, 0.75);
  a.hit('fx', kit.riserTone(2, p.riserNote), s0 + 32, 0.42);
  a.hit('fx', kit.reverse(4), s0 + 48, 0.6);
  a.ramp('chords.cut', bar, p.cut.build[0], bar + 4, p.cut.build[1], 'exp');
}

/** The landing of a drop: crash, boom and a falling noise tail. */
export function land(a: Arranger, kit: Kit, bar: number, gain = 1): void {
  const s = bar * STEPS_PER_BAR;
  a.hit('fx', kit.crash, s, 0.8 * gain);
  a.hit('fx', kit.impact, s, 0.7 * gain);
  a.hit('fx', kit.downlifter(2), s, 0.5 * gain);
}

/**
 * Lay a song out on the shared skeleton: intro 8, groove 8, build 4, drop 16, break 8, build 4,
 * drop 8, outro 8. The song supplies its own patterns bar by bar; the builds, fills, transitions
 * and filter moves that every track needs are done here.
 */
export function arrangeStandard(a: Arranger, p: SongParts): void {
  const { kit } = p;
  for (let bar = 0; bar < TOTAL_BARS; bar++) {
    const { level, idx, len } = levelAt(bar);
    const c: BarCtx = { bar, s: bar * STEPS_PER_BAR, level, idx, len, chord: p.chordAt(bar, level) };
    if (level !== 'build' && level !== 'break') p.drums(a, c);
    p.bass(a, c);
    p.chords(a, c);
    p.pluck(a, c);
    p.lead(a, c);
  }

  build(a, p, BAR.build1, false);
  build(a, p, BAR.build2, true);

  // fills at the end of phrases, crashes at the start of sections
  fill(a, kit, BAR.groove - 1, false);
  fill(a, kit, BAR.build1 - 1, true);
  fill(a, kit, BAR.drop1 + 7, false);
  fill(a, kit, BAR.breakdown - 1, true);
  fill(a, kit, BAR.outro - 1, true);
  fill(a, kit, BAR.outro + 3, false);
  a.hit('fx', kit.crash, BAR.groove * 16, 0.45);
  land(a, kit, BAR.drop1);
  a.hit('fx', kit.crash, (BAR.drop1 + 8) * 16, 0.6);
  a.hit('fx', kit.crash, BAR.breakdown * 16, 0.5);
  a.hit('fx', kit.downlifter(2), BAR.breakdown * 16, 0.45);
  land(a, kit, BAR.drop2);
  a.hit('fx', kit.crash, BAR.outro * 16, 0.5);
  a.hit('fx', kit.reverse(4), (BAR.build2 - 1) * 16, 0.4);
  // the last downbeat: one kick and a cymbal to close
  a.kick(kit.kick, TOTAL_BARS * 16, 0.9);
  a.hit('fx', kit.crash, TOTAL_BARS * 16, 0.35);

  // chord filter: closed in the intro, opens through the builds, wide open in the drops
  a.ramp('chords.cut', BAR.intro + 4, p.cut.intro[0], BAR.groove, p.cut.intro[1], 'exp');
  a.ramp('chords.gain', BAR.intro + 4, 0.35, BAR.groove, 0.9);
  a.set('chords.cut', BAR.groove, p.cut.groove);
  a.set('chords.gain', BAR.groove, 1);
  a.set('chords.cut', BAR.drop1, 20000);
  a.ramp('chords.cut', BAR.breakdown, p.cut.breakdown[0], BAR.build2, p.cut.breakdown[1], 'exp');
  a.set('chords.cut', BAR.drop2, 20000);
  a.ramp('chords.cut', BAR.outro, 5000, BAR.outro + 4, p.cut.outro, 'exp');
  a.ramp('chords.gain', BAR.outro, 0.9, BAR.outro + 5, 0);
  // bass leaves through a closing filter
  a.set('bass.cut', 0, 20000);
  a.ramp('bass.cut', BAR.outro, 1800, BAR.outro + 4, 140, 'exp');
  a.set('bass.cut', BAR.outro + 5, 140);
  a.set('bass.gain', 0, 1);
  a.ramp('bass.gain', BAR.outro + 3, 1, BAR.outro + 4, 0);
}
