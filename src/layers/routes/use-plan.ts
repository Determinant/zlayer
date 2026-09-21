import { useEffect, useMemo, useState } from 'react';
import type { AirwayDataResponse, CatalogResponse, NavigationData, TerminalProceduresData, PreferredRoutesData } from '@zlayer/contracts';
import { attachRouteDepartures, type RouteDraft, type RoutePlan } from '@zlayer/domain';
import { loadRouteResources, routeResourceKey } from './resources';
import { routeResolver } from './resolver';
import { useOnline } from '../../core/use-online';
import { useInventoryVersion } from '../../offline/use-inventory-version';

export type RouteLoadStatus = 'idle' | 'loading' | 'ready' | 'partial' | 'error';
type LoadedRouteData = {
  key: string;
  data: NavigationData;
  airways?: AirwayDataResponse;
  terminal?: TerminalProceduresData;
  preferred?: PreferredRoutesData;
  status: RouteLoadStatus;
};
const EMPTY_DATA: NavigationData = {};
const RETRY_DELAY_MS = 3_000;

export function useRoutePlan(
  catalog: CatalogResponse | undefined,
  draft: RouteDraft,
  onNormalize?: (edit: (current: RouteDraft) => RouteDraft) => void,
): { plan: RoutePlan; data: NavigationData; status: RouteLoadStatus } {
  const active = draft.entries.length > 0;
  const online = useOnline();
  const inventoryVersion = useInventoryVersion();
  const [loaded, setLoaded] = useState<LoadedRouteData>();
  const key = catalog ? routeResourceKey(catalog, 'plan') : '';

  useEffect(() => {
    if (!catalog || !active) return;
    let cancelled = false;
    let retryTimer: number | undefined;
    setLoaded(current => current?.key === key ? current : { key, data: EMPTY_DATA, status: 'loading' });
    const load = async () => {
      const { data, failed, airways, terminal, preferred } = await loadRouteResources(catalog, 'plan');
      if (cancelled) return;
      const collections = Object.values(data);
      const status = collections.length === 0 ? 'error' : failed ? 'partial' : 'ready';
      // Failed-product retries must not rebuild the national waypoint index when
      // every successful collection is still the same cached object.
      setLoaded(current => current?.key === key && current.status === status && current.airways === airways &&
        current.terminal === terminal && current.preferred === preferred &&
        Object.keys(current.data).length === collections.length &&
        collections.every(collection => current.data[collection.meta.layer] === collection)
        ? current : {
          key,
          data,
          ...(airways ? { airways } : {}),
          ...(terminal ? { terminal } : {}),
          ...(preferred ? { preferred } : {}),
          status,
        });
      // Offline cached data still loads, but retries wait until connectivity returns.
      if (failed && online) retryTimer = window.setTimeout(() => void load(), RETRY_DELAY_MS);
    };
    void load();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [active, catalog, key, online, inventoryVersion]);

  const current = loaded?.key === key ? loaded : undefined;
  const data = current?.data ?? EMPTY_DATA;
  const airways = current?.airways;
  const terminal = current?.terminal;
  const preferred = current?.preferred;
  // GPS coordinates resolve independently of navigation-resource availability.
  const resolver = useMemo(() => routeResolver(data, airways, terminal, preferred), [data, airways, terminal, preferred]);
  const resolved = useMemo(() => resolver(draft), [draft, resolver]);
  const normalized = useMemo(() => attachRouteDepartures(draft, resolved, terminal), [draft, resolved, terminal]);
  useEffect(() => { if (normalized !== draft) onNormalize?.(current => current === draft ? normalized : current); }, [draft, normalized, onNormalize]);
  const plan = useMemo(() => normalized === draft ? resolved : resolver(normalized), [draft, normalized, resolved, resolver]);
  return { plan, data, status: !active ? 'idle' : current?.status ?? 'loading' };
}
