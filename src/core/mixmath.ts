import type { DeckId } from './types';
import { clamp, clamp01 } from './math';

/**
 * Crossfader law shared by the real engine, the mock engine and the game logic.
 * `x` is -1 (full A) .. +1 (full B). Each deck stays at full level until the centre,
 * then fades out with an equal-power tail, so both decks are at unity in the middle.
 */
export function crossfaderGain(deck: DeckId, x: number): number {
  const v = deck === 'A' ? x : -x; // v > 0: this deck is being faded out
  return v <= 0 ? 1 : Math.cos((clamp01(v) * Math.PI) / 2);
}

/** Channel fader taper: 0..1 position → linear gain. */
export const faderGain = (fader: number): number => {
  const f = clamp01(fader);
  return f * f;
};

/** Linear gain of a channel in the master from its fader and the crossfader (ignores EQ/filter). */
export const channelGain = (deck: DeckId, fader: number, crossfader: number): number =>
  faderGain(fader) * crossfaderGain(deck, crossfader);

/** EQ knob 0..1 → gain in dB. 0.5 = 0 dB, 1 = +6 dB, 0 = kill (KILL_DB or lower). */
export const EQ_KILL_DB = -60;
export function eqGainDb(value: number): number {
  const v = clamp01(value);
  if (v >= 0.5) return (v - 0.5) * 12;
  // below centre: 0 dB down to the kill, steeper near the bottom
  const t = (0.5 - v) / 0.5;
  return -Math.pow(t, 1.6) * -EQ_KILL_DB;
}

export const clampTempo = (tempo: number, min: number, max: number): number => clamp(tempo, min, max);
