import { withAbort } from '../../core/data/abort';
import { createTaskLimiter, type TaskRunner } from '../../core/data/task-limiter';

/** Pending demand only: products own freshness, accepted reports and persistence. */
export class SharedWeatherRequests {
  readonly #pending = new Map<string, { controller: AbortController; users: number; done: Promise<void> }>();
  constructor(readonly admit: TaskRunner = createTaskLimiter(2)) {}

  async run(key: string, signal: AbortSignal, work: (signal: AbortSignal) => Promise<void>): Promise<void> {
    signal.throwIfAborted();
    let request = this.#pending.get(key);
    if (!request || request.controller.signal.aborted) {
      const controller = new AbortController();
      const created = { controller, users: 0, done: Promise.resolve() };
      created.done = this.admit(controller.signal, () => work(controller.signal)).finally(() => {
        if (this.#pending.get(key) === created) this.#pending.delete(key);
      });
      request = created; this.#pending.set(key, request);
    }
    request.users++;
    const shared = request;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (--shared.users === 0) shared.controller.abort();
    };
    signal.addEventListener('abort', release, { once: true });
    try { await withAbort(shared.done, signal); }
    finally { signal.removeEventListener('abort', release); release(); }
  }
}
