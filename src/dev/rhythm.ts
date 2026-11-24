/**
 * Harness for the playfield. Open http://localhost:5184/dev/rhythm.html
 *
 *   ?h=150|250|430   slot height in px (default 430)
 *   ?auto=1          autoplay with human-like timing errors (some early, some late, a few misses)
 *   ?diff=chill|club|festival
 *   ?density=0..1    (default 1)
 *   ?beat=76         start deck A at this beat (76 = just before the first drop)
 *   ?miss=0.03       autoplay miss rate
 *   ?lowfx=1         low effects
 *   ?panel=0         hide the control panel
 *
 * window.__rh exposes the playfield; window.__rhPerf() returns update() timings.
 */
import { bootHarness } from './harness';
import { createSettings } from '../core/settings';
import type { Difficulty, Lane } from '../core/types';
import { createRhythmDev } from '../game/rhythm';
import { SHOWN, lowerBound } from '../game/rhythm/core';

const q = new URLSearchParams(location.search);
const height = Number(q.get('h') ?? 430);
const auto = q.get('auto') === '1';
const diff = (q.get('diff') ?? 'club') as Difficulty;
const density = q.has('density') ? Number(q.get('density')) : 1;
const startBeat = q.has('beat') ? Number(q.get('beat')) : 0;
const missRate = q.has('miss') ? Number(q.get('miss')) : 0.03;

const h = await bootHarness({ startBeat: startBeat || undefined });
const settings = createSettings(null);
settings.set({ difficulty: diff, lowFx: q.get('lowfx') === '1', haptics: false });

// a stand-in for the slots above the playfield, so the page reads like the game screen
const above = document.createElement('div');
above.style.cssText =
  'flex:none;height:60px;background:linear-gradient(180deg,#0d0d1a,#08080f);border-bottom:1px solid rgba(255,255,255,0.06)';
if (q.get('panel') !== '0') h.root.appendChild(above);

const dev = createRhythmDev({ engine: h.engine, bus: h.bus, settings });
const rhythm = dev.controller;
rhythm.setDensity(density);
const box = h.mount(rhythm.el, height);
box.style.transition = 'height 220ms cubic-bezier(0.16, 1, 0.3, 1)';
h.loop.add((f) => rhythm.update(f), 'logic');

// ── autoplay ──
const planned = new Set<string>();
const queue: { t: number; lane: Lane }[] = [];
const releases: { t: number; lane: Lane }[] = [];
let seed = 12345;
const rand = (): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const gauss = (): number => {
  const u = Math.max(1e-6, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
};
if (auto) {
  h.loop.add((f) => {
    const deck = dev.core.shown;
    const notes = deck ? dev.core.decks[deck] : null;
    const snap = deck ? f.decks[deck] : null;
    if (deck && notes && snap && snap.track && snap.rate > 0.2 && f.liveDeck === deck) {
      const beatsPerMs = (snap.track.grid.bpm * snap.rate) / 60000;
      for (let i = lowerBound(notes.beat, notes.count, snap.beat - 0.2); i < notes.count; i++) {
        const b = notes.beat[i];
        if (b > snap.beat + 0.6) break;
        if (notes.state[i] !== SHOWN) continue;
        const key = `${deck}:${notes.chart.difficulty}:${i}`;
        if (planned.has(key)) continue;
        planned.add(key);
        if (rand() < missRate) continue; // a miss now and then
        const err = rand() < 0.1 ? (rand() < 0.5 ? -1 : 1) * (60 + rand() * 50) : gauss() * 34;
        queue.push({ t: f.now + (b - snap.beat) / beatsPerMs + err, lane: notes.lane[i] as Lane });
      }
    }
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].t <= f.now + 8) {
        const { t, lane } = queue[i];
        queue.splice(i, 1);
        dev.press(lane, t);
        releases.push({ t: f.now + 70 + rand() * 50, lane });
      }
    }
    for (let i = releases.length - 1; i >= 0; i--) {
      if (releases[i].t <= f.now) {
        dev.release(releases[i].lane);
        releases.splice(i, 1);
      }
    }
  }, 'logic');
}

// ── frame timing ──
const times: number[] = [];
h.loop.add(() => {
  times.push(dev.lastUpdateMs);
  if (times.length > 600) times.shift();
});
const perf = (): { avg: number; p95: number; max: number; n: number } => {
  const s = [...times].sort((a, b) => a - b);
  const avg = s.reduce((a, b) => a + b, 0) / Math.max(1, s.length);
  return { avg, p95: s[Math.floor(s.length * 0.95)] ?? 0, max: s[s.length - 1] ?? 0, n: s.length };
};

// ── panel ──
if (q.get('panel') !== '0') {
  const panel = document.createElement('div');
  panel.style.cssText = 'display:flex;gap:6px;padding:10px;flex-wrap:wrap;overflow:auto;flex:1 1 auto;align-content:flex-start';
  const btn = (label: string, fn: () => void): void => {
    const b = document.createElement('button');
    b.className = 'ui-btn ui-btn--sm';
    b.textContent = label;
    b.addEventListener('click', fn);
    panel.appendChild(b);
  };
  const stats = document.createElement('div');
  stats.style.cssText = 'width:100%;font:600 11px/1.4 var(--font-ui);color:var(--ink-3)';
  panel.appendChild(stats);
  for (const hh of [150, 250, 430]) btn(`h ${hh}`, () => (box.style.height = `${hh}px`));
  for (const d of ['chill', 'club', 'festival'] as Difficulty[]) btn(d, () => rhythm.setDifficulty(d));
  for (const d of [0, 0.35, 0.7, 1]) btn(`dens ${d}`, () => rhythm.setDensity(d));
  btn('play/pause A', () => h.engine.togglePlay('A'));
  btn('play/pause B', () => h.engine.togglePlay('B'));
  const fade = (to: number): void => {
    const from = h.engine.getMixer().crossfader;
    const t0 = performance.now();
    const id = setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / 1500);
      h.engine.setCrossfader(from + (to - from) * k);
      if (k >= 1) clearInterval(id);
    }, 16);
  };
  btn('mix → B', () => {
    h.engine.sync('B');
    h.engine.play('B');
    fade(1);
  });
  btn('mix → A', () => {
    h.engine.sync('A');
    h.engine.play('A');
    fade(-1);
  });
  btn('scratch live', () => {
    const deck = h.loop.frame.liveDeck;
    if (!deck) return;
    h.engine.scratchStart(deck);
    const t0 = performance.now();
    const id = setInterval(() => {
      const t = (performance.now() - t0) / 1000;
      h.engine.scratchMove(deck, Math.sin(t * 9) * 0.03);
      if (t > 1.6) {
        clearInterval(id);
        h.engine.scratchEnd(deck);
      }
    }, 16);
  });
  btn('tempo 0.92', () => h.engine.setTempo('A', 0.92));
  btn('tempo 1.08', () => h.engine.setTempo('A', 1.08));
  btn('lowFx', () => settings.set({ lowFx: !settings.get().lowFx }));
  btn('reset', () => rhythm.reset());
  btn('→ drop', () => h.engine.seek('A', h.tracks.A.meta.grid.firstBeatSec + (76 * 60) / h.tracks.A.meta.grid.bpm));
  setInterval(() => {
    const s = rhythm.getStats();
    const p = perf();
    stats.textContent =
      `${s.perfect}P ${s.great}G ${s.good}g ${s.miss}M · combo ${s.combo} ×${s.multiplier} · ${s.points} pts · acc ${(s.accuracy * 100).toFixed(1)}%` +
      ` · update avg ${p.avg.toFixed(2)} ms p95 ${p.p95.toFixed(2)} max ${p.max.toFixed(2)}`;
  }, 250);
  h.root.appendChild(panel);
}

(window as unknown as Record<string, unknown>).__rh = dev;
(window as unknown as Record<string, unknown>).__rhPerf = perf;
