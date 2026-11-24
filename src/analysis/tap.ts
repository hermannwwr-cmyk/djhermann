/**
 * Tap tempo: the BPM of a run of taps, for the player's manual beat-grid fix.
 */

/** Fewest taps that give a tempo. */
export const TAP_MIN_TAPS = 4;
/** Only the most recent taps count, so the tempo follows the player when they change their mind. */
export const TAP_WINDOW = 16;
/** A pause longer than this starts a new run of taps. */
export const TAP_RESET_MS = 2000;
/** The tempo is folded by octaves into this range (the range the beat-grid detector covers). */
export const TAP_MIN_BPM = 70;
export const TAP_MAX_BPM = 180;

/**
 * BPM from a run of tap times (ms, ascending, e.g. event.timeStamp values), or null until there
 * are enough taps. Only the latest run counts (a pause over two seconds starts a new one) and only
 * its last 16 taps. A doubled or missed tap is tolerated: the tempo is a least-squares fit of tap
 * time against beat number, where every interval counts as the whole number of beats nearest to
 * the median interval. The result is folded into 70-180 BPM and rounded to 0.01.
 */
export function tapTempo(tapTimesMs: number[]): number | null {
  const times = tapTimesMs.filter((t) => Number.isFinite(t));
  if (times.length < TAP_MIN_TAPS) return null;
  // the latest run of taps
  let start = times.length - 1;
  while (start > 0 && times.length - start < TAP_WINDOW) {
    const gap = times[start] - times[start - 1];
    if (!(gap > 0) || gap > TAP_RESET_MS) break;
    start--;
  }
  const run = times.slice(start);
  if (run.length < TAP_MIN_TAPS) return null;

  const intervals = run.slice(1).map((t, i) => t - run[i]);
  const sorted = [...intervals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (!(median > 0)) return null;

  // beat number of every tap: an interval twice the median is a missed tap, a tiny one a double tap
  const beats: number[] = [0];
  const kept: number[] = [run[0]];
  let beat = 0;
  for (let i = 0; i < intervals.length; i++) {
    const steps = Math.round(intervals[i] / median);
    if (steps < 1) continue; // a double tap: ignore it
    beat += steps;
    beats.push(beat);
    kept.push(run[i + 1]);
  }
  if (kept.length < TAP_MIN_TAPS) return null;

  // least-squares slope of time against beat number
  const n = kept.length;
  let mb = 0;
  let mt = 0;
  for (let i = 0; i < n; i++) {
    mb += beats[i];
    mt += kept[i];
  }
  mb /= n;
  mt /= n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (beats[i] - mb) * (kept[i] - mt);
    den += (beats[i] - mb) ** 2;
  }
  if (!(den > 0) || !(num > 0)) return null;
  let bpm = 60000 / (num / den);
  while (bpm < TAP_MIN_BPM) bpm *= 2;
  while (bpm > TAP_MAX_BPM) bpm /= 2;
  return Math.round(bpm * 100) / 100;
}
