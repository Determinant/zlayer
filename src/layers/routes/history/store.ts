import { type RouteHistoryResource } from '@zlayer/contracts';
import { routeHistoryDocumentGuard as guard } from '../../../core/data/references';
import { captureReference } from '../../../core/data/reference-snapshot';
import { createRouteHistoryLookup, type RouteHistoryQuery } from '@zlayer/domain';
import { fetchJson, readCachedJson } from '../../../core/data/fetch-json';
import { DATA_CACHE } from '../../../core/storage/cache-names';

/** Runs in a worker. Retain one indexed snapshot, never send the national dataset to React. */
export function createRouteHistoryStore() {
  type Lookup = ReturnType<typeof createRouteHistoryLookup>;
  let loaded: { key: string; promise: Promise<Lookup> } | undefined;
  const load = (resource: RouteHistoryResource, revision: string, requireCache = false) =>
    fetchJson(resource.url, guard(resource, revision), 'Historical filed routes', { gzip: resource, requireCache, cacheOnly: !!resource.cacheOnly });
  return {
    async query(resource: RouteHistoryResource, revision: string, query: RouteHistoryQuery) {
      const key = JSON.stringify([revision, resource]);
      if (loaded?.key !== key) {
        const promise = load(resource, revision).then(data => createRouteHistoryLookup(data.pairs));
        loaded = { key, promise };
        void promise.catch(() => { if (loaded?.promise === promise) loaded = undefined; });
      }
      return (await loaded.promise)(query);
    },
    async prepare(resource: RouteHistoryResource, revision: string) {
      // Explicit downloads must prove durable storage even if browsing has a memory copy.
      return captureReference(resource, revision);
    },
    async cached(resource: RouteHistoryResource, revision: string) {
      const cache = await globalThis.caches?.open(DATA_CACHE).catch(() => undefined);
      return await readCachedJson(cache, resource.url, guard(resource, revision), 'Historical filed routes', resource) !== undefined;
    },
  };
}

export type RouteHistoryStore = ReturnType<typeof createRouteHistoryStore>;
