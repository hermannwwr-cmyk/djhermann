/**
 * Loading the player's own music: the file input, running the imports one after another with
 * visible progress, and the words that go with it (what loads, what does not, where files stay).
 * Shared by the My Music screen and the track picker.
 */
import { Ban, CircleAlert, Lock, Music, Upload } from 'lucide-static';
import { ImportError } from '../../core/types';
import type { ImportErrorCode, Library, TrackMeta } from '../../core/types';
import { add, button, clear, h, icon } from './dom';
import { importErrorCopy } from './logic';
import { recordElement } from './record';

export const AUDIO_ACCEPT = 'audio/*,.mp3,.wav,.m4a,.flac,.aac,.ogg,.oga,.opus,.aif,.aiff';

export interface ImportFailure {
  name: string;
  code: ImportErrorCode;
}

export interface ImportOutcome {
  added: TrackMeta[];
  failed: ImportFailure[];
}

export interface ImportProgress {
  /** 0-based index of the file being imported */
  index: number;
  total: number;
  name: string;
  /** 0..1 for this file */
  progress: number;
  stage: string;
}

/** Import files one at a time (decoding is heavy; phones cannot do several at once). Never rejects. */
export async function importFiles(
  library: Library,
  files: File[],
  onProgress: (p: ImportProgress) => void,
): Promise<ImportOutcome> {
  const out: ImportOutcome = { added: [], failed: [] };
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const report = (progress: number, stage?: string): void =>
      onProgress({ index: i, total: files.length, name: file.name, progress, stage: stage ?? 'Working' });
    report(0, 'Reading file');
    try {
      out.added.push(await library.importFile(file, report));
    } catch (err) {
      const code: ImportErrorCode = err instanceof ImportError ? err.code : 'unknown';
      if (!(err instanceof ImportError)) console.error('[import] unexpected error', err);
      out.failed.push({ name: file.name, code });
    }
  }
  return out;
}

/** A hidden <input type="file"> for audio. Call open() from a tap. */
export function audioFileInput(onFiles: (files: File[]) => void): { el: HTMLInputElement; open(): void } {
  const el = document.createElement('input');
  el.type = 'file';
  el.accept = AUDIO_ACCEPT;
  el.multiple = true;
  el.className = 'sc-fileinput';
  el.tabIndex = -1;
  el.setAttribute('aria-hidden', 'true');
  el.addEventListener('change', () => {
    const files = Array.from(el.files ?? []);
    el.value = ''; // picking the same file again must fire "change" again
    if (files.length > 0) onFiles(files);
  });
  return { el, open: () => el.click() };
}

/** The three things the player must know before picking a file. */
export function importNotes(): HTMLElement {
  const line = (svg: string, tone: string, strong: string, rest: string): HTMLElement => {
    const li = h('li', `sc-notes__item sc-notes__item--${tone}`, icon(svg), h('span', null, h('b', null, strong), rest));
    return li;
  };
  return h(
    'ul',
    'sc-notes',
    line(Lock, 'good', 'Stays on this device.', ' Your files are never uploaded.'),
    line(Music, 'info', 'Use files you own:', ' MP3, WAV, M4A or FLAC.'),
    line(
      Ban,
      'warn',
      'Streaming songs will not load.',
      ' Music from Spotify, Apple Music, YouTube Music or Tidal is copy-protected.',
    ),
  );
}

export interface ImportPanel {
  el: HTMLElement;
  /** show the idle state: the big button */
  idle(): void;
  progress(p: ImportProgress): void;
  /** show what failed (and return to idle underneath) */
  errors(failed: ImportFailure[]): void;
  readonly busy: boolean;
}

/** The import block: big button → progress → errors. `onPick` opens the file input. */
export function createImportPanel(onPick: () => void, compact = false): ImportPanel {
  const el = h('div', `sc-import${compact ? ' sc-import--compact' : ''}`);
  const pick = button({
    className: `ui-btn ui-btn--primary ${compact ? '' : 'ui-btn--lg '}ui-btn--block`,
    icon: Upload,
    label: 'Load your own music',
    onTap: onPick,
  });
  pick.dataset.act = 'import';

  const bar = h('span', 'sc-progress__fill');
  const count = h('div', 'sc-import__count');
  const name = h('div', 'sc-import__name');
  const stage = h('div', 'sc-import__stage');
  const pct = h('span', 'sc-import__pct ui-num');
  const working = h(
    'div',
    'sc-import__working',
    recordElement(56, 'logo', 'sc-import__rec'),
    h('div', 'sc-import__text', count, name, h('div', 'sc-import__stageline', stage, pct), h('div', 'sc-progress', bar)),
  );
  working.setAttribute('role', 'status');

  const errorBox = h('div', 'sc-import__errors');
  let busy = false;

  function idle(): void {
    busy = false;
    working.remove();
    if (!pick.isConnected) el.prepend(pick);
  }

  add(el, pick, errorBox);

  return {
    el,
    idle,
    get busy() {
      return busy;
    },
    progress(p) {
      if (!busy) {
        busy = true;
        clear(errorBox);
        pick.remove();
        el.prepend(working);
      }
      count.textContent = p.total > 1 ? `Adding song ${p.index + 1} of ${p.total}` : 'Adding your song';
      name.textContent = p.name;
      stage.textContent = p.stage;
      const overall = Math.min(1, Math.max(0, p.progress));
      pct.textContent = `${Math.round(overall * 100)}%`;
      bar.style.transform = `scaleX(${Math.max(0.02, overall)})`;
    },
    errors(failed) {
      idle();
      clear(errorBox);
      if (failed.length === 0) return;
      for (const f of failed) {
        const copy = importErrorCopy(f.code);
        const item = h(
          'div',
          'sc-import__error',
          icon(CircleAlert),
          h('div', null, h('div', 'sc-import__errtitle', copy.title), h('div', 'sc-import__errfile', f.name), h('p', null, copy.body)),
        );
        item.dataset.code = f.code;
        errorBox.appendChild(item);
      }
      const ok = button({ className: 'sc-chipbtn', label: 'OK', onTap: () => clear(errorBox) });
      ok.dataset.act = 'dismiss-errors';
      errorBox.appendChild(h('div', 'sc-import__errok', ok));
      errorBox.setAttribute('role', 'alert');
    },
  };
}
