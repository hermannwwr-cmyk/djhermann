/**
 * The four performance pads: backlit rubber pads set into a metal plate, like the pads on a DJ
 * controller. Each pad glows in its lane colour, brightens as a note comes down its lane, and
 * goes down and lights up hot when it is pressed. Input is handled by the playfield (index.ts);
 * this file only draws.
 */
import { Drum, Hand, Megaphone, Zap } from 'lucide-static';
import { damp } from '../../core/math';
import { LANE_COUNT, LANE_LABELS } from '../../core/types';
import type { Lane } from '../../core/types';
import { LANE_COLORS, hexToRgb } from '../../theme/theme';

const ICONS = [Drum, Hand, Zap, Megaphone] as const;
export const PAD_KEYS = ['D', 'F', 'J', 'K'] as const;

interface PadEls {
  root: HTMLElement;
  led: HTMLElement;
  hot: HTMLElement;
  halo: HTMLElement;
  ledV: number;
  hotV: number;
  haloV: number;
}

export class PadRow {
  readonly el: HTMLElement;
  private readonly pads: PadEls[] = [];
  private readonly heat = new Float32Array(LANE_COUNT);
  private readonly downCount = new Uint8Array(LANE_COUNT);

  constructor() {
    const el = document.createElement('div');
    el.className = 'rh-pads';
    el.setAttribute('aria-hidden', 'true');
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const [r, g, b] = hexToRgb(LANE_COLORS[lane]);
      const pad = document.createElement('div');
      pad.className = 'rh-pad';
      pad.dataset.lane = String(lane);
      pad.style.setProperty('--rh-c', `var(--lane-${lane})`);
      pad.style.setProperty('--rh-rgb', `${r}, ${g}, ${b}`);
      pad.innerHTML = `
        <div class="rh-pad-halo"></div>
        <div class="rh-pad-well">
          <div class="rh-pad-body">
            <div class="rh-pad-led"></div>
            <div class="rh-pad-hot"></div>
            <div class="rh-pad-face">
              <span class="rh-pad-icon">${ICONS[lane]}</span>
              <span class="rh-pad-label">${LANE_LABELS[lane]}</span>
            </div>
          </div>
        </div>
        <span class="rh-pad-key">${PAD_KEYS[lane]}</span>`;
      el.appendChild(pad);
      this.pads.push({
        root: pad,
        led: pad.querySelector('.rh-pad-led') as HTMLElement,
        hot: pad.querySelector('.rh-pad-hot') as HTMLElement,
        halo: pad.querySelector('.rh-pad-halo') as HTMLElement,
        ledV: -1,
        hotV: -1,
        haloV: -1,
      });
    }
    this.el = el;
  }

  down(lane: Lane): void {
    this.downCount[lane]++;
    this.heat[lane] = 1;
    this.pads[lane].root.classList.add('is-down');
    // light up at once, before the next frame
    this.write(lane, 1, 1, 1);
  }

  up(lane: Lane): void {
    if (this.downCount[lane] > 0) this.downCount[lane]--;
    if (this.downCount[lane] === 0) this.pads[lane].root.classList.remove('is-down');
  }

  /** release everything (focus lost, destroy) */
  releaseAll(): void {
    this.downCount.fill(0);
    for (const p of this.pads) p.root.classList.remove('is-down');
  }

  /**
   * Per frame. `cue` (0..1 per lane) is how close the next note of the lane is; `pulse` is the
   * shared beat envelope; `alive` dims everything in dead air.
   */
  update(cue: Float32Array, pulse: number, alive: number, dt: number, lowFx: boolean): void {
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const down = this.downCount[lane] > 0;
      this.heat[lane] = down ? 1 : damp(this.heat[lane], 0, 0.07, dt);
      const heat = this.heat[lane];
      const c = cue[lane];
      const idle = (0.27 + (lowFx ? 0 : 0.13 * pulse)) * (0.5 + 0.5 * alive);
      const led = Math.max(idle + 0.6 * c * c, heat);
      const halo = Math.max(heat * 0.95, c * c * 0.45);
      this.write(lane as Lane, led, heat, halo);
    }
  }

  private write(lane: Lane, led: number, hot: number, halo: number): void {
    const p = this.pads[lane];
    if (Math.abs(led - p.ledV) > 0.01) {
      p.ledV = led;
      p.led.style.opacity = led.toFixed(3);
    }
    if (Math.abs(hot - p.hotV) > 0.01) {
      p.hotV = hot;
      p.hot.style.opacity = hot.toFixed(3);
    }
    if (Math.abs(halo - p.haloV) > 0.01) {
      p.haloV = halo;
      p.halo.style.opacity = halo.toFixed(3);
    }
  }
}
