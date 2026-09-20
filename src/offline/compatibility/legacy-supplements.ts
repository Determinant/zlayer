import { bookUrl, type ChartSupplementCatalog } from '@zlayer/contracts';
import { readCachedJson } from '../../core/data/fetch-json';
import { navigationDocumentGuard } from '../../core/data/references';
import { writeOfflineRecord } from '../../core/storage/database';
import { savedPlans } from '../saved-plans';
import { REGION_PREFIX } from '../plan-records';
import type { DownloadPlan } from '../downloads';
import { OFFLINE_REGIONS } from '../regions';
import { DATA_CACHE } from '../../core/storage/cache-names';
import { regionAirportIds, supplementSnapshot } from '../../layers/plates/supplement-snapshot';

/** Capture legacy page targets before a mutable index is refreshed. Never guess a missing edition. */
export async function preserveSavedSupplements(catalog: ChartSupplementCatalog, url: string): Promise<void> {
  if (!navigator.locks) throw new Error('Download coordination unavailable');
  await navigator.locks.request('zlayer-region-downloads', async () => {
    const cache = await caches.open(DATA_CACHE);
    const pin = async (plan: DownloadPlan): Promise<DownloadPlan> => {
      const references = [];
      for (const reference of plan.references) {
        if (reference.id !== 'chart-supplements' || reference.snapshot || reference.url !== url) {
          references.push(reference); continue;
        }
        const region = OFFLINE_REGIONS.find(region => region.id === plan.regionId);
        const resource = plan.references.find(resource => resource.id === 'airports');
        const airports = resource?.id === 'airports' ? await readCachedJson(cache, resource.url,
          navigationDocumentGuard(resource, plan.revision), 'Saved airports') : undefined;
        const snapshot = region && airports ? supplementSnapshot(catalog, region, regionAirportIds(airports.features, region)) : undefined;
        if (region && airports && !snapshot) continue; // This edition has no applicable supplement targets.
        if (snapshot && snapshot.volumes.every(volume => plan.files.some(file => file.url === bookUrl(volume, url)))) {
          references.push({ ...reference, snapshot });
        } else {
          references.push({ id: 'unverified' as const, url });
        }
      }
      return { ...plan, references };
    };
    for (const plan of await savedPlans(true)) {
      const next = await pin(plan);
      if (plan.previous) next.previous = await pin(plan.previous);
      if (JSON.stringify(next) !== JSON.stringify(plan)) await writeOfflineRecord(`${REGION_PREFIX}${plan.id}`, next);
    }
  });
}
