/**
 * Dev harness for the analysis + library module: imports synthetic WAV files through the real
 * library (real decodeAudioData, real Worker, real IndexedDB), draws the three-band waveform with
 * the detected beat grid over it, and runs a read-only check against the built-in music when that
 * module exists.
 *
 * Open http://localhost:5183/dev/analysis.html. Everything is on window.__a for Playwright.
 */
import '../styles/base.css';
import { loadFonts } from '../core/fonts';
import { beatAtSec, secAtBeat } from '../core/beatgrid';
import { BEATS_PER_BAR, ImportError } from '../core/types';
import type { BuiltinMusic, Library, LoadedTrack, TrackMeta } from '../core/types';
import { COLORS, FONT_DISPLAY, fitCanvas, font, rgba } from '../theme/theme';
import { detectGrid } from '../analysis';
import { encodeWav, synthTrack } from '../analysis/synth';
import { createLibrary } from '../library';
import { MOCK_CATALOG } from './mocks';

const SAMPLE_RATE = 48000;

/** Stand-in for the built-in music: the mock catalog rendered as synthetic house. */
const fakeMusic: BuiltinMusic = {
  catalog: MOCK_CATALOG.slice(0, 2),
  async renderTrack(id, sampleRate, onProgress) {
    const meta = MOCK_CATALOG.find((m) => m.id === id)!;
    onProgress?.(0.3);
    const t = synthTrack({ bpm: meta.grid.bpm, firstBeatSec: meta.grid.firstBeatSec, sampleRate, bars: 64, seed: meta.art.seed });
    onProgress?.(1);
    return t.pcm;
  },
  async renderSounds() {
    throw new Error('not in this harness');
  },
};

await loadFonts();
const library: Library = createLibrary({ music: fakeMusic, sampleRate: SAMPLE_RATE });

// ───────────────────────────── page ─────────────────────────────

const app = document.getElementById('app')!;
app.innerHTML = `
<div class="an-page" style="max-width:520px;margin:0 auto;padding:16px;display:flex;flex-direction:column;gap:12px;color:${COLORS.ink};font-family:Manrope,system-ui">
  <div style="font:800 18px ${FONT_DISPLAY};letter-spacing:.02em">Analysis harness</div>
  <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
    <label class="ui-label">BPM <input id="bpm" value="124.5" style="width:64px"></label>
    <label class="ui-label">1st beat <input id="first" value="0.731" style="width:64px"></label>
    <button class="ui-btn ui-btn--sm" id="synth">Import synthetic WAV</button>
    <button class="ui-btn ui-btn--sm" id="garbage">Import garbage</button>
    <label class="ui-btn ui-btn--sm">Pick a file<input id="file" type="file" accept="audio/*" hidden></label>
  </div>
  <div id="status" class="ui-muted" style="min-height:20px;font-size:13px"></div>
  <canvas id="wave" style="width:100%;height:150px;border-radius:12px;background:${COLORS.bg1}"></canvas>
  <canvas id="zoom" style="width:100%;height:190px;border-radius:12px;background:${COLORS.bg1}"></canvas>
  <div id="list" style="display:flex;flex-direction:column;gap:6px"></div>
</div>`;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const status = (s: string): void => {
  $('status').textContent = s;
};

let current: LoadedTrack | null = null;
let zoomStart = 0;
let zoomSpan = 4;

function renderList(): void {
  const list = $('list');
  list.replaceChildren();
  for (const m of library.list()) {
    const row = document.createElement('button');
    row.className = 'ui-btn ui-btn--sm';
    row.style.justifyContent = 'space-between';
    row.dataset.id = m.id;
    const conf = m.gridConfidence !== undefined ? ` · conf ${m.gridConfidence.toFixed(2)}` : '';
    row.textContent = `${m.source === 'user' ? '★ ' : ''}${m.artist} - ${m.title} · ${m.grid.bpm.toFixed(2)} BPM @ ${m.grid.firstBeatSec.toFixed(3)}s${conf}`;
    row.addEventListener('click', () => void show(m.id));
    list.appendChild(row);
  }
}
library.subscribe(renderList);
renderList();

// ───────────────────────────── drawing ─────────────────────────────

const BAND_COLORS = { low: COLORS.violet, mid: COLORS.cyan, high: COLORS.ink } as const;

/** Draw [t0, t0 + span) seconds of the waveform with beat / bar lines of `grid`. */
function drawWave(canvas: HTMLCanvasElement, track: LoadedTrack, t0: number, span: number, label: string): void {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const ctx = fitCanvas(canvas, w, h);
  ctx.clearRect(0, 0, w, h);
  const wf = track.waveform;
  const mid = h / 2;
  const grid = track.meta.grid;
  const pxPerSec = w / span;

  // grid lines under the waveform
  const b0 = Math.ceil(beatAtSec(grid, t0));
  const b1 = Math.floor(beatAtSec(grid, t0 + span));
  const beatPx = (60 / grid.bpm) * pxPerSec;
  if (beatPx > 3) {
    for (let b = b0; b <= b1; b++) {
      const x = (secAtBeat(grid, b) - t0) * pxPerSec;
      const bar = ((b % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR === 0;
      ctx.fillStyle = bar ? rgba(COLORS.gold, 0.9) : rgba(COLORS.ink, 0.28);
      ctx.fillRect(Math.round(x) - (bar ? 1 : 0), 0, bar ? 2 : 1, h);
    }
  }

  // three bands, mirrored, drawn loudest-first so the treble stays on top
  ctx.globalCompositeOperation = 'lighter';
  for (const band of ['low', 'mid', 'high'] as const) {
    const data = wf[band];
    ctx.fillStyle = rgba(BAND_COLORS[band], band === 'high' ? 0.55 : 0.75);
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const from = Math.floor((t0 + x / pxPerSec) * wf.rate);
      const to = Math.max(from + 1, Math.floor((t0 + (x + 1) / pxPerSec) * wf.rate));
      let v = 0;
      for (let i = from; i < to && i < wf.length; i++) if (i >= 0 && data[i] > v) v = data[i];
      const a = (v / 255) * (mid - 4) * (band === 'high' ? 0.6 : band === 'mid' ? 0.8 : 1);
      ctx.rect(x, mid - a, 1, 2 * a);
    }
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';

  ctx.fillStyle = COLORS.ink2;
  ctx.font = font(700, 11);
  ctx.fillText(label, 8, 14);
}

function redraw(): void {
  if (!current) return;
  const dur = current.meta.durationSec;
  drawWave($<HTMLCanvasElement>('wave'), current, 0, dur, `${current.meta.title}: whole track`);
  drawWave(
    $<HTMLCanvasElement>('zoom'),
    current,
    zoomStart,
    zoomSpan,
    `${zoomStart.toFixed(2)}s +${zoomSpan}s · ${current.meta.grid.bpm.toFixed(3)} BPM · gold = bar line`,
  );
}

async function show(id: string, startSec?: number, spanSec?: number): Promise<LoadedTrack> {
  status(`Loading ${id}…`);
  const t0 = performance.now();
  const track = await library.load(id, (p, s) => status(`${s ?? ''} ${(p * 100).toFixed(0)}%`));
  timings.load = performance.now() - t0;
  current = track;
  // zoom on the first loud section
  const drop = track.meta.sections.find((s) => s.kind === 'drop') ?? track.meta.sections[0];
  const grid = track.meta.grid;
  zoomStart = startSec ?? secAtBeat(grid, (drop?.startBar ?? 0) * BEATS_PER_BAR) - 0.1;
  zoomSpan = spanSec ?? (60 / grid.bpm) * 8;
  redraw();
  status(`${track.meta.title}: loaded in ${timings.load.toFixed(0)} ms · sections ${track.meta.sections.map((s) => `${s.kind}${s.bars}`).join(' ')}`);
  return track;
}

// ───────────────────────────── actions ─────────────────────────────

const timings: Record<string, number> = {};

function synthFile(bpm: number, first: number, bars = 64, name?: string): File {
  const t = synthTrack({ bpm, firstBeatSec: first, bars, sampleRate: 44100, seed: Math.round(bpm * 10) });
  return new File([encodeWav(t.pcm)], name ?? `Synth Lab - House ${bpm} at ${first}.wav`, { type: 'audio/wav' });
}

async function importFile(file: File): Promise<TrackMeta | { error: string; code: string }> {
  const t0 = performance.now();
  try {
    const meta = await library.importFile(file, (p, s) => status(`${s ?? ''} ${(p * 100).toFixed(0)}%`));
    timings.import = performance.now() - t0;
    status(`Imported ${meta.title}: ${meta.grid.bpm.toFixed(3)} BPM, conf ${meta.gridConfidence?.toFixed(2)} in ${timings.import.toFixed(0)} ms`);
    return meta;
  } catch (err) {
    const code = err instanceof ImportError ? err.code : 'not-an-ImportError';
    status(`Import failed (${code}): ${(err as Error).message}`);
    return { error: (err as Error).message, code };
  }
}

$('synth').addEventListener('click', () => {
  void importFile(synthFile(Number($<HTMLInputElement>('bpm').value), Number($<HTMLInputElement>('first').value)));
});
$('garbage').addEventListener('click', () => {
  void importFile(new File([crypto.getRandomValues(new Uint8Array(40000))], 'Protected - Song.m4p', { type: 'audio/mp4' }));
});
$<HTMLInputElement>('file').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) void importFile(f);
});
window.addEventListener('resize', redraw);

/** Read-only check against the real built-in music module, when it exists. */
async function musicCheck(): Promise<unknown> {
  const mods = import.meta.glob('../music/index.ts');
  const loader = mods['../music/index.ts'];
  if (!loader) return { available: false };
  const mod = (await loader()) as { createBuiltinMusic?: () => BuiltinMusic };
  if (!mod.createBuiltinMusic) return { available: false, reason: 'no createBuiltinMusic export' };
  const music = mod.createBuiltinMusic();
  const lib = createLibrary({ music, sampleRate: SAMPLE_RATE });
  const results = [];
  for (const meta of music.catalog) {
    const t0 = performance.now();
    const track = await lib.load(meta.id);
    const loadMs = performance.now() - t0;
    const t1 = performance.now();
    const det = await detectGrid(track.pcm);
    const detectMs = performance.now() - t1;
    const beat = 60 / meta.grid.bpm;
    const dBeats = (det.grid.firstBeatSec - meta.grid.firstBeatSec) / beat;
    const nearest = Math.round(dBeats);
    results.push({
      id: meta.id,
      catalogBpm: meta.grid.bpm,
      detectedBpm: det.grid.bpm,
      phaseMs: (dBeats - nearest) * beat * 1000,
      downbeatOffsetBeats: ((nearest % 4) + 4) % 4,
      confidence: det.confidence,
      loadMs,
      detectMs,
      durationSec: track.pcm.length / track.pcm.sampleRate,
    });
  }
  return { available: true, results };
}

declare global {
  interface Window {
    __a: unknown;
  }
}
window.__a = {
  library,
  timings,
  synthFile,
  importFile,
  importSynth: (bpm: number, first: number, bars = 64, name?: string) => importFile(synthFile(bpm, first, bars, name)),
  importGarbage: () =>
    importFile(new File([crypto.getRandomValues(new Uint8Array(40000))], 'Protected - Song.m4p', { type: 'audio/mp4' })),
  list: () => library.list().map((m) => ({ id: m.id, title: m.title, artist: m.artist, source: m.source, grid: m.grid, conf: m.gridConfidence, sections: m.sections })),
  show: async (id: string, startSec?: number, spanSec?: number) => {
    const t = await show(id, startSec, spanSec);
    return { id: t.meta.id, grid: t.meta.grid, waveformLength: t.waveform.length, rate: t.waveform.rate };
  },
  musicCheck,
};
