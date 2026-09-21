import { isRouteHistoryCached } from '../layers/routes/history/client';
import { readCachedJson } from '../core/data/fetch-json';
import { referenceGuard } from '../core/data/references';
import { snapshotFilesIncluded } from './plan-records';
import { DATA_CACHE } from '../core/storage/cache-names';
import type { DownloadPlan } from './downloads';
import { terrainFilesIncluded } from './terrain';

export async function regionReferencesReady(plan: DownloadPlan,
  verified = new Map<string, Promise<boolean>>()): Promise<boolean> {
  if (!snapshotFilesIncluded(plan)) return false;
  if (!await terrainFilesIncluded(plan)) return false;
  const cache = await caches.open(DATA_CACHE);
  for (const resource of plan.references) {
    const key = JSON.stringify([plan.revision, resource]);
    if (!verified.has(key)) verified.set(key, (async () => {
      // Unknown legacy expectations must not evict potentially usable cached bytes.
      if (resource.id === 'unverified') return false;
      if (resource.id === 'chart-supplements' && resource.snapshot) {
        return referenceGuard(resource, plan.revision)(resource.snapshot);
      }
      if (resource.id === 'route-history') return isRouteHistoryCached(resource, plan.revision);
      return await readCachedJson(cache, resource.url, referenceGuard(resource, plan.revision),
        'Regional reference data') !== undefined;
    })());
    if (!await verified.get(key)) return false;
  }
  return true;
}
