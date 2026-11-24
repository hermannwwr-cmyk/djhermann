/**
 * Beat check: after one of the player's own songs is analysed, let them hear (a click on every
 * beat) and see (grid lines over the waveform) whether the detected beat grid is right, and fix
 * it by hand: tap along, ½× / 2×, nudge the grid, move the first beat of the bar.
 *
 * The preview uses deck A of the engine, so it is only opened from the menus, never over a game.
 */
import { ChevronLeft, ChevronRight, Minus, Pause, Play, Plus, RotateCcw } from 'lucide-static';
import { clamp, fract } from '../../core/math';
import { BEATS_PER_BAR } from '../../core/types';
import type { AppContext, BeatGrid, LoadedTrack, TrackMeta } from '../../core/types';
import { COLORS, fitCanvas, font, rgba } from '../../theme/theme';
import { add, button, h, holdRepeat, icon } from './dom';
import {
  adjustBpm,
  canScaleGrid,
  confidenceInfo,
  formatBpm,
  gridFromTaps,
  nudgeGrid,
  sameGrid,
  scaleGrid,
  shiftDownbeat,
} from './logic';
import { buzz, playUi } from './shared';
import { onFrame } from './ticker';
import { cover, openSheet, toast } from './ui';

export interface BeatCheckOptions {
  /** shown in the title when several new songs are checked in a row: "1 of 3" */
  position?: { index: number; total: number };
}

export type BeatCheckResult = 'saved' | 'kept' | 'closed';

const PX_PER_SEC = 96;
/** how far ahead of the heard position clicks are handed to the engine, on top of its latency */
const LOOKAHEAD_SEC = 0.14;
const TAP_RESET_MS = 2500;

export function openBeatCheck(
  ctx: AppContext,
  host: HTMLElement,
  trackId: string,
  opts: BeatCheckOptions = {},
): Promise<BeatCheckResult> {
  const { engine, library, settings } = ctx;
  const meta0 = library.get(trackId);
  if (!meta0) return Promise.resolve('closed');
  const meta: TrackMeta = meta0;

  const original: BeatGrid = { ...meta.grid };
  const detectedBpm = original.bpm;
  let draft: BeatGrid = { ...original };
  let loaded: LoadedTrack | null = null;
  let playing = false;
  let result: BeatCheckResult = 'closed';
  let lastClickSec = -Infinity; // track time of the last click handed to the engine
  let lastPos = 0;
  let taps: number[] = [];
  let lastTapMs = 0;
  let destroyed = false;
  let mixerBefore: { crossfader: number; fader: number } | null = null;

  const more = opts.position && opts.position.index + 1 < opts.position.total;
  const sheet = openSheet(host, {
    title: opts.position && opts.position.total > 1 ? `Beat check ${opts.position.index + 1} of ${opts.position.total}` : 'Beat check',
    className: 'sc-bc',
    tall: true,
  });
  sheet.el.dataset.sheet = 'beatcheck';

  // ── what it is ──
  const head = h(
    'div',
    'sc-bc__track',
    cover(meta, 48),
    h('div', 'sc-bc__names', h('div', 'sc-bc__title', meta.title), h('div', 'sc-bc__ask', 'Do the clicks land on the beat?')),
  );

  // ── see it: waveform with the grid ──
  const canvas = h('canvas', 'sc-bc__wave ui-touch');
  canvas.setAttribute('aria-hidden', 'true');
  const status = h('div', 'sc-bc__status', 'Getting your song ready');
  const waveBox = h('div', 'sc-bc__wavebox', canvas, status);

  // ── hear it ──
  const listenIcon = h('span', 'sc-bc__listenicon', icon(Play, 'sc-fillicon'));
  const listenLabel = h('span', null, 'LISTEN');
  const listen = h('button', 'ui-btn ui-btn--lg sc-bc__listen', listenIcon, listenLabel);
  listen.type = 'button';
  listen.dataset.act = 'listen';
  listen.disabled = true;
  const lamp = h('span', 'sc-bc__lamp');
  const listenRow = h('div', 'sc-bc__listenrow', listen, h('div', 'sc-bc__lampbox', lamp, h('span', 'sc-bc__lamplabel', 'BEAT')));

  // ── the number ──
  const bpmValue = h('span', 'sc-bc__bpm ui-num');
  const bpmDown = button({ className: 'ui-iconbtn', icon: Minus, ariaLabel: 'Tempo down a little' });
  const bpmUp = button({ className: 'ui-iconbtn', icon: Plus, ariaLabel: 'Tempo up a little' });
  bpmDown.dataset.act = 'bpm-';
  bpmUp.dataset.act = 'bpm+';
  const conf = confidenceInfo(meta.gridConfidence);
  const meter = h('span', `sc-bc__meter sc-bc__meter--${conf.level}`);
  for (let i = 1; i <= 4; i++) meter.appendChild(h('i', i <= conf.level ? 'on' : null));
  const confLine = h('div', 'sc-bc__conf');
  const tempoBox = h(
    'div',
    'sc-bc__tempo',
    h('div', 'sc-bc__bpmrow', bpmDown, h('div', 'sc-bc__bpmbox', bpmValue, h('span', 'sc-bc__bpmunit', 'BPM')), bpmUp),
    confLine,
  );

  // ── fix it ──
  const half = button({ className: 'ui-btn sc-bc__scale', label: '½×', ariaLabel: 'Half the tempo' });
  const dbl = button({ className: 'ui-btn sc-bc__scale', label: '2×', ariaLabel: 'Double the tempo' });
  half.dataset.act = 'half';
  dbl.dataset.act = 'double';
  const tapHint = h('span', 'sc-bc__taphint', 'tap along');
  const tap = h('button', 'sc-bc__tap ui-touch', h('span', 'sc-bc__taplabel', 'TAP'), tapHint);
  tap.type = 'button';
  tap.dataset.act = 'tap';
  const fixRow = h('div', 'sc-bc__fix', half, tap, dbl);

  const earlier = button({ className: 'ui-btn sc-bc__nudge ui-touch', icon: ChevronLeft, ariaLabel: 'Move the clicks earlier' });
  const later = button({ className: 'ui-btn sc-bc__nudge ui-touch', icon: ChevronRight, ariaLabel: 'Move the clicks later' });
  earlier.dataset.act = 'nudge-';
  later.dataset.act = 'nudge+';
  const nudgeValue = h('div', 'sc-bc__nudgevalue ui-num');
  const nudgeRow = h(
    'div',
    'sc-bc__nudgerow',
    earlier,
    h('div', 'sc-bc__nudgetext', h('div', 'sc-bc__nudgetitle', 'Clicks early or late? Nudge them'), nudgeValue),
    later,
  );
  const oneBtn = button({ className: 'sc-chipbtn', label: 'Move the 1', iconAfter: ChevronRight });
  oneBtn.dataset.act = 'downbeat';
  const oneRow = h('div', 'sc-bc__one', h('span', null, 'The high click should be the first beat of each bar.'), oneBtn);

  add(sheet.body, head, waveBox, listenRow, tempoBox, fixRow, nudgeRow, oneRow);

  // ── footer ──
  const reset = button({ className: 'ui-btn ui-btn--ghost', icon: RotateCcw, label: 'Reset' });
  reset.dataset.act = 'reset';
  const saveLabel = h('span', null, '');
  const save = h('button', 'ui-btn ui-btn--primary', saveLabel);
  save.type = 'button';
  save.dataset.act = 'save';
  add(sheet.foot, reset, save);

  // ───────────── state → screen ─────────────

  function render(): void {
    const changed = !sameGrid(draft, original);
    bpmValue.textContent = formatBpm(draft.bpm);
    half.disabled = !canScaleGrid(draft, 0.5);
    dbl.disabled = !canScaleGrid(draft, 2);
    reset.disabled = !changed;
    saveLabel.textContent = changed ? (more ? 'SAVE & NEXT' : 'SAVE') : more ? 'SOUNDS RIGHT, NEXT' : 'SOUNDS RIGHT';
    const movedMs = Math.round((draft.firstBeatSec - original.firstBeatSec) * 1000);
    const beatMs = 60000 / draft.bpm;
    const wholeBeats = Math.round(movedMs / beatMs);
    const fineMs = Math.round(movedMs - wholeBeats * beatMs);
    nudgeValue.textContent = fineMs === 0 ? 'Not moved' : `${Math.abs(fineMs)} ms ${fineMs > 0 ? 'later' : 'earlier'}`;
    confLine.replaceChildren(
      ...(changed
        ? [h('span', null, `Set by you · we heard ${formatBpm(detectedBpm)}`)]
        : [meter, h('span', null, h('b', null, conf.label), ` · ${conf.advice}`)]),
    );
  }

  function setDraft(next: BeatGrid): void {
    if (sameGrid(next, draft)) return;
    draft = next;
    // clicks already handed to the engine cannot be taken back: skip the ones inside that window
    const d = engine.getDeck('A');
    lastClickSec = d.positionSec + (LOOKAHEAD_SEC + engine.getLatency()) * Math.max(0, d.rate);
    render();
  }

  // ───────────── preview: the track on deck A, a click on every beat ─────────────

  function setPlaying(on: boolean): void {
    playing = on;
    listen.classList.toggle('sc-bc__listen--on', on);
    listenLabel.textContent = on ? 'STOP' : 'LISTEN';
    listenIcon.replaceChildren(icon(on ? Pause : Play, 'sc-fillicon'));
  }

  async function startPreview(): Promise<boolean> {
    if (!loaded || destroyed) return false;
    try {
      await engine.unlock();
    } catch (err) {
      console.error('[beatcheck] audio would not start', err);
      toast(host, 'The sound did not start. Tap LISTEN again.', 'bad');
      return false;
    }
    if (destroyed) return false;
    const d = engine.getDeck('A');
    if (d.positionSec >= d.durationSec - 1) engine.seek('A', draft.firstBeatSec);
    lastClickSec = engine.getDeck('A').positionSec - 0.001;
    engine.play('A');
    setPlaying(true);
    return true;
  }

  function stopPreview(): void {
    engine.pause('A');
    setPlaying(false);
  }

  /** Hand the engine every click that falls inside the look-ahead window. */
  function scheduleClicks(pos: number, rate: number): void {
    if (rate < 0.2) return;
    const latency = engine.getLatency();
    const now = engine.ctxTime();
    const beatLen = 60 / draft.bpm;
    const horizon = LOOKAHEAD_SEC + latency;
    let k = Math.ceil((Math.max(pos, lastClickSec + beatLen * 0.25) - draft.firstBeatSec) / beatLen - 1e-6);
    for (let guard = 0; guard < 8; guard++, k++) {
      const t = draft.firstBeatSec + k * beatLen;
      const heardIn = (t - pos) / rate; // seconds until this beat of the track is heard
      if (heardIn > horizon) break;
      // a beat that is due right now (the preview starts on one) still clicks, a hair late
      if (heardIn >= -0.01) {
        const downbeat = ((k % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR === 0;
        playUi(engine, downbeat ? 'tick' : 'tock', downbeat ? 0.9 : 0.6, Math.max(now, now + heardIn - latency));
      }
      lastClickSec = t;
    }
  }

  // ───────────── drawing ─────────────

  let w = 0;
  let hgt = 0;
  const ro = new ResizeObserver(() => {
    w = canvas.clientWidth;
    hgt = canvas.clientHeight;
  });
  ro.observe(canvas);

  function draw(pos: number, moving: boolean): void {
    if (!w || !hgt) return;
    const g = fitCanvas(canvas, w, hgt);
    g.clearRect(0, 0, w, hgt);
    const mid = hgt / 2;
    const cx = w / 2;
    const wave = loaded?.waveform;
    if (wave) {
      const maxH = hgt * 0.46;
      for (let x = 0; x < w; x += 2) {
        const t = pos + (x - cx) / PX_PER_SEC;
        if (t < 0 || t > meta.durationSec) continue;
        const i = Math.min(wave.length - 1, Math.floor(t * wave.rate));
        const lo = wave.low[i] / 255;
        const mi = wave.mid[i] / 255;
        const hi = wave.high[i] / 255;
        const played = x < cx;
        g.globalAlpha = played ? 0.45 : 1;
        g.fillStyle = COLORS.violet;
        let a = Math.max(1, mi * maxH * 0.8);
        g.fillRect(x, mid - a, 1.5, a * 2);
        g.fillStyle = COLORS.cyan;
        a = Math.max(1, lo * maxH);
        g.fillRect(x, mid - a, 1.5, a * 2);
        g.fillStyle = '#ffffff';
        a = hi * maxH * 0.45;
        if (a > 0.5) g.fillRect(x, mid - a, 1.5, a * 2);
      }
      g.globalAlpha = 1;
    }
    // the grid
    const beatLen = 60 / draft.bpm;
    const first = Math.ceil((pos - cx / PX_PER_SEC - draft.firstBeatSec) / beatLen);
    const last = Math.floor((pos + cx / PX_PER_SEC - draft.firstBeatSec) / beatLen);
    g.textAlign = 'left';
    g.textBaseline = 'top';
    g.font = font(800, 10);
    for (let k = first; k <= last; k++) {
      const t = draft.firstBeatSec + k * beatLen;
      if (t < -0.001) continue;
      const x = Math.round(cx + (t - pos) * PX_PER_SEC);
      const beatInBar = ((k % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR;
      if (beatInBar === 0) {
        g.fillStyle = COLORS.pink;
        g.fillRect(x - 1, 0, 2, hgt);
        g.fillText('1', x + 5, 4);
      } else {
        g.fillStyle = rgba(COLORS.ink, 0.55);
        g.fillRect(x, hgt * 0.14, 1, hgt * 0.72);
        g.fillStyle = rgba(COLORS.ink, 0.5);
        g.fillText(String(beatInBar + 1), x + 4, 4);
      }
    }
    // the playhead: what you hear right now
    g.fillStyle = COLORS.ink;
    g.fillRect(cx - 1, 0, 2, hgt);
    g.beginPath();
    g.moveTo(cx - 6, 0);
    g.lineTo(cx + 6, 0);
    g.lineTo(cx, 8);
    g.closePath();
    g.fill();

    // the lamp follows the heard beat
    const phase = fract((pos - draft.firstBeatSec) / beatLen);
    const pulse = moving ? Math.pow(1 - phase, 3) : 0;
    const bar = Math.floor((pos - draft.firstBeatSec) / beatLen);
    lamp.style.opacity = String(0.18 + 0.82 * pulse);
    lamp.classList.toggle('sc-bc__lamp--one', ((bar % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR === 0);
  }

  const offFrame = onFrame(() => {
    if (destroyed) return;
    const d = engine.getDeck('A');
    const pos = loaded ? d.positionSec : draft.firstBeatSec;
    if (loaded && playing) {
      if (!d.playing && !d.scratching) {
        setPlaying(false); // ran off the end
      } else {
        if (pos < lastPos - 0.05 || pos > lastPos + 1) lastClickSec = pos - 0.001; // a jump: start afresh
        scheduleClicks(pos, d.rate);
      }
    }
    lastPos = pos;
    draw(pos, playing && d.rate > 0.2);
  });

  // ───────────── controls ─────────────

  listen.addEventListener('click', () => {
    if (playing) stopPreview();
    else void startPreview();
  });

  half.addEventListener('click', () => setDraft(scaleGrid(draft, 0.5)));
  dbl.addEventListener('click', () => setDraft(scaleGrid(draft, 2)));
  holdRepeat(bpmDown, () => setDraft(adjustBpm(draft, -0.1)));
  holdRepeat(bpmUp, () => setDraft(adjustBpm(draft, 0.1)));
  holdRepeat(earlier, (n) => setDraft(nudgeGrid(draft, n > 12 ? -0.01 : -0.005)));
  holdRepeat(later, (n) => setDraft(nudgeGrid(draft, n > 12 ? 0.01 : 0.005)));
  oneBtn.addEventListener('click', () => setDraft(shiftDownbeat(draft, 1, original.firstBeatSec)));
  reset.addEventListener('click', () => {
    taps = [];
    tapHint.textContent = 'tap along';
    setDraft({ ...original });
  });

  // tap along: needs the music running, so the first tap starts it
  tap.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    tap.classList.remove('sc-bc__tap--hit');
    void tap.offsetWidth;
    tap.classList.add('sc-bc__tap--hit');
    buzz(settings, 6);
    if (!loaded) return;
    if (!playing) {
      taps = [];
      tapHint.textContent = 'now tap the beat';
      void startPreview();
      return;
    }
    if (e.timeStamp - lastTapMs > TAP_RESET_MS) taps = [];
    lastTapMs = e.timeStamp;
    taps.push(engine.positionAt('A', e.timeStamp));
    if (taps.length > 16) taps.shift();
    if (taps.length < 4) {
      tapHint.textContent = `${4 - taps.length} more`;
      return;
    }
    const next = gridFromTaps(taps, draft, detectedBpm);
    if (next) {
      tapHint.textContent = 'keep going';
      setDraft(next);
    } else {
      tapHint.textContent = 'steady taps, please';
    }
  });
  tap.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') e.preventDefault();
  });

  // drag the waveform to move through the song
  let dragId = -1;
  let dragX = 0;
  canvas.addEventListener('pointerdown', (e) => {
    if (!loaded) return;
    dragId = e.pointerId;
    dragX = e.clientX;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic event */
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== dragId || !loaded) return;
    const dx = e.clientX - dragX;
    dragX = e.clientX;
    const d = engine.getDeck('A');
    engine.seek('A', clamp(d.positionSec - dx / PX_PER_SEC, 0, Math.max(0, meta.durationSec - 0.5)));
  });
  const endDrag = (e: PointerEvent): void => {
    if (e.pointerId === dragId) dragId = -1;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  save.addEventListener('click', () => {
    void (async () => {
      if (sameGrid(draft, original)) {
        result = 'kept';
        await sheet.close();
        return;
      }
      save.disabled = true;
      try {
        await library.setGrid(trackId, draft);
        result = 'saved';
        toast(host, 'Beat grid saved', 'good');
        await sheet.close();
      } catch (err) {
        console.error('[beatcheck] could not save the grid', err);
        save.disabled = false;
        toast(host, 'Could not save that. Try again.', 'bad');
      }
    })();
  });

  // ───────────── load, then tidy up when the sheet goes ─────────────

  void (async () => {
    try {
      const track = await library.load(trackId, (p, stage) => {
        status.textContent = `${stage ?? 'Getting your song ready'} · ${Math.round(p * 100)}%`;
      });
      if (destroyed) return;
      const mixer = engine.getMixer();
      mixerBefore = { crossfader: mixer.crossfader, fader: mixer.channels.A.fader };
      await engine.loadTrack('A', track);
      if (destroyed) {
        engine.eject('A');
        return;
      }
      engine.setCrossfader(-1);
      engine.setFader('A', 1);
      engine.setTempo('A', 1);
      loaded = track;
      status.textContent = 'Drag the picture to move through the song';
      status.classList.add('sc-bc__status--hint');
      listen.disabled = false;
    } catch (err) {
      console.error('[beatcheck] could not load the track', err);
      if (!destroyed) status.textContent = 'This song could not be opened for a listen.';
    }
  })();

  render();

  return sheet.closed.then(() => {
    destroyed = true;
    offFrame();
    ro.disconnect();
    if (loaded) {
      engine.pause('A');
      engine.eject('A');
    }
    if (mixerBefore) {
      engine.setCrossfader(mixerBefore.crossfader);
      engine.setFader('A', mixerBefore.fader);
    }
    return result;
  });
}
