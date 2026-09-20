import { isChartSupplementCatalog, type ChartSupplementCatalog } from '@zlayer/contracts';
import { fetchJson, readCachedJson, JsonResponseError } from '../core/data/fetch-json';
import { ResourceCache } from '../core/data/resource-cache';
import { preserveSavedSupplements } from './compatibility/legacy-supplements';
import { DATA_CACHE } from '../core/storage/cache-names';

const catalogs = new ResourceCache<ChartSupplementCatalog | undefined>();

/** Small metadata loads once on opening Plates; no PDF is fetched until selection. */
export function readSupplementCatalog(url: string, revision: string): Promise<ChartSupplementCatalog | undefined> {
  return catalogs.get(url, async () => {
    const guard = (value: unknown): value is ChartSupplementCatalog => isChartSupplementCatalog(value, revision);
    const cache = await globalThis.caches?.open(DATA_CACHE).catch(() => undefined);
    const saved = await readCachedJson(cache, url, guard, 'Chart Supplement catalog');
    if (saved) {
      try { await preserveSavedSupplements(saved, new URL(url, location.href).href); }
      catch { return saved; } // Keep the old index if its saved page targets cannot be preserved.
    }
    return fetchJson(url, guard, 'Chart Supplement catalog', { revalidate: true }).catch(error => {
      if (error instanceof JsonResponseError && error.status === 404) return undefined;
      throw error;
    });
  }, result => result !== undefined);
}
