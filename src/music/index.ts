/**
 * Built-in music: six original tracks synthesised on the device, plus every one-shot sound.
 *
 *   const music = createBuiltinMusic();
 *   music.catalog                                  // TrackMeta[] (no audio rendered)
 *   const pcm = await music.renderTrack(id, 48000, (p) => …);
 *   const sounds = await music.renderSounds(48000);
 *
 * Tracks are rendered by a pure-TypeScript synth/sampler (see render.ts), in a Web Worker when
 * one is available, otherwise on the main thread in short slices that yield between them.
 */
import type { BuiltinMusic, PcmData, ProgressFn, SoundName } from '../core/types';
import { buildCatalog, songById } from './catalog';
import { createTrackJob } from './render';
import { SOUND_NAMES, renderSound } from './sounds';

export interface BuiltinMusicOptions {
  /** render tracks in a Web Worker when possible (default true) */
  worker?: boolean;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const nextTick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Main-thread render: work in slices of ~12 ms and give the event loop a turn in between. */
async function renderHere(id: string, sampleRate: number, onProgress?: ProgressFn): Promise<PcmData> {
  const song = songById(id);
  if (!song) throw new Error(`unknown built-in track "${id}"`);
  // one bar per step keeps every slice short enough for the UI to keep animating
  const job = createTrackJob(song, sampleRate, { chunkBars: 1 });
  for (;;) {
    const t0 = now();
    let finished = false;
    while (!(finished = job.step()) && now() - t0 < 12);
    if (finished) break;
    onProgress?.(job.progress);
    await nextTick();
  }
  onProgress?.(1);
  return job.result();
}

class WorkerUnavailable extends Error {}

function renderInWorker(id: string, sampleRate: number, onProgress?: ProgressFn): Promise<PcmData> {
  return new Promise<PcmData>((resolve, reject) => {
    let w: Worker;
    try {
      w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: `music-${id}` });
    } catch {
      reject(new WorkerUnavailable());
      return;
    }
    let heard = false;
    w.onmessage = (e: MessageEvent<{ type: string; p?: number; pcm?: PcmData; message?: string }>) => {
      heard = true;
      const m = e.data;
      if (m.type === 'progress') onProgress?.(m.p ?? 0);
      else {
        w.terminate();
        if (m.type === 'done' && m.pcm) {
          onProgress?.(1);
          resolve(m.pcm);
        } else reject(new Error(m.message ?? 'render failed'));
      }
    };
    w.onerror = (e) => {
      e.preventDefault();
      w.terminate();
      // a worker that never spoke could not start (module workers unsupported, blocked, …)
      reject(heard ? new Error(e.message || 'render failed') : new WorkerUnavailable());
    };
    w.postMessage({ id, sampleRate });
  });
}

export function createBuiltinMusic(opts: BuiltinMusicOptions = {}): BuiltinMusic {
  const catalog = buildCatalog();
  let useWorker = opts.worker !== false && typeof Worker !== 'undefined';

  return {
    catalog,

    async renderTrack(id: string, sampleRate: number, onProgress?: ProgressFn): Promise<PcmData> {
      if (!songById(id)) throw new Error(`unknown built-in track "${id}"`);
      if (!(sampleRate >= 8000 && sampleRate <= 192000)) throw new Error(`bad sample rate ${sampleRate}`);
      onProgress?.(0);
      if (useWorker) {
        try {
          return await renderInWorker(id, sampleRate, onProgress);
        } catch (err) {
          if (!(err instanceof WorkerUnavailable)) throw err;
          useWorker = false;
        }
      }
      return renderHere(id, sampleRate, onProgress);
    },

    async renderSounds(sampleRate: number): Promise<Record<SoundName, PcmData>> {
      const out = {} as Record<SoundName, PcmData>;
      for (const name of SOUND_NAMES) {
        out[name] = renderSound(name, sampleRate);
        await nextTick();
      }
      return out;
    },
  };
}
