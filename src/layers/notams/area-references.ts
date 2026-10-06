import type { GeoPointFeature, NavigationData, NotamRecord } from '@zlayer/contracts';
import { featureIdentifiers, isAirportFeature, isRadialCoordinate, isVorReference, positionOnRadial, radialReference } from '@zlayer/domain';
import type { NotamCoordinate } from './coordinates';

export type NotamAreaReference = { ident: string; radial?: number; distanceNm?: number; kind?: 'airport' | 'navaid' };
export type NotamAreaReferences = (location: NotamAreaReference, record: NotamRecord) => NotamCoordinate | undefined;

/** Resolve only published identities. A VOR radial uses station alignment, never airport variation or WMM. */
export function createNotamAreaReferences(data: NavigationData): NotamAreaReferences {
  const index = new Map<string, GeoPointFeature[]>();
  for (const feature of [...data.airports?.features ?? [], ...data.navaids?.features ?? []]) {
    if (!isRadialCoordinate(feature.geometry.coordinates)) continue;
    for (const ident of featureIdentifiers(feature)) index.set(ident, [...index.get(ident) ?? [], feature]);
  }
  return (location, record) => {
    const candidates = index.get(location.ident) ?? [];
    if (location.radial !== undefined && location.distanceNm !== undefined) {
      const stations = candidates.filter(isVorReference);
      // Ambiguous stations and stations without published alignment remain unresolved.
      if (stations.length !== 1) return;
      const reference = radialReference(stations[0]!);
      return reference ? positionOnRadial(reference, location.radial, location.distanceNm).coordinate : undefined;
    }
    let matches = candidates.filter(f => !location.kind || (location.kind === 'airport' ? isAirportFeature(f) : isVorReference(f)));
    if (!location.kind && matches.length > 1) {
      // A published airport ICAO association disambiguates its bare local airport ID.
      const airports = matches.filter(f => isAirportFeature(f) &&
        typeof f.properties.icaoId === 'string' && record.icaoLocations.includes(f.properties.icaoId));
      if (airports.length === 1) matches = airports;
    }
    return matches.length === 1 ? [...matches[0]!.geometry.coordinates] : undefined;
  };
}
