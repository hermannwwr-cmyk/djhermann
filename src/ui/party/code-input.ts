/**
 * The four-letter room code box. One real <input> lies over four big letter cells, so the phone
 * keyboard, autofill and paste all just work: letters are upper-cased as they are typed, anything
 * else is dropped, a pasted invite link gives its code, and the caret walks from cell to cell.
 */
import { ROOM_CODE_LENGTH } from '../../core/party';
import { h } from '../screens/dom';
import { cleanCodeInput } from './logic';

export interface CodeInput {
  readonly el: HTMLElement;
  readonly input: HTMLInputElement;
  readonly value: string;
  set(code: string): void;
  focus(): void;
  /** a wrong code: a short shake and red cells until the next edit */
  reject(): void;
}

export interface CodeInputOptions {
  /** the code changed; `typed` is false when it was set from code */
  onChange?: (code: string, typed: boolean) => void;
  /** Enter / Go on the keyboard */
  onSubmit?: () => void;
}

export function createCodeInput(opts: CodeInputOptions = {}): CodeInput {
  const cells: HTMLElement[] = [];
  const row = h('div', 'pt-code__cells');
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    const c = h('span', 'pt-code__cell', h('span', 'pt-code__char'), h('i', 'pt-code__caret'));
    c.style.setProperty('--i', String(i));
    cells.push(c);
    row.appendChild(c);
  }
  const input = h('input', 'pt-code__input');
  input.type = 'text';
  input.setAttribute('autocapitalize', 'characters');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('spellcheck', 'false');
  input.setAttribute('inputmode', 'text');
  input.setAttribute('enterkeyhint', 'go');
  input.setAttribute('aria-label', 'Party code, four letters');
  input.dataset.act = 'code';
  const el = h('label', 'pt-code', row, input);

  let value = '';

  function paint(prev: string): void {
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      const ch = value[i] ?? '';
      const cell = cells[i];
      const charEl = cell.firstElementChild as HTMLElement;
      if (charEl.textContent !== ch) {
        charEl.textContent = ch;
        if (ch && ch !== prev[i]) {
          cell.classList.remove('pt-code__cell--pop');
          void cell.offsetWidth;
          cell.classList.add('pt-code__cell--pop');
        }
      }
      cell.classList.toggle('pt-code__cell--on', !!ch);
      cell.classList.toggle('pt-code__cell--cur', i === Math.min(value.length, ROOM_CODE_LENGTH - 1));
    }
    el.classList.toggle('pt-code--full', value.length === ROOM_CODE_LENGTH);
  }

  function apply(raw: string, typed: boolean): void {
    const prev = value;
    value = cleanCodeInput(raw);
    if (input.value !== value) input.value = value;
    // keep the caret at the end: the cells only make sense typed left to right
    try {
      input.setSelectionRange(value.length, value.length);
    } catch {
      /* not focusable right now */
    }
    el.classList.remove('pt-code--bad');
    paint(prev);
    if (value !== prev) opts.onChange?.(value, typed);
  }

  input.addEventListener('input', () => apply(input.value, true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      opts.onSubmit?.();
    }
  });
  const sync = (): void => el.classList.toggle('pt-code--focus', document.activeElement === input);
  input.addEventListener('focus', () => {
    sync();
    try {
      input.setSelectionRange(value.length, value.length);
    } catch {
      /* ignore */
    }
  });
  input.addEventListener('blur', sync);
  paint('');

  return {
    el,
    input,
    get value() {
      return value;
    },
    set(code) {
      apply(code, false);
    },
    focus() {
      input.focus({ preventScroll: true });
    },
    reject() {
      el.classList.remove('pt-code--bad');
      void el.offsetWidth;
      el.classList.add('pt-code--bad');
    },
  };
}
