import { isChartSupplementCatalog, type ChartSupplementCatalog } from '@zlayer/contracts';
import { fetchJson, readCachedJson, JsonResponseError } from '../core/data/fetch-json';
import { ResourceCache } from '../core/data/resource-cache';
import { preserveSavedSupplements } from './compatibility/legacy-supplements';
import { DATA_CACHE } from '../core/storage/cache-names';

const pendingCatalogs = new ResourceCache<ChartSupplementCatalog | undefined>();

/** Coalesce concurrent reads, then revalidate on later opens/catalog refreshes.
 * The URL is mutable; durable fallback and saved-region snapshots own retention. */
export function readSupplementCatalog(url: string, revision: string): Promise<ChartSupplementCatalog | undefined> {
  return pendingCatalogs.get(JSON.stringify([url, revision]), async () => {
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
  }, () => false);
}
