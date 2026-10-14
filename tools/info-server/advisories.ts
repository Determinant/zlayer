import { isAwcAdvisorySnapshot, type AwcAdvisoryProduct, type AwcAdvisorySnapshot } from '@zlayer/contracts';
import type { WeatherCache } from './cache';
import { SourceDiagnostics, sourceFailureCode } from './diagnostics';
import { advisoryRefreshAge, GAIRMET_SOURCE, resourceFor } from './weather-resources';
import type { Payload } from './upstream';

const products: AwcAdvisoryProduct[] = ['gairmet', 'sigmet', 'cwa'];
/** Derive diagnostics from the committed publication, including after restart.
 * Bound examples and omit raw bulletins; the artifact retains complete evidence. */
function interpretation(snapshot: AwcAdvisorySnapshot) {
  const classification = { metadata: 0, bulletin: 0, unspecified: 0, legacy: 0, unsupportedBulletins: 0 };
  for (const advisory of snapshot.advisories) {
    classification[advisory.classification?.basis ?? 'legacy']++;
    if (advisory.classification?.bulletin === 'unsupported') classification.unsupportedBulletins++;
  }
  const issueReasons: Record<string, number> = {}, issueDetails: Record<string, number> = {};
  for (const issue of snapshot.issues ?? []) {
    issueReasons[issue.reason] = (issueReasons[issue.reason] ?? 0) + 1;
    if (issue.detail) issueDetails[issue.detail] = (issueDetails[issue.detail] ?? 0) + 1;
  }
  return { acceptedRecords: snapshot.advisories.length, classification, issueReasons, issueDetails,
    issueSamples: (snapshot.issues ?? []).slice(0, 5).map(issue => ({ issuer: issue.issuer.slice(0, 80),
      identifier: issue.identifier.slice(0, 80), reason: issue.reason, ...(issue.detail ? { detail: issue.detail } : {}) })) };
}
/** Advisory acquisition has the same explicit lifetime as other background
 * products. HTTP cache misses still share the cache's existing source request. */
export function createAdvisoryWarming(cache: WeatherCache, signal: AbortSignal,
  options: { now?: () => number; log?: (message: string) => void } = {}) {
  const now = options.now ?? Date.now;
  let clock = now();
  const failures = new SourceDiagnostics(products.length, now, message => options.log?.(`Advisory ${message}`));
  const states = new Map(products.map(product => [product, { publication: undefined as Pick<Payload, 'checkedAt' | 'sha256'> | undefined,
    interpretation: null as ReturnType<typeof interpretation> | null,
    nextAttemptAt: 0, unresolvedRecords: 0, invalid: false, legacySource: false, task: undefined as Promise<void> | undefined }]));
  const resource = (product: AwcAdvisoryProduct) => resourceFor(`/api/weather/advisories/${product}.json`);
  // These are published products, not disposable raw inputs. Protect their one
  // committed file from capacity/expiry sweeps until replacement or shutdown.
  // HTTP still applies the product age limit, including for legacy 60-second files.
  cache.retain(products.map(product => resource(product).key), 'advisories');
  signal.addEventListener('abort', () => cache.retain([], 'advisories'), { once: true });
  for (const [product, state] of states) {
    cache.observe(resource(product), payload => {
      if (state.publication?.sha256 !== payload.sha256 || state.publication.checkedAt !== payload.checkedAt) {
        state.publication = { checkedAt: payload.checkedAt, sha256: payload.sha256 };
        state.invalid = true; state.unresolvedRecords = 0; state.interpretation = null;
        try {
          const value: unknown = JSON.parse(payload.body.toString());
          if (isAwcAdvisorySnapshot(value) && value.product === product && value.checkedAt === payload.checkedAt) {
            state.unresolvedRecords = value.issues?.length ?? 0; state.invalid = false;
            state.interpretation = interpretation(value);
            state.legacySource = product === 'gairmet' && value.source !== GAIRMET_SOURCE;
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
      if (now() < clock) for (const state of states.values()) state.nextAttemptAt = 0;
      clock = now();
      for (const [product, state] of states) {
        if (signal.aborted || state.task || now() < state.nextAttemptAt) continue;
        // Acquisition cadence is independent of the retained publication's age.
        // G-AIRMET checks its minute-updated bulk file; other families refresh
        // early enough to finish before their 60-second delivery TTL.
        const maxAge = advisoryRefreshAge(product);
        state.task = cache.get(resource(product), state.legacySource ? 0 : maxAge, signal).then(payload => {
          state.nextAttemptAt = Math.max(now() + (product === 'gairmet' ? maxAge : 1000), payload.checkedAt + maxAge);
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
          interpretation: state.interpretation,
          error: failure ? sourceFailureCode(failure) : state.invalid ? 'invalid-source'
            : state.unresolvedRecords ? 'incomplete-advisories' : null }];
      }));
    },
    get diagnostics() { return failures.status; },
    async close() { await Promise.all([...states.values()].map(state => state.task)); },
  };
}
