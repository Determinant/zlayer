import type {
  GeoPointFeature,
  AirwayDataResponse,
  AirwayResourceRecord,
  ChartRecord,
  FeatureCollectionResponse,
  NavigationLayerRecord,
  NavigationLayerId,
} from '@zlayer/contracts';
import { featureKey } from '@zlayer/domain';
import { formatDate } from '../../core/format/time';
import { isInsideChartCoverage } from '../../workspace/catalog/catalog';
import { fetchJson } from '../../core/data/fetch-json';
import { navigationDocumentGuard, airwayDocumentGuard, type SourceFeatureCollection } from '../../core/data/references';
import { ResourceCache } from '../../core/data/resource-cache';

import { browsingCatalog, routingCatalog, bundleForFeature, regionalBundles, regionalCatalogKey,
  navigationSourceKey, type CatalogReadSource } from '../../workspace/read-context';
import { OFFLINE_REGIONS } from '../../offline/regions';

const navigationSources = new ResourceCache<SourceFeatureCollection>();
const navigationViews = new ResourceCache<FeatureCollectionResponse>();
const airwayCache = new ResourceCache<AirwayDataResponse>();

export type NavigationIssue = {
  layer: NavigationLayerId;
  revision: string;
  regionId?: string;
  regionTitle?: string;
  fallbackRevision?: string;
};
export type NavigationResult = { collection?: FeatureCollectionResponse; issues: NavigationIssue[] };

export function navigationIssueMessages(issues: readonly NavigationIssue[]): string[] {
  const groups = new Map<string, NavigationIssue[]>();
  for (const issue of issues) {
    const key = JSON.stringify([issue.regionId, issue.regionTitle, issue.revision, issue.fallbackRevision]);
    const group = groups.get(key) ?? [];
    group.push(issue); groups.set(key, group);
  }
  return [...groups.values()].map(group => {
    const issue = group[0]!;
    const products = [...new Set(group.map(issue => issue.layer.replaceAll('-', ' ')))].join(', ');
    return `${issue.regionTitle ?? 'Browsing'} · ${formatDate(issue.revision)}: ${products} unavailable` +
      (issue.fallbackRevision ? `; using ${formatDate(issue.fallbackRevision)} outside saved regions.` : '.');
  });
}

/** Map/search layers are the union of the browsing and saved products. Routing
 * deliberately continues to use its one national catalog's navigation list. */
export function regionalNavigationLayers(catalog: CatalogReadSource): NavigationLayerRecord[] {
  const sources = [browsingCatalog(catalog), ...regionalBundles(catalog).map(bundle => bundle.catalog)];
  return [...new Map(sources.flatMap(source => source.navigation).map(layer => [layer.id, layer])).values()];
}

export async function fetchNavigationResult(layer: NavigationLayerRecord, revision: string,
  charts: readonly ChartRecord[], scope?: CatalogReadSource): Promise<NavigationResult> {
  try {
    return scope ? await fetchRegionalNavigation(scope, layer.id, charts)
      : { collection: await fetchNavigation(layer, revision, charts), issues: [] };
  }
  catch { return { issues: [{ layer: layer.id, revision }] }; }
}

/** Product and regional failures are values, so healthy data remains usable. */
export async function fetchNavigationCollections(layers: readonly NavigationLayerRecord[], revision: string, charts: readonly ChartRecord[], scope?: CatalogReadSource) {
  const results = await Promise.all(layers.map(layer => fetchNavigationResult(layer, revision, charts, scope)));
  const collections: FeatureCollectionResponse[] = [];
  const unavailable: NavigationLayerId[] = [];
  results.forEach((result, index) => {
    if (result.collection) collections.push(result.collection);
    else unavailable.push(layers[index]!.id);
  });
  return { collections, unavailable, issues: results.flatMap(result => result.issues) };
}

export async function fetchNavigation(
  layer: NavigationLayerRecord,
  revision: string,
  charts: readonly ChartRecord[],
  scope?: CatalogReadSource,
): Promise<FeatureCollectionResponse> {
  if (scope) {
    const result = await fetchRegionalNavigation(scope, layer.id, charts);
    if (!result.collection) throw new Error(navigationIssueMessages(result.issues).join(' '));
    return result.collection;
  }
  const cacheKey = navigationRequestKey(layer, revision, charts);
  return navigationViews.get(cacheKey, async () => {
    const source = await navigationSources.get(JSON.stringify([revision, layer]),
      () => fetchJson(layer.url, navigationDocumentGuard(layer, revision), `Navigation layer ${layer.id}`, { cacheOnly: !!layer.cacheOnly }));
    const features = source.features.filter((feature) =>
      charts.length === 0 || isInsideChartCoverage(feature.geometry.coordinates, charts)
    );
    const collection: FeatureCollectionResponse = {
      type: 'FeatureCollection',
      features,
      meta: {
        revision,
        layer: layer.id,
        returned: features.length,
        truncated: false,
      },
    };
    return collection;
  });
}

export function navigationRequestKey(layer: NavigationLayerRecord, revision: string, charts: readonly ChartRecord[], scope?: CatalogReadSource): string {
  return JSON.stringify([revision, layer.id, layer.url, layer.jsonSha256, layer.cacheOnly, layer.sourceCount, charts.map(chart => chart.bounds), scope ? regionalCatalogKey(scope) : undefined]);
}

export async function fetchAirways(
  resource: AirwayResourceRecord,
  revision: string,
): Promise<AirwayDataResponse> {
  const cacheKey = JSON.stringify([revision, resource]);
  return airwayCache.get(cacheKey, () => fetchJson(
    resource.url,
    airwayDocumentGuard(resource, revision),
    'FAA airways',
    { cacheOnly: !!resource.cacheOnly },
  ));
}


const regionalCache = new WeakMap<CatalogReadSource, ResourceCache<NavigationResult>>();
async function fetchRegionalNavigation(scope: CatalogReadSource, id: NavigationLayerId,
  charts: readonly ChartRecord[]): Promise<NavigationResult> {
  let cache = regionalCache.get(scope);
  if (!cache) { cache = new ResourceCache(); regionalCache.set(scope, cache); }
  const key = JSON.stringify([id, charts.map(chart => chart.bounds)]);
  return cache.get(key, async (): Promise<NavigationResult> => {
    const browsing = browsingCatalog(scope);
    const bundles = regionalBundles(scope);
    const editions = [...new Set([browsing, ...bundles.map(bundle => bundle.catalog)])];
    const results = await Promise.allSettled(editions.map(async catalog => {
      const resource = catalog.navigation.find(layer => layer.id === id);
      if (!resource) throw new Error(`Navigation ${id} unavailable for ${routingCatalog(catalog).revision}`);
      return fetchNavigation(resource, routingCatalog(catalog).revision, []);
    }));
    const loaded = new Map(editions.flatMap((catalog, index) => {
      const result = results[index]!;
      return result.status === 'fulfilled' ? [[catalog, result.value] as const] : [];
    }));
    // A browsing failure is never a prerequisite for reading saved regions.
    // Complete national exports can still supply the existing offline fallback.
    const baseline = loaded.has(browsing) ? browsing : editions.find(catalog => loaded.has(catalog));
    const issues: NavigationIssue[] = [];
    if (!loaded.has(browsing)) issues.push({ layer: id, revision: browsing.revision,
      ...(baseline ? { fallbackRevision: baseline.revision } : {}) });
    for (const bundle of bundles) if (!loaded.has(bundle.catalog)) issues.push({ layer: id,
      revision: bundle.catalog.revision, ...(bundle.plan.regionId ? { regionId: bundle.plan.regionId } : {}),
      regionTitle: OFFLINE_REGIONS.find(region => region.id === bundle.plan.regionId)?.title ?? bundle.plan.title });
    if (!loaded.size) return { issues };
    const features = new Map<string, GeoPointFeature>();
    for (const [catalog, collection] of loaded) {
      const dataSourceKey = navigationSourceKey(catalog);
      for (const feature of collection.features) {
        const owner = bundleForFeature(scope, feature);
        if (owner ? owner.catalog !== catalog : catalog !== baseline) continue;
        if (charts.length && !isInsideChartCoverage(feature.geometry.coordinates, charts)) continue;
        features.set(featureKey(feature), { ...feature, properties: { ...feature.properties,
          dataRevision: catalog.revision, dataSourceKey } });
      }
    }
    return { collection: { type: 'FeatureCollection', features: [...features.values()],
      meta: { revision: routingCatalog(scope).revision, layer: id, returned: features.size, truncated: false } }, issues };
  // Keep successful source requests, but never memoize a partial composition:
  // reconnect, repair and subsequent searches must be able to retry missing data.
  }, result => result.issues.length === 0);
}
