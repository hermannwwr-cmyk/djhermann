/**
 * Runs analysis jobs in a module Worker, one shared Worker for the whole app, created on first
 * use and closed after a while without work. Falls back to the main thread when the Worker cannot
 * be created or dies (old browser, CSP, out of memory in the Worker). The caller's PCM is copied
 * into the Worker (structured clone), never transferred, so it stays usable.
 */
import type { ProgressFn } from '../core/types';
import { runAnalysis } from './pipeline';
import type { AnalysisJob, AnalysisOutput } from './pipeline';

/** Close the Worker after this long without a job (it holds a few MB of tables and heap). */
const IDLE_CLOSE_MS = 30000;

interface Pending {
  job: AnalysisJob;
  onProgress?: ProgressFn;
  resolve: (out: AnalysisOutput) => void;
  reject: (err: Error) => void;
}

type WorkerMessage =
  | { id: number; type: 'progress'; p: number; stage: string }
  | { id: number; type: 'done'; out: AnalysisOutput }
  | { id: number; type: 'error'; message: string };

let worker: Worker | null = null;
/** set once a Worker failed to start or crashed: everything runs on the main thread from then on */
let workerBroken = false;
let nextId = 1;
const pending = new Map<number, Pending>();
let idleTimer: ReturnType<typeof setTimeout> | null = null;

const yieldToMain = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Run a job on the main thread, yielding between stages. */
export function runOnMainThread(job: AnalysisJob, onProgress?: ProgressFn): Promise<AnalysisOutput> {
  return yieldToMain().then(() => runAnalysis(job, onProgress, yieldToMain));
}

function closeWorker(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  worker?.terminate();
  worker = null;
}

function scheduleIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = pending.size === 0 ? setTimeout(closeWorker, IDLE_CLOSE_MS) : null;
}

/** The Worker crashed or could not load its script: finish every pending job on the main thread. */
function failOver(reason: unknown): void {
  if (!workerBroken) console.warn('[analysis] worker unavailable, analysing on the main thread', reason);
  workerBroken = true;
  closeWorker();
  const jobs = [...pending.values()];
  pending.clear();
  for (const p of jobs) runOnMainThread(p.job, p.onProgress).then(p.resolve, p.reject);
}

function getWorker(): Worker | null {
  if (workerBroken || typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'analysis' });
  } catch (err) {
    failOver(err);
    return null;
  }
  worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
    const msg = e.data;
    const p = pending.get(msg.id);
    if (!p) return;
    if (msg.type === 'progress') {
      p.onProgress?.(msg.p, msg.stage);
      return;
    }
    pending.delete(msg.id);
    scheduleIdleClose();
    if (msg.type === 'done') p.resolve(msg.out);
    else p.reject(new Error(msg.message));
  };
  worker.onerror = (e) => {
    e.preventDefault();
    failOver(e.message || 'worker error');
  };
  worker.onmessageerror = () => failOver('message error');
  return worker;
}

/** Run an analysis job in the Worker (or on the main thread when there is none). */
export function runJob(job: AnalysisJob, onProgress?: ProgressFn): Promise<AnalysisOutput> {
  const w = getWorker();
  if (!w) return runOnMainThread(job, onProgress);
  return new Promise<AnalysisOutput>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { job, onProgress, resolve, reject });
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    try {
      // structured clone: the Worker gets its own copy of the PCM; nothing is transferred
      w.postMessage({ id, job });
    } catch (err) {
      pending.delete(id);
      // the PCM could not be cloned (out of memory): try once more on the main thread
      console.warn('[analysis] could not hand the track to the worker', err);
      runOnMainThread(job, onProgress).then(resolve, reject);
    }
  });
}

/** For the harness and tests: force the main-thread path. */
export function setWorkerEnabled(enabled: boolean): void {
  if (!enabled) closeWorker();
  workerBroken = !enabled;
}
