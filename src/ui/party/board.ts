/**
 * The party leaderboard, in two sizes:
 *
 *   createBoardChip(deps)          a small live board for a corner of the playfield (host + players)
 *   renderBoardList(board, myPid)  the full board for the results
 *
 * The chip redraws only when the board changes, and rows slide to their new place when someone
 * overtakes someone.
 */
import './party.css';
import { Crown, Unplug } from 'lucide-static';
import { hashString } from '../../core/math';
import type { BoardEntry } from '../../core/party';
import type { Component, FrameState } from '../../core/types';
import { add, h, icon } from '../screens/dom';
import { formatPercent, formatScore } from '../screens/logic';
import { boardWindow, initial, rankBoard, shortScore } from './logic';
import type { RankedEntry } from './logic';

export interface BoardChipDeps {
  getBoard: () => BoardEntry[];
  /** this phone's player id (its row is highlighted and always shown) */
  myPid: string;
}

/** rows shown at most */
const CHIP_ROWS = 4;
/** px per row (must match .pt-chip__row height in party.css) */
const ROW_H = 24;
/** how often the board is read, ms */
const POLL_MS = 200;

const hueOf = (pid: string): number => hashString(pid) % 360;

interface ChipRow {
  el: HTMLElement;
  rank: HTMLElement;
  name: HTMLElement;
  score: HTMLElement;
  key: string;
  index: number;
}

export function createBoardChip(deps: BoardChipDeps): Component {
  const list = h('div', 'pt-chip__list');
  const el = h('div', 'pt-chip', list);
  el.setAttribute('role', 'status');
  el.setAttribute('aria-label', 'Leaderboard');
  el.hidden = true;
  const rows = new Map<string, ChipRow>();
  let lastPoll = -1e9;
  let shownSig = '';

  function rowFor(e: RankedEntry): ChipRow {
    let r = rows.get(e.pid);
    if (!r) {
      const rank = h('span', 'pt-chip__rank ui-num');
      const name = h('span', 'pt-chip__name');
      const score = h('span', 'pt-chip__score ui-num');
      const row = h('div', 'pt-chip__row', rank, name, score);
      list.appendChild(row);
      r = { el: row, rank, name, score, key: '', index: -1 };
      rows.set(e.pid, r);
    }
    return r;
  }

  function render(board: BoardEntry[]): void {
    const ranked = rankBoard(board, deps.myPid);
    const shown = boardWindow(ranked, CHIP_ROWS);
    const sig = shown.map((e) => `${e.pid}:${e.rank}:${e.score}:${e.connected ? 1 : 0}:${e.name}`).join('|');
    if (sig === shownSig) return;
    shownSig = sig;
    // a board of one is no race: show it once there is someone to race
    el.hidden = ranked.length < 2;
    const keep = new Set<string>();
    shown.forEach((e, i) => {
      keep.add(e.pid);
      const r = rowFor(e);
      const detached = i === shown.length - 1 && i > 0 && e.rank > shown[i - 1].rank + 1;
      const key = `${e.rank}|${e.name}|${e.score}|${e.connected}|${e.me}|${detached}`;
      if (key !== r.key) {
        r.key = key;
        r.rank.textContent = String(e.rank);
        r.name.textContent = e.me ? 'YOU' : e.name;
        r.score.textContent = shortScore(e.score);
        r.el.classList.toggle('pt-chip__row--me', e.me);
        r.el.classList.toggle('pt-chip__row--first', e.rank === 1);
        r.el.classList.toggle('pt-chip__row--off', !e.connected);
        r.el.classList.toggle('pt-chip__row--detached', detached);
      }
      if (r.index !== i) {
        // moving up the board: a short flash so the overtake is seen
        if (r.index > i && e.me) {
          r.el.classList.remove('pt-chip__row--up');
          void r.el.offsetWidth;
          r.el.classList.add('pt-chip__row--up');
        }
        r.index = i;
        r.el.style.transform = `translateY(${i * ROW_H}px)`;
      }
    });
    for (const [pid, r] of rows) {
      if (!keep.has(pid)) {
        r.el.remove();
        rows.delete(pid);
      }
    }
    list.style.height = `${shown.length * ROW_H}px`;
  }

  return {
    el,
    update(frame: FrameState) {
      if (frame.now - lastPoll < POLL_MS) return;
      lastPoll = frame.now;
      render(deps.getBoard());
    },
    destroy() {
      el.remove();
      rows.clear();
    },
  };
}

export interface BoardListOptions {
  /** most rows to show (the player's own row is always kept) */
  max?: number;
}

/** The full board: medal ranks, avatar, name, host and "you" tags, score, accuracy and best combo. */
export function renderBoardList(board: readonly BoardEntry[], myPid: string, opts: BoardListOptions = {}): HTMLElement {
  const ranked = rankBoard(board, myPid);
  const shown = opts.max ? boardWindow(ranked, opts.max) : ranked;
  const list = h('ol', 'pt-board');
  shown.forEach((e, i) => {
    const medal = e.rank <= 3 ? ` pt-board__rank--${e.rank}` : '';
    const av = h('span', 'pt-avatar pt-avatar--sm', initial(e.name));
    av.style.setProperty('--hue', String(hueOf(e.pid)));
    const tags = h(
      'span',
      'pt-board__tags',
      e.role === 'host' ? h('span', 'pt-tag pt-tag--dj', icon(Crown), 'DJ') : null,
      e.me ? h('span', 'pt-tag pt-tag--you', 'YOU') : null,
      e.connected ? null : h('span', 'pt-tag pt-tag--off', icon(Unplug), 'LEFT'),
    );
    const row = h(
      'li',
      `pt-board__row${e.me ? ' pt-board__row--me' : ''}${e.connected ? '' : ' pt-board__row--off'}`,
      h('span', `pt-board__rank ui-num${medal}`, String(e.rank)),
      av,
      h(
        'span',
        'pt-board__who',
        h('span', 'pt-board__nameline', h('span', 'pt-board__name', e.name), tags),
        h('span', 'pt-board__sub', `${formatPercent(e.accuracy)} accuracy · best combo ${e.maxCombo}`),
      ),
      h('span', 'pt-board__score ui-num', formatScore(e.score)),
    );
    row.style.setProperty('--i', String(i));
    if (i > 0 && e.rank > shown[i - 1].rank + 1) row.classList.add('pt-board__row--gap');
    list.appendChild(row);
  });
  if (shown.length === 0) add(list, h('li', 'pt-board__empty', 'No scores yet.'));
  return list;
}
