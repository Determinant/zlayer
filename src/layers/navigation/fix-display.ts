import type { AirwayDataResponse, FeatureCollectionResponse, GeoPointFeature } from '@zlayer/contracts';
import { featureKey } from '@zlayer/domain';
import { AIRPORT_MIN_ZOOM } from './definitions';

export type FixDetail = 'enroute' | 'terminal' | 'all';
export type FixAirspace = 'low' | 'high' | 'both';
export type FixDisplaySettings = { detail: FixDetail; airspace: FixAirspace };
export const DEFAULT_FIX_DISPLAY: FixDisplaySettings = { detail: 'enroute', airspace: 'low' };
// Filters use integer tile zooms; the layer enforces the shared fractional cutoff.
// Rank/density, not category, decides which enroute fixes survive above it.
const ENROUTE_DENSITY_MIN_ZOOM = Math.floor(AIRPORT_MIN_ZOOM);
const FIX_TIER_MIN_ZOOM = [ENROUTE_DENSITY_MIN_ZOOM, ENROUTE_DENSITY_MIN_ZOOM, ENROUTE_DENSITY_MIN_ZOOM, 11, 12] as const;
const FIX_DENSITY_MAX_ZOOM = 10;
export type FixMapContext = {
  fixDisplay: FixDisplaySettings;
  airways: AirwayDataResponse | undefined;
  priorityFixes: readonly GeoPointFeature[];
};

type FixEntry = {
  feature: GeoPointFeature;
  low: boolean;
  high: boolean;
  terminal: boolean;
  lowConnections: number;
  highConnections: number;
};
export type FixDisplayIndex = { collection: FeatureCollectionResponse; entries: FixEntry[] };
type RankedFix = { entry: FixEntry; tier: number; connections: number };
// Retain only the current settings' ranking, not a GeoJSON copy for every mode.
const rankings = new WeakMap<FixDisplayIndex, { detail: FixDetail; airspace: FixAirspace; entries: RankedFix[] }>();

const TERMINAL_CHARTS = new Set(['SID', 'STAR', 'MILITARY SID', 'MILITARY STAR', 'SPECIAL DP']);
const OCEANIC_CHARTS = new Set(['WESTERN ATLANTIC ROUTE', 'NORTH ATLANTIC ROUTE', 'NORTH PACIFIC ROUTE']);

// Preserve density tie-breaks independently of the entity key's serialization.
function fixSortKey(feature: GeoPointFeature): string {
  return feature.id ?? `${feature.properties.ident ?? ''}:${feature.geometry.coordinates.join(',')}`;
}

/** Keep the original collection intact for search, route resolution, and feature details. */
export function indexFixDisplay(collection: FeatureCollectionResponse, airways?: AirwayDataResponse): FixDisplayIndex {
  const entries: FixEntry[] = collection.features.filter(feature => feature.properties.kind !== 'vfr-waypoint').map(feature => {
    const charts = Array.isArray(feature.properties.charts)
      ? feature.properties.charts.filter((value): value is string => typeof value === 'string')
        .map(value => value.trim().toUpperCase()) : [];
    const oceanic = charts.some(chart => OCEANIC_CHARTS.has(chart));
    return {
      feature,
      low: oceanic || charts.includes('ENROUTE LOW') || charts.includes('AREA'),
      high: oceanic || charts.includes('ENROUTE HIGH'),
      terminal: charts.some(chart => TERMINAL_CHARTS.has(chart)),
      lowConnections: 0, highConnections: 0,
    };
  });
  const byIdent = new Map<string, FixEntry[]>();
  for (const entry of entries) {
    const ident = entry.feature.properties.ident?.trim().toUpperCase();
    if (ident) {
      const matches = byIdent.get(ident);
      if (matches) matches.push(entry); else byIdent.set(ident, [entry]);
    }
  }
  // Membership names are needed only while indexing, and only for airway fixes.
  const memberships = new Map<FixEntry, Set<string>>();
  for (const airway of airways?.airways ?? []) {
    const ident = airway.ident.trim().toUpperCase();
    const band = /^[VT]\d+$/.test(ident) ? 'low' : /^[JQ]\d+$/.test(ident) ? 'high' : undefined;
    if (!band || airway.regulatory === false) continue;
    // NASR includes the last point as a from record, with no outgoing to point.
    // Qualify names by region/state/country; an ambiguous name earns no boost.
    for (const point of airway.segments) {
      if (point.fromType && /VOR|TACAN|NDB|DME|VOT/.test(point.fromType.toUpperCase())) continue;
      const candidates = (byIdent.get(point.from.trim().toUpperCase()) ?? []).filter(entry =>
        (['country', 'state', 'icaoRegion'] as const).every(key => {
          const actual = entry.feature.properties[key];
          const expected = point[key];
          return !expected || !actual || actual === expected;
        })
      );
      if (candidates.length !== 1) continue;
      const entry = candidates[0]!;
      entry[band] = true;
      let names = memberships.get(entry);
      if (!names) { names = new Set(); memberships.set(entry, names); }
      if (!names.has(ident)) {
        names.add(ident);
        if (band === 'low') entry.lowConnections++; else entry.highConnections++;
      }
    }
  }
  return { collection, entries };
}

/** Detail controls eligibility; zoom only adds detail within the chosen categories. */
export function fixDisplayData(
  index: FixDisplayIndex,
  settings: FixDisplaySettings,
  priorityFeatures: readonly GeoPointFeature[] = [],
): FeatureCollectionResponse {
  const priorityKeys = new Set(priorityFeatures.map(featureKey));
  // Filter before density placement: promoting a fix must still free its cells.
  const ranked = rankedFixes(index, settings).filter(({ entry }) => !priorityKeys.has(featureKey(entry.feature)));
  const densityZoom = createDensityZoom();
  const features = ranked.map(({ entry, tier }, order) => ({
    ...entry.feature,
    properties: { ...entry.feature.properties,
      mapFixMinZoom: densityZoom(entry.feature, FIX_TIER_MIN_ZOOM[tier]!), mapFixPriority: order },
  }));
  return { ...index.collection, features, meta: { ...index.collection.meta, returned: features.length } };
}

function rankedFixes(index: FixDisplayIndex, settings: FixDisplaySettings): RankedFix[] {
  const airspace = settings.detail === 'all' ? 'both' : settings.airspace;
  const cached = rankings.get(index);
  if (cached?.detail === settings.detail && cached.airspace === airspace) return cached.entries;
  const ranked = index.entries.flatMap(entry => {
    const enroute = airspace === 'low' ? entry.low
      : airspace === 'high' ? entry.high : entry.low || entry.high;
    const eligible = enroute || settings.detail === 'all' ||
      (settings.detail === 'terminal' && entry.terminal);
    if (!eligible) return [];
    // V/T and J/Q names are disjoint, so the union's size is their sum.
    const connections = airspace === 'low' ? entry.lowConnections
      : airspace === 'high' ? entry.highConnections : entry.lowConnections + entry.highConnections;
    const tier = enroute ? connections > 1 ? 0 : connections === 1 ? 1 : 2
      : entry.terminal ? 3 : 4;
    return [{ entry, tier, connections }];
  });
  ranked.sort((a, b) => a.tier - b.tier || b.connections - a.connections ||
    fixSortKey(a.entry.feature).localeCompare(fixSortKey(b.entry.feature)));
  rankings.set(index, { detail: settings.detail, airspace, entries: ranked });
  return ranked;
}

/** Process highest priority first. World-anchored, nested cells keep pan/zoom stable. */
function createDensityZoom(): (feature: GeoPointFeature, minimum: number) => number {
  const occupied = Array.from({ length: FIX_DENSITY_MAX_ZOOM }, () => new Set<number>());
  return (feature, minimum) => {
    if (minimum >= FIX_DENSITY_MAX_ZOOM) return minimum;
    const [longitude, latitude] = feature.geometry.coordinates;
    const x = ((longitude + 180) % 360 + 360) % 360 / 360;
    const sin = Math.sin(Math.max(-85.05112878, Math.min(85.05112878, latitude)) * Math.PI / 180);
    const y = Math.max(0, Math.min(1 - Number.EPSILON, 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)));
    let firstZoom = FIX_DENSITY_MAX_ZOOM;
    for (let zoom = minimum; zoom < FIX_DENSITY_MAX_ZOOM; zoom++) {
      // MapLibre's world is 512 * 2^zoom CSS pixels; use 128-pixel cells.
      const cells = 4 * 2 ** zoom;
      const key = Math.floor(y * cells) * cells + Math.floor(x * cells);
      if (occupied[zoom]!.has(key)) continue;
      occupied[zoom]!.add(key);
      firstZoom = Math.min(firstZoom, zoom);
    }
    return firstZoom;
  };
}

export function priorityFixData(features: readonly GeoPointFeature[]): FeatureCollectionResponse {
  const unique = [...new Map(features.filter(feature => feature.properties.kind === 'fix')
    .map(feature => [featureKey(feature), feature])).values()];
  return {
    type: 'FeatureCollection', features: unique,
    meta: { revision: '', layer: 'fixes', returned: unique.length, truncated: false },
  };
}
