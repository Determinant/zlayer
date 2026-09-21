import type { GeoPointFeature } from '@zlayer/contracts';
import { sameFeature, type RoutePlan, type RouteWaypoint } from '@zlayer/domain';

/** Keep each occurrence distinct, including repeated children of one published item. */
export function routePointKeys(plan: RoutePlan): Map<RouteWaypoint, string> {
  const occurrences = new Map<string, number>();
  return new Map(plan.waypoints.map(point => {
    const occurrence = occurrences.get(point.source.entryId) ?? 0;
    occurrences.set(point.source.entryId, occurrence + 1);
    return [point, point.edit?.entryId ?? `expanded:${JSON.stringify([point.source.entryId, occurrence])}`];
  }));
}

/** Prefer the selected occurrence; the shared details panel always reflects
 * current route membership, including another occurrence after a removal. */
export function routePointForFeature(plan: RoutePlan, feature: GeoPointFeature,
  pointKey?: string): RouteWaypoint | undefined {
  const restored = restoreApproachSelection(plan, feature);
  if (restored !== feature) return plan.waypoints.find(point => point.feature === restored);
  const matches = [...routePointKeys(plan)].filter(([point]) => sameFeature(point.feature, feature));
  return (matches.find(([, key]) => key === pointKey) ?? matches[0])?.[0];
}

/** Older saved map selections identify a child by its airport entry and index.
 * Rebind that occurrence to its coded feature; saved map geometry is rounded. */
export function restoreApproachSelection(plan: RoutePlan, feature: GeoPointFeature): GeoPointFeature {
  const legacy = /^approach:(.+):(\d+):([^:]+)$/.exec(feature.id ?? '');
  if (!legacy) return feature;
  const point = plan.waypoints.filter(point => point.source.entryId === legacy[1] &&
    point.owners.some(owner => owner.kind === 'approach'))[Number(legacy[2])];
  return point && point.ident === legacy[3] ? point.feature : feature;
}
