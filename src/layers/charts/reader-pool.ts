type Resource = { dispose: () => Promise<void> | void; isUsable?: () => boolean };
type Entry<T> = { promise: Promise<T>; users: Map<symbol, AbortSignal | undefined>; ready: boolean };

// Persistent files outlive these readers. Bound active and idle resources
// (legacy SQLite workers or complete extracted packages), coalescing file opens.
export class ArchiveReaderPool<T extends Resource> {
  readonly #entries = new Map<string, Entry<T>>();
  readonly #waiting: Array<() => void> = [];
  #slots = 0;

  constructor(readonly open: (url: string) => Promise<T>, readonly limit = 6) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Reader limit must be positive');
  }

  async use<R>(url: string, action: (resource: T) => Promise<R>, signal?: AbortSignal): Promise<R> {
    signal?.throwIfAborted();
    let entry = this.#entries.get(url);
    if (!entry) {
      const users = new Map<symbol, AbortSignal | undefined>();
      entry = {
        promise: this.#open(url, () => [...users.values()].some(signal => !signal?.aborted)),
        users, ready: false,
      };
      this.#entries.set(url, entry);
    }
    const user = Symbol();
    entry.users.set(user, signal);
    let resource: T | undefined;
    try {
      resource = await entry.promise;
      entry.ready = true;
      signal?.throwIfAborted();
      return await action(resource);
    } finally {
      entry.users.delete(user);
      if (entry.users.size === 0 && this.#entries.get(url) === entry) {
        this.#entries.delete(url);
        const next = this.#waiting.shift();
        if (next || resource?.isUsable?.() === false) {
          try { await (await entry.promise).dispose(); }
          catch { /* Disposal still hands the slot to the next reader. */ }
          finally { if (next) next(); else this.#slots--; }
        } else this.#entries.set(url, entry);
      }
    }
  }

  async #open(url: string, needed: () => boolean): Promise<T> {
    await this.#reserve();
    try {
      if (!needed()) throw new DOMException('Archive no longer visible', 'AbortError');
      return await this.open(url);
    }
    catch (error) {
      this.#entries.delete(url);
      const next = this.#waiting.shift();
      if (next) next();
      else this.#slots -= 1;
      throw error;
    }
  }

  async #reserve(): Promise<void> {
    if (this.#slots < this.limit) { this.#slots += 1; return; }
    for (const [url, entry] of this.#entries) {
      if (entry.ready && entry.users.size === 0) {
        this.#entries.delete(url);
        try { await (await entry.promise).dispose(); }
        catch { /* The resource owner must release its underlying worker in finally. */ }
        return;
      }
    }
    await new Promise<void>(resolve => this.#waiting.push(resolve));
  }
}
