import { useEffect, useMemo, useState, type ComponentProps } from 'react';
import type { CatalogResponse } from '@zlayer/contracts';
import type { GpsService } from '../../core/gps/service';
import type { RouteBar } from './bar';
import type { RouteMapPreview } from './map-preview';
import type { RouteEditingActions } from './public';
import { useRouteDraft } from './use-draft';
import { useRoutePlan } from './use-plan';
import { useDirectTo } from './use-direct-to';
import { appendRouteText, EMPTY_ROUTE_DRAFT, insertRouteFeature, insertRouteTextBefore, moveRouteEntry,
  removeRouteEntry, replaceRouteFeature, replaceRouteText, setRouteApproach, setRouteDeparture, setRouteArrival } from './draft';

/** Own route intent, transient previews and edits together. Unloading stops plan
 * demand and clears previews without replacing the saved draft. */
export function useRouteController({ catalog, enabled, gps, directToEnabled }: {
  catalog: CatalogResponse | undefined; enabled: boolean;
  gps: Pick<GpsService, 'subscribe' | 'getSnapshot'>; directToEnabled: boolean;
}) {
  const [draft, update] = useRouteDraft();
  const [focusNonce, setFocusNonce] = useState(0);
  const [recommendations, setRecommendations] = useState<RouteMapPreview>();
  const [approach, setApproach] = useState<RouteMapPreview>();
  const preview = enabled ? approach ?? recommendations : undefined;
  useEffect(() => {
    if (!enabled) { setRecommendations(undefined); setApproach(undefined); }
  }, [enabled]);
  const route = useRoutePlan(enabled ? catalog : undefined, enabled ? draft : EMPTY_ROUTE_DRAFT, enabled ? update : undefined);
  const { action, confirmation } = useDirectTo(gps, route.plan, update);
  const directTo = directToEnabled ? action : undefined;
  const displayedRoutes = useMemo(() => preview?.routes.map(value => value.plan) ?? [route.plan], [route.plan, preview]);
  const actions = useMemo<RouteEditingActions>(() => ({
    insert: (id, feature) => update(current => insertRouteFeature(current, id, feature)),
    replace: (id, feature) => update(current => replaceRouteFeature(current, id, feature)),
    remove: id => update(current => removeRouteEntry(current, id)),
  }), [update]);
  const barProps = {
    plan: route.plan, navigationData: route.data, status: route.status,
    onUseRoute: update, onDirectTo: directTo,
    onApproachChange: (entry, selection) => update(current => setRouteApproach(current, entry, selection)),
    onDepartureChange: (entry, selection) => update(current => setRouteDeparture(current, entry, selection)),
    onArrivalChange: (entry, selection) => update(current => setRouteArrival(current, entry, selection)),
    onRecommendationPreview: setRecommendations, onApproachPreview: setApproach,
    onAppendInput: input => update(current => appendRouteText(current, input)),
    onInsertInput: (id, input) => update(current => insertRouteTextBefore(current, id, input)),
    onReplaceInput: (id, input) => update(current => replaceRouteText(current, id, input)),
    onRemoveEntry: actions.remove,
    onMoveEntry: (from, to) => update(current => moveRouteEntry(current, from, to)),
    onClear: () => update(EMPTY_ROUTE_DRAFT), onFit: () => setFocusNonce(current => current + 1),
  } satisfies Omit<ComponentProps<typeof RouteBar>, 'catalog' | 'onOpenPlate'>;
  return { ...route, hasEntries: draft.entries.length > 0, preview, confirmation, barProps,
    featureRoute: { plan: route.plan, update, onDirectTo: directTo },
    mapInput: { route: route.plan, routePreview: preview, displayedRoutes, focusNonce, actions } };
}
