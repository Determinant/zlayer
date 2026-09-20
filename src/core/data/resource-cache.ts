/** Immutable resources coalesce in flight and retain a bounded set of successes.
 * Failures (and optional missing/partial values) always remain retryable. */
export class ResourceCache<T> {
  readonly #pending = new Map<string, Promise<T>>();
  readonly #ready = new Map<string, Promise<T>>();
  constructor(readonly capacity = 24) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Invalid resource cache capacity');
  }
  get(key: string, load: () => Promise<T>, retain: (value: T) => boolean = () => true): Promise<T> {
    const pending = this.#pending.get(key);
    if (pending) return pending;
    const ready = this.#ready.get(key);
    if (ready) { this.#ready.delete(key); this.#ready.set(key, ready); return ready; }
    const request = Promise.resolve().then(load).then(value => {
      if (retain(value)) {
        this.#ready.set(key, request);
        while (this.#ready.size > this.capacity) this.#ready.delete(this.#ready.keys().next().value!);
      }
      return value;
    }).finally(() => { this.#pending.delete(key); });
    this.#pending.set(key, request);
    return request;
  }
}
