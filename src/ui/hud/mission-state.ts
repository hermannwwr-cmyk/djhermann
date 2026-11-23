/** The logic of the mission line, free of DOM so it can be tested. */
import type { MissionRating } from '../../core/types';

/** how long a mission result stays on the line when nothing is waiting behind it */
export const RESULT_MS = 1500;
/** … and when the next instruction is already there: shorter, the player needs to read it */
export const RESULT_MIN_MS = 900;

export type LineMode = 'mission' | 'status' | 'result' | 'empty';

/** Decides what the line shows: a fresh result wins for a moment, then the mission, else the status. */
export class MissionLineState {
  private resultAt = -1;

  showResult(nowMs: number): void {
    this.resultAt = nowMs;
  }

  resolve(nowMs: number, hasMission: boolean, hasStatus: boolean): LineMode {
    if (this.resultAt >= 0) {
      const age = nowMs - this.resultAt;
      if (age >= 0 && age < (hasMission ? RESULT_MIN_MS : RESULT_MS)) return 'result';
      this.resultAt = -1;
    }
    return hasMission ? 'mission' : hasStatus ? 'status' : 'empty';
  }
}

export const RATING_WORD: Record<MissionRating, string> = {
  perfect: 'PERFECT',
  great: 'GREAT',
  ok: 'OK',
  fail: 'MISSED',
};

export type TimeUrgency = 'none' | 'calm' | 'soon' | 'now';

/** How the draining time bar looks. A bar that never started draining (no time limit) is not shown. */
export function timeUrgency(timeLeft: number): TimeUrgency {
  if (timeLeft >= 0.9995) return 'none';
  if (timeLeft > 0.5) return 'calm';
  if (timeLeft > 0.25) return 'soon';
  return 'now';
}

export interface TextPart {
  text: string;
  kind: 'plain' | 'deckA' | 'deckB' | 'key';
}

const DECK_ONLY = /\b[Dd][Ee][Cc][Kk]\s+([AB])\b/g;
const DECK_OR_CAPS = /\b[Dd][Ee][Cc][Kk]\s+([AB])\b|\b[A-Z][A-Z0-9]+\b/g;

/**
 * Split an instruction for display: "deck A" / "deck B" get their deck colour (A cyan, B pink,
 * everywhere), and with `emphasiseCaps` words written in capitals (PLAY, CUE, LOW: the legends
 * printed on the hardware) are marked as keys.
 */
export function splitInstruction(text: string, emphasiseCaps: boolean): TextPart[] {
  const parts: TextPart[] = [];
  const re = emphasiseCaps ? DECK_OR_CAPS : DECK_ONLY;
  re.lastIndex = 0;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > at) parts.push({ text: text.slice(at, m.index), kind: 'plain' });
    parts.push({ text: m[0], kind: m[1] === 'A' ? 'deckA' : m[1] === 'B' ? 'deckB' : 'key' });
    at = m.index + m[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), kind: 'plain' });
  return parts;
}
