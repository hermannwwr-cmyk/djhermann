import { describe, expect, it } from 'vitest';
import { buildCatalog } from './catalog';
import { Arranger } from './score';
import { scoreOf } from './render';
import { SONGS } from './songs';
import { tokens } from './songs/common';
import { BAR, FIRST_BEAT_SEC, TOTAL_BARS, beatToFrame, trackDurationSec } from './timeline';

const KEYS_OK = /^[A-G][#b]? (major|minor)$/;

describe('catalog', () => {
  const cat = buildCatalog();

  it('has six tracks at the agreed tempos, all mixable with their neighbours', () => {
    expect(cat.map((t) => t.grid.bpm)).toEqual([116, 120, 122, 124, 126, 128]);
    for (let i = 1; i < cat.length; i++) expect(cat[i].grid.bpm / cat[i - 1].grid.bpm).toBeLessThan(1.08);
  });

  it('describes every track exactly', () => {
    const ids = new Set<string>();
    for (const t of cat) {
      expect(t.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(ids.has(t.id)).toBe(false);
      ids.add(t.id);
      expect(t.artist).toBe('DJ Hermann Originals');
      expect(t.source).toBe('builtin');
      expect(t.grid.firstBeatSec).toBe(0.1);
      expect(t.key).toMatch(KEYS_OK);
      expect(t.durationSec).toBeCloseTo(FIRST_BEAT_SEC + (64 * 4 * 60) / t.grid.bpm + 1.8, 9);
      expect(t.art.hueA).toBeGreaterThanOrEqual(0);
      expect(t.art.hueB).toBeLessThanOrEqual(360);
      const kinds = t.sections.map((s) => `${s.kind}${s.bars}`);
      expect(kinds).toEqual(['intro8', 'groove8', 'build4', 'drop16', 'break8', 'build4', 'drop8', 'outro8']);
      let bar = 0;
      for (const s of t.sections) {
        expect(s.startBar).toBe(bar);
        bar += s.bars;
      }
      expect(bar).toBe(64);
      expect(t.sections.filter((s) => s.kind === 'drop').every((s) => s.energy === 1)).toBe(true);
      expect(t.sections.find((s) => s.kind === 'break')!.energy).toBeCloseTo(0.3);
    }
  });

  it('keys are related (each a neighbour of another on the circle of fifths)', () => {
    expect(cat.map((t) => t.key)).toEqual(['F major', 'D minor', 'A minor', 'C major', 'E minor', 'G major']);
  });

  it('a track is 64 bars plus a tail shorter than a bar', () => {
    for (const t of cat) {
      const tail = t.durationSec - (FIRST_BEAT_SEC + (TOTAL_BARS * 240) / t.grid.bpm);
      expect(tail).toBeGreaterThan(1.5);
      expect(tail).toBeLessThan(240 / t.grid.bpm);
      expect(trackDurationSec(t.grid.bpm)).toBe(t.durationSec);
    }
  });
});

describe('timing', () => {
  it('places beats on the same musical time at 44.1 and 48 kHz', () => {
    for (const bpm of [116, 128]) {
      for (const beat of [0, 1, 64, 255]) {
        const a = beatToFrame(bpm, 44100, beat) / 44100;
        const b = beatToFrame(bpm, 48000, beat) / 48000;
        const exact = 0.1 + (beat * 60) / bpm;
        expect(Math.abs(a - exact)).toBeLessThanOrEqual(0.5 / 44100);
        expect(Math.abs(b - exact)).toBeLessThanOrEqual(0.5 / 48000);
      }
    }
  });
});

describe('scores', () => {
  for (const song of SONGS) {
    describe(song.id, () => {
      const score = scoreOf(song);
      const at = (stem: string, b0: number, b1: number) => score.events.filter((e) => e.stem === stem && e.beat >= b0 * 4 && e.beat < b1 * 4);

      it('has a kick on every beat of the intro, groove, drops and outro, from beat 0', () => {
        const kicks = new Set(score.events.filter((e) => e.stem === 'kick').map((e) => e.beat));
        for (const [a, b] of [
          [0, 19],
          [BAR.drop1, BAR.breakdown],
          [BAR.drop2, 64],
        ]) {
          for (let beat = a * 4; beat < b * 4 - (b === 19 ? 4 : 0); beat++) expect(kicks.has(beat), `beat ${beat}`).toBe(true);
        }
        expect(Math.min(...kicks)).toBe(0);
      });

      it('drops the drums in the break', () => {
        expect(at('kick', BAR.breakdown, BAR.build2)).toHaveLength(0);
        expect(at('tops', BAR.breakdown, BAR.build2)).toHaveLength(0);
        // nothing from the drum bus but the fill that leads out of the break's last bar
        expect(at('drums', BAR.breakdown, BAR.build2 - 1)).toHaveLength(0);
      });

      it('keeps the intro sparse: drums, then pads; no bass or lead before the groove', () => {
        expect(at('bass', 0, BAR.groove)).toHaveLength(0);
        expect(at('lead', 0, BAR.groove)).toHaveLength(0);
        expect(at('chords', 0, 4)).toHaveLength(0);
      });

      it('has the lead hook in both drops and the bass throughout them', () => {
        expect(at('lead', BAR.drop1, BAR.breakdown).length).toBeGreaterThan(30);
        expect(at('lead', BAR.drop2, BAR.outro).length).toBeGreaterThan(15);
        for (let bar = BAR.drop1; bar < BAR.breakdown; bar++) expect(at('bass', bar, bar + 1).length, `bar ${bar}`).toBeGreaterThan(0);
      });

      it('keeps every event inside the track', () => {
        for (const e of score.events) {
          expect(e.beat).toBeGreaterThanOrEqual(0);
          expect(e.beat).toBeLessThanOrEqual(256);
          expect(Number.isFinite(e.gain) && e.gain > 0).toBe(true);
          expect(Math.abs(e.pan)).toBeLessThanOrEqual(1);
        }
      });

      it('is deterministic', () => {
        const a = new Arranger(song.bpm, song.seed, song.swing);
        song.arrange(a);
        const b = new Arranger(song.bpm, song.seed, song.swing);
        song.arrange(b);
        const sig = (x: Arranger) => x.finish().events.map((e) => `${e.sound.key}@${e.beat}:${e.gain.toFixed(6)}:${e.pan}`).join('|');
        expect(sig(a)).toBe(sig(b));
      });
    });
  }

  it('writes every pattern with the right number of steps', async () => {
    // hooks are 4 bars, every other grid one bar
    const src = await Promise.all(
      ['lanterns', 'satellites', 'glasshouse', 'golden', 'northbound', 'neon'].map(async (n) => (await import(`./songs/${n}.ts?raw`)).default as string),
    );
    let hooks = 0;
    let grids = 0;
    for (const file of src) {
      for (const m of file.matchAll(/(hookA|hookB): '([^']+)'/g)) {
        expect(tokens(m[2]), m[1]).toHaveLength(64);
        hooks++;
      }
      for (const m of file.matchAll(/(hats|hatsLight|perc|groove|drop|pattern|dropPattern): '([^']+)'/g)) {
        expect(tokens(m[2]), `${m[1]}: ${m[2]}`).toHaveLength(16);
        grids++;
      }
    }
    expect(hooks).toBe(12);
    expect(grids).toBeGreaterThan(50);
  });
});
