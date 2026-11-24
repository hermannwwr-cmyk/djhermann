/** Conversions between game data and wire messages (party.ts). Pure. */
import type { WireEnergy } from '../core/party';
import type { BeatEnergy, LoadedTrack, PcmData, TrackMeta, WaveformData } from '../core/types';

/** Round to `digits` decimals (as a number, so JSON stays short: 0.5 not 0.50). */
export const round = (v: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

const toWire = (a: ArrayLike<number>): number[] => {
  const out = new Array<number>(a.length);
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    out[i] = Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
  }
  return out;
};

export function energyToWire(e: BeatEnergy): WireEnergy {
  return { div: e.div, low: toWire(e.low), mid: toWire(e.mid), high: toWire(e.high), bar: toWire(e.bar) };
}

export function energyFromWire(w: WireEnergy): BeatEnergy {
  const arr = (a: unknown): Float32Array => Float32Array.from(Array.isArray(a) ? (a as number[]) : []);
  return { div: w.div > 0 ? w.div : 4, low: arr(w.low), mid: arr(w.mid), high: arr(w.high), bar: arr(w.bar) };
}

/** A flat, all-zero waveform (players have no audio to draw), valid for any consumer. */
export function emptyWaveform(durationSec: number, rate = 10): WaveformData {
  const length = Math.max(1, Math.ceil(Math.max(0, durationSec) * rate));
  return { rate, length, low: new Uint8Array(length), mid: new Uint8Array(length), high: new Uint8Array(length) };
}

/** One silent sample: players never play deck audio. */
export const silentPcm = (sampleRate: number): PcmData => ({
  sampleRate,
  length: 1,
  channels: [new Int16Array(1)],
});

/** A LoadedTrack built from a 'track' message: meta + beat energy, no audio. */
export function remoteTrack(meta: TrackMeta, energy: WireEnergy, sampleRate: number): LoadedTrack {
  return {
    meta,
    pcm: silentPcm(sampleRate),
    waveform: emptyWaveform(meta.durationSec),
    energy: energyFromWire(energy),
  };
}
