import { type ChartSupplementCatalog, type GeoPointFeature } from '@zlayer/contracts';
import { featureIdentifiers, normalizeIdentifier } from '@zlayer/domain';
import { chartRoot } from '../../workspace/catalog/feed';
import { bookDocument, type ProcedureSelection } from './data';
import { savedAirportSupplements } from '../../offline/saved-supplements';
import { readSupplementCatalog } from '../../offline/supplement-catalog';

export function supplementCatalogUrl(revision: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(revision)) throw new Error('Invalid Chart Supplement revision');
  return `${chartRoot()}/${revision}/cs/catalog.json`;
}

/** Small metadata loads once on opening Plates; no PDF is fetched until selection. */
export function fetchChartSupplements(revision: string): Promise<ChartSupplementCatalog | undefined> {
  return readSupplementCatalog(supplementCatalogUrl(revision), revision);
}

export async function fetchAirportSupplements(revision: string, feature: GeoPointFeature): Promise<ChartSupplementCatalog | undefined> {
  const saved = await savedAirportSupplements(feature, revision).catch(() => undefined);
  if (saved) return saved;
  const latest = await fetchChartSupplements(revision);
  // Loading may have captured an older selection's page targets during migration.
  return await savedAirportSupplements(feature, revision).catch(() => undefined) ?? latest;
}

export function supplementSelections(
  catalog: ChartSupplementCatalog,
  feature: GeoPointFeature,
  catalogUrl: string,
  baseUrl: string,
): Array<{ selection: ProcedureSelection; volumeId: string; printedPage: string }> {
  const identifiers = new Set(featureIdentifiers(feature));
  return catalog.airports.filter(airport => identifiers.has(airport.faaId)).map(airport => {
    const volume = catalog.volumes.find(volume => volume.id === airport.volumeId)!;
    return { volumeId: volume.id, printedPage: airport.printedPage, selection: {
      airport: { id: normalizeIdentifier(feature.properties.icaoId) ?? airport.faaId },
      procedure: { id: `cs:${airport.faaId}:${volume.id}:${airport.pageIndex}`, name: 'Chart Supplement' },
      document: { ...bookDocument(volume, airport.pageIndex, catalogUrl, baseUrl), source: 'chart-supplement' },
      cycle: catalog.effectiveDate,
      effectiveDate: catalog.effectiveDate,
      expirationDate: catalog.expirationDate,
    } };
  });
}
