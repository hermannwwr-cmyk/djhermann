/**
 * Renders one built-in track off the main thread. Message in: { id, sampleRate }.
 * Messages out: { type: 'progress', p } … then { type: 'done', pcm } (channels transferred)
 * or { type: 'error', message }.
 */
import { songById } from './catalog';
import { createTrackJob } from './render';

interface Req {
  id: string;
  sampleRate: number;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<Req>) => {
  const { id, sampleRate } = e.data;
  try {
    const song = songById(id);
    if (!song) throw new Error(`unknown built-in track "${id}"`);
    const job = createTrackJob(song, sampleRate);
    let last = 0;
    while (!job.step()) {
      const now = performance.now();
      if (now - last > 30) {
        last = now;
        ctx.postMessage({ type: 'progress', p: job.progress });
      }
    }
    const pcm = job.result();
    ctx.postMessage({ type: 'done', pcm }, pcm.channels.map((c) => c.buffer as ArrayBuffer));
  } catch (err) {
    ctx.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
