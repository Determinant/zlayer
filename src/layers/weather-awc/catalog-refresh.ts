import { OnDemandRefresh } from '../../core/layers/on-demand-refresh';

type CatalogState<T> = { snapshot?: T; loading: boolean; error?: string };

/** Catalog acquisition is independent of loading/rendering its immutable files. */
export function catalogRefresh<T>(options: {
  intervalMs: number;
  read(): CatalogState<T>;
  publish(state: CatalogState<T>): void;
  refresh(signal: AbortSignal, onReady: (snapshot: T) => void): Promise<T>;
}) {
  return new OnDemandRefresh({ intervalMs: options.intervalMs, retryIntervalMs: 30_000, debounceMs: 0,
    onState(loading) {
      if (!loading && options.read().loading) options.publish({ ...options.read(), loading: false });
    },
    onError() {},
    async refresh(_ids, signal) {
      options.publish({ ...options.read(), loading: true });
      try {
        const snapshot = await options.refresh(signal, snapshot => {
          if (!signal.aborted) options.publish({ snapshot, loading: false });
        });
        signal.throwIfAborted();
        options.publish({ snapshot, loading: false });
      } catch (error) {
        if (!signal.aborted) options.publish({ ...options.read(), loading: false,
          error: error instanceof Error ? error.message : 'Weather refresh failed' });
        throw error;
      }
    },
  });
}

/** Release demand first so cancellation clears product loading flags. Core's
 * destroy deliberately suppresses callbacks after its owner has been removed. */
export function stopRefresh(scheduler: OnDemandRefresh | undefined) {
  scheduler?.setDemand([], false);
  scheduler?.destroy();
}
