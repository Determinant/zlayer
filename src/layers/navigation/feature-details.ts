import type { GeoPointFeature, NavigationData } from '@zlayer/contracts';
import { isAirportFeature, routeCoordinateFeature } from '@zlayer/domain';
import { metarDetailRows } from '../metar-taf/metar/details';
import { navaidMorse, type NavaidMorse } from './navaid-morse';
import { airportFrequencyRows } from './airport-frequencies';

export type FeatureDetailRow = {
  label: string;
  value: string;
  wide?: boolean;
  frequency?: true;
  morse?: NavaidMorse;
  notes?: string[];
};

export function featureDetailRows(feature: GeoPointFeature, includeWeather = true): FeatureDetailRow[] {
  const properties = feature.properties;
  const airport = isAirportFeature(feature);
  return compactRows([
    ...(includeWeather ? metarDetailRows(properties).filter(row => row.label !== 'Raw') : []),
    !airport ? row('Type', properties.type ?? properties.facilityType ?? properties.kind) : undefined,
    row('Elevation', formatNumber(properties.elevationFt, ' ft')),
    !airport ? frequencyRow(feature) : undefined,
    row('Longest runway', formatNumber(properties.longestRunwayFt, ' ft')),
    ...(airport ? airportFrequencyRows(properties.frequencies) : []),
    !airport ? row('ARTCC', properties.lowArtcc) : undefined,
    includeWeather ? row('Raw', properties.rawMetar, true) : undefined,
    coordinateRow(feature),
  ]);
}

function coordinateRow(feature: GeoPointFeature): FeatureDetailRow | undefined {
  if (!['navaid', 'fix', 'vfr-waypoint', 'coordinate'].includes(feature.properties.kind ?? '')) return undefined;
  const [longitude, latitude] = feature.geometry.coordinates;
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(latitude) > 90) return undefined;
  // GPS identifiers retain the exact saved seconds even after map geometry is rounded.
  const ident = feature.properties.kind === 'coordinate' ? feature.properties.ident
    : routeCoordinateFeature(feature.geometry.coordinates).properties.ident;
  const coordinate = ident?.replace(
    /^(\d{2})(\d{2})(\d{2})([NS])(\d{3})(\d{2})(\d{2})([EW])$/, '$1°$2′$3″$4 $5°$6′$7″$8',
  );
  return row('Coordinates', coordinate, true);
}

function frequencyRow(feature: GeoPointFeature): FeatureDetailRow | undefined {
  const frequency = row('Frequency', feature.properties.frequency);
  if (!frequency) return undefined;
  const morse = navaidMorse(feature);
  return morse ? { ...frequency, morse } : frequency;
}

function row(
  label: string,
  value: string | number | undefined,
  wide = false,
): FeatureDetailRow | undefined {
  if (value === undefined || value === '') return undefined;
  return { label, value: String(value), ...(wide ? { wide: true } : {}) };
}

function compactRows(
  rows: Array<FeatureDetailRow | undefined>,
): FeatureDetailRow[] {
  return rows.filter((item): item is FeatureDetailRow => item !== undefined);
}

function formatNumber(value: number | undefined, suffix: string): string | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${value.toLocaleString()}${suffix}`
    : undefined;
}

/** Restore nested detail data after MapLibre serializes properties for rendering. */
export function resolveNavigationFeature(feature: GeoPointFeature, data: NavigationData): GeoPointFeature {
  if (feature.id === undefined) return feature;
  for (const collection of Object.values(data)) {
    const original = collection?.features.find(candidate => candidate.id === feature.id &&
      candidate.properties.dataSourceKey === feature.properties.dataSourceKey &&
      candidate.properties.dataRevision === feature.properties.dataRevision);
    if (original) return original;
  }
  return feature;
}
