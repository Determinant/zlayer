import type { ProcedureCatalog, ProcedureResourceRecord } from '@zlayer/contracts';
import { fetchJson } from '../../core/data/fetch-json';
import { procedureCatalogGuard } from '../../core/data/references';
import { ResourceCache } from '../../core/data/resource-cache';

const procedureCatalogCache = new ResourceCache<ProcedureCatalog>();

export async function fetchProcedureCatalog(
  resource: ProcedureResourceRecord,
): Promise<ProcedureCatalog> {
  const key = JSON.stringify(resource);
  return procedureCatalogCache.get(key, () => fetchJson(
    resource.url,
    procedureCatalogGuard(resource),
    'FAA procedure catalog',
    { cacheOnly: !!resource.cacheOnly },
  ));
}
