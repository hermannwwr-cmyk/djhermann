/**
 * The analysis Worker: runs analysis jobs off the main thread.
 *
 *   → { id, job }                          (the PCM arrives as a structured-clone copy)
 *   ← { id, type: 'progress', p, stage }   (throttled)
 *   ← { id, type: 'done', out }            (result buffers are transferred)
 *   ← { id, type: 'error', message }
 */
import { outputBuffers, runAnalysis } from './pipeline';
import type { AnalysisJob } from './pipeline';

export interface WorkerRequest {
  id: number;
  job: AnalysisJob;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const { id, job } = e.data;
  let lastP = -1;
  let lastStage = '';
  try {
    const out = await runAnalysis(job, (p, stage = '') => {
      if (p - lastP < 0.01 && stage === lastStage && p < 1) return;
      lastP = p;
      lastStage = stage;
      scope.postMessage({ id, type: 'progress', p, stage });
    });
    scope.postMessage({ id, type: 'done', out }, outputBuffers(out));
  } catch (err) {
    scope.postMessage({ id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
