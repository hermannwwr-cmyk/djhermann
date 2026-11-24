import { describe, expect, it } from 'vitest';
import { MAX_NAME_LENGTH, isRoomCode } from '../../core/party';
import type { BoardEntry } from '../../core/party';
import {
  badLetters,
  boardWindow,
  cleanCodeInput,
  cleanName,
  codeProblem,
  controllerState,
  djLine,
  initial,
  ordinal,
  rankBoard,
  roomErrorCopy,
  roomLink,
  roomParam,
  shortScore,
  sortPlayers,
  standingLine,
  suggestName,
} from './logic';
import type { ControllerFacts } from './logic';

const entry = (pid: string, score: number, over: Partial<BoardEntry> = {}): BoardEntry => ({
  pid,
  name: pid.toUpperCase(),
  role: 'player',
  score,
  combo: 0,
  maxCombo: 0,
  accuracy: 0.9,
  connected: true,
  ...over,
});

describe('room code input', () => {
  it('upper-cases, drops anything that is not a letter and keeps four', () => {
    expect(cleanCodeInput('kq')).toBe('KQ');
    expect(cleanCodeInput(' k-q p d x')).toBe('KQPD');
    expect(cleanCodeInput('ab12cd')).toBe('ABCD');
    expect(cleanCodeInput('äb')).toBe('B');
  });

  it('takes the code out of a pasted invite link', () => {
    expect(cleanCodeInput('https://djhermann.example/?room=wxyz')).toBe('WXYZ');
    expect(cleanCodeInput('Join my party https://x.dev/?a=1&room=KQPD&b=2')).toBe('KQPD');
  });

  it('says what is wrong with a code', () => {
    expect(codeProblem('')).toBe('short');
    expect(codeProblem('KQP')).toBe('short');
    expect(codeProblem('KQPD')).toBeNull();
    expect(codeProblem('KOPI')).toBe('letters');
    expect(badLetters('KOPI')).toEqual(['O', 'I']);
    expect(badLetters('OOPS')).toEqual(['O']);
  });

  it('reads ?room= from the page address', () => {
    expect(roomParam('?room=kqpd')).toBe('KQPD');
    expect(roomParam('?x=1&room=KQPD')).toBe('KQPD');
    expect(roomParam('?room=KQ')).toBeNull();
    expect(roomParam('')).toBeNull();
  });

  it('builds the invite link', () => {
    expect(roomLink('KQPD', 'https://dj.example', '/')).toBe('https://dj.example/?room=KQPD');
    // the link is read back to the same code
    expect(roomParam(new URL(roomLink('KQPD', 'https://dj.example')).search)).toBe('KQPD');
  });
});

describe('names', () => {
  it('suggests fun names that always fit', () => {
    let seed = 1;
    const rand = (): number => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < 500; i++) {
      const n = suggestName(rand);
      expect(n.length).toBeGreaterThan(2);
      expect(n.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
      expect(n).toMatch(/^\S+ \S+$/);
    }
    // the edges of the random range are safe
    expect(suggestName(() => 0)).toBeTruthy();
    expect(suggestName(() => 0.999999)).toBeTruthy();
  });

  it('cleans typed names', () => {
    expect(cleanName('  Sam  ')).toBe('Sam');
    expect(cleanName('DJ   Big\tFun')).toBe('DJ Big Fun');
    expect(cleanName('a\u0000b')).toBe('ab');
    expect(cleanName('x'.repeat(40))).toHaveLength(MAX_NAME_LENGTH);
    expect([...cleanName('🎧'.repeat(20))]).toHaveLength(MAX_NAME_LENGTH);
    expect(cleanName('   ')).toBe('');
  });

  it('gives an avatar letter', () => {
    expect(initial('sam')).toBe('S');
    expect(initial('  émile')).toBe('É');
    expect(initial('🎧 Kid')).toBe('🎧');
    expect(initial('')).toBe('?');
  });
});

describe('board', () => {
  const board = [entry('a', 500), entry('me', 900), entry('h', 900, { role: 'host', accuracy: 0.8 }), entry('b', 1200), entry('c', 100)];

  it('ranks best score first, equal scores share a rank', () => {
    const r = rankBoard(board, 'me');
    expect(r.map((e) => e.pid)).toEqual(['b', 'me', 'h', 'a', 'c']);
    expect(r.map((e) => e.rank)).toEqual([1, 2, 2, 4, 5]);
    expect(r.find((e) => e.me)?.pid).toBe('me');
  });

  it('breaks exact ties host first, then by name', () => {
    const r = rankBoard([entry('z', 10), entry('h', 10, { role: 'host' }), entry('a', 10)], 'x');
    expect(r.map((e) => e.pid)).toEqual(['h', 'a', 'z']);
    expect(r.every((e) => e.rank === 1)).toBe(true);
  });

  it('always shows the player in a short board', () => {
    const many = rankBoard([entry('a', 9), entry('b', 8), entry('c', 7), entry('d', 6), entry('me', 1)], 'me');
    expect(boardWindow(many, 4).map((e) => e.pid)).toEqual(['a', 'b', 'c', 'me']);
    const top = rankBoard([entry('me', 9), entry('b', 8), entry('c', 7), entry('d', 6), entry('e', 1)], 'me');
    expect(boardWindow(top, 4).map((e) => e.pid)).toEqual(['me', 'b', 'c', 'd']);
    expect(boardWindow(top, 10)).toHaveLength(5);
    // a spectator (not on the board) just sees the top
    expect(boardWindow(rankBoard([entry('a', 3), entry('b', 2), entry('c', 1)], 'x'), 2).map((e) => e.pid)).toEqual(['a', 'b']);
  });

  it('writes places and scores for tight spaces', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd',
      '23rd',
      '101st',
      '111th',
    ]);
    expect(shortScore(0)).toBe('0');
    expect(shortScore(980)).toBe('980');
    expect(shortScore(9999)).toBe('9,999');
    expect(shortScore(12345)).toBe('12.3k');
    expect(shortScore(99999)).toBe('99.9k');
    expect(shortScore(123456)).toBe('123k');
    expect(shortScore(1234567)).toBe('1.23M');
    expect(shortScore(-5)).toBe('0');
  });

  it('says where the player stands', () => {
    expect(standingLine(rankBoard(board, 'me'))).toBe('2nd of 5 · 300 behind B');
    expect(standingLine(rankBoard(board, 'b'))).toBe('1st of 5 · 300 ahead');
    expect(standingLine(rankBoard([entry('me', 5), entry('x', 5)], 'me'))).toBe('Tied for 1st of 2');
    expect(standingLine(rankBoard([entry('me', 5)], 'me'))).toBe('');
  });

  it('lists the host first, then by seat', () => {
    const p = (pid: string, seat: number, role: 'host' | 'player' = 'player') => ({
      pid,
      name: pid,
      role,
      connected: true,
      difficulty: 'club' as const,
      seat,
    });
    expect(sortPlayers([p('b', 3), p('h', 0, 'host'), p('a', 1)]).map((x) => x.pid)).toEqual(['h', 'a', 'b']);
  });
});

describe('a player screen', () => {
  const live: ControllerFacts = {
    status: 'open',
    fatal: false,
    hasResults: false,
    hostConnected: true,
    hasTrack: true,
    hadTick: true,
    hostLive: true,
  };

  it('plays when the host music runs', () => {
    expect(controllerState(live)).toBe('live');
  });

  it('waits for the tracks and the first tick', () => {
    expect(controllerState({ ...live, hasTrack: false, hadTick: false, hostLive: false })).toBe('waiting');
    expect(controllerState({ ...live, hadTick: false, hostLive: false })).toBe('waiting');
  });

  it('knows the DJ paused, dropped out, or we did', () => {
    expect(controllerState({ ...live, hostLive: false })).toBe('paused');
    expect(controllerState({ ...live, hostLive: false, hostConnected: false })).toBe('host-lost');
    expect(controllerState({ ...live, status: 'reconnecting', hostConnected: false })).toBe('reconnecting');
  });

  it('results and the end of the room win over everything', () => {
    expect(controllerState({ ...live, hasResults: true, status: 'reconnecting' })).toBe('results');
    expect(controllerState({ ...live, fatal: true, hasResults: true })).toBe('ended');
    expect(controllerState({ ...live, status: 'closed' })).toBe('ended');
  });

  it('says what the DJ is doing', () => {
    expect(djLine(null)).toBe('');
    expect(djLine({ hype: 0.5, progress: 0.2, status: 'NEXT MIX IN 8 BARS', set: null, djAction: 'START DECK B' })).toBe(
      'DJ: START DECK B',
    );
    expect(djLine({ hype: 0.5, progress: 0.2, status: 'NEXT MIX IN 8 BARS', set: null, djAction: null })).toBe('NEXT MIX IN 8 BARS');
  });
});

describe('errors', () => {
  it('has plain words for every way a room can fail', () => {
    for (const code of ['not-found', 'full', 'host-taken', 'kicked', 'bad-message', 'not-allowed', 'network'] as const) {
      const c = roomErrorCopy(code, 'KQPD');
      expect(c.title.length).toBeGreaterThan(3);
      expect(c.body.length).toBeGreaterThan(10);
      expect(c.body).not.toMatch(/undefined|error code|websocket/i);
    }
    expect(roomErrorCopy('not-found', 'KQPD').body).toContain('KQPD');
  });

  it('agrees with the contract on what a code is', () => {
    expect(isRoomCode(cleanCodeInput('kqpd'))).toBe(true);
  });
});
