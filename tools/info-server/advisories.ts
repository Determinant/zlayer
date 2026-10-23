import { isAwcAdvisorySnapshot, type AwcAdvisoryProduct, type AwcAdvisorySnapshot } from '@zlayer/contracts';
import type { WeatherCache } from './cache';
import { legacyAdvisories } from '../../src/layers/weather-awc/source';
import { digest } from './upstream';
import { WeatherSourceError, WeatherPreparationError } from './source-error';
import { SourceDiagnostics, sourceFailureCode } from './diagnostics';
import { advisoryRefreshAge, GAIRMET_SOURCE, resourceFor } from './weather-resources';
import type { Payload } from './upstream';

const products: AwcAdvisoryProduct[] = ['gairmet', 'sigmet', 'cwa'];
/** Derive diagnostics from the committed publication, including after restart.
 * Bound examples and omit raw bulletins; the artifact retains complete evidence. */
function issueRule(sourceFeature: string): string | undefined {
  try {
    const rule = JSON.parse(sourceFeature)?.properties?.adaptationError;
    return typeof rule === 'string' ? rule.slice(0, 300) : undefined;
  } catch { return undefined; }
}
function interpretation(snapshot: AwcAdvisorySnapshot) {
  const classification = { metadata: 0, bulletin: 0, unspecified: 0, legacy: 0, unsupportedBulletins: 0, sourceDurationAnomalies: 0 };
  for (const advisory of snapshot.advisories) {
    classification[advisory.classification?.basis ?? 'legacy']++;
    if (advisory.classification?.bulletin === 'unsupported') classification.unsupportedBulletins++;
    if (advisory.classification?.sourceDurationMs !== undefined) classification.sourceDurationAnomalies++;
  }
  const issueReasons: Record<string, number> = {}, issueDetails: Record<string, number> = {};
  for (const issue of snapshot.issues ?? []) {
    issueReasons[issue.reason] = (issueReasons[issue.reason] ?? 0) + 1;
    if (issue.detail) issueDetails[issue.detail] = (issueDetails[issue.detail] ?? 0) + 1;
  }
  return { acceptedRecords: snapshot.advisories.length, classification, issueReasons, issueDetails,
    issueSamples: (snapshot.issues ?? []).slice(0, 5).map(issue => ({ issuer: issue.issuer.slice(0, 80),
      identifier: issue.identifier.slice(0, 80), reason: issue.reason, rule: issue.geometryError ?? issueRule(issue.sourceFeature), ...(issue.detail ? { detail: issue.detail } : {}) })) };
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
    evidenceId: null as string | null, nextAttemptAt: 0, unresolvedRecords: 0, invalid: false, legacySource: false, task: undefined as Promise<void> | undefined }]));
  const resource = (product: AwcAdvisoryProduct) => resourceFor(`/api/weather/advisories/${product === 'gairmet' ? 'gairmet-v3' : product}.json`);
  // These are published products, not disposable raw inputs. Protect their one
  // committed file from capacity/expiry sweeps until replacement or shutdown.
  // HTTP still applies the product age limit, including for legacy 60-second files.
  cache.retain([...products.map(product => resource(product).key), resourceFor('/api/weather/advisories/gairmet.json').key], 'advisories');
  signal.addEventListener('abort', () => cache.retain([], 'advisories'), { once: true });
  for (const [product, state] of states) {
    cache.observe(resource(product), payload => {
      if (state.publication?.sha256 !== payload.sha256 || state.publication.checkedAt !== payload.checkedAt) {
        state.publication = { checkedAt: payload.checkedAt, sha256: payload.sha256 };
        state.evidenceId = payload.headers['x-weather-evidence'] ?? null;
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
      for (const product of products) {
        if (await cache.read(resource(product)) || product !== 'gairmet') continue;
        const legacy = await cache.read(resourceFor('/api/weather/advisories/gairmet.json'));
        if (legacy) {
          try {
            const value: unknown = JSON.parse(legacy.body.toString());
            if (isAwcAdvisorySnapshot(value) && value.product === product && value.checkedAt === legacy.checkedAt) await cache.put(resource(product), legacy);
          } catch { /* Invalid legacy data must not become a publication. */ }
        }
      }
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
        state.task = cache.get(resource(product), state.legacySource ? 0 : maxAge, signal).then(async payload => {
          if (product === 'gairmet') {
            const body = Buffer.from(JSON.stringify(legacyAdvisories(JSON.parse(payload.body.toString()))));
            await cache.put(resourceFor('/api/weather/advisories/gairmet.json'), { ...payload, body, sha256: digest(body) });
          }
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
        const sample = state.interpretation?.issueSamples[0];
        const issueDetail = state.unresolvedRecords && sample
          ? `${state.unresolvedRecords} unresolved; example ${sample.issuer} ${sample.identifier}: ${sample.rule ?? sample.detail ?? sample.reason}`.slice(0, 300) : null;
        return [product, { endpoint: `/api/weather/advisories/${product === 'gairmet' ? 'gairmet-v3' : product}.json`,
          evidenceId: failure instanceof WeatherSourceError || failure instanceof WeatherPreparationError ? failure.evidenceId ?? null : state.evidenceId,
          errorDetail: failure instanceof Error ? failure.message.slice(0, 300) : issueDetail, ready: !state.invalid && !!state.publication && cache.isCurrent(resource(product), state.publication),
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
