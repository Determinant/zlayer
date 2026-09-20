import type { GeoPointFeature } from '@zlayer/contracts';

/** Identifier preference is shared by display, search and route resolution. */
export function featureIdentifiers(feature: GeoPointFeature): string[] {
  const { icaoId, faaId, ident } = feature.properties;
  return normalizedIdentifiers([icaoId, faaId, ident]);
}

/** Airport services use ICAO/FAA aliases, without treating a generic ident as an airport code. */
export function airportIdentifiers(feature: GeoPointFeature): string[] {
  const { icaoId, faaId } = feature.properties;
  return normalizedIdentifiers([icaoId, faaId]);
}

export function normalizeIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim().toUpperCase() || undefined : undefined;
}

function normalizedIdentifiers(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.map(normalizeIdentifier).filter((value): value is string => value !== undefined))];
}

export function featureIdent(feature: GeoPointFeature): string {
  return featureIdentifiers(feature)[0] ?? feature.properties.name ?? 'Unknown';
}

export function featureSubtitle(feature: GeoPointFeature): string {
  const name = String(feature.properties.name ?? 'FAA navigation point');
  const location = [feature.properties.city, feature.properties.state].filter(Boolean).join(', ');
  return location ? `${name} · ${location}` : name;
}

export function isAirportFeature(feature: GeoPointFeature): boolean {
  return feature.properties.kind === 'airport' || feature.properties.kind === 'landing-facility';
}

/** Entity identity excludes route occurrences and reference-data editions. */
export function featureKey(feature: GeoPointFeature): string {
  if (feature.id !== undefined) return feature.id;
  const ident = featureIdentifiers(feature)[0] ?? '';
  const kind = isAirportFeature(feature) ? 'airport' : feature.properties.kind;
  // GPS identifiers encode the coordinate; rendered geometry may be rounded or
  // moved during a drag while the selected waypoint keeps its original identity.
  return JSON.stringify(kind === 'coordinate' && ident ? [kind, ident]
    : [kind, ident, feature.geometry.coordinates]);
}

export function sameFeature(left: GeoPointFeature, right: GeoPointFeature): boolean {
  if (left.id !== undefined || right.id !== undefined) return left.id === right.id;
  return featureKey(left) === featureKey(right);
}
