import { useEffect, useMemo, useState } from 'react';
import type { CatalogResponse } from '@zlayer/contracts';
import type { RouteAirportPair } from '@zlayer/domain';
import { queryRouteHistory } from './history/client';
import { fetchPreferredRoutes } from './api';
import { routeHistoryQuery } from './history/draft';

/** Keep the sources independent: one failed feed must not hide the other sections. */
export function useSuggestions(catalog: CatalogResponse, pair: RouteAirportPair, engine: string) {
  const query = useMemo(() => routeHistoryQuery(pair, engine), [pair, engine]);
  const history = useSource(useMemo(() => catalog.routeHistory
    ? () => queryRouteHistory(catalog.routeHistory!, catalog.revision, query) : undefined,
  [catalog.routeHistory, catalog.revision, query]));
  const preferred = useSource(useMemo(() => catalog.preferredRoutes
    ? () => fetchPreferredRoutes(catalog.preferredRoutes!, catalog.revision) : undefined,
  [catalog.preferredRoutes, catalog.revision]));
  return { history, preferred };
}

function useSource<T>(request: (() => Promise<T>) | undefined) {
  const [result, setResult] = useState<{ request: () => Promise<T>; data?: T; error?: string }>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!request) return;
    let cancelled = false;
    setResult(undefined);
    void request().then(data => {
      if (!cancelled) setResult({ request, data });
    }).catch(reason => {
      if (!cancelled) setResult({ request, error: reason instanceof Error ? reason.message : 'Route data unavailable' });
    });
    return () => { cancelled = true; };
  }, [request, attempt]);
  const current = result?.request === request ? result : undefined;
  return { data: current?.data, error: current?.error, retry: () => setAttempt(value => value + 1) };
}
