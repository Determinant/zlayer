import { Worker } from 'node:worker_threads';

/** One bounded, cancellable CPU job. Termination finishes before its slot is released. */
export async function workerJob<T>(module: URL, message: unknown, signal: AbortSignal, transfer: ArrayBuffer[] = []): Promise<T> {
  signal.throwIfAborted();
  const worker = module.pathname.endsWith('.ts')
    ? new Worker(`import('tsx/esm/api').then(({register}) => { register(); return import(${JSON.stringify(module.href)}); })`, { eval: true })
    : new Worker(module);
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
  try {
    return await new Promise<T>((resolve, reject) => {
      const cleanup = () => deadline.removeEventListener('abort', aborted);
      const failed = (error: Error) => { cleanup(); reject(error); };
      const aborted = () => failed(deadline.reason);
      deadline.addEventListener('abort', aborted, { once: true });
      worker.once('error', failed); worker.once('messageerror', failed);
      worker.once('exit', () => failed(new Error('Weather worker stopped')));
      worker.once('message', (result: { value: T; error?: string }) => {
        cleanup();
        if (result.error) { const error = new Error(result.error); error.name = 'InvalidWeatherSource'; reject(error); }
        else resolve(result.value);
      });
      worker.postMessage(message, transfer);
    });
  } finally { await worker.terminate(); }
}
