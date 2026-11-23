/** Score display helpers: thousands grouping and the smooth count-up. */

/** 48250 → "48,250". Locale independent, so every device shows the same thing. */
export function formatScore(value: number): string {
  let n = Math.max(0, Math.round(value));
  if (n < 1000) return String(n);
  let out = '';
  while (n >= 1000) {
    const rem = n % 1000;
    out = `,${rem < 10 ? '00' : rem < 100 ? '0' : ''}${rem}${out}`;
    n = Math.floor(n / 1000);
  }
  return `${n}${out}`;
}

/**
 * One step of the count-up: the shown number closes half of the remaining gap every `halfLifeSec`,
 * never overshoots and lands exactly on the target. A lower target (a new gig) is taken at once.
 */
export function stepCount(shown: number, target: number, dt: number, halfLifeSec = 0.12): number {
  if (target <= shown) return target;
  const next = target + (shown - target) * Math.pow(0.5, dt / halfLifeSec);
  return target - next < 1 ? target : next;
}
