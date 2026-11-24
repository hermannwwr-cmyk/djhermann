/**
 * Northbound Signal: 126 BPM, E minor. Driving and a little dark: a gliding detuned saw lead,
 * a galloping off-beat bass, square-wave sixteenth arps and 3-3-2 pumping chords.
 */
import { baseMix, chord, defineSong } from './common';

export default defineSong({
  id: 'northbound-signal',
  title: 'Northbound Signal',
  bpm: 126,
  key: 'E minor',
  art: { hueA: 158, hueB: 228, seed: 12619 },
  seed: 1260,
  swing: 0.5,
  kit: {
    kick: { fEnd: 48, fMid: 118, fTop: 450, decay: 0.17, click: 0.32, drive: 1.9 },
    clap: { tone: 1050, tail: 0.08, bright: 0.4, body: 0.4, seed: 111 },
    hatDecay: 0.013,
    hatHp: 8200,
    openDecay: 0.075,
    snareTune: 0.9,
    toms: [200, 135],
    seed: 126,
  },
  progression: [
    chord('E2', 'E3 G3 B3 E4', 'E4 G4 B4 E5'),
    chord('C2', 'E3 G3 C4 E4', 'C4 E4 G4 C5'),
    chord('A1', 'E3 A3 C4 E4', 'A3 C4 E4 A4'),
    chord('B1', 'F#3 B3 D#4 F#4', 'B3 D#4 F#4 B4'),
  ],
  riserNote: 'B4',
  drums: {
    hats: 'o x O x | o x O x | o x O x | o x O x',
    hatsLight: '. . x . | . . x . | . . x . | . . x .',
    shaker: false,
    perc: '. . . . | . . . . | . . l . | . . . .',
    percGain: 0.35,
    clapGhosts: [10],
  },
  bass: {
    p: { sub: 1, mid: 0.55, shape: 'saw', midOct: 1, cutoff: 340, env: 2.6, envDecay: 0.045, q: 1.3, drive: 1.7, release: 0.02 },
    groove: '. . x - | . . x - | . . x - | . . x -',
    drop: '. . x x | . . x x | . . x x | . . o x',
  },
  chords: {
    saw: { detune: 0.012, seed: 121 },
    groove: 'x - - - | - - - - | - - - - | - - - -',
    drop: 'x - - x | - - x - | - - x - | - x - -',
    stabRelease: 0.09,
  },
  layers: [
    {
      name: 'sqarp',
      inst: { kind: 'pluck', p: { shape: 'square', cutoff: 900, env: 3000, envDecay: 0.04, q: 1.4, decay: 0.12, detune: 8, len: 0.35 } },
      kind: 'arp',
      pattern: '0 1 2 1 | 0 1 2 3 | 0 1 2 1 | 0 1 3 2',
      levels: ['introB', 'groove', 'build', 'break', 'drop', 'drop2', 'outroA'],
      gain: 0.5,
      transpose: 12,
      pan: 0.25,
    },
  ],
  lead: {
    voice: { kind: 'synth', p: { shape: 'saw', voices: 5, detune: 32, cutoff: 2600, env: 5000, envDecay: 0.18, q: 0.9, glide: 0.06, decay: 0 } },
    hookA: 'B4 - - - | E5 - - - | D5 - E5 - | G5 - - - | . . . . | E5 - - - | D5 - C5 - | B4 - - - | C5 - - - | E5 - - - | A5 - - - | G5 - E5 - | F#5 - - - | - - - - | D#5 - - - | B4 - - -',
    hookB: 'B4 - - - | E5 - - - | G5 - A5 - | B5 - - - | . . . . | G5 - - - | E5 - G5 - | C6 - - - | B5 - - - | A5 - - - | E5 - - - | G5 - F#5 - | D#5 - - - | - - - - | . . . . | . . . .',
    pickup: 'B4',
    teaser: true,
  },
  cut: { intro: [450, 1700], groove: 2400, build: [1400, 13000], breakdown: [600, 3200], outro: 550 },
  mix: baseMix(
    { lead: { gainDb: -12, delay: 0.18 }, chords: { gainDb: -18 }, pluck: { gainDb: -17 } },
    { reverb: { decay: 0.68, damping: 0.42, preDelay: 0.018, returnDb: -6, duck: 0.5 }, delay: { beats: 0.75, feedback: 0.36, damp: 0.45, returnDb: -10, toReverb: 0.2 }, masterDb: 0 },
  ),
});
