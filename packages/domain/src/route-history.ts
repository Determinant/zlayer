import type { RouteHistoryPair } from '@zlayer/contracts';
import { routeTokensFromText } from './route-text.js';

export type RouteHistoryQuery = { origins: string[]; destinations: string[]; engine?: string };
export type RouteHistoryMatch = { route: string; count: number };
export type RouteHistoryResults = { routes: RouteHistoryMatch[]; totalCount: number; engines: string[] };

/** The caller supplies ICAO first, then any FAA alias, for each selected airport. */
export function filedRouteText(text: string, query: RouteHistoryQuery): string {
  return filedRouteTokens(text, query).join(' ');
}

export function filedRouteTokens(text: string, { origins, destinations }: RouteHistoryQuery): string[] {
  const entries = routeTokensFromText(text);
  if (origins.includes(entries[0] ?? '')) entries.shift();
  if (destinations.includes(entries.at(-1) ?? '')) entries.pop();
  return [origins[0], ...entries, destinations[0]].filter((entry): entry is string => !!entry);
}

export function createRouteHistoryLookup(pairs: readonly RouteHistoryPair[]) {
  // Per-record dates are validated at load time; retain only the fields needed for queries.
  const index = new Map(pairs.map(pair => [JSON.stringify([pair.origin, pair.destination]),
    pair.routes.map(({ route, count, engineCounts }) => ({ route, count, engineCounts }))]));
  return (query: RouteHistoryQuery): RouteHistoryResults => {
    const counts = new Map<string, number>();
    const engines = new Set<string>();
    for (const origin of new Set(query.origins)) for (const destination of new Set(query.destinations)) {
      for (const entry of index.get(JSON.stringify([origin, destination])) ?? []) {
        for (const engine of Object.keys(entry.engineCounts)) engines.add(engine);
        const count = query.engine ? entry.engineCounts[query.engine] ?? 0 : entry.count;
        if (count <= 0) continue;
        const route = filedRouteText(entry.route, query);
        counts.set(route, (counts.get(route) ?? 0) + count);
      }
    }
    const routes = [...counts].map(([route, count]) => ({ route, count }))
      .sort((a, b) => b.count - a.count || a.route.localeCompare(b.route));
    return { routes, totalCount: routes.reduce((sum, route) => sum + route.count, 0), engines: [...engines].sort() };
  };
}
