import { useEffect } from 'react';
import type { CatalogResponse } from '@zlayer/contracts';
import type { RouteAirportPair } from '@zlayer/domain';
import { queryRouteHistory, retainRouteHistory } from './history/client';
import { fetchPreferredRoutes } from './api';
import { routeHistoryQuery } from './history/draft';
import { useRouteResource } from './use-resource';

/** Keep the sources independent: one failed feed must not hide the other sections. */
export function useSuggestions(catalog: CatalogResponse, pair: RouteAirportPair, engine: string) {
  useEffect(() => catalog.routeHistory ? retainRouteHistory() : undefined, [catalog.routeHistory]);
  const query = routeHistoryQuery(pair, engine);
  const history = useRouteResource(catalog.routeHistory
    ? JSON.stringify([catalog.revision, catalog.routeHistory, query]) : undefined,
  signal => queryRouteHistory(catalog.routeHistory!, catalog.revision, query, signal));
  const preferred = useRouteResource(catalog.preferredRoutes
    ? JSON.stringify([catalog.revision, catalog.preferredRoutes]) : undefined,
  () => fetchPreferredRoutes(catalog.preferredRoutes!, catalog.revision));
  return { history, preferred };
}
