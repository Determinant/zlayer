import type { CatalogResponse, ProcedureCatalog, ChartSupplementCatalog, GeoPointFeature } from '@zlayer/contracts';
import type { DownloadPlan, OfflineFile } from '../../offline/downloads';
import type { OfflineRegion } from '../../offline/regions';
import { fetchNavigation } from '../navigation/api';
import { fetchProcedureCatalog } from './api';
import { fetchChartSupplements, supplementCatalogUrl } from './supplements';
import { bookDocument, procedureDocument } from './data';
import { regionAirportIds, requiredSupplementTargets, supplementSnapshot } from './supplement-snapshot';
import { jsonIdentity } from '../../core/data/json-identity';

// An immutable national index is shared across every region planned in Settings.
const procedureIdentities = new WeakMap<ProcedureCatalog, string>();

export type OfflinePlateIndex = {
  airports: GeoPointFeature[];
  procedures: ProcedureCatalog;
  supplements: ChartSupplementCatalog;
};

export async function fetchOfflinePlateIndex(catalog: CatalogResponse): Promise<OfflinePlateIndex> {
  const airports = catalog.navigation.find(layer => layer.id === 'airports');
  if (!airports || !catalog.procedures) throw new Error('Airport and plate indexes are required for regional plate downloads');
  const [navigation, procedures, supplements] = await Promise.all([
    // Book coverage must not be clipped to whichever chart footprints were published.
    fetchNavigation(airports, catalog.revision, []),
    fetchProcedureCatalog(catalog.procedures), fetchChartSupplements(catalog.revision),
  ]);
  if (!supplements) throw new Error('Chart Supplement index is unavailable; retry before downloading a complete region');
  return { airports: navigation.features, procedures, supplements };
}

export function withRegionPlates(plan: DownloadPlan, region: OfflineRegion, index: OfflinePlateIndex,
  catalog: CatalogResponse, baseUrl: string): DownloadPlan {
  let jsonSha256 = procedureIdentities.get(index.procedures);
  if (!jsonSha256) { jsonSha256 = jsonIdentity(index.procedures); procedureIdentities.set(index.procedures, jsonSha256); }
  const procedures = { ...catalog.procedures!, jsonSha256 };
  const identifiers = regionAirportIds(index.airports, region);
  const supplementTargets = requiredSupplementTargets(index.supplements, region, identifiers);
  const snapshot = supplementSnapshot(index.supplements, region, identifiers);
  const files = new Map(plan.files.map(file => [file.url, file]));
  const volumeIds = new Set(index.procedures.airports
    // Pacific TPPs use state XX; NASR identifiers supply their actual territory.
    .filter(airport => airport.state === region.code || identifiers.has(airport.faaId) || identifiers.has(airport.id))
    .flatMap(airport => airport.procedures.filter(procedure => procedure.source.userAction !== 'D').flatMap(procedure => {
      if (!procedure.volumeTarget) {
        const doc = procedureDocument(index.procedures, procedure, catalog.procedures!.url, baseUrl);
        files.set(doc.url, { url: doc.url, kind: 'faa-pdf' });
        return [];
      }
      if (procedure.volumeTarget.pageIndex === null) throw new Error(
        `${airport.id}: ${procedure.name} has an unresolved book page. Retry after the plate index is corrected.`,
      );
      return procedure.volumeTarget.volumeId;
    })));
  const supplementIds = new Set(index.supplements.airports.filter(airport =>
    airport.state === region.title.toUpperCase() || identifiers.has(airport.faaId)).map(airport => airport.volumeId));
  for (const [volumes, ids, catalogUrl] of [
    [index.procedures.volumes, volumeIds, catalog.procedures!.url],
    [index.supplements.volumes, supplementIds, supplementCatalogUrl(catalog.revision)],
  ] as const) {
    for (const volume of volumes) if (ids.has(volume.id)) {
      const doc = bookDocument(volume, 0, catalogUrl, baseUrl);
      const file: OfflineFile = { url: doc.url, byteLength: volume.byteLength, sha256: volume.sha256, kind: 'pdf' };
      files.set(file.url, file);
    }
  }
  return { ...plan, supplementTargets, catalog: { ...catalog, procedures }, files: [...files.values()],
    references: [...plan.references, procedures,
      ...(snapshot ? [{ id: 'chart-supplements' as const, url: supplementCatalogUrl(catalog.revision), snapshot }] : [])]
      .map(resource => ({ ...resource, url: new URL(resource.url, baseUrl).href })),
  };
}
