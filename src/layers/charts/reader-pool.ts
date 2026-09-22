type Resource = { dispose: () => Promise<void> | void; isUsable?: () => boolean };
type Entry<T> = { promise: Promise<T>; users: number; controller: AbortController; resource?: T | undefined; retired: boolean };
type Waiter = { signal: AbortSignal; start(): void; abort(): void };

/** Bound active and idle readers. clear() ends one attachment generation; the pool is reusable. */
export class ArchiveReaderPool<T extends Resource> {
  readonly #entries = new Map<string, Entry<T>>();
  readonly #waiting: Waiter[] = [];
  #slots = 0;

  constructor(readonly open: (url: string, signal: AbortSignal) => Promise<T>, readonly limit = 6) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Reader limit must be positive');
  }

  async use<R>(url: string, action: (resource: T) => Promise<R>, signal?: AbortSignal): Promise<R> {
    signal?.throwIfAborted();
    let entry = this.#entries.get(url);
    if (!entry) {
      entry = { promise: undefined!, users: 0, controller: new AbortController(), retired: false };
      this.#entries.set(url, entry);
      entry.promise = this.#open(url, entry);
    }
    const current = entry;
    current.users++;
    // An obsolete queued/opening file must not occupy the queue until another read finishes.
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (--current.users || current.retired) return;
      if (!current.resource || current.resource.isUsable?.() === false || this.#waiting.length) this.#retire(url, current);
      else { this.#entries.delete(url); this.#entries.set(url, current); }
    };
    const abort = () => { if (!current.resource) release(); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const resource = await current.promise;
      signal?.throwIfAborted();
      current.controller.signal.throwIfAborted();
      return await action(resource);
    } finally {
      signal?.removeEventListener('abort', abort);
      release();
    }
  }

  /** Cancel obsolete opens and terminate resident readers, without touching durable files. */
  clear(): void {
    for (const [url, entry] of this.#entries) this.#retire(url, entry);
  }

  #retire(url: string, entry: Entry<T>): void {
    if (entry.retired) return;
    entry.retired = true;
    if (this.#entries.get(url) === entry) this.#entries.delete(url);
    entry.controller.abort();
    if (entry.resource) {
      const resource = entry.resource;
      entry.resource = undefined;
      void this.#dispose(resource).finally(() => this.#release());
    }
    // An unfinished open owns its slot until it settles and disposes any late result.
  }

  async #dispose(resource: T): Promise<void> {
    try { await resource.dispose(); } catch { /* Keep releasing other readers and slots. */ }
  }

  async #open(url: string, entry: Entry<T>): Promise<T> {
    const { signal } = entry.controller;
    await this.#reserve(signal);
    try {
      signal.throwIfAborted();
      const resource = await this.open(url, signal);
      if (signal.aborted) { await this.#dispose(resource); signal.throwIfAborted(); }
      entry.resource = resource;
      return resource;
    } catch (error) {
      if (this.#entries.get(url) === entry) this.#entries.delete(url);
      this.#release();
      throw error;
    }
  }

  #release(): void {
    const next = this.#waiting.shift();
    if (next) next.start(); else this.#slots--;
  }

  async #reserve(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#slots < this.limit) { this.#slots++; return; }
    const reserved = new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { signal,
        start: () => { signal.removeEventListener('abort', waiter.abort); resolve(); },
        abort: () => {
          const index = this.#waiting.indexOf(waiter);
          if (index >= 0) this.#waiting.splice(index, 1);
          reject(signal.reason);
        },
      };
      this.#waiting.push(waiter);
      signal.addEventListener('abort', waiter.abort, { once: true });
    });
    for (const [url, entry] of this.#entries) {
      if (entry.resource && !entry.users) { this.#retire(url, entry); break; }
    }
    await reserved;
  }
}
