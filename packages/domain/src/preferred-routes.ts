import type { GeoPointFeature, NavigationData, PreferredRouteRecord, PreferredRouteSegment } from '@zlayer/contracts';
import { routeTokensFromText } from './route-text.js';
import { airportIdentifiers } from './features.js';
import type { RouteFeaturePins } from './route-model.js';

export type RouteAirportPair = { origin: GeoPointFeature; destination: GeoPointFeature };

/** Only the literal first/last route entries count; intermediate entries may be unresolved. */
export function preferredRouteAirports(
  tokens: readonly string[],
  airports: readonly GeoPointFeature[],
  pins: RouteFeaturePins = {},
): RouteAirportPair | undefined {
  if (tokens.length < 2) return undefined;
  const resolve = (index: number) => {
    const token = tokens[index]!.trim().toUpperCase();
    const candidates = airports.filter(airport => airport.properties.faaId &&
      (pins[index] ? airport.id === pins[index] : airportIdentifiers(airport).includes(token)));
    return candidates.length === 1 ? candidates[0] : undefined;
  };
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
