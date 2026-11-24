import { describe, expect, it } from 'vitest';
import { bassSym, chord, parseMelody, parseRhythm, sectionBar, syllable, tokens, tone } from './songs/common';
import { autoValue, note } from './score';
import type { AutoPoint } from './score';
import { swungStep } from './timeline';

describe('pattern parsing', () => {
  it('reads a melody: notes, holds and rests', () => {
    const m = parseMelody('C5 - - A4 | . . G4 - | . . . .');
    expect(m).toEqual([
      { step: 0, len: 3, midi: 72 },
      { step: 3, len: 1, midi: 69 },
      { step: 6, len: 2, midi: 67 },
    ]);
  });

  it('reads a rhythm grid with symbols', () => {
    expect(parseRhythm('x - . o | 5 . . -')).toEqual([
      { step: 0, len: 2, sym: 'x' },
      { step: 3, len: 1, sym: 'o' },
      { step: 4, len: 1, sym: '5' },
    ]);
  });

  it('ignores bar separators when counting steps', () => {
    expect(tokens('a b | c d |')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('names notes the MIDI way', () => {
    expect(note('A4')).toBe(69);
    expect(note('C4')).toBe(60);
    expect(note('A#1')).toBe(34);
    expect(note('Bb1')).toBe(34);
    expect(() => note('H2')).toThrow();
  });

  it('climbs octaves past the end of the chord tones', () => {
    const c = chord('C2', 'C4 E4 G4', 'C4 E4 G4');
    expect([0, 1, 2, 3, 4].map((i) => tone(c, i))).toEqual([60, 64, 67, 72, 76]);
    expect(bassSym(c, 'x')).toBe(36);
    expect(bassSym(c, 'o')).toBe(48);
    expect(bassSym(c, '5')).toBe(43);
    expect(bassSym(c, '-')).toBeNull();
  });

  it('parses vocal syllables', () => {
    expect(syllable('y:eh>ee')).toEqual({ onset: 'y', vowel: 'eh', to: 'ee' });
    expect(syllable('ah')).toEqual({ onset: 'none', vowel: 'ah', to: undefined });
  });
});

describe('section maths', () => {
  it('counts bars from the start of each section (intro and outro are one section)', () => {
    expect([0, 7, 8, 15, 16, 19, 20, 35, 36, 43, 44, 47, 48, 55, 56, 63].map(sectionBar)).toEqual([
      0, 7, 0, 7, 0, 3, 0, 15, 0, 7, 0, 3, 0, 7, 0, 7,
    ]);
  });

  it('interpolates automation and lets a jump follow a ramp on the same beat', () => {
    const pts: AutoPoint[] = [
      { beat: 0, value: 100, curve: 'step' },
      { beat: 8, value: 1600, curve: 'exp' },
      { beat: 8, value: 20000, curve: 'step' },
    ];
    expect(autoValue(pts, -4)).toBe(100);
    expect(autoValue(pts, 4)).toBeCloseTo(400, 6);
    expect(autoValue(pts, 9)).toBe(20000);
  });

  it('swings only the off sixteenths, so beats stay on the grid', () => {
    expect(swungStep(0, 0.58)).toBe(0);
    expect(swungStep(1, 0.58)).toBeCloseTo(1.16, 9);
    expect(swungStep(2, 0.58)).toBe(2);
    expect(swungStep(4, 0.58)).toBe(4);
  });
});
