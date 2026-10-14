import { isPirepSourceSnapshot, PIREP_MAX_BYTES, PIREP_SOURCE_MAX_AGE_MS } from '@zlayer/contracts';
import type { WeatherCache } from './cache';
import { PIREP_SOURCE } from './pirep-source';
import { resourceFor, type Resource } from './routes';
import { sourceFailureCode } from './diagnostics';
import { WeatherSourceError } from './source-error';

export const PUBLISHED_PIREPS = 'pireps-v2';

/** One small retained snapshot. HTTP reads never initiate upstream acquisition. */
export function createPirepWarming(cache: WeatherCache, signal: AbortSignal, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now, resource = resourceFor('/api/weather/pireps.json');
  const source: Resource = { key: `${PIREP_SOURCE}:v2`, url: PIREP_SOURCE, upstream: 'awc', kind: 'pirep-cache',
    ttl: PIREP_SOURCE_MAX_AGE_MS, maxBytes: PIREP_MAX_BYTES, revalidate: true };
  let publication: { checkedAt: number; sha256: string } | undefined;
  let recordCount = 0, error: string | null = null, nextAttemptAt = 0, lastAttemptAt = 0, task: Promise<void> | undefined;
  cache.retain([resource.key], 'pireps');
  signal.addEventListener('abort', () => cache.retain([], 'pireps'), { once: true });
  cache.observe(resource, payload => {
    try {
      const snapshot: unknown = JSON.parse(payload.body.toString());
      if (!isPirepSourceSnapshot(snapshot) || snapshot.checkedAt !== payload.checkedAt ||
        payload.headers['x-weather-catalog'] !== PUBLISHED_PIREPS) throw new Error();
      publication = { checkedAt: payload.checkedAt, sha256: payload.sha256 };
      recordCount = snapshot.records.length;
    } catch { publication = undefined; recordCount = 0; error = 'invalid-source'; }
  }, signal);
  return {
    async restore() {
      const saved = await cache.read(resource);
      // A schema-1 publication is a previous server interpretation, not a
      // complete source delivery. Acquire a new envelope after migration.
      if (saved && !publication) await cache.discard(resource);
    },
    refresh() {
      if (now() < lastAttemptAt) nextAttemptAt = 0;
      if (signal.aborted || task || now() < nextAttemptAt) return;
      lastAttemptAt = now();
      task = (async () => {
        try {
          const input = await cache.get(source, 60_000, signal);
          signal.throwIfAborted();
          if (publication && publication.checkedAt <= now() && input.checkedAt < publication.checkedAt)
            throw new WeatherSourceError('Aircraft-report publication regressed', 'stale-source');
          await cache.put(resource, { ...input, headers: { ...input.headers, 'x-weather-catalog': PUBLISHED_PIREPS } });
          error = null; nextAttemptAt = now() + 60_000;
        } catch (cause) {
          if (!signal.aborted) { error = sourceFailureCode(cause); nextAttemptAt = now() + 30_000; }
        }
      })().finally(() => { task = undefined; });
    },
    get status() { return { ready: !!publication && cache.isCurrent(resource, publication),
      checkedAt: publication?.checkedAt ?? null, recordCount, nextAttemptAt, preparing: !!task, error }; },
    async close() { await task; },
  };
}
