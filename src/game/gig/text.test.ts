import { describe, expect, it } from 'vitest';
import type { DeckId } from '../../core/types';
import { HINT_MAX, STATUS_MAX, TEXT, TITLE_MAX } from './text';

const decks: DeckId[] = ['A', 'B'];
const other = (d: DeckId): DeckId => (d === 'A' ? 'B' : 'A');
/** widest numbers the hints can show */
const bpms = [99.5, 128, 187.4, 199.9];

function hints(): string[] {
  const out: string[] = [];
  for (const d of decks) {
    const o = other(d);
    out.push(
      TEXT.startSet.hint(d),
      TEXT.startDeck.ready(d),
      TEXT.startDeck.now(d),
      TEXT.startDeck.plain(d),
      TEXT.beatmatch.sync(d, o),
      TEXT.beatmatch.syncHold,
      TEXT.beatmatch.orSync(d),
      TEXT.beatmatch.behind(d),
      TEXT.beatmatch.ahead(d),
      TEXT.beatmatch.hold,
      TEXT.beatmatch.startFirst(d),
      TEXT.crossfade.faderFirst(d),
      TEXT.crossfade.slide(d),
      TEXT.crossfade.bonusTip(o),
      TEXT.crossfade.keepGoing(d),
      TEXT.crossfade.cut(d),
      TEXT.stopDeck.hint(d),
      TEXT.bassDrop.cut(d),
      TEXT.bassDrop.wait,
      TEXT.bassDrop.now(d),
      TEXT.bassDrop.back(d),
      TEXT.filterSweep.out(d),
      TEXT.filterSweep.back(d),
      TEXT.scratch.letGo(d),
      TEXT.echoOut.hold(d),
      TEXT.echoOut.stop(d),
      TEXT.recover.play(d),
      TEXT.recover.fader(d),
      TEXT.recover.crossfader(d),
      TEXT.recover.letGo(d),
      TEXT.recover.eq(d),
    );
    for (let k = 1; k <= 4; k++) out.push(TEXT.startDeck.count(d, k), TEXT.bassDrop.count(d, k));
    for (let n = 1; n <= 9; n++) out.push(TEXT.scratch.hint(d, n));
    for (const a of bpms) for (const b of bpms) out.push(TEXT.beatmatch.faster(d, a, b), TEXT.beatmatch.slower(d, a, b));
  }
  return out;
}

function titles(): string[] {
  const out: string[] = [TEXT.startSet.title, TEXT.beatmatch.manualTitle, TEXT.beatmatch.resultTitle];
  out.push(TEXT.bassDrop.title, TEXT.filterSweep.title, TEXT.scratch.title, TEXT.echoOut.title, TEXT.recover.title);
  for (const d of decks) {
    out.push(TEXT.startDeck.title(d), TEXT.beatmatch.syncTitle(d), TEXT.crossfade.title(d), TEXT.crossfade.cutTitle(d));
    out.push(TEXT.stopDeck.title(d));
  }
  return out;
}

function statuses(): string[] {
  const out: string[] = [TEXT.status.loading, TEXT.status.loadingNext, TEXT.status.trainwreck, TEXT.status.leaving];
  out.push(TEXT.status.complete, TEXT.status.crowdLeft, TEXT.status.lessonDone, TEXT.status.freeIdle);
  out.push(TEXT.status.freeEmpty, TEXT.status.inTheMix);
  for (let n = 1; n <= 16; n++) out.push(TEXT.status.mixIn(n), TEXT.status.lastBars(n), TEXT.status.fadeIn(n));
  for (let n = 0; n <= 99; n++) out.push(TEXT.status.pads(n, 99));
  for (const d of decks) {
    out.push(TEXT.status.fading(d));
    const advice = [TEXT.advice.play(d), TEXT.advice.fader(d), TEXT.advice.crossfader(d), TEXT.advice.letGo(d), TEXT.advice.eq(d)];
    for (const a of advice) out.push(TEXT.status.deadAir(a));
  }
  return out;
}

describe('on-screen text fits the HUD', () => {
  it(`every mission hint is at most ${HINT_MAX} characters`, () => {
    const all = hints();
    expect(all.length).toBeGreaterThan(100);
    const long = all.filter((h) => [...h].length > HINT_MAX);
    expect(long).toEqual([]);
    for (const h of all) expect(h.trim().length).toBeGreaterThan(0);
  });

  it(`every mission title is at most ${TITLE_MAX} characters, upper case`, () => {
    for (const t of titles()) {
      expect([...t].length, t).toBeLessThanOrEqual(TITLE_MAX);
      expect(t).toBe(t.toUpperCase());
    }
  });

  it(`every status line (track titles aside) is at most ${STATUS_MAX} characters`, () => {
    const long = statuses().filter((s) => [...s].length > STATUS_MAX);
    expect(long).toEqual([]);
  });

  it('controls are named as printed on the hardware', () => {
    const all = hints().join(' ');
    for (const word of ['PLAY', 'SYNC', 'TEMPO', 'PITCH BEND', 'LOW', 'FILTER', 'ECHO', 'CROSSFADER']) {
      expect(all).toContain(word);
    }
    // the TEMPO fader is realistic: down makes the deck faster
    expect(TEXT.beatmatch.faster('B', 120, 122)).toContain('down');
    expect(TEXT.beatmatch.slower('B', 124, 122)).toContain('up');
  });
});
