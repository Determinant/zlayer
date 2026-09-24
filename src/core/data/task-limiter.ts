import { withAbort } from './abort';

export type TaskRunner = <T>(signal: AbortSignal, work: () => Promise<T>) => Promise<T>;

/** Bound expensive work, including its cleanup. Queued callers allocate only
 * after admission; cancelling active work never releases its slot prematurely. */
export function createTaskLimiter(concurrency: number): TaskRunner {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Invalid task concurrency');
  let active = 0;
  const waiting = new Set<() => void>();
  function drain() {
    for (const start of waiting) {
      if (active >= concurrency) break;
      waiting.delete(start); start();
    }
  }
  return async function run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    const result = new Promise<T>((resolve, reject) => {
      const cancel = () => { waiting.delete(start); reject(signal.reason); };
      const start = () => {
        signal.removeEventListener('abort', cancel);
        active++;
        void Promise.resolve().then(() => { signal.throwIfAborted(); return work(); })
          .then(resolve, reject).finally(() => { active--; drain(); });
      };
      waiting.add(start);
      signal.addEventListener('abort', cancel, { once: true });
      drain();
    });
    return withAbort(result, signal);
  };
}
