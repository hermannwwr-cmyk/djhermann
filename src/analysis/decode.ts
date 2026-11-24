/**
 * Decoding the player's own audio files (MP3, WAV, M4A/AAC, FLAC, OGG: whatever the browser can
 * read) into stereo 16-bit PCM at the engine's sample rate. Nothing leaves the device.
 */
import { ImportError } from '../core/types';
import type { PcmData } from '../core/types';

export const MIN_TRACK_SEC = 20;
export const MAX_TRACK_SEC = 12 * 60;

export const DECODE_MESSAGE =
  "This file can't be played. It is either in a format this browser can't read, or it is " +
  'copy-protected. Songs from Spotify, Apple Music, YouTube Music or Tidal are protected and ' +
  'will not load. Use an MP3, WAV, M4A or FLAC file that you own.';
export const TOO_SHORT_MESSAGE = 'This track is shorter than 20 seconds. Pick a whole song.';
export const TOO_LONG_MESSAGE = 'This track is longer than 12 minutes. Pick a song under 12 minutes.';
export const READ_MESSAGE = "The file couldn't be read from your device. Try picking it again.";

/** Reject a duration outside 20 s .. 12 min with the matching ImportError. */
export function checkDuration(sec: number): void {
  if (!(sec >= MIN_TRACK_SEC)) throw new ImportError('too-short', TOO_SHORT_MESSAGE);
  if (sec > MAX_TRACK_SEC) throw new ImportError('too-long', TOO_LONG_MESSAGE);
}

/** Float samples (-1..1) to 16-bit, clipped. */
export function floatToInt16(src: Float32Array, dst: Int16Array = new Int16Array(src.length)): Int16Array {
  const n = Math.min(src.length, dst.length);
  for (let i = 0; i < n; i++) {
    const v = src[i];
    dst[i] = v >= 1 ? 32767 : v <= -1 ? -32768 : Math.round(v * 32767);
  }
  return dst;
}

/** Minimal view of an AudioBuffer (so the conversion can be tested without Web Audio). */
export interface AudioBufferLike {
  sampleRate: number;
  length: number;
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

/** An AudioBuffer as stereo PCM: mono is copied to both sides, extra channels are dropped. */
export function audioBufferToPcm(buffer: AudioBufferLike): PcmData {
  const left = floatToInt16(buffer.getChannelData(0));
  const right =
    buffer.numberOfChannels > 1 ? floatToInt16(buffer.getChannelData(1)) : Int16Array.from(left);
  return { sampleRate: buffer.sampleRate, length: buffer.length, channels: [left, right] };
}

type OfflineCtor = new (channels: number, length: number, sampleRate: number) => OfflineAudioContext;

/**
 * Decode an audio file at `sampleRate` (the engine's rate: decodeAudioData resamples to the
 * context's rate) into stereo Int16 PCM. Rejects with ImportError: 'decode' for anything the
 * browser cannot read (unsupported or DRM-protected), 'too-short' under 20 s, 'too-long' over 12 min.
 */
export async function decodeAudioFile(file: Blob, sampleRate: number): Promise<PcmData> {
  let data: ArrayBuffer;
  try {
    data = await file.arrayBuffer();
  } catch {
    throw new ImportError('unknown', READ_MESSAGE);
  }
  if (data.byteLength < 64) throw new ImportError('decode', DECODE_MESSAGE);

  const g = globalThis as unknown as { OfflineAudioContext?: OfflineCtor; webkitOfflineAudioContext?: OfflineCtor };
  const Ctor = g.OfflineAudioContext ?? g.webkitOfflineAudioContext;
  if (!Ctor) throw new ImportError('decode', DECODE_MESSAGE);

  let buffer: AudioBuffer;
  try {
    const ctx = new Ctor(2, 1, sampleRate);
    buffer = await new Promise<AudioBuffer>((resolve, reject) => {
      // Safari 16 supports the promise form, but old WebKit only calls back: handle both
      const result = ctx.decodeAudioData(data, resolve, (err) => reject(err ?? new Error('decode failed')));
      if (result && typeof result.then === 'function') result.then(resolve, reject);
    });
  } catch {
    throw new ImportError('decode', DECODE_MESSAGE);
  }
  if (!buffer || buffer.length === 0 || buffer.numberOfChannels === 0) throw new ImportError('decode', DECODE_MESSAGE);
  checkDuration(buffer.duration);
  return audioBufferToPcm(buffer);
}
