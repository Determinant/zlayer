import { HttpError } from './routes';

type Waiting = { start(): void; reject(error: unknown): void; signal: AbortSignal; aborted(): void };

/** Bounded FIFO admission. Completion/abort wakes capacity waiters; one timer
 * enforces start spacing. This clock measures transport time, not source age. */
export class UpstreamQueue {
  private active = 0;
  private nextStart = 0;
  private blockedUntil = 0;
  private waiting: Waiting[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly limit: number, private readonly spacing: number) {}

  backoff(until: number): HttpError {
    this.blockedUntil = Math.max(this.blockedUntil, until);
    this.pump();
    return this.backoffError();
  }
  private backoffError() {
    return new HttpError(503, 'Upstream is backing off', Math.max(1, Math.ceil((this.blockedUntil - Date.now()) / 1000)));
  }
  async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (Date.now() < this.blockedUntil) throw this.backoffError();
    if (this.waiting.length + this.active >= 32) throw new HttpError(503, 'Upstream queue is full', 5);
    return new Promise<T>((resolve, reject) => {
      const entry: Waiting = { signal, reject,
        aborted: () => {
          const index = this.waiting.indexOf(entry);
          if (index < 0) return;
          this.waiting.splice(index, 1);
          signal.removeEventListener('abort', entry.aborted);
          reject(signal.reason); this.pump();
        },
        start: () => {
          this.active++;
          this.nextStart = Date.now() + this.spacing;
          signal.removeEventListener('abort', entry.aborted);
          void Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }).then(resolve, reject)
            .finally(() => { this.active--; this.pump(); });
        },
      };
      this.waiting.push(entry);
      signal.addEventListener('abort', entry.aborted, { once: true });
      if (signal.aborted) entry.aborted(); else this.pump();
    });
  }
  private pump() {
    clearTimeout(this.timer); this.timer = undefined;
    if (Date.now() < this.blockedUntil) {
      const waiting = this.waiting; this.waiting = [];
      for (const entry of waiting) {
        entry.signal.removeEventListener('abort', entry.aborted);
        entry.reject(this.backoffError());
      }
      return;
    }
    while (this.waiting.length && this.active < this.limit) {
      const wait = this.nextStart - Date.now();
      if (wait > 0) { this.timer = setTimeout(() => this.pump(), wait); return; }
      this.waiting.shift()!.start();
    }
  }
}
