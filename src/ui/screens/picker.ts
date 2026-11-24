/**
 * The track picker: a bottom sheet over the game (free play) listing every track as the library
 * shows it, with a way to load the player's own music right there. Resolves with the chosen
 * track's id, or null when the sheet is closed without a choice.
 */
import { ChevronDown, ChevronUp, Upload } from 'lucide-static';
import type { AppContext, DeckId, TrackMeta } from '../../core/types';
import { add, button, clear, h, icon } from './dom';
import { audioFileInput, createImportPanel, importFiles, importNotes } from './importer';
import { buzz } from './shared';
import { openSheet, toast, trackRow } from './ui';

export interface TrackPickerOptions {
  title?: string;
}

export function openTrackPicker(ctx: AppContext, host: HTMLElement, opts: TrackPickerOptions = {}): Promise<string | null> {
  const { library, engine, settings } = ctx;
  let picked: string | null = null;

  const sheet = openSheet(host, { title: opts.title ?? 'Pick a track', className: 'sc-picker', tall: true });
  sheet.el.dataset.sheet = 'picker';

  // ── load your own ──
  const input = audioFileInput((files) => void runImport(files));
  const panel = createImportPanel(() => input.open(), true);
  const notes = importNotes();
  notes.classList.add('sc-picker__notes');
  const moreLabel = h('span', null, 'What files work?');
  const moreIcon = h('span', 'sc-picker__moreicon', icon(ChevronDown));
  const more = h('button', 'sc-link sc-picker__more', moreLabel, moreIcon);
  more.type = 'button';
  let notesOpen = false;
  notes.hidden = true;
  more.addEventListener('click', () => {
    notesOpen = !notesOpen;
    notes.hidden = !notesOpen;
    moreIcon.replaceChildren(icon(notesOpen ? ChevronUp : ChevronDown));
  });
  const own = h('section', 'sc-picker__own', panel.el, more, notes, input.el);

  const list = h('div', 'sc-list');
  add(sheet.body, list, own);

  const fresh = new Set<string>();

  function onDeck(id: string): DeckId | null {
    for (const d of ['A', 'B'] as const) {
      try {
        if (engine.getDeck(d).track?.id === id) return d;
      } catch {
        /* engine not ready */
      }
    }
    return null;
  }

  function choose(meta: TrackMeta): void {
    picked = meta.id;
    buzz(settings, 10);
    void sheet.close();
  }

  function render(): void {
    clear(list);
    const all = library.list();
    let lastSource: string | null = null;
    for (const m of all) {
      if (m.source !== lastSource) {
        list.appendChild(h('div', 'sc-list__label', m.source === 'user' ? 'Your music' : 'Built-in tracks'));
        lastSource = m.source;
      }
      const deck = onDeck(m.id);
      const row = trackRow(m, {
        onTap: () => choose(m),
        coverSize: 48,
        tag: fresh.has(m.id) ? 'NEW' : deck ? `ON DECK ${deck}` : undefined,
      });
      if (deck) row.classList.add(`sc-track--deck${deck}`);
      list.appendChild(row);
    }
  }

  async function runImport(files: File[]): Promise<void> {
    if (panel.busy) return;
    const outcome = await importFiles(library, files, (p) => panel.progress(p));
    for (const m of outcome.added) fresh.add(m.id);
    panel.errors(outcome.failed);
    render();
    if (outcome.added.length > 0) {
      toast(host, outcome.added.length === 1 ? `Added “${outcome.added[0].title}”. Tap it to play it.` : `Added ${outcome.added.length} songs`, 'good');
      const row = list.querySelector<HTMLElement>(`[data-track="${CSS.escape(outcome.added[0].id)}"]`);
      row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  const unsubscribe = library.subscribe(render);
  render();

  // a quick way to the upload button when the list is long
  const jump = button({
    className: 'sc-chipbtn sc-picker__jump',
    icon: Upload,
    label: 'Your own music',
    ariaLabel: 'Load your own music',
    onTap: () => own.scrollIntoView({ block: 'start', behavior: 'smooth' }),
  });
  jump.dataset.act = 'jump-own';
  sheet.el.querySelector('.sc-sheet__head')?.insertBefore(jump, sheet.el.querySelector('.sc-sheet__head [data-act="close"]'));

  return sheet.closed.then(() => {
    unsubscribe();
    return picked;
  });
}
