/**
 * The party screens' pure logic: room-code input, player names, leaderboard ranking and the plain
 * words for every way joining can fail. No DOM in here, so all of it is unit-tested.
 */
import { MAX_NAME_LENGTH, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, isRoomCode } from '../../core/party';
import type { BoardEntry, PlayerInfo, RemoteHud, RoomErrorCode } from '../../core/party';
import type { Difficulty } from '../../core/types';

// ───────────────────────────── room codes ─────────────────────────────

/**
 * What the code box keeps of whatever was typed or pasted: a pasted invite link gives its
 * ?room= code, anything else is upper-cased and reduced to its first four letters.
 */
export function cleanCodeInput(raw: string): string {
  const link = /[?&#]room=([A-Za-z]{1,8})/.exec(raw);
  const src = link ? link[1] : raw;
  return src
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, ROOM_CODE_LENGTH);
}

export type CodeProblem = 'short' | 'letters' | null;

/** Why a code cannot be sent yet: too short, or it has letters no code uses (I and O). */
export function codeProblem(code: string): CodeProblem {
  if (code.length < ROOM_CODE_LENGTH) return 'short';
  return isRoomCode(code) ? null : 'letters';
}

/** Letters of `code` that never appear in a room code. */
export const badLetters = (code: string): string[] => [...new Set([...code].filter((c) => !ROOM_CODE_ALPHABET.includes(c)))];

/** The invite link for a room: this page with ?room=CODE (any other query and hash dropped). */
export function roomLink(code: string, origin: string, pathname = '/'): string {
  return `${origin}${pathname}?room=${code}`;
}

/**
 * The room code an invite link opened the page with, or null. A code with letters codes never use
 * is still returned (cleaned), so the join box can show it and explain.
 */
export function roomParam(search: string): string | null {
  const v = new URLSearchParams(search).get('room');
  if (!v) return null;
  const code = cleanCodeInput(v);
  return code.length === ROOM_CODE_LENGTH ? code : null;
}

// ───────────────────────────── names ─────────────────────────────

const FIRST = ['DJ', 'MC', 'Lil', 'Big', 'Captain', 'Disco', 'Funky', 'Groovy', 'Cosmic', 'Turbo', 'Neon', 'Sir'];
const SECOND = [
  'Llama',
  'Panda',
  'Bassline',
  'Wombat',
  'Noodle',
  'Pickle',
  'Waffle',
  'Mango',
  'Otter',
  'Taco',
  'Comet',
  'Sprout',
  'Biscuit',
  'Yeti',
  'Pixel',
  'Kiwi',
];

/** A fun default name ("Disco Llama"). `random` is injectable for tests. Always ≤ MAX_NAME_LENGTH. */
export function suggestName(random: () => number = Math.random): string {
  for (let i = 0; i < 8; i++) {
    const a = FIRST[Math.floor(random() * FIRST.length) % FIRST.length];
    const b = SECOND[Math.floor(random() * SECOND.length) % SECOND.length];
    const name = `${a} ${b}`;
    if (name.length <= MAX_NAME_LENGTH) return name;
  }
  return 'DJ Llama';
}

/** What we keep of a typed name: no control characters, single spaces, trimmed, at most MAX_NAME_LENGTH. */
export function cleanName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return [...s].slice(0, MAX_NAME_LENGTH).join('').trim();
}

/** The first letter of a name for its avatar (a whole emoji or accented letter, upper-cased). */
export function initial(name: string): string {
  const first = [...name.trim()][0];
  return first ? first.toUpperCase() : '?';
}

/** Eight avatar hues, one per seat, along the aurora and past it. */
const SEAT_HUES = [190, 330, 265, 45, 155, 215, 300, 20];
export const seatHue = (seat: number): number => SEAT_HUES[((seat % SEAT_HUES.length) + SEAT_HUES.length) % SEAT_HUES.length];

// ───────────────────────────── board ─────────────────────────────

export interface RankedEntry extends BoardEntry {
  /** 1-based; equal scores share a rank (1, 2, 2, 4) */
  rank: number;
  me: boolean;
}

/** Best score first (ties: higher accuracy, then the host, then name), with shared ranks for equal scores. */
export function rankBoard(board: readonly BoardEntry[], myPid: string): RankedEntry[] {
  const sorted = [...board].sort(
    (a, b) =>
      b.score - a.score ||
      b.accuracy - a.accuracy ||
      (a.role === b.role ? 0 : a.role === 'host' ? -1 : 1) ||
      a.name.localeCompare(b.name),
  );
  const out: RankedEntry[] = [];
  sorted.forEach((e, i) => {
    const rank = i > 0 && e.score === sorted[i - 1].score ? out[i - 1].rank : i + 1;
    out.push({ ...e, rank, me: e.pid === myPid });
  });
  return out;
}

/**
 * The rows a compact board shows: the first `max` places, but the player always sees themself:
 * when they are further down, the last row is theirs.
 */
export function boardWindow(ranked: readonly RankedEntry[], max: number): RankedEntry[] {
  if (ranked.length <= max) return [...ranked];
  const top = ranked.slice(0, max);
  if (top.some((e) => e.me)) return top;
  const me = ranked.find((e) => e.me);
  return me ? [...ranked.slice(0, max - 1), me] : top;
}

/** 1 → "1st", 2 → "2nd", 11 → "11th", 23 → "23rd". */
export function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** 980 → "980", 12345 → "12.3k", 123456 → "123k", 1234567 → "1.23M". For tight spaces. */
export function shortScore(n: number): string {
  const v = Math.max(0, Math.round(n));
  if (v < 10000) return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (v < 100000) return `${(Math.floor(v / 100) / 10).toFixed(1)}k`;
  if (v < 1000000) return `${Math.floor(v / 1000)}k`;
  return `${(Math.floor(v / 10000) / 100).toFixed(2)}M`;
}

/** One line about where the player stands: "You're 1st!", "2nd of 5 · 1,200 behind Sam". */
export function standingLine(ranked: readonly RankedEntry[]): string {
  const i = ranked.findIndex((e) => e.me);
  if (i < 0 || ranked.length < 2) return '';
  const me = ranked[i];
  if (me.rank === 1) {
    const next = ranked.find((e) => !e.me && e.score < me.score);
    if (ranked.filter((e) => e.rank === 1).length > 1) return `Tied for 1st of ${ranked.length}`;
    return next ? `1st of ${ranked.length} · ${shortScore(me.score - next.score)} ahead` : `1st of ${ranked.length}`;
  }
  const ahead = ranked[i - 1];
  const gap = ahead.score - me.score;
  return gap > 0
    ? `${ordinal(me.rank)} of ${ranked.length} · ${shortScore(gap)} behind ${ahead.name}`
    : `${ordinal(me.rank)} of ${ranked.length}`;
}

// ───────────────────────────── players ─────────────────────────────

/** The lobby list: host first, then by seat. */
export const sortPlayers = (players: readonly PlayerInfo[]): PlayerInfo[] =>
  [...players].sort((a, b) => (a.role === b.role ? a.seat - b.seat : a.role === 'host' ? -1 : 1));

export const hostOf = (players: readonly PlayerInfo[]): PlayerInfo | undefined => players.find((p) => p.role === 'host');

/** "Waiting for Sam to start" or, without a known host name, "Waiting for the DJ to start". */
export function waitingLine(host: PlayerInfo | undefined): string {
  return host ? `Waiting for ${host.name} to start` : 'Waiting for the DJ to start';
}

// ───────────────────────────── in game ─────────────────────────────

/** The line under the player's top bar: what the DJ is doing right now, or the host's status. */
export function djLine(hud: RemoteHud | null): string {
  if (!hud) return '';
  if (hud.djAction) return `DJ: ${hud.djAction}`;
  return hud.status;
}

/** How the notes feel at each difficulty, for a player who only plays the pads. */
export const NOTES_COPY: Record<Difficulty, { name: string; line: string }> = {
  chill: { name: 'CHILL', line: 'Fewer notes, relaxed timing.' },
  club: { name: 'CLUB', line: 'More notes to hit.' },
  festival: { name: 'FESTIVAL', line: 'All the notes, strict timing.' },
};

// ───────────────────────────── errors ─────────────────────────────

export interface ErrorCopy {
  title: string;
  body: string;
}

/** Plain words for every way joining (or staying in) a room can fail. */
export function roomErrorCopy(code: RoomErrorCode, roomCode?: string): ErrorCopy {
  const c = roomCode ? ` ${roomCode}` : '';
  switch (code) {
    case 'not-found':
      return {
        title: 'No party with that code',
        body: `There is no party${c} right now. Check the letters with the DJ, or ask them to start one.`,
      };
    case 'full':
      return { title: 'This party is full', body: 'Eight phones is the most a party can take. Ask the DJ to make room.' };
    case 'network':
      return { title: 'No connection', body: 'Check your Wi-Fi or mobile data, then try again.' };
    case 'kicked':
      return { title: 'You left the party', body: 'The DJ took you out of this party. You can join another one.' };
    case 'host-taken':
      return { title: 'Someone is already the DJ', body: 'This party already has a DJ. Join it as a player instead.' };
    default:
      return { title: 'Something went wrong', body: 'That did not work. Try again in a moment.' };
  }
}

// ───────────────────────────── controller state ─────────────────────────────

export type ControllerState = 'waiting' | 'live' | 'paused' | 'host-lost' | 'reconnecting' | 'results' | 'ended';

export interface ControllerFacts {
  status: 'connecting' | 'open' | 'reconnecting' | 'closed';
  /** the room ended for good (fatal error) */
  fatal: boolean;
  hasResults: boolean;
  hostConnected: boolean;
  /** at least one of the host's tracks is on a deck here */
  hasTrack: boolean;
  /** a tick has arrived since this screen opened */
  hadTick: boolean;
  hostLive: boolean;
}

/**
 * What a player's screen should be showing, most important first: the end of the room, the
 * results, our own connection, the host's phone, and only then the music itself.
 */
export function controllerState(f: ControllerFacts): ControllerState {
  if (f.fatal) return 'ended';
  if (f.hasResults) return 'results';
  if (f.status === 'reconnecting' || f.status === 'connecting') return 'reconnecting';
  if (f.status === 'closed') return 'ended';
  if (!f.hostConnected) return 'host-lost';
  if (!f.hasTrack || !f.hadTick) return 'waiting';
  return f.hostLive ? 'live' : 'paused';
}
