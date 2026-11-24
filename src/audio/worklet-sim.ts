/**
 * Runs the AudioWorklet processors of public/worklets outside a browser, block by block, so their
 * DSP can be unit-tested deterministically. Test-only: nothing in the game imports this.
 */
import deckSource from '../../public/worklets/deck-processor.js?raw';
import limiterSource from '../../public/worklets/limiter-processor.js?raw';

export const QUANTUM = 128;

interface SimPort {
  onmessage: ((e: { data: unknown }) => void) | null;
  postMessage(data: unknown): void;
}

interface SimProcessor {
  port: SimPort;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

type ProcessorClass = new (options?: unknown) => SimProcessor;

export interface WorkletSim {
  /** context frame of the next block */
  readonly frame: number;
  /** everything the processor posted, oldest first, with the frame of the block it was posted in */
  readonly messages: { frame: number; data: unknown }[];
  /** deliver a message; it is seen at the start of the next block, like a real MessagePort */
  send(msg: Record<string, unknown>): void;
  /** render n frames (rounded up to whole blocks) of stereo output; input defaults to silence */
  render(n: number, input?: [Float32Array, Float32Array]): [Float32Array, Float32Array];
}

function load(source: string, name: string, sampleRate: number, options?: unknown): { proc: SimProcessor; env: { currentFrame: number }; posted: { frame: number; data: unknown }[] } {
  const posted: { frame: number; data: unknown }[] = [];
  const env = {
    currentFrame: 0,
    sampleRate,
    registerProcessor: (_n: string, cls: ProcessorClass) => {
      registered = cls;
    },
    AudioWorkletProcessor: class {
      port: SimPort;
      constructor() {
        this.port = {
          onmessage: null,
          postMessage: (data: unknown) => posted.push({ frame: env.currentFrame, data }),
        };
      }
    },
  };
  let registered: ProcessorClass | null = null;
  // the processor reads currentFrame / sampleRate as globals: resolve them through `env`
  const run = new Function('env', `with (env) {\n${source}\n}`) as (e: typeof env) => void;
  run(env);
  if (!registered) throw new Error(`${name} did not register a processor`);
  const proc = new (registered as ProcessorClass)(options);
  return { proc, env, posted };
}

function createSim(source: string, name: string, sampleRate: number, options?: unknown): WorkletSim {
  const { proc, env, posted } = load(source, name, sampleRate, options);
  const inbox: Record<string, unknown>[] = [];
  return {
    get frame() {
      return env.currentFrame;
    },
    messages: posted,
    send(msg) {
      inbox.push(msg);
    },
    render(n, input) {
      const blocks = Math.ceil(n / QUANTUM);
      const L = new Float32Array(blocks * QUANTUM);
      const R = new Float32Array(blocks * QUANTUM);
      for (let b = 0; b < blocks; b++) {
        while (inbox.length) proc.port.onmessage?.({ data: inbox.shift() });
        const oL = new Float32Array(QUANTUM);
        const oR = new Float32Array(QUANTUM);
        const off = b * QUANTUM;
        const inputs: Float32Array[][] = input ? [[input[0].subarray(off, off + QUANTUM), input[1].subarray(off, off + QUANTUM)]] : [[]];
        proc.process(inputs, [[oL, oR]]);
        L.set(oL, off);
        R.set(oR, off);
        env.currentFrame += QUANTUM;
      }
      return [L, R];
    },
  };
}

export const createDeckSim = (sampleRate = 48000): WorkletSim => createSim(deckSource, 'deck-processor', sampleRate);

export const createLimiterSim = (sampleRate: number, processorOptions: Record<string, number>): WorkletSim =>
  createSim(limiterSource, 'limiter-processor', sampleRate, { processorOptions });
