/**
 * Sound delay calibration. A steady click plays (a high "tick" on the first beat of every bar, a
 * "tock" between); the player taps the big pad along with it. The game takes the median of
 * (tap − click) over the taps after a short warm-up as the delay, says how steady the taps were,
 * offers a quick check (the pad flashes in time using the new value) and saves it.
 *
 * Nothing flashes while the player is being measured: the taps must follow the ears, not the eyes.
 */
import { Check, Headphones, Play, RotateCcw, Square, Timer } from 'lucide-static';
import { BEATS_PER_BAR } from '../../core/types';
import type { AppContext, Screen } from '../../core/types';
import { add, button, h, icon } from './dom';
import { analyseTaps, clampLatencyMs } from './logic';
import type { TapAnalysis, TapQuality } from './logic';
import { buzz, playUi } from './shared';
import { onFrame } from './ticker';
import { dismissTopLayer, toast, topBar } from './ui';

/** 100 BPM: slow enough to be easy, fast enough to keep a steady pulse. */
const PERIOD_SEC = 0.6;
/** clicks are handed to the engine this far ahead */
const LOOKAHEAD_SEC = 0.3;
const WARMUP_TAPS = 4;
const MEASURED_TAPS = 12;
const TOTAL_TAPS = WARMUP_TAPS + MEASURED_TAPS;
/** taps further apart than this mean the player stopped: nudge them */
const IDLE_HINT_MS = 4000;

type State = 'intro' | 'run' | 'result';

const QUALITY_COPY: Record<TapQuality, { label: string; line: string }> = {
  steady: { label: 'Rock steady', line: 'Your taps were very even. This value is solid.' },
  good: { label: 'Nice and even', line: 'Good taps. This value will feel right.' },
  uneven: { label: 'A bit uneven', line: 'Usable, but another go may get a better value.' },
  poor: { label: 'All over the place', line: 'The taps were too uneven to trust. Try again with headphones on.' },
};

export function createCalibrateScreen(ctx: AppContext): Screen<undefined> {
  const { nav, settings, engine } = ctx;
  const el = h('div', 'sc-screen sc-cal');

  // ── why ──
  const why = h(
    'p',
    'sc-cal__why',
    icon(Headphones),
    h('span', null, 'Bluetooth headphones and some phones play sound late. Tap along and the game will line itself up.'),
  );

  // ── the pad, with a ring of tap lights around it ──
  const lights = h('div', 'sc-cal__lights');
  for (let i = 0; i < TOTAL_TAPS; i++) {
    const led = h('i', i < WARMUP_TAPS ? 'sc-cal__led sc-cal__led--warm' : 'sc-cal__led');
    led.style.setProperty('--a', `${(i / TOTAL_TAPS) * 360}deg`);
    lights.appendChild(led);
  }
  const padIcon = h('span', 'sc-cal__padicon', icon(Play, 'sc-fillicon'));
  const padLabel = h('span', 'sc-cal__padlabel', 'START');
  const padSub = h('span', 'sc-cal__padsub', '');
  const ripple = h('span', 'sc-cal__ripple');
  const flash = h('span', 'sc-cal__flash');
  const pad = h('button', 'sc-cal__pad ui-touch', flash, ripple, padIcon, padLabel, padSub);
  pad.type = 'button';
  pad.dataset.act = 'pad';
  const stage = h('div', 'sc-cal__stage', lights, pad);

  const status = h('p', 'sc-cal__status');
  status.setAttribute('aria-live', 'polite');

  // ── the result ──
  const resValue = h('span', 'sc-cal__ms ui-num');
  const resQuality = h('div', 'sc-cal__quality');
  const resLine = h('p', 'sc-cal__line');
  const plotDots = h('div', 'sc-cal__dots');
  const plot = h(
    'div',
    'sc-cal__plot',
    h('span', 'sc-cal__axis'),
    plotDots,
    h('span', 'sc-cal__plotlabel sc-cal__plotlabel--l', 'early'),
    h('span', 'sc-cal__plotlabel sc-cal__plotlabel--r', 'late'),
  );
  const checkBtn = button({ className: 'sc-chipbtn', icon: Play, label: 'Check it' });
  checkBtn.dataset.act = 'check';
  const checkNote = h('p', 'sc-cal__checknote', 'The pad flashes using the new value. Flash and click should feel like one.');
  const result = h(
    'div',
    'sc-cal__result',
    h('div', 'sc-cal__reshead', h('span', 'sc-h', 'Your sound delay'), resQuality),
    h('div', 'sc-cal__valrow', resValue, h('span', 'sc-cal__unit', 'ms')),
    resLine,
    plot,
    h('div', 'sc-cal__checkrow', checkBtn, checkNote),
  );

  const body = h('div', 'sc-body ui-scroll sc-cal__body', why, stage, status, result);

  // ── current value + actions ──
  const nowValue = h('b', 'ui-num');
  const autoBtn = button({ className: 'sc-link', icon: RotateCcw, label: 'Reset to auto' });
  autoBtn.dataset.act = 'auto';
  const nowLine = h('div', 'sc-cal__now', icon(Timer), h('span', null, 'In use: ', nowValue), autoBtn);

  const primaryLabel = h('span', null, 'START');
  const primaryIcon = h('span', 'sc-cal__btnicon', icon(Play, 'sc-fillicon'));
  const primary = h('button', 'ui-btn ui-btn--primary ui-btn--lg', primaryIcon, primaryLabel);
  primary.type = 'button';
  primary.dataset.act = 'primary';
  const again = button({ className: 'ui-btn ui-btn--lg sc-cal__again', icon: RotateCcw, label: 'Again' });
  again.dataset.act = 'again';
  const actions = h('div', 'sc-cal__actions', again, primary);
  const foot = h('footer', 'sc-foot', nowLine, actions);

  add(el, topBar('Sound delay', () => nav.back()), body, foot);

  // ───────────── state ─────────────

  let state: State = 'intro';
  let off: (() => void) | null = null;
  let firstClick = 0;
  let nextClick = 0;
  let clickIndex = 0;
  let taps: number[] = [];
  let lastTapMs = 0;
  let analysis: TapAnalysis | null = null;
  let checking = false;
  /** performance.now() times at which the quick check flashes the pad */
  const flashes: { at: number; one: boolean }[] = [];
  let savedFlash = 0;

  const value = (): number | null => (analysis ? clampLatencyMs(analysis.latencyMs) : null);

  function syncNow(): void {
    const ms = settings.get().latencyMs;
    nowValue.textContent = ms === null ? `Auto · ${Math.round(engine.getAutoLatencyMs())} ms` : `${Math.round(ms)} ms (set by you)`;
    autoBtn.hidden = ms === null;
  }

  function setPrimary(label: string, svg: string, disabled = false): void {
    primaryLabel.textContent = label;
    primaryIcon.replaceChildren(icon(svg, svg === Play || svg === Square ? 'sc-fillicon' : ''));
    primary.disabled = disabled;
  }

  function render(): void {
    el.dataset.state = state;
    el.classList.toggle('sc-cal--checking', checking);
    const n = taps.length;
    lights.querySelectorAll('.sc-cal__led').forEach((led, i) => led.classList.toggle('on', i < n));
    result.hidden = state !== 'result';
    again.hidden = state !== 'result';
    stage.classList.toggle('sc-cal__stage--small', state === 'result');

    if (state === 'intro') {
      padIcon.hidden = false;
      padLabel.textContent = 'START';
      padSub.textContent = '';
      status.replaceChildren(h('b', null, 'Put your headphones on'), ', press START, then tap the pad on every click.');
      setPrimary('START', Play);
    } else if (state === 'run') {
      padIcon.hidden = true;
      padLabel.textContent = 'TAP';
      padSub.textContent = n < WARMUP_TAPS ? 'on every click' : `${TOTAL_TAPS - n} to go`;
      status.replaceChildren(
        n === 0
          ? 'Listen for the click, then tap the pad on every one.'
          : n < WARMUP_TAPS
            ? 'Good. Keep going, nice and steady.'
            : 'Keep tapping. Close your eyes if it helps.',
      );
      setPrimary('STOP', Square);
    } else {
      padIcon.hidden = true;
      padLabel.textContent = checking ? 'LISTEN' : 'DONE';
      padSub.textContent = checking ? 'and watch' : '';
      const v = value();
      const ok = !!analysis && analysis.quality !== 'poor';
      if (analysis && v !== null) {
        resValue.textContent = String(v);
        const q = QUALITY_COPY[analysis.quality];
        resQuality.className = `sc-cal__quality sc-cal__quality--${analysis.quality}`;
        resQuality.replaceChildren(h('i', null), q.label, h('span', 'ui-num', ` · ±${Math.round(analysis.spreadMs)} ms`));
        resLine.textContent = q.line;
        plotDots.replaceChildren(
          ...analysis.offsetsMs.map((o) => {
            const d = h('i', 'sc-cal__dot');
            const rel = Math.max(-1, Math.min(1, (o - analysis!.latencyMs) / 80));
            d.style.left = `${50 + rel * 50}%`;
            return d;
          }),
        );
        status.replaceChildren(ok ? 'Done. Check it, then save it.' : 'Those taps were too uneven. Have another go.');
      } else {
        resValue.textContent = '–';
        resQuality.className = 'sc-cal__quality sc-cal__quality--poor';
        resQuality.replaceChildren(h('i', null), 'Not enough taps');
        resLine.textContent = 'Tap the pad on every click until all the lights are on.';
        plotDots.replaceChildren();
        status.replaceChildren('Have another go.');
      }
      checkBtn.disabled = !ok;
      checkBtn.replaceChildren(icon(checking ? Square : Play), h('span', null, checking ? 'Stop check' : 'Check it'));
      checkNote.hidden = !checking;
      if (savedFlash > performance.now()) setPrimary('SAVED', Check, true);
      else setPrimary(ok ? 'SAVE' : 'TRY AGAIN', ok ? Check : RotateCcw);
    }
  }

  // ───────────── the click ─────────────

  function startClicks(): void {
    stopClicks();
    firstClick = engine.ctxTime() + 0.45;
    nextClick = firstClick;
    clickIndex = 0;
    el.dataset.firstClick = firstClick.toFixed(4);
    el.dataset.period = String(PERIOD_SEC);
    off = onFrame((now) => tick(now));
  }

  function stopClicks(): void {
    off?.();
    off = null;
    flashes.length = 0;
  }

  function tick(nowMs: number): void {
    const now = engine.ctxTime();
    // the clock behind an iOS tab can jump: never try to catch up with a burst of clicks
    if (nextClick < now - 0.05) {
      const skip = Math.ceil((now - nextClick) / PERIOD_SEC);
      nextClick += skip * PERIOD_SEC;
      clickIndex += skip;
    }
    while (nextClick < now + LOOKAHEAD_SEC) {
      const one = clickIndex % BEATS_PER_BAR === 0;
      playUi(engine, one ? 'tick' : 'tock', one ? 0.95 : 0.7, nextClick);
      if (checking && analysis) {
        // heard at nextClick + delay: flash then
        const at = nowMs + (nextClick + (value() ?? 0) / 1000 - now) * 1000;
        flashes.push({ at, one });
      }
      nextClick += PERIOD_SEC;
      clickIndex++;
    }
    while (flashes.length > 0 && flashes[0].at <= nowMs + 8) {
      const f = flashes.shift()!;
      flash.classList.remove('sc-cal__flash--on', 'sc-cal__flash--one');
      void flash.offsetWidth;
      flash.classList.add('sc-cal__flash--on');
      if (f.one) flash.classList.add('sc-cal__flash--one');
    }
    if (state === 'run' && taps.length > 0 && performance.now() - lastTapMs > IDLE_HINT_MS) {
      status.replaceChildren(h('b', null, 'Still there?'), ' Tap the pad every time you hear a click.');
    }
  }

  async function begin(): Promise<void> {
    try {
      await engine.unlock();
    } catch (err) {
      console.error('[calibrate] audio would not start', err);
      toast(el, 'The sound did not start. Tap START again.', 'bad');
      return;
    }
    taps = [];
    analysis = null;
    checking = false;
    state = 'run';
    lastTapMs = performance.now();
    startClicks();
    render();
  }

  function finish(): void {
    analysis = analyseTaps(taps, firstClick, PERIOD_SEC, { warmup: WARMUP_TAPS });
    state = 'result';
    checking = false;
    stopClicks();
    render();
    if (analysis && analysis.quality !== 'poor') playUi(engine, 'success', 0.5);
  }

  function reset(): void {
    stopClicks();
    state = 'intro';
    taps = [];
    analysis = null;
    checking = false;
    render();
  }

  function onTap(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    ripple.classList.remove('sc-cal__ripple--on');
    void ripple.offsetWidth;
    ripple.classList.add('sc-cal__ripple--on');
    if (state === 'intro') {
      void begin();
      return;
    }
    if (state !== 'run') {
      if (analysis && analysis.quality !== 'poor') toggleCheck();
      return;
    }
    const t = engine.perfToCtx(e.timeStamp);
    // taps before the first click can only be the player getting ready
    if (t < firstClick - PERIOD_SEC * 0.3) return;
    buzz(settings, 8);
    taps.push(t);
    lastTapMs = performance.now();
    if (taps.length >= TOTAL_TAPS) finish();
    else render();
  }

  function toggleCheck(): void {
    if (!analysis || analysis.quality === 'poor') return;
    checking = !checking;
    if (checking) startClicks();
    else stopClicks();
    render();
  }

  pad.addEventListener('pointerdown', onTap);
  pad.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    if (!e.repeat) onTap(new PointerEvent('pointerdown', { pointerType: 'keyboard' }));
  });
  checkBtn.addEventListener('click', toggleCheck);
  again.addEventListener('click', () => void begin());
  autoBtn.addEventListener('click', () => {
    settings.set({ latencyMs: null });
    engine.setLatencyMs(null);
    syncNow();
    toast(el, 'Back to automatic', 'good');
  });

  primary.addEventListener('click', () => {
    if (state === 'intro') void begin();
    else if (state === 'run') reset();
    else {
      const v = value();
      if (v === null || !analysis || analysis.quality === 'poor') {
        void begin();
        return;
      }
      settings.set({ latencyMs: v });
      engine.setLatencyMs(v);
      checking = false;
      stopClicks();
      savedFlash = performance.now() + 1400;
      syncNow();
      render();
      buzz(settings, [10, 40, 18]);
      toast(el, `Saved: ${v} ms`, 'good');
      window.setTimeout(() => {
        if (nav.current === 'calibrate' && state === 'result') render();
      }, 1450);
    }
  });

  render();

  return {
    el,
    enter() {
      reset();
      syncNow();
      body.scrollTop = 0;
    },
    leave() {
      stopClicks();
      checking = false;
    },
    back: () => dismissTopLayer(el),
  };
}
