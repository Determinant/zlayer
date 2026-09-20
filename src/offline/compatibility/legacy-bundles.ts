import { isCatalogResponse, type Bounds, type CatalogResponse } from '@zlayer/contracts';
import { offlineRecords, readOfflineRecord, writeOfflineRecord } from '../../core/storage/database';
import { chartRegionPlans } from '../../layers/charts/offline';
import { persistBundleSnapshot, readBundleSnapshot } from '../bundle-snapshots';
import type { DownloadPlan } from '../downloads';
import { REGION_PREFIX } from '../plan-records';

/** Compatibility for inline catalogs and pre-snapshot selections. Scoped to one restore. */
export function createLegacyBundleMigration() {
  let catalogs: CatalogResponse[] | undefined;
  return {
    async findCatalog(plan: DownloadPlan): Promise<CatalogResponse | undefined> {
      const inline = await readBundleSnapshot(plan);
      if (inline) return inline;
      catalogs ??= (await offlineRecords('catalog:')).filter(isCatalogResponse);
      return catalogs.find(candidate => legacyCatalogMatches(plan, candidate));
    },
    /** Called only after the repository establishes eligibility and verifies legacy dependencies.
     * Compare the original record under the existing download lock before writing. */
    async adopt(root: DownloadPlan, plan: DownloadPlan, catalog: CatalogResponse, bounds: Bounds[]) {
      const migrated = { ...await persistBundleSnapshot({ ...plan, catalog, bounds }), completedAt: Date.now() };
      await navigator.locks?.request('zlayer-region-downloads', { ifAvailable: true }, async lock => {
        if (!lock) return;
        const latest = await readOfflineRecord(`${REGION_PREFIX}${root.id}`);
        if (JSON.stringify(latest) !== JSON.stringify(root)) return;
        await writeOfflineRecord(`${REGION_PREFIX}${root.id}`, plan === root ? migrated : { ...root, previous: migrated });
      });
      return migrated.snapshotId;
    },
  };
}

function legacyCatalogMatches(plan: DownloadPlan, catalog: CatalogResponse): boolean {
  if (catalog.revision !== plan.revision) return false;
  const candidate = chartRegionPlans(catalog, location.href).find(item => item.plan.id === plan.id)?.plan;
  if (!candidate) return false;
  const actual = plan.files.filter(file => file.kind === 'chart');
  if (actual.length !== candidate.files.length || !candidate.files.every(file => actual.some(value =>
    value.url === file.url && value.sha256 === file.sha256 && value.byteLength === file.byteLength))) return false;
  const resources = [...candidate.references, ...(catalog.procedures ? [catalog.procedures] : [])];
  return resources.every(resource => plan.references.some(saved => saved.id === resource.id &&
    saved.url === new URL(resource.url, location.href).href && JSON.stringify({ ...resource, url: saved.url }) === JSON.stringify(saved)));
}
