/**
 * The host's set in the lobby, picked the same way as on the "Play a gig" screen: the chain of
 * covers (with a warning when two neighbours are too far apart in tempo), and a sheet with every
 * track to add or take out. Reuses the menus' setlist logic, track rows and styles.
 */
import { Check, Plus, TriangleAlert } from 'lucide-static';
import type { Library, TrackMeta } from '../../core/types';
import { add, button, clear, h, icon } from '../screens/dom';
import { SETLIST_MAX, SETLIST_MIN, formatBpm, recommendSetlist, setlistIssues, tooFarApart } from '../screens/logic';
import { cover, openSheet, toast, trackRow } from '../screens/ui';

/** The host's last set, kept while the page is open so PLAY AGAIN comes back to it. */
let remembered: string[] = [];

export interface SetPicker {
  readonly el: HTMLElement;
  /** the chosen track ids, in play order */
  readonly ids: string[];
  readonly ready: boolean;
  /** open the sheet with every track */
  edit(): void;
  refresh(): void;
}

export function createSetPicker(library: Library, host: HTMLElement, onChange: () => void): SetPicker {
  const strip = h('button', 'sc-set pt-set');
  strip.type = 'button';
  strip.dataset.act = 'set';
  strip.setAttribute('aria-label', 'Change the set');
  const warn = h('div', 'sc-warn');
  warn.setAttribute('role', 'status');
  const el = h('div', 'pt-setpick', strip, warn);
  let selected: string[] = remembered.filter((id) => library.get(id));
  if (selected.length < SETLIST_MIN) selected = recommendSetlist(library.list());

  const metas = (): TrackMeta[] => selected.map((id) => library.get(id)).filter((m): m is TrackMeta => !!m);

  function renderStrip(): void {
    selected = selected.filter((id) => library.get(id));
    remembered = [...selected];
    const set = metas();
    clear(strip);
    set.forEach((m, i) => {
      if (i > 0) {
        const bad = tooFarApart(set[i - 1].grid.bpm, m.grid.bpm);
        strip.appendChild(h('span', `sc-set__link${bad ? ' sc-set__link--bad' : ''}`, icon(bad ? TriangleAlert : Check)));
      }
      strip.appendChild(
        h(
          'span',
          'sc-set__slot',
          h('span', 'sc-set__cover', cover(m, 52), h('span', 'sc-num', String(i + 1))),
          h('span', 'sc-set__title', m.title),
          h('span', 'sc-set__bpm ui-num', `${formatBpm(m.grid.bpm)} BPM`),
        ),
      );
    });
    if (set.length < SETLIST_MAX) {
      if (set.length > 0) strip.appendChild(h('span', 'sc-set__link sc-set__link--none'));
      strip.appendChild(
        h(
          'span',
          'sc-set__slot sc-set__slot--empty',
          h('span', 'sc-set__cover', icon(Plus)),
          h('span', 'sc-set__title', set.length < SETLIST_MIN ? 'Pick a track' : 'Add one'),
          h('span', 'sc-set__bpm', ' '),
        ),
      );
    }
    clear(warn);
    const issues = setlistIssues(set);
    if (issues.length > 0) {
      const first = issues[0];
      add(
        warn,
        icon(TriangleAlert),
        h(
          'p',
          null,
          h('b', null, `${first.from.title} and ${first.to.title} are too far apart to match speeds.`),
          ' Tap the set to swap one, or the beats will clash.',
        ),
      );
    }
    warn.classList.toggle('sc-warn--on', issues.length > 0);
  }

  function edit(): void {
    const sheet = openSheet(host, { title: 'Tonight’s set', tall: true });
    const list = h('div', 'sc-list');
    const note = h('p', 'sc-note', 'Tap tracks to add or take them out. They play in the order you pick them.');
    const done = button({ className: 'ui-btn ui-btn--primary', label: 'Done' });
    done.dataset.act = 'done';
    done.addEventListener('click', () => void sheet.close());
    add(sheet.body, note, list);
    add(sheet.foot, done);

    const renderList = (): void => {
      clear(list);
      const full = selected.length >= SETLIST_MAX;
      for (const m of library.list()) {
        const pos = selected.indexOf(m.id);
        const badge = pos >= 0 ? h('span', 'sc-num sc-num--lg', String(pos + 1)) : h('span', 'sc-pick', icon(Plus));
        const row = trackRow(m, { trailing: badge, coverSize: 44, onTap: () => toggle(m.id) });
        row.classList.toggle('sc-track--on', pos >= 0);
        row.classList.toggle('sc-track--dim', pos < 0 && full);
        list.appendChild(row);
      }
      done.disabled = selected.length < SETLIST_MIN;
      (done.lastElementChild as HTMLElement).textContent =
        selected.length < SETLIST_MIN ? `Pick ${SETLIST_MIN - selected.length} more` : 'Done';
    };
    const toggle = (id: string): void => {
      const i = selected.indexOf(id);
      if (i >= 0) selected.splice(i, 1);
      else if (selected.length >= SETLIST_MAX) {
        toast(sheet.el, `A set is ${SETLIST_MAX} tracks at most. Tap a numbered one to take it out.`);
        return;
      } else selected.push(id);
      renderList();
      renderStrip();
      onChange();
    };
    renderList();
    void sheet.closed.then(() => {
      if (selected.length < SETLIST_MIN) selected = recommendSetlist(library.list());
      renderStrip();
      onChange();
    });
  }

  strip.addEventListener('click', edit);
  renderStrip();

  return {
    el,
    get ids() {
      return [...selected];
    },
    get ready() {
      return selected.length >= SETLIST_MIN;
    },
    edit,
    refresh: renderStrip,
  };
}
