/** Bound terrain allocations as well as downloads; canceled work never waits
 * for an occupied slot or starts allocating after its route has gone away. */
export class TerrainWorkLimit {
  readonly #waiting: (() => void)[] = [];
  #active = 0;

  constructor(readonly limit: number) {}

  async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.#active >= this.limit) await new Promise<void>((resolve, reject) => {
      const next = () => { signal.removeEventListener('abort', abort); resolve(); };
      const abort = () => {
        const index = this.#waiting.indexOf(next);
        if (index !== -1) this.#waiting.splice(index, 1);
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      this.#waiting.push(next);
    });
    else this.#active++;
    try {
      signal.throwIfAborted();
      return await work();
    } finally {
      const next = this.#waiting.shift();
      if (next) next(); else this.#active--;
    }
  }
}
