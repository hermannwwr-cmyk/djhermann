/**
 * Rough song structure from the loudness of the bars: intro / groove / build / drop / break /
 * outro, cut on four-bar boundaries. An estimate for the player's own music (built-in tracks
 * carry their exact sections); it only needs to be sane.
 */
import type { BeatEnergy, SectionKind, TrackSection } from '../core/types';
import { percentile } from './dsp';

/** Sections are made of blocks this many bars long. */
const BLOCK_BARS = 4;
/** Bar loudness relative to the loud parts: at or above this is a drop, below QUIET is quiet. */
const LOUD = 0.88;
const QUIET = 0.62;
/** A track whose quiet bars are this close to its loud bars has no structure worth labelling. */
const FLAT = 0.12;

type Level = 'quiet' | 'mid' | 'loud';

interface Run {
  start: number;
  bars: number;
  level: Level;
  kind: SectionKind;
}

const mean = (values: ArrayLike<number>, from: number, to: number): number => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += values[i];
  return to > from ? sum / (to - from) : 0;
};

export function estimateSections(energy: BeatEnergy): TrackSection[] {
  const bar = energy.bar;
  const bars = bar.length;
  if (bars === 0) return [];
  const top = Math.max(percentile(bar, 0.9), 1e-6);
  const section = (kind: SectionKind, startBar: number, count: number): TrackSection => ({
    kind,
    startBar,
    bars: count,
    energy: Math.min(1, Math.max(0.05, mean(bar, startBar, startBar + count) / top)),
  });
  const bottom = percentile(bar, 0.1);
  if (bars < 2 * BLOCK_BARS || (top - bottom) / top < FLAT) return [section('groove', 0, bars)];

  // Where do the four-bar blocks start? Usually on bar 0; a pickup of 1-3 bars shifts them.
  let offset = 0;
  let bestContrast = -1;
  for (let o = 0; o < BLOCK_BARS; o++) {
    let contrast = 0;
    for (let b = o === 0 ? BLOCK_BARS : o; b + BLOCK_BARS <= bars; b += BLOCK_BARS) {
      contrast += Math.abs(mean(bar, b, b + BLOCK_BARS) - mean(bar, Math.max(0, b - BLOCK_BARS), b));
    }
    if (contrast > bestContrast * (o === 0 ? 1 : 1.25)) {
      bestContrast = contrast;
      offset = o;
    }
  }

  // classify blocks and merge neighbours of the same level into runs
  const runs: Run[] = [];
  for (let start = offset === 0 ? 0 : offset - BLOCK_BARS; start < bars; start += BLOCK_BARS) {
    const from = Math.max(0, start);
    const to = Math.min(bars, start + BLOCK_BARS);
    const rel = mean(bar, from, to) / top;
    const level: Level = rel >= LOUD ? 'loud' : rel < QUIET ? 'quiet' : 'mid';
    const last = runs[runs.length - 1];
    const sliver = to - from < BLOCK_BARS;
    if (last && (last.level === level || (sliver && to === bars))) last.bars += to - from;
    else runs.push({ start: from, bars: to - from, level, kind: 'groove' });
  }
  // a pickup of fewer than four bars joins what follows
  if (runs.length > 1 && runs[0].bars < BLOCK_BARS) {
    runs[1].start = 0;
    runs[1].bars += runs[0].bars;
    runs.shift();
  }

  const hasLoud = runs.some((r) => r.level === 'loud');
  runs.forEach((run, i) => {
    const firstRun = i === 0;
    const lastRun = i === runs.length - 1;
    if (run.level === 'loud') run.kind = 'drop';
    else if (firstRun && !lastRun && (run.level === 'quiet' || (hasLoud && run.bars <= 16 && runs[1].level !== 'quiet')))
      run.kind = 'intro';
    else if (lastRun && !firstRun && (run.level === 'quiet' || (hasLoud && run.bars <= 16 && runs[i - 1].level === 'loud')))
      run.kind = 'outro';
    else run.kind = run.level === 'quiet' ? 'break' : 'groove';
  });

  // the bars that lead into a drop are a build when they rise, or when they follow a quiet part
  const out: TrackSection[] = [];
  runs.forEach((run, i) => {
    const next = runs[i + 1];
    if (next && next.kind === 'drop' && run.kind !== 'drop') {
      const end = run.start + run.bars;
      const rising = mean(bar, end - 2, end) > mean(bar, end - BLOCK_BARS, end - 2) + 0.03;
      const lead = run.bars >= 16 && mean(bar, end - 4, end) > mean(bar, end - 8, end - 4) + 0.03 ? 8 : BLOCK_BARS;
      const keep = run.bars - lead;
      if ((rising || run.level === 'quiet') && (keep >= BLOCK_BARS || (keep === 0 && i > 0))) {
        if (keep > 0) out.push(section(run.kind, run.start, keep));
        out.push(section('build', run.start + keep, lead));
        return;
      }
    }
    out.push(section(run.kind, run.start, run.bars));
  });
  return out;
}
