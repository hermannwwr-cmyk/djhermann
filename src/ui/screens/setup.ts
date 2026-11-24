/**
 * Before a gig: pick how hard it should be and which tracks to play, in which order.
 * A good set is already chosen, so the quickest path is one tap on START.
 */
import { Check, GraduationCap, Play, Plus, TriangleAlert, Upload, WandSparkles } from 'lucide-static';
import type { AppContext, Difficulty, Screen, TrackMeta } from '../../core/types';
import { add, button, clear, h, icon } from './dom';
import {
  DIFFICULTIES,
  DIFFICULTY_COPY,
  SETLIST_MAX,
  SETLIST_MIN,
  formatBpm,
  recommendSetlist,
  setlistIssues,
  tooFarApart,
  tutorialParams,
} from './logic';
import { buzz } from './shared';
import { cover, dismissTopLayer, toast, topBar, trackRow } from './ui';

const PIPS: Record<Difficulty, number> = { chill: 1, club: 2, festival: 3 };

export function createSetupScreen(ctx: AppContext): Screen<undefined> {
  const { nav, settings, library } = ctx;
  const el = h('div', 'sc-screen sc-setup');
  const body = h('div', 'sc-body sc-body--fade ui-scroll');

  const lesson = h('div', 'sc-setup__lesson');
  const diffs = h('div', 'sc-diffs');
  diffs.setAttribute('role', 'radiogroup');
  diffs.setAttribute('aria-label', 'Difficulty');
  const setStrip = h('div', 'sc-set');
  const warn = h('div', 'sc-warn');
  warn.setAttribute('role', 'status');
  const list = h('div', 'sc-list');
  const recommendBtn = button({ className: 'sc-link', icon: WandSparkles, label: 'Recommended', onTap: () => useRecommended() });
  recommendBtn.dataset.act = 'recommend';

  const startLabel = h('span', null, 'START THE GIG');
  const start = h('button', 'ui-btn ui-btn--primary ui-btn--lg ui-btn--block', icon(Play, 'sc-fillicon'), startLabel);
  start.type = 'button';
  start.dataset.act = 'start';
  const startNote = h('div', 'sc-foot__note');

  add(
    body,
    lesson,
    h('section', 'sc-section', h('div', 'sc-section__head', h('h2', 'sc-h', 'How hard?')), diffs),
    h('section', 'sc-section', h('div', 'sc-section__head', h('h2', 'sc-h', 'Your set'), recommendBtn), setStrip, warn),
    h('section', 'sc-section', h('div', 'sc-section__head', h('h2', 'sc-h', 'Tap tracks to add or remove them')), list),
  );
  add(el, topBar('Play a gig', () => nav.back()), body, h('footer', 'sc-foot', start, startNote));

  let difficulty: Difficulty = settings.get().difficulty;
  let selected: string[] = [];
  let unsubscribe: (() => void) | null = null;

  const metas = (): TrackMeta[] => selected.map((id) => library.get(id)).filter((m): m is TrackMeta => !!m);

  function useRecommended(): void {
    selected = recommendSetlist(library.list());
    renderSet();
  }

  function toggleTrack(id: string): void {
    const i = selected.indexOf(id);
    if (i >= 0) selected.splice(i, 1);
    else if (selected.length >= SETLIST_MAX) {
      toast(el, `A set is ${SETLIST_MAX} tracks at most. Tap a numbered track to take it out.`);
      return;
    } else selected.push(id);
    buzz(settings, 8);
    renderSet();
  }

  function renderDifficulty(): void {
    clear(diffs);
    for (const d of DIFFICULTIES) {
      const copy = DIFFICULTY_COPY[d];
      const pips = h('span', 'sc-diff__pips');
      for (let i = 1; i <= 3; i++) pips.appendChild(h('i', i <= PIPS[d] ? 'on' : null));
      const b = h(
        'button',
        `sc-diff sc-diff--${d}`,
        pips,
        h('span', 'sc-diff__text', h('span', 'sc-diff__name', copy.name), h('span', 'sc-diff__line', copy.line)),
        h('span', 'sc-diff__radio', icon(Check)),
      );
      b.type = 'button';
      b.dataset.diff = d;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(d === difficulty));
      b.addEventListener('click', () => {
        if (difficulty === d) return;
        difficulty = d;
        settings.set({ difficulty: d });
        buzz(settings, 8);
        for (const other of Array.from(diffs.children)) {
          other.setAttribute('aria-checked', String((other as HTMLElement).dataset.diff === d));
        }
      });
      diffs.appendChild(b);
    }
  }

  function renderSet(): void {
    // forget tracks that are no longer in the library
    selected = selected.filter((id) => library.get(id));
    const set = metas();
    const issues = setlistIssues(set);

    // the chain: cover, link, cover, link, ...
    clear(setStrip);
    set.forEach((m, i) => {
      if (i > 0) {
        const bad = tooFarApart(set[i - 1].grid.bpm, m.grid.bpm);
        setStrip.appendChild(h('span', `sc-set__link${bad ? ' sc-set__link--bad' : ''}`, icon(bad ? TriangleAlert : Check)));
      }
      const slot = h(
        'button',
        'sc-set__slot',
        h('span', 'sc-set__cover', cover(m, 56), h('span', 'sc-num', String(i + 1))),
        h('span', 'sc-set__title', m.title),
        h('span', 'sc-set__bpm ui-num', `${formatBpm(m.grid.bpm)} BPM`),
      );
      slot.type = 'button';
      slot.setAttribute('aria-label', `Track ${i + 1}: ${m.title}. Tap to take it out.`);
      slot.addEventListener('click', () => toggleTrack(m.id));
      setStrip.appendChild(slot);
    });
    if (set.length < SETLIST_MAX) {
      if (set.length > 0) setStrip.appendChild(h('span', 'sc-set__link sc-set__link--none'));
      setStrip.appendChild(
        h(
          'span',
          'sc-set__slot sc-set__slot--empty',
          h('span', 'sc-set__cover', icon(Plus)),
          h('span', 'sc-set__title', set.length < SETLIST_MIN ? 'Pick a track' : 'Optional'),
          h('span', 'sc-set__bpm', ' '),
        ),
      );
    }

    // tempo warning, in plain words
    clear(warn);
    if (issues.length > 0) {
      const first = issues[0];
      add(
        warn,
        icon(TriangleAlert),
        h(
          'p',
          null,
          h('b', null, `${first.from.title} and ${first.to.title} are too far apart to match speeds`),
          ` (${formatBpm(first.from.grid.bpm)} and ${formatBpm(first.to.grid.bpm)} BPM). Swap one for a track with a closer BPM, or the beats will clash.`,
          issues.length > 1 ? ` ${issues.length - 1} more pair${issues.length > 2 ? 's have' : ' has'} the same problem.` : null,
        ),
      );
    }
    warn.classList.toggle('sc-warn--on', issues.length > 0);

    // the library
    clear(list);
    const all = library.list();
    const full = selected.length >= SETLIST_MAX;
    let lastSource: string | null = null;
    for (const m of all) {
      if (m.source !== lastSource && m.source === 'user') list.appendChild(h('div', 'sc-list__label', 'Your music'));
      lastSource = m.source;
      const pos = selected.indexOf(m.id);
      const badge = pos >= 0 ? h('span', 'sc-num sc-num--lg', String(pos + 1)) : h('span', 'sc-pick', icon(Plus));
      const row = trackRow(m, { trailing: badge, onTap: () => toggleTrack(m.id), coverSize: 48 });
      row.classList.toggle('sc-track--on', pos >= 0);
      row.classList.toggle('sc-track--dim', pos < 0 && full);
      (row.firstElementChild as HTMLElement).setAttribute('aria-pressed', String(pos >= 0));
      list.appendChild(row);
    }
    const own = button({ className: 'sc-chipbtn', icon: Upload, label: 'Load your own music', onTap: () => nav.go('library') });
    own.dataset.act = 'library';
    list.appendChild(h('div', 'sc-list__more', own));

    // start button
    const ready = set.length >= SETLIST_MIN;
    start.disabled = !ready;
    startLabel.textContent = ready ? 'START THE GIG' : `PICK ${SETLIST_MIN - set.length} MORE TRACK${SETLIST_MIN - set.length === 1 ? '' : 'S'}`;
    startNote.textContent = ready
      ? `${set.length} tracks · ${DIFFICULTY_COPY[difficulty].name.charAt(0)}${DIFFICULTY_COPY[difficulty].name.slice(1).toLowerCase()}`
      : 'A gig needs at least two tracks to mix.';
    recommendBtn.disabled = sameIds(selected, recommendSetlist(all));
  }

  function renderLesson(): void {
    clear(lesson);
    const show = !settings.get().tutorialDone;
    lesson.hidden = !show;
    if (!show) return;
    const go = button({
      className: 'sc-chipbtn',
      label: 'Learn first',
      onTap: () => nav.go('game', tutorialParams(library.list())),
    });
    go.dataset.act = 'learn';
    add(lesson, icon(GraduationCap), h('p', null, h('b', null, 'New here?'), ' The 2-minute lesson shows you every move.'), go);
  }

  start.addEventListener('click', () => {
    const setlist = metas().map((m) => m.id);
    if (setlist.length < SETLIST_MIN) return;
    buzz(settings, 14);
    nav.go('game', { mode: 'gig', setlist, difficulty });
  });

  return {
    el,
    enter() {
      difficulty = settings.get().difficulty;
      selected = selected.filter((id) => library.get(id));
      if (selected.length < SETLIST_MIN) selected = recommendSetlist(library.list());
      renderLesson();
      renderDifficulty();
      renderSet();
      body.scrollTop = 0;
      unsubscribe?.();
      unsubscribe = library.subscribe(() => renderSet());
    },
    leave() {
      unsubscribe?.();
      unsubscribe = null;
    },
    back: () => dismissTopLayer(el),
  };
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}
