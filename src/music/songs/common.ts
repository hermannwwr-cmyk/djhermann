/**
 * The song factory: a song is a SongSpec (progression, hook, instruments, grooves, mix) and this
 * file turns it into the bar-by-bar parts that `arrangeStandard` lays out on the shared 64-bar
 * skeleton. Patterns are written as small text grids so a song reads like a tracker page:
 *
 *   melody   "C5 - - A4 | - . G4 -"   note name = new note, '-' = hold, '.' = rest ('|' is ignored)
 *   rhythm   "x - . x"                 'x' = hit (held through the '-' after it), '.' = rest
 *   bass     "x - o 5"                 'x' root, 'o' octave up, '5' fifth up, '-' hold, '.' rest
 *   arp      "0 . 2 1"                 index into the chord's tones (past the end = next octave up)
 *   hats     "x o O ."                 'x' closed accent, 'o' closed soft, 'O' open hat
 *   perc     "h . l s"                 'h' high tom/conga, 'l' low tom, 's' snap
 */
import type { TrackArt } from '../../core/types';
import type { SongDef } from '../render';
import { Arranger, arrangeStandard, levelAt, makeKit, note, notes } from '../score';
import type { BarCtx, BusSettings, Chord, Kit, KitParams, Level, MixSettings, Sound, SongParts, StemId, SynthEnv } from '../score';
import type { Sample } from '../dsp';
import { bassNote, bell, keys, lead, mallet, pluck, stringPluck, supersawLoop, vox } from '../synth';
import type { BassParams, BellParams, KeysParams, LeadParams, PluckParams, StringParams, SupersawParams, VoxParams, Vowel, Onset } from '../synth';
import { BAR, STEPS_PER_BAR } from '../timeline';

// ───────────────────────────── pattern parsing (pure) ─────────────────────────────

export const tokens = (src: string): string[] => src.replace(/\|/g, ' ').trim().split(/\s+/).filter(Boolean);

export interface MelNote {
  /** sixteenth step from the start of the phrase */
  step: number;
  /** length in sixteenths */
  len: number;
  midi: number;
}

export function parseMelody(src: string): MelNote[] {
  const out: MelNote[] = [];
  let cur: MelNote | null = null;
  tokens(src).forEach((t, i) => {
    if (t === '-') {
      if (cur) cur.len++;
    } else if (t === '.') cur = null;
    else out.push((cur = { step: i, len: 1, midi: note(t) }));
  });
  return out;
}

export interface Hit {
  step: number;
  len: number;
  sym: string;
}

/** Rhythm grid: every symbol other than '-' / '.' starts a hit that lasts through its '-'s. */
export function parseRhythm(src: string): Hit[] {
  const out: Hit[] = [];
  let cur: Hit | null = null;
  tokens(src).forEach((t, i) => {
    if (t === '-') {
      if (cur) cur.len++;
    } else if (t === '.') cur = null;
    else out.push((cur = { step: i, len: 1, sym: t }));
  });
  return out;
}

/** A chord from note names: bass note, supersaw voicing, tones for arps and riffs. */
export function chord(bass: string, voicing: string, tones: string): Chord {
  return { bass: note(bass), notes: notes(voicing), tones: notes(tones) };
}

/** Tone `i` of a chord; indexes past the end climb into the next octave. */
export function tone(c: Chord, i: number): number {
  const n = c.tones.length;
  return c.tones[i % n] + 12 * Math.floor(i / n);
}

/** MIDI note of a bass symbol over a chord, or null for a rest/hold. */
export function bassSym(c: Chord, sym: string): number | null {
  if (sym === 'x') return c.bass;
  if (sym === 'o') return c.bass + 12;
  if (sym === '5') return c.bass + 7;
  return null;
}

/** First bar of every section of the skeleton. */
export const SECTION_STARTS = [BAR.intro, BAR.groove, BAR.build1, BAR.drop1, BAR.breakdown, BAR.build2, BAR.drop2, BAR.outro] as const;

/** Bar index inside its section (intro and outro count as one 8-bar section each). */
export function sectionBar(bar: number): number {
  let start = 0;
  for (const s of SECTION_STARTS) if (bar >= s) start = s;
  return bar - start;
}

// ───────────────────────────── instruments ─────────────────────────────

export type Instrument =
  | { kind: 'pluck'; p: PluckParams }
  | { kind: 'string'; p: StringParams }
  | { kind: 'keys'; p: KeysParams }
  | { kind: 'mallet'; decay: number }
  | { kind: 'bell'; p: BellParams };

function instSound(a: Arranger, name: string, inst: Instrument, midi: number): Sound {
  return a.sound(`${name}:${midi}`, (e) => {
    switch (inst.kind) {
      case 'pluck':
        return pluck(e.sr, midi, inst.p);
      case 'string':
        return stringPluck(e.sr, midi, inst.p);
      case 'keys':
        return keys(e.sr, midi, inst.p);
      case 'mallet':
        return mallet(e.sr, midi, inst.decay);
      case 'bell':
        return bell(e.sr, midi, inst.p);
    }
  });
}

/** A vocal-chop syllable: "d:ah", "y:eh>ee" (onset : vowel > glide-to vowel). */
export interface Syllable {
  onset: Onset;
  vowel: Vowel;
  to?: Vowel;
}
export function syllable(src: string): Syllable {
  const [on, rest] = src.includes(':') ? src.split(':') : ['none', src];
  const [v, to] = rest.split('>');
  return { onset: on as Onset, vowel: v as Vowel, to: to as Vowel | undefined };
}

export type LeadVoice =
  | { kind: 'vox'; p: Omit<VoxParams, 'vowel' | 'to' | 'onset'>; syllables: string[] }
  | { kind: 'synth'; p: LeadParams }
  | { kind: 'inst'; inst: Instrument };

// ───────────────────────────── the spec ─────────────────────────────

export interface Layer {
  name: string;
  inst: Instrument;
  /** 'arp' plays one chord tone per hit; 'block' plays `voices` tones together */
  kind: 'arp' | 'block';
  /** one bar, 16 tokens (arp: tone indexes; block: rhythm) */
  pattern: string;
  /** a different bar for the drops (default: pattern) */
  dropPattern?: string;
  levels: Level[];
  gain: number;
  /** semitones added to every note */
  transpose?: number;
  /** block: how many tones from the bottom of chord.tones */
  voices?: number;
  /** stereo spread: hits alternate between -pan and +pan */
  pan?: number;
}

export interface SongSpec {
  id: string;
  title: string;
  bpm: number;
  key: string;
  art: TrackArt;
  seed: number;
  swing: number;
  kit: KitParams;
  /** 4 or 8 bars; restarts at every section */
  progression: Chord[];
  riserNote: string;
  drums: {
    /** a bar of hats for the full groove */
    hats: string;
    /** a bar of hats for the first half of the intro and the end of the outro */
    hatsLight: string;
    shaker: boolean;
    /** a bar of percussion for the groove and the drops */
    perc?: string;
    percGain?: number;
    /** extra ghost-clap steps in the drops */
    clapGhosts?: number[];
  };
  bass: { p: BassParams; groove: string; drop: string; gain?: number };
  chords: { saw: SupersawParams; groove: string; drop: string; stabRelease?: number };
  layers: Layer[];
  lead: {
    voice: LeadVoice;
    /** 4 bars each: A over the first half of an 8-bar phrase, B over the second */
    hookA: string;
    hookB: string;
    /** a note on the last beat of each build */
    pickup?: string;
    /** semitone offset of a quieter double in the drops (e.g. -12), none if unset */
    double?: number;
    /** play the B phrase filtered at the end of the groove */
    teaser: boolean;
  };
  cut: SongParts['cut'];
  mix: MixSettings;
}

// ───────────────────────────── mix defaults ─────────────────────────────

const bus = (gainDb: number, hp: number, reverb: number, delay: number, duck: number): BusSettings => ({ gainDb, hp, reverb, delay, duck });

/** Per-stem changes a song makes to the default mix; `trim` is added to the default gain in dB. */
export type BusTweak = Partial<Omit<BusSettings, 'gainDb'>> & { trim?: number };

/**
 * A balanced starting mix (drop RMS of each stem soloed, before the master gain: kick ≈ -14,
 * bass ≈ -15, chords and lead ≈ -18, plucks ≈ -21, clap ≈ -26, hats ≈ -30 dB); songs trim it.
 */
export function baseMix(over: Partial<Record<StemId, BusTweak>> = {}, rest: Partial<Omit<MixSettings, 'stems'>> = {}): MixSettings {
  const stems: Record<StemId, BusSettings> = {
    kick: bus(-5, 0, 0, 0, 0),
    drums: bus(-4.5, 160, 0.16, 0, 0),
    tops: bus(-6, 450, 0.05, 0, 0.12),
    bass: bus(-10, 0, 0, 0, 0.9),
    chords: bus(-9.5, 190, 0.22, 0.04, 0.72),
    pluck: bus(-12, 220, 0.2, 0.26, 0.4),
    lead: bus(0, 260, 0.2, 0.2, 0.3),
    fx: bus(-6, 140, 0.16, 0, 0.1),
  };
  for (const k of Object.keys(over) as StemId[]) {
    const { trim = 0, ...restTweak } = over[k]!;
    stems[k] = { ...stems[k], ...restTweak, gainDb: stems[k].gainDb + trim };
  }
  return {
    stems,
    reverb: { decay: 0.72, damping: 0.4, preDelay: 0.022, returnDb: -5, duck: 0.45, ...rest.reverb },
    delay: { beats: 0.75, feedback: 0.38, damp: 0.42, returnDb: -9, toReverb: 0.2, ...rest.delay },
    masterDb: rest.masterDb ?? 0,
  };
}

// ───────────────────────────── spec → SongDef ─────────────────────────────

const ON_DROP = (l: Level): boolean => l === 'drop' || l === 'drop2';

export function defineSong(spec: SongSpec): SongDef {
  const hookA = parseMelody(spec.lead.hookA);
  const hookB = parseMelody(spec.lead.hookB);
  const hats = parseRhythm(spec.drums.hats);
  const hatsLight = parseRhythm(spec.drums.hatsLight);
  const perc = spec.drums.perc ? parseRhythm(spec.drums.perc) : [];
  const bassGroove = parseRhythm(spec.bass.groove);
  const bassDrop = parseRhythm(spec.bass.drop);
  const chGroove = parseRhythm(spec.chords.groove);
  const chDrop = parseRhythm(spec.chords.drop);
  const layers = spec.layers.map((l) => ({ ...l, bar: parseRhythm(l.pattern), drop: parseRhythm(l.dropPattern ?? l.pattern) }));
  const prog = spec.progression;
  const chordOf = (bar: number): Chord => prog[sectionBar(bar) % prog.length];

  function arrange(a: Arranger): void {
    const kit: Kit = makeKit(a, spec.kit);
    const sixteenth = (e: { bpm: number }): number => 15 / e.bpm;
    const bassSound = (midi: number, len: number): Sound =>
      a.sound(`bass:${midi}:${len}`, (e) => bassNote(e.sr, midi, len * sixteenth(e) * 0.94, spec.bass.p));
    // one supersaw loop per note and render (keyed by the render's env object, so nothing outlives it)
    const loops = new WeakMap<object, Map<number, Sample>>();
    const sawLoop = (e: SynthEnv, midi: number): Sample => {
      let m = loops.get(e);
      if (!m) loops.set(e, (m = new Map()));
      let s = m.get(midi);
      if (!s) m.set(midi, (s = supersawLoop(e.sr, midi, spec.chords.saw)));
      return s;
    };
    /** A whole chord as one sample: the notes' loops summed under an attack / hold / release envelope. */
    const chordSound = (chordNotes: number[], len: number, attack: number, release: number): Sound =>
      a.sound(`chord:${chordNotes.join(',')}:${len}:${attack}:${release}`, (e) => {
        const hold = Math.round(len * sixteenth(e) * e.sr);
        const att = Math.max(1, Math.round(attack * e.sr));
        const rel = Math.max(1, Math.round(release * e.sr));
        const n = Math.max(hold, att) + rel;
        const l = new Float32Array(n);
        const r = new Float32Array(n);
        chordNotes.forEach((midi, v) => {
          const s = sawLoop(e, midi);
          const size = s.l.length;
          let idx = Math.floor(((v * 0.381966 + 0.13) % 1) * size);
          const sr2 = s.r ?? s.l;
          for (let i = 0; i < n; i++) {
            l[i] += s.l[idx];
            r[i] += sr2[idx];
            if (++idx === size) idx = 0;
          }
        });
        const gate = Math.max(hold, att);
        for (let i = 0; i < n; i++) {
          const env = i < att ? i / att : i < gate ? 1 : 1 - (i - gate) / rel;
          l[i] *= env;
          r[i] *= env;
        }
        return { l, r };
      });
    const syl = spec.lead.voice.kind === 'vox' ? spec.lead.voice.syllables.map(syllable) : [];

    const leadSound = (n: MelNote, idx: number, prev: number | null, shift: number): Sound => {
      const v = spec.lead.voice;
      const midi = n.midi + shift;
      if (v.kind === 'vox') {
        const s = syl[idx % syl.length];
        return a.sound(`vox:${midi}:${n.len}:${s.onset}:${s.vowel}:${s.to ?? ''}`, (e) =>
          vox(e.sr, midi, n.len * sixteenth(e) * 0.9, { ...v.p, vowel: s.vowel, to: s.to, onset: s.onset }),
        );
      }
      if (v.kind === 'synth') {
        const pm = prev === null ? null : prev + shift;
        return a.sound(`lead:${midi}:${n.len}:${pm ?? ''}`, (e) => lead(e.sr, midi, n.len * sixteenth(e) * 0.92, pm, v.p));
      }
      return instSound(a, 'leadInst', v.inst, midi);
    };

    /** Play bar `inPhrase` (0..3) of a hook phrase at the bar starting on step s. */
    const playHook = (phrase: MelNote[], inPhrase: number, s: number, gain: number, shift: number): void => {
      const from = inPhrase * STEPS_PER_BAR;
      phrase.forEach((n, i) => {
        if (n.step < from || n.step >= from + STEPS_PER_BAR) return;
        const prevNote = i > 0 ? phrase[i - 1] : null;
        const prev = prevNote && prevNote.step + prevNote.len >= n.step ? prevNote.midi : null;
        const dur = spec.lead.voice.kind === 'inst' ? undefined : n.len;
        a.hit('lead', leadSound(n, i, prev, shift), s + n.step - from, gain, { dur, swing: false });
      });
    };

    const parts: SongParts = {
      kit,
      riserNote: note(spec.riserNote),
      chordAt: (bar) => chordOf(bar),
      cut: spec.cut,
      buildGap: spec.lead.pickup !== undefined,

      drums(a2: Arranger, c: BarCtx): void {
        const { level, s, idx } = c;
        for (let q = 0; q < 4; q++) a2.kick(kit.kick, s + q * 4);
        const light = level === 'introA' || level === 'outroB';
        if (level !== 'introA') {
          a2.hit('drums', kit.clap, s + 4, 0.92);
          a2.hit('drums', kit.clap, s + 12, 0.95);
          if (ON_DROP(level)) for (const g of spec.drums.clapGhosts ?? []) a2.hit('drums', kit.clap, s + g, 0.28);
        }
        // the very first bar of the intro: hats come in on its second half so the kick is alone on beat 0
        for (const h of light ? hatsLight : hats) {
          if (level === 'introA' && idx === 0 && h.step < 8) continue;
          const hum = 0.9 + 0.2 * a2.rand();
          if (h.sym === 'O') a2.hit('tops', kit.open, s + h.step, 0.5 * hum, { pan: -0.12 });
          else a2.hit('tops', kit.hat[(h.step >> 1) % 3], s + h.step, (h.sym === 'x' ? 0.5 : 0.27) * hum, { pan: 0.14 });
        }
        if (ON_DROP(level) && !spec.drums.shaker) {
          // drops get ghost sixteenths in the gaps of the hat pattern: brighter, busier tops
          const used = new Set(hats.map((h) => h.step));
          for (let i = 1; i < 16; i += 2) if (!used.has(i)) a2.hit('tops', kit.hat[(i >> 1) % 3], s + i, 0.16 * (0.85 + 0.3 * a2.rand()), { pan: 0.3 });
        }
        const busy = ON_DROP(level) || (level === 'groove' && idx >= 4) || level === 'outroA';
        if (spec.drums.shaker && busy) {
          for (let i = 0; i < 16; i++) {
            const acc = i % 4 === 2;
            a2.hit('tops', kit.shaker[acc ? 0 : 1], s + i, (acc ? 0.36 : 0.17) * (0.9 + 0.2 * a2.rand()), { pan: -0.35 });
          }
        }
        if (busy || level === 'groove') {
          const pg = spec.drums.percGain ?? 0.5;
          for (const p of perc) {
            const snd = p.sym === 'h' ? kit.tomHi : p.sym === 'l' ? kit.tomLo : kit.snap;
            a2.hit('drums', snd, s + p.step, pg * (p.sym === 's' ? 0.7 : 1), { pan: p.sym === 'h' ? 0.4 : p.sym === 'l' ? -0.3 : 0.2 });
          }
        }
        if (level === 'drop2' && idx % 4 === 0 && idx > 0) a2.hit('fx', kit.crash, s, 0.35);
      },

      bass(a2: Arranger, c: BarCtx): void {
        const { level, s, idx, chord: ch } = c;
        const g = spec.bass.gain ?? 1;
        let pat: Hit[] | null = null;
        let gain = g;
        if (level === 'groove' || level === 'outroA' || level === 'outroB') pat = bassGroove;
        else if (ON_DROP(level)) pat = bassDrop;
        else if (level === 'build' && idx < 3) pat = HOLD_BAR;
        else if (level === 'break' && idx >= 4) {
          pat = HOLD_BAR;
          gain = g * 0.6;
        }
        if (!pat) return;
        for (const h of pat) {
          const midi = bassSym(ch, h.sym);
          if (midi !== null) a2.hit('bass', bassSound(midi, h.len), s + h.step, gain, { swing: false });
        }
      },

      chords(a2: Arranger, c: BarCtx): void {
        const { level, s, chord: ch } = c;
        if (level === 'introA') return;
        const pat = ON_DROP(level) ? chDrop : level === 'groove' ? chGroove : HOLD_BAR;
        const stab = pat.length > 1;
        for (const h of pat) {
          a2.hit('chords', chordSound(ch.notes, h.len, stab ? 0.006 : 0.03, stab ? spec.chords.stabRelease ?? 0.06 : 0.14), s + h.step, 1, { swing: false });
          // the drops stack the chord tones an octave up: wider, brighter, bigger
          if (ON_DROP(level)) a2.hit('chords', chordSound(ch.tones.map((t) => t + 12), h.len, stab ? 0.006 : 0.03, stab ? spec.chords.stabRelease ?? 0.06 : 0.14), s + h.step, 0.4, { swing: false });
        }
      },

      pluck(a2: Arranger, c: BarCtx): void {
        const { level, s, chord: ch } = c;
        for (const l of layers) {
          if (!l.levels.includes(level)) continue;
          const pat = ON_DROP(level) ? l.drop : l.bar;
          const t = l.transpose ?? 0;
          let side = 1;
          for (const h of pat) {
            const pan = (l.pan ?? 0) * side;
            side = -side;
            if (l.kind === 'arp') {
              const i = Number(h.sym);
              if (Number.isNaN(i)) continue;
              a2.hit('pluck', instSound(a2, l.name, l.inst, tone(ch, i) + t), s + h.step, l.gain, { pan });
            } else {
              const v = l.voices ?? 3;
              for (let k = 0; k < v; k++) a2.hit('pluck', instSound(a2, l.name, l.inst, tone(ch, k) + t), s + h.step, l.gain / Math.sqrt(v), { pan: pan * (k - 1) });
            }
          }
        }
      },

      lead(a2: Arranger, c: BarCtx): void {
        const { level, s, idx, bar } = c;
        const rel = sectionBar(bar);
        const phrase = Math.floor(rel / 4) % 2 === 0 ? hookA : hookB;
        const inPhrase = rel % 4;
        if (ON_DROP(level)) {
          playHook(phrase, inPhrase, s, 1, 0);
          if (spec.lead.double !== undefined) playHook(phrase, inPhrase, s, 0.4, spec.lead.double);
        } else if (level === 'break' && rel >= 4) playHook(phrase, inPhrase, s, 0.75, 0);
        else if (level === 'groove' && spec.lead.teaser && rel >= 4) playHook(phrase, inPhrase, s, 0.6, 0);
        else if (level === 'build' && idx === 3 && spec.lead.pickup) {
          const n: MelNote = { step: 12, len: 4, midi: note(spec.lead.pickup) };
          a2.hit('lead', leadSound(n, 0, null, 0), s + 12, 0.85, { dur: spec.lead.voice.kind === 'inst' ? undefined : 4, swing: false });
        }
      },
    };

    arrangeStandard(a, parts);

    // lead filter: closed for the teasers, opening through the break, open in the drops
    a.set('lead.cut', 0, 20000);
    a.ramp('lead.cut', BAR.groove + 4, 900, BAR.build1, 2600, 'exp');
    a.set('lead.cut', BAR.drop1, 20000);
    a.ramp('lead.cut', BAR.breakdown + 4, 1400, BAR.build2, 6000, 'exp');
    a.set('lead.cut', BAR.drop2, 20000);
    // plucks: darker in the intro and breakdown, open in the drops
    a.set('pluck.cut', 0, 2200);
    a.ramp('pluck.cut', BAR.groove, 2200, BAR.drop1, 9000, 'exp');
    a.set('pluck.cut', BAR.drop1, 20000);
    a.ramp('pluck.cut', BAR.breakdown, 2500, BAR.drop2, 12000, 'exp');
    a.set('pluck.cut', BAR.drop2, 20000);
    a.ramp('pluck.cut', BAR.outro, 8000, BAR.outro + 4, 1200, 'exp');
    // the groove holds back so the drop is clearly bigger
    a.set('chords.gain', BAR.groove, 0.78);
    a.set('chords.gain', BAR.build1, 0.9);
    a.set('chords.gain', BAR.drop1, 1);
    // the breakdown sits back: pads and plucks a few dB down, back up through the second build
    a.set('chords.gain', BAR.breakdown, 0.62);
    a.ramp('chords.gain', BAR.build2, 0.62, BAR.drop2, 1);
    a.set('pluck.gain', 0, 1);
    a.set('pluck.gain', BAR.breakdown, 0.6);
    a.ramp('pluck.gain', BAR.build2, 0.6, BAR.drop2, 1);
    // a soft pump through the breakdown so the pads still breathe without a kick
    a.ghost(BAR.breakdown, BAR.build2, 0.25);
  }

  return {
    id: spec.id,
    title: spec.title,
    bpm: spec.bpm,
    key: spec.key,
    art: spec.art,
    seed: spec.seed,
    swing: spec.swing,
    mix: spec.mix,
    arrange,
  };
}

/** One note held for the whole bar. */
const HOLD_BAR: Hit[] = [{ step: 0, len: 16, sym: 'x' }];

/** Exposed for tests: the level of every bar, as arranged. */
export const levelOfBar = (bar: number): Level => levelAt(bar).level;
