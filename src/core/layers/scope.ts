export type Dispose = () => void;

/** One lifetime. Cleanup is reverse ordered, idempotent, and continues after errors. */
export class LayerScope {
  readonly #controller = new AbortController();
  readonly #cleanup = new Set<Dispose>();
  constructor(private readonly onError: (error: unknown) => void = error => { console.error(error); }) {}
  get signal(): AbortSignal { return this.#controller.signal; }
  add(dispose: Dispose): Dispose {
    let active = true;
    const once = () => { if (active) { active = false; this.#cleanup.delete(once); dispose(); } };
    if (this.signal.aborted) this.#run(once);
    else this.#cleanup.add(once);
    return once;
  }
  dispose(): void {
    if (this.signal.aborted) return;
    this.#controller.abort();
    for (const dispose of [...this.#cleanup].reverse()) this.#run(dispose);
  }
  #run(dispose: Dispose): void {
    try { dispose(); } catch (error) { this.onError(error); }
  }
}
