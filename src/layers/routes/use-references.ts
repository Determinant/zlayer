import { useEffect, useState } from 'react';
import type { CatalogResponse } from '@zlayer/contracts';
import { loadRouteResources, mergeRouteReferences, routeResourceKey, type RouteReferenceData } from './resources';
import { useOnline } from '../../core/use-online';
import { useInventoryVersion } from '../../offline/use-inventory-version';

export type RouteLoadStatus = 'idle' | 'loading' | 'ready' | 'partial' | 'error';
type LoadedReferences = {
  key: string;
  references: RouteReferenceData;
  status: RouteLoadStatus;
  pending: boolean;
};
const EMPTY_REFERENCES: RouteReferenceData = { data: {} };
const RETRY_DELAY_MS = 3_000;
const MAX_RETRY_DELAY_MS = 60_000;

/** Own reference demand and recovery separately from route resolution. Pending
 * describes the current round; status retains the last result during a retry. */
export function useRouteReferences(catalog: CatalogResponse | undefined, active: boolean) {
  const online = useOnline();
  const inventoryVersion = useInventoryVersion();
  const [loaded, setLoaded] = useState<LoadedReferences>();
  const key = catalog ? routeResourceKey(catalog, 'plan') : '';

  useEffect(() => {
    if (!catalog || !active) { setLoaded(undefined); return; }
    let cancelled = false;
    let retryTimer: number | undefined;
    let retryDelay = RETRY_DELAY_MS, running = false, needsRetry = false;
    const publish = (update: Partial<RouteReferenceData>, pending: boolean, failed = false) => {
      if (cancelled) return;
      setLoaded(current => {
        if (cancelled) return current;
        const previous = current?.key === key ? current : undefined;
        const references = mergeRouteReferences(catalog, previous?.references, update);
        const status: RouteLoadStatus = pending ? previous?.status ?? 'loading'
          : Object.keys(references.data).length === 0 ? 'error' : failed ? 'partial' : 'ready';
        return previous?.references === references && previous.status === status && previous.pending === pending
          ? previous : { key, references, status, pending };
      });
    };
    const load = async () => {
      if (cancelled || running) return;
      running = true;
      publish({}, true);
      const result = await loadRouteResources(catalog, 'plan', resources => publish(resources, true));
      running = false;
      if (cancelled) return;
      needsRetry = result.failed;
      publish(result, false, result.failed);
      // Cached data still loads offline/hidden; repeated acquisition needs visible online demand.
      if (result.failed && online && document.visibilityState !== 'hidden') {
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

  const current = active && loaded?.key === key ? loaded : undefined;
  const status: RouteLoadStatus = !active ? 'idle' : current?.status ?? 'loading';
  return { ...(current?.references ?? EMPTY_REFERENCES), status, pending: active && (current?.pending ?? true) };
}
