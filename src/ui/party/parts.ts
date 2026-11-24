/**
 * Small pieces the party screens share: avatar, name field, difficulty switch, a big state card,
 * and what the party screens remember between visits.
 */
import { Check, Dices } from 'lucide-static';
import { MAX_NAME_LENGTH } from '../../core/party';
import type { Difficulty } from '../../core/types';
import { add, button, h, icon } from '../screens/dom';
import type { Child } from '../screens/dom';
import { DIFFICULTIES } from '../screens/logic';
import { cleanName, initial, roomParam, suggestName } from './logic';

/** What the party screens remember for as long as the page is open. */
export const partySession = {
  /** rooms whose players were already told to turn their volume down */
  reminded: new Set<string>(),
  /**
   * The player saw the results of the gig in this room and went back to the lobby: until the host
   * starts the next one, the lobby must not send them back into the old one.
   */
  doneWith: '' as string,
};

export function avatar(name: string, hue: number, size: 'sm' | 'md' | 'lg' = 'md'): HTMLElement {
  const a = h('span', `pt-avatar pt-avatar--${size}`, initial(name));
  a.style.setProperty('--hue', String(hue));
  a.setAttribute('aria-hidden', 'true');
  return a;
}

export interface NameField {
  readonly el: HTMLElement;
  readonly value: string;
  set(name: string): void;
}

/**
 * The player's name with a dice button for a fun one. `onCommit` gets the cleaned name when the
 * player is done typing (blur / Enter) or rolls the dice. An empty field commits a suggestion.
 */
export function nameField(start: string, hue: number, onCommit: (name: string) => void): NameField {
  const av = avatar(start, hue, 'md');
  const input = h('input', 'pt-name__input');
  input.type = 'text';
  input.value = start;
  input.maxLength = MAX_NAME_LENGTH * 2;
  input.setAttribute('autocomplete', 'nickname');
  input.setAttribute('autocapitalize', 'words');
  input.setAttribute('spellcheck', 'false');
  input.setAttribute('enterkeyhint', 'done');
  input.setAttribute('aria-label', 'Your name');
  input.dataset.act = 'name';
  const dice = button({ className: 'pt-name__dice', icon: Dices, ariaLabel: 'Pick a fun name' });
  dice.dataset.act = 'dice';
  const el = h('div', 'pt-name', av, input, dice);
  let value = start;

  const paintAvatar = (): void => {
    av.textContent = initial(input.value || value);
  };
  const commit = (): void => {
    let name = cleanName(input.value);
    if (!name) name = suggestName();
    input.value = name;
    paintAvatar();
    if (name === value) return;
    value = name;
    onCommit(name);
  };
  input.addEventListener('input', paintAvatar);
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    }
  });
  dice.addEventListener('click', () => {
    let next = suggestName();
    for (let i = 0; i < 4 && next === value; i++) next = suggestName();
    input.value = next;
    dice.classList.remove('pt-name__dice--roll');
    void dice.offsetWidth;
    dice.classList.add('pt-name__dice--roll');
    commit();
  });

  return {
    el,
    get value() {
      return value;
    },
    set(name) {
      value = name;
      if (document.activeElement !== input) input.value = name;
      paintAvatar();
    },
  };
}

const PIPS: Record<Difficulty, number> = { chill: 1, club: 2, festival: 3 };

export interface DiffPicker {
  readonly el: HTMLElement;
  set(d: Difficulty): void;
}

/** Three-way difficulty switch with level pips, and one line saying what the choice means. */
export function diffPicker(
  start: Difficulty,
  copy: Record<Difficulty, { name: string; line: string }>,
  onChange: (d: Difficulty) => void,
): DiffPicker {
  const seg = h('div', 'pt-seg');
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-label', 'Difficulty');
  const line = h('p', 'pt-seg__line');
  const el = h('div', 'pt-diff', seg, line);
  let value = start;
  const buttons = DIFFICULTIES.map((d) => {
    const pips = h('span', 'pt-seg__pips');
    for (let i = 1; i <= 3; i++) pips.appendChild(h('i', i <= PIPS[d] ? 'on' : null));
    const b = h('button', `pt-seg__opt pt-seg__opt--${d}`, pips, h('span', null, copy[d].name));
    b.type = 'button';
    b.dataset.diff = d;
    b.setAttribute('role', 'radio');
    b.addEventListener('click', () => {
      if (value === d) return;
      set(d);
      onChange(d);
    });
    seg.appendChild(b);
    return b;
  });
  function set(d: Difficulty): void {
    value = d;
    for (const b of buttons) b.setAttribute('aria-checked', String(b.dataset.diff === d));
    line.replaceChildren(icon(Check), copy[d].line);
    el.dataset.diff = d;
  }
  set(start);
  return { el, set };
}

export interface StateCardOptions {
  icon: string;
  tone?: 'info' | 'bad' | 'good';
  title: string;
  body: string;
  actions?: Child[];
  /** a live animated "waiting" equaliser instead of a still icon */
  busy?: boolean;
}

/** A centred card for a state the player has to know about (paused, reconnecting, the party ended). */
export function stateCard(opts: StateCardOptions): HTMLElement {
  const badge = h('div', `pt-state__badge pt-state__badge--${opts.tone ?? 'info'}`, icon(opts.icon));
  if (opts.busy) badge.appendChild(h('span', 'pt-state__ring'));
  const card = h('div', 'pt-state', badge, h('h2', 'pt-state__title', opts.title), h('p', 'pt-state__body', opts.body));
  if (opts.actions?.length) add(card, h('div', 'pt-state__actions', ...opts.actions));
  return card;
}

/** Three bouncing bars: "something is going on, keep waiting". */
export function waitingBars(): HTMLElement {
  const e = h('span', 'pt-eq', h('i'), h('i'), h('i'), h('i'));
  e.setAttribute('aria-hidden', 'true');
  return e;
}

let inviteTaken = false;

/**
 * The room code the page was opened with (?room=CODE), once per page load; the parameter is
 * removed from the address bar so a reload or a later visit home does not join again.
 */
export function takeRoomInvite(): string | null {
  if (inviteTaken || typeof location === 'undefined') return null;
  inviteTaken = true;
  const code = roomParam(location.search);
  if (new URLSearchParams(location.search).has('room')) {
    try {
      const url = new URL(location.href);
      url.searchParams.delete('room');
      history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    } catch {
      /* history unavailable: harmless */
    }
  }
  return code;
}
