import type { BoardEntry, PartyStore } from './party';

/**
 * Shared contracts for the whole game. Every module codes against these types;
 * modules never import each other's internals (they are wired together in src/app).
 *
 * Conventions
 * - Time on a track is in seconds ("Sec"). Musical position is in beats (fractional).
 * - "perfMs" is a performance.now() / event.timeStamp value in milliseconds.
 * - "ctxTime" is AudioContext time in seconds.
 * - Positions reported to the UI are "as heard": compensated for output latency.
 */

// ───────────────────────────── basics ─────────────────────────────

export type DeckId = 'A' | 'B';
export const DECK_IDS: readonly DeckId[] = ['A', 'B'];
export const otherDeck = (d: DeckId): DeckId => (d === 'A' ? 'B' : 'A');

/** Tempo fader range as playback-rate multipliers (pitch moves with tempo, like vinyl). */
export const TEMPO_MIN = 0.92;
export const TEMPO_MAX = 1.08;
/** Rate offset at full pitch bend (a held pitch-bend button, or the jog ring turned fast). */
export const NUDGE_AMOUNT = 0.035;
/** Track seconds per full platter revolution (33⅓ rpm). */
export const SCRATCH_SEC_PER_REV = 1.8;
export const BEATS_PER_BAR = 4;

export type Lane = 0 | 1 | 2 | 3;
export const LANE_COUNT = 4;
/** The four pads, left to right. The name is also the sound name registered with the engine. */
export const LANE_SOUNDS = ['boom', 'clap', 'zap', 'horn'] as const;
export const LANE_LABELS = ['BOOM', 'CLAP', 'ZAP', 'HORN'] as const;

/** Every sound the built-in music module renders (pads + UI sounds). */
export type SoundName =
  | 'boom'
  | 'clap'
  | 'zap'
  | 'horn'
  | 'tick' // accented metronome click (calibration, count-in)
  | 'tock' // unaccented click
  | 'success' // mission complete
  | 'fail' // mission failed / miss streak
  | 'cheer' // crowd swell
  | 'whoosh'; // transition sweep

export type Difficulty = 'chill' | 'club' | 'festival';
export type GameMode = 'gig' | 'free';

export type ProgressFn = (progress: number, stage?: string) => void;

// ───────────────────────────── tracks ─────────────────────────────

/** Planar 16-bit PCM at the AudioContext sample rate. */
export interface PcmData {
  sampleRate: number;
  /** length in frames */
  length: number;
  /** 1 or 2 channels, each `length` samples */
  channels: Int16Array[];
}

/** Constant-tempo 4/4 beat grid. */
export interface BeatGrid {
  /** native tempo at playback rate 1 */
  bpm: number;
  /** track time of beat 0, which is a downbeat (bar 0, beat 1 of 4) */
  firstBeatSec: number;
}

export type SectionKind = 'intro' | 'groove' | 'build' | 'drop' | 'break' | 'outro';

export interface TrackSection {
  kind: SectionKind;
  /** first bar of the section (bar 0 starts at grid.firstBeatSec) */
  startBar: number;
  bars: number;
  /** 0..1 how intense the section is (drops ≈ 1, breaks ≈ 0.3) */
  energy: number;
}

/** Parameters for the procedural cover art / label of a track. */
export interface TrackArt {
  /** two hues in degrees (0..360) */
  hueA: number;
  hueB: number;
  seed: number;
}

export interface TrackMeta {
  id: string;
  title: string;
  artist: string;
  source: 'builtin' | 'user';
  durationSec: number;
  grid: BeatGrid;
  /** e.g. "A minor"; null when unknown */
  key: string | null;
  /** exact for built-in tracks, estimated from energy for user tracks */
  sections: TrackSection[];
  art: TrackArt;
  /** user tracks: 0..1 confidence of the detected grid */
  gridConfidence?: number;
}

/** Three-band overview for drawing waveforms. One bucket = 1/rate seconds. */
export interface WaveformData {
  /** buckets per second of track time */
  rate: number;
  /** number of buckets */
  length: number;
  /** 0..255 amplitude per bucket (already perceptually scaled for display) */
  low: Uint8Array;
  mid: Uint8Array;
  high: Uint8Array;
}

/** Onset strength on the beat grid, used to chart notes and to estimate sections. */
export interface BeatEnergy {
  /** subdivisions per beat (4 = sixteenth notes) */
  div: number;
  /** 0..1 onset strength per subdivision; index = round(beat * div), beat 0 = grid.firstBeatSec */
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
  /** 0..1 loudness per bar */
  bar: Float32Array;
}

export interface TrackAnalysis {
  waveform: WaveformData;
  energy: BeatEnergy;
}

/** A track that is ready to go on a deck. */
export interface LoadedTrack {
  meta: TrackMeta;
  pcm: PcmData;
  waveform: WaveformData;
  energy: BeatEnergy;
}

/** Implemented by src/music: the original built-in tracks and all one-shot sounds. */
export interface BuiltinMusic {
  /** metadata for every built-in track; available without rendering audio */
  catalog: TrackMeta[];
  /** Deterministically render a built-in track. onProgress gets 0..1. */
  renderTrack(id: string, sampleRate: number, onProgress?: ProgressFn): Promise<PcmData>;
  /** Render every one-shot sound. */
  renderSounds(sampleRate: number): Promise<Record<SoundName, PcmData>>;
}

export type ImportErrorCode = 'decode' | 'too-short' | 'too-long' | 'storage' | 'unknown';

/** Thrown by Library.importFile. `decode` usually means an unsupported or DRM-protected file. */
export class ImportError extends Error {
  constructor(
    public code: ImportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ImportError';
  }
}

/** Implemented by src/library: every track the player can put on a deck. */
export interface Library {
  /** built-in tracks first, then the player's own tracks (newest first) */
  list(): TrackMeta[];
  get(id: string): TrackMeta | undefined;
  /** Render or decode + analyse a track so it can go on a deck. Small in-memory cache. */
  load(id: string, onProgress?: ProgressFn): Promise<LoadedTrack>;
  /**
   * Import an audio file from the device: decode, detect BPM + beat grid, keep it locally.
   * Nothing is ever uploaded. Rejects with ImportError.
   */
  importFile(file: File, onProgress?: ProgressFn): Promise<TrackMeta>;
  /** Manual beat-grid fix for a user track (tap tempo, ½×/2×, nudge). Persists. */
  setGrid(id: string, grid: BeatGrid): Promise<TrackMeta>;
  remove(id: string): Promise<void>;
  /** called whenever list() changes */
  subscribe(fn: () => void): () => void;
}

// ───────────────────────────── audio engine ─────────────────────────────

export type EqBand = 'low' | 'mid' | 'high';

export interface DeckSnapshot {
  id: DeckId;
  track: TrackMeta | null;
  /** transport: true while the motor is on (stays true while the platter is held for a scratch) */
  playing: boolean;
  /** true while the platter is being held */
  scratching: boolean;
  /** playhead in track seconds as HEARD right now (latency compensated, smooth enough to animate) */
  positionSec: number;
  /** instantaneous playback rate as heard: 1 = native speed, 0 = stopped, negative = backwards */
  rate: number;
  /** tempo fader as a rate multiplier, TEMPO_MIN..TEMPO_MAX; 1 = native tempo */
  tempo: number;
  /** effective tempo = grid.bpm * tempo; 0 with no track */
  bpm: number;
  /** fractional beat position = (positionSec - grid.firstBeatSec) * grid.bpm / 60; 0 with no track */
  beat: number;
  /** cue point in track seconds */
  cueSec: number;
  durationSec: number;
  /** pitch bend currently applied, -1..1 (0 = none) */
  nudge: number;
  /** true while CUE is held and the deck is playing a cue preview (playing stays false) */
  cuePreview: boolean;
  /** true after SYNC until the tempo fader or a nudge is touched again */
  synced: boolean;
  /**
   * 0..1 how loud the deck is in the master: channelGain(fader, crossfader) from core/mixmath
   * while the deck is playing or being scratched, 0 when it is stopped. Ignores EQ and filter.
   */
  audibility: number;
  /** 0..1 post-fader peak level for meters */
  level: number;
}

export interface ChannelSnapshot {
  /** 0..1 per band: 0.5 = flat, 0 = full kill, 1 = +6 dB */
  eq: Record<EqBand, number>;
  /** -1..1: 0 = off, towards -1 closes a low-pass, towards +1 closes a high-pass */
  filter: number;
  /** 0..1 channel fader */
  fader: number;
  /** echo (beat-synced delay) engaged */
  echo: boolean;
}

export interface MixerSnapshot {
  channels: Record<DeckId, ChannelSnapshot>;
  /** -1 = full A, 0 = centre, +1 = full B */
  crossfader: number;
  /** 0..1 master peak level */
  masterLevel: number;
  /** 0..1 master energy per band, for audio-reactive visuals */
  bands: Record<EqBand, number>;
}

export interface EngineEvents {
  'deck:load': { deck: DeckId; track: TrackMeta };
  'deck:eject': { deck: DeckId };
  /** PLAY pressed. perfMs = performance.now() at the press. */
  'deck:play': { deck: DeckId; perfMs: number };
  'deck:pause': { deck: DeckId; perfMs: number };
  'deck:cue': { deck: DeckId; perfMs: number };
  /** the deck ran off the end of its track and stopped */
  'deck:end': { deck: DeckId };
  'deck:sync': { deck: DeckId; ok: boolean };
  'deck:scratch': { deck: DeckId; active: boolean };
}

export interface PlaySoundOptions {
  /** linear gain, default 1 */
  gain?: number;
  /** AudioContext time to start at; default = now */
  atCtxTime?: number;
  /** playback rate, default 1 */
  rate?: number;
}

/** Implemented by src/audio (real) and src/dev/mock-engine (simulated, silent). */
export interface AudioEngine {
  readonly sampleRate: number;
  /** true once unlock() has succeeded */
  readonly unlocked: boolean;

  /**
   * Call from inside a user gesture (tap). Resumes the AudioContext and resolves once the engine
   * is fully ready (worklets loaded). Safe to call again any time audio may have been suspended.
   */
  unlock(): Promise<void>;
  /** Freeze all audio (pause menu, tab hidden). Decks keep their state. */
  suspend(): Promise<void>;
  resume(): Promise<void>;

  // decks
  /** Stop the deck, load the track and park the playhead on the cue point (the first beat). */
  loadTrack(deck: DeckId, track: LoadedTrack): Promise<void>;
  eject(deck: DeckId): void;
  play(deck: DeckId): void;
  pause(deck: DeckId): void;
  togglePlay(deck: DeckId): void;
  /**
   * CUE button pressed, with real CDJ behaviour:
   * - playing → jump back to the cue point and pause;
   * - paused away from the cue point → set the cue point here;
   * - paused on the cue point → play for as long as the button is held (cue preview).
   */
  cueDown(deck: DeckId): void;
  /** CUE button released: a running cue preview stops and returns to the cue point. */
  cueUp(deck: DeckId): void;
  seek(deck: DeckId, sec: number): void;
  /** Tempo fader. Clamped to TEMPO_MIN..TEMPO_MAX. */
  setTempo(deck: DeckId, tempo: number): void;
  /**
   * Pitch bend. amount is -1..1: the deck runs at tempo × (1 + amount × NUDGE_AMOUNT) until it is set
   * back to 0. Pitch-bend buttons send ±1 while held; the jog wheel's outer ring sends a value
   * proportional to how fast it is being turned.
   */
  setNudge(deck: DeckId, amount: number): void;
  /** Match tempo and beat phase to the other deck. Returns false if it cannot (no track there, out of range). */
  sync(deck: DeckId): boolean;
  /** Top of the platter touched: the record now follows the finger (works while playing or paused). */
  scratchStart(deck: DeckId): void;
  /** Move the held record by deltaSec of track time (positive = forwards). Call on every pointer move. */
  scratchMove(deck: DeckId, deltaSec: number): void;
  /** Platter released: spins back up to speed if the deck is playing. */
  scratchEnd(deck: DeckId): void;

  // mixer
  setEq(deck: DeckId, band: EqBand, value: number): void;
  setFilter(deck: DeckId, value: number): void;
  setFader(deck: DeckId, value: number): void;
  setCrossfader(value: number): void;
  setEcho(deck: DeckId, on: boolean): void;
  setMasterVolume(value: number): void;

  // one-shot sounds (pads, UI)
  registerSound(name: string, pcm: PcmData): void;
  playSound(name: string, opts?: PlaySoundOptions): void;

  // state
  getDeck(deck: DeckId): DeckSnapshot;
  /** The track currently on a deck (with its waveform and beat energy), or null. */
  getLoadedTrack(deck: DeckId): LoadedTrack | null;
  getMixer(): MixerSnapshot;
  /** Track position (seconds) of a deck as heard at a given performance.now() timestamp. For judging taps. */
  positionAt(deck: DeckId, perfMs: number): number;

  // clock
  /** AudioContext time now (jitter-smoothed). */
  ctxTime(): number;
  /** Convert a performance.now() / event.timeStamp value to AudioContext time. */
  perfToCtx(perfMs: number): number;
  /** Latency compensation in use, in seconds: something scheduled at ctx time T is heard at T + latency. */
  getLatency(): number;
  /** The engine's own estimate for this device, in ms. */
  getAutoLatencyMs(): number;
  /** Override the latency used (from calibration), or null to go back to the automatic estimate. */
  setLatencyMs(ms: number | null): void;

  on<K extends keyof EngineEvents>(type: K, fn: (e: EngineEvents[K]) => void): () => void;
  destroy(): void;
}

// ───────────────────────────── controls ─────────────────────────────

export type PanelId = 'deckA' | 'mixer' | 'deckB';

export type DeckControl =
  | 'play'
  | 'cue'
  | 'sync'
  | 'tempo'
  | 'nudge-'
  | 'nudge+'
  | 'platter'
  | 'eq.low'
  | 'eq.mid'
  | 'eq.high'
  | 'filter'
  | 'fader'
  | 'echo';

/**
 * Id of a physical control. The element that draws the control carries it as
 * `data-control="<id>"` so missions can point at it. Tab buttons carry `data-tab="<PanelId>"`.
 */
export type ControlId = `${DeckId}.${DeckControl}` | 'xfader';

// ───────────────────────────── rhythm ─────────────────────────────

export type Judgment = 'perfect' | 'great' | 'good' | 'miss';

export interface RhythmStats {
  perfect: number;
  great: number;
  good: number;
  miss: number;
  combo: number;
  maxCombo: number;
  /** current score multiplier from the combo (1 when the combo is cold) */
  multiplier: number;
  /** points earned from notes so far (multiplier included) */
  points: number;
  /** 0..1 weighted accuracy over all judged notes (1 when nothing was judged yet) */
  accuracy: number;
}

/** Implemented by src/game/rhythm: the note highway + the four pads. */
export interface RhythmController {
  /** root element; fills its container */
  readonly el: HTMLElement;
  /**
   * Note difficulty. The playfield follows the engine's 'deck:load' / 'deck:eject' events by itself
   * and charts the notes for whatever track is on each deck (engine.getLoadedTrack).
   */
  setDifficulty(difficulty: Difficulty): void;
  /** 0..1. Only notes with priority <= density appear. 0 = no notes (free play, busy mixing). */
  setDensity(density: number): void;
  /** the density last set */
  readonly density: number;
  getStats(): RhythmStats;
  /** forget all judgments, combo and points */
  reset(): void;
  update(frame: FrameState): void;
  destroy(): void;
}

// ───────────────────────────── gig, missions, HUD ─────────────────────────────

export type MissionKind =
  | 'start-set'
  | 'start-deck'
  | 'beatmatch'
  | 'crossfade'
  | 'stop-deck'
  | 'bass-drop'
  | 'filter-sweep'
  | 'scratch'
  | 'echo-out';

export type MissionRating = 'perfect' | 'great' | 'ok' | 'fail';

/** What the player's finger should do on a control. Drawn as an animated cue next to it. */
export type Gesture =
  | 'tap'
  | 'hold'
  | 'up' // slide up
  | 'down' // slide down
  | 'left' // slide left
  | 'right' // slide right
  | 'turn-left' // turn a knob anticlockwise (drag down)
  | 'turn-right' // turn a knob clockwise (drag up)
  | 'scratch'; // rock the record back and forth

export interface MissionTarget {
  control: ControlId;
  gesture: Gesture;
}

/**
 * What the HUD shows for the mission in progress. It is the guide: the player should be able to
 * finish the mission by doing exactly what `title`, `hint` and `targets` say, with no DJ knowledge.
 * A mission with several steps updates title/hint/targets as it goes.
 */
export interface MissionView {
  id: number;
  kind: MissionKind;
  /** short imperative, upper case, plain words: "START DECK B" */
  title: string;
  /** one plain line saying exactly what to do: "Press the green PLAY button on deck B" */
  hint: string;
  /** the control(s) to use right now, each with the gesture to make; spotlighted on the console */
  targets: MissionTarget[];
  /** 0..1 progress towards completion, or null when there is nothing to show */
  progress: number | null;
  /** 1 → 0 fraction of the time window left */
  timeLeft: number;
  /** points on offer for a perfect rating */
  points: number;
}

export interface HudState {
  mode: GameMode;
  score: number;
  combo: number;
  multiplier: number;
  /** 0..1 crowd hype */
  hype: number;
  /** 0..1 through the gig; null in free play */
  progress: number | null;
  mission: MissionView | null;
  /** short line shown when no mission is active: "NEXT MIX IN 8 BARS", a track title, … */
  status: string;
  /** e.g. { index: 1, count: 3 } for "track 2 of 3"; null in free play */
  set: { index: number; count: number } | null;
}

export type CalloutTone = 'good' | 'bad' | 'info';
export type CalloutKind = 'trainwreck' | 'deadair' | 'drop' | 'rescue' | 'combo' | 'mix' | 'info';

export interface MissionResult {
  kind: MissionKind;
  title: string;
  rating: MissionRating;
  points: number;
  /** flavour for the result line: "SMOOTH MIX", "BASS SWAP", "USED SYNC" … */
  label: string;
}

export type Grade = 'S' | 'A' | 'B' | 'C' | 'D';

export interface GigResults {
  /** false when the crowd left before the end */
  completed: boolean;
  score: number;
  grade: Grade;
  /** 0..5 */
  stars: number;
  rhythm: RhythmStats;
  missions: MissionResult[];
  /** 0..1 */
  hypeAvg: number;
  hypePeak: number;
  /** hype sampled once per bar, for a chart */
  hypeHistory: number[];
  trainwrecks: number;
  deadAirSec: number;
  setlist: { id: string; title: string }[];
  difficulty: Difficulty;
  durationSec: number;
}

export interface GameEvents {
  /** any pad press, on or off a note */
  pad: { lane: Lane; perfMs: number };
  /** a note was judged (hit or missed) */
  judge: {
    lane: Lane;
    judgment: Judgment;
    /** signed timing error; negative = early. 0 for a miss. */
    errorMs: number;
    combo: number;
    multiplier: number;
    points: number;
  };
  'combo:break': { combo: number };
  /** combo crossed a multiplier threshold */
  'combo:milestone': { combo: number; multiplier: number };
  'mission:start': { mission: MissionView };
  'mission:end': { mission: MissionView; result: MissionResult };
  /** big on-screen shout: "TRAINWRECK!", "DEAD AIR", "DROP!" */
  callout: { kind: CalloutKind; text: string; tone: CalloutTone };
  /** the live deck entered a new section of its track */
  section: { deck: DeckId; kind: SectionKind; energy: number };
  'gig:start': { setlist: TrackMeta[] };
  'gig:end': { results: GigResults };
}

/** Implemented by src/game/gig: runs a gig (missions, hype, score) or a free-play session. */
export interface GigController {
  /** Load the opening tracks onto the decks and reset the mixer. Resolves when ready to play. */
  prepare(onProgress?: ProgressFn): Promise<void>;
  /** Free play: put a track from the library on a deck. Rejected during a gig (the gig picks the tracks). */
  loadTrack(deck: DeckId, trackId: string, onProgress?: ProgressFn): Promise<void>;
  update(frame: FrameState): void;
  getHud(): HudState;
  /** true once the gig is over (results are final) */
  readonly ended: boolean;
  getResults(): GigResults;
  destroy(): void;
}

// ───────────────────────────── frame ─────────────────────────────

/** Built once per animation frame by the frame loop and handed to every component. */
export interface FrameState {
  /** performance.now() of this frame */
  now: number;
  /** seconds since the previous frame, clamped to 0.1 */
  dt: number;
  decks: Record<DeckId, DeckSnapshot>;
  mixer: MixerSnapshot;
  /**
   * The deck the crowd is listening to: the most audible moving deck (with hysteresis).
   * It drives the note highway and all beat-synced visuals. null = dead air.
   */
  liveDeck: DeckId | null;
  /** live deck's fractional beat (0 with no live deck) */
  beat: number;
  /** 0..1 phase inside the current beat of the live deck */
  beatPhase: number;
  /** 0..1 phase inside the current bar of the live deck */
  barPhase: number;
  /** live deck's effective bpm (0 with no live deck) */
  bpm: number;
  /** 1 → 0 envelope that fires on every beat of the live deck; use it for beat-synced glow */
  pulse: number;
  hud: HudState;
}

/** Anything that draws: created by a factory, mounted by the app, updated once per frame. */
export interface Component {
  readonly el: HTMLElement;
  update(frame: FrameState): void;
  destroy(): void;
}

// ───────────────────────────── app shell ─────────────────────────────

export interface Settings {
  /** calibrated total latency in ms, or null to use the engine's automatic estimate */
  latencyMs: number | null;
  haptics: boolean;
  difficulty: Difficulty;
  /** 0..1 */
  masterVolume: number;
  /** render fewer effects on slow phones */
  lowFx: boolean;
  /** spotlight the control to use and show the gesture during missions */
  guide: boolean;
  /** the how-to-play cards were shown */
  seenHowTo: boolean;
  /** the guided tutorial gig was finished */
  tutorialDone: boolean;
  /** name shown to other players in party mode ('' until the player picks one) */
  playerName: string;
  /** best score per difficulty */
  best: Partial<Record<Difficulty, number>>;
}

export interface SettingsStore {
  get(): Settings;
  set(patch: Partial<Settings>): void;
  subscribe(fn: (s: Settings) => void): () => void;
}

export type ScreenId =
  | 'title'
  | 'home'
  | 'setup'
  | 'library'
  | 'settings'
  | 'calibrate'
  | 'howto'
  | 'game'
  | 'results'
  // party mode (step 2)
  | 'party'
  | 'lobby'
  | 'controller';

export interface GameParams {
  mode: GameMode;
  /** gig: track ids in play order (2–4 tracks). free: ignored. */
  setlist: string[];
  difficulty: Difficulty;
  /**
   * Guided tutorial gig: the missions teach one control at a time, wait for the player with no
   * time limit, and nothing is penalised. Uses mode 'gig'.
   */
  tutorial?: boolean;
  /** Party mode: this gig is hosted in the room in AppContext.party (the host's phone plays the audio). */
  party?: boolean;
}

export interface ScreenParams {
  title: undefined;
  home: undefined;
  setup: undefined;
  library: undefined;
  settings: undefined;
  calibrate: undefined;
  howto: undefined;
  game: GameParams;
  results: { results: GigResults; params: GameParams; board?: BoardEntry[] };
  /** party hub: host a party or join one (code optional, e.g. from a ?room= link) */
  party: { code?: string } | undefined;
  /** the room lobby (host and players) for AppContext.party.room */
  lobby: undefined;
  /** a player's game screen (notes + pads, in time with the host) for AppContext.party.room */
  controller: undefined;
}

/** A full-screen view. The navigator mounts `el`, then calls enter(); leave() before unmounting. */
export interface Screen<P = unknown> {
  readonly el: HTMLElement;
  enter?(params: P): void | Promise<void>;
  leave?(): void;
  /** Device/browser back button. Return true if the screen handled it (e.g. opened its pause menu). */
  back?(): boolean;
}

export interface Nav {
  readonly current: ScreenId | null;
  go<K extends ScreenId>(id: K, ...params: ScreenParams[K] extends undefined ? [] : [ScreenParams[K]]): void;
  /** go back to the previous screen (falls back to home) */
  back(): void;
}

/** Everything a screen may need. Built in src/main.ts. */
export interface AppContext {
  engine: AudioEngine;
  library: Library;
  settings: SettingsStore;
  nav: Nav;
  party: PartyStore;
}
