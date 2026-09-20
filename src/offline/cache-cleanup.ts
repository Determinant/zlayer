import { chartPackageUrl, type CatalogResponse } from '@zlayer/contracts';
import { isOnChartFeed } from '../workspace/catalog/feed';
import { readOfflineRecord, writeOfflineRecord } from '../core/storage/database';
import { cacheAccessKey, cacheLastUsed, noteCacheAccess } from '../core/storage/cache-access';
import { savedPlans } from './saved-plans';
import { retainedFiles, type DownloadPlan } from './downloads';
import { CHART_CACHE, DATA_CACHE, PDF_CACHE } from '../core/storage/cache-names';
import { activeCatalogs as readActiveCatalogs, activeFileUrls } from './active-catalogs';

export const ONLINE_CACHE_RETENTION_MS = 14 * 24 * 60 * 60 * 1_000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const LAST_CLEANUP = 'online-cache-cleanup:last';

export function catalogResourceUrls(catalog: CatalogResponse, base: string): string[] {
  const references = [...catalog.navigation, catalog.airways, catalog.terminalProcedures,
    catalog.preferredRoutes, catalog.routeHistory, catalog.procedures].filter(value => value !== undefined);
  const urls = [...references.map(value => new URL(value.url, base).href),
    ...catalog.charts.map(chart => new URL(chart.url, base).href)];
  if (catalog.chartPackages) {
    const root = new URL(catalog.chartPackages.root, base).href;
    urls.push(...catalog.chartPackages.archives.map(file => chartPackageUrl(root, file)));
    urls.push(`${root}/manifest.json`);
  }
  // Discovery metadata stays with the active catalog, including legacy layouts.
  for (const resource of references) {
    const url = new URL(resource.url, base);
    urls.push(new URL('manifest.json', url).href);
    if (resource.id === 'procedures') urls.push(new URL('../cs/catalog.json', url).href);
  }
  return urls;
}

export function retainedResourceUrls(plan: DownloadPlan): string[] {
  return [...retainedFiles(plan).map(file => file.url), ...plan.references.map(resource => resource.url),
    ...(plan.previous?.references.map(resource => resource.url) ?? [])];
}

/** Opportunistic FAA cache expires independently of the explicitly saved inventory.
 * All tabs and download mutations use the same lock; unreadable inventory fails closed. */
export async function pruneOnlineCache(activeCatalogs: readonly CatalogResponse[], options: {
  now?: number; force?: boolean;
} = {}): Promise<{ removed: number }> {
  if (!navigator.locks || navigator.onLine === false) return { removed: 0 };
  return navigator.locks.request('zlayer-region-downloads', { ifAvailable: true }, async lock => {
    if (!lock) return { removed: 0 };
    const now = options.now ?? Date.now();
    const last = await readOfflineRecord(LAST_CLEANUP);
    if (!options.force && typeof last === 'number' && now - last < CLEANUP_INTERVAL_MS) return { removed: 0 };
    const plans = await savedPlans(true);
    const protectedUrls = new Set([
      ...plans.flatMap(retainedResourceUrls),
      ...await activeFileUrls(),
      ...activeCatalogs.flatMap(catalog => catalogResourceUrls(catalog, location.href)),
      ...(await readActiveCatalogs()).flatMap(catalog => catalogResourceUrls(catalog, location.href)),
    ]);
    let removed = 0;
    for (const name of [CHART_CACHE, PDF_CACHE, DATA_CACHE]) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        if (protectedUrls.has(request.url)) continue;
        // DATA_CACHE also contains weather and basemap resources with separate lifetimes.
        if (name === DATA_CACHE && !isOnChartFeed(new URL(request.url), location.href)) continue;
        const lastUsed = await cacheLastUsed(name, request.url);
        if (lastUsed === undefined) {
          await noteCacheAccess(name, request.url, now); // Existing installs receive a full grace period.
          continue;
        }
        if (now - lastUsed < ONLINE_CACHE_RETENTION_MS) continue;
        if (await cache.delete(request)) removed++;
        await writeOfflineRecord(cacheAccessKey(name, request.url), undefined);
        if (name === CHART_CACHE) navigator.serviceWorker?.controller?.postMessage({ type: 'forget-chart-memory', url: request.url });
      }
    }
    await writeOfflineRecord(LAST_CLEANUP, now);
    return { removed };
  });
}
