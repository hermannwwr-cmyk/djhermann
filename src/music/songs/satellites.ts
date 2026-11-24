/**
 * Paper Satellites: 120 BPM, D minor. Nostalgic and bittersweet: a clean picked-guitar arpeggio,
 * an off-beat house bass, wide pads and a choppy "ah / eh" vocal hook.
 */
import { baseMix, chord, defineSong } from './common';

export default defineSong({
  id: 'paper-satellites',
  title: 'Paper Satellites',
  bpm: 120,
  key: 'D minor',
  art: { hueA: 205, hueB: 268, seed: 12011 },
  seed: 1200,
  swing: 0.52,
  kit: {
    kick: { fEnd: 51, fMid: 120, fTop: 420, decay: 0.15, click: 0.3, drive: 1.6 },
    clap: { tone: 1250, tail: 0.06, bright: 0.45, body: 0.25, seed: 41 },
    hatDecay: 0.016,
    hatHp: 7200,
    openDecay: 0.09,
    snareTune: 1,
    toms: [240, 160],
    seed: 120,
  },
  progression: [
    chord('D2', 'D3 A3 D4 F4 A4', 'D4 F4 A4 D5'),
    chord('G1', 'G3 A#3 D4 F4', 'D4 G4 A#4 D5'),
    chord('A#1', 'F3 A#3 D4 F4', 'D4 F4 A#4 D5'),
    chord('A1', 'E3 A3 C#4 E4', 'C#4 E4 A4 C#5'),
  ],
  riserNote: 'A4',
  drums: {
    hats: 'x . O o | x . O . | x . O o | x . O .',
    hatsLight: '. . x . | . . x . | . . x . | . . x o',
    shaker: false,
    perc: '. . . . | . . . . | . . . s | . . . .',
    percGain: 0.4,
    clapGhosts: [7],
  },
  bass: {
    p: { sub: 1, mid: 0.45, shape: 'saw', midOct: 1, cutoff: 420, env: 1.8, envDecay: 0.07, q: 1, drive: 1.4, release: 0.03 },
    groove: '. . x - | . . x - | . . x - | . . x -',
    drop: 'x - x - | . . x - | . . x - | . o x -',
  },
  chords: { saw: { detune: 0.011, seed: 61 }, groove: 'x - - - | - - - - | - - - - | - - - -', drop: 'x - - - | - - - - | - - - - | - - - -' },
  layers: [
    {
      name: 'guitar',
      inst: { kind: 'string', p: { pos: 0.18, bright: 1.15, t1: 1.3, damp: 0.12, len: 1.4, pick: 0.6 } },
      kind: 'arp',
      pattern: '0 . 1 2 | . 1 3 . | 0 . 1 2 | . 3 2 1',
      levels: ['introB', 'groove', 'build', 'drop', 'break', 'drop2', 'outroA'],
      gain: 0.75,
      pan: 0.3,
    },
  ],
  lead: {
    voice: {
      kind: 'vox',
      p: { scoop: 2, refMidi: 72, track: 0.5, breath: 0.04, vib: 0.004, bright: 1.15, decay: 0.32 },
      syllables: ['d:ah', 'y:eh', 'n:ah>ee', 'b:oh', 'd:eh', 'h:ah'],
    },
    hookA: 'A4 - . A4 | . F5 - . | E5 - . D5 | - . A4 - | . . A#4 - | . D5 - . | C5 - . A#4 | - . A4 - | . . F4 - | . A#4 - . | D5 - . F5 | - - E5 - | C#5 - - - | - - - . | E5 - . C#5 | - . A4 -',
    hookB: 'D5 - . D5 | . F5 - . | A5 - . G5 | - . F5 - | . . D5 - | . G5 - . | F5 - . D5 | - . A#4 - | . . D5 - | . F5 - . | E5 - . D5 | - . C#5 - | E5 - - - | - - - - | . . . . | . . . .',
    pickup: 'A4',
    teaser: true,
  },
  cut: { intro: [450, 1500], groove: 2200, build: [1400, 12000], breakdown: [700, 3600], outro: 600 },
  mix: baseMix(
    { pluck: { trim: 1, reverb: 0.24, delay: 0.3 }, lead: { trim: 1 }, chords: { trim: 0 } },
    { reverb: { decay: 0.74, damping: 0.4, preDelay: 0.02, returnDb: -5, duck: 0.45 }, delay: { beats: 0.75, feedback: 0.4, damp: 0.42, returnDb: -9, toReverb: 0.2 }, masterDb: -1.6 },
  ),
});
