/**
 * Dev harness for the stage + HUD + guide (src/ui/hud).
 * Open http://localhost:5187/dev/hud.html?scene=<name>   (scenes: see SCENES below, or window.__hud.scenes)
 * Extra query flags: guide=0, lowfx=1, safe=<px of top safe area>, marked=1 (console carries data-console).
 * The console here is a stand-in: boxes that carry the same data-control / data-tab attributes as the
 * real one, in a drawer that opens, closes and slides between panels.
 */
import { bootHarness } from './harness';
import { createSettings } from '../core/settings';
import type { ControlId, DeckId, FrameState, Gesture, MissionRating, MissionView, PanelId } from '../core/types';
import { createCallouts, createGuide, createPauseMenu, createTopBar, showCard } from '../ui/hud';

const q = new URLSearchParams(location.search);

const css = `
.hx-top{position:relative;flex:none;height:calc(104px + var(--safe-top));z-index:2}
@media (max-height:620px){.hx-top{height:calc(92px + var(--safe-top))}}
.hx-waves{position:relative;flex:none;height:60px;background:linear-gradient(180deg,#0b0b18,#07070f);border-bottom:1px solid var(--line);overflow:hidden}
.hx-waves i{position:absolute;left:0;right:0;height:22px;opacity:.5;background:repeating-linear-gradient(90deg,var(--c) 0 2px,transparent 2px 5px);-webkit-mask-image:linear-gradient(90deg,transparent,#000 20%,#000 80%,transparent)}
.hx-play{position:relative;flex:1 1 0;min-height:0;overflow:hidden;background:linear-gradient(180deg,#07070f,#0d0d1e)}
.hx-lanes{position:absolute;inset:0 0 56px 0;display:grid;grid-template-columns:repeat(4,1fr)}
.hx-lanes i{border-left:1px solid var(--line);background:linear-gradient(180deg,transparent,rgba(255,255,255,.03))}
.hx-hit{position:absolute;left:0;right:0;bottom:62px;height:3px;background:var(--aurora);box-shadow:0 0 12px rgba(139,108,255,.8)}
.hx-pads{position:absolute;left:0;right:0;bottom:0;height:56px;display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:6px}
.hx-pads i{border-radius:10px;background:var(--hw-rubber);box-shadow:inset 0 1px 0 var(--hw-edge),inset 0 -3px 0 var(--c)}
.hx-console{position:relative;flex:none;z-index:2;background:var(--hw-plate-flat);box-shadow:0 -1px 0 var(--hw-edge)}
.hx-drawer{position:relative;height:0;overflow:hidden;transition:height 220ms cubic-bezier(.16,1,.3,1)}
.hx-console[data-open] .hx-drawer{height:280px}
.hx-panel{position:absolute;inset:0;height:280px;padding:12px;background:var(--hw-plate);transition:transform 220ms cubic-bezier(.16,1,.3,1);transform:translateX(105%)}
.hx-panel[data-pos="-1"]{transform:translateX(-105%)}
.hx-panel[data-pos="0"]{transform:none}
.hx-strip{position:relative;height:72px;display:grid;grid-template-columns:64px 1fr 64px;gap:10px;align-items:center;padding:0 10px;background:linear-gradient(180deg,#1b1b25,#101017);box-shadow:inset 0 1px 0 var(--hw-edge)}
.hx-tab{height:52px;border-radius:10px;background:var(--hw-rubber);box-shadow:inset 0 1px 0 var(--hw-edge),0 2px 4px rgba(0,0,0,.5);font:800 9px var(--font-ui);letter-spacing:.14em;color:var(--hw-silk)}
.hx-tab[data-active]{box-shadow:inset 0 0 0 1.5px var(--c),0 0 12px var(--c)}
.hx-mid{display:grid;grid-template-rows:auto auto;gap:5px;justify-items:center}
.hx-mid .hx-tab{height:22px;width:84px}
.hx-xf{position:relative;width:100%;height:30px;border-radius:6px;background:var(--hw-well);box-shadow:var(--shadow-inset)}
.hx-xf::after{content:'';position:absolute;top:3px;left:8px;width:30px;height:24px;border-radius:4px;background:var(--hw-metal)}
.hx-deck{display:grid;grid-template-columns:1fr 92px;grid-template-rows:1fr 54px;gap:10px;height:100%}
.hx-platter{align-self:center;justify-self:center;width:176px;height:176px;border-radius:50%;background:repeating-radial-gradient(circle,#0b0b10 0 2px,#15151c 2px 4px);box-shadow:0 0 0 6px #23232c,0 0 0 7px var(--hw-edge),0 8px 20px rgba(0,0,0,.6);position:relative}
.hx-platter::after{content:'';position:absolute;inset:34%;border-radius:50%;background:var(--c)}
.hx-side{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr auto;gap:8px;justify-items:center}
.hx-fader{width:30px;height:100%;min-height:120px;border-radius:6px;background:var(--hw-well);box-shadow:var(--shadow-inset);position:relative}
.hx-fader::after{content:'';position:absolute;left:2px;right:2px;top:44%;height:20px;border-radius:4px;background:var(--hw-metal)}
.hx-nudges{display:grid;gap:8px;align-content:center}
.hx-btn{min-width:44px;height:44px;padding:0 8px;border-radius:10px;background:var(--hw-rubber);box-shadow:inset 0 1px 0 var(--hw-edge),0 2px 4px rgba(0,0,0,.5);font:800 9px var(--font-ui);letter-spacing:.12em;color:var(--hw-silk)}
.hx-btn--round{border-radius:50%;width:50px;height:50px}
.hx-btn--play{box-shadow:inset 0 0 0 2px var(--led-green),0 0 10px rgba(61,255,122,.4)}
.hx-btn--cue{box-shadow:inset 0 0 0 2px var(--led-amber)}
.hx-row{grid-column:1 / -1;display:flex;gap:14px;align-items:center;justify-content:center}
.hx-mixer{display:grid;grid-template-columns:1fr 1fr;gap:14px;height:100%}
.hx-ch{display:grid;grid-template-columns:1fr 46px;gap:8px;padding:8px;border-radius:12px;background:rgba(0,0,0,.2);box-shadow:inset 0 0 0 1px var(--line)}
.hx-knobs{display:grid;grid-template-columns:1fr 1fr;gap:8px 6px;justify-items:center;align-content:center}
.hx-knob{width:46px;height:46px;border-radius:50%;background:radial-gradient(circle at 50% 30%,#3a3a48,#17171e);box-shadow:0 0 0 2px #0a0a0f,0 4px 8px rgba(0,0,0,.6);position:relative}
.hx-knob::after{content:'';position:absolute;left:50%;top:5px;width:2px;height:12px;margin-left:-1px;background:var(--c)}
.hx-knob span,.hx-leg{position:absolute;left:50%;top:100%;transform:translateX(-50%);font:800 8px var(--font-ui);letter-spacing:.14em;color:var(--hw-silk-dim);white-space:nowrap;margin-top:1px}
.hx-dev{position:fixed;left:8px;top:8px;bottom:8px;width:190px;overflow:auto;display:none;flex-direction:column;gap:4px;z-index:999;font:700 11px var(--font-ui)}
.hx-dev button{padding:5px 8px;border-radius:6px;background:#1c1c33;color:var(--ink-2);text-align:left}
@media (min-width:940px){.hx-dev{display:flex}}
`;
document.head.appendChild(Object.assign(document.createElement('style'), { textContent: css }));

const h = await bootHarness();
const root = h.root;
root.style.position = 'relative';
if (q.get('safe')) root.style.setProperty('--safe-top', `${q.get('safe')}px`);
const settings = createSettings(null);
if (q.get('guide') === '0') settings.set({ guide: false });
if (q.get('lowfx') === '1') settings.set({ lowFx: true });

function div(cls: string, parent: HTMLElement, html = ''): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  if (html) d.innerHTML = html;
  parent.appendChild(d);
  return d;
}

// ── the game screen, as the lead lays it out ──
const topSlot = div('hx-top', root);
div('hx-waves', root, '<i style="top:5px;--c:var(--deck-a)"></i><i style="top:33px;--c:var(--deck-b)"></i>');
const playSlot = div('hx-play', root);
div('hx-lanes', playSlot, '<i></i><i></i><i></i><i></i>');
div('hx-hit', playSlot);
div(
  'hx-pads',
  playSlot,
  [0, 1, 2, 3].map((i) => `<i style="--c:var(--lane-${i})"></i>`).join(''),
);

// ── stand-in console ──
const consoleEl = div('hx-console', root);
if (q.get('marked') === '1') consoleEl.dataset.console = '';
const drawer = div('hx-drawer', consoleEl);
const PANELS: PanelId[] = ['deckA', 'mixer', 'deckB'];
const panelEls = {} as Record<PanelId, HTMLDivElement>;
const ctl = (id: ControlId, cls: string, label = ''): string => `<button class="${cls}" data-control="${id}">${label}</button>`;
const deckHtml = (d: DeckId): string => `
  <div class="hx-deck" style="--c:var(--deck-${d.toLowerCase()})">
    <div class="hx-platter" data-control="${d}.platter"></div>
    <div class="hx-side">
      <div class="hx-fader" data-control="${d}.tempo"></div>
      <div class="hx-nudges">${ctl(`${d}.nudge+`, 'hx-btn', '+')}${ctl(`${d}.nudge-`, 'hx-btn', '−')}</div>
    </div>
    <div class="hx-row">${ctl(`${d}.cue`, 'hx-btn hx-btn--round hx-btn--cue', 'CUE')}${ctl(`${d}.play`, 'hx-btn hx-btn--round hx-btn--play', 'PLAY')}${ctl(`${d}.sync`, 'hx-btn', 'SYNC')}</div>
  </div>`;
const chHtml = (d: DeckId): string => `
  <div class="hx-ch" style="--c:var(--deck-${d.toLowerCase()})">
    <div class="hx-knobs">
      <div class="hx-knob" data-control="${d}.eq.high"><span>HIGH</span></div>
      <div class="hx-knob" data-control="${d}.eq.mid"><span>MID</span></div>
      <div class="hx-knob" data-control="${d}.eq.low"><span>LOW</span></div>
      <div class="hx-knob" data-control="${d}.filter"><span>FILTER</span></div>
      ${ctl(`${d}.echo`, 'hx-btn', 'ECHO')}
    </div>
    <div class="hx-fader" data-control="${d}.fader"></div>
  </div>`;
panelEls.deckA = div('hx-panel', drawer, deckHtml('A'));
panelEls.mixer = div('hx-panel', drawer, `<div class="hx-mixer">${chHtml('A')}${chHtml('B')}</div>`);
panelEls.deckB = div('hx-panel', drawer, deckHtml('B'));
const strip = div('hx-strip', consoleEl);
strip.innerHTML = `
  <button class="hx-tab" data-tab="deckA" style="--c:var(--deck-a)">DECK A</button>
  <div class="hx-mid"><button class="hx-tab" data-tab="mixer" style="--c:var(--violet)">MIXER</button><div class="hx-xf" data-control="xfader"></div></div>
  <button class="hx-tab" data-tab="deckB" style="--c:var(--deck-b)">DECK B</button>`;

let panel: PanelId | null = null;
const opened: PanelId[] = [];
function setPanel(id: PanelId | null): void {
  panel = id;
  if (id) consoleEl.dataset.open = '';
  else delete consoleEl.dataset.open;
  const at = id ? PANELS.indexOf(id) : -1;
  PANELS.forEach((p, i) => {
    if (id) panelEls[p].dataset.pos = String(Math.sign(i - at));
  });
  strip.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => {
    if (b.dataset.tab === id) b.dataset.active = '';
    else delete b.dataset.active;
  });
}
strip.addEventListener('click', (e) => {
  const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
  if (tab) setPanel(panel === tab.dataset.tab ? null : (tab.dataset.tab as PanelId));
});

// ── the HUD ──
const overlay = div('', root);
overlay.style.cssText = 'position:absolute;inset:0;z-index:30;pointer-events:none';
const guideLayer = div('', root);
guideLayer.style.cssText = 'position:absolute;inset:0;z-index:20;pointer-events:none';

const pauseMenu = createPauseMenu({ settings });
pauseMenu.el.style.pointerEvents = 'auto';
overlay.appendChild(pauseMenu.el);
async function pause(): Promise<string> {
  h.loop.stop();
  const choice = await pauseMenu.open();
  h.loop.start();
  return choice;
}
const topBar = createTopBar({ bus: h.bus, settings, onPause: () => void pause() });
const callouts = createCallouts({ bus: h.bus, settings });
const guide = createGuide({
  root,
  settings,
  openPanel: (id) => {
    opened.push(id);
    setPanel(id);
  },
  getPanel: () => panel,
});
topSlot.appendChild(topBar.el);
const calloutLayer = div('', playSlot);
calloutLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:3';
calloutLayer.appendChild(callouts.el);
guideLayer.appendChild(guide.el);

// timing of update() per component
const perf = { top: [] as number[], guide: [] as number[], callouts: [] as number[] };
function timed(name: keyof typeof perf, fn: (f: FrameState) => void): (f: FrameState) => void {
  return (f) => {
    const t0 = performance.now();
    fn(f);
    const a = perf[name];
    a.push(performance.now() - t0);
    if (a.length > 900) a.shift();
  };
}
h.loop.add(timed('top', (f) => topBar.update(f)));
h.loop.add(timed('callouts', (f) => callouts.update(f)));
h.loop.add(timed('guide', (f) => guide.update(f)));

// ── scenes ──
const hud = h.hud;
let nextId = 10;
let tick: ((f: FrameState) => void) | null = null;
h.loop.add((f) => tick?.(f), 'logic');

function mission(over: Partial<MissionView>): MissionView {
  return {
    id: nextId++,
    kind: 'start-deck',
    title: 'START DECK B',
    hint: 'Press the green PLAY button on deck B',
    targets: [{ control: 'B.play', gesture: 'tap' }],
    progress: null,
    timeLeft: 1,
    points: 1000,
    ...over,
  };
}
/** a mission whose time drains over `sec` (0 = no limit) and whose progress climbs if `prog` */
function run(m: MissionView, sec = 16, prog = false): void {
  hud.mission = m;
  h.bus.emit('mission:start', { mission: m });
  let t = 0;
  tick = (f) => {
    t += f.dt;
    if (sec > 0) m.timeLeft = Math.max(0, 1 - t / sec);
    if (prog) m.progress = Math.min(1, (t / (sec || 10)) * 1.4);
  };
}
function gestureScene(control: ControlId, gesture: Gesture, title: string, hint: string, extra: Partial<MissionView> = {}): () => void {
  return () => run(mission({ title, hint, targets: [{ control, gesture }], ...extra }), 30);
}
function endMission(rating: MissionRating, label: string): void {
  const m = hud.mission ?? mission({});
  hud.mission = null;
  tick = null;
  const points = rating === 'perfect' ? 1000 : rating === 'great' ? 700 : rating === 'ok' ? 400 : 0;
  hud.score += points;
  h.bus.emit('mission:end', { mission: m, result: { kind: m.kind, title: m.title, rating, points, label } });
}
const idle = (over: Partial<typeof hud>): void => {
  tick = null;
  Object.assign(hud, { mode: 'gig', mission: null, status: 'NEXT MIX IN 8 BARS', progress: 0.4, set: { index: 1, count: 3 } }, over);
};

const SCENES: Record<string, () => void> = {
  'hype-low': () => idle({ hype: 0.05, combo: 0, multiplier: 1, score: 3150, status: 'THE FLOOR IS EMPTYING' }),
  'hype-mid': () => idle({ hype: 0.5, combo: 12, multiplier: 2, score: 48250 }),
  'hype-high': () => idle({ hype: 0.95, combo: 128, multiplier: 4, score: 248250, progress: 0.8, set: { index: 2, count: 3 } }),
  score: () => {
    idle({ hype: 0.7, score: 0, combo: 0, multiplier: 1 });
    let acc = 0;
    tick = (f) => {
      acc += f.dt;
      if (acc > 0.35) {
        acc = 0;
        hud.combo++;
        hud.score += 300 * hud.multiplier;
        if (hud.combo % 8 === 0) {
          hud.multiplier++;
          h.bus.emit('combo:milestone', { combo: hud.combo, multiplier: hud.multiplier });
        }
      }
    };
  },
  combo: () => {
    idle({ hype: 0.8, combo: 50, multiplier: 3 });
    h.bus.emit('combo:milestone', { combo: 50, multiplier: 3 });
  },
  'combo-break': () => {
    idle({ hype: 0.5, combo: 0, multiplier: 1 });
    h.bus.emit('combo:break', { combo: 37 });
  },
  'mission-start': () => run(mission({}), 12),
  'mission-progress': () =>
    run(
      mission({
        kind: 'crossfade',
        title: 'MIX INTO DECK B',
        hint: 'Slide the CROSSFADER slowly to the right',
        targets: [{ control: 'xfader', gesture: 'right' }],
        progress: 0,
        points: 1500,
      }),
      9,
      true,
    ),
  'mission-urgent': () => {
    const m = mission({});
    run(m, 0);
    m.timeLeft = 0.14;
  },
  'mission-long': () =>
    run(mission({ title: 'KILL THE BASS, THEN BRING IT BACK', hint: 'Turn the LOW knob on deck A all the way down, wait one bar, then turn it back up', targets: [{ control: 'A.eq.low', gesture: 'turn-left' }] }), 20),
  'result-perfect': () => endMission('perfect', 'SMOOTH MIX'),
  'result-great': () => endMission('great', 'NICE BLEND'),
  'result-ok': () => endMission('ok', 'USED SYNC'),
  'result-fail': () => endMission('fail', 'TOO LATE'),
  'callout-trainwreck': () => h.bus.emit('callout', { kind: 'trainwreck', text: 'TRAINWRECK!', tone: 'bad' }),
  'callout-deadair': () => {
    h.engine.pause('A');
    h.bus.emit('callout', { kind: 'deadair', text: 'DEAD AIR', tone: 'bad' });
  },
  'callout-drop': () => {
    h.bus.emit('section', { deck: 'A', kind: 'drop', energy: 1 });
    h.bus.emit('callout', { kind: 'drop', text: 'DROP!', tone: 'good' });
  },
  'callout-rescue': () => h.bus.emit('callout', { kind: 'rescue', text: 'BACK ON BEAT', tone: 'good' }),
  'callout-combo': () => h.bus.emit('combo:milestone', { combo: 100, multiplier: 4 }),
  'callout-mix': () => h.bus.emit('callout', { kind: 'mix', text: 'SMOOTH MIX', tone: 'good' }),
  'callout-info': () => h.bus.emit('callout', { kind: 'info', text: 'LAST TRACK', tone: 'info' }),
  'g-tap': gestureScene('B.play', 'tap', 'START DECK B', 'Press the green PLAY button on deck B'),
  'g-hold': gestureScene('A.cue', 'hold', 'PREVIEW DECK A', 'Hold the CUE button on deck A to listen', { kind: 'start-set' }),
  'g-up': gestureScene('B.fader', 'up', 'BRING IN DECK B', 'Slide the deck B volume fader up', { kind: 'crossfade' }),
  'g-down': gestureScene('A.fader', 'down', 'FADE OUT DECK A', 'Slide the deck A volume fader down', { kind: 'crossfade' }),
  'g-left': gestureScene('xfader', 'left', 'BACK TO DECK A', 'Slide the CROSSFADER all the way left', { kind: 'crossfade' }),
  'g-right': gestureScene('xfader', 'right', 'MIX INTO DECK B', 'Slide the CROSSFADER all the way right', { kind: 'crossfade' }),
  'g-turn-left': gestureScene('A.eq.low', 'turn-left', 'KILL THE BASS', 'Turn the LOW knob on deck A all the way down', { kind: 'bass-drop' }),
  'g-turn-right': gestureScene('B.filter', 'turn-right', 'SWEEP THE FILTER', 'Turn the FILTER knob on deck B to the right', { kind: 'filter-sweep' }),
  'g-scratch': gestureScene('A.platter', 'scratch', 'SCRATCH!', 'Rub the record on deck A back and forth', { kind: 'scratch' }),
  'g-tempo': gestureScene('B.tempo', 'down', 'MATCH THE SPEED', 'Slide the TEMPO fader on deck B down a little', { kind: 'beatmatch' }),
  'g-nudge': gestureScene('B.nudge+', 'hold', 'CATCH UP', 'Hold the + button on deck B until the beats line up', { kind: 'beatmatch' }),
  'g-two': () =>
    run(
      mission({
        kind: 'bass-drop',
        title: 'SWAP THE BASS',
        hint: 'Turn LOW down on deck A and up on deck B',
        targets: [
          { control: 'A.eq.low', gesture: 'turn-left' },
          { control: 'B.eq.low', gesture: 'turn-right' },
        ],
      }),
      30,
    ),
  /** the player wandered off to another panel: the guide points at the way back */
  'guide-tab': () => {
    SCENES['g-tap']();
    window.setTimeout(() => setPanel('mixer'), 500);
  },
  'guide-closed': () => {
    SCENES['g-turn-left']();
    window.setTimeout(() => setPanel(null), 500);
  },
  'guide-off': () => {
    settings.set({ guide: false });
    setPanel('deckB');
    SCENES['g-tap']();
  },
  pause: () => void pause(),
  'card-good': () => void showCard(overlay, { title: 'SET COMPLETE!', subtitle: 'The crowd wants more', tone: 'good', ms: 5000 }),
  'card-bad': () => void showCard(overlay, { title: 'THE CROWD LEFT', subtitle: 'Keep the music going next time', tone: 'bad', ms: 5000 }),
  'card-info': () => void showCard(overlay, { title: 'GET READY', subtitle: 'Deck A is playing. Listen for the beat.', ms: 5000 }),
  free: () => idle({ mode: 'free', progress: null, set: null, status: 'FREE PLAY: LOAD A TRACK AND MIX', hype: 0.6 }),
  empty: () => idle({ status: '', hype: 0.5 }),
};

function scene(name: string): void {
  const fn = SCENES[name];
  if (!fn) throw new Error(`unknown scene "${name}"`);
  fn();
}

const summary = (a: number[]): { avg: number; p95: number; max: number; n: number } => {
  const s = [...a].sort((x, y) => x - y);
  return {
    avg: +(s.reduce((x, y) => x + y, 0) / Math.max(1, s.length)).toFixed(3),
    p95: +(s[Math.floor(s.length * 0.95)] ?? 0).toFixed(3),
    max: +(s[s.length - 1] ?? 0).toFixed(3),
    n: s.length,
  };
};

const api = {
  scene,
  scenes: Object.keys(SCENES),
  hud,
  settings,
  setPanel,
  getPanel: () => panel,
  opened,
  pause,
  pauseMenu,
  showCard: (c: Parameters<typeof showCard>[1]) => showCard(overlay, c),
  endMission,
  perf: () => ({ top: summary(perf.top), guide: summary(perf.guide), callouts: summary(perf.callouts) }),
  resetPerf: () => {
    perf.top.length = perf.guide.length = perf.callouts.length = 0;
  },
};
(window as unknown as { __hud: typeof api }).__hud = api;

// dev panel (wide windows only)
const dev = document.createElement('div');
dev.className = 'hx-dev';
for (const name of Object.keys(SCENES)) {
  const b = document.createElement('button');
  b.textContent = name;
  b.addEventListener('click', () => scene(name));
  dev.appendChild(b);
}
document.body.appendChild(dev);

idle({ hype: Number(q.get('hype') ?? 0.6) });
const first = q.get('scene');
if (first) for (const name of first.split(',')) scene(name);
