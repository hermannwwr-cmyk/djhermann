/**
 * Golden Static: 124 BPM, C major. The uplifting one: a bright FM-bell hook over an off-beat saw
 * pluck, a rolling sixteenth bass and big open pads. Hands in the air.
 */
import { baseMix, chord, defineSong } from './common';

export default defineSong({
  id: 'golden-static',
  title: 'Golden Static',
  bpm: 124,
  key: 'C major',
  art: { hueA: 44, hueB: 14, seed: 12403 },
  seed: 1240,
  swing: 0.5,
  kit: {
    kick: { fEnd: 52, fMid: 115, fTop: 400, decay: 0.15, click: 0.28, drive: 1.6 },
    clap: { tone: 1200, tail: 0.065, bright: 0.5, body: 0.2, seed: 91 },
    hatDecay: 0.017,
    hatHp: 7500,
    openDecay: 0.1,
    snareTune: 1.05,
    toms: [250, 165],
    seed: 124,
  },
  progression: [
    chord('F2', 'A3 C4 F4 A4', 'F4 A4 C5 F5'),
    chord('E2', 'G3 C4 E4 G4', 'E4 G4 C5 E5'),
    chord('D2', 'A3 C4 D4 F4', 'D4 F4 A4 C5'),
    chord('G2', 'G3 B3 D4 G4', 'D4 G4 B4 D5'),
  ],
  riserNote: 'G4',
  drums: {
    hats: 'x o O o | x o O o | x o O o | x o O o',
    hatsLight: '. . x . | . . x . | . . x . | . . x .',
    shaker: true,
    clapGhosts: [],
  },
  bass: {
    p: { sub: 0.9, mid: 0.55, shape: 'saw', midOct: 0, cutoff: 600, env: 1.6, envDecay: 0.05, q: 1.1, drive: 1.4, release: 0.02 },
    groove: '. . x . | . . x . | . . x . | . . x .',
    drop: '. x x x | . x x x | . x x x | . x x o',
    gain: 0.95,
  },
  chords: { saw: { detune: 0.012, seed: 101 }, groove: 'x - - - | - - - - | - - - - | - - - -', drop: 'x - - - | - - - - | - - - - | - - - -' },
  layers: [
    {
      name: 'sawpluck',
      inst: { kind: 'pluck', p: { shape: 'saw', cutoff: 700, env: 4200, envDecay: 0.06, q: 1.2, decay: 0.22, detune: 14, len: 0.6 } },
      kind: 'block',
      pattern: '. . x . | . . x . | . . x . | . . x .',
      levels: ['groove', 'build', 'drop', 'drop2', 'outroA'],
      gain: 0.8,
      voices: 3,
      pan: 0.3,
    },
    {
      name: 'piano',
      inst: { kind: 'keys', p: { bright: 1, t1: 1.4, len: 2 } },
      kind: 'block',
      pattern: 'x - - - | - - x - | - - - - | x - - -',
      levels: ['break'],
      gain: 0.75,
      voices: 4,
      pan: 0.2,
    },
  ],
  lead: {
    voice: { kind: 'inst', inst: { kind: 'bell', p: { ratio: 3.5, index: 2.6, indexDecay: 0.09, decay: 0.55, len: 1.4 } } },
    hookA: 'C5 - . A4 | - . C5 - | . A4 - . | G4 - F4 - | G4 - . E4 | - . G4 - | . C5 - . | B4 - G4 - | A4 - . F4 | - . A4 - | . D5 - . | C5 - A4 - | B4 - . G4 | - . D4 - | . G4 - . | A4 - B4 -',
    hookB: 'C5 - . A4 | - . C5 - | . A4 - . | C5 - D5 - | E5 - . C5 | - . G4 - | . E4 - . | G4 - C5 - | D5 - . C5 | - . A4 - | . F4 - . | A4 - B4 - | C5 - - - | - - - - | . . . . | . . . .',
    pickup: 'G4',
    double: 12,
    teaser: true,
  },
  cut: { intro: [550, 2200], groove: 3000, build: [1800, 14000], breakdown: [800, 4200], outro: 700 },
  mix: baseMix(
    { lead: { trim: -8.5, delay: 0.26, reverb: 0.22 }, pluck: { trim: 2, delay: 0.18 }, chords: { trim: -1 }, bass: { trim: -0.5 } },
    { reverb: { decay: 0.72, damping: 0.38, preDelay: 0.02, returnDb: -5, duck: 0.45 }, delay: { beats: 0.75, feedback: 0.4, damp: 0.4, returnDb: -9, toReverb: 0.2 }, masterDb: -1.9 },
  ),
});
