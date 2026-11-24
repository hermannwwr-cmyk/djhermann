/**
 * Music harness: renders a built-in track (in the worker, then again on the main thread to prove
 * the two are bit-identical), draws its waveform and spectrogram with the sections marked, and
 * prints the numbers that matter. Also renders and measures every one-shot sound.
 *
 *   /dev/music.html                         track picker
 *   /dev/music.html?track=<id>&sr=48000     analyse one track (auto)
 *   /dev/music.html?sounds=1                the one-shot sounds
 *
 * Results are kept on window.__music for Playwright.
 */
import '../styles/base.css';
import { loadFonts } from '../core/fonts';
import type { PcmData, SoundName, TrackMeta } from '../core/types';
import { COLORS, FONT_DISPLAY, font } from '../theme/theme';
import { createBuiltinMusic } from '../music';
import { createTrackJob } from '../music/render';
import { songById } from '../music/catalog';
import { beatToFrame } from '../music/timeline';

interface TrackResult {
  id: string;
  sampleRate: number;
  workerMs: number;
  mainMs: number;
  identical: boolean;
  peakDb: number;
  prePeakDb: number;
  limiterDb: number;
  nonFinite: number;
  dc: [number, number];
  sections: { kind: string; startBar: number; rmsDb: number; low: number; mid: number; high: number; sideDb: number }[];
  kickErrMs: Record<number, number | null>;
  mixKickErrMs: number | null;
  lowSideDb: number;
}

const music = createBuiltinMusic();
const params = new URLSearchParams(location.search);
const SR = Number(params.get('sr') ?? 48000);
interface Store {
  tracks: Record<string, TrackResult>;
  sounds?: unknown;
  done?: boolean;
}
const store: Store = { tracks: {} };
(window as unknown as { __music: Store }).__music = store;

await loadFonts();
const app = document.getElementById('app')!;
app.style.cssText = `padding:20px 24px;color:${COLORS.ink};font:500 13px/1.45 Manrope,system-ui;min-height:100vh;background:${COLORS.bg0}`;
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, css = '', text = ''): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  el.style.cssText = css;
  el.textContent = text;
  return el;
};

const bar = h('div', 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px');
app.appendChild(bar);
for (const t of music.catalog) {
  const a = h('a', `color:${COLORS.ink2};text-decoration:none;padding:6px 10px;border:1px solid rgba(255,255,255,.12);border-radius:8px`, `${t.grid.bpm} · ${t.title}`);
  a.href = `?track=${t.id}&sr=${SR}`;
  bar.appendChild(a);
}
const sl = h('a', `color:${COLORS.gold};text-decoration:none;padding:6px 10px;border:1px solid rgba(255,207,74,.3);border-radius:8px`, 'sounds');
sl.href = `?sounds=1&sr=${SR}`;
bar.appendChild(sl);
const status = h('div', `color:${COLORS.ink3};margin:0 0 10px`);
app.appendChild(status);

// ───────────────────────────── analysis helpers ─────────────────────────────

const db = (x: number): number => 20 * Math.log10(Math.max(x, 1e-9));

/** In-place radix-2 FFT of (re, im). */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

const N = 2048;
const hann = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
/** scales FFT power to dBFS of a full-scale sine (Hann window gain N/4) */
const NORM = 16 / (N * N);
const re = new Float64Array(N);
const im = new Float64Array(N);
/** Power spectrum of the mono mix (or the side signal) at a frame; result in `pow` (N/2 bins). */
function spectrumAt(p: PcmData, at: number, pow: Float64Array, side = false): void {
  const [l, r] = p.channels;
  for (let i = 0; i < N; i++) {
    const j = at - N / 2 + i;
    const x = j >= 0 && j < p.length ? (side ? l[j] - r[j] : l[j] + r[j]) / 65536 : 0;
    re[i] = x * hann[i];
    im[i] = 0;
  }
  fft(re, im);
  for (let k = 0; k < N / 2; k++) pow[k] = re[k] * re[k] + im[k] * im[k];
}

function bandsOf(p: PcmData, f0: number, f1: number, side = false): { low: number; mid: number; high: number; total: number } {
  const pow = new Float64Array(N / 2);
  let low = 0;
  let mid = 0;
  let high = 0;
  const steps = 48;
  for (let s = 0; s < steps; s++) {
    spectrumAt(p, Math.round(f0 + ((f1 - f0) * (s + 0.5)) / steps), pow, side);
    for (let k = 1; k < N / 2; k++) {
      const f = (k * p.sampleRate) / N;
      if (f < 150) low += pow[k];
      else if (f < 2500) mid += pow[k];
      else high += pow[k];
    }
  }
  return { low, mid, high, total: low + mid + high };
}

function onsetErr(ch: Int16Array, expect: number, sr: number, thr = 300): number | null {
  for (let i = expect - Math.round(0.01 * sr); i < expect + Math.round(0.01 * sr); i++) {
    if (Math.abs(ch[i]) > thr) return ((i - expect) / sr) * 1000;
  }
  return null;
}

function hashPcm(p: PcmData): string {
  let a = 2166136261;
  for (const ch of p.channels) for (let i = 0; i < ch.length; i++) a = Math.imul(a ^ (ch[i] & 0xffff), 16777619);
  return (a >>> 0).toString(16);
}

const nextFrame = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// ───────────────────────────── drawing ─────────────────────────────

const SECTION_COLORS: Record<string, string> = {
  intro: '#4a4866',
  groove: '#6f8dff',
  build: '#ffa63d',
  drop: '#ff4fa8',
  break: '#2de2ff',
  outro: '#4a4866',
};

function drawTrack(meta: TrackMeta, p: PcmData, res: TrackResult): HTMLCanvasElement {
  const W = 1200;
  const H = 470;
  const c = h('canvas', `width:${W}px;height:${H}px;display:block;border-radius:12px;background:#08080d`);
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const top = 34;
  const waveH = 130;
  const specTop = top + waveH + 10;
  const specH = 260;
  const fx = (frame: number): number => (frame / p.length) * W;
  // sections
  for (const s of meta.sections) {
    const x0 = fx(beatToFrame(meta.grid.bpm, p.sampleRate, s.startBar * 4));
    const x1 = fx(beatToFrame(meta.grid.bpm, p.sampleRate, (s.startBar + s.bars) * 4));
    g.fillStyle = SECTION_COLORS[s.kind] + '33';
    g.fillRect(x0, 0, x1 - x0, 26);
    g.fillStyle = SECTION_COLORS[s.kind];
    g.fillRect(x0, 0, 2, H);
    g.font = font(800, 11);
    g.fillText(`${s.kind.toUpperCase()} ${s.bars}`, x0 + 6, 17);
  }
  // bar ticks
  g.fillStyle = 'rgba(255,255,255,.12)';
  for (let b = 0; b <= 64; b++) g.fillRect(fx(beatToFrame(meta.grid.bpm, p.sampleRate, b * 4)), 26, 1, b % 4 ? 4 : 8);
  // waveform: min/max per column, left up / right down
  const [l, r] = p.channels;
  const per = p.length / W;
  const mid = top + waveH / 2;
  for (let x = 0; x < W; x++) {
    const a = Math.floor(x * per);
    const b = Math.min(p.length, Math.floor((x + 1) * per));
    let mx = 0;
    let s2 = 0;
    for (let i = a; i < b; i++) {
      const v = Math.max(Math.abs(l[i]), Math.abs(r[i])) / 32768;
      if (v > mx) mx = v;
      s2 += ((l[i] + r[i]) / 65536) ** 2;
    }
    const rms = Math.sqrt(s2 / Math.max(1, b - a));
    g.fillStyle = 'rgba(139,108,255,.55)';
    g.fillRect(x, mid - (mx * waveH) / 2, 1, mx * waveH);
    g.fillStyle = COLORS.cyan;
    g.fillRect(x, mid - (rms * waveH) / 2, 1, rms * waveH);
  }
  // spectrogram: log frequency 30 Hz .. 16 kHz
  const img = g.createImageData(W, specH);
  const pow = new Float64Array(N / 2);
  const fLo = Math.log(30);
  const fHi = Math.log(16000);
  for (let x = 0; x < W; x++) {
    spectrumAt(p, Math.round((x + 0.5) * per), pow);
    for (let y = 0; y < specH; y++) {
      const f = Math.exp(fHi - ((fHi - fLo) * y) / (specH - 1));
      const k = Math.min(N / 2 - 1, Math.max(1, Math.round((f * N) / p.sampleRate)));
      const v = Math.max(0, Math.min(1, (10 * Math.log10(pow[k] * NORM + 1e-14) + 96) / 80));
      const o = (y * W + x) * 4;
      // dark → violet → pink → gold
      img.data[o] = Math.min(255, v < 0.5 ? v * 2 * 140 : 140 + (v - 0.5) * 2 * 115);
      img.data[o + 1] = Math.min(255, v < 0.6 ? v * 60 : 36 + (v - 0.6) * 2.5 * 170);
      img.data[o + 2] = Math.min(255, v < 0.5 ? 30 + v * 2 * 200 : 230 - (v - 0.5) * 2 * 150);
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, specTop);
  g.fillStyle = 'rgba(255,255,255,.5)';
  g.font = font(600, 10);
  for (const f of [50, 150, 500, 2500, 10000]) {
    const y = specTop + ((fHi - Math.log(f)) / (fHi - fLo)) * (specH - 1);
    g.fillRect(0, y, 6, 1);
    g.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, 8, y + 3);
  }
  // section borders over everything
  for (const s of meta.sections) {
    g.fillStyle = SECTION_COLORS[s.kind];
    g.fillRect(fx(beatToFrame(meta.grid.bpm, p.sampleRate, s.startBar * 4)), specTop, 2, specH);
  }
  g.fillStyle = COLORS.ink;
  g.font = font(900, 13, FONT_DISPLAY);
  g.fillText(`${meta.title.toUpperCase()}  ·  ${meta.grid.bpm} BPM  ·  ${meta.key}`, 12, H - 12);
  void res;
  return c;
}

function table(rows: (string | number)[][], head: string[]): HTMLTableElement {
  const t = h('table', `border-collapse:collapse;margin:12px 0;font:600 12px/1.5 Manrope;color:${COLORS.ink2}`);
  const tr = h('tr');
  for (const x of head) tr.appendChild(h('th', `text-align:left;padding:3px 12px 3px 0;color:${COLORS.ink3};font-weight:700`, x));
  t.appendChild(tr);
  for (const r of rows) {
    const row = h('tr');
    for (const x of r) row.appendChild(h('td', 'padding:2px 12px 2px 0;font-variant-numeric:tabular-nums', String(x)));
    t.appendChild(row);
  }
  return t;
}

// ───────────────────────────── track analysis ─────────────────────────────

async function analyseTrack(id: string): Promise<void> {
  const meta = music.catalog.find((t) => t.id === id)!;
  const song = songById(id)!;
  status.textContent = `rendering ${meta.title} in the worker…`;
  let t0 = performance.now();
  const pcm = await music.renderTrack(id, SR, (p) => (status.textContent = `rendering ${meta.title} in the worker… ${(p * 100).toFixed(0)}%`));
  const workerMs = performance.now() - t0;

  status.textContent = 'rendering again on the main thread…';
  await nextFrame();
  t0 = performance.now();
  const job = createTrackJob(song, SR);
  while (!job.step());
  const mainMs = performance.now() - t0;
  const again = job.result();
  const identical = hashPcm(again) === hashPcm(pcm);

  status.textContent = 'measuring kick onsets…';
  await nextFrame();
  const kj = createTrackJob(song, SR, { solo: ['kick'] });
  while (!kj.step());
  const kick = kj.result().channels[0];
  const kickErrMs: Record<number, number | null> = {};
  for (const b of [0, 16, 32, 63]) kickErrMs[b] = onsetErr(kick, beatToFrame(meta.grid.bpm, SR, b * 4), SR);

  const [l, r] = pcm.channels;
  let pk = 0;
  let sl = 0;
  let sr2 = 0;
  for (let i = 0; i < pcm.length; i++) {
    pk = Math.max(pk, Math.abs(l[i]), Math.abs(r[i]));
    sl += l[i];
    sr2 += r[i];
  }
  const sections = meta.sections.map((s) => {
    const f0 = beatToFrame(meta.grid.bpm, SR, s.startBar * 4);
    const f1 = beatToFrame(meta.grid.bpm, SR, (s.startBar + s.bars) * 4);
    let sum = 0;
    let side = 0;
    for (let i = f0; i < f1; i++) {
      const m = (l[i] + r[i]) / 65536;
      const d = (l[i] - r[i]) / 65536;
      sum += m * m;
      side += d * d;
    }
    const b = bandsOf(pcm, f0, f1);
    return {
      kind: s.kind,
      startBar: s.startBar,
      rmsDb: db(Math.sqrt(sum / (f1 - f0))),
      sideDb: db(Math.sqrt(side / (f1 - f0))),
      low: b.low / b.total,
      mid: b.mid / b.total,
      high: b.high / b.total,
    };
  });
  // low end mono: energy below 150 Hz in the side signal vs the mid signal, over the first drop
  const d0 = beatToFrame(meta.grid.bpm, SR, 80);
  const d1 = beatToFrame(meta.grid.bpm, SR, 144);
  const lowSideDb = 10 * Math.log10(bandsOf(pcm, d0, d1, true).low / bandsOf(pcm, d0, d1).low);
  const res: TrackResult = {
    id,
    sampleRate: SR,
    workerMs,
    mainMs,
    identical,
    peakDb: db(pk / 32768),
    prePeakDb: db(job.prePeak),
    limiterDb: db(job.limiterMinGain),
    nonFinite: job.nonFinite,
    dc: [sl / pcm.length / 32768, sr2 / pcm.length / 32768],
    sections,
    kickErrMs,
    mixKickErrMs: onsetErr(l, beatToFrame(meta.grid.bpm, SR, 0), SR),
    lowSideDb,
  };
  store.tracks[id] = res;

  app.appendChild(drawTrack(meta, pcm, res));
  app.appendChild(
    table(
      [
        ['render (worker / main thread)', `${workerMs.toFixed(0)} ms / ${mainMs.toFixed(0)} ms at ${SR} Hz`],
        ['worker = main thread (bit-identical)', identical ? 'yes' : 'NO'],
        ['peak', `${res.peakDb.toFixed(2)} dBFS (into limiter ${res.prePeakDb.toFixed(1)} dBFS, max gain reduction ${(-res.limiterDb).toFixed(1)} dB)`],
        ['NaN / Inf samples', res.nonFinite],
        ['DC offset L / R', `${res.dc[0].toExponential(1)} / ${res.dc[1].toExponential(1)}`],
        ['kick onset error, bars 0 / 16 / 32 / 63', Object.values(kickErrMs).map((v) => (v === null ? 'none' : `${v.toFixed(3)} ms`)).join('  ')],
        ['first kick in the full mix', res.mixKickErrMs === null ? 'none' : `${res.mixKickErrMs.toFixed(3)} ms off`],
        ['side vs mid energy below 150 Hz (drop 1)', `${res.lowSideDb.toFixed(1)} dB`],
      ],
      ['', ''],
    ),
  );
  app.appendChild(
    table(
      sections.map((s) => [s.kind, s.startBar, s.rmsDb.toFixed(1), s.sideDb.toFixed(1), (s.low * 100).toFixed(0) + '%', (s.mid * 100).toFixed(0) + '%', (s.high * 100).toFixed(1) + '%']),
      ['section', 'bar', 'RMS dBFS', 'side RMS', 'low <150', 'mid', 'high >2.5k'],
    ),
  );
  addPlayer(pcm);
  status.textContent = `${meta.title}: done`;
  store.done = true;
}

function addPlayer(p: PcmData): void {
  const b = h('button', `padding:8px 14px;border-radius:8px;border:0;background:${COLORS.violet};color:white;font-weight:800`, 'PLAY');
  let src: AudioBufferSourceNode | null = null;
  b.onclick = () => {
    const ctx = new AudioContext({ sampleRate: p.sampleRate });
    if (src) {
      src.stop();
      src = null;
      b.textContent = 'PLAY';
      return;
    }
    const buf = ctx.createBuffer(2, p.length, p.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      const s = p.channels[c];
      for (let i = 0; i < p.length; i++) d[i] = s[i] / 32768;
    }
    src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start();
    b.textContent = 'STOP';
  };
  app.appendChild(b);
}

// ───────────────────────────── sounds ─────────────────────────────

async function analyseSounds(): Promise<void> {
  status.textContent = 'rendering sounds…';
  const t0 = performance.now();
  const sounds = await music.renderSounds(SR);
  const ms = performance.now() - t0;
  const grid = h('div', 'display:grid;grid-template-columns:repeat(2, 580px);gap:14px');
  app.appendChild(grid);
  const rows: (string | number)[][] = [];
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(sounds) as SoundName[]) {
    const p = sounds[name];
    const [l, r] = p.channels;
    let pk = 0;
    let onset = -1;
    for (let i = 0; i < p.length; i++) {
      const v = Math.max(Math.abs(l[i]), Math.abs(r[i]));
      if (v > pk) pk = v;
      if (onset < 0 && v > 328) onset = i; // -40 dBFS
    }
    // spectral centre over the whole sound
    const pow = new Float64Array(N / 2);
    let num = 0;
    let den = 0;
    for (let at = N / 2; at < p.length + N / 2; at += N / 2) {
      spectrumAt(p, at, pow);
      for (let k = 1; k < N / 2; k++) {
        num += pow[k] * ((k * SR) / N);
        den += pow[k];
      }
    }
    const stats = { durMs: (p.length / SR) * 1000, peakDb: db(pk / 32768), onsetMs: (onset / SR) * 1000, centroidHz: num / den };
    out[name] = stats;
    rows.push([name, stats.durMs.toFixed(0), stats.peakDb.toFixed(1), stats.onsetMs.toFixed(3), stats.centroidHz.toFixed(0)]);
    // picture: waveform over its spectrogram
    const W = 580;
    const H = 150;
    const c = h('canvas', `width:${W}px;height:${H}px;border-radius:10px;background:#08080d`);
    c.width = W;
    c.height = H;
    const g = c.getContext('2d')!;
    const per = p.length / W;
    const img = g.createImageData(W, 80);
    for (let x = 0; x < W; x++) {
      spectrumAt(p, Math.round((x + 0.5) * per), pow);
      for (let y = 0; y < 80; y++) {
        const f = Math.exp(Math.log(16000) - ((Math.log(16000) - Math.log(30)) * y) / 79);
        const k = Math.min(N / 2 - 1, Math.max(1, Math.round((f * N) / SR)));
        const v = Math.max(0, Math.min(1, (10 * Math.log10(pow[k] * NORM + 1e-14) + 90) / 80));
        const o = (y * W + x) * 4;
        img.data[o] = 40 + v * 215;
        img.data[o + 1] = v * v * 200;
        img.data[o + 2] = 60 + v * 140;
        img.data[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 70);
    g.fillStyle = COLORS.cyan;
    for (let x = 0; x < W; x++) {
      let mx = 0;
      for (let i = Math.floor(x * per); i < Math.min(p.length, Math.floor((x + 1) * per)); i++) mx = Math.max(mx, Math.abs(l[i]));
      g.fillRect(x, 38 - (mx / 32768) * 30, 1, (mx / 32768) * 60);
    }
    g.fillStyle = COLORS.ink;
    g.font = font(900, 12, FONT_DISPLAY);
    g.fillText(name.toUpperCase(), 10, 18);
    g.font = font(600, 11);
    g.fillStyle = COLORS.ink2;
    g.fillText(`${stats.durMs.toFixed(0)} ms · peak ${stats.peakDb.toFixed(1)} dBFS · centre ${stats.centroidHz.toFixed(0)} Hz`, 110, 18);
    grid.appendChild(c);
  }
  app.appendChild(table(rows, ['sound', 'duration ms', 'peak dBFS', 'onset ms', 'spectral centre Hz']));
  status.textContent = `all sounds rendered in ${ms.toFixed(0)} ms at ${SR} Hz`;
  store.sounds = out;
  store.done = true;
}

const trackParam = params.get('track');
if (params.get('sounds')) await analyseSounds();
else if (trackParam) await analyseTrack(trackParam);
else status.textContent = 'pick a track';
