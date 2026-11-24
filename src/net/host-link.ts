/**
 * Host side of a party gig: tells the players what is on the decks and where the playheads are,
 * collects their judgments (they move the host's crowd) and stats, and keeps the leaderboard.
 * See HostLink in core/party.ts.
 */
import { STATS_HZ, TICK_HZ } from '../core/party';
import type { BoardEntry, DeckTick, HostLink, HostLinkDeps, HostMsg, PlayerInfo, RemoteHud } from '../core/party';
import type { DeckId, FrameState, GigResults, Judgment, Lane, RhythmStats } from '../core/types';
import { DECK_IDS } from '../core/types';
import { energyToWire, round } from './wire';

export const HOST = {
  tickMs: 1000 / TICK_HZ,
  boardMs: 1000 / STATS_HZ,
  /** a full board is re-sent at least this often even when nothing changed (late joiners, lost state) */
  boardRefreshMs: 5000,
  /** send an extra tick when the players' extrapolation would be off by more than this (s) */
  driftSec: 0.002,
  /** …but never two ticks closer than this */
  minTickGapMs: 25,
} as const;

export interface HostLinkImpl extends HostLink {
  /** ticks sent so far (diagnostics) */
  readonly ticksSent: number;
}

const LANES: readonly Lane[] = [0, 1, 2, 3];
const JUDGMENTS: readonly Judgment[] = ['perfect', 'great', 'good', 'miss'];
const multiplierOf = (s: RhythmStats | undefined): number => (s && s.multiplier > 0 ? s.multiplier : 1);

export function createHostLink(deps: HostLinkDeps): HostLinkImpl {
  const { room, engine, bus, rhythm, getHud } = deps;
  const offs: (() => void)[] = [];
  /** the 'track' message per deck, built once per load */
  const trackMsg: Record<DeckId, Extract<HostMsg, { k: 'track' }> | null> = { A: null, B: null };
  const stats = new Map<string, RhythmStats>();
  /** every player that was ever in the room during this gig (they stay on the board) */
  const known = new Map<string, PlayerInfo>();
  let lastPlayers = new Map<string, boolean>(); // pid → connected
  let nextTick = 0;
  let lastTickPerf = -Infinity;
  let lastSent: { perf: number; decks: Record<DeckId, DeckTick | null>; live: DeckId | null } | null = null;
  let urgent = false;
  let nextBoard = 0;
  let lastBoardJson = '';
  let lastBoardSent = -Infinity;
  let playersDirty = true;
  let lastBoardCheck = -Infinity;
  let finished = false;
  let destroyed = false;
  let ticksSent = 0;

  // ───────────── tracks ─────────────

  function buildTrack(deck: DeckId): void {
    const t = engine.getLoadedTrack(deck);
    trackMsg[deck] = t ? { k: 'track', deck, meta: t.meta, energy: energyToWire(t.energy) } : null;
  }

  function sendTracks(to?: string): void {
    for (const deck of DECK_IDS) {
      const m = trackMsg[deck];
      if (m) room.cast(m, to);
      else room.cast({ k: 'eject', deck }, to);
    }
    urgent = true; // and where they are, right away
  }

  for (const deck of DECK_IDS) buildTrack(deck);
  if (trackMsg.A || trackMsg.B) sendTracks();

  offs.push(
    engine.on('deck:load', ({ deck }) => {
      buildTrack(deck);
      const m = trackMsg[deck];
      if (m) room.cast(m);
      urgent = true;
    }),
    engine.on('deck:eject', ({ deck }) => {
      trackMsg[deck] = null;
      room.cast({ k: 'eject', deck });
      urgent = true;
    }),
    // transport changes: tell the players at once rather than at the next scheduled tick
    engine.on('deck:play', () => (urgent = true)),
    engine.on('deck:pause', () => (urgent = true)),
    engine.on('deck:cue', () => (urgent = true)),
    engine.on('deck:sync', () => (urgent = true)),
    engine.on('deck:scratch', () => (urgent = true)),
    engine.on('deck:end', () => (urgent = true)),
  );

  // ───────────── players ─────────────

  const midGig = (): boolean => room.phase === 'loading' || room.phase === 'playing';

  function onPlayers(players: PlayerInfo[], initial = false): void {
    const next = new Map<string, boolean>();
    for (const p of players) {
      if (p.role !== 'player') continue;
      next.set(p.pid, p.connected);
      known.set(p.pid, p);
      const was = lastPlayers.get(p.pid);
      // joined, or came back: they may have missed tracks
      if (!initial && p.connected && was !== true && midGig() && !finished) sendTracks(p.pid);
    }
    for (const [pid, info] of known) {
      if (!next.has(pid) && info.connected) known.set(pid, { ...info, connected: false });
    }
    lastPlayers = next;
    playersDirty = true;
  }
  onPlayers(room.players, true); // they got the tracks above
  offs.push(
    room.on('players', ({ players }) => onPlayers(players)),
    room.on('phase', ({ phase }) => {
      // the gig is starting: make sure everyone has the decks (idempotent on the players' side)
      if ((phase === 'loading' || phase === 'playing') && !finished) sendTracks();
    }),
    room.on('status', ({ status }) => {
      // we were away: players may have missed loads / ejects
      if (status === 'open' && !finished) sendTracks();
    }),
    room.on('from', ({ pid, m }) => {
      if (destroyed) return;
      switch (m.k) {
        case 'judge': {
          if (!LANES.includes(m.lane) || !JUDGMENTS.includes(m.judgment)) return;
          const s = stats.get(pid);
          const miss = m.judgment === 'miss';
          bus.emit('judge', {
            lane: m.lane,
            judgment: m.judgment,
            errorMs: Number.isFinite(m.errorMs) ? m.errorMs : 0,
            combo: miss ? 0 : (s?.combo ?? 0) + 1,
            multiplier: miss ? 1 : multiplierOf(s),
            // the host's score is the host's own: a player's points count on the board only
            points: 0,
          });
          break;
        }
        case 'stats':
          if (m.stats && typeof m.stats.points === 'number') {
            stats.set(pid, m.stats);
          }
          break;
        case 'need':
          if (!finished) sendTracks(pid);
          break;
      }
    }),
  );

  // ───────────── board ─────────────

  function entryFor(info: PlayerInfo, s: RhythmStats | undefined, connected: boolean): BoardEntry {
    return {
      pid: info.pid,
      name: info.name,
      role: info.role,
      score: Math.round(s?.points ?? 0),
      combo: s?.combo ?? 0,
      maxCombo: s?.maxCombo ?? 0,
      accuracy: round(s?.accuracy ?? 1, 4),
      connected,
    };
  }

  function getBoard(): BoardEntry[] {
    const seat = new Map<string, number>();
    const entries: BoardEntry[] = [];
    const me = room.me;
    const hostInfo: PlayerInfo = me ?? {
      pid: room.pid,
      name: 'DJ',
      role: 'host',
      connected: true,
      difficulty: 'club',
      seat: 0,
    };
    entries.push(entryFor(hostInfo, rhythm.getStats(), true));
    seat.set(hostInfo.pid, -1);
    const live = new Map(room.players.map((p) => [p.pid, p]));
    for (const [pid, info] of known) {
      const cur = live.get(pid) ?? info;
      entries.push(entryFor(cur, stats.get(pid), live.get(pid)?.connected ?? false));
      seat.set(pid, cur.seat);
    }
    entries.sort((a, b) => b.score - a.score || (seat.get(a.pid) ?? 99) - (seat.get(b.pid) ?? 99));
    return entries;
  }

  /** at STATS_HZ (when something changed), and soon after a player joins, leaves or reconnects */
  function maybeSendBoard(now: number): void {
    const periodic = now >= nextBoard;
    if (!periodic && !(playersDirty && now - lastBoardCheck >= 100)) return;
    lastBoardCheck = now;
    if (periodic) nextBoard = now + HOST.boardMs;
    playersDirty = false;
    const entries = getBoard();
    const json = JSON.stringify(entries);
    if (json === lastBoardJson && now - lastBoardSent < HOST.boardRefreshMs) return;
    lastBoardJson = json;
    lastBoardSent = now;
    room.cast({ k: 'board', entries });
  }

  // ───────────── ticks ─────────────

  function deckTick(frame: FrameState, deck: DeckId): DeckTick | null {
    const snap = frame.decks[deck];
    if (!snap.track) return null;
    // the frame's snapshot was read a moment after frame.now; ask for the exact position at frame.now
    let pos = snap.positionSec;
    try {
      const p = engine.positionAt(deck, frame.now);
      if (Number.isFinite(p)) pos = p;
    } catch {
      /* keep the snapshot's */
    }
    const grid = snap.track.grid;
    return {
      trackId: snap.track.id,
      playing: snap.playing,
      scratching: snap.scratching,
      pos: round(pos, 4),
      rate: round(snap.rate, 4),
      tempo: round(snap.tempo, 4),
      bpm: round(snap.bpm, 3),
      beat: round(((pos - grid.firstBeatSec) * grid.bpm) / 60, 4),
      audibility: round(snap.audibility, 3),
    };
  }

  /** would the players' extrapolation of the last tick be off now? */
  function drifted(frame: FrameState, decks: Record<DeckId, DeckTick | null>): boolean {
    if (!lastSent) return true;
    if (lastSent.live !== frame.liveDeck) return true;
    for (const deck of DECK_IDS) {
      const a = lastSent.decks[deck];
      const b = decks[deck];
      if (!a || !b) {
        if (a !== b) return true;
        continue;
      }
      if (a.trackId !== b.trackId || a.playing !== b.playing || a.scratching !== b.scratching) return true;
      const predicted = a.pos + ((frame.now - lastSent.perf) / 1000) * a.rate;
      if (Math.abs(predicted - b.pos) > HOST.driftSec) return true;
      if (Math.abs(a.audibility - b.audibility) > 0.1 || Math.abs(a.tempo - b.tempo) > 0.0005) return true;
    }
    return false;
  }

  function hudSlice(): RemoteHud {
    const h = getHud();
    return {
      hype: round(h.hype, 3),
      progress: h.progress === null ? null : round(h.progress, 4),
      status: h.status,
      set: h.set,
      djAction: h.mission ? h.mission.title : null,
    };
  }

  function update(frame: FrameState): void {
    if (destroyed || finished) return;
    const now = frame.now;
    const due = now >= nextTick;
    const gapOk = now - lastTickPerf >= HOST.minTickGapMs;
    if (due || (gapOk && urgent)) {
      sendTick(frame);
    } else if (gapOk) {
      const decks = { A: deckTick(frame, 'A'), B: deckTick(frame, 'B') };
      if (drifted(frame, decks)) sendTick(frame, decks);
    }
    maybeSendBoard(now);
  }

  function sendTick(frame: FrameState, decksIn?: Record<DeckId, DeckTick | null>): void {
    const now = frame.now;
    const decks = decksIn ?? { A: deckTick(frame, 'A'), B: deckTick(frame, 'B') };
    room.cast({
      k: 'tick',
      at: round(room.perfToShared(now), 1),
      live: frame.liveDeck,
      decks,
      density: round(rhythm.density, 3),
      hud: hudSlice(),
    });
    ticksSent++;
    urgent = false;
    lastTickPerf = now;
    lastSent = { perf: now, decks, live: frame.liveDeck };
    // keep the regular cadence (extra ticks in between don't move it); after a stall, restart from now
    if (now >= nextTick) nextTick = now >= nextTick + HOST.tickMs ? now + HOST.tickMs : nextTick + HOST.tickMs;
  }

  return {
    update,
    getBoard,
    finish(results: GigResults) {
      if (finished || destroyed) return;
      finished = true;
      const board = getBoard();
      room.cast({ k: 'board', entries: board });
      room.cast({ k: 'results', results, board });
      room.setPhase('results', room.params);
    },
    destroy() {
      destroyed = true;
      for (const off of offs) off();
      offs.length = 0;
    },
    get ticksSent() {
      return ticksSent;
    },
  };
}
