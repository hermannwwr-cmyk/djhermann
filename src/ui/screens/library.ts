/**
 * My Music: the built-in tracks and the player's own. Own songs are loaded here (files stay on
 * the device), get a beat check after analysis, and can be deleted.
 */
import { Metronome, Trash2 } from 'lucide-static';
import type { AppContext, Screen, TrackMeta } from '../../core/types';
import { openBeatCheck } from './beatcheck';
import { add, button, clear, h } from './dom';
import { audioFileInput, createImportPanel, importFiles, importNotes } from './importer';
import { confidenceInfo } from './logic';
import { recordElement } from './record';
import { confirmDialog, dismissTopLayer, toast, topBar, trackRow } from './ui';

export function createLibraryScreen(ctx: AppContext): Screen<undefined> {
  const { nav, library } = ctx;
  const el = h('div', 'sc-screen sc-library');
  const body = h('div', 'sc-body sc-body--fade ui-scroll');

  const input = audioFileInput((files) => void runImport(files));
  const panel = createImportPanel(() => input.open());
  const mineList = h('div', 'sc-list');
  const builtinList = h('div', 'sc-list');
  const mineCount = h('span', 'sc-count');

  add(
    body,
    h('section', 'sc-section sc-library__load', panel.el, importNotes()),
    h('section', 'sc-section', h('div', 'sc-section__head', h('h2', 'sc-h', 'Your music'), mineCount), mineList),
    h(
      'section',
      'sc-section',
      h('div', 'sc-section__head', h('h2', 'sc-h', 'Built-in tracks'), h('span', 'sc-count', 'Original music made for this game')),
      builtinList,
    ),
  );
  add(el, topBar('My music', () => nav.back()), body, input.el);

  /** ids imported during this visit: they carry a NEW tag */
  const fresh = new Set<string>();
  let unsubscribe: (() => void) | null = null;
  let active = false;

  async function runImport(files: File[]): Promise<void> {
    if (panel.busy) return;
    body.scrollTo({ top: 0, behavior: 'smooth' });
    const outcome = await importFiles(library, files, (p) => panel.progress(p));
    for (const m of outcome.added) fresh.add(m.id);
    panel.errors(outcome.failed);
    render();
    if (!active) return;
    if (outcome.added.length > 0) {
      toast(el, outcome.added.length === 1 ? `Added “${outcome.added[0].title}”` : `Added ${outcome.added.length} songs`, 'good');
      // check the beat of every new song, one after another; closing a check ends the round
      for (let i = 0; i < outcome.added.length; i++) {
        if (!active) return;
        const r = await openBeatCheck(ctx, el, outcome.added[i].id, { position: { index: i, total: outcome.added.length } });
        if (r === 'closed') break;
      }
    }
  }

  async function remove(meta: TrackMeta): Promise<void> {
    const yes = await confirmDialog(el, {
      title: `Delete “${meta.title}”?`,
      body: 'It is removed from the game only. The file on your device stays where it is.',
      confirm: 'Delete',
      danger: true,
    });
    if (!yes) return;
    try {
      await library.remove(meta.id);
      toast(el, 'Song removed');
    } catch (err) {
      console.error('[library] could not remove', err);
      toast(el, 'Could not remove that song. Try again.', 'bad');
    }
  }

  function render(): void {
    const all = library.list();
    const mine = all.filter((t) => t.source === 'user');
    const builtin = all.filter((t) => t.source === 'builtin');
    mineCount.textContent = mine.length > 0 ? `${mine.length} song${mine.length === 1 ? '' : 's'}` : '';

    clear(mineList);
    if (mine.length === 0) {
      mineList.appendChild(
        h(
          'div',
          'sc-empty',
          recordElement(72, 'logo', 'sc-empty__rec'),
          h('div', null, h('div', 'sc-empty__title', 'Nothing of yours yet'), h('p', null, 'Load a song and it shows up here, ready for the decks.')),
        ),
      );
    }
    for (const m of mine) {
      const unsure = confidenceInfo(m.gridConfidence).level <= 2;
      const check = button({
        className: `sc-chipbtn${unsure ? ' sc-chipbtn--warn' : ''}`,
        icon: Metronome,
        label: unsure ? 'Check the beat' : 'Beat check',
        onTap: () => void openBeatCheck(ctx, el, m.id),
      });
      check.dataset.act = 'beatcheck';
      const del = button({ className: 'sc-chipbtn sc-chipbtn--quiet', icon: Trash2, label: 'Delete', onTap: () => void remove(m) });
      del.dataset.act = 'delete';
      mineList.appendChild(trackRow(m, { tag: fresh.has(m.id) ? 'NEW' : undefined, below: h('div', 'sc-track__actions', check, del) }));
    }

    clear(builtinList);
    for (const m of builtin) builtinList.appendChild(trackRow(m));
  }

  return {
    el,
    enter() {
      active = true;
      fresh.clear();
      panel.idle();
      render();
      body.scrollTop = 0;
      unsubscribe?.();
      unsubscribe = library.subscribe(render);
    },
    leave() {
      active = false;
      unsubscribe?.();
      unsubscribe = null;
      // a beat check left open would keep deck A busy
      while (dismissTopLayer(el)) {
        /* close every layer */
      }
    },
    back: () => dismissTopLayer(el),
  };
}
