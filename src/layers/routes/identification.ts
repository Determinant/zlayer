import { radialReference, type NearbyVor, routeIdentificationKey, sameFeature, type RouteDraft, type RoutePlan, type RouteWaypoint,
  type RoutePointForm, type RadialPosition, type RouteEntry } from '@zlayer/domain';
import type { GeoPointFeature } from '@zlayer/contracts';
import { replaceRouteFeature, sameRouteDraft } from './draft';
import { routeItemsForPoint } from './removal';

/** Changing presentation keeps the original entity, constraints and geometry. */
export function identifyRoutePoint(draft: RouteDraft, plan: RoutePlan, point: RouteWaypoint, form: RoutePointForm | undefined): RouteDraft {
  if (!plan.waypoints.includes(point) || !sameRouteDraft(draft, plan)) return draft;
  const key = routeIdentificationKey(point);
  return { entries: draft.entries.map(entry => {
    if (entry.id !== point.source.entryId) return entry;
    const values = (entry.identifications ?? []).filter(value => value.key !== key);
    if (form) values.push({ key, form });
    const { identifications: _old, ...rest } = entry;
    const pinned = form && point.edit?.entryId === entry.id && point.feature.properties.kind !== 'coordinate' && point.feature.id
      ? { ...rest, pinnedFeatureId: point.feature.id } : rest;
    return values.length ? { ...pinned, identifications: values } : pinned;
  }) };
}

/** Use the displayed station snapshot; returning to the original reference preserves its exact definition. */
export function identifyRoutePointWithStation(draft: RouteDraft, plan: RoutePlan, point: RouteWaypoint, station: NearbyVor): RouteDraft {
  const reference = radialReference(station.feature);
  if (!reference || station.radial === null || station.distanceNm <= 0) return draft;
  const original = point.radialPosition?.reference;
  return identifyRoutePoint(draft, plan, point, JSON.stringify(original) === JSON.stringify(reference) ? undefined
    : { kind: 'radial', reference, radial: station.radial, distanceNm: station.distanceNm });
}

export function pointReplacementProblem(plan: RoutePlan, point: RouteWaypoint): string | undefined {
  const entry = plan.entries.find(value => value.id === point.edit?.entryId);
  return !point.edit || point.owners.length || routeItemsForPoint(plan, point).length || entry?.approach || entry?.departure || entry?.arrival
    ? 'This point belongs to a published route or procedure. Its description can change; replacing its position requires editing that route item.' : undefined;
}

export function replaceIdentifiedPoint(draft: RouteDraft, plan: RoutePlan, point: RouteWaypoint, feature: GeoPointFeature): RouteDraft {
  return !plan.waypoints.includes(point) || !sameRouteDraft(draft, plan) || pointReplacementProblem(plan, point)
    ? draft : sameFeature(point.feature, feature) ? identifyRoutePoint(draft, plan, point, undefined)
      : replaceRouteFeature(draft, point.edit!.entryId, feature);
}

export function selectRadialStation(draft: RouteDraft, expected: RouteEntry, position: RadialPosition): RouteDraft {
  return !draft.entries.includes(expected) ? draft : { entries: draft.entries.map(entry => entry === expected
    ? { ...entry, radialPosition: position } : entry) };
}
