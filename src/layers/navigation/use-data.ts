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
): { data: NavigationData; loadState: NavigationLoadState; issues: NavigationIssue[]; airways: AirwayDataResponse | undefined } {
  const [loaded, setLoaded] = useState<Partial<Record<NavigationLayerId, {
    key: string; status: NavigationLoadStatus; collection?: FeatureCollectionResponse | undefined; issues?: NavigationIssue[];
  }>>>({});
  const online = useOnline();
  const inventoryVersion = useInventoryVersion();
  const [airwayState, setAirwayState] = useState<{ revision: string; url: string; data: AirwayDataResponse }>();
  const routing = catalog ? routingCatalog(catalog) : undefined;

  useEffect(() => {
    if (!routing || !visibility.fixes) return;
    const resource = routing.airways;
    if (!resource) return;
    let cancelled = false;
    const load = () => {
      void fetchAirways(resource, routing.revision).then(data => {
        if (!cancelled) setAirwayState({ revision: routing.revision, url: resource.url, data });
      }).catch(() => { /* Chart-use tags still provide enroute filtering offline. */ });
    };
    load();
    window.addEventListener('online', load);
    return () => { cancelled = true; window.removeEventListener('online', load); };
  }, [routing, visibility.fixes]);

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

  const { data, loadState, issues } = useMemo(() => {
    const data: NavigationData = {};
    const loadState: NavigationLoadState = {};
    const issues: NavigationIssue[] = [];
    for (const layer of catalog ? regionalNavigationLayers(catalog) : []) {
      const entry = loaded[layer.id];
      if (!catalog || entry?.key !== navigationRequestKey(layer, routingCatalog(catalog).revision, catalog.charts, catalog)) continue;
      loadState[layer.id] = entry.status;
      if (entry.collection) data[layer.id] = entry.collection;
      if (visibility[layer.id]) issues.push(...entry.issues ?? []);
    }
    return { data, loadState, issues };
  }, [catalog, loaded, visibility]);
  return { data, loadState, issues, airways: airwayState?.revision === routing?.revision &&
    airwayState?.url === routing?.airways?.url ? airwayState?.data : undefined };
}
