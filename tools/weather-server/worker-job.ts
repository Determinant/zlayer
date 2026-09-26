import { Worker } from 'node:worker_threads';
import { workerError, type WorkerResult } from './worker-protocol';

export function workerModule(owner: string, name: 'worker' | 'radar-worker' | 'progs-worker' | 'progs-coverage-worker'): URL {
  return new URL(`./${name}.${new URL(owner).pathname.endsWith('.ts') ? 'ts' : 'js'}`, owner);
}
export function createWeatherWorker(module: URL): Worker {
  return module.pathname.endsWith('.ts')
    ? new Worker(`import('tsx/esm/api').then(({register}) => { register(); return import(${JSON.stringify(module.href)}); })`, { eval: true })
    : new Worker(module);
}

/** One bounded, cancellable CPU job. Termination finishes before its slot is released. */
export async function workerJob<T>(module: URL, input: unknown, signal: AbortSignal, transfer: ArrayBuffer[] = []): Promise<T> {
  signal.throwIfAborted();
  const worker = createWeatherWorker(module);
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
  try {
    return await new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        deadline.removeEventListener('abort', aborted);
        worker.off('message', message); worker.off('error', failed); worker.off('messageerror', failed); worker.off('exit', exited);
      };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const aborted = () => failed(deadline.reason);
      deadline.addEventListener('abort', aborted, { once: true });
      worker.once('error', failed); worker.once('messageerror', failed);
      const exited = () => failed(new Error('Weather worker stopped'));
      const message = (result: WorkerResult<T>) => {
        cleanup();
        if (result.type === 'error') reject(workerError(result.error));
        else resolve(result.value);
      };
      worker.once('exit', exited); worker.once('message', message);
      if (deadline.aborted) { aborted(); return; }
      worker.postMessage(input, transfer);
    });
  } finally { await worker.terminate(); }
}
