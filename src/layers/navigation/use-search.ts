import { routingCatalog, type CatalogReadSource } from '../../workspace/read-context';
import { useEffect, useMemo, useState } from 'react';

import type { MetarFeatureCollection, NavigationLayerId, SearchResult } from '@zlayer/contracts';
import { mergeMetarsIntoAirports, searchNavigation } from '@zlayer/domain';

import { fetchNavigationResult, regionalNavigationLayers, type NavigationIssue, type NavigationResult } from './api';
import { useOnline } from '../../core/use-online';
import { useInventoryVersion } from '../../offline/use-inventory-version';

const SEARCH_DEBOUNCE_MS = 120;

type SearchState = {
  catalog: CatalogReadSource;
  query: string;
  layers: Array<{ id: NavigationLayerId; pending: boolean; result?: NavigationResult }>;
};

export function useNavigationSearch(
  catalog: CatalogReadSource | undefined,
  query: string,
  metars: MetarFeatureCollection | undefined,
): { results: SearchResult[]; loading: boolean; unavailable: NavigationLayerId[]; issues: NavigationIssue[] } {
  const normalizedQuery = query.trim().toUpperCase();
  const [state, setState] = useState<SearchState>();
  const online = useOnline();
  const inventoryVersion = useInventoryVersion();

  useEffect(() => {
    if (!catalog || normalizedQuery.length < 2) {
      setState(undefined);
      return;
    }

    let cancelled = false;
    const layers = regionalNavigationLayers(catalog);
    setState(previous => ({ catalog, query: normalizedQuery, layers: layers.map(({ id }) => ({
      ...(previous?.catalog === catalog && previous.query === normalizedQuery
        ? previous.layers.find(layer => layer.id === id) : undefined),
      id, pending: true,
    })) }));
    const timer = window.setTimeout(() => {
      for (const layer of layers) void fetchNavigationResult(layer, routingCatalog(catalog).revision, catalog.charts, catalog)
        .then(result => {
          if (cancelled) return;
          setState(previous => previous?.catalog === catalog && previous.query === normalizedQuery ? {
            ...previous, layers: previous.layers.map(entry => entry.id === layer.id
              ? { id: layer.id, pending: false, result } : entry),
          } : previous);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [catalog, normalizedQuery, online, inventoryVersion]);

  const current = state?.catalog === catalog && state?.query === normalizedQuery ? state : undefined;
  // Score after React batches ready feeds; retain their catalog order for tied matches.
  const matches = useMemo(() => searchNavigation(current?.layers.flatMap(({ result }) =>
    result?.collection ? [result.collection] : []) ?? [], normalizedQuery), [current, normalizedQuery]);
  // Weather does not affect ranking. Enrich only the bounded airport results.
  const results = useMemo(() => {
    if (!metars) return matches;
    const airports = matches.filter(result => result.layer === 'airports');
    if (!airports.length) return matches;
    const enriched = mergeMetarsIntoAirports({ type: 'FeatureCollection',
      features: airports.map(result => result.feature),
      meta: { revision: '', layer: 'airports', returned: airports.length, truncated: false },
    }, metars).features;
    let index = 0;
    return matches.map(result => result.layer === 'airports' ? { ...result, feature: enriched[index++]! } : result);
  }, [matches, metars]);
  return {
    results,
    loading: Boolean(catalog && normalizedQuery.length >= 2 && (!current || current.layers.some(layer => layer.pending))),
    unavailable: current?.layers.filter(layer => !layer.pending && !layer.result?.collection).map(layer => layer.id) ?? [],
    issues: current?.layers.flatMap(layer => layer.result?.issues ?? []) ?? [],
  };
}
