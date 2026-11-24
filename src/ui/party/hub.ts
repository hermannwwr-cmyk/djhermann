/**
 * The party hub: who you are (name + how hard your notes are), then the two ways in: HOST A PARTY
 * (this phone plays the music) or JOIN A PARTY (type the four letters from the DJ's phone).
 * Opened from an invite link, the code is already in and JOIN is the obvious next tap.
 */
import { ArrowRight, CircleAlert, LoaderCircle, Smartphone, Speaker } from 'lucide-static';
import { RoomError } from '../../core/party';
import type { RoomErrorCode } from '../../core/party';
import type { AppContext, Difficulty, Screen, ScreenParams } from '../../core/types';
import { add, art, h, icon } from '../screens/dom';
import { dismissTopLayer, topBar } from '../screens/ui';
import { createCodeInput } from './code-input';
import { NOTES_COPY, badLetters, codeProblem, roomErrorCopy, seatHue, suggestName } from './logic';
import { diffPicker, nameField } from './parts';

/** Phones around a speaker, four pads on each phone. */
const HERO_ART = `<svg viewBox="0 0 300 120" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="pt-aur" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#2de2ff"/><stop offset="0.52" stop-color="#8b6cff"/><stop offset="1" stop-color="#ff4fa8"/>
    </linearGradient>
    <radialGradient id="pt-spk-glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#8b6cff" stop-opacity="0.55"/><stop offset="1" stop-color="#8b6cff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="pt-metal" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2b2b3c"/><stop offset="1" stop-color="#14141d"/>
    </linearGradient>
  </defs>
  <circle cx="150" cy="62" r="62" fill="url(#pt-spk-glow)"/>
  <g class="pt-art__waves" stroke="url(#pt-aur)" stroke-width="2" stroke-linecap="round" opacity="0.9">
    <path d="M112 38a52 52 0 0 0 0 48"/><path d="M188 38a52 52 0 0 1 0 48"/>
    <path d="M100 28a68 68 0 0 0 0 68" opacity="0.55"/><path d="M200 28a68 68 0 0 1 0 68" opacity="0.55"/>
  </g>
  <rect x="124" y="20" width="52" height="84" rx="12" fill="url(#pt-metal)" stroke="rgba(255,255,255,0.14)"/>
  <circle cx="150" cy="40" r="9" fill="#08080d" stroke="rgba(255,255,255,0.12)"/>
  <circle cx="150" cy="40" r="3" fill="#8b6cff"/>
  <circle cx="150" cy="78" r="17" fill="#08080d" stroke="rgba(255,255,255,0.12)"/>
  <circle class="pt-art__cone" cx="150" cy="78" r="10" fill="#1d1d2a" stroke="url(#pt-aur)" stroke-width="2"/>
  <circle cx="150" cy="78" r="3.5" fill="#f4f3ff"/>
  ${phone(22, 34, -10)}
  ${phone(232, 34, 10)}
  ${phone(62, 70, -4, 0.75)}
  ${phone(198, 70, 4, 0.75)}
</svg>`;

function phone(x: number, y: number, rot: number, scale = 1): string {
  const pads = ['#2de2ff', '#6f8dff', '#b86bff', '#ff4fa8']
    .map((c, i) => `<rect x="${4 + i * 9}" y="40" width="7" height="7" rx="2" fill="${c}"/>`)
    .join('');
  const notes = `<rect x="13" y="12" width="7" height="3" rx="1.5" fill="#6f8dff" opacity="0.9"/><rect x="31" y="22" width="7" height="3" rx="1.5" fill="#ff4fa8" opacity="0.9"/><rect x="4" y="28" width="7" height="3" rx="1.5" fill="#2de2ff"/>`;
  return `<g transform="translate(${x} ${y}) rotate(${rot} 22 26) scale(${scale})" opacity="${scale < 1 ? 0.75 : 1}">
    <rect width="44" height="54" rx="8" fill="#0c0c16" stroke="rgba(255,255,255,0.22)"/>
    <rect x="3" y="4" width="38" height="46" rx="5" fill="#15152a"/>${notes}${pads}
  </g>`;
}

export function createHubScreen(ctx: AppContext): Screen<ScreenParams['party']> {
  const { nav, settings, party } = ctx;
  const el = h('div', 'sc-screen pt-hub');
  const body = h('div', 'sc-body sc-body--fade ui-scroll pt-hub__body');
  add(el, topBar('Party mode', () => nav.back()), body);

  // ── who you are ──
  const name = nameField(settings.get().playerName || 'DJ', seatHue(2), (n) => settings.set({ playerName: n }));
  const diff = diffPicker(settings.get().difficulty, NOTES_COPY, (d: Difficulty) => settings.set({ difficulty: d }));
  const you = h(
    'section',
    'pt-you',
    h('div', 'pt-you__head', h('h2', 'sc-h', 'You'), h('span', 'pt-you__hint', 'Your friends see this name')),
    name.el,
    h('h2', 'sc-h pt-you__notes', 'Your notes'),
    diff.el,
  );

  // ── host ──
  const hostBtn = h('button', 'ui-btn ui-btn--lg ui-btn--block pt-go', h('span', null, 'Host a party'), icon(ArrowRight));
  hostBtn.type = 'button';
  hostBtn.dataset.act = 'host';
  const hostErr = h('div', 'pt-err');
  hostErr.setAttribute('role', 'alert');
  const hostCard = h(
    'section',
    'pt-card pt-card--host',
    h(
      'div',
      'pt-card__head',
      h('span', 'pt-card__icon', icon(Speaker)),
      h('span', 'pt-card__text', h('span', 'pt-card__title', 'HOST A PARTY'), h('span', 'pt-card__line', 'This phone plays the music. Best with a speaker.')),
    ),
    hostErr,
    hostBtn,
  );

  // ── join ──
  const joinBtn = h('button', 'ui-btn ui-btn--lg ui-btn--block pt-go', h('span', null, 'Join'), icon(ArrowRight));
  joinBtn.type = 'button';
  joinBtn.dataset.act = 'join';
  const joinErr = h('div', 'pt-err');
  joinErr.setAttribute('role', 'alert');
  const invite = h('div', 'pt-card__invite');
  const code = createCodeInput({
    onChange: (c, typed) => {
      showError(joinErr, null);
      paintJoin();
      const problem = codeProblem(c);
      if (problem === 'letters') {
        code.reject();
        showError(joinErr, { title: 'Check the letters', body: `Party codes never use ${badLetters(c).join(' or ')}.` });
      } else if (typed && problem === null) {
        // all four letters typed: go, the keyboard has done its job
        code.input.blur();
        void join();
      }
    },
    onSubmit: () => void join(),
  });
  const joinCard = h(
    'section',
    'pt-card pt-card--join',
    h(
      'div',
      'pt-card__head',
      h('span', 'pt-card__icon', icon(Smartphone)),
      h('span', 'pt-card__text', h('span', 'pt-card__title', 'JOIN A PARTY'), h('span', 'pt-card__line', 'Type the code from the DJ’s phone.')),
    ),
    invite,
    code.el,
    joinErr,
    joinBtn,
  );

  const hero = h(
    'div',
    'pt-hub__hero',
    art(HERO_ART, 'pt-hub__art'),
    h('h1', 'pt-hub__title', 'Play ', h('span', 'ui-aurora-text', 'together')),
    h('p', 'pt-hub__line', 'One phone plays the music. Everyone else plays the pads on their own phone.'),
  );
  const cards = h('div', 'pt-hub__cards');
  add(body, hero, you, cards);

  let busy: 'host' | 'join' | null = null;

  function showError(box: HTMLElement, copy: { title: string; body: string } | null): void {
    box.replaceChildren();
    box.classList.toggle('pt-err--on', !!copy);
    if (copy) add(box, icon(CircleAlert), h('p', null, h('b', null, copy.title), ' ', copy.body));
  }

  function setBusy(which: 'host' | 'join' | null): void {
    busy = which;
    el.classList.toggle('pt-hub--busy', !!which);
    for (const [b, w, label] of [
      [hostBtn, 'host', 'Host a party'],
      [joinBtn, 'join', 'Join'],
    ] as const) {
      b.replaceChildren(
        ...(which === w ? [icon(LoaderCircle, 'pt-spin'), h('span', null, 'Connecting')] : [h('span', null, label), icon(ArrowRight)]),
      );
      b.disabled = !!which;
    }
    paintJoin();
  }

  function paintJoin(): void {
    const ready = codeProblem(code.value) === null;
    joinBtn.classList.toggle('ui-btn--primary', ready);
    joinCard.classList.toggle('pt-card--ready', ready);
  }

  function me(): { name: string; difficulty: Difficulty } {
    const s = settings.get();
    return { name: s.playerName || name.value, difficulty: s.difficulty };
  }

  async function host(): Promise<void> {
    if (busy) return;
    showError(hostErr, null);
    setBusy('host');
    try {
      await party.host(me());
      if (nav.current === 'party') nav.go('lobby');
    } catch (err) {
      const c: RoomErrorCode = err instanceof RoomError ? err.code : 'network';
      const copy = roomErrorCopy(c);
      showError(hostErr, { title: c === 'network' ? 'Could not start a party.' : copy.title, body: copy.body });
    } finally {
      setBusy(null);
    }
  }

  async function join(): Promise<void> {
    if (busy) return;
    const c = code.value;
    const problem = codeProblem(c);
    if (problem) {
      code.reject();
      showError(
        joinErr,
        problem === 'short'
          ? { title: 'Four letters, please.', body: 'The code is on the DJ’s phone, under PARTY CODE.' }
          : { title: 'Check the letters', body: `Party codes never use ${badLetters(c).join(' or ')}.` },
      );
      if (problem === 'short') code.focus();
      return;
    }
    showError(joinErr, null);
    setBusy('join');
    try {
      await party.join(c, me());
      if (nav.current === 'party') nav.go('lobby');
    } catch (err) {
      const rc: RoomErrorCode = err instanceof RoomError ? err.code : 'network';
      code.reject();
      showError(joinErr, roomErrorCopy(rc, c));
    } finally {
      setBusy(null);
    }
  }

  hostBtn.addEventListener('click', () => void host());
  joinBtn.addEventListener('click', () => void join());

  return {
    el,
    enter(params) {
      if (!settings.get().playerName) settings.set({ playerName: suggestName() });
      name.set(settings.get().playerName);
      diff.set(settings.get().difficulty);
      showError(hostErr, null);
      showError(joinErr, null);
      setBusy(null);
      const invited = params?.code ?? '';
      code.set(invited);
      invite.replaceChildren();
      if (invited) add(invite, 'You’re invited to party ', h('b', null, invited), '. Check your name, then tap JOIN.');
      el.classList.toggle('pt-hub--invited', !!invited);
      // an invite puts JOIN first; otherwise the DJ (usually the first one here) sees HOST first
      cards.replaceChildren(...(invited ? [joinCard, hostCard] : [hostCard, joinCard]));
      paintJoin();
      body.scrollTop = 0;
    },
    leave() {
      (document.activeElement as HTMLElement | null)?.blur?.();
    },
    back: () => dismissTopLayer(el),
  };
}
