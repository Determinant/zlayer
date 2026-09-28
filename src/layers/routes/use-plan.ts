import { useEffect, useMemo, useState } from 'react';
import type { AirwayDataResponse, CatalogResponse, NavigationData, TerminalProceduresData, PreferredRoutesData } from '@zlayer/contracts';
import { attachRouteDepartures, captureRadialPositions, featureIdentifiers, isVorReference, parseRadialDefinition, type RouteDraft, type RoutePlan } from '@zlayer/domain';
import { useReferenceBearing } from './use-reference-bearing';
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
const MAX_RETRY_DELAY_MS = 60_000;

export function useRoutePlan(
  catalog: CatalogResponse | undefined,
  draft: RouteDraft,
  onNormalize?: (edit: (current: RouteDraft) => RouteDraft) => void,
): { plan: RoutePlan; data: NavigationData; status: RouteLoadStatus } {
  const active = draft.entries.length > 0;
  const { resolver, data, terminal, status } = useRouteResolver(catalog, active, draft);
  const resolved = useMemo(() => resolver(draft), [draft, resolver]);
  const normalized = useMemo(() => captureRadialPositions(attachRouteDepartures(draft, resolved, terminal), resolved), [draft, resolved, terminal]);
  useEffect(() => { if (normalized !== draft) onNormalize?.(current => current === draft ? normalized : current); }, [draft, normalized, onNormalize]);
  const plan = useMemo(() => normalized === draft ? resolved : resolver(normalized), [draft, normalized, resolved, resolver]);
  return { plan, data, status };
}

/** One resource subscription and shared national index for an active view. */
export function useRouteResolver(catalog: CatalogResponse | undefined, active: boolean, draft?: RouteDraft) {
  const online = useOnline();
  const inventoryVersion = useInventoryVersion();
  const [loaded, setLoaded] = useState<LoadedRouteData>();
  const key = catalog ? routeResourceKey(catalog, 'plan') : '';

  useEffect(() => {
    if (!catalog || !active) { setLoaded(undefined); return; }
    let cancelled = false;
    let retryTimer: number | undefined;
    let retryDelay = RETRY_DELAY_MS, running = false, needsRetry = false;
    setLoaded(current => current?.key === key ? current : { key, data: EMPTY_DATA, status: 'loading' });
    const load = async () => {
      if (cancelled || running) return;
      running = true;
      const { data, failed, airways, terminal, preferred } = await loadRouteResources(catalog, 'plan');
      running = false;
      if (cancelled) return;
      needsRetry = failed;
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
      // Cached data still loads offline/hidden; repeated acquisition needs visible online demand.
      if (failed && online && document.visibilityState !== 'hidden') {
        retryTimer = window.setTimeout(() => void load(), retryDelay);
        retryDelay = Math.min(MAX_RETRY_DELAY_MS, retryDelay * 2);
      }
    };
    const visibilityChanged = () => {
      window.clearTimeout(retryTimer);
      retryTimer = undefined;
      if (document.visibilityState !== 'hidden' && online && needsRetry) {
        retryDelay = RETRY_DELAY_MS;
        void load();
      }
    };
    document.addEventListener('visibilitychange', visibilityChanged);
    void load();
    return () => {
      document.removeEventListener('visibilitychange', visibilityChanged);
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [active, catalog, key, online, inventoryVersion]);

  const current = loaded?.key === key ? loaded : undefined;
  const data = current?.data ?? EMPTY_DATA;
  const airways = current?.airways;
  const terminal = current?.terminal;
  const preferred = current?.preferred;
  const vorIdentifiers = useMemo(() => new Set(data.navaids?.features.filter(isVorReference).flatMap(featureIdentifiers)), [data.navaids]);
  const needsMagnetic = useMemo(() => draft?.entries.some(entry => {
    const definition = parseRadialDefinition(entry.text);
    if (!definition || definition.bearing === 'true' || definition.bearing === 'radial') return false;
    if (definition.bearing === 'magnetic' || entry.radialPosition?.reference.bearing === 'magnetic') return true;
    return Object.keys(data).length > 0 && !vorIdentifiers.has(definition.station);
  }) ?? false, [draft, data, vorIdentifiers]);
  const magnetic = useReferenceBearing(catalog?.revision, active && needsMagnetic);
  // GPS coordinates resolve independently of navigation-resource availability.
  const resolver = useMemo(() => routeResolver(data, airways, terminal, preferred, magnetic), [data, airways, terminal, preferred, magnetic]);
  const status: RouteLoadStatus = !active ? 'idle' : current?.status ?? 'loading';
  return { resolver, data, terminal, status };
}
