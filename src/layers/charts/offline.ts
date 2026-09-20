import { chartPackageUrl, packageBoundsIntersect, type CatalogResponse } from '@zlayer/contracts';
import type { DownloadPlan } from '../../offline/downloads';
import { OFFLINE_REGIONS, type OfflineRegion } from '../../offline/regions';

export function chartRegionPlans(catalog: CatalogResponse, baseUrl: string,
  regions: readonly OfflineRegion[] = OFFLINE_REGIONS): Array<{ region: OfflineRegion; plan: DownloadPlan }> {
  const index = catalog.chartPackages;
  if (!index || !catalog.airways || !['airports', 'fixes', 'navaids', 'vfr-waypoints']
    .every(id => catalog.navigation.some(layer => layer.id === id))) return [];
  const root = new URL(index.root, baseUrl).href;
  const files = new Map(index.archives.map(file => [file.id, {
    url: chartPackageUrl(root, file), byteLength: file.byteLength, sha256: file.sha256, kind: 'chart' as const,
  }]));
  const references = [...catalog.navigation, catalog.airways,
    ...(catalog.preferredRoutes ? [catalog.preferredRoutes] : []),
    ...(catalog.terminalProcedures ? [catalog.terminalProcedures] : []),
    ...(catalog.routeHistory ? [catalog.routeHistory] : [])]
    .map(resource => ({ ...resource, url: new URL(resource.url, baseUrl).href }));
  return regions.filter(region => catalog.charts.some(chart =>
    region.bounds.some(bounds => packageBoundsIntersect(bounds, chart.bounds))))
    .map(region => ({ region, plan: {
      id: `${root}|${region.id}|all-v1`,
      regionId: region.id,
      title: `${region.title} (${region.code})`,
      revision: catalog.revision,
      catalog,
      bounds: region.bounds,
      files: index.archives.filter(file => region.bounds.some(bounds => packageBoundsIntersect(bounds, file.bounds)))
        .map(file => files.get(file.id)!),
      references,
    } })).filter(({ plan }) => plan.files.length > 0);
}
