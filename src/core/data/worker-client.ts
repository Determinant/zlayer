import { wrap, type Remote } from 'comlink';
import { ResourceError } from './errors';

type WorkerEndpoint = Pick<Worker, 'postMessage' | 'addEventListener' | 'removeEventListener' | 'terminate'>;

/** Owns the worker and every pending RPC. A retired client accepts no new work;
 * ordinary request failures may drain shared reads, while crashes reject them all. */
export class WorkerClient<T> {
  readonly #remote: Remote<T>;
  readonly #pending = new Set<(error: Error) => void>();
  #retired = false;
  #closed = false;

  constructor(readonly worker: WorkerEndpoint, readonly message: string,
    readonly options: { retireOnError?: boolean; timeoutMs?: number } = {}) {
    this.#remote = wrap<T>(worker);
    worker.addEventListener('error', this.#crash);
    worker.addEventListener('messageerror', this.#crash);
  }

  get retired(): boolean { return this.#retired; }

  async call<R>(request: (remote: Remote<T>) => Promise<R>): Promise<R> {
    if (this.#retired) throw new ResourceError('worker', this.message);
    let reject!: (error: Error) => void;
    const failure = new Promise<never>((_resolve, fail) => { reject = fail; });
    this.#pending.add(reject);
    const timeout = setTimeout(() => this.#crash(), this.options.timeoutMs ?? 180_000);
    try { return await Promise.race([Promise.resolve().then(() => {
      if (this.#closed) throw new ResourceError('worker', this.message);
      return request(this.#remote);
    }), failure]); }
    catch (error) {
      if (this.options.retireOnError) this.#retired = true;
      throw error;
    } finally {
      clearTimeout(timeout);
      this.#pending.delete(reject);
      if (this.#retired && this.#pending.size === 0) this.dispose();
    }
  }

  #crash = (): void => { this.dispose(); };

  dispose(): void {
    if (this.#closed) return;
    this.#closed = this.#retired = true;
    const error = new ResourceError('worker', this.message);
    for (const reject of this.#pending) reject(error);
    this.#pending.clear();
    this.worker.removeEventListener('error', this.#crash);
    this.worker.removeEventListener('messageerror', this.#crash);
    this.worker.terminate();
  }
}
