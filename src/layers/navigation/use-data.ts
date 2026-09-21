import { routingCatalog, type CatalogReadSource } from '../../workspace/read-context';
import { useEffect, useMemo, useState } from 'react';

import type {
  AirwayDataResponse,
  FeatureCollectionResponse,
  NavigationData,
  NavigationLayerId,
} from '@zlayer/contracts';

import { fetchAirways, fetchNavigationResult, navigationRequestKey, regionalNavigationLayers, type NavigationIssue } from './api';
import type { LayerVisibility } from './definitions';
import { useOnline } from '../../core/use-online';
import { useInventoryVersion } from '../../offline/use-inventory-version';

export type NavigationLoadStatus = 'loading' | 'ready' | 'partial' | 'error';
export type NavigationLoadState = Partial<Record<NavigationLayerId, NavigationLoadStatus>>;

export function useNavigationData(
  catalog: CatalogReadSource | undefined,
  visibility: LayerVisibility,
): { data: NavigationData; loadState: NavigationLoadState; loading: boolean; issues: NavigationIssue[]; airways: AirwayDataResponse | undefined } {
  const [loaded, setLoaded] = useState<Partial<Record<NavigationLayerId, {
    key: string; status: NavigationLoadStatus; collection?: FeatureCollectionResponse | undefined; issues?: NavigationIssue[];
  }>>>({});
  const online = useOnline();
  const inventoryVersion = useInventoryVersion();
  const [airwayState, setAirwayState] = useState<{ key: string; data: AirwayDataResponse | undefined }>();
  const routing = catalog ? routingCatalog(catalog) : undefined;
  const airwayKey = routing?.airways ? JSON.stringify([routing.revision, routing.airways]) : undefined;

  useEffect(() => {
    if (!routing || !visibility.fixes || !airwayKey) return;
    const resource = routing.airways;
    if (!resource) return;
    let cancelled = false;
    const load = () => {
      void fetchAirways(resource, routing.revision).then(data => {
        if (!cancelled) setAirwayState({ key: airwayKey, data });
      }).catch(() => {
        // Chart-use tags still provide enroute filtering offline. A failed
        // optional airway request must also settle the initial loading state.
        if (!cancelled) setAirwayState(current => current?.key === airwayKey
          ? current : { key: airwayKey, data: undefined });
      });
    };
    load();
    return () => { cancelled = true; };
  }, [routing, airwayKey, visibility.fixes, online, inventoryVersion]);

  useEffect(() => {
    if (!catalog) return;
    let cancelled = false;
    for (const layer of regionalNavigationLayers(catalog)) {
      if (!visibility[layer.id]) continue;
      const key = navigationRequestKey(layer, routingCatalog(catalog).revision, catalog.charts, catalog);
      setLoaded(current => ({ ...current, [layer.id]: { key, status: 'loading',
        collection: current[layer.id]?.key === key ? current[layer.id]?.collection : undefined } }));
      fetchNavigationResult(layer, routingCatalog(catalog).revision, catalog.charts, catalog)
        .then(({ collection, issues }) => {
          if (!cancelled) setLoaded(current => ({ ...current, [layer.id]: { key,
            status: !collection ? 'error' : issues.length ? 'partial' : 'ready', collection, issues } }));
        })
        .catch(() => {
          if (!cancelled) setLoaded(current => ({ ...current, [layer.id]: { key, status: 'error' } }));
        });
    }
    return () => { cancelled = true; };
  }, [catalog, visibility, online, inventoryVersion]);

  const { data, loadState, issues, loading } = useMemo(() => {
    const data: NavigationData = {};
    const loadState: NavigationLoadState = {};
    const issues: NavigationIssue[] = [];
    let loading = false;
    for (const layer of catalog ? regionalNavigationLayers(catalog) : []) {
      const entry = loaded[layer.id];
      if (!catalog || entry?.key !== navigationRequestKey(layer, routingCatalog(catalog).revision, catalog.charts, catalog)) {
        if (visibility[layer.id]) loading = true;
        continue;
      }
      if (visibility[layer.id] && entry.status === 'loading') loading = true;
      loadState[layer.id] = entry.status;
      if (entry.collection) data[layer.id] = entry.collection;
      if (visibility[layer.id]) issues.push(...entry.issues ?? []);
    }
    return { data, loadState, issues, loading };
  }, [catalog, loaded, visibility]);
  const airwaysCurrent = airwayKey !== undefined && airwayState?.key === airwayKey;
  return { data, loadState, issues, loading: loading || !!(visibility.fixes && routing?.airways && !airwaysCurrent),
    airways: airwaysCurrent ? airwayState?.data : undefined };
}
