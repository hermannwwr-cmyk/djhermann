/**
 * iOS plays Web Audio through the "ambient" audio session by default, which the ringer switch
 * silences. Two ways out:
 *  - Safari 16.4+: navigator.audioSession.type = 'playback';
 *  - older iOS: keep a silent, looping <audio> element playing (media elements use the "playback"
 *    session, and Web Audio follows). It has to be started inside the same tap as the context.
 * Other platforms need neither and get neither.
 */
import type { Platform } from './params';

export interface Unmute {
  /** Call synchronously inside a user gesture, before any await. */
  arm(): void;
  /** Audio is being suspended: stop the helper element too. */
  pause(): void;
  dispose(): void;
}

interface AudioSessionLike {
  type: string;
}

/** One second of silence as an 8-bit mono WAV data URI. */
function silentWavUri(): string {
  const rate = 8000;
  const n = rate;
  const bytes = new Uint8Array(44 + n);
  const v = new DataView(bytes.buffer);
  const tag = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i);
  };
  tag(0, 'RIFF');
  v.setUint32(4, 36 + n, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate, true); // byte rate
  v.setUint16(32, 1, true); // block align
  v.setUint16(34, 8, true); // bits
  tag(36, 'data');
  v.setUint32(40, n, true);
  bytes.fill(128, 44); // 8-bit silence
  let bin = '';
  for (let i = 0; i < bytes.length; i += 4096) bin += String.fromCharCode(...bytes.subarray(i, i + 4096));
  return `data:audio/wav;base64,${btoa(bin)}`;
}

export function createUnmute(platform: Platform): Unmute {
  let el: HTMLAudioElement | null = null;
  let disposed = false;

  const session = (): AudioSessionLike | null => {
    try {
      const s = (navigator as unknown as { audioSession?: AudioSessionLike }).audioSession;
      return s && typeof s === 'object' && 'type' in s ? s : null;
    } catch {
      return null;
    }
  };

  return {
    arm() {
      if (disposed) return;
      const s = session();
      if (s) {
        try {
          if (s.type !== 'playback') s.type = 'playback';
        } catch {
          /* not allowed here: nothing lost */
        }
        return;
      }
      if (platform !== 'ios') return;
      try {
        if (!el) {
          el = document.createElement('audio');
          el.setAttribute('playsinline', '');
          el.setAttribute('x-webkit-airplay', 'deny');
          el.preload = 'auto';
          el.loop = true;
          el.controls = false;
          (el as unknown as { disableRemotePlayback: boolean }).disableRemotePlayback = true;
          el.src = silentWavUri();
        }
        if (el.paused) void el.play().catch(() => undefined);
      } catch {
        /* the workaround is best effort */
      }
    },
    pause() {
      try {
        el?.pause();
      } catch {
        /* ignore */
      }
    },
    dispose() {
      disposed = true;
      try {
        if (el) {
          el.pause();
          el.removeAttribute('src');
          el.load();
        }
      } catch {
        /* ignore */
      }
      el = null;
    },
  };
}
