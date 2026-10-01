import { withAbort } from './abort';

export type TaskRunner = <T>(signal: AbortSignal, work: () => Promise<T>) => Promise<T>;

/** Own admission until work and cleanup finish, even after active cancellation.
 * Queued cancellation removes the waiter without starting its allocation. */
export class TaskLimiter {
  readonly #waiting = new Set<() => void>();
  #active = 0;

  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid task concurrency');
  }

  async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.#active >= this.limit) await new Promise<void>((resolve, reject) => {
      const next = () => { signal.removeEventListener('abort', abort); resolve(); };
      const abort = () => {
        this.#waiting.delete(next);
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      this.#waiting.add(next);
    });
    else this.#active++;
    try {
      signal.throwIfAborted();
      return await work();
    } finally {
      const next = this.#waiting.values().next().value;
      if (next) { this.#waiting.delete(next); next(); }
      else this.#active--;
    }
  }
}

/** Callers can stop waiting immediately; the shared queue still owns admission
 * until the active task finishes. Use TaskLimiter.run when cleanup must be awaited. */
export function createTaskLimiter(concurrency: number): TaskRunner {
  const queue = new TaskLimiter(concurrency);
  return (signal, work) => withAbort(queue.run(signal, async () => {
    // Preserve deferred admission: cancellation before the next microtask skips work.
    await Promise.resolve();
    signal.throwIfAborted();
    return work();
  }), signal);
}
