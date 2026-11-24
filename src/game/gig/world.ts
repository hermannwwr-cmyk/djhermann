/** How the director reads the decks and mixer, and the few things it does to them by itself. */
import { AUDIBLE_MIN } from '../../core/frame';
import { crossfaderGain } from '../../core/mixmath';
import type {
  AudioEngine,
  ChannelSnapshot,
  DeckId,
  DeckSnapshot,
  Difficulty,
  MissionTarget,
  MixerSnapshot,
} from '../../core/types';
import { TEXT } from './text';
import { TUNING } from './tuning';

/** The world as seen this frame. One object, refreshed in place by the director every frame. */
export interface Sight {
  /** frame time (performance.now() of the frame) */
  now: number;
  /** seconds since the previous frame */
  dt: number;
  /** the gig's own beat clock: always runs, at the tempo of whatever is playing */
  clock: number;
  /** beats the clock moved this frame */
  dtBeats: number;
  decks: Record<DeckId, DeckSnapshot>;
  mixer: MixerSnapshot;
}

export interface MissionEnv {
  engine: AudioEngine;
  s: Sight;
  difficulty: Difficulty;
  tutorial: boolean;
}

export const eqSilent = (ch: ChannelSnapshot): boolean => {
  const t = TUNING.deadAir.eqSilent;
  return ch.eq.low <= t && ch.eq.mid <= t && ch.eq.high <= t;
};

/** 0..1 how loud a deck really is: nothing when the record stands still or every EQ band is killed. */
export function heard(d: DeckSnapshot, ch: ChannelSnapshot): number {
  if (!d.track || Math.abs(d.rate) < TUNING.deadAir.minRate || eqSilent(ch)) return 0;
  return d.audibility;
}

export const sounding = (s: Sight, deck: DeckId): boolean =>
  heard(s.decks[deck], s.mixer.channels[deck]) >= AUDIBLE_MIN;

/** The deck is playing normally: motor on, nobody holding the record. */
export const runs = (d: DeckSnapshot): boolean => !!d.track && d.playing && !d.scratching;

export const atEnd = (d: DeckSnapshot): boolean => !!d.track && d.positionSec >= d.durationSec - 0.05;

/** EQ flat, filter off, echo off, fader up. */
export function resetChannel(engine: AudioEngine, deck: DeckId): void {
  engine.setEq(deck, 'low', 0.5);
  engine.setEq(deck, 'mid', 0.5);
  engine.setEq(deck, 'high', 0.5);
  engine.setFilter(deck, 0);
  engine.setEcho(deck, false);
  engine.setFader(deck, 1);
}

/** The state every gig starts from: both channels reset, tempos at 0 %, crossfader fully on A. */
export function resetMixer(engine: AudioEngine): void {
  for (const deck of ['A', 'B'] as DeckId[]) {
    resetChannel(engine, deck);
    engine.setTempo(deck, 1);
    engine.setNudge(deck, 0);
  }
  engine.setCrossfader(-1);
}

export interface Advice {
  /** full sentence for a mission hint */
  hint: string;
  /** short form for the status line */
  short: string;
  target: MissionTarget;
  what: 'letGo' | 'play' | 'eq' | 'fader' | 'crossfader';
}

/** Why is `deck` not heard, and what is the one thing to do about it? null = it should be heard. */
export function adviseSilence(s: Sight, deck: DeckId): Advice | null {
  const d = s.decks[deck];
  const ch = s.mixer.channels[deck];
  if (!d.track) return null;
  if (d.scratching) {
    return {
      what: 'letGo',
      hint: TEXT.recover.letGo(deck),
      short: TEXT.advice.letGo(deck),
      target: { control: `${deck}.platter`, gesture: 'tap' },
    };
  }
  if (!d.playing) {
    return {
      what: 'play',
      hint: TEXT.recover.play(deck),
      short: TEXT.advice.play(deck),
      target: { control: `${deck}.play`, gesture: 'tap' },
    };
  }
  if (eqSilent(ch)) {
    return {
      what: 'eq',
      hint: TEXT.recover.eq(deck),
      short: TEXT.advice.eq(deck),
      target: { control: `${deck}.eq.low`, gesture: 'turn-right' },
    };
  }
  if (ch.fader * ch.fader < TUNING.deadAir.lowGain * TUNING.deadAir.lowGain) {
    return {
      what: 'fader',
      hint: TEXT.recover.fader(deck),
      short: TEXT.advice.fader(deck),
      target: { control: `${deck}.fader`, gesture: 'up' },
    };
  }
  if (crossfaderGain(deck, s.mixer.crossfader) < TUNING.deadAir.lowGain) {
    return {
      what: 'crossfader',
      hint: TEXT.recover.crossfader(deck),
      short: TEXT.advice.crossfader(deck),
      target: { control: 'xfader', gesture: deck === 'B' ? 'right' : 'left' },
    };
  }
  return null;
}
