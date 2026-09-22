import { useEffect, useState } from 'react';
import { readRouteStash, ROUTE_STASH_KEY, ROUTE_STASH_CHANGED, type SavedRoute } from './stash';

function loadStash() {
  try { return { routes: readRouteStash(), error: '' }; }
  catch (error) { return { routes: [] as SavedRoute[], error: (error as Error).message }; }
}

/** Keep open recommendations and management dialogs current across saves and windows. */
export function useRouteStash() {
  const [state, setState] = useState(loadStash);
  const refresh = () => setState(loadStash());
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const changed = (event: StorageEvent) => {
      if (event.key === ROUTE_STASH_KEY || event.key === 'zlayer-route-stash-v1' || event.key === null) refresh();
    };
    window.addEventListener('storage', changed);
    window.addEventListener('focus', refresh);
    window.addEventListener(ROUTE_STASH_CHANGED, refresh);
    return () => {
      window.removeEventListener('storage', changed);
      window.removeEventListener('focus', refresh);
      window.removeEventListener(ROUTE_STASH_CHANGED, refresh);
    };
  }, []);
  return [state, setState, refresh] as const;
}
