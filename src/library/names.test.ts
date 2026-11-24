import { describe, expect, test } from 'vitest';
import { artFor, newTrackId, parseFileName, UNKNOWN_ARTIST } from './names';

describe('parseFileName', () => {
  test.each([
    ['Daft Punk - One More Time.mp3', 'Daft Punk', 'One More Time'],
    ['Bicep_-_Glue.flac', 'Bicep', 'Glue'],
    ['Fred_again.. – Delilah (pull me out of this).m4a', 'Fred again..', 'Delilah (pull me out of this)'],
    ['03 - Kerri Chandler - Rain.wav', 'Kerri Chandler', 'Rain'],
    ['01. Strings of Life.mp3', UNKNOWN_ARTIST, 'Strings of Life'],
    ['my_mix_final_v2.mp3', UNKNOWN_ARTIST, 'my mix final v2'],
    ['Artist - Title - Extended Mix.mp3', 'Artist', 'Title - Extended Mix'],
    ['C:\\Music\\Moby - Porcelain.mp3', 'Moby', 'Porcelain'],
    ['no-dash-here.ogg', UNKNOWN_ARTIST, 'no-dash-here'],
    ['808.wav', UNKNOWN_ARTIST, '808'],
    ['.mp3', UNKNOWN_ARTIST, 'Untitled track'],
  ])('%s', (name, artist, title) => {
    expect(parseFileName(name)).toEqual({ artist, title });
  });
});

describe('artFor', () => {
  test('stable per title, hues in range and apart', () => {
    const a = artFor('Glue');
    expect(artFor('Glue')).toEqual(a);
    expect(artFor('glue')).toEqual(a);
    for (const t of ['Glue', 'Rain', 'One More Time', 'x', '']) {
      const art = artFor(t);
      expect(art.hueA).toBeGreaterThanOrEqual(0);
      expect(art.hueA).toBeLessThan(360);
      expect(art.hueB).toBeGreaterThanOrEqual(0);
      expect(art.hueB).toBeLessThan(360);
      const d = Math.abs(art.hueA - art.hueB);
      expect(Math.min(d, 360 - d)).toBeGreaterThanOrEqual(90 - 30); // well apart on the wheel
    }
    expect(artFor('Rain')).not.toEqual(a);
  });

  test('ids are unique', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newTrackId(12345)));
    expect(ids.size).toBe(200);
  });
});
