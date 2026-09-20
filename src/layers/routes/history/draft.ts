import type { NavigationData } from '@zlayer/contracts';
import { airportIdentifiers, createRouteEntry, filedRouteTokens, type RouteAirportPair, type RouteHistoryQuery } from '@zlayer/domain';
import type { RouteDraft } from '../draft';

export function routeHistoryQuery(pair: RouteAirportPair, engine?: string): RouteHistoryQuery {
  return { origins: airportIdentifiers(pair.origin), destinations: airportIdentifiers(pair.destination), ...(engine ? { engine } : {}) };
}

export function filedRouteDraft(route: string, pair: RouteAirportPair, navigation: NavigationData): RouteDraft {
  return createFiledRouteDraft(pair, navigation)(route);
}

/** Build the waypoint index once when preparing many recommendations for a pair. */
export function createFiledRouteDraft(pair: RouteAirportPair, navigation: NavigationData) {
  const waypoints = new Map<string, string | undefined>();
  for (const feature of [...navigation.navaids?.features ?? [], ...navigation.fixes?.features ?? []]) {
    const ident = feature.properties.ident;
    if (ident) waypoints.set(ident, waypoints.has(ident) ? undefined : feature.id);
  }
  return (route: string): RouteDraft => {
    const tokens = filedRouteTokens(route, routeHistoryQuery(pair));
    return { entries: tokens.map((text, index) => {
      // Explicit endpoints and unique interior fixes/NAVAIDs retain their identities.
      const pin = index === 0 ? pair.origin.id : index === tokens.length - 1 ? pair.destination.id : waypoints.get(text);
      return createRouteEntry(text, pin);
    }) };
  };
}
