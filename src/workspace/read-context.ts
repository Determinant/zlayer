import type { CatalogResponse, ChartSupplementCatalog, GeoPointFeature } from '@zlayer/contracts';
import type { SavedBundle } from '../offline/bundle-repository';
import { regionContainsPoint } from '../offline/region-coverage';
import { jsonIdentity } from '../core/data/json-identity';
import { OFFLINE_REGIONS } from '../offline/regions';

/** A workspace can read several editions, but each published catalog stays intact.
 * National route topology comes from one complete export, never a regional merge. */
export type WorkspaceReadContext = {
  browsing: CatalogResponse;
  routing: CatalogResponse;
  bundles: readonly SavedBundle[];
  charts: CatalogResponse['charts'];
};
export type CatalogReadSource = CatalogResponse | WorkspaceReadContext;

export function regionalBundles(catalog: CatalogReadSource): readonly SavedBundle[] {
  return 'bundles' in catalog ? catalog.bundles : [];
}
export function browsingCatalog(catalog: CatalogReadSource): CatalogResponse {
  return 'browsing' in catalog ? catalog.browsing : catalog;
}
export function routingCatalog(catalog: CatalogReadSource): CatalogResponse {
  return 'routing' in catalog ? catalog.routing : catalog;
}
export function regionalCatalogKey(catalog: CatalogReadSource): string {
  return JSON.stringify([navigationSourceKey(browsingCatalog(catalog)), ...regionalBundles(catalog).map(bundle => bundle.key)]);
}

export function createWorkspaceReadContext(browsing: CatalogResponse, bundles: readonly SavedBundle[]): WorkspaceReadContext {
  // An older download of the same state remains retained, but owns no display
  // area. It must not add dependencies or failure notices to the active view.
  const claimed = new Set<string>();
  bundles = bundles.filter(bundle => {
    const id = bundle.plan.regionId;
    if (!id || !OFFLINE_REGIONS.some(region => region.id === id)) return true;
    if (claimed.has(id)) return false;
    claimed.add(id);
    return true;
  });
  // Every region stores complete national reference exports. Use one saved export
  // for route topology/search; never splice airway graphs from different editions.
  const routing = bundles[0]?.catalog ?? browsing;
  const charts = new Map(browsing.charts.map(chart => [chart.id, chart]));
  for (const bundle of bundles) for (const chart of bundle.catalog.charts) {
    const prior = charts.get(chart.id);
    if (!prior || chart.maxZoom > prior.maxZoom) charts.set(chart.id, chart);
  }
  return { browsing, routing, bundles, charts: [...charts.values()] };
}

export function bundleForFeature(catalog: CatalogReadSource, feature: GeoPointFeature): SavedBundle | undefined {
  return regionalBundles(catalog).find(bundle =>
    regionContainsPoint(bundle.plan.regionId, bundle.bounds, feature.geometry.coordinates));
}

/** A serialized source key survives search, weather enrichment and MapLibre copies. */
const sourceKeys = new WeakMap<CatalogResponse, string>();
export function navigationSourceKey(source: CatalogResponse): string {
  let key = sourceKeys.get(source);
  if (!key) {
    // Chart coverage and live weather do not change a navigation/plate source.
    const { charts: _charts, chartPackages: _packages, weather: _weather, ...references } = source;
    key = `catalog:${jsonIdentity(references)}`;
    sourceKeys.set(source, key);
  }
  return key;
}

export function catalogForFeature(catalog: CatalogReadSource, feature: GeoPointFeature): CatalogResponse | undefined {
  const source = feature.properties.dataSourceKey;
  if (source !== undefined) {
    const owner = bundleForFeature(catalog, feature);
    if (owner && source === navigationSourceKey(owner.catalog)) return owner.catalog;
    const browsing = browsingCatalog(catalog);
    if (source === navigationSourceKey(browsing)) return browsing;
    return regionalBundles(catalog).find(bundle => source === navigationSourceKey(bundle.catalog))?.catalog;
  }
  return bundleForFeature(catalog, feature)?.catalog ?? browsingCatalog(catalog);
}


export type SavedSupplement = { catalog?: ChartSupplementCatalog; url: string };
export function supplementForFeature(catalog: CatalogReadSource, feature: GeoPointFeature): SavedSupplement | undefined {
  const source = catalogForFeature(catalog, feature);
  if (!source) return { url: '' }; // Do not substitute current metadata for a retired feature source.
  const bundle = bundleForFeature(catalog, feature);
  if (!bundle) return undefined;
  if (bundle.catalog !== source) return { url: '' };
  const reference = bundle.plan.references.find(reference => reference.id === 'chart-supplements');
  if (reference?.id === 'chart-supplements') return reference.snapshot ? { url: reference.url, catalog: reference.snapshot } : undefined;
  return { url: '' }; // The saved edition has no applicable supplement; do not adopt a newer one.
}
