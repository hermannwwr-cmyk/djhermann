/**
 * The drawn illustrations of the how-to cards, as inline SVG (viewBox 320 × 240). They animate with
 * CSS (screens.css, .sc-ill …) only while their card is on screen.
 */
import { COLORS, LANE_COLORS } from '../../theme/theme';

const C = COLORS;
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const f = (n: number): string => n.toFixed(1);

/** Gradients and filters every illustration may use; ids are prefixed per card so they never clash. */
function defs(p: string): string {
  return `
  <linearGradient id="${p}-aur" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="${C.cyan}"/><stop offset="0.52" stop-color="${C.violet}"/><stop offset="1" stop-color="${C.pink}"/>
  </linearGradient>
  <linearGradient id="${p}-plate" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#1d1d28"/><stop offset="1" stop-color="#111118"/>
  </linearGradient>
  <linearGradient id="${p}-rubber" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#2d2d38"/><stop offset="1" stop-color="#1a1a22"/>
  </linearGradient>
  <linearGradient id="${p}-metal" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#e4e4ee"/><stop offset="0.48" stop-color="#8b8b9b"/><stop offset="0.52" stop-color="#5d5d6c"/><stop offset="1" stop-color="#b9b9c8"/>
  </linearGradient>
  <radialGradient id="${p}-glow-gold"><stop offset="0" stop-color="${C.gold}" stop-opacity="0.8"/><stop offset="1" stop-color="${C.gold}" stop-opacity="0"/></radialGradient>
  <radialGradient id="${p}-glow-green"><stop offset="0" stop-color="${C.ledGreen}" stop-opacity="0.75"/><stop offset="1" stop-color="${C.ledGreen}" stop-opacity="0"/></radialGradient>
  <radialGradient id="${p}-glow-cyan"><stop offset="0" stop-color="${C.cyan}" stop-opacity="0.7"/><stop offset="1" stop-color="${C.cyan}" stop-opacity="0"/></radialGradient>
  <radialGradient id="${p}-glow-pink"><stop offset="0" stop-color="${C.pink}" stop-opacity="0.7"/><stop offset="1" stop-color="${C.pink}" stop-opacity="0"/></radialGradient>
  <radialGradient id="${p}-glow-violet"><stop offset="0" stop-color="${C.violet}" stop-opacity="0.6"/><stop offset="1" stop-color="${C.violet}" stop-opacity="0"/></radialGradient>`;
}

const svg = (p: string, body: string, extraDefs = ''): string =>
  `<svg class="sc-ill sc-ill--${p}" viewBox="0 0 320 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-hidden="true"><defs>${defs(p)}${extraDefs}</defs>${body}</svg>`;

/** A hardware plate with a 1 px top highlight. */
const plate = (p: string, x: number, y: number, w: number, h: number, r = 14): string =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="url(#${p}-plate)" stroke="#000" stroke-opacity="0.6"/>
   <path d="M${x + r} ${y + 0.75}H${x + w - r}" stroke="#fff" stroke-opacity="0.12"/>`;

/** A pulsing "tap here" marker. */
const tapMarker = (cx: number, cy: number, color: string = C.ink): string =>
  `<g class="sc-ill__tap" style="transform-origin:${cx}px ${cy}px">
     <circle cx="${cx}" cy="${cy}" r="16" fill="none" stroke="${color}" stroke-width="2" class="sc-ill__ring"/>
     <circle cx="${cx}" cy="${cy}" r="16" fill="none" stroke="${color}" stroke-width="2" class="sc-ill__ring sc-ill__ring--2"/>
     <circle cx="${cx}" cy="${cy}" r="18" fill="none" stroke="${color}" stroke-width="2.5" stroke-opacity="0.85"/>
   </g>`;

// ───────────────────────────── 1: hit the pads ─────────────────────────────

export function padsArt(): string {
  const p = 'pads';
  const top = { y: 6, l: 126, r: 194 };
  const bot = { y: 178, l: 22, r: 298 };
  const at = (lane: number, t: number): { x: number; y: number; w: number } => {
    const l = lerp(top.l, bot.l, t);
    const r = lerp(top.r, bot.r, t);
    const lw = (r - l) / 4;
    return { x: l + lw * (lane + 0.5), y: lerp(top.y, bot.y, t), w: lw };
  };
  let lanes = '';
  for (let i = 0; i < 4; i++) {
    const a = lerp(top.l, top.r, i / 4);
    const b = lerp(top.l, top.r, (i + 1) / 4);
    const c = lerp(bot.l, bot.r, (i + 1) / 4);
    const d = lerp(bot.l, bot.r, i / 4);
    lanes += `<polygon points="${f(a)},${top.y} ${f(b)},${top.y} ${f(c)},${bot.y} ${f(d)},${bot.y}" fill="url(#pads-lane${i})"/>`;
  }
  let seps = '';
  for (let i = 0; i <= 4; i++) {
    seps += `<line x1="${f(lerp(top.l, top.r, i / 4))}" y1="${top.y}" x2="${f(lerp(bot.l, bot.r, i / 4))}" y2="${bot.y}" stroke="#fff" stroke-opacity="${i === 0 || i === 4 ? 0.22 : 0.08}"/>`;
  }
  // beat lines across the highway
  let beats = '';
  for (const t of [0.12, 0.3, 0.52, 0.78]) {
    const y = lerp(top.y, bot.y, t);
    beats += `<line x1="${f(lerp(top.l, bot.l, t))}" y1="${f(y)}" x2="${f(lerp(top.r, bot.r, t))}" y2="${f(y)}" stroke="#fff" stroke-opacity="${(0.04 + t * 0.06).toFixed(2)}"/>`;
  }
  const note = (lane: number, t: number, cls = ''): string => {
    const n = at(lane, t);
    const w = n.w * 0.78;
    const hgt = 3 + 7 * t;
    const col = LANE_COLORS[lane];
    return `<g class="${cls}"><rect x="${f(n.x - w / 2)}" y="${f(n.y - hgt / 2)}" width="${f(w)}" height="${f(hgt)}" rx="${f(hgt / 2)}" fill="${col}"/>
      <rect x="${f(n.x - w / 2 + 2)}" y="${f(n.y - hgt / 2 + 1)}" width="${f(w - 4)}" height="${f(Math.max(1, hgt * 0.3))}" rx="1" fill="#fff" fill-opacity="0.55"/></g>`;
  };
  const hit = at(1, 0.94);
  const laneGrads = LANE_COLORS.map(
    (c, i) =>
      `<linearGradient id="pads-lane${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c}" stop-opacity="0"/><stop offset="1" stop-color="${c}" stop-opacity="${i === 1 ? 0.3 : 0.12}"/></linearGradient>`,
  ).join('');

  let pads = '';
  for (let i = 0; i < 4; i++) {
    const x = 20 + i * 72;
    const on = i === 1;
    const col = LANE_COLORS[i];
    pads += `<g class="${on ? 'sc-ill__pad--on' : ''}">
      ${on ? `<ellipse cx="${x + 32}" cy="208" rx="54" ry="34" fill="url(#pads-glow-violet)"/>` : ''}
      <rect x="${x}" y="188" width="64" height="44" rx="10" fill="#08080d"/>
      <rect x="${x + 2}" y="190" width="60" height="40" rx="9" fill="url(#pads-rubber)" stroke="${col}" stroke-opacity="${on ? 0.95 : 0.4}" stroke-width="${on ? 2 : 1}"/>
      ${on ? `<rect x="${x + 2}" y="190" width="60" height="40" rx="9" fill="${col}" fill-opacity="0.28"/>` : ''}
      <rect x="${x + 16}" y="194" width="32" height="3" rx="1.5" fill="${col}" fill-opacity="${on ? 1 : 0.45}"/>
      <text x="${x + 32}" y="219" text-anchor="middle" class="sc-ill__silk">${['BOOM', 'CLAP', 'ZAP', 'HORN'][i]}</text>
    </g>`;
  }

  return svg(
    p,
    `
    <rect x="0" y="0" width="320" height="240" fill="#06060c"/>
    <polygon points="${top.l},${top.y} ${top.r},${top.y} ${bot.r},${bot.y} ${bot.l},${bot.y}" fill="#0c0c18"/>
    ${lanes}${seps}${beats}
    ${note(0, 0.34)}${note(2, 0.16)}${note(3, 0.5)}${note(0, 0.7)}${note(2, 0.62)}
    ${note(1, 0.94, 'sc-ill__arrive')}
    <line x1="${f(lerp(top.l, bot.l, 0.94))}" y1="${f(hit.y)}" x2="${f(lerp(top.r, bot.r, 0.94))}" y2="${f(hit.y)}" stroke="#fff" stroke-width="2.5" stroke-opacity="0.9"/>
    <g class="sc-ill__burst" style="transform-origin:${f(hit.x)}px ${f(hit.y)}px">
      <ellipse cx="${f(hit.x)}" cy="${f(hit.y)}" rx="46" ry="22" fill="url(#pads-glow-gold)"/>
      ${[0, 1, 2, 3, 4, 5, 6, 7]
        .map((k) => {
          const a = (k / 8) * Math.PI * 2;
          return `<line x1="${f(hit.x + Math.cos(a) * 12)}" y1="${f(hit.y + Math.sin(a) * 6)}" x2="${f(hit.x + Math.cos(a) * 26)}" y2="${f(hit.y + Math.sin(a) * 13)}" stroke="${C.goldHot}" stroke-width="2" stroke-linecap="round"/>`;
        })
        .join('')}
    </g>
    <text x="${f(hit.x + 4)}" y="${f(hit.y - 30)}" text-anchor="middle" class="sc-ill__judge" style="transform-origin:${f(hit.x)}px ${f(hit.y - 36)}px">PERFECT</text>
    ${pads}
    ${tapMarker(20 + 72 + 32, 210, '#ffffff')}
  `,
    laneGrads,
  );
}

// ───────────────────────────── 2: follow the missions ─────────────────────────────

export function missionArt(): string {
  const p = 'mis';
  const target = { x: 262, y: 204 };
  const jog = (cx: number, cy: number, color: string, letter: string): string => `
    <circle cx="${cx}" cy="${cy}" r="40" fill="#08080d"/>
    <circle cx="${cx}" cy="${cy}" r="37" fill="url(#mis-rubber)" stroke="${color}" stroke-opacity="0.55" stroke-width="2"/>
    <circle cx="${cx}" cy="${cy}" r="29" fill="#0d0d14" stroke="#fff" stroke-opacity="0.06"/>
    ${[0, 1, 2, 3, 4, 5].map((k) => `<circle cx="${cx}" cy="${cy}" r="${10 + k * 3}" fill="none" stroke="#fff" stroke-opacity="0.05"/>`).join('')}
    <circle cx="${cx}" cy="${cy}" r="9" fill="${color}" fill-opacity="0.85"/>
    <text x="${cx}" y="${cy + 3.5}" text-anchor="middle" class="sc-ill__deck">${letter}</text>`;
  const btn = (cx: number, cy: number, kind: 'cue' | 'play', lit: boolean): string => {
    const col = kind === 'play' ? C.ledGreen : C.ledAmber;
    const icon =
      kind === 'play'
        ? `<path d="M${cx - 3.5} ${cy - 5}L${cx + 5.5} ${cy}L${cx - 3.5} ${cy + 5}Z" fill="${lit ? col : '#555566'}"/>`
        : `<text x="${cx}" y="${cy + 3}" text-anchor="middle" class="sc-ill__btntext" fill="${lit ? col : '#77778a'}">CUE</text>`;
    return `<circle cx="${cx}" cy="${cy}" r="15" fill="#08080d"/>
      <circle cx="${cx}" cy="${cy}" r="13" fill="url(#mis-rubber)" stroke="${lit ? col : '#000'}" stroke-width="${lit ? 2 : 1}" stroke-opacity="${lit ? 1 : 0.6}"/>${icon}`;
  };
  return svg(
    p,
    `
    <rect x="0" y="0" width="320" height="240" fill="#06060c"/>
    <!-- the mission line, as the top bar shows it -->
    <rect x="14" y="10" width="292" height="60" rx="16" fill="#13132a" stroke="url(#mis-aur)" stroke-width="1.5"/>
    <text x="30" y="31" class="sc-ill__kicker">MISSION</text>
    <text x="30" y="51" class="sc-ill__mtitle">START DECK B</text>
    <text x="30" y="63" class="sc-ill__mhint">Press the green PLAY button on deck B</text>
    <rect x="246" y="24" width="46" height="18" rx="9" fill="${C.gold}" fill-opacity="0.14" stroke="${C.gold}" stroke-opacity="0.5"/>
    <text x="269" y="36.5" text-anchor="middle" class="sc-ill__pts">+1500</text>
    <!-- the console -->
    ${plate(p, 14, 84, 292, 148, 16)}
    ${jog(78, 146, C.cyan, 'A')}
    ${jog(242, 146, C.pink, 'B')}
    <rect x="142" y="108" width="36" height="80" rx="6" fill="#0b0b12" stroke="#fff" stroke-opacity="0.05"/>
    <rect x="157" y="116" width="6" height="64" rx="3" fill="#000"/>
    <rect x="148" y="140" width="24" height="12" rx="3" fill="url(#mis-metal)"/>
    <text x="160" y="200" text-anchor="middle" class="sc-ill__silk">MIXER</text>
    ${btn(56, 206, 'cue', true)}${btn(92, 206, 'play', true)}
    ${btn(226, 206, 'cue', false)}${btn(target.x, target.y, 'play', false)}
    <!-- spotlight: everything but the control to use goes dark -->
    <mask id="mis-spot"><rect x="0" y="76" width="320" height="164" fill="#fff"/><circle cx="${target.x}" cy="${target.y}" r="24" fill="#000"/></mask>
    <rect x="0" y="76" width="320" height="164" fill="#040409" fill-opacity="0.62" mask="url(#mis-spot)"/>
    <circle cx="${target.x}" cy="${target.y}" r="38" fill="url(#mis-glow-green)" class="sc-ill__breathe" style="transform-origin:${target.x}px ${target.y}px"/>
    <path d="M${target.x - 3.5} ${target.y - 5}L${target.x + 5.5} ${target.y}L${target.x - 3.5} ${target.y + 5}Z" fill="${C.ledGreen}"/>
    <circle cx="${target.x}" cy="${target.y}" r="13" fill="none" stroke="${C.ledGreen}" stroke-width="2"/>
    ${tapMarker(target.x, target.y, '#ffffff')}
    <g class="sc-ill__bob">
      <rect x="${target.x - 52}" y="${target.y - 58}" width="50" height="22" rx="11" fill="#fff"/>
      <path d="M${target.x - 14} ${target.y - 37}l6 7l2 -7z" fill="#fff"/>
      <text x="${target.x - 27}" y="${target.y - 43}" text-anchor="middle" class="sc-ill__bubble">TAP</text>
    </g>
  `,
  );
}

// ───────────────────────────── 3: mixing in three moves ─────────────────────────────

export function mixArt(): string {
  const p = 'mix';
  const panel = (i: number, inner: string, caption: string): string => {
    const x = 8 + i * 104;
    return `<g transform="translate(${x} 0)">
      ${plate(p, 0, 22, 96, 172, 14)}
      <circle cx="16" cy="38" r="10" fill="url(#mix-aur)"/>
      <text x="16" y="42" text-anchor="middle" class="sc-ill__badge">${i + 1}</text>
      ${inner}
      <text x="48" y="220" text-anchor="middle" class="sc-ill__cap">${caption}</text>
    </g>`;
  };
  // 1: press PLAY on the other deck
  const one = `
    <circle cx="48" cy="104" r="34" fill="url(#mix-glow-green)" class="sc-ill__breathe" style="transform-origin:48px 104px"/>
    <circle cx="48" cy="104" r="24" fill="#08080d"/>
    <circle cx="48" cy="104" r="21" fill="url(#mix-rubber)" stroke="${C.ledGreen}" stroke-width="2.5"/>
    <path d="M41 93L60 104L41 115Z" fill="${C.ledGreen}"/>
    <text x="48" y="150" text-anchor="middle" class="sc-ill__silk">PLAY</text>
    <text x="48" y="172" text-anchor="middle" class="sc-ill__small">deck B</text>
    ${tapMarker(48, 104, '#ffffff')}`;
  // 2: the beats line up (SYNC, or the TEMPO fader by hand)
  let ticksA = '';
  let ticksB = '';
  for (let k = 0; k < 5; k++) {
    ticksA += `<rect x="${26 + k * 14}" y="${k === 0 ? 62 : 66}" width="3" height="${k === 0 ? 20 : 14}" rx="1.5" fill="${C.cyan}"/>`;
    ticksB += `<rect x="${26 + k * 14}" y="${k === 0 ? 92 : 96}" width="3" height="${k === 0 ? 20 : 14}" rx="1.5" fill="${C.pink}"/>`;
  }
  const two = `
    <text x="10" y="78" class="sc-ill__deckmini" fill="${C.cyan}">A</text>
    <g>${ticksA}</g>
    <g class="sc-ill__align">${ticksB}</g>
    <text x="10" y="108" class="sc-ill__deckmini" fill="${C.pink}">B</text>
    <rect x="22" y="132" width="52" height="24" rx="6" fill="url(#mix-rubber)" stroke="${C.cyan}" stroke-width="1.5" class="sc-ill__syncbtn"/>
    <text x="48" y="148" text-anchor="middle" class="sc-ill__btntext" fill="${C.cyan}">SYNC</text>
    <text x="48" y="174" text-anchor="middle" class="sc-ill__small">beats line up</text>`;
  // 3: slide the crossfader from A to B
  const three = `
    <text x="16" y="104" text-anchor="middle" class="sc-ill__deckmini" fill="${C.cyan}">A</text>
    <text x="80" y="104" text-anchor="middle" class="sc-ill__deckmini" fill="${C.pink}">B</text>
    <rect x="24" y="96" width="48" height="8" rx="4" fill="#000" stroke="#fff" stroke-opacity="0.08"/>
    ${[0, 1, 2, 3, 4].map((k) => `<rect x="${25 + k * 11.5}" y="84" width="1" height="6" fill="#fff" fill-opacity="0.3"/>`).join('')}
    <g class="sc-ill__xfade">
      <rect x="22" y="88" width="14" height="24" rx="3" fill="url(#mix-metal)"/>
      <rect x="22" y="99" width="14" height="2" fill="#222"/>
    </g>
    <path d="M30 128h34m-6 -5l6 5l-6 5" stroke="${C.ink}" stroke-opacity="0.7" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="48" y="150" text-anchor="middle" class="sc-ill__silk">CROSSFADER</text>
    <text x="48" y="172" text-anchor="middle" class="sc-ill__small">crowd hears B</text>`;
  return svg(
    p,
    `<rect x="0" y="0" width="320" height="240" fill="#06060c"/>
     ${panel(0, one, 'START')}${panel(1, two, 'MATCH')}${panel(2, three, 'SLIDE')}`,
  );
}

// ───────────────────────────── 4: keep the crowd hyped ─────────────────────────────

export function crowdArt(): string {
  const p = 'crowd';
  const people: { x: number; y: number; s: number; up: boolean; d: number }[] = [
    { x: 18, y: 214, s: 0.9, up: false, d: 0.1 },
    { x: 54, y: 206, s: 1.05, up: true, d: 0.35 },
    { x: 92, y: 216, s: 0.95, up: false, d: 0.2 },
    { x: 128, y: 204, s: 1.12, up: true, d: 0.5 },
    { x: 166, y: 212, s: 1.0, up: true, d: 0.05 },
    { x: 204, y: 206, s: 1.08, up: false, d: 0.42 },
    { x: 240, y: 214, s: 0.96, up: true, d: 0.25 },
    { x: 276, y: 206, s: 1.04, up: false, d: 0.6 },
    { x: 308, y: 216, s: 0.9, up: true, d: 0.15 },
  ];
  const person = (q: (typeof people)[number]): string => {
    const arms = q.up
      ? `<path d="M-12 -28L-22 -62M12 -28L22 -62" stroke="#0a0914" stroke-width="7" stroke-linecap="round"/>
         <path d="M-12 -28L-22 -62M12 -28L22 -62" stroke="url(#crowd-rim)" stroke-width="7" stroke-linecap="round" stroke-opacity="0.35"/>
         <circle cx="-22" cy="-64" r="5.5" fill="#0a0914" stroke="url(#crowd-rim)" stroke-opacity="0.8"/><circle cx="22" cy="-64" r="5.5" fill="#0a0914" stroke="url(#crowd-rim)" stroke-opacity="0.8"/>`
      : '';
    return `<g transform="translate(${q.x} ${q.y}) scale(${q.s})"><g class="sc-ill__dance" style="animation-delay:-${q.d}s">
      ${arms}
      <path d="M-20 30C-20 -6 -14 -24 0 -24C14 -24 20 -6 20 30Z" fill="#0a0914"/>
      <circle cx="0" cy="-38" r="12" fill="#0a0914"/>
      <path d="M-20 30C-20 -6 -14 -24 0 -24C14 -24 20 -6 20 30" fill="none" stroke="url(#crowd-rim)" stroke-width="1.5" stroke-opacity="0.7"/>
      <path d="M-11 -42A12 12 0 0 1 11 -42" fill="none" stroke="url(#crowd-rim)" stroke-width="1.5" stroke-opacity="0.8"/>
    </g></g>`;
  };
  return svg(
    p,
    `
    <rect x="0" y="0" width="320" height="240" fill="#06060c"/>
    <g class="sc-ill__beam" style="transform-origin:70px -10px"><polygon points="62,-10 78,-10 170,240 -20,240" fill="url(#crowd-beam-c)"/></g>
    <g class="sc-ill__beam sc-ill__beam--2" style="transform-origin:250px -10px"><polygon points="242,-10 258,-10 340,240 150,240" fill="url(#crowd-beam-p)"/></g>
    <ellipse cx="160" cy="150" rx="150" ry="60" fill="url(#crowd-glow-violet)" opacity="0.7"/>
    <!-- the hype meter -->
    <text x="36" y="34" class="sc-ill__hype">HYPE</text>
    <rect x="80" y="23" width="204" height="14" rx="7" fill="#000" stroke="#fff" stroke-opacity="0.1"/>
    <rect x="82" y="25" width="200" height="10" rx="5" fill="url(#crowd-hype)" class="sc-ill__meter" style="transform-origin:82px 30px"/>
    <ellipse cx="270" cy="30" rx="24" ry="16" fill="url(#crowd-glow-gold)" class="sc-ill__breathe" style="transform-origin:270px 30px"/>
    ${[0, 1, 2, 3].map((k) => `<path class="sc-ill__note sc-ill__note--${k}" d="M${92 + k * 52} 92v-16l10 -3v16" stroke="${[C.cyan, C.violet, C.pink, C.gold][k]}" stroke-width="2.5" fill="none" stroke-linecap="round"/><circle class="sc-ill__note sc-ill__note--${k}" cx="${89 + k * 52}" cy="92" r="4" fill="${[C.cyan, C.violet, C.pink, C.gold][k]}"/>`).join('')}
    ${people.map(person).join('')}
  `,
    `<linearGradient id="crowd-beam-c" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.cyan}" stop-opacity="0.45"/><stop offset="1" stop-color="${C.cyan}" stop-opacity="0"/></linearGradient>
     <linearGradient id="crowd-beam-p" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.pink}" stop-opacity="0.45"/><stop offset="1" stop-color="${C.pink}" stop-opacity="0"/></linearGradient>
     <linearGradient id="crowd-rim" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${C.cyan}"/><stop offset="1" stop-color="${C.pink}"/></linearGradient>
     <linearGradient id="crowd-hype" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${C.amber}"/><stop offset="1" stop-color="${C.gold}"/></linearGradient>`,
  );
}

// ───────────────────────────── 5: bring your own music ─────────────────────────────

export function ownMusicArt(): string {
  const p = 'own';
  let grooves = '';
  for (let r = 30; r < 70; r += 3.2) grooves += `<circle cx="0" cy="0" r="${r.toFixed(1)}" fill="none" stroke="#c8ccff" stroke-opacity="${(0.04 + ((r * 7) % 5) / 60).toFixed(3)}"/>`;
  return svg(
    p,
    `
    <rect x="0" y="0" width="320" height="240" fill="#06060c"/>
    <ellipse cx="236" cy="124" rx="96" ry="86" fill="url(#own-glow-violet)"/>
    <!-- the phone -->
    <rect x="26" y="20" width="104" height="200" rx="20" fill="#16161f" stroke="#3a3a4a" stroke-width="2"/>
    <rect x="33" y="27" width="90" height="186" rx="14" fill="#0b0b16"/>
    <rect x="62" y="31" width="32" height="7" rx="3.5" fill="#000"/>
    <text x="42" y="58" class="sc-ill__kicker">FILES</text>
    ${[0, 1, 2]
      .map(
        (k) => `<g opacity="${k === 0 ? 0 : 0.55}">
          <rect x="40" y="${68 + k * 34}" width="76" height="26" rx="7" fill="#1a1a2e"/>
          <rect x="46" y="${74 + k * 34}" width="14" height="14" rx="3.5" fill="${[C.cyan, C.violet, C.pink][k]}" fill-opacity="0.8"/>
          <rect x="65" y="${76 + k * 34}" width="${40 - k * 6}" height="4" rx="2" fill="#fff" fill-opacity="0.6"/>
          <rect x="65" y="${83 + k * 34}" width="24" height="3" rx="1.5" fill="#fff" fill-opacity="0.25"/>
        </g>`,
      )
      .join('')}
    <g class="sc-ill__fly">
      <rect x="40" y="68" width="76" height="26" rx="7" fill="#232342" stroke="${C.cyan}" stroke-width="1.5"/>
      <rect x="46" y="74" width="14" height="14" rx="3.5" fill="${C.cyan}"/>
      <path d="M51 85v-7l5 -1.5v7" stroke="#06060c" stroke-width="1.6" fill="none"/>
      <text x="65" y="81" class="sc-ill__file">my-song</text>
      <text x="65" y="89" class="sc-ill__ext">.mp3</text>
    </g>
    <!-- the lock: it stays here -->
    <g transform="translate(78 176)">
      <rect x="-34" y="-14" width="68" height="28" rx="14" fill="${C.mint}" fill-opacity="0.12" stroke="${C.mint}" stroke-opacity="0.6"/>
      <rect x="-23" y="-3" width="11" height="9" rx="2" fill="${C.mint}"/>
      <path d="M-21 -3v-3a3.5 3.5 0 0 1 7 0v3" stroke="${C.mint}" stroke-width="1.8" fill="none"/>
      <text x="-3" y="4.5" class="sc-ill__lock">LOCAL</text>
    </g>
    <!-- arrow to the deck -->
    <path d="M140 110h20m-7 -6l7 6l-7 6" stroke="${C.ink}" stroke-opacity="0.6" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <!-- the record on the deck -->
    <circle cx="242" cy="120" r="76" fill="#0a0a10" stroke="#2a2a38" stroke-width="2"/>
    <g transform="translate(242 120)"><g class="sc-ill__spin">
      <circle cx="0" cy="0" r="70" fill="#0b0b12"/>
      ${grooves}
      <circle cx="0" cy="0" r="24" fill="url(#own-aur)"/>
      <path d="M-24 0A24 24 0 0 1 24 0Z" fill="#0a0714" fill-opacity="0.85"/>
      <circle cx="0" cy="0" r="3.5" fill="#d9d9e4"/>
    </g></g>
    <path d="M190 64A70 70 0 0 1 232 50" stroke="${C.cyan}" stroke-opacity="0.5" stroke-width="3" fill="none" stroke-linecap="round"/>
    <path d="M296 160A70 70 0 0 1 262 188" stroke="${C.pink}" stroke-opacity="0.5" stroke-width="3" fill="none" stroke-linecap="round"/>
  `,
  );
}
