/**
 * Audio engine harness: http://localhost:5181/dev/audio.html
 *
 * Plays the real engine with two synthetic grooves. Every control of the AudioEngine interface is
 * here, plus live readouts (as-heard position, rate, meters, clock, latency) and the measurement
 * suite. Playwright drives it through window.__audio.
 */
import '../styles/base.css';
import { createAudioEngine } from '../audio';
import type { RealAudioEngine } from '../audio';
import { loadFonts } from '../core/fonts';
import type { DeckId, EqBand, LoadedTrack } from '../core/types';
import { groove, toPcm, tone, trackFrom } from './audio-signals';
import { measureAlignment, measureClock, measureMixer, measureWorklet, soak } from './audio-measure';

const engine = createAudioEngine() as RealAudioEngine;
const sr = engine.sampleRate;
const tracks: LoadedTrack[] = [
  trackFrom(groove(sr, 122, 0.25, 24, 1), 'groove-122', 'Groove 122', 122, 0.25, 190),
  trackFrom(groove(sr, 126, 0.4, 24, 2), 'groove-126', 'Groove 126', 126, 0.4, 320),
];

// one-shot sounds for the pads
function burst(hz: number, decay: number, noiseAmt: number): ReturnType<typeof toPcm> {
  const n = Math.round(0.4 * sr);
  const L = new Float32Array(n);
  let s = 3;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const t = i / sr;
    L[i] = (Math.sin(2 * Math.PI * hz * t * (1 + Math.exp(-t * 40))) * (1 - noiseAmt) + (s / 4294967296 - 0.5) * noiseAmt) * Math.exp(-t * decay) * 0.9;
  }
  return toPcm(L, L, sr);
}
engine.registerSound('boom', burst(55, 9, 0));
engine.registerSound('clap', burst(1200, 25, 0.9));
engine.registerSound('zap', burst(880, 14, 0.1));
engine.registerSound('horn', tone(sr, 440, 0.5, 0.3));

// ───────────────────────────── UI ─────────────────────────────

await loadFonts();
const style = document.createElement('style');
style.textContent = `
  body { background: var(--bg-0); }
  .aud { width: 100%; max-width: 520px; height: 100%; overflow-y: auto; box-sizing: border-box; margin: 0 auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; color: var(--ink); font-family: var(--font-ui); }
  .aud h1 { font-family: var(--font-display); font-weight: 900; font-size: 20px; margin: 0; letter-spacing: .02em; }
  .aud-card, .aud-row, .aud-read { min-width: 0; }
  .aud-card { overflow: hidden; background: var(--hw-plate); border: 1px solid var(--line); border-radius: 14px; padding: 12px; box-shadow: inset 0 1px 0 var(--hw-edge), 0 8px 24px rgba(0,0,0,.4); }
  .aud-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .aud-deck { border-left: 3px solid var(--c); }
  .aud-title { font-weight: 800; font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: var(--c, var(--ink)); margin-bottom: 8px; }
  .aud-read { font: 600 12px/1.5 ui-monospace, Menlo, monospace; color: var(--ink-2); white-space: pre-wrap; }
  .aud label { font-size: 11px; color: var(--ink-3); display: flex; flex-direction: column; gap: 2px; min-width: 70px; flex: 1 1 70px; }
  .aud input[type=range] { width: 100%; accent-color: var(--c, var(--violet)); }
  .aud-scr { flex: 1; min-width: 120px; height: 44px; border-radius: 10px; background: var(--hw-well); border: 1px solid var(--line-strong); display: grid; place-items: center; font-size: 11px; color: var(--ink-3); touch-action: none; user-select: none; }
  .aud-meter { height: 6px; border-radius: 3px; background: var(--hw-well); overflow: hidden; }
  .aud-meter > i { display: block; height: 100%; width: 0; background: var(--c, var(--aurora)); transform-origin: left; }
  .aud-out { font: 500 11px/1.45 ui-monospace, Menlo, monospace; color: var(--ink-2); white-space: pre-wrap; max-height: 360px; overflow: auto; }
`;
document.head.appendChild(style);

const root = document.createElement('div');
root.className = 'aud';
document.getElementById('app')!.appendChild(root);
root.innerHTML = `<h1 class="ui-aurora-text">AUDIO ENGINE</h1>`;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement, text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  parent.appendChild(e);
  return e;
};
const button = (parent: HTMLElement, label: string, fn: () => void, down?: () => void): HTMLButtonElement => {
  const b = el('button', 'ui-btn ui-btn--sm', parent, label);
  if (down) {
    b.addEventListener('pointerdown', (e) => {
      b.setPointerCapture(e.pointerId);
      down();
    });
    b.addEventListener('pointerup', fn);
    b.addEventListener('pointercancel', fn);
  } else b.addEventListener('pointerdown', fn);
  return b;
};
const slider = (parent: HTMLElement, label: string, min: number, max: number, value: number, fn: (v: number) => void): HTMLInputElement => {
  const l = el('label', '', parent, label);
  const i = el('input', '', l);
  i.type = 'range';
  i.min = String(min);
  i.max = String(max);
  i.step = String((max - min) / 400);
  i.value = String(value);
  i.addEventListener('input', () => fn(Number(i.value)));
  return i;
};

const top = el('div', 'aud-card', root);
const topRow = el('div', 'aud-row', top);
button(topRow, 'Unlock', () => {
  void engine.unlock().then(() => Promise.all([engine.loadTrack('A', tracks[0]), engine.loadTrack('B', tracks[1])]));
});
button(topRow, 'Suspend', () => void engine.suspend());
button(topRow, 'Resume', () => void engine.resume());
for (const p of ['boom', 'clap', 'zap', 'horn']) button(topRow, p.toUpperCase(), () => engine.playSound(p));
const masterRow = el('div', 'aud-row', top);
slider(masterRow, 'crossfader', -1, 1, -1, (v) => engine.setCrossfader(v));
slider(masterRow, 'master', 0, 1, 1, (v) => engine.setMasterVolume(v));
slider(masterRow, 'latency ms (0 = auto)', 0, 300, 0, (v) => engine.setLatencyMs(v > 0 ? v : null));
const masterMeter = el('div', 'aud-meter', top);
const masterBar = el('i', '', masterMeter);
const clockRead = el('div', 'aud-read', top);

const readouts: Record<DeckId, { read: HTMLElement; bar: HTMLElement }> = {} as never;
for (const id of ['A', 'B'] as DeckId[]) {
  const card = el('div', 'aud-card aud-deck', root);
  card.style.setProperty('--c', id === 'A' ? 'var(--deck-a)' : 'var(--deck-b)');
  el('div', 'aud-title', card, `Deck ${id}`);
  const r1 = el('div', 'aud-row', card);
  button(r1, 'PLAY', () => engine.togglePlay(id));
  button(r1, 'CUE', () => engine.cueUp(id), () => engine.cueDown(id));
  button(r1, 'SYNC', () => engine.sync(id));
  button(r1, '◀ bend', () => engine.setNudge(id, 0), () => engine.setNudge(id, -1));
  button(r1, 'bend ▶', () => engine.setNudge(id, 0), () => engine.setNudge(id, 1));
  const echo = el('button', 'ui-btn ui-btn--sm', r1, 'ECHO');
  let echoOn = false;
  echo.addEventListener('pointerdown', () => {
    echoOn = !echoOn;
    echo.classList.toggle('ui-btn--primary', echoOn);
    engine.setEcho(id, echoOn);
  });
  button(r1, 'eject', () => engine.eject(id));
  button(r1, 'load', () => void engine.loadTrack(id, tracks[id === 'A' ? 0 : 1]));
  const scr = el('div', 'aud-scr', r1, 'drag to scratch');
  let lastX = 0;
  scr.addEventListener('pointerdown', (e) => {
    scr.setPointerCapture(e.pointerId);
    lastX = e.clientX;
    engine.scratchStart(id);
  });
  scr.addEventListener('pointermove', (e) => {
    if (!scr.hasPointerCapture(e.pointerId)) return;
    engine.scratchMove(id, ((e.clientX - lastX) / 200) * 1.8 * 0.5);
    lastX = e.clientX;
  });
  const end = (): void => engine.scratchEnd(id);
  scr.addEventListener('pointerup', end);
  scr.addEventListener('pointercancel', end);
  const r2 = el('div', 'aud-row', card);
  slider(r2, 'tempo', 0.92, 1.08, 1, (v) => engine.setTempo(id, v));
  for (const band of ['high', 'mid', 'low'] as EqBand[]) slider(r2, band, 0, 1, 0.5, (v) => engine.setEq(id, band, v));
  slider(r2, 'filter', -1, 1, 0, (v) => engine.setFilter(id, v));
  slider(r2, 'fader', 0, 1, 1, (v) => engine.setFader(id, v));
  const meter = el('div', 'aud-meter', card);
  const bar = el('i', '', meter);
  readouts[id] = { read: el('div', 'aud-read', card), bar };
}

const measure = el('div', 'aud-card', root);
const mRow = el('div', 'aud-row', measure);
const out = el('div', 'aud-out', measure);
const show = (name: string, v: unknown): void => {
  out.textContent = `${name}\n${JSON.stringify(v, null, 1)}\n\n${out.textContent ?? ''}`;
};
const run = (name: string, fn: () => Promise<unknown>): void => {
  button(mRow, name, () => {
    show(name, 'running…');
    fn().then(
      (v) => show(name, v),
      (e: unknown) => show(name, String(e)),
    );
  });
};
run('worklet', measureWorklet);
run('mixer', measureMixer);
run('clock', () => measureClock(engine, tracks[0]));
run('align 80 ms', () => measureAlignment(engine, 80));

function update(): void {
  for (const id of ['A', 'B'] as DeckId[]) {
    const d = engine.getDeck(id);
    readouts[id].bar.style.width = `${Math.round(d.level * 100)}%`;
    readouts[id].read.textContent =
      `${d.track ? d.track.title : '(empty)'}  ${d.playing ? 'PLAYING' : d.cuePreview ? 'CUE PREVIEW' : 'paused'}${d.scratching ? ' SCRATCH' : ''}${d.synced ? ' SYNCED' : ''}\n` +
      `pos ${d.positionSec.toFixed(3)} s  beat ${d.beat.toFixed(2)}  rate ${d.rate.toFixed(3)}  bpm ${d.bpm.toFixed(2)}\n` +
      `cue ${d.cueSec.toFixed(3)}  audibility ${d.audibility.toFixed(2)}  level ${d.level.toFixed(2)}  nudge ${d.nudge.toFixed(2)}`;
  }
  const m = engine.getMixer();
  masterBar.style.width = `${Math.round(m.masterLevel * 100)}%`;
  const s = engine.debug.stats();
  clockRead.textContent =
    `ctx ${s.state}  sr ${sr}  unlocked ${engine.unlocked}  ctxTime ${engine.ctxTime().toFixed(3)}\n` +
    `latency ${(engine.getLatency() * 1000).toFixed(1)} ms (auto ${engine.getAutoLatencyMs().toFixed(1)})  out ${s.outputLatencyMs?.toFixed(1) ?? '-'}  base ${s.baseLatencyMs?.toFixed(1) ?? '-'}  ts ${s.measuredOutputLatencyMs?.toFixed(1) ?? '-'}\n` +
    `bands L ${m.bands.low.toFixed(2)} M ${m.bands.mid.toFixed(2)} H ${m.bands.high.toFixed(2)}  nodes ${s.graphNodes}  voices ${s.voices}`;
  requestAnimationFrame(update);
}
requestAnimationFrame(update);

(window as unknown as { __audio: unknown }).__audio = {
  engine,
  tracks,
  measure: {
    worklet: measureWorklet,
    mixer: measureMixer,
    clock: (sec?: number) => measureClock(engine, tracks[0], sec),
    alignment: (latencyMs: number) => measureAlignment(engine, latencyMs),
    soak: (sec?: number) => soak(engine, tracks, sec),
  },
};
