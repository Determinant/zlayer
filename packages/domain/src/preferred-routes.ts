import type { GeoPointFeature, NavigationData, PreferredRouteRecord, PreferredRouteSegment } from '@zlayer/contracts';
import { routeTokensFromText } from './route-text.js';
import { airportIdentifiers } from './features.js';
import type { RouteFeaturePins } from './route-model.js';

export type RouteAirportPair = { origin: GeoPointFeature; destination: GeoPointFeature };

type AirportMatches = Map<string, GeoPointFeature | undefined>;
type AirportIndex = { identifiers: AirportMatches; ids: AirportMatches };
const airportIndexes = new WeakMap<readonly GeoPointFeature[], AirportIndex>();

/** Navigation snapshots are immutable; replacing the feature array rebuilds the index.
 * Undefined marks an ambiguous key, including duplicate stable IDs. */
function airportIndex(airports: readonly GeoPointFeature[]): AirportIndex {
  const cached = airportIndexes.get(airports);
  if (cached) return cached;
  const identifiers: AirportMatches = new Map(), ids: AirportMatches = new Map();
  const add = (index: AirportMatches, key: string, airport: GeoPointFeature) =>
    index.set(key, index.has(key) ? undefined : airport);
  for (const airport of airports) {
    if (!airport.properties.faaId) continue;
    for (const ident of airportIdentifiers(airport)) add(identifiers, ident, airport);
    if (airport.id) add(ids, airport.id, airport);
  }
  const index = { identifiers, ids };
  airportIndexes.set(airports, index);
  return index;
}

/** Only the literal first/last route entries count; intermediate entries may be unresolved. */
export function preferredRouteAirports(
  tokens: readonly string[],
  airports: readonly GeoPointFeature[],
  pins: RouteFeaturePins = {},
): RouteAirportPair | undefined {
  if (tokens.length < 2) return undefined;
  const { identifiers, ids } = airportIndex(airports);
  const resolve = (index: number) => pins[index]
    ? ids.get(pins[index]) : identifiers.get(tokens[index]!.trim().toUpperCase());
  const origin = resolve(0);
  const destination = resolve(tokens.length - 1);
  return origin && destination ? { origin, destination } : undefined;
}

export function preferredRoutesForAirports(
  routes: readonly PreferredRouteRecord[],
  pair: RouteAirportPair,
): PreferredRouteRecord[] {
  return routes.filter(route => route.originId === pair.origin.properties.faaId &&
    route.destinationId === pair.destination.properties.faaId);
}

/** Preserve the published text, while avoiding duplicate endpoints in imported routes. */
export function preferredRouteText(route: PreferredRouteRecord, pair: RouteAirportPair): string | undefined {
  return preferredRouteEntries(route, pair)?.map(entry => entry.value).join(' ');
}

/** Import only when every typed waypoint has one stable identity; never drop a published constraint. */
export function preferredRouteFeaturePins(
  route: PreferredRouteRecord, pair: RouteAirportPair, navigation: NavigationData,
): RouteFeaturePins | undefined {
  const entries = resolvePreferredRouteEntries(route, pair, navigation);
  return entries ? Object.fromEntries(entries.flatMap((entry, index) => entry.pinnedFeatureId ? [[index, entry.pinnedFeatureId]] : [])) : undefined;
}

export type PublishedRouteEntry = { text: string; pinnedFeatureId?: string };

/** Resolve typed published entries once, before attaching them to a draft or expansion. */
export function resolvePreferredRouteEntries(route: PreferredRouteRecord, pair: RouteAirportPair,
  navigation: NavigationData): PublishedRouteEntry[] | undefined {
  const entries = preferredRouteEntries(route, pair);
  if (!entries) return undefined;
  const result: PublishedRouteEntry[] = [];
  for (const { value, segment } of entries) {
    const entry: PublishedRouteEntry = { text: value };
    const layer = segment?.type === 'NAVAID' ? 'navaids' : segment?.type === 'FIX' ? 'fixes'
      : segment?.type === 'AIRPORT' ? 'airports' : undefined;
    if (layer && segment) {
      const candidates = navigation[layer]?.features.filter(feature => {
        const { properties } = feature;
        return (layer === 'airports' ? airportIdentifiers(feature).includes(value) : properties.ident === value) &&
          (!segment.state || properties.state === segment.state) &&
          (!segment.country || properties.country === segment.country) &&
          (!segment.icaoRegion || properties.icaoRegion === segment.icaoRegion) &&
          (!segment.navaidType || properties.type === segment.navaidType);
      }) ?? [];
      if (candidates.length !== 1 || !candidates[0]!.id) return undefined;
      entry.pinnedFeatureId = candidates[0]!.id!;
    }
    result.push(entry);
  }
  if (pair.origin.id) result[0]!.pinnedFeatureId = pair.origin.id;
  if (pair.destination.id) result.at(-1)!.pinnedFeatureId = pair.destination.id;
  return result;
}

function preferredRouteEntries(route: PreferredRouteRecord, pair: RouteAirportPair) {
  if (!route.route?.trim()) return undefined;
  const values = routeTokensFromText(route.route);
  const segments = route.segments.flatMap(segment => routeTokensFromText(segment.value)
    .map(value => ({ value, segment })));
  // Text-only feeds are supported, but inconsistent metadata must never lose its constraints.
  const aligned = values.length === segments.length && values.every((value, i) => value === segments[i]!.value);
  if (route.segments.length && !aligned) return undefined;
  const entries: Array<{ value: string; segment?: PreferredRouteSegment }> = values.map((value, i) =>
    aligned ? segments[i]! : { value });
  const isEndpoint = (entry: typeof entries[number] | undefined, airport: GeoPointFeature) =>
    !!entry && airportIdentifiers(airport).includes(entry.value) &&
    (!entry.segment || entry.segment.type === 'AIRPORT');
  if (isEndpoint(entries[0], pair.origin)) entries.shift();
  if (isEndpoint(entries.at(-1), pair.destination)) entries.pop();
  return [{ value: airportRouteIdent(pair.origin) },
    ...entries,
    { value: airportRouteIdent(pair.destination) }];
}

export function airportRouteIdent(airport: GeoPointFeature): string {
  return airportIdentifiers(airport)[0] ?? '';
}
