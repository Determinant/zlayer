import { useEffect, useMemo, useState } from 'react';
import type { CatalogResponse } from '@zlayer/contracts';
import type { RouteAirportPair } from '@zlayer/domain';
import { queryRouteHistory, retainRouteHistory } from './history/client';
import { fetchPreferredRoutes } from './api';
import { routeHistoryQuery } from './history/draft';

/** Keep the sources independent: one failed feed must not hide the other sections. */
export function useSuggestions(catalog: CatalogResponse, pair: RouteAirportPair, engine: string) {
  useEffect(() => catalog.routeHistory ? retainRouteHistory() : undefined, [catalog.routeHistory]);
  const query = useMemo(() => routeHistoryQuery(pair, engine), [pair, engine]);
  const history = useSource(useMemo(() => catalog.routeHistory
    ? (signal: AbortSignal) => queryRouteHistory(catalog.routeHistory!, catalog.revision, query, signal) : undefined,
  [catalog.routeHistory, catalog.revision, query]));
  const preferred = useSource(useMemo(() => catalog.preferredRoutes
    ? () => fetchPreferredRoutes(catalog.preferredRoutes!, catalog.revision) : undefined,
  [catalog.preferredRoutes, catalog.revision]));
  return { history, preferred };
}

function useSource<T>(request: ((signal: AbortSignal) => Promise<T>) | undefined) {
  const [result, setResult] = useState<{ request: (signal: AbortSignal) => Promise<T>; data?: T; error?: string }>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setResult(undefined);
    if (!request) return;
    const controller = new AbortController();
    void request(controller.signal).then(data => {
      if (!controller.signal.aborted) setResult({ request, data });
    }).catch(reason => {
      if (!controller.signal.aborted) setResult({ request, error: reason instanceof Error ? reason.message : 'Route data unavailable' });
    });
    return () => controller.abort();
  }, [request, attempt]);
  const current = result?.request === request ? result : undefined;
  return { data: current?.data, error: current?.error, retry: () => setAttempt(value => value + 1) };
}
