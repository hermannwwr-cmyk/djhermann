/**
 * Console harness: the game-screen column with the waveforms and the console in their real slots.
 * Open http://localhost:5186/dev/console.html
 *   ?panel=deckA|mixer|deckB   open a panel at start
 *   ?b=play                    start deck B playing too (synced unless &phase=<beats>)
 *   ?empty=B                   eject a deck
 *   ?load=1                    free-play LOAD buttons
 */
import { bootHarness } from './harness';
import { createConsole, createWaveforms } from '../ui/console';
import { createSettings } from '../core/settings';
import { deckPanel } from '../core/controls';
import type { DeckId, PanelId } from '../core/types';

const q = new URLSearchParams(location.search);
const h = await bootHarness({ startBeat: Number(q.get('beat') ?? 16) });
const settings = createSettings(null);

const top = document.createElement('div');
top.style.cssText =
  'flex:none;height:104px;display:grid;place-items:center;color:#4a4866;font:800 10px Manrope;letter-spacing:.16em;background:linear-gradient(180deg,#0d0d1c,#0a0a14)';
top.textContent = 'TOP BAR';
h.root.appendChild(top);

const loads: DeckId[] = [];
const con = createConsole({ engine: h.engine, settings, onLoadRequest: (d) => loads.push(d) });
const waves = createWaveforms({ engine: h.engine, onDeckTap: (d) => con.openPanel(deckPanel(d)) });
h.mount(waves.el, 60);

const play = document.createElement('div');
play.style.cssText =
  'flex:1 1 0;min-height:0;display:grid;place-items:center;color:#4a4866;font:800 10px Manrope;letter-spacing:.16em;background:radial-gradient(80% 60% at 50% 100%,rgba(139,108,255,.12),transparent),#0a0a14';
play.textContent = 'PLAYFIELD';
h.root.appendChild(play);
h.root.appendChild(con.el);

h.loop.add((f) => waves.update(f));
let worst = 0;
const times: number[] = [];
h.loop.add((f) => {
  const t0 = performance.now();
  con.update(f);
  const dt = performance.now() - t0;
  times.push(dt);
  if (times.length > 600) times.shift();
  worst = Math.max(worst, dt);
});

if (q.get('load')) con.setLoadEnabled(true);
const empty = q.get('empty') as DeckId | null;
if (empty) h.engine.eject(empty);
if (q.get('b') === 'play') {
  h.engine.setCrossfader(0);
  h.engine.sync('B');
  const ph = Number(q.get('phase') ?? 0);
  if (ph) {
    const d = h.engine.getDeck('B');
    h.engine.seek('B', d.positionSec + (ph * 60) / d.track!.grid.bpm);
  }
  h.engine.play('B');
}
const panel = q.get('panel') as PanelId | null;
if (panel) con.openPanel(panel);

const panelLog: (PanelId | null)[] = [];
con.onPanelChange((id) => panelLog.push(id));

Object.assign(window as object, {
  __con: con,
  __settings: settings,
  __loads: loads,
  __panelLog: panelLog,
  __perf: () => {
    const s = [...times].sort((a, b) => a - b);
    return { n: s.length, mean: s.reduce((a, b) => a + b, 0) / Math.max(1, s.length), p95: s[Math.floor(s.length * 0.95)] ?? 0, worst };
  },
  __resetPerf: () => {
    times.length = 0;
    worst = 0;
  },
});
