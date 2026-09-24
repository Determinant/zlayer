import { isCatalogResponse } from '@zlayer/contracts';
import { offlineRecords, readOfflineRecord, writeOfflineRecord } from '../../core/storage/database';
import type { ChartCatalog } from './catalog';
import { defaultCycleSelection, isSupportedCycle, type CycleSelection } from './cycles';
import { chartRoot } from './feed';
import { formatDate } from '../../core/format/time';

function prefix(): string { return `catalog:${chartRoot()}:`; }
function selectionKey(): string { return `catalog-selection:${chartRoot()}`; }

export async function savedCatalogs(): Promise<{ catalogs: ChartCatalog[]; catalog?: ChartCatalog; selection: CycleSelection }> {
  const [records, selected] = await Promise.all([
    offlineRecords(prefix()).catch((): unknown[] => []), readOfflineRecord(selectionKey()).catch(() => undefined),
  ]);
  const catalogs = records.filter(isCatalogResponse).map(value => ({ ...value, issues: [] }))
    .filter(value => isSupportedCycle(value.revision) && hasCatalogData(value))
    .sort((a, b) => b.revision.localeCompare(a.revision));
  const selection = selected === 'latest' || isSupportedCycle(selected) ? selected : defaultCycleSelection();
  const catalog = catalogs.find(value => value.revision === selection) ?? catalogs[0];
  return { catalogs, selection, ...(catalog ? { catalog } : {}) };
}

export function selectSavedCycle(revision: CycleSelection): Promise<void> {
  return writeOfflineRecord(selectionKey(), revision);
}

export function hasCatalogData(catalog: ChartCatalog): boolean {
  return catalog.charts.length > 0 || catalog.navigation.length > 0 || catalog.procedures !== undefined;
}

export async function saveCatalog(catalog: ChartCatalog): Promise<void> {
  if (isSupportedCycle(catalog.revision) && hasCatalogData(catalog)) await writeOfflineRecord(`${prefix()}${catalog.revision}`, catalog);
}

/** A failed refresh must not discard an already usable, same-cycle product. */
export function retainCachedProducts(fresh: ChartCatalog, cached?: ChartCatalog): ChartCatalog {
  if (!cached || cached.revision !== fresh.revision) return fresh;
  const result = { ...fresh };
  for (const issue of fresh.issues) {
    if (issue.product === 'charts') {
      result.charts = cached.charts;
      if (cached.chartPackages) result.chartPackages = cached.chartPackages;
    } else if (issue.product === 'navigation') {
      result.navigation = cached.navigation;
      if (cached.airways) result.airways = cached.airways;
      if (cached.terminalProcedures) result.terminalProcedures = cached.terminalProcedures;
      if (cached.preferredRoutes) result.preferredRoutes = cached.preferredRoutes;
      if (cached.routeHistory) result.routeHistory = cached.routeHistory;
    } else if (issue.product === 'terrain') {
      if (cached.terrain) result.terrain = cached.terrain;
    } else if (issue.product === 'route-history') {
      if (cached.routeHistory) result.routeHistory = cached.routeHistory;
    } else if (cached.procedures) result.procedures = cached.procedures;
  }
  if (cached.charts.length) result.issues = result.issues.map(issue => issue.product === 'charts'
    ? { ...issue, message: `Chart refresh failed; using saved FAA ${formatDate(cached.revision)} charts. ${issue.message}` }
    : issue);
  return result;
}
