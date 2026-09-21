import { supplementTargetKey, type ChartSupplementCatalog, type ChartSupplementTarget, type GeoPointFeature } from '@zlayer/contracts';
import { featureIdentifiers } from '@zlayer/domain';
import type { OfflineRegion } from '../../offline/regions';
import { regionContainsPoint } from '../../offline/region-coverage';

export function regionAirportIds(airports: readonly GeoPointFeature[], region: OfflineRegion): Set<string> {
  return new Set(airports.filter(feature =>
    regionContainsPoint(region.id, region.bounds, feature.geometry.coordinates)
  ).flatMap(featureIdentifiers));
}

/** Only the region's page targets and book metadata are copied; PDF bytes stay shared. */
export function supplementSnapshot(catalog: ChartSupplementCatalog, region: OfflineRegion, identifiers: ReadonlySet<string>) {
  const applies = (airport: ChartSupplementTarget) => airport.state === region.title.toUpperCase() || identifiers.has(airport.faaId);
  const airports = catalog.airports.filter(applies);
  const expected = catalog.expected?.filter(applies);
  const ids = new Set(airports.map(airport => airport.volumeId));
  return airports.length ? { ...catalog, airports, ...(expected ? { expected } : {}), volumes: catalog.volumes.filter(volume => ids.has(volume.id)) } : undefined;
}

export function requiredSupplementTargets(catalog: ChartSupplementCatalog, region: OfflineRegion, identifiers: ReadonlySet<string>) {
  if (!catalog.expected) throw new Error('Chart Supplement coverage is unavailable. Refresh the published index before saving this region.');
  const expected = catalog.expected.filter(target => target.state === region.title.toUpperCase() || identifiers.has(target.faaId));
  const available = new Set(catalog.airports.map(supplementTargetKey));
  const volumes = new Set(catalog.volumes.map(volume => volume.id));
  const missing = expected.filter(target => !available.has(supplementTargetKey(target)) || !volumes.has(target.volumeId));
  if (missing.length) throw new Error(`${region.title}: Chart Supplement coverage is incomplete (${[...new Set(missing.map(t => t.volumeId))].join(', ')}). Retry after the missing books are published.`);
  return expected;
}
