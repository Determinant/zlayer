import { isRecord, type CatalogResponse } from '@zlayer/contracts';
import type { ReferenceResource } from '../../core/data/references';
import type { DownloadPlan } from '../downloads';
import { isDownloadPlan } from '../plan-records';

/** Upgrade URL-only records from matching cached catalogs, without any network I/O. */
export function restoreDownloadPlan(value: unknown, catalogs: readonly CatalogResponse[], baseUrl: string): DownloadPlan | undefined {
  if (isDownloadPlan(value)) return value;
  if (!isRecord(value) || value.references !== undefined || !Array.isArray(value.referenceUrls) ||
    !value.referenceUrls.every(url => typeof url === 'string')) return undefined;
  const known = new Map<string, ReferenceResource>();
  for (const catalog of catalogs) {
    if (catalog.revision !== value.revision) continue;
    const resources: ReferenceResource[] = [...catalog.navigation,
      ...(catalog.airways ? [catalog.airways] : []), ...(catalog.preferredRoutes ? [catalog.preferredRoutes] : []),
      ...(catalog.routeHistory ? [catalog.routeHistory] : []),
      ...(catalog.terminalProcedures ? [catalog.terminalProcedures] : []),
      ...(catalog.procedures ? [catalog.procedures] : []),
    ];
    for (const resource of resources) {
      try {
        const url = new URL(resource.url, baseUrl).href;
        known.set(url, { ...resource, url });
        if (resource.id === 'procedures') {
          const supplementUrl = new URL('../cs/catalog.json', url).href;
          known.set(supplementUrl, { id: 'chart-supplements', url: supplementUrl });
        }
      } catch { /* Keep unresolvable legacy references unverified, without hiding saved files. */ }
    }
  }
  const { referenceUrls, ...fields } = value;
  const restored = { ...fields, references: referenceUrls.map((url: string) =>
    known.get(url) ?? { id: 'unverified', url }) };
  return isDownloadPlan(restored) ? restored : undefined;
}
