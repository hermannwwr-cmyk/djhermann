/**
 * Glasshouse Hearts: 122 BPM, A minor. Future bass on a four-on-the-floor: syncopated supersaw
 * chord stabs with the bass locked to them, glassy FM bells and a bright, pitched-up vocal chop.
 */
import { baseMix, chord, defineSong } from './common';

export default defineSong({
  id: 'glasshouse-hearts',
  title: 'Glasshouse Hearts',
  bpm: 122,
  key: 'A minor',
  art: { hueA: 286, hueB: 178, seed: 12207 },
  seed: 1220,
  swing: 0.5,
  kit: {
    kick: { fEnd: 50, fMid: 125, fTop: 480, decay: 0.14, click: 0.35, drive: 1.8 },
    clap: { tone: 1400, tail: 0.075, bright: 0.6, body: 0.3, seed: 71 },
    hatDecay: 0.014,
    hatHp: 8000,
    openDecay: 0.07,
    snareTune: 1.1,
    toms: [260, 170],
    seed: 122,
  },
  progression: [
    chord('F1', 'F3 A3 C4 E4 G4', 'F4 A4 C5 E5'),
    chord('G1', 'G3 B3 D4 G4 A4', 'G4 B4 D5 G5'),
    chord('A1', 'A3 C4 E4 G4 B4', 'A4 C5 E5 G5'),
    chord('E1', 'G3 B3 D4 E4', 'E4 G4 B4 D5'),
  ],
  riserNote: 'E5',
  drums: {
    hats: 'o o O o | o o O o | o o O o | o o O x',
    hatsLight: '. . x . | . . x . | . . x . | . . x .',
    shaker: false,
    perc: '. . . . | . . . . | . . . . | . . s .',
    percGain: 0.45,
    clapGhosts: [14],
  },
  bass: {
    p: { sub: 1, mid: 0.5, shape: 'saw', midOct: 1, cutoff: 380, env: 2.2, envDecay: 0.06, q: 1.1, drive: 1.5, release: 0.03 },
    groove: 'x - - - | - - . . | x - - - | - - . .',
    drop: 'x - - x | - - x - | - - x - | x - - -',
  },
  chords: {
    saw: { detune: 0.013, seed: 81 },
    groove: 'x - - - | - - - - | . . . . | x - . .',
    drop: 'x - . x | - . x - | . . x - | x - . .',
    stabRelease: 0.07,
  },
  layers: [
    {
      name: 'glass',
      inst: { kind: 'bell', p: { ratio: 2, index: 2.2, indexDecay: 0.12, decay: 0.45, len: 1.2 } },
      kind: 'arp',
      pattern: '0 . . 2 | . . 1 . | 3 . . 2 | . . 1 .',
      dropPattern: '4 . 2 . | 3 . 2 . | 4 . 2 . | 5 . 3 .',
      levels: ['introB', 'groove', 'build', 'break', 'drop', 'drop2', 'outroA'],
      gain: 0.45,
      pan: 0.4,
    },
  ],
  lead: {
    voice: {
      kind: 'vox',
      p: { scoop: 3, refMidi: 74, track: 0.8, breath: 0.03, vib: 0.003, bright: 1.4, decay: 0.2 },
      syllables: ['y:ee', 'd:ah', 'n:eh>ee', 'y:ah', 'b:ee', 'w:ah>ee'],
    },
    hookA: 'E5 - . E5 | . G5 - . | A5 - . G5 | . E5 - . | D5 - . D5 | . G5 - . | B5 - . A5 | . G5 - . | C6 - . B5 | . A5 - . | E5 - . A5 | . B5 - . | G5 - - - | . . E5 - | D5 - . E5 | - - . .',
    hookB: 'E5 - . E5 | . G5 - . | A5 - . C6 | . A5 - . | B5 - . A5 | . G5 - . | D5 - . G5 | . A5 - . | B5 - . C6 | . B5 - . | A5 - . E5 | . G5 - . | E5 - - - | - - - - | . . . . | . . . .',
    pickup: 'E5',
    teaser: true,
  },
  cut: { intro: [500, 2000], groove: 2600, build: [1500, 13000], breakdown: [650, 3400], outro: 600 },
  mix: baseMix(
    { chords: { trim: 1, duck: 0.6 }, lead: { trim: 2 }, pluck: { trim: 2 } },
    { reverb: { decay: 0.7, damping: 0.35, preDelay: 0.02, returnDb: -5, duck: 0.5 }, delay: { beats: 0.5, feedback: 0.35, damp: 0.4, returnDb: -10, toReverb: 0.2 }, masterDb: -1.5 },
  ),
});
