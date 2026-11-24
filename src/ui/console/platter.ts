/**
 * The platter: a record that turns exactly with the audio. The top of the record scratches,
 * the knurled outer ring bends the pitch, as on a digital turntable.
 */
import type { AudioEngine, DeckId, FrameState, TrackMeta } from '../../core/types';
import { damp } from '../../core/math';
import { canvasDpr, deckColor, drawGlow, fitCanvas, rgba } from '../../theme/theme';
import type { Ctl, CtlEnv } from './controls';
import { bindDrag, h } from './gestures';
import { HUB_RADIUS, RING_INNER, TAU, angleDelta, angleToSec, platterAngle, platterZone, ringNudge } from './logic';
import { buildDisc, buildSheen } from './platter-art';

export interface PlatterEnv extends CtlEnv {
  engine: AudioEngine;
  lowFx(): boolean;
}

export function createPlatter(env: PlatterEnv, deck: DeckId): Ctl {
  const color = deckColor(deck);
  const canvas = h('canvas', 'dk-platter-canvas');
  const el = h('div', 'dk-platter ui-touch', { 'data-control': `${deck}.platter` }, canvas);

  let size = 0;
  let disc: HTMLCanvasElement | null = null;
  let sheen: HTMLCanvasElement | null = null;
  let builtFor: TrackMeta | null | undefined;
  let builtSize = 0;
  let dirty = true;
  let lastAngle = NaN;
  let lastFlags = -1;

  // touch state
  let mode: 'none' | 'top' | 'ring' = 'none';
  let cx = 0;
  let cy = 0;
  let radius = 1;
  let fingerX = 0;
  let fingerY = 0;
  let prevAngle: number | null = null;
  let prevT = 0;
  let ringVel = 0; // revolutions per second, smoothed
  let lastRingMove = 0;
  let sentNudge = 0;

  const ro = new ResizeObserver(() => {
    const s = Math.floor(Math.min(el.clientWidth, el.clientHeight));
    if (s !== size) {
      size = s;
      dirty = true;
    }
  });
  ro.observe(el);

  const nudge = (amount: number): void => {
    const a = Math.abs(amount) < 0.02 ? 0 : amount;
    if (a === sentNudge) return;
    sentNudge = a;
    env.engine.setNudge(deck, a);
  };

  const unbind = bindDrag(el, {
    start(e) {
      const r = el.getBoundingClientRect();
      radius = Math.min(r.width, r.height) / 2;
      cx = r.left + r.width / 2;
      cy = r.top + r.height / 2;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      const zone = platterZone(Math.hypot(dx, dy), radius);
      if (zone === 'outside') return false;
      mode = zone;
      fingerX = dx;
      fingerY = dy;
      prevAngle = Math.atan2(dy, dx);
      prevT = e.timeStamp;
      if (mode === 'top') {
        env.engine.scratchStart(deck);
      } else {
        ringVel = 0;
        lastRingMove = performance.now();
      }
      env.haptic(6);
      el.classList.add(mode === 'top' ? 'dk-held-top' : 'dk-held-ring');
      return true;
    },
    move(e) {
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      fingerX = dx;
      fingerY = dy;
      // too close to the spindle the angle is meaningless: wait until the finger comes back out
      if (Math.hypot(dx, dy) < radius * HUB_RADIUS) {
        prevAngle = null;
        return;
      }
      const a = Math.atan2(dy, dx);
      if (prevAngle === null) {
        prevAngle = a;
        prevT = e.timeStamp;
        return;
      }
      const d = angleDelta(prevAngle, a);
      const dt = Math.max(0.004, (e.timeStamp - prevT) / 1000);
      prevAngle = a;
      prevT = e.timeStamp;
      if (mode === 'top') {
        if (d !== 0) env.engine.scratchMove(deck, angleToSec(d));
      } else if (mode === 'ring') {
        const inst = d / TAU / dt;
        ringVel += (inst - ringVel) * (1 - Math.exp(-dt / 0.07));
        lastRingMove = performance.now();
        nudge(ringNudge(ringVel));
      }
    },
    end() {
      if (mode === 'top') env.engine.scratchEnd(deck);
      else if (mode === 'ring') {
        ringVel = 0;
        sentNudge = 0;
        env.engine.setNudge(deck, 0);
      }
      el.classList.remove('dk-held-top', 'dk-held-ring');
      mode = 'none';
    },
  });

  function rebuild(track: TrackMeta | null): void {
    const dpr = canvasDpr();
    disc = buildDisc(size * dpr, deck, color, track);
    sheen = buildSheen(size * dpr, color, track !== null);
    builtFor = track;
    builtSize = size;
    dirty = false;
    lastAngle = NaN;
  }

  return {
    el,
    update(frame: FrameState) {
      const d = frame.decks[deck];
      // a ring that is held still stops bending
      if (mode === 'ring' && frame.now - lastRingMove > 70) {
        ringVel = damp(ringVel, 0, 0.05, frame.dt);
        nudge(ringNudge(ringVel));
      }
      if (size < 8) return;
      if (dirty || builtFor !== d.track || builtSize !== size) rebuild(d.track);
      if (!disc || !sheen) return;

      const angle = d.track ? platterAngle(d.positionSec) : 0;
      const low = env.lowFx();
      const live = frame.liveDeck === deck && !low;
      const pulse = live ? Math.round(frame.pulse * 12) : 0;
      const flags = (mode === 'top' ? 1 : mode === 'ring' ? 2 : 0) + pulse * 4 + (mode !== 'none' ? Math.round(fingerX + fingerY * 7) * 64 : 0);
      if (Math.abs(angle - lastAngle) < 0.0004 && flags === lastFlags) return;
      lastAngle = angle;
      lastFlags = flags;

      const ctx = fitCanvas(canvas, size, size);
      const c = size / 2;
      ctx.clearRect(0, 0, size, size);
      ctx.save();
      ctx.translate(c, c);
      ctx.rotate(angle % TAU);
      ctx.drawImage(disc, -c, -c, size, size);
      ctx.restore();
      ctx.drawImage(sheen, 0, 0, size, size);

      if (pulse > 0) {
        // the strobe lamp breathes with the beat while this deck is the one the crowd hears
        const a = Math.PI * 0.75;
        drawGlow(ctx, c + Math.cos(a) * c * 0.81, c + Math.sin(a) * c * 0.81, c * 0.3, color, 0.5 * frame.pulse);
      }
      if (mode === 'ring') {
        ctx.strokeStyle = rgba(color, 0.42);
        ctx.lineWidth = c * (1 - RING_INNER) - 2;
        ctx.beginPath();
        ctx.arc(c, c, c * (1 + RING_INNER) * 0.5 - 0.5, 0, TAU);
        ctx.stroke();
      } else if (mode === 'top' && !low) {
        drawGlow(ctx, c + fingerX, c + fingerY, 30, color, 0.55);
      }
    },
    destroy() {
      unbind();
      ro.disconnect();
    },
  };
}
