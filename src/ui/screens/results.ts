/**
 * Results: the grade revealed with ceremony (ring, letter, stars, the score counting up, NEW BEST),
 * then the breakdown: accuracy and the four judgments, best combo, every mission, the hype over
 * time, trainwrecks and dead air. A gig the crowd walked out of gets its own, sober treatment with
 * what went wrong in plain words; the tutorial ends on a simple "you're ready".
 *
 * Tap anywhere on the reveal to skip the ceremony.
 */
import { House, Play, RotateCcw, Sparkles, Star, Trophy, VolumeX, Waves, Zap } from 'lucide-static';
import { easeOutCubic, formatTime } from '../../core/math';
import type { AppContext, GameParams, GigResults, Grade, MissionRating, Screen, ScreenParams } from '../../core/types';
import { COLORS, fitCanvas, font, rgba } from '../../theme/theme';
import { add, h, icon, prefersReducedMotion } from './dom';
import type { Child } from './dom';
import { DIFFICULTY_COPY, countsForBest, formatPercent, formatScore, isNewBest } from './logic';
import { buzz, playUi, shared } from './shared';
import { tween } from './ticker';
import { dismissTopLayer } from './ui';

type Kind = 'win' | 'left' | 'tutorial';

const GRADE_LINE: Record<Grade, string> = {
  S: 'Legendary set. The crowd will talk about this one.',
  A: 'Great set. The floor never stopped moving.',
  B: 'Solid set. A few rough edges, a happy crowd.',
  C: 'You got through it. Smoother mixes will lift the grade.',
  D: 'A tough night. Every DJ has one.',
};

const RATING_LABEL: Record<MissionRating, string> = { perfect: 'PERFECT', great: 'GREAT', ok: 'OK', fail: 'MISSED' };

/** When each part of the reveal happens, in ms after entering. */
const T = { ring: 250, grade: 900, stars: 1250, starStep: 140, score: 1300, scoreMs: 1400, best: 2800, rest: 2300 };

export function createResultsScreen(ctx: AppContext): Screen<ScreenParams['results']> {
  const { nav, settings, engine } = ctx;
  const el = h('div', 'sc-screen sc-res');
  const scroll = h('div', 'sc-res__scroll ui-scroll');
  const foot = h('footer', 'sc-foot sc-foot--row sc-res__foot');
  add(el, h('div', 'sc-res__bgglow'), scroll, foot);

  let timers: number[] = [];
  let cancelCount: (() => void) | null = null;
  let finalScore = 0;
  let scoreEl: HTMLElement | null = null;
  let ro: ResizeObserver | null = null;

  function later(ms: number, fn: () => void): void {
    timers.push(window.setTimeout(fn, ms));
  }

  function clearTimers(): void {
    for (const t of timers) window.clearTimeout(t);
    timers = [];
    cancelCount?.();
    cancelCount = null;
  }

  /** Jump to the end of the ceremony. */
  function skip(): void {
    if (el.classList.contains('sc-res--instant')) return;
    el.classList.add('sc-res--instant');
    const pending = timers.length > 0;
    clearTimers();
    if (scoreEl) scoreEl.textContent = formatScore(finalScore);
    if (pending) el.classList.add('sc-res--best-on');
  }

  // ───────────── pieces ─────────────

  function medal(grade: Grade, kind: Kind): HTMLElement {
    const ticks = Array.from({ length: 60 }, (_, i) => {
      const a = (i / 60) * Math.PI * 2;
      const r0 = i % 5 === 0 ? 78 : 81;
      return `<line x1="${(100 + Math.cos(a) * r0).toFixed(1)}" y1="${(100 + Math.sin(a) * r0).toFixed(1)}" x2="${(100 + Math.cos(a) * 84).toFixed(1)}" y2="${(100 + Math.sin(a) * 84).toFixed(1)}"/>`;
    }).join('');
    const ring = document.createElement('div');
    ring.className = 'sc-res__ringsvg';
    ring.innerHTML = `<svg viewBox="0 0 200 200" aria-hidden="true">
      <defs><linearGradient id="sc-res-ring" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" style="stop-color:var(--g1)"/><stop offset="0.5" style="stop-color:var(--g2)"/><stop offset="1" style="stop-color:var(--g3)"/>
      </linearGradient></defs>
      <circle cx="100" cy="100" r="93" class="sc-res__ringtrack"/>
      <g class="sc-res__ticks">${ticks}</g>
      <circle cx="100" cy="100" r="93" class="sc-res__ringarc" pathLength="100" transform="rotate(-90 100 100)"/>
    </svg>`;
    const sparks = h('div', 'sc-res__sparks');
    if ((grade === 'S' || grade === 'A') && kind === 'win' && !shared.lowFx()) {
      for (let i = 0; i < 14; i++) {
        const s = h('i');
        s.style.setProperty('--a', `${(i / 14) * 360 + (i % 2) * 9}deg`);
        s.style.setProperty('--d', `${70 + (i % 3) * 22}px`);
        sparks.appendChild(s);
      }
    }
    const letter = h('div', 'sc-res__grade', grade);
    letter.setAttribute('aria-label', `Grade ${grade}`);
    return h('div', `sc-res__medal sc-res__medal--${grade}`, h('div', 'sc-res__rays'), ring, h('div', 'sc-res__disc'), sparks, letter);
  }

  function stars(n: number): HTMLElement {
    const row = h('div', 'sc-res__stars');
    row.setAttribute('aria-label', `${n} of 5 stars`);
    for (let i = 0; i < 5; i++) {
      const s = h('span', `sc-res__star${i < n ? ' on' : ''}`, icon(Star));
      s.style.setProperty('--i', String(i));
      row.appendChild(s);
    }
    return row;
  }

  function tile(label: string, value: Child, sub?: string, tone = ''): HTMLElement {
    return h(
      'div',
      `sc-res__tile${tone ? ` sc-res__tile--${tone}` : ''}`,
      h('div', 'sc-res__tilelabel', label),
      h('div', 'sc-res__tilevalue ui-num', value),
      sub ? h('div', 'sc-res__tilesub', sub) : null,
    );
  }

  function judgments(r: GigResults): HTMLElement {
    const rows: [string, number, string][] = [
      ['PERFECT', r.rhythm.perfect, 'perfect'],
      ['GREAT', r.rhythm.great, 'great'],
      ['GOOD', r.rhythm.good, 'good'],
      ['MISS', r.rhythm.miss, 'miss'],
    ];
    const max = Math.max(1, ...rows.map((x) => x[1]));
    return h(
      'div',
      'sc-res__judges',
      ...rows.map(([label, n, cls], i) => {
        const bar = h('span', 'sc-res__jbar', h('i'));
        bar.style.setProperty('--w', String(n / max));
        bar.style.setProperty('--i', String(i));
        return h('div', `sc-res__jrow sc-res__jrow--${cls}`, h('span', 'sc-res__jlabel', label), bar, h('span', 'sc-res__jn ui-num', String(n)));
      }),
    );
  }

  function missions(r: GigResults): HTMLElement {
    const done = r.missions.filter((m) => m.rating !== 'fail').length;
    const list = h('div', 'sc-res__missions');
    for (const m of r.missions) {
      list.appendChild(
        h(
          'div',
          `sc-res__mission sc-res__mission--${m.rating}`,
          h('span', 'sc-res__rating', RATING_LABEL[m.rating]),
          h('span', 'sc-res__mtext', h('span', 'sc-res__mtitle', m.title), h('span', 'sc-res__mlabel', m.label)),
          h('span', 'sc-res__mpts ui-num', m.points > 0 ? `+${formatScore(m.points)}` : '–'),
        ),
      );
    }
    if (r.missions.length === 0) list.appendChild(h('p', 'sc-note', 'No missions this time.'));
    return section('Missions', `${done} of ${r.missions.length} done`, list);
  }

  function section(title: string, aside: string | null, ...children: Child[]): HTMLElement {
    return h(
      'section',
      'sc-section sc-res__section',
      h('div', 'sc-section__head', h('h2', 'sc-h', title), aside ? h('span', 'sc-count', aside) : null),
      ...children,
    );
  }

  function hypeChart(r: GigResults): HTMLElement {
    const canvas = h('canvas', 'sc-res__chart');
    canvas.setAttribute('aria-hidden', 'true');
    const box = h(
      'div',
      'sc-res__chartbox',
      canvas,
      h('span', 'sc-res__axis sc-res__axis--l', 'start'),
      h('span', 'sc-res__axis sc-res__axis--r', r.completed ? 'end' : 'crowd left'),
    );
    const draw = (): void => drawHype(canvas, r);
    ro?.disconnect();
    ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return section(
      'Hype over the set',
      `avg ${formatPercent(r.hypeAvg)} · peak ${formatPercent(r.hypePeak)}`,
      h('div', 'sc-res__card', box),
    );
  }

  function cleanStats(r: GigResults): HTMLElement {
    const wrecks = r.trainwrecks;
    const dead = Math.round(r.deadAirSec * 10) / 10;
    return h(
      'div',
      'sc-res__tiles sc-res__tiles--2',
      tile('TRAINWRECKS', String(wrecks), wrecks === 0 ? 'No clashing beats' : 'Times the beats clashed', wrecks === 0 ? 'good' : 'bad'),
      tile('DEAD AIR', dead === 0 ? '0 s' : `${dead} s`, dead === 0 ? 'Never went silent' : 'Of silence', dead === 0 ? 'good' : 'bad'),
    );
  }

  /** Plain-words reasons the crowd left, most important first. */
  function whatWentWrong(r: GigResults): HTMLElement {
    const items: HTMLElement[] = [];
    const add1 = (svg: string, strong: string, rest: string): void => {
      items.push(h('li', null, icon(svg), h('span', null, h('b', null, strong), ` ${rest}`)));
    };
    if (r.deadAirSec >= 2)
      add1(VolumeX, `${Math.round(r.deadAirSec)} s of silence.`, 'Start the next track before the one playing runs out.');
    if (r.trainwrecks > 0)
      add1(Waves, `The beats clashed ${r.trainwrecks === 1 ? 'once' : `${r.trainwrecks} times`}.`, 'Match the speeds (or press SYNC) before you slide the crossfader.');
    if (r.missions.some((m) => m.rating === 'fail'))
      add1(Zap, 'Missed missions.', 'Read the line at the top and use the glowing control.');
    if (r.rhythm.accuracy < 0.7)
      add1(Sparkles, 'Many missed notes.', 'Tap the pad when a note reaches the line, not before.');
    if (items.length === 0) add1(Sparkles, 'The hype ran dry.', 'Keep hitting the pads and keep the music going.');
    return h('div', 'sc-res__card sc-res__wrong', h('h3', 'sc-res__wronghead', 'What emptied the floor'), h('ul', null, ...items.slice(0, 3)));
  }

  // ───────────── build ─────────────

  function build(r: GigResults, params: GameParams): void {
    const kind: Kind = params.tutorial ? 'tutorial' : r.completed ? 'win' : 'left';
    el.dataset.kind = kind;
    el.dataset.grade = r.grade;
    el.classList.remove('sc-res--go', 'sc-res--instant', 'sc-res--best-on');
    el.classList.toggle('sc-res--lowfx', shared.lowFx());
    scroll.replaceChildren();
    foot.replaceChildren();
    finalScore = r.score;

    const best = settings.get().best;
    const newBest = isNewBest(r, params, best);
    const previousBest = best[r.difficulty] ?? 0;
    if (newBest) settings.set({ best: { ...best, [r.difficulty]: r.score } });
    if (kind === 'tutorial' && r.completed && !settings.get().tutorialDone) settings.set({ tutorialDone: true });

    const diffName = DIFFICULTY_COPY[r.difficulty].name;
    const setNames = r.setlist.map((t) => t.title).join('  →  ');

    // ── the reveal ──
    const hero = h('div', 'sc-res__hero');
    hero.addEventListener('click', skip);
    if (kind === 'tutorial') {
      add(
        hero,
        h('div', 'sc-res__kicker', icon(Sparkles), 'LESSON COMPLETE'),
        h('div', 'sc-res__ready', h('span', 'ui-aurora-text', 'YOU’RE'), h('span', 'ui-aurora-text', 'READY')),
        stars(r.stars),
        h(
          'p',
          'sc-res__line',
          'You started a deck, matched the speed, crossfaded and dropped the bass. That is DJing. Now play your first real gig.',
        ),
      );
    } else {
      scoreEl = h('span', 'sc-res__score ui-num', '0');
      const bestEl = newBest
        ? h('div', 'sc-res__best sc-res__best--new', icon(Trophy), 'NEW BEST')
        : countsForBest(r, params) && previousBest > 0
          ? h('div', 'sc-res__best', `Best on ${diffName.toLowerCase()}: `, h('b', 'ui-num', formatScore(previousBest)))
          : null;
      add(
        hero,
        h('div', 'sc-res__kicker', kind === 'left' ? 'THE CROWD LEFT' : 'GIG COMPLETE'),
        h('div', 'sc-res__set', h('span', null, setNames), h('span', 'sc-res__diff', `${diffName} · ${formatTime(r.durationSec)}`)),
        medal(r.grade, kind),
        stars(r.stars),
        h('div', 'sc-res__scorebox', scoreEl, h('span', 'sc-res__scorelabel', 'SCORE')),
        bestEl,
        h('p', 'sc-res__line', kind === 'left' ? 'The floor emptied before the end of your set.' : GRADE_LINE[r.grade]),
      );
    }
    scroll.appendChild(hero);

    // ── the breakdown ──
    const rest = h('div', 'sc-res__rest');
    if (kind === 'left') rest.appendChild(whatWentWrong(r));
    add(
      rest,
      h(
        'div',
        'sc-res__tiles',
        tile('ACCURACY', formatPercent(r.rhythm.accuracy), 'of the notes'),
        tile('BEST COMBO', String(r.rhythm.maxCombo), 'hits in a row'),
        tile('HYPE', formatPercent(r.hypeAvg), 'on average', 'gold'),
      ),
      section('Notes', `${r.rhythm.perfect + r.rhythm.great + r.rhythm.good + r.rhythm.miss} in all`, h('div', 'sc-res__card', judgments(r))),
      missions(r),
      r.hypeHistory.length > 1 ? hypeChart(r) : null,
      kind === 'tutorial' ? null : section('Clean mixing', null, cleanStats(r)),
    );
    scroll.appendChild(rest);

    // ── what next ──
    const homeBtn = h('button', 'ui-btn ui-btn--lg sc-res__home', icon(House), h('span', null, 'HOME'));
    homeBtn.type = 'button';
    homeBtn.dataset.act = 'home';
    homeBtn.setAttribute('aria-label', 'Home');
    homeBtn.addEventListener('click', () => nav.go('home'));
    const mainLabel = kind === 'tutorial' ? 'PLAY YOUR FIRST GIG' : kind === 'left' ? 'TRY AGAIN' : 'PLAY AGAIN';
    const main = h(
      'button',
      'ui-btn ui-btn--primary ui-btn--lg sc-res__again',
      icon(kind === 'tutorial' ? Play : RotateCcw, kind === 'tutorial' ? 'sc-fillicon' : ''),
      h('span', null, mainLabel),
    );
    main.type = 'button';
    main.dataset.act = kind === 'tutorial' ? 'first-gig' : 'again';
    main.addEventListener('click', () => {
      buzz(settings, 12);
      if (kind === 'tutorial') nav.go('setup');
      else nav.go('game', params);
    });
    add(foot, homeBtn, main);

    // ── the ceremony ──
    scroll.scrollTop = 0;
    if (prefersReducedMotion()) {
      el.classList.add('sc-res--go');
      skip();
      return;
    }
    void el.offsetWidth;
    el.classList.add('sc-res--go');
    later(T.grade, () => {
      if (kind === 'left') playUi(engine, 'fail', 0.5);
      else if (kind === 'tutorial' || r.grade === 'S' || r.grade === 'A') playUi(engine, 'cheer', 0.7);
      else playUi(engine, 'success', 0.6);
      buzz(settings, r.grade === 'S' ? [20, 60, 30] : 18);
    });
    if (scoreEl) {
      const target = scoreEl;
      later(T.score, () => {
        cancelCount = tween(T.scoreMs, (t) => {
          target.textContent = formatScore(r.score * easeOutCubic(t));
        });
      });
    }
    if (newBest) later(T.best, () => {
      el.classList.add('sc-res--best-on');
      playUi(engine, 'success', 0.6);
    });
    // nothing left to wait for: the skip handler has nothing to do after this
    later(T.best + 400, () => {
      timers = [];
    });
  }

  return {
    el,
    enter(p) {
      clearTimers();
      build(p.results, p.params);
    },
    leave() {
      clearTimers();
      ro?.disconnect();
      ro = null;
    },
    back() {
      if (dismissTopLayer(el)) return true;
      nav.go('home');
      return true;
    },
  };
}

/** The hype history as an area chart, drawn once per size. */
function drawHype(canvas: HTMLCanvasElement, r: GigResults): void {
  const w = canvas.clientWidth;
  const hgt = canvas.clientHeight;
  if (!w || !hgt) return;
  const g = fitCanvas(canvas, w, hgt);
  g.clearRect(0, 0, w, hgt);
  const data = r.hypeHistory;
  const n = data.length;
  const padT = 10;
  const padB = 4;
  const ch = hgt - padT - padB;
  const x = (i: number): number => (i / (n - 1)) * w;
  const y = (v: number): number => padT + (1 - Math.max(0, Math.min(1, v))) * ch;

  // guides at 25 / 50 / 75 %
  g.fillStyle = rgba(COLORS.ink, 0.06);
  for (const v of [0.25, 0.5, 0.75]) g.fillRect(0, Math.round(y(v)), w, 1);

  // a smooth path through the samples
  const path = (): void => {
    g.moveTo(x(0), y(data[0]));
    for (let i = 1; i < n; i++) {
      const xm = (x(i - 1) + x(i)) / 2;
      g.bezierCurveTo(xm, y(data[i - 1]), xm, y(data[i]), x(i), y(data[i]));
    }
  };
  const left = !r.completed;
  const area = g.createLinearGradient(0, padT, 0, hgt);
  area.addColorStop(0, rgba(left ? COLORS.red : COLORS.violet, 0.42));
  area.addColorStop(1, rgba(left ? COLORS.red : COLORS.violet, 0));
  g.beginPath();
  path();
  g.lineTo(x(n - 1), hgt);
  g.lineTo(0, hgt);
  g.closePath();
  g.fillStyle = area;
  g.fill();

  const line = g.createLinearGradient(0, 0, w, 0);
  if (left) {
    line.addColorStop(0, COLORS.violet);
    line.addColorStop(1, COLORS.red);
  } else {
    line.addColorStop(0, COLORS.cyan);
    line.addColorStop(0.52, COLORS.violet);
    line.addColorStop(1, COLORS.pink);
  }
  g.beginPath();
  path();
  g.strokeStyle = line;
  g.lineWidth = 2.5;
  g.lineJoin = 'round';
  g.lineCap = 'round';
  g.stroke();

  // the peak, in gold
  let pi = 0;
  for (let i = 1; i < n; i++) if (data[i] > data[pi]) pi = i;
  const px = x(pi);
  const py = y(data[pi]);
  g.fillStyle = rgba(COLORS.gold, 0.25);
  g.beginPath();
  g.arc(px, py, 8, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = COLORS.gold;
  g.beginPath();
  g.arc(px, py, 3.5, 0, Math.PI * 2);
  g.fill();
  g.font = font(800, 10);
  g.textBaseline = 'bottom';
  g.textAlign = px > w - 40 ? 'right' : px < 40 ? 'left' : 'center';
  g.fillText('PEAK', Math.max(2, Math.min(w - 2, px)), py - 9 < 12 ? py + 22 : py - 9);

  if (left) {
    const ex = x(n - 1) - 4;
    const ey = y(data[n - 1]);
    g.strokeStyle = COLORS.red;
    g.lineWidth = 2.5;
    g.beginPath();
    g.moveTo(ex - 5, ey - 5);
    g.lineTo(ex + 5, ey + 5);
    g.moveTo(ex + 5, ey - 5);
    g.lineTo(ex - 5, ey + 5);
    g.stroke();
  }
}
