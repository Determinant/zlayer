import type { ProcedureCatalog, ProcedureResourceRecord } from '@zlayer/contracts';
import { fetchJson } from '../../core/data/fetch-json';
import { procedureCatalogGuard } from '../../core/data/references';
import { ResourceCache } from '../../core/data/resource-cache';

const procedureCatalogCache = new ResourceCache<ProcedureCatalog>();

export async function fetchProcedureCatalog(
  resource: ProcedureResourceRecord,
  requireFresh = false,
): Promise<ProcedureCatalog> {
  const key = JSON.stringify(resource);
  const load = () => fetchJson(
    resource.url,
    procedureCatalogGuard(resource),
    'FAA procedure catalog',
    { policy: resource.cacheOnly ? 'cache-only' : requireFresh && !resource.jsonSha256 ? 'network-only' : 'cache-first' },
  );
  // Published hashes already pin immutable catalogs; mutable legacy metadata must revalidate.
  return requireFresh && !resource.jsonSha256 ? load() : procedureCatalogCache.get(key, load);
}
