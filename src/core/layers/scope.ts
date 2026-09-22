export type Dispose = () => void;

/** One lifetime. Cleanup is reverse ordered, idempotent, and continues after errors. */
export class LayerScope {
  readonly #controller = new AbortController();
  readonly #cleanup: Dispose[] = [];
  constructor(private readonly onError: (error: unknown) => void = error => { console.error(error); }) {}
  get signal(): AbortSignal { return this.#controller.signal; }
  add(dispose: Dispose): Dispose {
    let active = true;
    const once = () => { if (active) { active = false; dispose(); } };
    if (this.signal.aborted) this.#run(once);
    else this.#cleanup.push(once);
    return once;
  }
  dispose(): void {
    if (this.signal.aborted) return;
    this.#controller.abort();
    for (const dispose of this.#cleanup.splice(0).reverse()) this.#run(dispose);
  }
  #run(dispose: Dispose): void {
    try { dispose(); } catch (error) { this.onError(error); }
  }
}
