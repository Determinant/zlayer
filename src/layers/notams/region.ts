import { isNotamRegionQuery, type GeoPointProperties, type NotamRegionQuery } from '@zlayer/contracts';

/** Only published associations. Center radio assignments and ICAO prefixes are not aliases. */
export function airportNotamRegion(airport: GeoPointProperties): NotamRegionQuery | undefined {
  const code = (value: unknown) => typeof value === 'string' ? value.trim().toUpperCase() : '';
  const artccId = airport.country === 'US' ? code(airport.responsibleArtcc) : '';
  const firId = code(airport.firId);
  const query = { ...(artccId ? { artccId } : {}), ...(firId ? { firId } : {}) };
  return isNotamRegionQuery(query) ? query : undefined;
}
