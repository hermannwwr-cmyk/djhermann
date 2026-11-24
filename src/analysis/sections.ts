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
const LOUD = 0.95;
const QUIET = 0.62;
/** Blocks of the same level whose loudness differs by less than this (relative) are one run. */
const MERGE = 0.07;
/** A rise or fall in relative loudness smaller than this does not count. */
const RISE = 0.03;
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

  // classify blocks and merge neighbours of the same level and about the same loudness into runs
  const runs: Run[] = [];
  for (let start = offset === 0 ? 0 : offset - BLOCK_BARS; start < bars; start += BLOCK_BARS) {
    const from = Math.max(0, start);
    const to = Math.min(bars, start + BLOCK_BARS);
    const rel = mean(bar, from, to) / top;
    const level: Level = rel >= LOUD ? 'loud' : rel < QUIET ? 'quiet' : 'mid';
    const last = runs[runs.length - 1];
    const sliver = to - from < BLOCK_BARS;
    const similar =
      last && last.level === level && (level === 'loud' || Math.abs(rel - mean(bar, last.start, last.start + last.bars) / top) < MERGE);
    if (last && (similar || (sliver && to === bars))) last.bars += to - from;
    else runs.push({ start: from, bars: to - from, level, kind: 'groove' });
  }
  // a pickup of fewer than four bars joins what follows
  if (runs.length > 1 && runs[0].bars < BLOCK_BARS) {
    runs[1].start = 0;
    runs[1].bars += runs[0].bars;
    runs.shift();
  }

  const level = (r: Run): number => mean(bar, r.start, r.start + r.bars) / top;
  let lastDrop = -1;
  let firstDrop = -1;
  runs.forEach((run, i) => {
    if (run.level === 'loud') {
      lastDrop = i;
      if (firstDrop < 0) firstDrop = i;
    }
  });
  // the tail after the last drop is the outro when it only winds down (and is not too long)
  let outroFrom = runs.length;
  if (lastDrop >= 0) {
    let tail = 0;
    for (let i = lastDrop + 1; i < runs.length; i++) tail += runs[i].bars;
    if (tail > 0 && tail <= 24) outroFrom = lastDrop + 1;
  } else if (runs.length > 1 && level(runs[runs.length - 1]) < level(runs[runs.length - 2]) - RISE) {
    outroFrom = runs.length - 1;
  }
  runs.forEach((run, i) => {
    if (run.level === 'loud') run.kind = 'drop';
    else if (i >= outroFrom) run.kind = 'outro';
    else if (i === 0 && runs.length > 1 && (run.level === 'quiet' || level(run) < level(runs[1]) - RISE)) run.kind = 'intro';
    // a quiet stretch before the first drop that follows the intro is still the intro, not a break
    else if (run.level === 'quiet' && i < firstDrop && runs[i - 1]?.kind === 'intro') run.kind = 'intro';
    else run.kind = run.level === 'quiet' ? 'break' : 'groove';
  });
  // neighbours with the same label are one section
  for (let i = runs.length - 1; i > 0; i--) {
    if (runs[i].kind === runs[i - 1].kind && runs[i].kind !== 'groove') {
      runs[i - 1].bars += runs[i].bars;
      runs.splice(i, 1);
    }
  }

  // the bars that lead into a drop are a build when they rise, or when they follow a quiet part
  const out: TrackSection[] = [];
  runs.forEach((run, i) => {
    const next = runs[i + 1];
    if (next && next.kind === 'drop' && run.kind !== 'drop') {
      const end = run.start + run.bars;
      const prev = runs[i - 1];
      const rising =
        run.bars >= 2 * BLOCK_BARS
          ? mean(bar, end - BLOCK_BARS, end) > mean(bar, end - 2 * BLOCK_BARS, end - BLOCK_BARS) + RISE * top
          : !!prev && prev.kind !== 'drop' && level(run) > level(prev) + RISE;
      const lead = run.bars >= 16 && mean(bar, end - 4, end) > mean(bar, end - 8, end - 4) + RISE * top ? 8 : BLOCK_BARS;
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
