import type { ChartSupplementCatalog, GeoPointFeature } from '@zlayer/contracts';
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
  const airports = catalog.airports.filter(airport => airport.state === region.title.toUpperCase() || identifiers.has(airport.faaId));
  const ids = new Set(airports.map(airport => airport.volumeId));
  return airports.length ? { ...catalog, airports, volumes: catalog.volumes.filter(volume => ids.has(volume.id)) } : undefined;
}
