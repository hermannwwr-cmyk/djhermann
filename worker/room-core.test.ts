import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_MESSAGE_BYTES, MAX_NAME_LENGTH, MAX_PLAYERS, ROOM_IDLE_TTL_MS, type ServerMsg } from '../src/core/party';
import { CLOSE, RoomCore, SEAT_HOLD_MS, cleanName, uniqueName, utf8Length, type RoomStorage } from './room-core';

// ───────────── fakes ─────────────

class FakeSocket {
  readyState = 1;
  sent: ServerMsg[] = [];
  closed: { code?: number; reason?: string } | null = null;
  private att: unknown = null;
  constructor(readonly label: string) {}
  send(data: string): void {
    if (this.readyState !== 1) throw new Error('socket not open');
    this.sent.push(JSON.parse(data) as ServerMsg);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 2;
  }
  serializeAttachment(v: unknown): void {
    this.att = structuredClone(v);
  }
  deserializeAttachment(): unknown {
    return structuredClone(this.att);
  }
  /** messages received since the last call */
  take(): ServerMsg[] {
    const out = this.sent;
    this.sent = [];
    return out;
  }
  last<T extends ServerMsg['t']>(t: T): Extract<ServerMsg, { t: T }> | undefined {
    return [...this.sent].reverse().find((m) => m.t === t) as Extract<ServerMsg, { t: T }> | undefined;
  }
  all<T extends ServerMsg['t']>(t: T): Extract<ServerMsg, { t: T }>[] {
    return this.sent.filter((m) => m.t === t) as Extract<ServerMsg, { t: T }>[];
  }
}

class FakeStorage implements RoomStorage {
  data = new Map<string, unknown>();
  alarm: number | null = null;
  get<T>(key: string): T | undefined {
    return structuredClone(this.data.get(key)) as T | undefined;
  }
  put<T>(key: string, value: T): void {
    this.data.set(key, structuredClone(value));
  }
  deleteAll(): void {
    this.data.clear();
  }
  setAlarm(at: number): void {
    this.alarm = at;
  }
}

let clock: number;
let storage: FakeStorage;
let sockets: FakeSocket[];
let core: RoomCore<FakeSocket>;
let ids: number;

const makeCore = () =>
  new RoomCore<FakeSocket>({
    storage,
    sockets: () => sockets,
    now: () => clock,
    randomHex: (bytes) => (++ids).toString(16).padStart(bytes * 2, '0'),
  });

beforeEach(() => {
  clock = 1_000_000;
  storage = new FakeStorage();
  sockets = [];
  ids = 0;
  core = makeCore();
  expect(core.claim('ABCD')).toBe(true);
});

const connect = (label = 'ws'): FakeSocket => {
  const ws = new FakeSocket(label);
  sockets.push(ws);
  core.accept(ws);
  return ws;
};
const say = (ws: FakeSocket, msg: unknown) => core.message(ws, typeof msg === 'string' ? msg : JSON.stringify(msg));
/** the client goes away; like the runtime, the socket is still listed (and open) while the handler runs */
const hangUp = (ws: FakeSocket, code = 1006, reason = '') => {
  core.close(ws, code, reason);
  ws.readyState = 3;
  sockets = sockets.filter((s) => s !== ws);
};
const join = (role: 'host' | 'player', name = '', extra: Record<string, unknown> = {}) => {
  const ws = connect(name || role);
  say(ws, { t: 'hello', role, name, difficulty: 'club', ...extra });
  const welcome = ws.last('welcome');
  return { ws, welcome: welcome! };
};
const errorsOf = (ws: FakeSocket) => ws.all('error').map((e) => e.code);

// ───────────── tests ─────────────

describe('claim / info', () => {
  it('claims a free code once, reports info, and arms the idle alarm', () => {
    expect(core.claim('ABCD')).toBe(false);
    expect(core.info()).toEqual({ code: 'ABCD', phase: 'lobby', players: 0, hostConnected: false, full: false });
    expect(storage.alarm).toBe(clock + ROOM_IDLE_TTL_MS);
  });

  it('an unclaimed room does not exist and writes nothing', () => {
    storage = new FakeStorage();
    core = makeCore();
    expect(core.exists()).toBe(false);
    expect(core.info()).toBeNull();
    expect(storage.data.size).toBe(0);
  });
});

describe('hello / welcome', () => {
  it('welcomes the host into seat 0 with a secret, and turns the idle alarm into a watchdog', () => {
    const { ws, welcome } = join('host', '');
    expect(welcome.role).toBe('host');
    expect(welcome.code).toBe('ABCD');
    expect(welcome.secret).toMatch(/^[0-9a-f]{32}$/);
    expect(welcome.phase).toBe('lobby');
    expect(welcome.params).toBeUndefined();
    expect(welcome.players).toEqual([{ pid: welcome.pid, name: 'DJ', role: 'host', connected: true, difficulty: 'club', seat: 0 }]);
    expect(ws.last('players')?.players).toEqual(welcome.players);
    expect(storage.alarm).toBe(clock + ROOM_IDLE_TTL_MS);
    expect(core.info()).toMatchObject({ players: 1, hostConnected: true });
  });

  it('cleans, limits, defaults and de-duplicates names', () => {
    const host = join('host', '  Hermann  ');
    const a = join('player', '  Ann\n\t  Lee  ');
    const b = join('player', 'ann lee');
    const c = join('player', '');
    const d = join('player', 'X'.repeat(40));
    const e = join('player', 'x'.repeat(40));
    expect(host.welcome.players[0].name).toBe('Hermann');
    expect(a.welcome.players.find((p) => p.pid === a.welcome.pid)?.name).toBe('Ann Lee');
    const names = e.welcome.players.map((p) => p.name);
    expect(names).toEqual(['Hermann', 'Ann Lee', 'ann lee 2', 'Player 3', 'X'.repeat(16), 'x'.repeat(14) + ' 2']);
    expect(names.every((n) => [...n].length <= MAX_NAME_LENGTH)).toBe(true);
    expect(b.welcome.players.map((p) => p.seat)).toEqual([0, 1, 2]);
    expect(c.welcome.players.at(-1)).toMatchObject({ name: 'Player 3', seat: 3, role: 'player' });
    expect(d.welcome.role).toBe('player');
  });

  it('broadcasts players to everyone on every join', () => {
    const host = join('host', 'H');
    host.ws.take();
    const p = join('player', 'P', { difficulty: 'festival' });
    const list = host.ws.last('players')!.players;
    expect(list.map((x) => [x.name, x.role, x.connected, x.difficulty])).toEqual([
      ['H', 'host', true, 'club'],
      ['P', 'player', true, 'festival'],
    ]);
    expect(p.ws.last('players')!.players).toEqual(list);
  });

  it('rejects a second host without the secret (fatal), even while the host is away', () => {
    const host = join('host', 'H');
    const other = join('host', 'Impostor');
    expect(other.welcome).toBeUndefined();
    expect(errorsOf(other.ws)).toEqual(['host-taken']);
    expect(other.ws.closed?.code).toBe(CLOSE.hostTaken);
    hangUp(host.ws);
    const again = join('host', 'Impostor');
    expect(errorsOf(again.ws)).toEqual(['host-taken']);
  });

  it('a 9th person gets "full" (fatal); the host seat is always reserved', () => {
    join('host', 'H');
    for (let i = 0; i < MAX_PLAYERS - 1; i++) expect(join('player', `P${i}`).welcome).toBeDefined();
    expect(core.info()).toMatchObject({ players: MAX_PLAYERS, full: true });
    const ninth = join('player', 'Late');
    expect(ninth.welcome).toBeUndefined();
    expect(errorsOf(ninth.ws)).toEqual(['full']);
    expect(ninth.ws.closed?.code).toBe(CLOSE.full);
  });

  it('a full room hands out the seat of a player gone for longer than SEAT_HOLD_MS', () => {
    const host = join('host', 'H');
    const players = Array.from({ length: MAX_PLAYERS - 1 }, (_, i) => join('player', `P${i}`));
    hangUp(players[2].ws);
    clock += SEAT_HOLD_MS - 1;
    expect(errorsOf(join('player', 'Early').ws)).toEqual(['full']);
    clock += 1;
    expect(core.info()?.full).toBe(false);
    const late = join('player', 'Late');
    expect(late.welcome.players.find((p) => p.pid === late.welcome.pid)).toMatchObject({ seat: 3, connected: true }); // P2's seat
    expect(late.welcome.players.some((p) => p.pid === players[2].welcome.pid)).toBe(false);
    expect(host.ws.last('players')!.players).toHaveLength(MAX_PLAYERS);
  });
});

describe('reconnect', () => {
  it('keeps a disconnected seat (connected:false) and gives it back with pid + secret', () => {
    const host = join('host', 'H');
    const p = join('player', 'P', { difficulty: 'chill' });
    host.ws.take();
    hangUp(p.ws);
    const after = host.ws.last('players')!.players.find((x) => x.pid === p.welcome.pid);
    expect(after).toMatchObject({ connected: false, name: 'P', seat: 1 });

    const back = join('player', 'P', { pid: p.welcome.pid, secret: p.welcome.secret, difficulty: 'chill' });
    expect(back.welcome).toMatchObject({ pid: p.welcome.pid, secret: p.welcome.secret, role: 'player' });
    expect(host.ws.last('players')!.players.find((x) => x.pid === p.welcome.pid)).toMatchObject({ connected: true, seat: 1 });
    expect(host.ws.last('players')!.players).toHaveLength(2);
  });

  it('a wrong secret gets a new seat instead', () => {
    join('host', 'H');
    const p = join('player', 'P');
    hangUp(p.ws);
    const fake = join('player', 'P', { pid: p.welcome.pid, secret: 'f'.repeat(32) });
    expect(fake.welcome.pid).not.toBe(p.welcome.pid);
    expect(fake.welcome.players.map((x) => x.name)).toEqual(['H', 'P', 'P 2']);
  });

  it('the host reclaims the host seat with its secret', () => {
    const host = join('host', 'H');
    const p = join('player', 'P');
    hangUp(host.ws);
    expect(p.ws.last('players')!.players[0]).toMatchObject({ role: 'host', connected: false });
    expect(core.info()?.hostConnected).toBe(false);
    const back = join('host', 'H', { pid: host.welcome.pid, secret: host.welcome.secret });
    expect(back.welcome).toMatchObject({ role: 'host', pid: host.welcome.pid });
    expect(p.ws.last('players')!.players[0]).toMatchObject({ role: 'host', connected: true, seat: 0 });
  });

  it('a second socket for the same seat replaces the first one', () => {
    join('host', 'H');
    const p = join('player', 'P');
    const again = join('player', 'P', { pid: p.welcome.pid, secret: p.welcome.secret });
    expect(again.welcome.pid).toBe(p.welcome.pid);
    expect(p.ws.closed?.code).toBe(CLOSE.replaced);
    hangUp(p.ws); // the old socket's close event must not mark the seat disconnected
    expect(again.ws.last('players')!.players.find((x) => x.pid === p.welcome.pid)?.connected).toBe(true);
  });

  it('state survives hibernation (a fresh core over the same storage + sockets)', () => {
    const host = join('host', 'H');
    const p = join('player', 'P');
    say(host.ws, { t: 'phase', phase: 'playing', params: { mode: 'gig', setlist: ['a'], difficulty: 'club', party: true } });
    core = makeCore();
    expect(core.info()).toEqual({ code: 'ABCD', phase: 'playing', players: 2, hostConnected: true, full: false });
    say(p.ws, { t: 'send', m: { k: 'need' } });
    expect(host.ws.last('from')).toEqual({ t: 'from', pid: p.welcome.pid, m: { k: 'need' } });
  });

  it('closing with 1000 "leave" gives a player seat up', () => {
    const host = join('host', 'H');
    const p = join('player', 'P');
    hangUp(p.ws, 1000, 'leave');
    expect(host.ws.last('players')!.players.map((x) => x.name)).toEqual(['H']);
    expect(core.info()?.players).toBe(1);
  });
});

describe('messages', () => {
  it('ping → pong with the server time when handled (also before hello)', () => {
    const ws = connect();
    clock = 1234567;
    say(ws, { t: 'ping', c: 42.5 });
    expect(ws.take()).toEqual([{ t: 'pong', c: 42.5, s: 1234567 }]);
    say(ws, { t: 'ping', c: 'x' });
    expect(errorsOf(ws)).toEqual(['bad-message']);
  });

  it('me updates name / difficulty and broadcasts only real changes', () => {
    const host = join('host', 'H');
    const p = join('player', 'P');
    host.ws.take();
    say(p.ws, { t: 'me', name: '  Neo  ', difficulty: 'festival' });
    expect(host.ws.last('players')!.players[1]).toMatchObject({ name: 'Neo', difficulty: 'festival' });
    host.ws.take();
    say(p.ws, { t: 'me', name: 'Neo' });
    say(p.ws, { t: 'me', name: '   ' });
    expect(host.ws.take()).toEqual([]);
    say(p.ws, { t: 'me', name: 'h' }); // collides with the host, case-insensitively
    expect(host.ws.last('players')!.players[1].name).toBe('h 2');
    say(p.ws, { t: 'me', difficulty: 'impossible' });
    expect(errorsOf(p.ws)).toEqual(['bad-message']);
  });

  it('phase: host only, stored, broadcast to everyone, sent to late joiners', () => {
    const host = join('host', 'H');
    const p = join('player', 'P');
    const params = { mode: 'gig', setlist: ['t1', 't2'], difficulty: 'club', party: true };
    say(p.ws, { t: 'phase', phase: 'playing' });
    expect(errorsOf(p.ws)).toEqual(['not-allowed']);
    say(host.ws, { t: 'phase', phase: 'loading', params });
    expect(host.ws.last('phase')).toEqual({ t: 'phase', phase: 'loading', params });
    expect(p.ws.last('phase')).toEqual({ t: 'phase', phase: 'loading', params });
    say(host.ws, { t: 'phase', phase: 'playing' }); // params omitted: the gig's params are kept
    expect(p.ws.last('phase')).toEqual({ t: 'phase', phase: 'playing', params });
    const late = join('player', 'Late');
    expect(late.welcome).toMatchObject({ phase: 'playing', params });
    say(host.ws, { t: 'phase', phase: 'lobby' }); // back to the lobby clears them
    expect(late.ws.last('phase')).toEqual({ t: 'phase', phase: 'lobby' });
    expect(join('player', 'Later').welcome.params).toBeUndefined();
    say(host.ws, { t: 'phase', phase: 'dancing' });
    say(host.ws, { t: 'phase', phase: 'lobby', params: [1] });
    expect(errorsOf(host.ws)).toEqual(['bad-message', 'bad-message']);
    expect(core.info()?.phase).toBe('lobby');
  });

  it('cast: host → all players, or one; never back to the host', () => {
    const host = join('host', 'H');
    const a = join('player', 'A');
    const b = join('player', 'B');
    const c = join('player', 'C');
    hangUp(c.ws);
    [host, a, b].forEach((x) => x.ws.take());
    const tick = { k: 'tick', at: 5, live: 'A', decks: { A: null, B: null }, density: 0.5, hud: {} };
    say(host.ws, { t: 'cast', m: tick });
    expect(a.ws.take()).toEqual([{ t: 'cast', m: tick }]);
    expect(b.ws.take()).toEqual([{ t: 'cast', m: tick }]);
    expect(host.ws.take()).toEqual([]);
    say(host.ws, { t: 'cast', m: { k: 'eject', deck: 'B' }, to: b.welcome.pid });
    expect(a.ws.take()).toEqual([]);
    expect(b.ws.take()).toEqual([{ t: 'cast', m: { k: 'eject', deck: 'B' } }]);
    say(host.ws, { t: 'cast', m: { k: 'eject', deck: 'B' }, to: c.welcome.pid }); // offline: dropped quietly
    expect(host.ws.take()).toEqual([]);
    say(host.ws, { t: 'cast', m: { k: 'eject', deck: 'B' }, to: 'nobody' });
    say(host.ws, { t: 'cast', m: { k: 'eject', deck: 'B' }, to: host.welcome.pid });
    say(host.ws, { t: 'cast', m: 'tick' });
    expect(errorsOf(host.ws)).toEqual(['bad-message', 'bad-message', 'bad-message']);
    say(a.ws, { t: 'cast', m: tick });
    expect(errorsOf(a.ws)).toEqual(['not-allowed']);
    expect(b.ws.take()).toEqual([]);
  });

  it('send: player → host as "from"; the host cannot send', () => {
    const host = join('host', 'H');
    const p = join('player', 'P');
    host.ws.take();
    const judge = { k: 'judge', lane: 2, judgment: 'perfect', errorMs: -3 };
    say(p.ws, { t: 'send', m: judge });
    expect(host.ws.take()).toEqual([{ t: 'from', pid: p.welcome.pid, m: judge }]);
    say(host.ws, { t: 'send', m: judge });
    expect(errorsOf(host.ws)).toEqual(['not-allowed']);
    hangUp(host.ws);
    say(p.ws, { t: 'send', m: judge }); // host away: dropped, no error
    expect(errorsOf(p.ws)).toEqual([]);
  });

  it('kick: host only; the player gets "kicked", is closed and loses the seat', () => {
    const host = join('host', 'H');
    const a = join('player', 'A');
    const b = join('player', 'B');
    say(a.ws, { t: 'kick', pid: b.welcome.pid });
    expect(errorsOf(a.ws)).toEqual(['not-allowed']);
    say(host.ws, { t: 'kick', pid: host.welcome.pid });
    say(host.ws, { t: 'kick', pid: 'nobody' });
    expect(errorsOf(host.ws)).toEqual(['not-allowed', 'bad-message']);
    host.ws.take();
    say(host.ws, { t: 'kick', pid: b.welcome.pid });
    expect(b.ws.last('error')?.code).toBe('kicked');
    expect(b.ws.closed?.code).toBe(CLOSE.kicked);
    expect(host.ws.last('players')!.players.map((x) => x.name)).toEqual(['H', 'A']);
    hangUp(b.ws);
    // its old secret no longer reclaims anything
    const back = join('player', 'B', { pid: b.welcome.pid, secret: b.welcome.secret });
    expect(back.welcome.pid).not.toBe(b.welcome.pid);
  });

  it('bad messages are answered with bad-message and do not close the socket', () => {
    const { ws } = join('host', 'H');
    ws.take();
    say(ws, 'not json');
    say(ws, '[1,2]');
    say(ws, { t: 42 });
    say(ws, { t: 'dance' });
    say(ws, { t: 'hello', role: 'host', name: 'again' });
    core.message(ws, new ArrayBuffer(8));
    say(ws, JSON.stringify({ t: 'cast', m: { k: 'x', pad: 'é'.repeat(MAX_MESSAGE_BYTES / 2) } })); // > limit in UTF-8 bytes only
    expect(errorsOf(ws)).toEqual(Array(7).fill('bad-message'));
    expect(ws.closed).toBeNull();
    const fresh = connect();
    say(fresh, { t: 'me', name: 'x' });
    say(fresh, { t: 'hello', role: 'boss', name: 'x' });
    expect(errorsOf(fresh)).toEqual(['bad-message', 'bad-message']);
    expect(fresh.closed).toBeNull();
  });
});

describe('idle cleanup', () => {
  it('arms the alarm when the last socket closes, a reconnect cancels it, then it deletes the room', () => {
    const host = join('host', 'H');
    const p = join('player', 'P');
    const watchdog = storage.alarm;
    hangUp(p.ws);
    expect(storage.alarm).toBe(watchdog); // someone is still here: unchanged
    clock += 1000;
    hangUp(host.ws);
    expect(storage.alarm).toBe(clock + ROOM_IDLE_TTL_MS);

    clock += 60_000;
    const back = join('host', 'H', { pid: host.welcome.pid, secret: host.welcome.secret });
    expect(back.welcome.players.map((x) => [x.name, x.connected])).toEqual([
      ['H', true],
      ['P', false],
    ]);
    // the pending deletion is cancelled: the alarm is a watchdog again, which only re-arms itself
    clock = storage.alarm!;
    core.alarm();
    expect(core.exists()).toBe(true);
    expect(storage.alarm).toBe(clock + ROOM_IDLE_TTL_MS);

    clock += 5000;
    hangUp(back.ws);
    const due = storage.alarm!;
    expect(due).toBe(clock + ROOM_IDLE_TTL_MS);
    clock = due - 1;
    core.alarm(); // early: re-armed
    expect(core.exists()).toBe(true);
    expect(storage.alarm).toBe(due);
    clock = due;
    core.alarm();
    expect(core.exists()).toBe(false);
    expect(storage.data.size).toBe(0);
    // the code is free again
    expect(core.claim('ABCD')).toBe(true);
  });

  it('sockets lost without close events (runtime restart): the watchdog cleans up after two periods', () => {
    join('host', 'H');
    join('player', 'P');
    sockets = []; // the runtime restarted: no sockets, no close events
    core = makeCore();
    expect(core.info()).toMatchObject({ players: 2, hostConnected: false });
    clock = storage.alarm!;
    core.alarm();
    expect(core.exists()).toBe(true);
    expect(storage.alarm).toBe(clock + ROOM_IDLE_TTL_MS);
    clock = storage.alarm!;
    core.alarm();
    expect(core.exists()).toBe(false);
  });

  it('a claimed room nobody joined expires too', () => {
    clock += ROOM_IDLE_TTL_MS;
    core.alarm();
    expect(core.info()).toBeNull();
  });

  it('an expired room whose alarm never ran is gone on load', () => {
    clock += ROOM_IDLE_TTL_MS + 1;
    core = makeCore();
    expect(core.exists()).toBe(false);
  });

  it('a socket that is rejected (full / host-taken) does not keep an empty room alive', () => {
    const host = join('host', 'H');
    hangUp(host.ws);
    const alarm = storage.alarm;
    clock += 5000;
    const imp = join('host', 'X');
    expect(imp.ws.closed?.code).toBe(CLOSE.hostTaken);
    expect(storage.alarm).toBe(clock + ROOM_IDLE_TTL_MS);
    expect(alarm).not.toBeNull();
  });
});

describe('helpers', () => {
  it('utf8Length counts bytes for long strings', () => {
    const s = 'é'.repeat(MAX_MESSAGE_BYTES);
    expect(utf8Length(s)).toBe(2 * MAX_MESSAGE_BYTES);
    expect(utf8Length('😀'.repeat(MAX_MESSAGE_BYTES / 2))).toBe(2 * MAX_MESSAGE_BYTES);
  });
  it('cleanName / uniqueName', () => {
    expect(cleanName(42)).toBe('');
    expect(cleanName(' a\u0000b ')).toBe('a b');
    expect(uniqueName('Bo', ['bo', 'BO 2'])).toBe('Bo 3');
  });
});
