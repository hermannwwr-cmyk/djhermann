/**
 * Brighter Than Neon: 128 BPM, G major. The festival closer: the widest supersaws, an octave bass,
 * a sixteenth saw pluck and a sung "ah / ay" vocal-chop anthem doubled an octave down.
 */
import { baseMix, chord, defineSong } from './common';

export default defineSong({
  id: 'brighter-than-neon',
  title: 'Brighter Than Neon',
  bpm: 128,
  key: 'G major',
  art: { hueA: 318, hueB: 192, seed: 12823 },
  seed: 1280,
  swing: 0.5,
  kit: {
    kick: { fEnd: 52, fMid: 130, fTop: 500, decay: 0.15, click: 0.38, drive: 2 },
    clap: { tone: 1300, tail: 0.07, bright: 0.55, body: 0.3, seed: 131 },
    hatDecay: 0.015,
    hatHp: 7800,
    openDecay: 0.085,
    snareTune: 1.1,
    toms: [270, 180],
    seed: 128,
  },
  progression: [
    chord('C2', 'G3 C4 E4 G4', 'E4 G4 C5 E5'),
    chord('D2', 'A3 D4 F#4 A4', 'F#4 A4 D5 F#5'),
    chord('B1', 'F#3 B3 D4 F#4', 'D4 F#4 B4 D5'),
    chord('E2', 'G3 B3 E4 G4', 'E4 G4 B4 E5'),
    chord('C2', 'G3 C4 E4 G4', 'E4 G4 C5 E5'),
    chord('D2', 'A3 D4 F#4 A4', 'F#4 A4 D5 F#5'),
    chord('G1', 'G3 B3 D4 G4', 'D4 G4 B4 D5'),
    chord('G1', 'G3 C4 D4 G4', 'D4 G4 C5 D5'),
  ],
  riserNote: 'D5',
  drums: {
    hats: 'x o O o | x o O o | x o O o | x o O o',
    hatsLight: '. . x . | . . x . | . . x . | . . x .',
    shaker: true,
    perc: '. . . . | . . . . | . . . . | . . . s',
    percGain: 0.4,
    clapGhosts: [],
  },
  bass: {
    p: { sub: 1, mid: 0.5, shape: 'saw', midOct: 1, cutoff: 450, env: 2, envDecay: 0.06, q: 1, drive: 1.6, release: 0.02 },
    groove: 'x - - . | . . x - | . . x - | . . x -',
    drop: 'x - . o | . . x - | . o x - | . o x -',
  },
  chords: { saw: { detune: 0.014, seed: 141 }, groove: 'x - - - | - - - - | - - - - | - - - -', drop: 'x - - - | - - - - | - - - - | - - - -' },
  layers: [
    {
      name: 'saw16',
      inst: { kind: 'pluck', p: { shape: 'saw', cutoff: 800, env: 3800, envDecay: 0.05, q: 1.1, decay: 0.15, detune: 12, len: 0.4 } },
      kind: 'arp',
      pattern: '0 . 1 . | 2 . 1 . | 0 . 1 . | 3 . 2 .',
      dropPattern: '0 1 2 3 | 2 1 0 1 | 2 3 4 3 | 2 1 2 3',
      levels: ['groove', 'build', 'drop', 'drop2', 'outroA'],
      gain: 0.5,
      pan: 0.3,
    },
    {
      name: 'piano',
      inst: { kind: 'keys', p: { bright: 1, t1: 1.3, len: 2 } },
      kind: 'block',
      pattern: 'x - - - | - - - - | - - x - | - - - -',
      levels: ['break', 'introB'],
      gain: 0.75,
      voices: 4,
      pan: 0.2,
    },
  ],
  lead: {
    voice: {
      kind: 'vox',
      p: { scoop: 2.5, refMidi: 74, track: 0.55, breath: 0.035, vib: 0.006, bright: 1.2, decay: 0 },
      syllables: ['h:ah', 'y:ah>ee', 'n:oh', 'd:ah', 'w:ah>ee', 'h:eh'],
    },
    hookA: 'E5 - - . | E5 - D5 - | E5 - - . | G5 - - - | F#5 - - . | E5 - D5 - | . . A4 - | D5 - - - | D5 - - . | D5 - B4 - | D5 - - . | F#5 - - - | E5 - - - | - - - - | . . B4 - | D5 - E5 -',
    hookB: 'G5 - - . | G5 - E5 - | G5 - - . | A5 - - - | A5 - - . | F#5 - E5 - | . . D5 - | F#5 - - - | G5 - - - | - - - - | D5 - - - | B4 - - - | G4 - - - | - - - - | . . . . | . . . .',
    pickup: 'D5',
    double: -12,
    teaser: true,
  },
  cut: { intro: [500, 2000], groove: 2800, build: [1600, 14000], breakdown: [700, 3800], outro: 650 },
  mix: baseMix(
    { chords: { trim: 0 }, lead: { trim: 0 }, pluck: { trim: 3 } },
    { reverb: { decay: 0.75, damping: 0.38, preDelay: 0.02, returnDb: -5, duck: 0.5 }, delay: { beats: 0.75, feedback: 0.38, damp: 0.42, returnDb: -9, toReverb: 0.2 }, masterDb: -2.1 },
  ),
});
