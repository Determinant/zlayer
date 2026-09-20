import type { CatalogResponse } from '@zlayer/contracts';
import { jsonIdentity } from '../../core/data/json-identity';
import { browsingCatalog, regionalBundles, type CatalogReadSource } from '../../workspace/read-context';
import type { ChartFamilyId } from './overlays';

const catalogKeys = new WeakMap<CatalogResponse, Partial<Record<ChartFamilyId, string>>>();

/** Tile identity includes ordered regional ownership, but not navigation or storage health. */
export function chartSourceKey(catalog: CatalogReadSource, family: ChartFamilyId): string {
  return JSON.stringify([
    chartDefinitions(catalog, family),
    catalogKey(browsingCatalog(catalog), family),
    regionalBundles(catalog).map(bundle => [
      bundle.plan.regionId, bundle.bounds, catalogKey(bundle.catalog, family),
    ]),
  ]);
}

function catalogKey(catalog: CatalogResponse, family: ChartFamilyId): string {
  let keys = catalogKeys.get(catalog);
  if (!keys) { keys = {}; catalogKeys.set(catalog, keys); }
  return keys[family] ??= jsonIdentity([
    chartDefinitions(catalog, family),
    catalog.chartPackages ? [catalog.chartPackages.root,
      catalog.chartPackages.archives.filter(archive => archive.kind === family)
        .map(archive => [archive.id, archive.file, archive.tileMask, archive.sha256, archive.byteLength]),
    ] : null,
  ]);
}

function chartDefinitions(catalog: CatalogReadSource, family: ChartFamilyId) {
  return catalog.charts.filter(chart => chart.kind === family).map(chart => [
    chart.id, chart.revision, chart.bounds, chart.minZoom, chart.maxZoom, chart.url, chart.sha256, chart.byteLength,
  ]);
}
