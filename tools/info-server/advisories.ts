import { isAwcAdvisorySnapshot, type AwcAdvisoryProduct } from '@zlayer/contracts';
import type { WeatherCache } from './cache';
import { SourceDiagnostics, sourceFailureCode } from './diagnostics';
import { resourceFor } from './routes';
import type { Payload } from './upstream';

const products: AwcAdvisoryProduct[] = ['gairmet', 'sigmet', 'cwa'];
/** Advisory acquisition has the same explicit lifetime as other background
 * products. HTTP cache misses still share the cache's existing source request. */
export function createAdvisoryWarming(cache: WeatherCache, signal: AbortSignal,
  options: { now?: () => number; log?: (message: string) => void } = {}) {
  const now = options.now ?? Date.now;
  const failures = new SourceDiagnostics(products.length, now, message => options.log?.(`Advisory ${message}`));
  const states = new Map(products.map(product => [product, { publication: undefined as Pick<Payload, 'checkedAt' | 'sha256'> | undefined,
    nextAttemptAt: 0, unresolvedRecords: 0, invalid: false, task: undefined as Promise<void> | undefined }]));
  const resource = (product: AwcAdvisoryProduct) => resourceFor(`/api/weather/advisories/${product}.json`);
  for (const [product, state] of states) {
    cache.observe(resource(product), payload => {
      if (state.publication?.sha256 !== payload.sha256 || state.publication.checkedAt !== payload.checkedAt) {
        state.publication = { checkedAt: payload.checkedAt, sha256: payload.sha256 };
        state.invalid = true; state.unresolvedRecords = 0;
        try {
          const value: unknown = JSON.parse(payload.body.toString());
          if (isAwcAdvisorySnapshot(value) && value.product === product && value.checkedAt === payload.checkedAt) {
            state.unresolvedRecords = value.issues?.length ?? 0; state.invalid = false;
          }
        } catch { /* Invalid saved output must never imply complete coverage. */ }
      }
      if (!cache.failure(resource(product))) failures.recovered(product);
    }, signal);
  }
  return {
    async restore() {
      for (const product of products) await cache.read(resource(product));
    },
    refresh() {
      for (const [product, state] of states) {
        if (signal.aborted || state.task || now() < state.nextAttemptAt) continue;
        // Refresh before the 60-second delivery TTL. A 30-second scheduler can
        // wake just before the TTL boundary; waiting until expiry leaves gaps.
        state.task = cache.get(resource(product), 20_000, signal).then(payload => {
          state.nextAttemptAt = Math.max(now() + 1000, payload.checkedAt + 20_000);
        }).catch(cause => {
          if (signal.aborted) return;
          failures.failed(product, sourceFailureCode(cause)); state.nextAttemptAt = now() + 30_000;
        }).finally(() => { state.task = undefined; });
      }
    },
    get status() {
      return Object.fromEntries([...states].map(([product, state]) => {
        const failure = cache.failure(resource(product));
        return [product, { ready: !state.invalid && !!state.publication && cache.isCurrent(resource(product), state.publication),
          checkedAt: state.publication?.checkedAt ?? null, preparing: !!state.task, nextAttemptAt: state.nextAttemptAt,
          unresolvedRecords: state.unresolvedRecords,
          error: failure ? sourceFailureCode(failure) : state.invalid ? 'invalid-source'
            : state.unresolvedRecords ? 'incomplete-advisories' : null }];
      }));
    },
    get diagnostics() { return failures.status; },
    async close() { await Promise.all([...states.values()].map(state => state.task)); },
  };
}
