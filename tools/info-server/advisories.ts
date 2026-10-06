import type { AwcAdvisoryProduct } from '@zlayer/contracts';
import type { WeatherCache } from './cache';
import { SourceDiagnostics, sourceFailureCode } from './diagnostics';
import { resourceFor } from './routes';

const products: AwcAdvisoryProduct[] = ['gairmet', 'sigmet', 'cwa'];
/** Advisory acquisition has the same explicit lifetime as other background
 * products. HTTP cache misses still share the cache's existing source request. */
export function createAdvisoryWarming(cache: WeatherCache, signal: AbortSignal,
  options: { now?: () => number; log?: (message: string) => void } = {}) {
  const now = options.now ?? Date.now;
  const failures = new SourceDiagnostics(products.length, now, message => options.log?.(`Advisory ${message}`));
  const states = new Map(products.map(product => [product, { checkedAt: null as number | null,
    nextAttemptAt: 0, task: undefined as Promise<void> | undefined }]));
  const resource = (product: AwcAdvisoryProduct) => resourceFor(`/api/weather/advisories/${product}.json`);
  return {
    async restore() {
      for (const [product, state] of states) state.checkedAt = (await cache.read(resource(product)))?.checkedAt ?? null;
    },
    refresh() {
      for (const [product, state] of states) {
        if (signal.aborted || state.task || now() < state.nextAttemptAt) continue;
        // Refresh before the 60-second delivery TTL. A 30-second scheduler can
        // wake just before the TTL boundary; waiting until expiry leaves gaps.
        state.task = cache.get(resource(product), 20_000, signal).then(payload => {
          state.checkedAt = payload.checkedAt;
          state.nextAttemptAt = Math.max(now() + 1000, payload.checkedAt + 20_000);
          failures.recovered(product);
        }).catch(cause => {
          if (signal.aborted) return;
          failures.failed(product, sourceFailureCode(cause)); state.nextAttemptAt = now() + 30_000;
        }).finally(() => { state.task = undefined; });
      }
    },
    get status() {
      const diagnostics = failures.status;
      return Object.fromEntries([...states].map(([product, state]) => [product, { ready: cache.has(resource(product)),
        checkedAt: state.checkedAt, preparing: !!state.task, nextAttemptAt: state.nextAttemptAt,
        error: diagnostics.sources[product]?.code ?? null }]));
    },
    get diagnostics() { return failures.status; },
    async close() { await Promise.all([...states.values()].map(state => state.task)); },
  };
}
