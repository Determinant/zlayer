/** Closed documents still own their workers until asynchronous PDF.js teardown
 * settles. New parsers wait here; existing shared readers keep working. */
export class PdfRetirement {
  #pending = 0;
  readonly #waiters = new Set<() => void>();
  #failure: unknown;

  async open<T>(signal: AbortSignal, create: () => T): Promise<T> {
    while (this.#pending) await this.#wait(signal);
    signal.throwIfAborted();
    if (this.#failure) throw this.#failure;
    // No asynchronous gap between checking retirement and creating the parser.
    return create();
  }

  #wait(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const remove = () => { this.#waiters.delete(wake); signal.removeEventListener('abort', abort); };
      const wake = () => { remove(); resolve(); };
      const abort = () => { remove(); reject(signal.reason); };
      this.#waiters.add(wake);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  retire(destroy: () => Promise<void>, terminate: () => void): void {
    this.#pending++;
    void Promise.resolve().then(destroy).catch(() => {
      // The independently owned public PDFWorker below is the fallback.
    }).then(() => {
      try { terminate(); }
      catch (error) { this.#failure = error || new Error('Unable to release the PDF worker'); }
    }).finally(() => {
      if (--this.#pending === 0) for (const wake of this.#waiters) wake();
    });
  }
}
