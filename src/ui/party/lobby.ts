/**
 * The room lobby. The party code, big enough to read across a room, and a way to send the invite
 * link; everyone in the room, live. The host picks the set and how hard it is, can take a player
 * out, and starts the party. A player sees who they are waiting for, can change their name and
 * difficulty, and is taken to their pads the moment the host starts.
 */
import { Crown, LogOut, Play, Share2, UserX, Wifi, WifiOff, X } from 'lucide-static';
import { MAX_PLAYERS } from '../../core/party';
import type { PlayerInfo, RoomClient, RoomErrorCode } from '../../core/party';
import type { AppContext, Difficulty, GameParams, Screen } from '../../core/types';
import { add, button, clear, h, icon } from '../screens/dom';
import { DIFFICULTY_COPY } from '../screens/logic';
import { buzz } from '../screens/shared';
import { confirmDialog, dismissTopLayer, toast, topBar } from '../screens/ui';
import { NOTES_COPY, hostOf, roomErrorCopy, roomLink, seatHue, sortPlayers, waitingLine } from './logic';
import { avatar, diffPicker, nameField, partySession, stateCard, waitingBars } from './parts';
import { createSetPicker } from './setlist';
import type { SetPicker } from './setlist';

const PIPS: Record<Difficulty, number> = { chill: 1, club: 2, festival: 3 };

export function createLobbyScreen(ctx: AppContext): Screen<undefined> {
  const { nav, settings, party, library } = ctx;
  const el = h('div', 'sc-screen pt-lobby');
  const top = topBar('Party', () => void askLeave(), null, X);
  top.querySelector('[data-act="back"]')?.setAttribute('aria-label', 'Leave the party');
  const banner = h('div', 'pt-banner');
  banner.setAttribute('role', 'status');
  const body = h('div', 'sc-body sc-body--fade ui-scroll pt-lobby__body');
  const foot = h('footer', 'sc-foot pt-lobby__foot');
  add(el, top, banner, body, foot);

  let room: RoomClient | null = null;
  let offs: (() => void)[] = [];
  let known = new Set<string>();
  let setPicker: SetPicker | null = null;
  let ended = false;

  // pieces rebuilt on enter
  const playersBox = h('div', 'pt-players');
  const playersCount = h('span', 'sc-count');
  const startNote = h('div', 'sc-foot__note');

  // ───────────── room code ─────────────

  function codeBlock(r: RoomClient): HTMLElement {
    const keys = h('div', 'pt-room__code');
    keys.setAttribute('aria-label', `Party code ${r.code.split('').join(' ')}`);
    [...r.code].forEach((ch, i) => {
      const k = h('span', 'pt-key', h('span', 'pt-key__char', ch));
      k.style.setProperty('--i', String(i));
      k.setAttribute('aria-hidden', 'true');
      keys.appendChild(k);
    });
    const share = button({ className: 'ui-btn pt-share', icon: Share2, label: 'Invite friends' });
    share.dataset.act = 'share';
    share.addEventListener('click', () => void invite(r.code));
    const where = typeof location !== 'undefined' ? location.host : '';
    return h(
      'section',
      'pt-room',
      h('div', 'pt-room__label', 'Party code'),
      keys,
      h('p', 'pt-room__how', 'Friends open ', h('b', null, where || 'the game'), ', tap ', h('b', null, 'PARTY'), ' and type this code.'),
      share,
    );
  }

  async function invite(code: string): Promise<void> {
    const url = roomLink(code, location.origin, location.pathname);
    const text = `Join my DJ party! Code ${code}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: 'DJ Hermann party', text, url });
        return;
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return; // the player closed the share sheet
    }
    try {
      await navigator.clipboard.writeText(url);
      toast(el, 'Invite link copied. Paste it in your group chat.', 'good');
    } catch {
      toast(el, `Tell your friends the code: ${code}`);
    }
  }

  // ───────────── players ─────────────

  function playerRow(p: PlayerInfo, r: RoomClient): HTMLElement {
    const isMe = p.pid === r.pid;
    const isHost = p.role === 'host';
    const pips = h('span', `pt-pips pt-pips--${p.difficulty}`);
    for (let i = 1; i <= 3; i++) pips.appendChild(h('i', i <= PIPS[p.difficulty] ? 'on' : null));
    const tags = h(
      'span',
      'pt-player__tags',
      isHost ? h('span', 'pt-tag pt-tag--dj', icon(Crown), 'DJ') : null,
      isMe ? h('span', 'pt-tag pt-tag--you', 'YOU') : null,
    );
    const state = p.connected
      ? h('span', 'pt-player__state', h('i', 'pt-led'), isHost ? 'Plays the music' : 'Ready')
      : h('span', 'pt-player__state pt-player__state--off', h('i', 'pt-led pt-led--off'), 'Reconnecting…');
    const row = h(
      'div',
      `pt-player${isMe ? ' pt-player--me' : ''}${p.connected ? '' : ' pt-player--off'}`,
      avatar(p.name, seatHue(p.seat)),
      h(
        'span',
        'pt-player__text',
        h('span', 'pt-player__nameline', h('span', 'pt-player__name', p.name), tags),
        h('span', 'pt-player__sub', state, h('span', 'pt-player__diff', pips, DIFFICULTY_COPY[p.difficulty].name)),
      ),
    );
    row.dataset.pid = p.pid;
    if (!known.has(p.pid)) row.classList.add('pt-player--new');
    if (r.role === 'host' && !isHost) {
      const kick = button({ className: 'ui-iconbtn pt-kick', icon: UserX, ariaLabel: `Take ${p.name} out of the party` });
      kick.dataset.act = 'kick';
      kick.addEventListener('click', () => void askKick(p));
      row.appendChild(kick);
    }
    return row;
  }

  function renderPlayers(): void {
    const r = room;
    if (!r) return;
    clear(playersBox);
    const list = sortPlayers(r.players);
    for (const p of list) playersBox.appendChild(playerRow(p, r));
    const others = list.filter((p) => p.role !== 'host').length;
    if (others === 0) {
      const empty = h(
        r.role === 'host' ? 'button' : 'div',
        'pt-player pt-player--empty',
        waitingBars(),
        h(
          'span',
          'pt-player__text',
          h('span', 'pt-player__name', 'Waiting for friends'),
          h('span', 'pt-player__sub', r.role === 'host' ? 'Tap to send them the invite' : 'They join with the code above'),
        ),
      );
      if (empty instanceof HTMLButtonElement) {
        empty.type = 'button';
        empty.dataset.act = 'invite';
        empty.addEventListener('click', () => void invite(r.code));
      }
      playersBox.appendChild(empty);
    }
    known = new Set(list.map((p) => p.pid));
    playersCount.textContent = `${list.length} of ${MAX_PLAYERS}`;
    renderFoot();
  }

  async function askKick(p: PlayerInfo): Promise<void> {
    const ok = await confirmDialog(el, {
      title: `Take ${p.name} out?`,
      body: `${p.name}’s phone leaves the party. They can join again with the code.`,
      confirm: 'Take out',
      cancel: 'Keep',
      danger: true,
    });
    if (ok) room?.kick(p.pid);
  }

  // ───────────── host: set + difficulty ─────────────

  function hostSettings(): HTMLElement {
    setPicker = createSetPicker(library, el, () => renderFoot());
    const change = button({ className: 'sc-link', label: 'Change', onTap: () => setPicker?.edit() });
    change.dataset.act = 'change-set';
    const diff = diffPicker(settings.get().difficulty, DIFFICULTY_COPY, (d) => {
      settings.set({ difficulty: d });
      room?.setMe({ difficulty: d });
      renderFoot();
    });
    return h(
      'div',
      'pt-lobby__host',
      h('section', 'sc-section', h('div', 'sc-section__head', h('h2', 'sc-h', 'Tonight’s set'), change), setPicker.el),
      h('section', 'sc-section', h('div', 'sc-section__head', h('h2', 'sc-h', 'How hard?')), diff.el),
    );
  }

  // ───────────── player: you ─────────────

  function playerSettings(r: RoomClient): HTMLElement {
    const me = r.me;
    const name = nameField(me?.name ?? settings.get().playerName, seatHue(me?.seat ?? 1), (n) => {
      settings.set({ playerName: n });
      room?.setMe({ name: n });
    });
    const diff = diffPicker(me?.difficulty ?? settings.get().difficulty, NOTES_COPY, (d) => {
      settings.set({ difficulty: d });
      room?.setMe({ difficulty: d });
    });
    return h(
      'section',
      'sc-section pt-lobby__you',
      h('div', 'sc-section__head', h('h2', 'sc-h', 'You')),
      name.el,
      h('h2', 'sc-h pt-you__notes', 'Your notes'),
      diff.el,
    );
  }

  // ───────────── foot ─────────────

  function renderFoot(): void {
    const r = room;
    clear(foot);
    if (!r || ended) return;
    if (r.role === 'host') {
      const ready = setPicker?.ready ?? false;
      const start = h('button', 'ui-btn ui-btn--primary ui-btn--lg ui-btn--block', icon(Play, 'sc-fillicon'), h('span', null, 'Start the party'));
      start.type = 'button';
      start.dataset.act = 'start';
      start.disabled = !ready || r.status !== 'open';
      start.addEventListener('click', startGig);
      const friends = r.players.filter((p) => p.role !== 'host' && p.connected).length;
      startNote.textContent = !ready
        ? 'Pick at least two tracks.'
        : friends === 0
          ? 'You can start alone: friends can join while you play.'
          : `${friends} friend${friends === 1 ? '' : 's'} ready · ${DIFFICULTY_COPY[settings.get().difficulty].name.toLowerCase()}`;
      add(foot, start, startNote);
    } else {
      const host = hostOf(r.players);
      const lost = !!host && !host.connected;
      add(
        foot,
        h(
          'div',
          `pt-wait${lost ? ' pt-wait--lost' : ''}`,
          lost ? h('span', 'pt-wait__icon', icon(WifiOff)) : waitingBars(),
          h(
            'span',
            'pt-wait__text',
            h('span', 'pt-wait__title', lost ? `${host!.name}’s phone dropped out` : waitingLine(host)),
            h(
              'span',
              'pt-wait__sub',
              lost ? 'Waiting for it to come back. You can stay here.' : 'Keep this screen open. Your pads appear when the music starts.',
            ),
          ),
        ),
      );
    }
  }

  function startGig(): void {
    const r = room;
    if (!r || !setPicker?.ready) return;
    buzz(settings, 14);
    const params: GameParams = { mode: 'gig', setlist: setPicker.ids, difficulty: settings.get().difficulty, party: true };
    r.setPhase('loading', params);
    nav.go('game', params);
  }

  // ───────────── status / errors ─────────────

  function renderStatus(): void {
    const r = room;
    const s = r?.status;
    banner.replaceChildren();
    banner.className = 'pt-banner';
    if (s === 'reconnecting' || s === 'connecting') {
      banner.classList.add('pt-banner--on');
      add(banner, icon(Wifi), h('span', null, h('b', null, 'Reconnecting… '), 'Your phone lost the party for a moment.'));
    }
    renderFoot();
  }

  function showEnded(code: RoomErrorCode): void {
    if (ended) return;
    ended = true;
    const copy =
      code === 'not-found'
        ? { title: 'The party is over', body: 'The DJ closed this party. Start your own, or join another one.' }
        : roomErrorCopy(code);
    const home = button({ className: 'ui-btn ui-btn--primary ui-btn--lg', label: 'Back to the start' });
    home.dataset.act = 'home';
    home.addEventListener('click', () => {
      party.leave();
      nav.go('home');
    });
    const again = button({ className: 'ui-btn ui-btn--ghost', label: 'Join another party' });
    again.dataset.act = 'party';
    again.addEventListener('click', () => {
      party.leave();
      nav.go('party');
    });
    banner.replaceChildren();
    banner.className = 'pt-banner';
    body.replaceChildren(
      h('div', 'pt-lobby__ended', stateCard({ icon: code === 'network' ? WifiOff : LogOut, tone: 'bad', title: copy.title, body: copy.body, actions: [home, again] })),
    );
    clear(foot);
  }

  // ───────────── leave ─────────────

  async function askLeave(): Promise<void> {
    const r = room;
    if (!r || ended) {
      party.leave();
      nav.go('home');
      return;
    }
    const isHost = r.role === 'host';
    const ok = await confirmDialog(el, {
      title: isHost ? 'End the party?' : 'Leave the party?',
      body: isHost
        ? 'Everyone else’s phone leaves the party too.'
        : `You can come back any time with the code ${r.code}.`,
      confirm: isHost ? 'End party' : 'Leave',
      cancel: 'Stay',
      danger: true,
    });
    if (!ok) return;
    party.leave();
    nav.go('home');
  }

  // ───────────── build ─────────────

  function onPhase(phase: string): void {
    const r = room;
    if (!r || r.role !== 'player') return;
    if (phase === 'loading' || phase === 'playing') {
      partySession.doneWith = '';
      if (nav.current === 'lobby') nav.go('controller');
    }
  }

  function build(r: RoomClient): void {
    ended = false;
    known = new Set(r.players.map((p) => p.pid));
    setPicker = null;
    body.replaceChildren(
      codeBlock(r),
      r.role === 'host' ? hostSettings() : playerSettings(r),
      h('section', 'sc-section', h('div', 'sc-section__head', h('h2', 'sc-h', 'Who’s here'), playersCount), playersBox),
    );
    el.dataset.role = r.role;
    renderPlayers();
    renderStatus();
  }

  return {
    el,
    enter() {
      for (const off of offs) off();
      offs = [];
      const r = party.room;
      room = r;
      if (!r || r.status === 'closed') {
        // nothing to show: the room went away while we were elsewhere
        if (r) showEnded('not-found');
        else {
          ended = false;
          window.setTimeout(() => nav.go('party'), 0);
        }
        return;
      }
      build(r);
      offs.push(
        r.on('players', renderPlayers),
        r.on('status', renderStatus),
        r.on('phase', ({ phase }) => onPhase(phase)),
        r.on('error', ({ code }) => showEnded(code)),
        party.subscribe((now) => {
          if (now !== room && !ended && nav.current === 'lobby') showEnded('not-found');
        }),
      );
      if (r.role === 'host') {
        // back from a gig (PLAY AGAIN): the room is a lobby again
        if (r.phase !== 'lobby') r.setPhase('lobby');
      } else if ((r.phase === 'loading' || r.phase === 'playing') && partySession.doneWith !== r.code) {
        // joined while the music is already on
        window.setTimeout(() => {
          if (nav.current === 'lobby' && room === r) nav.go('controller');
        }, 0);
      }
      body.scrollTop = 0;
    },
    leave() {
      for (const off of offs) off();
      offs = [];
      (document.activeElement as HTMLElement | null)?.blur?.();
    },
    back() {
      if (dismissTopLayer(el)) return true;
      void askLeave();
      return true;
    },
  };
}
