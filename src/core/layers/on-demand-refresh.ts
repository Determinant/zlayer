type RefreshOptions = {
  intervalMs: number;
  retryIntervalMs?: number;
  debounceMs?: number;
  refresh: (ids: readonly string[], signal: AbortSignal) => Promise<void>;
  onState: (loading: boolean) => void;
  onError: (error: unknown) => void;
};

/** Bounded to one active refresh; products retain ownership of their data cache. */
export class OnDemandRefresh {
  #key = '';
  #active: AbortController | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #destroyed = false;

  constructor(readonly options: RefreshOptions) {}

  setDemand(ids: readonly string[], enabled: boolean): void {
    const key = enabled ? [...new Set(ids)].sort().join(',') : '';
    if (key === this.#key || this.#destroyed) return;
    this.#key = key;
    clearTimeout(this.#timer);
    this.#active?.abort();
    this.options.onState(false);
    this.#schedule(this.options.debounceMs ?? 250);
  }

  destroy(): void {
    this.#destroyed = true;
    clearTimeout(this.#timer);
    this.#active?.abort();
  }

  #schedule(delay: number): void {
    if (!this.#destroyed && this.#key && !this.#active) {
      this.#timer = setTimeout(() => void this.#refresh(), delay);
    }
  }

  async #refresh(): Promise<void> {
    if (this.#destroyed || !this.#key || this.#active) return;
    const key = this.#key;
    const controller = new AbortController();
    this.#active = controller;
    this.options.onState(true);
    let failed = false;
    try { await this.options.refresh(key.split(','), controller.signal); }
    catch (error) {
      failed = true;
      if (!controller.signal.aborted) this.options.onError(error);
    }
    finally {
      this.#active = undefined;
      if (!this.#destroyed) {
        this.options.onState(false);
        this.#schedule(controller.signal.aborted ? this.options.debounceMs ?? 250
          : failed ? this.options.retryIntervalMs ?? this.options.intervalMs : this.options.intervalMs);
      }
    }
  }
}
